/**
 * 表单缓存管理页：列出所有缓存项，点击后可编辑（除 domHash 外）并保存。
 */

import type { FormCacheEntry, DetectedField } from './utils/types';
import { initI18n, applyI18n, t, onLocaleChange, getDateLocale } from './i18n';

const CACHE_KEY = 'formCache';

const listEl = document.getElementById('list')!;
const detailEl = document.getElementById('detail')!;
const countEl = document.getElementById('count')!;
const placeholderEl = document.getElementById('placeholder')!;

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

function actionMeta(e: FormCacheEntry): string {
  if (e.code) return t('cache.metaHasCode');
  if (e.actions) return t('cache.metaHasActions');
  return t('cache.metaNoActions');
}

function renderList() {
  countEl.textContent = t('cache.count', { count: entries.length });
  listEl.innerHTML = '';
  if (entries.length === 0) {
    listEl.innerHTML = `<div class="list-empty">${esc(t('cache.empty'))}</div>`;
    return;
  }
  for (const e of entries) {
    const item = document.createElement('div');
    item.className = 'item' + (e.id === activeId ? ' active' : '');
    const when = new Date(e.updatedAt).toLocaleString(getDateLocale(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    item.innerHTML =
      `<div class="item-name">${esc(e.formName)}</div>` +
      `<div class="item-url">${esc(e.urlPattern)}</div>` +
      `<div class="item-meta">${t('cache.metaFields', { count: e.fields?.length ?? 0 })} · ${actionMeta(e)} · ${when}</div>`;
    item.addEventListener('click', () => { activeId = e.id; renderList(); renderDetail(e); });
    listEl.appendChild(item);
  }
}

function renderDetail(e: FormCacheEntry) {
  placeholderEl.style.display = 'none';
  detailEl.innerHTML = `
    <div class="detail-head">
      <div class="edits">
        <div class="edit-row"><label>${esc(t('cache.formName'))}</label><input id="d-name" type="text" /></div>
        <div class="edit-row"><label>${esc(t('cache.matchUrl'))}</label><input id="d-url" type="text" /></div>
        <div class="edit-row"><label>${esc(t('cache.domHash'))}</label><input id="d-hash" type="text" readonly /></div>
      </div>
      <div class="detail-actions">
        <button class="btn-save" id="d-save">${esc(t('cache.save'))}</button>
        <button class="btn-del" id="d-del">${esc(t('cache.delete'))}</button>
      </div>
    </div>
    <div class="save-msg" id="d-msg"></div>
    <div class="panes">
      <div class="pane">
        <div class="pane-head">${esc(t('cache.fieldsJson'))}</div>
        <textarea id="d-fields" spellcheck="false"></textarea>
      </div>
      <div class="pane">
        <div class="pane-head">${esc(t('cache.playwrightCode'))}</div>
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

  if (!formName) return msg('err', t('cache.errEmptyName'));
  if (!urlPattern) return msg('err', t('cache.errEmptyUrl'));
  try { new RegExp(urlPattern); } catch { return msg('err', t('cache.errInvalidUrl')); }

  const nameDup = entries.find(e => e.id !== id && e.formName.trim().toLowerCase() === formName.toLowerCase());
  if (nameDup) return msg('err', t('cache.errDupeName', { name: formName }));

  let fields: DetectedField[];
  try {
    const parsed = JSON.parse(fieldsText);
    fields = Array.isArray(parsed) ? parsed : parsed?.fields;
    if (!Array.isArray(fields)) throw new Error();
  } catch { return msg('err', t('cache.errInvalidFields')); }

  const dup = entries.find(e => e.id !== id && e.urlPattern === urlPattern && e.formName === formName);
  if (dup) return msg('err', t('cache.errDupeEntry'));

  const e = entries[idx];
  e.formName = formName;
  e.urlPattern = urlPattern;
  e.fields = fields;
  e.code = code;
  e.updatedAt = Date.now();
  await storeCache(entries);
  renderList();
  msg('ok', t('cache.saved'));
}

async function deleteEntry(id: string) {
  if (!confirm(t('cache.deleteConfirm'))) return;
  entries = entries.filter(e => e.id !== id);
  await storeCache(entries);
  if (activeId === id) {
    activeId = null;
    detailEl.innerHTML = '';
    placeholderEl.style.display = '';
    applyI18n();
  }
  renderList();
}

function refreshUi() {
  applyI18n();
  renderList();
  if (activeId) {
    const e = entries.find(x => x.id === activeId);
    if (e) renderDetail(e);
  }
}

onLocaleChange(refreshUi);

async function init() {
  await initI18n();
  applyI18n();
  entries = await loadCache();
  entries.sort((a, b) => b.updatedAt - a.updatedAt);
  renderList();
}

init();
