import { EMPTY_BATCH, isBusy, parseTasks, errorText, type BatchData, type Identity } from './batch/model';
import { parseExcelFile, type ExcelImportResult } from './batch/excel';

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => byId<HTMLInputElement>(id);
const button = (id: string) => byId<HTMLButtonElement>(id);
let data: BatchData = structuredClone(EMPTY_BATCH);
let dirty = false;
let requestPending = false;
let contentMode: 'csv' | 'ai' = 'csv';
let excelSummary: (Omit<ExcelImportResult, 'tasks'> & { filename: string }) | null = null;
const editor = byId<HTMLTextAreaElement>('tasks');
const promptEditor = byId<HTMLTextAreaElement>('comment-generation-prompt');
const notice = (text = '') => { byId('notice').textContent = text; };
const identity = (): Identity => ({ name: input('name').value, email: input('email').value, website: input('website').value });
async function send(type: string, payload: object = {}) {
  const result = await chrome.runtime.sendMessage({ type: `batch:${type}`, ...payload });
  if (result?.error) throw new Error(result.error);
  return result;
}
async function action(fn: () => Promise<void>) {
  requestPending = true; renderControls(); notice();
  try { await fn(); await refresh(); } catch (e) { notice(errorText(e)); }
  finally { requestPending = false; renderControls(); }
}
function renderControls() {
  const busy = isBusy(data.batchState);
  for (const key of ['name', 'email', 'website', 'remember']) input(key).disabled = busy || requestPending;
  editor.disabled = busy || requestPending;
  for (const id of ['preview', 'import', 'upload-excel']) button(id).disabled = busy || requestPending;
  input('xlsx-file').disabled = busy || requestPending;
  input('content-mode-csv').disabled = busy || requestPending;
  input('content-mode-ai').disabled = busy || requestPending;
  promptEditor.disabled = busy || requestPending;
  button('start').disabled = busy || requestPending || (!dirty && !data.batchTasks.some(t => t.status === 'READY'));
  button('start').textContent = ['PAUSED', 'STOPPED'].includes(data.batchState) ? 'Resume Batch' : 'Start Batch';
  button('pause').disabled = requestPending || data.batchState !== 'RUNNING';
  button('stop').disabled = requestPending || !['RUNNING', 'PAUSING', 'PAUSED'].includes(data.batchState);
  button('export').disabled = requestPending || busy || !data.batchRun;
}
function renderImportSummary() {
  const root = byId('import-summary');
  root.replaceChildren(); root.hidden = !excelSummary;
  if (!excelSummary) return;
  const title = document.createElement('strong'); title.textContent = `Imported: ${excelSummary.filename}`; root.append(title);
  const dl = document.createElement('dl');
  for (const [label, value] of [['Total', excelSummary.total], ['Valid', excelSummary.valid], ['Duplicate', excelSummary.duplicate], ['Invalid', excelSummary.invalid]] as const) {
    const box = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = String(value); box.append(dt, dd); dl.append(box);
  }
  root.append(dl);
  const count = document.createElement('div'); count.className = 'hint'; count.textContent = `Task count: ${excelSummary.valid}`; root.append(count);
  if (excelSummary.invalidRows.length) {
    const label = document.createElement('div'); label.textContent = 'Invalid:'; root.append(label);
    const list = document.createElement('ul'); list.className = 'invalid-list';
    for (const item of excelSummary.invalidRows.slice(0, 10)) { const li = document.createElement('li'); li.textContent = `row ${item.row}: ${item.value}`; list.append(li); }
    root.append(list);
  }
}
function renderContentMode() {
  input('content-mode-csv').checked = contentMode === 'csv';
  input('content-mode-ai').checked = contentMode === 'ai';
  byId('ai-prompt-wrap').hidden = contentMode !== 'ai';
}
function render() {
  renderControls();
  renderContentMode(); renderImportSummary();
  const done = data.batchTasks.filter(t => !['READY', 'RUNNING'].includes(t.status)).length;
  byId('summary').textContent = `Progress: ${done} / ${data.batchTasks.length} · ${data.batchState}`;
  const progress = byId<HTMLProgressElement>('progress'); progress.max = data.batchTasks.length || 1; progress.value = done;
  byId('control-hint').textContent = data.batchState === 'PAUSING' ? '当前任务完成并保存截图后暂停。' : data.batchState === 'STOPPING' ? '当前任务完成并保存截图后停止。' : 'Pause / Stop 会等待当前任务完成。';
  byId('empty').hidden = !!data.batchTasks.length;
  const list = byId('task-list'); list.replaceChildren();
  for (const [index, task] of data.batchTasks.entries()) {
    const row = document.createElement('tr');
    const cell = () => { const td = document.createElement('td'); row.append(td); return td; };
    cell().textContent = String(index + 1);
    const link = document.createElement('a'); link.href = task.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = new URL(task.url).hostname + new URL(task.url).pathname; link.title = task.url; cell().append(link);
    const content = document.createElement('span'); content.className = 'content-preview'; content.textContent = task.generatedContent || task.content || (task.contentSource === 'AI' ? 'Will generate with AI' : ''); content.title = task.generatedContent || task.content; cell().append(content);
    const statusCell = cell(); const status = document.createElement('span'); status.className = `status ${task.status}`; status.textContent = task.status; statusCell.append(status);
    if (task.phase && task.status === 'RUNNING') { const phase = document.createElement('div'); phase.textContent = task.phase; statusCell.append(phase); }
    if (task.error || task.detectionMethod || task.finalUrl) {
      const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = 'Details'; const text = document.createElement('p');
      text.textContent = [task.contentSource && `Content: ${task.contentSource}${task.generationStatus ? ` / ${task.generationStatus}` : ''}`, task.detectionMethod && `Detection: ${task.detectionMethod} / ${task.detectedFormType || 'unknown'}`, task.finalUrl, task.screenshotFilename, task.error].filter(Boolean).join('\n');
      details.append(summary, text); statusCell.append(details);
    }
    list.append(row);
  }
  if (data.batchRun) byId('output').textContent = [
    data.batchRun.resultsFilename ? `CSV: ${data.batchRun.resultsFilename}` : 'Batch 完成后自动生成 results.csv。',
    data.batchRun.error,
  ].filter(Boolean).join('\n');
  else byId('output').textContent = '截图和 results.csv 通过 Local File Writer（Native Messaging）直接写入本地输出目录，不经过浏览器下载。';
}
async function refresh() { const saved = await send('get'); data = saved; render(); }
async function importText(text: string, format: 'csv' | 'tsv') {
  const tasks = parseTasks(text, format).map(task => contentMode === 'ai' ? { ...task, content: '', contentSource: 'AI' as const } : { ...task, contentSource: 'CSV' as const });
  await send('import', { tasks });
  excelSummary = null; await chrome.storage.local.remove('excelImportSummary');
  dirty = false;
  await chrome.storage.local.remove('batchDraft');
}
async function importExcel(file: File) {
  if (!file.name.toLowerCase().endsWith('.xlsx')) throw new Error('Choose an .xlsx file.');
  const result = await parseExcelFile(file);
  if (!result.tasks.length) throw new Error('Excel contains no valid unique http(s) URLs.');
  await send('import', { tasks: result.tasks });
  contentMode = 'ai';
  excelSummary = { filename: file.name, total: result.total, valid: result.valid, duplicate: result.duplicate, invalid: result.invalid, invalidRows: result.invalidRows };
  await chrome.storage.local.set({ excelImportSummary: excelSummary, batchContentMode: contentMode });
  editor.value = ''; dirty = false; await chrome.storage.local.remove('batchDraft');
}
button('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
button('preview').addEventListener('click', () => action(() => importText(editor.value, 'tsv')));
button('import').addEventListener('click', () => input('csv-file').click());
button('upload-excel').addEventListener('click', () => input('xlsx-file').click());
input('csv-file').addEventListener('change', () => action(async () => {
  const file = input('csv-file').files?.[0];
  if (!file) return;
  await importText(await file.text(), 'csv'); editor.value = ''; input('csv-file').value = '';
}));
input('xlsx-file').addEventListener('change', () => action(async () => {
  const file = input('xlsx-file').files?.[0]; if (!file) return;
  await importExcel(file); input('xlsx-file').value = '';
}));
const dropzone = byId('excel-upload');
for (const event of ['dragenter', 'dragover']) dropzone.addEventListener(event, e => { e.preventDefault(); if (!requestPending && !isBusy(data.batchState)) dropzone.classList.add('dragover'); });
for (const event of ['dragleave', 'drop']) dropzone.addEventListener(event, e => { e.preventDefault(); dropzone.classList.remove('dragover'); });
dropzone.addEventListener('drop', e => { const file = (e as DragEvent).dataTransfer?.files?.[0]; if (file) void action(() => importExcel(file)); });
for (const mode of ['csv', 'ai'] as const) input(`content-mode-${mode}`).addEventListener('change', () => {
  contentMode = mode; chrome.storage.local.set({ batchContentMode: mode }).catch(e => notice(errorText(e))); renderContentMode(); renderControls();
});
promptEditor.addEventListener('input', () => chrome.storage.local.set({ commentGenerationPrompt: promptEditor.value }).catch(e => notice(errorText(e))));
editor.addEventListener('input', () => {
  dirty = !!editor.value.trim(); renderControls();
  chrome.storage.local.set({ batchDraft: editor.value }).catch(e => notice(errorText(e)));
});
button('start').addEventListener('click', () => action(async () => {
  if (dirty) await importText(editor.value, 'tsv');
  const window = await chrome.windows.getCurrent();
  await send('start', { identity: identity(), rememberIdentity: input('remember').checked, commentGenerationPrompt: promptEditor.value, windowId: window.id });
}));
for (const id of ['pause', 'stop', 'export']) button(id).addEventListener('click', () => action(async () => { await send(id); }));
for (const id of ['name', 'email', 'website', 'remember']) input(id).addEventListener('change', () => {
  if (!isBusy(data.batchState)) send('identity', { identity: identity(), rememberIdentity: input('remember').checked }).catch(e => notice(errorText(e)));
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && ['batchTasks', 'batchState', 'batchRun', 'currentTaskIndex'].some(k => k in changes)) void refresh().catch(e => notice(errorText(e)));
});
(async () => {
  const saved = await send('get'); data = saved;
  for (const key of ['name', 'email', 'website'] as const) input(key).value = saved.identity?.[key] || '';
  input('remember').checked = saved.rememberIdentity !== false;
  const savedUi = await chrome.storage.local.get(['batchDraft', 'batchContentMode', 'commentGenerationPrompt', 'excelImportSummary']);
  editor.value = savedUi.batchDraft || ''; dirty = !!editor.value.trim();
  contentMode = savedUi.batchContentMode === 'ai' ? 'ai' : 'csv';
  promptEditor.value = savedUi.commentGenerationPrompt || '';
  excelSummary = savedUi.excelImportSummary || null;
  render();
})().catch(e => notice(errorText(e)));
