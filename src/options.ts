/**
 * AI Form Filler — Options Page
 */

import type { AIConfig, Profile } from './utils/types';
import { getAIConfig, saveAIConfig, getProfiles, saveProfiles } from './utils/storage';

type Provider = 'anthropic' | 'openai' | 'custom' | 'custom-anthropic';

// ── Model presets (仅作输入建议，可输入任意模型 ID) ─────────────────────────

const CLAUDE_MODELS = ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'];

const MODELS: Record<Provider, string[]> = {
  anthropic: CLAUDE_MODELS,
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
  custom: [],
  'custom-anthropic': CLAUDE_MODELS,
};

// 各 provider 的默认 Base URL（留空则使用此值）
const DEFAULT_BASE_URL: Record<Provider, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  custom: '',
  'custom-anthropic': '',
};

// 需要用户必填 Base URL 的 provider
const CUSTOM_PROVIDERS: Provider[] = ['custom', 'custom-anthropic'];

// ── DOM refs ──────────────────────────────────────────────────────────────

const providerEl = document.getElementById('ai-provider') as HTMLSelectElement;
const modelEl = document.getElementById('ai-model') as HTMLInputElement;
const modelPresetsEl = document.getElementById('model-presets') as HTMLDataListElement;
const baseUrlEl = document.getElementById('base-url') as HTMLInputElement;
const baseUrlHint = document.getElementById('base-url-hint')!;
const apiKeyEl = document.getElementById('api-key') as HTMLInputElement;
const btnSaveAI = document.getElementById('btn-save-ai')!;
const aiSaveMsg = document.getElementById('ai-save-msg')!;

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

// ── State ─────────────────────────────────────────────────────────────────

let profiles: Profile[] = [];
let editingProfileId: string | null = null;

// ── AI Config ─────────────────────────────────────────────────────────────

function updateModelOptions() {
  const provider = providerEl.value as Provider;
  // 刷新模型 ID 建议列表（datalist），不清空用户已输入的值
  modelPresetsEl.innerHTML = '';
  for (const m of MODELS[provider]) {
    const opt = document.createElement('option');
    opt.value = m;
    modelPresetsEl.appendChild(opt);
  }
  // 未填模型时给一个默认建议
  if (!modelEl.value && MODELS[provider].length > 0) {
    modelEl.value = MODELS[provider][0];
  }
  // 更新 Base URL 提示
  const def = DEFAULT_BASE_URL[provider];
  baseUrlEl.placeholder = def || 'https://your-endpoint.com/v1 (required)';
  if (provider === 'custom') {
    baseUrlHint.textContent = 'Enter the Base URL of an OpenAI-compatible endpoint (no /chat/completions suffix), e.g. a local or third-party proxy';
  } else if (provider === 'custom-anthropic') {
    baseUrlHint.textContent = 'Enter the Base URL of a Claude/Anthropic-compatible endpoint (no /v1/messages suffix)';
  } else {
    baseUrlHint.textContent = `Default: ${def} (override here for a proxy; no suffix needed)`;
  }
}

providerEl.addEventListener('change', updateModelOptions);

btnSaveAI.addEventListener('click', async () => {
  const provider = providerEl.value as Provider;
  const config: AIConfig = {
    provider,
    apiKey: apiKeyEl.value.trim(),
    model: modelEl.value.trim(),
    baseUrl: baseUrlEl.value.trim() || undefined,
  };

  if (!config.apiKey) {
    showMsg(aiSaveMsg, 'error', 'Please enter your API Key');
    return;
  }
  if (!config.model) {
    showMsg(aiSaveMsg, 'error', 'Please enter a Model ID');
    return;
  }
  if (CUSTOM_PROVIDERS.includes(provider) && !config.baseUrl) {
    showMsg(aiSaveMsg, 'error', 'Custom provider requires a Base URL');
    return;
  }

  await saveAIConfig(config);
  showMsg(aiSaveMsg, 'success', '✓ Saved');
});

// ── Profiles ──────────────────────────────────────────────────────────────

function renderProfiles() {
  profileList.innerHTML = '';
  if (profiles.length === 0) {
    profileList.innerHTML = '<li style="font-size:12px;color:var(--muted);padding:4px 0;">No profiles yet</li>';
    return;
  }
  for (const p of profiles) {
    const li = document.createElement('li');
    li.className = 'profile-item';
    const fieldCount = Object.keys(p.fields).filter(k => p.fields[k]).length;
    li.innerHTML = `
      <span class="profile-name">${escHtml(p.name)}</span>
      <span class="profile-meta">${fieldCount} fields</span>
      <button class="btn btn-secondary btn-sm" data-id="${escHtml(p.id)}">Edit</button>`;
    li.querySelector('button')!.addEventListener('click', () => openEditor(p.id));
    profileList.appendChild(li);
  }
}

function openEditor(profileId?: string) {
  editingProfileId = profileId ?? null;

  if (profileId) {
    const p = profiles.find(x => x.id === profileId)!;
    editorTitle.textContent = `Edit profile: ${p.name}`;
    profileNameInput.value = p.name;
    // Fill standard fields
    profileEditor.querySelectorAll<HTMLInputElement>('[data-key]').forEach(el => {
      el.value = p.fields[el.dataset.key!] ?? '';
    });
    // Custom fields
    customFieldsContainer.innerHTML = '';
    const standardKeys = new Set(
      [...profileEditor.querySelectorAll<HTMLInputElement>('[data-key]')].map(e => e.dataset.key!)
    );
    for (const [k, v] of Object.entries(p.fields)) {
      if (!standardKeys.has(k)) addCustomFieldRow(k, v);
    }
    btnDeleteProfile.style.display = 'inline-flex';
  } else {
    editorTitle.textContent = 'New profile';
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
    <input type="text" class="custom-key" placeholder="Field name (key)" value="${escHtml(key)}" />
    <input type="text" class="custom-val" placeholder="Value" value="${escHtml(value)}" />
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

  // Custom fields
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
  if (!confirm('Delete this profile?')) return;
  profiles = profiles.filter(p => p.id !== editingProfileId);
  await saveProfiles(profiles);
  renderProfiles();
  closeEditor();
});

// ── Helpers ───────────────────────────────────────────────────────────────

function showMsg(el: HTMLElement, type: 'success' | 'error', text: string) {
  el.className = `save-msg ${type}`;
  el.textContent = text;
  setTimeout(() => { el.className = 'save-msg'; el.textContent = ''; }, 3000);
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Init ──────────────────────────────────────────────────────────────────

async function init() {
  // Load AI config
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

  // Load profiles
  profiles = await getProfiles();
  renderProfiles();
}

init();
