import { EMPTY_BATCH, isBusy, parseTasks, errorText, type BatchData, type Identity } from './batch/model';

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => byId<HTMLInputElement>(id);
const button = (id: string) => byId<HTMLButtonElement>(id);
let data: BatchData = structuredClone(EMPTY_BATCH);
let dirty = false;
let requestPending = false;
const editor = byId<HTMLTextAreaElement>('tasks');
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
  for (const id of ['preview', 'import']) button(id).disabled = busy || requestPending;
  button('start').disabled = busy || requestPending || (!dirty && !data.batchTasks.some(t => t.status === 'READY'));
  button('start').textContent = ['PAUSED', 'STOPPED'].includes(data.batchState) ? 'Resume Batch' : 'Start Batch';
  button('pause').disabled = requestPending || data.batchState !== 'RUNNING';
  button('stop').disabled = requestPending || !['RUNNING', 'PAUSING', 'PAUSED'].includes(data.batchState);
  button('export').disabled = requestPending || busy || !data.batchRun;
}
function render() {
  renderControls();
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
    const content = document.createElement('span'); content.className = 'content-preview'; content.textContent = task.content; content.title = task.content; cell().append(content);
    const statusCell = cell(); const status = document.createElement('span'); status.className = `status ${task.status}`; status.textContent = task.status; statusCell.append(status);
    if (task.phase && task.status === 'RUNNING') { const phase = document.createElement('div'); phase.textContent = task.phase; statusCell.append(phase); }
    if (task.error || task.detectionMethod || task.finalUrl) {
      const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = 'Details'; const text = document.createElement('p');
      text.textContent = [task.detectionMethod && `Detection: ${task.detectionMethod} / ${task.detectedFormType || 'unknown'}`, task.finalUrl, task.screenshotFilename, task.error].filter(Boolean).join('\n');
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
  const tasks = parseTasks(text, format);
  await send('import', { tasks });
  dirty = false;
  await chrome.storage.local.remove('batchDraft');
}
button('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
button('preview').addEventListener('click', () => action(() => importText(editor.value, 'tsv')));
button('import').addEventListener('click', () => input('csv-file').click());
input('csv-file').addEventListener('change', () => action(async () => {
  const file = input('csv-file').files?.[0];
  if (!file) return;
  await importText(await file.text(), 'csv'); editor.value = ''; input('csv-file').value = '';
}));
editor.addEventListener('input', () => {
  dirty = !!editor.value.trim(); renderControls();
  chrome.storage.local.set({ batchDraft: editor.value }).catch(e => notice(errorText(e)));
});
button('start').addEventListener('click', () => action(async () => {
  if (dirty) await importText(editor.value, 'tsv');
  const window = await chrome.windows.getCurrent();
  await send('start', { identity: identity(), rememberIdentity: input('remember').checked, windowId: window.id });
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
  const draft = await chrome.storage.local.get('batchDraft'); editor.value = draft.batchDraft || ''; dirty = !!editor.value.trim();
  render();
})().catch(e => notice(errorText(e)));
