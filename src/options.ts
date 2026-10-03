import { defaultFolder, validateFolder, errorText } from './batch/model';
/**
 * AI Form Filler — Options Page
 */

import type { AIConfig, Profile } from './utils/types';
import { getAIConfig, saveAIConfig, getProfiles, saveProfiles } from './utils/storage';
import { pingNative } from './utils/native';
import { initI18n, applyI18n, t, setLocale, onLocaleChange, getLocale, type Locale } from './i18n';

type Provider = 'anthropic' | 'openai' | 'deepseek' | 'custom' | 'custom-anthropic';

const CLAUDE_MODELS = ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'];

const MODELS: Record<Provider, string[]> = {
  anthropic: CLAUDE_MODELS,
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
  deepseek: ['deepseek-v4-flash', 'deepseek-v4-pro'],
  custom: [],
  'custom-anthropic': CLAUDE_MODELS,
};

const DEFAULT_BASE_URL: Record<Provider, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com',
  custom: '',
  'custom-anthropic': '',
};

const CUSTOM_PROVIDERS: Provider[] = ['custom', 'custom-anthropic'];

const providerEl = document.getElementById('ai-provider') as HTMLSelectElement;
const modelEl = document.getElementById('ai-model') as HTMLInputElement;
const modelPresetsEl = document.getElementById('model-presets') as HTMLDataListElement;
const baseUrlEl = document.getElementById('base-url') as HTMLInputElement;
const baseUrlHint = document.getElementById('base-url-hint')!;
const apiKeyEl = document.getElementById('api-key') as HTMLInputElement;
const btnSaveAI = document.getElementById('btn-save-ai')!;
const aiSaveMsg = document.getElementById('ai-save-msg')!;
const localeEl = document.getElementById('ui-locale') as HTMLSelectElement;
const btnOpenShortcuts = document.getElementById('btn-open-shortcuts')!;

// chrome://extensions/shortcuts 无法用 <a href> 直接导航，需用 tabs.create 打开
btnOpenShortcuts.addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

const profileList = document.getElementById('profile-list')!;
const btnAddProfile = document.getElementById('btn-add-profile')!;
const profileEditor = document.getElementById('profile-editor')!;
const editorTitle = document.getElementById('editor-title')!;
const profileNameInput = document.getElementById('profile-name-input') as HTMLInputElement;
const btnSaveProfile = document.getElementById('btn-save-profile')!;
const btnCancelProfile = document.getElementById('btn-cancel-profile')!;
const btnDeleteProfile = document.getElementById('btn-delete-profile') as HTMLButtonElement;
const customFieldsContainer = document.getElementById('custom-fields-container')!;
const btnAddCustomField = document.getElementById('btn-add-custom-field')!;

let profiles: Profile[] = [];
let editingProfileId: string | null = null;

function updateModelOptions() {
  const provider = providerEl.value as Provider;
  modelPresetsEl.innerHTML = '';
  for (const m of MODELS[provider]) {
    const opt = document.createElement('option');
    opt.value = m;
    modelPresetsEl.appendChild(opt);
  }
  if (!modelEl.value && MODELS[provider].length > 0) {
    modelEl.value = MODELS[provider][0];
  }
  const def = DEFAULT_BASE_URL[provider];
  baseUrlEl.placeholder = def || t('options.baseUrlPlaceholderRequired');
  if (provider === 'custom') {
    baseUrlHint.textContent = t('options.baseUrlHintCustom');
  } else if (provider === 'custom-anthropic') {
    baseUrlHint.textContent = t('options.baseUrlHintCustomAnthropic');
  } else {
    baseUrlHint.textContent = t('options.baseUrlHintDefault', { url: def });
  }
}

// 用户切换 provider：非 custom 的固定接口（含 DeepSeek）自动填好默认 Base URL 与默认模型 id；
// custom 两项不自动填 Base URL（保留用户已填内容）。init 加载已存配置时不走这里，避免覆盖。
function onProviderChange() {
  const provider = providerEl.value as Provider;
  if (!CUSTOM_PROVIDERS.includes(provider)) {
    baseUrlEl.value = DEFAULT_BASE_URL[provider];
  }
  if (MODELS[provider].length > 0) {
    modelEl.value = MODELS[provider][0];
  }
  updateModelOptions();
}

