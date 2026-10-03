import { detectBatchForm } from '../utils/ai';
import { getAIConfig } from '../utils/storage';
import { writeCsv, writeScreenshot } from '../utils/native';
import { generateComment } from './comment-generator';
import {
  EMPTY_BATCH, EMPTY_IDENTITY, defaultFolder, errorText, isBusy, resultsCSV, screenshotName, validateFolder, validateUrl,
  type BatchData, type BatchTask, type Detection, type EntryDetection, type Identity, type TaskStatus,
} from './model';

const ALARM = 'batch-worker-recovery';
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const deadline = async <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]); }
  finally { clearTimeout(timer!); }
};
let data: BatchData = structuredClone(EMPTY_BATCH);
let writing = Promise.resolve();
let executing = false;
let commandQueue = Promise.resolve();
class ChallengeError extends Error {}
const appendError = (task: BatchTask, message: string) => { task.error = [task.error, message].filter(Boolean).join('\n'); };
function persist() {
  const snapshot = structuredClone(data);
  writing = writing.catch(() => {}).then(() => chrome.storage.local.set({ ...snapshot, batchRun: snapshot.batchRun ?? null }));
  return writing;
}
const ready = chrome.storage.local.get(['batchTasks', 'batchState', 'currentTaskIndex', 'batchRun', 'rememberIdentity']).then(saved => {
  data = { ...structuredClone(EMPTY_BATCH), ...saved } as BatchData;
});
async function page<T = any>(tabId: number, type: string, payload: object = {}): Promise<T> {
  const result = await deadline(chrome.tabs.sendMessage(tabId, { type: `batchPage:${type}`, ...payload }, { frameId: 0 }), 12000, `Page ${type} timed out.`);
  if (!result) throw new Error(`No response from the page (${type}).`);
  if (result.error && !result.status) throw new Error(result.error);
  return result as T;
}
async function identity(): Promise<Identity> {
  const session = await chrome.storage.session.get('batchIdentity');
  return session.batchIdentity || (await chrome.storage.local.get('identity')).identity || EMPTY_IDENTITY;
}
async function saveIdentity(value: Identity, remember: boolean) {
  const clean = { name: String(value?.name || '').trim(), email: String(value?.email || '').trim(), website: String(value?.website || '').trim() };
  await chrome.storage.session.set({ batchIdentity: clean });
  if (remember) await chrome.storage.local.set({ identity: clean });
  else await chrome.storage.local.remove('identity');
  data.rememberIdentity = remember;
}
async function ensureTab(): Promise<chrome.tabs.Tab> {
  if (data.batchRun?.workerTabId == null) {
    const session = await chrome.storage.session.get('batchWorkerTab');
    if (session.batchWorkerTab?.windowId === data.batchRun?.windowId) data.batchRun!.workerTabId = session.batchWorkerTab.id;
  }
  if (data.batchRun?.workerTabId != null) {
    try { return await chrome.tabs.get(data.batchRun.workerTabId); } catch { /* Closed: create one replacement. */ }
  }
  const tab = await chrome.tabs.create({ url: 'about:blank', active: true, ...(data.batchRun?.windowId != null ? { windowId: data.batchRun.windowId } : {}) });
  data.batchRun!.workerTabId = tab.id!;
  data.batchRun!.windowId = tab.windowId;
  await chrome.storage.session.set({ batchWorkerTab: { id: tab.id, windowId: tab.windowId } });
  await persist();
  return tab;
}
async function navigate(tabId: number, url: string) {
  // Register first: fast cache hits must not race the complete event.
  let onUpdated: (id: number, change: chrome.tabs.TabChangeInfo) => void;
  let onRemoved: (id: number) => void;
  const loaded = new Promise<void>((resolve, reject) => {
    onUpdated = (id, change) => { if (id === tabId && change.status === 'complete') resolve(); };
    onRemoved = id => { if (id === tabId) reject(new Error('Batch Worker Tab was closed.')); };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
  // Attach timeout/rejection handlers before awaiting tabs.update.
  const wait = deadline(loaded, 30000, 'Page load timed out after 30 seconds.');
  try {
    await Promise.all([chrome.tabs.update(tabId, { url, active: true }), wait]);
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || !/^https?:/.test(tab.url)) throw new Error('Page did not load an http(s) document.');
    await sleep(800);
    // Receiving-end checks distinguish a browser network-error page from a page with no form.
    for (let i = 0; ; i++) {
      try { await page(tabId, 'detect'); break; }
      catch (e) { if (i >= 2) throw new Error(`Content script unavailable after loading: ${errorText(e)}`); await sleep(700); }
    }
  } finally {
    chrome.tabs.onUpdated.removeListener(onUpdated!);
    chrome.tabs.onRemoved.removeListener(onRemoved!);
  }
}
async function pollLocalForm(tabId: number, delays: number[]): Promise<Detection> {
  for (const delay of delays) {
    if (delay) await sleep(delay);
    const result = await page(tabId, 'detect');
    if (result.challenge) throw new ChallengeError(result.challenge);
    if (result.detection?.found) return result.detection;
  }
  return { found: false };
}
async function aiEntry(tabId: number, task: BatchTask, replyWasActivated: boolean): Promise<EntryDetection> {
  const snapshot = await page(tabId, 'snapshot');
  if (!snapshot.candidateCount) return { found: false };
  const config = await getAIConfig();
  if (!config?.apiKey || !config.model) {
    if (replyWasActivated) return { found: false };
    task.detectionMethod = 'ai';
    throw new Error('AI fallback needs Provider, Model and API Key in Settings.');
  }
  task.detectionMethod = 'ai';
  await persist();
  return detectBatchForm(config, snapshot.snapshot);
}
async function activateReply(tabId: number, locator: string, task: BatchTask): Promise<boolean> {
  try {
    const result = await page(tabId, 'activateReply', { locator });
    if (!result.ok) throw new Error(result.error || 'Reply trigger could not be activated.');
    return true;
  } catch (e) {
    const message = errorText(e);
    if (/requires authentication/i.test(message)) {
      task.error = 'Reply requires authentication';
      return false;
    }
    throw e;
  }
}
async function detect(tabId: number, task: BatchTask): Promise<Detection> {
  task.detectionMethod = 'local';
  let direct = await pollLocalForm(tabId, [0, 1000, 2000, 3000]);
  if (direct.found) { task.entryStrategy = 'DIRECT_FORM'; return direct; }

  const localEntry = await page(tabId, 'findReply');
  if (localEntry.requiresAuth) {
    task.error = 'Reply requires authentication';
    return { found: false };
  }
  let replyWasActivated = false;
  if (localEntry.locator) {
    replyWasActivated = await activateReply(tabId, localEntry.locator, task);
    if (!replyWasActivated) return { found: false };
    task.entryStrategy = 'REPLY_TRIGGER_LOCAL';
    direct = await pollLocalForm(tabId, [0, 500, 1000, 2000]);
    if (direct.found) return direct;
  }

  let ai = await aiEntry(tabId, task, replyWasActivated);
  if (!ai.found) {
    if (replyWasActivated) task.error ||= 'Reply activated but comment form not found.';
    return { found: false };
  }
  if (!('strategy' in ai)) {
    task.entryStrategy ||= 'DIRECT_FORM';
    return ai;
  }
  if (!(await activateReply(tabId, ai.replyLocator, task))) return { found: false };
  task.entryStrategy = 'REPLY_TRIGGER_AI';
  direct = await pollLocalForm(tabId, [0, 500, 1000, 2000]);
  if (direct.found) return direct;

  // A fresh snapshot/AI pass may now see the newly inserted form. Do not click a second AI trigger.
  ai = await aiEntry(tabId, task, true);
  if (ai.found && !('strategy' in ai)) return ai;
  task.error ||= 'Reply activated but comment form not found.';
  return { found: false };
}
async function prepareTaskContent(tabId: number, task: BatchTask) {
  task.contentSource ||= 'CSV';
  if (task.contentSource !== 'AI') return;
  if (task.generationStatus === 'SUCCESS' && task.generatedContent?.trim()) {
    task.content = task.generatedContent;
    return;
  }
  const prompt = data.batchRun?.commentGenerationPrompt?.trim();
  if (!prompt) throw new Error('Comment Generation Prompt is required.');
  const config = await getAIConfig();
  if (!config?.apiKey || !config.model) throw new Error('AI comment generation needs Provider, Model and API Key in Settings.');
  task.phase = 'extracting'; await persist();
  const extracted = await page(tabId, 'articleContext');
  task.phase = 'generating'; await persist();
  const generated = await generateComment(config, { ...extracted.context, userPrompt: prompt });
  task.generatedContent = generated;
  task.content = generated;
  task.generationStatus = 'SUCCESS';
  await persist();
}
async function observe(tabId: number, task: BatchTask) {
  const end = Date.now() + 15000;
  let lastError = '';
  while (Date.now() < end) {
    try {
      const result = await page(tabId, 'outcome', { baseline: task.baseline, content: task.content });
      if (result.status) return result as { status: TaskStatus; error?: string };
    } catch (e) { lastError = errorText(e); /* Navigation disconnects the old content script. */ }
    await sleep(600);
  }
  return { status: 'SUBMIT_FAILED' as const, error: 'No new success or moderation evidence within 15 seconds.' + (lastError ? ` ${lastError}` : '') };
}
async function screenshot(task: BatchTask, index: number) {
  if (task.screenshotFilename) return;
  const tabId = data.batchRun!.workerTabId;
  if (tabId == null) throw new Error('No worker tab is available for a screenshot.');
  const tab = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  await page(tabId, 'scrollResult', { content: task.content }).catch(() => {});
  await sleep(350);
  let switched = false;
  const activated = (info: chrome.tabs.TabActiveInfo) => { if (info.windowId === tab.windowId && info.tabId !== tabId) switched = true; };
  const navigated = (id: number, change: chrome.tabs.TabChangeInfo) => { if (id === tabId && (change.url || change.status === 'loading')) switched = true; };
  chrome.tabs.onActivated.addListener(activated);
  chrome.tabs.onUpdated.addListener(navigated);
  let png: string;
  try {
    const [before] = await chrome.tabs.query({ windowId: tab.windowId, active: true });
    if (before?.id !== tabId) throw new Error('Worker tab lost focus before capture.');
    png = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    const [after] = await chrome.tabs.query({ windowId: tab.windowId, active: true });
    if (switched || after?.id !== tabId || before.url !== after.url) throw new Error('Tab changed during capture; screenshot discarded to avoid saving the wrong page.');
    task.finalUrl = after.url;
  } finally {
    chrome.tabs.onActivated.removeListener(activated);
    chrome.tabs.onUpdated.removeListener(navigated);
  }
  const saved = await writeScreenshot(data.batchRun!.id, screenshotName(task, index), png!);
  task.screenshotFilename = saved.path;
}
async function finishTask(task: BatchTask, index: number) {
  task.phase = 'screenshot';
  await persist();
  try {
    if (data.batchRun?.workerTabId != null) task.finalUrl = (await chrome.tabs.get(data.batchRun.workerTabId)).url;
    await screenshot(task, index);
  } catch (e) { appendError(task, `FILE_SAVE_FAILED: ${errorText(e)}`); }
  task.completedAt = Date.now();
  task.phase = 'done';
  delete task.baseline;
  data.currentTaskIndex = index + 1;
  await persist();
}
async function executeTask(task: BatchTask, index: number) {
  task.status = 'RUNNING'; task.phase = 'loading'; task.startedAt = Date.now();
  data.currentTaskIndex = index;
  await persist();
  let failure: TaskStatus = 'LOAD_FAILED';
  try {
    const tab = await ensureTab();
    await navigate(tab.id!, task.url);
    if ((task.contentSource || 'CSV') === 'AI') {
      failure = 'CONTENT_GENERATION_FAILED';
      try { await prepareTaskContent(tab.id!, task); }
      catch (e) { task.generationStatus = 'FAILED'; throw e; }
    } else task.contentSource = 'CSV';
    task.phase = 'detecting'; await persist();
    failure = 'FORM_NOT_FOUND';
    let detection: Detection;
    try { detection = await detect(tab.id!, task); }
    catch (e) {
      if (e instanceof ChallengeError) failure = 'SUBMIT_FAILED';
      else if (task.detectionMethod === 'ai') failure = 'AI_FAILED';
      throw e;
    }
    if (!detection.found) { task.status = 'FORM_NOT_FOUND'; task.error ||= 'No reliable comment/reply/submission form found.'; }
    else {
      task.detectedFormType = detection.formType;
      failure = task.detectionMethod === 'ai' ? 'AI_FAILED' : 'SUBMIT_FAILED';
      detection = (await page(tab.id!, 'prepare', { detection })).detection;
      failure = 'SUBMIT_FAILED'; task.phase = 'filling'; await persist();
      const fields = { detection, identity: await identity(), content: task.content };
      await page(tab.id!, 'fill', fields);
      const baseline = await page(tab.id!, 'baseline', fields);
      task.baseline = baseline.evidence;
      // Persist BEFORE dispatching the irreversible click. Recovery observes, never re-clicks.
      task.phase = 'submitting'; await persist();
      try {
        const click = await page(tab.id!, 'submit', fields);
        if (!click.ok) throw new Error(click.error || 'Submit failed.');
      } catch (e) {
        // Navigation may close the message port after a successful click.
        appendError(task, `Submit acknowledgement: ${errorText(e)}`);
      }
      task.phase = 'observing'; await persist();
      const result = await observe(tab.id!, task);
      task.status = result.status;
      if (result.error) appendError(task, result.error);
    }
  } catch (e) { task.status = failure; appendError(task, errorText(e)); }
  await finishTask(task, index);
}
async function exportResults() {
  if (!data.batchRun) return;
  try {
    const run = data.batchRun;
    const saved = await writeCsv(run.id, resultsCSV(data.batchTasks));
    run.resultsFilename = saved.path;
    run.error = undefined;
  } catch (e) { data.batchRun.error = `FILE_SAVE_FAILED: ${errorText(e)}`; }
  data.batchRun.exportPending = false;
  await persist();
}
async function recover() {
  const index = data.batchTasks.findIndex(t => t.status === 'RUNNING' || t.phase === 'screenshot');
  if (index < 0) return;
  const task = data.batchTasks[index];
  if (task.status === 'RUNNING') {
    if (task.baseline && data.batchRun?.workerTabId != null && ['submitting', 'observing'].includes(task.phase || '')) {
      const result = await observe(data.batchRun.workerTabId, task);
      task.status = result.status;
      if (result.error) appendError(task, result.error);
    } else {
      task.status = task.phase === 'loading' ? 'LOAD_FAILED' : ['extracting', 'generating'].includes(task.phase || '') ? 'CONTENT_GENERATION_FAILED' : 'SUBMIT_FAILED';
      if (task.status === 'CONTENT_GENERATION_FAILED') task.generationStatus = 'FAILED';
      appendError(task, 'Background was interrupted. This task was not resubmitted to avoid duplicate posts.');
    }
  }
  await finishTask(task, index);
}
async function run() {
  await ready;
  if (executing || (!isBusy(data.batchState) && !data.batchRun?.exportPending)) return;
  executing = true;
  // Extension API activity keeps this finite user-started operation alive while the panel is closed.
  const keepAlive = setInterval(() => { chrome.runtime.getPlatformInfo().catch(() => {}); }, 20000);
  try {
    await chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
    if (!isBusy(data.batchState)) { await exportResults(); return; }
    const session = await chrome.storage.session.get('batchRunSession');
    if (session.batchRunSession !== data.batchRun?.id) {
      // A browser/extension restart loses tab ownership. Do not navigate or capture an unrelated tab.
      for (const task of data.batchTasks) {
        if (task.status === 'RUNNING' || task.phase === 'screenshot') {
          if (task.status === 'RUNNING') {
            task.status = ['extracting', 'generating'].includes(task.phase || '') ? 'CONTENT_GENERATION_FAILED' : task.phase === 'loading' ? 'LOAD_FAILED' : 'SUBMIT_FAILED';
            if (task.status === 'CONTENT_GENERATION_FAILED') task.generationStatus = 'FAILED';
          }
          appendError(task, 'Browser or extension restarted. Submission could not be verified; this task will not be resubmitted. Screenshot unavailable after restart.');
          task.phase = 'done'; task.completedAt = Date.now(); delete task.baseline;
        }
      }
      if (data.batchRun) delete data.batchRun.workerTabId;
      data.batchState = 'PAUSED';
      await persist();
      return;
    }
    await recover();
    while (data.batchState === 'RUNNING') {
      const index = data.batchTasks.findIndex(t => t.status === 'READY');
      if (index < 0) break;
      await executeTask(data.batchTasks[index], index);
    }
    if (!data.batchTasks.some(t => t.status === 'READY')) data.batchState = 'COMPLETED';
    else if (data.batchState === 'PAUSING') data.batchState = 'PAUSED';
    else if (data.batchState === 'STOPPING') data.batchState = 'STOPPED';
    if (['COMPLETED', 'STOPPED'].includes(data.batchState) && data.batchRun) data.batchRun.exportPending = true;
    await persist();
    if (data.batchRun?.exportPending) await exportResults();
  } catch (e) {
    data.batchState = 'PAUSED';
    if (data.batchRun) data.batchRun.error = `Batch paused: ${errorText(e)}`;
    await persist().catch(() => {});
  } finally {
    clearInterval(keepAlive);
    await chrome.alarms.clear(ALARM);
    executing = false;
  }
}
async function command(msg: any) {
  await ready;
  switch (msg.type) {
    case 'batch:get': return { ...data, identity: await identity() };
    case 'batch:identity':
      if (isBusy(data.batchState) || executing) throw new Error('Identity is locked while the batch is running.');
      await saveIdentity(msg.identity, !!msg.rememberIdentity); await persist(); break;
    case 'batch:import':
      if (isBusy(data.batchState) || executing) throw new Error('Finish or stop the active batch before importing tasks.');
      if (!Array.isArray(msg.tasks) || !msg.tasks.length) throw new Error('Import at least one task.');
      data.batchTasks = msg.tasks.map((task: any) => {
        const contentSource = task.contentSource === 'AI' ? 'AI' : 'CSV';
        if (contentSource === 'CSV' && (typeof task.content !== 'string' || !task.content.trim())) throw new Error('Every CSV task needs Content.');
        return { id: crypto.randomUUID(), url: validateUrl(task.url), content: contentSource === 'CSV' ? task.content.replace(/\r\n/g, '\n') : '', contentSource, status: 'READY' };
      });
      data.batchState = 'IDLE'; data.currentTaskIndex = 0; delete data.batchRun;
      await persist(); break;
    case 'batch:start': {
      if (isBusy(data.batchState) || executing) throw new Error('Batch is already running or finishing its export.');
      if (!data.batchTasks.some(t => t.status === 'READY')) throw new Error('No READY tasks remain. Import new tasks to start.');
      await saveIdentity(msg.identity, !!msg.rememberIdentity);
      if (!data.batchRun) {
        const settings = await chrome.storage.local.get('screenshotFolder');
        const base = validateFolder(settings.screenshotFolder || defaultFolder());
        const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`;
        const needsGeneration = data.batchTasks.some(t => t.status === 'READY' && t.contentSource === 'AI');
        const commentGenerationPrompt = needsGeneration ? String(msg.commentGenerationPrompt || '').trim() : undefined;
        if (needsGeneration && !commentGenerationPrompt) throw new Error('Comment Generation Prompt is required.');
        data.batchRun = { id, folder: `${base}/${id}`, windowId: msg.windowId, commentGenerationPrompt };
      }
      // Resuming a stopped batch re-exports the (now longer) CSV into the same batch folder.
      delete data.batchRun.resultsFilename; delete data.batchRun.error;
      data.batchRun.exportPending = false;
      data.batchRun.windowId = msg.windowId;
      await chrome.storage.session.set({ batchRunSession: data.batchRun.id });
      data.batchState = 'RUNNING'; await persist(); void run(); break;
    }
    case 'batch:pause':
      if (data.batchState === 'RUNNING') { data.batchState = 'PAUSING'; await persist(); } break;
    case 'batch:stop':
      if (isBusy(data.batchState)) { data.batchState = 'STOPPING'; await persist(); }
      else if (data.batchState === 'PAUSED') { data.batchState = 'STOPPED'; if (data.batchRun) data.batchRun.exportPending = true; await persist(); await exportResults(); }
      break;
    case 'batch:export':
      if (isBusy(data.batchState) || executing) throw new Error('Wait for the active task to finish.');
      if (!data.batchRun) throw new Error('No batch results yet.');
      await exportResults(); break;
    default: throw new Error('Unknown batch command.');
  }
  return { ok: true };
}
export function registerBatchRunner() {
  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (!String(msg?.type).startsWith('batch:')) return;
    // Only extension pages may start/modify batches, never page-origin content scripts.
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) { respond({ error: 'Batch controls require an extension page.' }); return; }
    commandQueue = commandQueue.catch(() => {}).then(async () => {
      try { respond(await command(msg)); } catch (e) { respond({ error: errorText(e) }); }
    });
    return true;
  });
  chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) void run(); });
  chrome.runtime.onStartup.addListener(() => { void run(); });
  ready.then(() => { if (isBusy(data.batchState) || data.batchRun?.exportPending) void run(); });
}
