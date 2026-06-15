import type { Locale, MessageParams } from './types';
import en from './locales/en';
import zhCN from './locales/zh-CN';
import type { MessageKey } from './locales/en';
import { getUiLocale, saveUiLocale } from '../utils/storage';

export type { Locale, MessageKey };

const MESSAGES: Record<Locale, Record<string, string>> = {
  en: en as Record<string, string>,
  'zh-CN': zhCN,
};

let currentLocale: Locale = 'en';
const listeners = new Set<() => void>();

function detectBrowserLocale(): Locale {
  const lang = (typeof navigator !== 'undefined' ? navigator.language : 'en') || 'en';
  return lang.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, key: string) =>
    params[key] !== undefined ? String(params[key]) : `{${key}}`);
}

export function getLocale(): Locale {
  return currentLocale;
}

export function getDateLocale(): string {
  return currentLocale === 'zh-CN' ? 'zh-CN' : 'en-US';
}

export function t(key: MessageKey | string, params?: MessageParams): string {
  const msg = MESSAGES[currentLocale]?.[key] ?? MESSAGES.en[key] ?? key;
  return interpolate(msg, params);
}

export async function initI18n(): Promise<Locale> {
  const stored = await getUiLocale();
  currentLocale = stored ?? detectBrowserLocale();
  document.documentElement?.setAttribute('lang', currentLocale === 'zh-CN' ? 'zh-CN' : 'en');
  return currentLocale;
}

export async function setLocale(locale: Locale): Promise<void> {
  currentLocale = locale;
  await saveUiLocale(locale);
  document.documentElement?.setAttribute('lang', locale === 'zh-CN' ? 'zh-CN' : 'en');
  listeners.forEach(fn => fn());
}

export function onLocaleChange(fn: () => void): void {
  listeners.add(fn);
}

export function applyI18n(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (key) el.textContent = t(key as MessageKey);
  });
  root.querySelectorAll<HTMLElement>('[data-i18n-html]').forEach(el => {
    const key = el.getAttribute('data-i18n-html');
    if (!key) return;
    const linkKey = el.getAttribute('data-i18n-link-key');
    const linkText = linkKey ? t(linkKey as MessageKey) : '';
    if (linkKey) {
      const link = el.querySelector('[data-i18n-link]');
      if (link) link.textContent = linkText;
      const full = t(key as MessageKey, { link: linkText });
      // Replace {link} placeholder with actual link element text already set
      const parts = full.split(linkText);
      if (parts.length === 2 && link) {
        el.childNodes.forEach(n => { if (n !== link) n.remove(); });
        if (parts[0]) el.insertBefore(document.createTextNode(parts[0]), link);
        if (parts[1]) el.appendChild(document.createTextNode(parts[1]));
      } else {
        el.textContent = full;
      }
    } else {
      el.innerHTML = t(key as MessageKey);
    }
  });
  root.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach(el => {
    const key = el.getAttribute('data-i18n-title');
    if (key) el.title = t(key as MessageKey);
  });
  root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    if (key) el.placeholder = t(key as MessageKey);
  });
  const titleKey = document.querySelector('title')?.getAttribute('data-i18n');
  if (titleKey) document.title = t(titleKey as MessageKey);
}

// Sync locale across extension contexts when changed in options
if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.uiLocale) return;
    const next = changes.uiLocale.newValue as Locale | undefined;
    if (next === 'en' || next === 'zh-CN') {
      currentLocale = next;
      document.documentElement?.setAttribute('lang', next === 'zh-CN' ? 'zh-CN' : 'en');
      listeners.forEach(fn => fn());
    }
  });
}
