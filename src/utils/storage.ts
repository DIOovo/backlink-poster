import type { SavedScript, Profile, AIConfig, CaptureMode } from './types';
import type { Locale } from '../i18n/types';

// ── Fingerprint / Key helpers ──────────────────────────────────────────────

function simpleHash(str: string): string {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(31, h) + str.charCodeAt(i) | 0;
  }
  return (h >>> 0).toString(36);
}

export function getFingerprint(snapshot: string): string {
  return simpleHash(snapshot);
}

export function getScriptKey(url: string, fingerprint: string): string {
  try {
    const { hostname, pathname } = new URL(url);
    return `script:${hostname}${pathname}:${fingerprint}`;
  } catch {
    return `script:unknown:${fingerprint}`;
  }
}

// ── Scripts ────────────────────────────────────────────────────────────────

export async function saveScript(key: string, script: SavedScript): Promise<void> {
  await chrome.storage.local.set({ [key]: script });
}

export async function getScript(key: string): Promise<SavedScript | null> {
  const res = await chrome.storage.local.get(key);
  return (res[key] as SavedScript) ?? null;
}

export async function getScriptsForUrl(url: string): Promise<Array<{ key: string; script: SavedScript }>> {
  try {
    const { hostname, pathname } = new URL(url);
    const prefix = `script:${hostname}${pathname}:`;
    const all = await chrome.storage.local.get(null);
    return Object.entries(all)
      .filter(([k]) => k.startsWith(prefix))
      .map(([key, script]) => ({ key, script: script as SavedScript }))
      .sort((a, b) => b.script.timestamp - a.script.timestamp);
  } catch {
    return [];
  }
}

export async function deleteScript(key: string): Promise<void> {
  await chrome.storage.local.remove(key);
}

// ── Profiles ───────────────────────────────────────────────────────────────

export async function getProfiles(): Promise<Profile[]> {
  const res = await chrome.storage.local.get('profiles');
  return (res.profiles as Profile[]) ?? [];
}

export async function saveProfiles(profiles: Profile[]): Promise<void> {
  await chrome.storage.local.set({ profiles });
}

export async function getProfile(id: string): Promise<Profile | null> {
  const profiles = await getProfiles();
  return profiles.find(p => p.id === id) ?? null;
}

// ── AI Config ──────────────────────────────────────────────────────────────

export async function getAIConfig(): Promise<AIConfig | null> {
  const res = await chrome.storage.local.get('aiConfig');
  return (res.aiConfig as AIConfig) ?? null;
}

export async function saveAIConfig(config: AIConfig): Promise<void> {
  await chrome.storage.local.set({ aiConfig: config });
}

// ── Capture mode（aria 快照 / 真实 DOM HTML）─────────────────────────────────

const CAPTURE_MODE_KEY = 'captureMode';

export async function getCaptureMode(): Promise<CaptureMode> {
  const res = await chrome.storage.local.get(CAPTURE_MODE_KEY);
  return res[CAPTURE_MODE_KEY] === 'html' ? 'html' : 'aria';
}

export async function saveCaptureMode(mode: CaptureMode): Promise<void> {
  await chrome.storage.local.set({ [CAPTURE_MODE_KEY]: mode });
}

// ── UI locale ──────────────────────────────────────────────────────────────

const UI_LOCALE_KEY = 'uiLocale';

export async function getUiLocale(): Promise<Locale | null> {
  const res = await chrome.storage.local.get(UI_LOCALE_KEY);
  const v = res[UI_LOCALE_KEY];
  return v === 'en' || v === 'zh-CN' ? v : null;
}

export async function saveUiLocale(locale: Locale): Promise<void> {
  await chrome.storage.local.set({ [UI_LOCALE_KEY]: locale });
}