providerEl.addEventListener('change', onProviderChange);

localeEl.addEventListener('change', async () => {
  const locale = localeEl.value as Locale;
  if (locale !== 'en' && locale !== 'zh-CN') return;
  await setLocale(locale);
  refreshUi();
});

function refreshUi() {
  applyI18n();
  updateModelOptions();
  renderProfiles();
  if (profileEditor.classList.contains('show')) {
    if (editingProfileId) {
      const p = profiles.find(x => x.id === editingProfileId);
      if (p) editorTitle.textContent = t('options.editProfile', { name: p.name });
    } else {
      editorTitle.textContent = t('options.newProfileTitle');
    }
  }
}

onLocaleChange(refreshUi);

btnSaveAI.addEventListener('click', async () => {
  const provider = providerEl.value as Provider;
  const config: AIConfig = {
    provider,
    apiKey: apiKeyEl.value.trim(),
    model: modelEl.value.trim(),
    baseUrl: baseUrlEl.value.trim() || undefined,
  };

  if (!config.apiKey) {
    showMsg(aiSaveMsg, 'error', t('options.errApiKey'));
    return;
  }
  if (!config.model) {
    showMsg(aiSaveMsg, 'error', t('options.errModel'));
    return;
  }
  if (CUSTOM_PROVIDERS.includes(provider) && !config.baseUrl) {
    showMsg(aiSaveMsg, 'error', t('options.errBaseUrl'));
    return;
  }

  await saveAIConfig(config);
  showMsg(aiSaveMsg, 'success', t('common.saved'));
});

function renderProfiles() {
  profileList.innerHTML = '';
  if (profiles.length === 0) {
    profileList.innerHTML = `<li style="font-size:12px;color:var(--muted);padding:4px 0;">${escHtml(t('options.noProfiles'))}</li>`;
    return;
  }
  for (const p of profiles) {
    const li = document.createElement('li');
    li.className = 'profile-item';
    const fieldCount = Object.keys(p.fields).filter(k => p.fields[k]).length;
    li.innerHTML = `
      <span class="profile-name">${escHtml(p.name)}</span>
      <span class="profile-meta">${escHtml(t('common.fields', { count: fieldCount }))}</span>
      <button class="btn btn-secondary btn-sm" data-id="${escHtml(p.id)}">${escHtml(t('common.edit'))}</button>`;
    li.querySelector('button')!.addEventListener('click', () => openEditor(p.id));
    profileList.appendChild(li);
  }
}

function openEditor(profileId?: string) {
  editingProfileId = profileId ?? null;

  if (profileId) {
    const p = profiles.find(x => x.id === profileId)!;
    editorTitle.textContent = t('options.editProfile', { name: p.name });
    profileNameInput.value = p.name;
    profileEditor.querySelectorAll<HTMLInputElement>('[data-key]').forEach(el => {
      el.value = p.fields[el.dataset.key!] ?? '';
    });
    customFieldsContainer.innerHTML = '';
    const standardKeys = new Set(
      [...profileEditor.querySelectorAll<HTMLInputElement>('[data-key]')].map(e => e.dataset.key!)
    );
    for (const [k, v] of Object.entries(p.fields)) {
      if (!standardKeys.has(k)) addCustomFieldRow(k, v);
    }
    btnDeleteProfile.style.display = 'inline-flex';
  } else {
    editorTitle.textContent = t('options.newProfileTitle');
    profileNameInput.value = '';
    profileEditor.querySelectorAll<HTMLInputElement>('[data-key]').forEach(el => {
      el.value = '';
    });
    customFieldsContainer.innerHTML = '';
    btnDeleteProfile.style.display = 'none';
  }

  profileEditor.classList.add('show');
  profileNameInput.focus();
}

function closeEditor() {
  profileEditor.classList.remove('show');
  editingProfileId = null;
}

function addCustomFieldRow(key = '', value = '') {
  const row = document.createElement('div');
  row.className = 'custom-field-row';
  row.innerHTML = `
    <input type="text" class="custom-key" placeholder="${escHtml(t('options.fieldKeyPlaceholder'))}" value="${escHtml(key)}" />
    <input type="text" class="custom-val" placeholder="${escHtml(t('common.value'))}" value="${escHtml(value)}" />
    <button class="btn btn-danger btn-sm">✕</button>`;
  row.querySelector('button')!.addEventListener('click', () => row.remove());
  customFieldsContainer.appendChild(row);
}

