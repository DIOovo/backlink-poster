/**
 * 表单缓存管理页：列出所有缓存项，点击后可编辑（除 domHash 外）并保存。
 * 本文件被独立打包，禁止 runtime import（仅 import type）。
 */

import type { FormCacheEntry, DetectedField } from './utils/types';

const CACHE_KEY = 'formCache';

const listEl = document.getElementById('list')!;
const detailEl = document.getElementById('detail')!;
const countEl = document.getElementById('count')!;

let entries: FormCacheEntry[] = [];
let activeId: string | null = null;

async function loadCache(): Promise<FormCacheEntry[]> {
  const r = await chrome.storage.local.get(CACHE_KEY);
  return (r[CACHE_KEY] as FormCacheEntry[]) ?? [];
}
async function storeCache(list: FormCacheEntry[]): Promise<void> {
  await chrome.storage.local.set({ [CACHE_KEY]: list });
}

function esc(s: string): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function pretty(v: unknown): string {
  try { return JSON.stringify(typeof v === 'string' ? JSON.parse(v as string) : v, null, 2); }
  catch { return typeof v === 'string' ? (v as string) : JSON.stringify(v); }
}

function renderList() {
  countEl.textContent = `${entries.length} item(s)`;
  listEl.innerHTML = '';
  if (entries.length === 0) {
    listEl.innerHTML = '<div class="list-empty">No cache yet. Forms you analyze and save in the side panel will appear here.</div>';
    return;
  }
  for (const e of entries) {
    const item = document.createElement('div');
    item.className = 'item' + (e.id === activeId ? ' active' : '');
    const when = new Date(e.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    item.innerHTML =
      `<div class="item-name">${esc(e.formName)}</div>` +
      `<div class="item-url">${esc(e.urlPattern)}</div>` +
      `<div class="item-meta">${e.fields?.length ?? 0} fields · ${e.code ? 'has code' : (e.actions ? 'has actions' : 'no actions')} · ${when}</div>`;
    item.addEventListener('click', () => { activeId = e.id; renderList(); renderDetail(e); });
    listEl.appendChild(item);
  }
}

function renderDetail(e: FormCacheEntry) {
  detailEl.innerHTML = `
    <div class="detail-head">
      <div class="edits">
        <div class="edit-row"><label>Form name</label><input id="d-name" type="text" /></div>
        <div class="edit-row"><label>Match URL</label><input id="d-url" type="text" /></div>
        <div class="edit-row"><label>domHash</label><input id="d-hash" type="text" readonly /></div>
      </div>
      <div class="detail-actions">
        <button class="btn-save" id="d-save">💾 Save</button>
        <button class="btn-del" id="d-del">🗑 Delete</button>
      </div>
    </div>
    <div class="save-msg" id="d-msg"></div>
    <div class="panes">
      <div class="pane">
        <div class="pane-head">Fields JSON</div>
        <textarea id="d-fields" spellcheck="false"></textarea>
      </div>
      <div class="pane">
        <div class="pane-head">Playwright code (executable)</div>
        <textarea id="d-code" spellcheck="false"></textarea>
      </div>
    </div>`;

  (detailEl.querySelector('#d-name') as HTMLInputElement).value = e.formName;
  (detailEl.querySelector('#d-url') as HTMLInputElement).value = e.urlPattern;
  (detailEl.querySelector('#d-hash') as HTMLInputElement).value = e.domHash;
  (detailEl.querySelector('#d-fields') as HTMLTextAreaElement).value = pretty(e.fields);
  (detailEl.querySelector('#d-code') as HTMLTextAreaElement).value = e.code || '';

  detailEl.querySelector('#d-save')!.addEventListener('click', () => saveEntry(e.id));
  detailEl.querySelector('#d-del')!.addEventListener('click', () => deleteEntry(e.id));
}

function msg(type: 'ok' | 'err', text: string) {
  const el = detailEl.querySelector('#d-msg') as HTMLElement;
  if (!el) return;
  el.className = `save-msg ${type}`;
  el.textContent = text;
}

async function saveEntry(id: string) {
  const idx = entries.findIndex(e => e.id === id);
  if (idx < 0) return;

  const formName = (detailEl.querySelector('#d-name') as HTMLInputElement).value.trim();
  const urlPattern = (detailEl.querySelector('#d-url') as HTMLInputElement).value.trim();
  const fieldsText = (detailEl.querySelector('#d-fields') as HTMLTextAreaElement).value.trim();
  const code = (detailEl.querySelector('#d-code') as HTMLTextAreaElement).value;

  if (!formName) return msg('err', 'Form name cannot be empty');
  if (!urlPattern) return msg('err', 'Match URL cannot be empty');
  try { new RegExp(urlPattern); } catch { return msg('err', 'Invalid URL regular expression'); }

  // 表单名必须唯一（全局，忽略大小写/首尾空白；排除自身）
  const nameDup = entries.find(e => e.id !== id && e.formName.trim().toLowerCase() === formName.toLowerCase());
  if (nameDup) return msg('err', `表单名“${formName}”已存在，请改用唯一名称`);

  let fields: DetectedField[];
  try {
    const parsed = JSON.parse(fieldsText);
    fields = Array.isArray(parsed) ? parsed : parsed?.fields;
    if (!Array.isArray(fields)) throw new Error();
  } catch { return msg('err', 'Invalid fields JSON (expected an array or {fields:[...]})'); }

  // Uniqueness: URL + form name (excluding self)
  const dup = entries.find(e => e.id !== id && e.urlPattern === urlPattern && e.formName === formName);
  if (dup) return msg('err', 'An entry with the same URL + form name already exists');

  const e = entries[idx];
  e.formName = formName;
  e.urlPattern = urlPattern;
  e.fields = fields;
  e.code = code;
  e.updatedAt = Date.now();
  await storeCache(entries);
  renderList();
  msg('ok', '✓ Saved');
}

async function deleteEntry(id: string) {
  if (!confirm('Delete this cache entry? Its fields and code will be removed.')) return;
  entries = entries.filter(e => e.id !== id);
  await storeCache(entries);
  if (activeId === id) {
    activeId = null;
    detailEl.innerHTML = '<div class="placeholder">← Select a cache entry on the left to view and edit</div>';
  }
  renderList();
}

async function init() {
  entries = await loadCache();
  entries.sort((a, b) => b.updatedAt - a.updatedAt);
  renderList();
}

init();