btnAddProfile.addEventListener('click', () => openEditor());
btnCancelProfile.addEventListener('click', closeEditor);
btnAddCustomField.addEventListener('click', () => addCustomFieldRow());

btnSaveProfile.addEventListener('click', async () => {
  const name = profileNameInput.value.trim();
  if (!name) {
    profileNameInput.focus();
    return;
  }

  const fields: Record<string, string> = {};
  profileEditor.querySelectorAll<HTMLInputElement>('[data-key]').forEach(el => {
    const v = el.value.trim();
    if (v) fields[el.dataset.key!] = v;
  });

  customFieldsContainer.querySelectorAll('.custom-field-row').forEach(row => {
    const k = (row.querySelector('.custom-key') as HTMLInputElement).value.trim();
    const v = (row.querySelector('.custom-val') as HTMLInputElement).value.trim();
    if (k) fields[k] = v;
  });

  if (editingProfileId) {
    const idx = profiles.findIndex(p => p.id === editingProfileId);
    if (idx >= 0) profiles[idx] = { id: editingProfileId, name, fields };
  } else {
    profiles.push({ id: crypto.randomUUID(), name, fields });
  }

  await saveProfiles(profiles);
  renderProfiles();
  closeEditor();
});

btnDeleteProfile.addEventListener('click', async () => {
  if (!editingProfileId) return;
  if (!confirm(t('common.deleteProfileConfirm'))) return;
  profiles = profiles.filter(p => p.id !== editingProfileId);
  await saveProfiles(profiles);
  renderProfiles();
  closeEditor();
});

function showMsg(el: HTMLElement, type: 'success' | 'error', text: string) {
  el.className = `save-msg ${type}`;
  el.textContent = text;
  setTimeout(() => { el.className = 'save-msg'; el.textContent = ''; }, 3000);
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function init() {
  await initI18n();
  localeEl.value = getLocale();
  applyI18n();

  const cfg = await getAIConfig();
  if (cfg) {
    providerEl.value = cfg.provider;
    apiKeyEl.value = cfg.apiKey;
    modelEl.value = cfg.model;
    baseUrlEl.value = cfg.baseUrl ?? '';
    updateModelOptions();
  } else {
    updateModelOptions();
  }

  profiles = await getProfiles();
  renderProfiles();
}

init();

const screenshotFolder = document.getElementById('screenshot-folder') as HTMLInputElement;
chrome.storage.local.get('screenshotFolder').then(s => { screenshotFolder.value = s.screenshotFolder || defaultFolder(); });
document.getElementById('save-screenshot-folder')!.addEventListener('click', async () => {
  const msg = document.getElementById('screenshot-folder-message')!;
  try {
    const folder = validateFolder(screenshotFolder.value);
    await chrome.storage.local.set({ screenshotFolder: folder });
    showMsg(msg, 'success', 'Saved. Applies to the next new batch.');
  } catch (e) { showMsg(msg, 'error', errorText(e)); }
});

// ── Local File Writer (Native Messaging) ────────────────────────────────────

const writerStatus = document.getElementById('writer-status')!;
const writerRoot = document.getElementById('writer-root')!;
const writerMsg = document.getElementById('writer-message')!;

async function refreshWriterStatus() {
  writerStatus.textContent = 'Checking…';
  writerStatus.className = 'writer-status';
  writerRoot.textContent = '–';
  try {
    const res = await pingNative();
    writerStatus.textContent = 'Connected';
    writerStatus.className = 'writer-status ok';
    writerRoot.textContent = res.outputRoot;
    showMsg(writerMsg as HTMLElement, 'success', `Host v${res.version}`);
  } catch (e) {
    writerStatus.textContent = 'Not Installed / Error';
    writerStatus.className = 'writer-status err';
    writerRoot.textContent = '–';
    writerMsg.className = 'save-msg error';
    writerMsg.textContent = errorText(e);
  }
}

document.getElementById('btn-test-writer')!.addEventListener('click', () => { void refreshWriterStatus(); });
void refreshWriterStatus();
