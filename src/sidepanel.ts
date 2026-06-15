/**
 * AI Form Filler — Side Panel UI
 *
 * 流程：选择 DOM → 采集快照+domHash → 命中缓存?→ 确认/编辑字段(含 URL 正则+表单名) → 保存
 *      → 生成动作 JSON(可编辑) → 确认生成 Playwright 代码(可编辑双向同步) → 执行 → 成功缓存动作并清空状态
 *
 * 本文件被独立打包，禁止 runtime import（仅 import type）。
 */

import type { CaptureMode, DetectedField, FillAction, FillTarget, FormCacheEntry, ValidationIssue } from './utils/types';

// ── State ─────────────────────────────────────────────────────────────────

type PanelState =
  | 'idle' | 'selecting' | 'selected'
  | 'snapshotting' | 'analyzing' | 'generating' | 'filling';

let state: PanelState = 'idle';
let activeTabId: number | null = null;
let currentUrl = '';
let selectedSelector = '';

let detectedSnapshot = '';
let detectedDomHash = '';

// 采集模式固定为真实 DOM HTML（已移除 ARIA snapshot 选项）
const captureMode: CaptureMode = 'html';
// 本次快照实际采集所用的模式（下游 analyze/generate 沿用）
let detectedMode: CaptureMode = 'html';

let currentEntryId: string | null = null;
let cacheHit = false;
// 一键本地填充：选元素后自动串起「(命中缓存?载入代码 : 本地识别→本地生成)→展示代码」
let oneClickLocal = false;
let lastActionsJson = '';
let lastCode = '';

// ── 录制状态 ───────────────────────────────────────────────────────────────
let recording = false;          // 是否正在录制
let recordIndex = 0;            // 插入位置 = 代码原始行边界（0..总行数，插入到第 N 行之前）
let recordedBuffer: FillAction[] = []; // 本次录制累计的动作

// ── 校验 / 拾取修复状态 ─────────────────────────────────────────────────────
let lastIssues: ValidationIssue[] = [];   // 最近一次定位校验报告
let pickingIndex: number | null = null;   // 正在"点选修复"的动作下标

// ── DOM refs ──────────────────────────────────────────────────────────────

const $ = (id: string) => document.getElementById(id)!;
const urlBar = $('current-url');
const btnOptions = $('btn-options');
const btnCache = $('btn-cache');
const linkOptions = $('link-options');
const noConfigBanner = $('no-config-banner');
const btnSelect = $('btn-select');
const btnOneClickLocal = $('btn-oneclick-local') as HTMLButtonElement;
const selectedInfo = $('selected-info');
const selectedSelectorEl = $('selected-selector');
const btnClear = $('btn-clear');
const profileSelect = $('profile-select') as HTMLSelectElement;
const btnFill = $('btn-fill') as HTMLButtonElement;
const btnFillLocal = $('btn-fill-local') as HTMLButtonElement;

const snapshotSection = $('snapshot-section');
const snapshotHeader = $('snapshot-header');
const snapshotHeaderLabel = $('snapshot-header-label');
const snapshotBody = $('snapshot-body');
const snapshotView = $('snapshot-view');
const fieldsSection = $('fields-section');
const fieldsHeader = $('fields-header');
const fieldsBody = $('fields-body');
const fieldsList = $('fields-list');
const btnAddField = $('btn-add-field') as HTMLButtonElement;
const formNameInput = $('form-name-input') as HTMLInputElement;
const urlPatternInput = $('url-pattern-input') as HTMLInputElement;
const domHashView = $('dom-hash-view') as HTMLInputElement;
const cacheHitHint = $('cache-hit');
const btnConfirmFields = $('btn-confirm-fields') as HTMLButtonElement;

const actionsSection = $('actions-section');
const actionsToggle = $('actions-toggle');
const actionsCaret = $('actions-caret');
const actionsBody = $('actions-body');
const actionsJsonEl = $('actions-json') as HTMLTextAreaElement;
const btnRegen = $('btn-regen') as HTMLButtonElement;
const btnRegenLocal = $('btn-regen-local') as HTMLButtonElement;

const codeSection = $('code-section');
const codeEditor = $('code-editor');
const codeTextEl = $('code-text') as HTMLTextAreaElement;
const codeHl = $('code-hl');
const recOverlay = $('rec-overlay');
const recLine = $('rec-line');
const recFab = $('rec-fab') as HTMLButtonElement;
const btnExecute = $('btn-execute') as HTMLButtonElement;
const btnValidate = $('btn-validate') as HTMLButtonElement;
const issuesList = $('issues-list');
const issuesRows = $('issues-rows');

const statusBar = $('status-bar');
const statusSpinner = $('status-spinner');
const statusText = $('status-text');
const stepsLog = $('steps-log');
const streamBox = $('stream-box');

// ── Form cache (chrome.storage.local) ───────────────────────────────────────

const CACHE_KEY = 'formCache';

async function loadCache(): Promise<FormCacheEntry[]> {
  const r = await chrome.storage.local.get(CACHE_KEY);
  return (r[CACHE_KEY] as FormCacheEntry[]) ?? [];
}
async function storeCache(list: FormCacheEntry[]): Promise<void> {
  await chrome.storage.local.set({ [CACHE_KEY]: list });
}
function matchCache(list: FormCacheEntry[], url: string, domHash: string): FormCacheEntry | null {
  return list.find(e => {
    try { return new RegExp(e.urlPattern).test(url) && e.domHash === domHash; }
    catch { return false; }
  }) ?? null;
}
/**
 * 以 (URL+表单名) 为唯一键的 upsert：
 * 先按 id 找已有项，找不到再按 (urlPattern+formName) 找——命中则「修改」该项，
 * 都没有才「新建」。因此重新分析 / 修改命中缓存的表单都会更新而非报重复。
 */
async function upsertCache(entry: FormCacheEntry): Promise<{ ok: boolean; id: string }> {
  const list = await loadCache();
  let idx = list.findIndex(e => e.id === entry.id);
  if (idx < 0) idx = list.findIndex(e => e.urlPattern === entry.urlPattern && e.formName === entry.formName);
  if (idx >= 0) {
    entry.id = list[idx].id;               // 复用已有 id（按键修改）
    entry.createdAt = list[idx].createdAt;  // 保留创建时间
    list[idx] = entry;
  } else {
    list.push(entry);
  }
  await storeCache(list);
  return { ok: true, id: entry.id };
}
async function updateCacheActions(id: string, actions: string, code?: string): Promise<void> {
  const list = await loadCache();
  const e = list.find(x => x.id === id);
  if (e) {
    if (actions) e.actions = actions;
    if (code !== undefined) e.code = code;
    e.updatedAt = Date.now();
    await storeCache(list);
  }
}

// ── JSON ⇄ Playwright code conversion ───────────────────────────────────────

function escStr(v: string): string {
  return String(v ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
/** 生成 JS 字符串字面量：含换行用反引号模板串（避免单引号换行报错），否则用单引号 */
function jsStr(v: string): string {
  const s = String(v ?? '');
  if (/[\r\n]/.test(s)) {
    return '`' + s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${') + '`';
  }
  return `'${escStr(s)}'`;
}
/** 始终用反引号模板串包裹（富文本等场景，正确处理换行） */
function tpl(v: string): string {
  return '`' + String(v ?? '').replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${') + '`';
}
/** 还原 JS 字符串字面量内容（单/双/反引号转义） */
function unescStr(v: string): string {
  return String(v ?? '').replace(/\\(\$\{|[`'"\\])/g, (_m, g) => g);
}

/**
 * 修正不安全的 CSS 选择器：若是单一 #id 形式且 id 含 CSS 不安全字符（如 / : . 空格等），
 * 改写为属性选择器 [id="..."]，避免 Playwright 解析 CSS 时报 "Unexpected token"。
 * 其它复杂选择器（含组合符、属性、类等）原样保留。
 */
function safeCss(sel: string): string {
  const s = String(sel ?? '').trim();
  // 仅匹配「单一 #后跟一段无组合符的标识」；id 部分允许任意非组合符字符（含 / 等）
  const m = s.match(/^#([^\s>+~,\[\]()]+)$/);
  if (m && /[^A-Za-z0-9_-]/.test(m[1])) {
    return `[id="${m[1].replace(/(["\\])/g, '\\$1')}"]`;
  }
  return s;
}

function locatorCode(t: FillTarget): string {
  switch (t.by) {
    case 'label':       return `getByLabel(${jsStr(t.value)})`;
    case 'placeholder': return `getByPlaceholder(${jsStr(t.value)})`;
    case 'role':        return t.value
                          ? `getByRole(${jsStr(t.role || 'textbox')}, { name: ${jsStr(t.value)} })`
                          : `getByRole(${jsStr(t.role || 'textbox')}).first()`;
    case 'text':        return `getByText(${jsStr(t.value)})`;
    case 'altText':     return `getByAltText(${jsStr(t.value)})`;
    case 'title':       return `getByTitle(${jsStr(t.value)})`;
    case 'name':        return `locator('[name="${escStr(t.value)}"]')`;
    case 'id':          return `locator('[id="${escStr(t.value)}"]')`;
    case 'css':         return `locator(${jsStr(safeCss(t.value))})`;
    default:            return `locator(${jsStr(safeCss(t.value))})`;
  }
}
function methodCode(a: FillAction): string {
  switch (a.type) {
    case 'fill':          return `fill(${tpl(a.value ?? '')})`;   // 始终反引号
    case 'selectOption':  return a.value && a.value.length ? `selectOption(${jsStr(a.value)})` : `selectOption({ index: 0 })`;
    case 'check':         return `check()`;
    case 'uncheck':       return `uncheck()`;
    case 'click':         return `click()`;
    case 'press':         return `press(${jsStr(a.value || 'Enter')})`;
    case 'pressSequentially': return `pressSequentially(${tpl(a.value ?? '')})`;
    case 'type':          return `type(${tpl(a.value ?? '')})`;
    case 'clear':         return `clear()`;
    case 'setInputFiles': return `setInputFiles(${jsStr(a.value ?? '')})`;
    case 'hover':         return `hover()`;
    case 'focus':         return `focus()`;
    // 调试用低层事件
    case 'mousedown': case 'mouseup': case 'mousemove':
    case 'pointerdown': case 'pointerup': case 'pointermove':
      return `${a.type}()`;
    case 'dispatchEvent': return `dispatchEvent(${jsStr(a.value || 'click')})`;
    default:              return `click()`;
  }
}
function actionLine(a: FillAction): string {
  const base = (a.raw && a.raw.trim()) ? a.raw.trim() : `page.${locatorCode(a.target)}`;
  return `await ${base}.${methodCode(a)};`;
}
function actionsToCode(actions: FillAction[]): string {
  return actions.map(actionLine).join('\n');
}

function parseLocator(s: string): { target: FillTarget; rest: string } {
  // getByRole('role', { name: 'x' })
  let m = s.match(/^getByRole\(\s*(['"`])([\s\S]*?)\1\s*,\s*\{\s*name\s*:\s*(['"`])([\s\S]*?)\3\s*\}\s*\)/);
  if (m) return { target: { by: 'role', role: unescStr(m[2]), value: unescStr(m[4]) }, rest: s.slice(m[0].length) };
  // getByRole('role')  —— 无 name（如 option），执行时取 .first()
  m = s.match(/^getByRole\(\s*(['"`])([\s\S]*?)\1\s*\)/);
  if (m) return { target: { by: 'role', role: unescStr(m[2]), value: '' }, rest: s.slice(m[0].length) };

  m = s.match(/^getBy(Label|Placeholder|Text|AltText|Title)\(\s*(['"`])([\s\S]*?)\2\s*\)/);
  if (m) {
    const map: Record<string, FillTarget['by']> = { Label: 'label', Placeholder: 'placeholder', Text: 'text', AltText: 'altText', Title: 'title' };
    return { target: { by: map[m[1]], value: unescStr(m[3]) }, rest: s.slice(m[0].length) };
  }
  m = s.match(/^locator\(\s*(['"`])([\s\S]*?)\1\s*\)/);
  if (m) {
    const sel = unescStr(m[2]);
    let mm = sel.match(/^\[name="([\s\S]*)"\]$/);
    if (mm) return { target: { by: 'name', value: mm[1] }, rest: s.slice(m[0].length) };
    mm = sel.match(/^\[id="([\s\S]*)"\]$/);
    if (mm) return { target: { by: 'id', value: mm[1] }, rest: s.slice(m[0].length) };
    return { target: { by: 'css', value: sel }, rest: s.slice(m[0].length) };
  }
  throw new Error('Cannot parse locator: ' + s);
}
function firstString(a: string): string {
  const m = a.match(/(['"`])([\s\S]*?)\1/);
  return m ? unescStr(m[2]) : '';
}
/** 按顶层分号切分语句；引号（'、"、`）内的分号不切分 */
function splitStatements(code: string): string[] {
  const out: string[] = [];
  let buf = '';
  let quote: string | null = null;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (quote) {
      buf += c;
      if (c === '\\') { buf += code[i + 1] ?? ''; i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') { quote = c; buf += c; continue; }
    if (c === ';') { out.push(buf); buf = ''; continue; }
    buf += c;
  }
  if (buf.trim()) out.push(buf);
  return out.map(s => s.trim()).filter(s => s && !s.startsWith('//'));
}

/** 尝试把链式表达式解析为单一结构化 target（仅 page.<一个定位器>[.first()/.nth()/.last()]） */
function trySimpleTarget(chain: string): FillTarget | null {
  if (!chain.startsWith('page.')) return null;
  try {
    const { target, rest } = parseLocator(chain.slice('page.'.length));
    if (/^(\.first\(\)|\.last\(\)|\.nth\(\s*\d+\s*\))*$/.test(rest.trim())) return target;
  } catch { /* not simple */ }
  return null;
}

/**
 * 把 Playwright 代码解析为动作 JSON（仅用于显示同步，尽力而为）：
 * 简单单定位器 → 结构化 target；复杂链（相对定位 / keyboard / frameLocator 等）→ raw。
 * 不抛错；无法解析的行跳过。执行始终以代码为准，不依赖本函数。
 */
function codeToActions(code: string): FillAction[] {
  const stmts = splitStatements(code);
  const actions: FillAction[] = [];
  for (const stmt of stmts) {
    const m = stmt.match(/^await\s+(page\.[\s\S]+)\.([a-zA-Z]+)\(([\s\S]*)\)$/);
    if (!m) continue; // 跳过无法识别的行
    const chain = m[1].trim();
    const type = m[2] as FillAction['type'];
    const argsRaw = m[3].trim();
    const action: FillAction = { type, target: { by: 'css', value: '' } };
    const simple = trySimpleTarget(chain);
    if (simple) action.target = simple;
    else action.raw = chain;
    if (type === 'selectOption') {
      if (!/index\s*:\s*0/.test(argsRaw)) action.value = firstString(argsRaw);
    } else if (type === 'fill' || type === 'press' || type === 'pressSequentially' || type === 'type' || type === 'setInputFiles' || type === 'dispatchEvent') {
      action.value = firstString(argsRaw);
    }
    actions.push(action);
  }
  return actions;
}

function parseActionsJson(text: string): FillAction[] {
  let data: any;
  try { data = JSON.parse(text); } catch { throw new Error('Invalid action JSON'); }
  const list = Array.isArray(data) ? data : data?.actions;
  if (!Array.isArray(list) || !list.length) throw new Error('Action JSON has no actions array');
  return list as FillAction[];
}
function prettyActions(text: string): string {
  try { return JSON.stringify({ actions: parseActionsJson(text) }, null, 2); }
  catch { return text; }
}

// ── UI helpers ────────────────────────────────────────────────────────────

function setState(s: PanelState) {
  state = s;
  btnSelect.classList.toggle('selecting', s === 'selecting');
  btnSelect.textContent = s === 'selecting'
    ? '🖱 Click an element on the page… (ESC to cancel)'
    : s === 'idle' ? '🎯 Click to pick a page element' : '🔄 Re-select';
  selectedInfo.classList.toggle('hidden', s === 'idle' || s === 'selecting');

  const busy = s === 'snapshotting' || s === 'analyzing' || s === 'generating' || s === 'filling';

  btnFill.disabled = !(s === 'selected' && !!detectedSnapshot);
  btnFill.classList.toggle('running', s === 'analyzing' || s === 'snapshotting');
  btnFill.textContent = s === 'analyzing' ? '⏳ Analyzing...' : s === 'snapshotting' ? '⏳ Reading...' : '🔍 Analyze form fields (AI)';

  // 本地分析只需选区（无需 AI 快照、无需 API Key）
  btnFillLocal.disabled = !(s === 'selected' && !!selectedSelector);
  // 一键本地填充：选择/识别/生成/执行进行中时禁用
  btnOneClickLocal.disabled = busy || s === 'selecting';

  btnConfirmFields.disabled = busy;
  btnRegen.disabled = s === 'generating' || s === 'filling';
  btnRegenLocal.disabled = s === 'generating' || s === 'filling';
  btnRegen.classList.toggle('running', s === 'generating');
  if (s === 'generating') btnRegen.textContent = '⏳ Generating...';
  else updateRegenLabel();

  const locked = s === 'filling';
  actionsJsonEl.readOnly = locked;
  codeTextEl.readOnly = locked;
  btnExecute.disabled = locked;
  btnExecute.classList.toggle('running', locked);
  btnExecute.textContent = locked ? '⏳ Filling...' : '⚡ Confirm & fill the page';
  btnValidate.disabled = busy;
}

function showStatus(type: 'info' | 'success' | 'error', text: string) {
  statusBar.className = `status-bar show ${type}`;
  statusSpinner.style.display = type === 'info' ? 'block' : 'none';
  statusText.textContent = text;
}
function hideStatus() { statusBar.classList.remove('show'); }

function showStream(text: string) {
  streamBox.textContent = text;
  streamBox.classList.add('show');
  streamBox.scrollTop = streamBox.scrollHeight;
}
function hideStream() { streamBox.classList.remove('show'); streamBox.textContent = ''; }

function resetSteps() { stepsLog.innerHTML = ''; stepsLog.classList.remove('show'); }
function addStep(text: string, step?: number, total?: number) {
  const prev = stepsLog.querySelector('.step-line.active');
  if (prev) { prev.classList.remove('active'); prev.classList.add('done'); prev.querySelector('.step-icon')!.textContent = '✓'; }
  const line = document.createElement('div');
  line.className = 'step-line active';
  const prefix = step && total ? `Step ${step}/${total} · ` : '';
  line.innerHTML = '<span class="step-icon">●</span><span class="step-text"></span>';
  line.querySelector('.step-text')!.textContent = prefix + text;
  stepsLog.appendChild(line);
  stepsLog.classList.add('show');
}
function finishSteps(ok: boolean) {
  stepsLog.querySelectorAll('.step-line.active').forEach(el => {
    el.classList.remove('active'); el.classList.add(ok ? 'done' : 'fail');
    el.querySelector('.step-icon')!.textContent = ok ? '✓' : '✕';
  });
}

// 折叠/展开一个可折叠区块（header 上加 .open 旋转 caret，body 上加 .collapsed 隐藏）
function setCollapsed(header: HTMLElement, body: HTMLElement, collapsed: boolean) {
  body.classList.toggle('collapsed', collapsed);
  header.classList.toggle('open', !collapsed);
}

function showSnapshot(text: string) {
  snapshotView.textContent = text;
  snapshotHeaderLabel.textContent = 'Captured page snapshot (real DOM HTML)';
  setCollapsed(snapshotHeader, snapshotBody, false); // 新快照默认展开供确认
  snapshotSection.style.display = 'block';
}
function hideSnapshot() { snapshotSection.style.display = 'none'; snapshotView.textContent = ''; }

function showFields() { setCollapsed(fieldsHeader, fieldsBody, false); fieldsSection.style.display = 'block'; }
function hideFields() { fieldsSection.style.display = 'none'; }
function showActions(json: string) {
  actionsJsonEl.value = prettyActions(json);
  actionsSection.style.display = 'block';
  // 默认折叠
  actionsBody.classList.add('collapsed');
  actionsToggle.classList.remove('open');
  actionsCaret.textContent = '▸';
}
/** 由动作 JSON 自动生成并展示代码（去掉了手动“确认生成代码”按钮） */
function regenCodeFromActions() {
  try {
    const actions = parseActionsJson(actionsJsonEl.value);
    lastActionsJson = JSON.stringify({ actions });
    showCode(actionsToCode(actions));
  } catch { /* JSON 不完整时不生成 */ }
}
function hideActions() { actionsSection.style.display = 'none'; }
// ── 代码语法高亮（透明 textarea + 背后高亮层）────────────────────────────────
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function highlight(code: string): string {
  const re = /(\/\/[^\n]*)|(`(?:\\[\s\S]|[^`\\])*`)|('(?:\\.|[^'\\\n])*')|("(?:\\.|[^"\\\n])*")|\b(await|page|true|false|null|undefined)\b|\.([a-zA-Z_$][\w$]*)(?=\s*\()|(\b\d+(?:\.\d+)?\b)/g;
  let out = '', last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    out += escapeHtml(code.slice(last, m.index));
    if (m[1]) out += `<span class="c">${escapeHtml(m[1])}</span>`;
    else if (m[2] || m[3] || m[4]) out += `<span class="s">${escapeHtml(m[0])}</span>`;
    else if (m[5]) out += `<span class="k">${escapeHtml(m[5])}</span>`;
    else if (m[6] !== undefined) out += `.<span class="m">${escapeHtml(m[6])}</span>`;
    else if (m[7]) out += `<span class="n">${escapeHtml(m[7])}</span>`;
    last = re.lastIndex;
  }
  out += escapeHtml(code.slice(last));
  return out + '\n'; // 末行占位，保证滚动对齐
}
function renderHighlight() { codeHl.innerHTML = highlight(codeTextEl.value); }
/** 设置代码内容并刷新高亮（统一入口） */
function setCode(code: string) { codeTextEl.value = code; renderHighlight(); }

function showCode(code: string) { setCode(code); codeSection.style.display = 'block'; }
function hideCode() { codeSection.style.display = 'none'; }

// ── 定位校验报告 + 点选修复 ──────────────────────────────────────────────────

function hideIssues() {
  lastIssues = [];
  issuesRows.innerHTML = '';
  issuesList.classList.remove('show');
  cancelPicking(false);
}

/** 渲染校验报告；未修复的项提供「🎯 Pick element」按钮，点击后到页面上点选目标 */
function renderIssues() {
  issuesRows.innerHTML = '';
  if (!lastIssues.length) { issuesList.classList.remove('show'); return; }
  for (const issue of lastIssues) {
    const row = document.createElement('div');
    row.className = 'issue-row ' + (issue.fixed ? 'fixed' : issue.severity);
    const icon = issue.fixed ? '✓' : issue.severity === 'error' ? '✕' : '⚠';
    row.innerHTML = '<span class="issue-icon"></span><span class="issue-text"></span>';
    row.querySelector('.issue-icon')!.textContent = icon;
    const textEl = row.querySelector('.issue-text')!;
    const code = document.createElement('code');
    code.textContent = issue.locator;
    textEl.append(`#${issue.index + 1} ${issue.label} — ${issue.message} `, document.createElement('br'), code);
    if (!issue.fixed) {
      const btn = document.createElement('button');
      const isPicking = pickingIndex === issue.index;
      btn.className = 'issue-fix-btn' + (isPicking ? ' picking' : '');
      btn.textContent = isPicking ? '◉ Click on page…' : '🎯 Pick element';
      btn.title = 'Click the real target element on the page to fix this locator';
      btn.addEventListener('click', () => onPickFix(issue.index));
      row.appendChild(btn);
    }
    issuesRows.appendChild(row);
  }
  issuesList.classList.add('show');
}

function onPickFix(index: number) {
  if (pickingIndex === index) { cancelPicking(true); return; }
  if (!activeTabId) return;
  cancelPicking(false);
  pickingIndex = index;
  renderIssues();
  showStatus('info', '🎯 Click the target element on the page (ESC to cancel)');
  chrome.tabs.sendMessage(activeTabId, { type: 'startPickTarget' }).catch(() => {
    pickingIndex = null;
    renderIssues();
    showStatus('error', 'Cannot start picking on this page (content script not available).');
  });
}

function cancelPicking(notifyContent: boolean) {
  if (pickingIndex == null) return;
  pickingIndex = null;
  if (notifyContent && activeTabId) {
    chrome.tabs.sendMessage(activeTabId, { type: 'stopPickTarget' }).catch(() => {});
  }
}

/** 用户在页面点选了元素：优先写回 playwright 语义定位（raw），CSS 兜底写入 target，并同步代码 */
function applyPickedSelector(selector: string, locator?: string) {
  const index = pickingIndex;
  pickingIndex = null;
  if (index == null) return;
  try {
    const actions = parseActionsJson(actionsJsonEl.value || lastActionsJson);
    if (!actions[index]) throw new Error('action index out of range');
    const loc = (locator ?? '').trim();
    if (loc) {
      // generateSelector 产出的语义定位链（getByRole 等），执行时优先于 target
      actions[index].raw = loc;
      actions[index].target = { by: 'css', value: selector }; // 留 CSS 兜底，便于手动降级
    } else {
      actions[index].target = { by: 'css', value: selector };
      delete actions[index].raw;
    }
    delete (actions[index] as any).ref;
    lastActionsJson = JSON.stringify({ actions });
    actionsJsonEl.value = JSON.stringify({ actions }, null, 2);
    const code = actionsToCode(actions);
    setCode(code);
    lastCode = code;
    const issue = lastIssues.find(i => i.index === index);
    if (issue) {
      issue.fixed = true;
      issue.fixedBy = 'pick';
      issue.locator = loc || selector;
      issue.message = '已用页面点选的元素修复';
    }
    renderIssues();
    showStatus('success', `✓ Locator #${index + 1} fixed: ${loc || selector}`);
  } catch (e: any) {
    renderIssues();
    showStatus('error', `Failed to apply picked selector: ${e?.message ?? e}`);
  }
}

function resetDownstream() {
  hideActions(); hideCode(); hideIssues(); lastActionsJson = ''; lastCode = '';
}

// ── 录制：代码区悬浮插入把手（hover 显示虚线 + ⏺，参考 playwright-crx 交互）────

// 录制时需要禁用、且不由 setState 管理的控件
const NON_STATE_CONTROLS: HTMLElement[] = [btnSelect, btnClear, btnAddField, btnFillLocal, profileSelect];

function setRecordingUI(on: boolean) {
  NON_STATE_CONTROLS.forEach(el => { (el as any).disabled = on; });
  if (on) {
    btnFill.disabled = true; btnConfirmFields.disabled = true; btnRegen.disabled = true; btnExecute.disabled = true;
    btnValidate.disabled = true;
    codeTextEl.readOnly = true; actionsJsonEl.readOnly = true;
  } else {
    setState(state); // 恢复 setState 管理的按钮与只读态
  }
}

let hoverBoundary = 0; // 鼠标当前指向的行边界（0..总行数）

function editorLineHeight(): number {
  const lh = parseFloat(getComputedStyle(codeTextEl).lineHeight);
  return Number.isFinite(lh) && lh > 0 ? lh : 16.5;
}
function editorPadTop(): number {
  const pt = parseFloat(getComputedStyle(codeTextEl).paddingTop);
  return Number.isFinite(pt) ? pt : 8;
}
function codeLineCount(): number { return codeTextEl.value.split('\n').length; }

/** 把行边界映射为编辑器内 Y 坐标（随滚动变化） */
function boundaryY(boundary: number): number {
  return editorPadTop() + boundary * editorLineHeight() - codeTextEl.scrollTop;
}

/** 在指定行边界显示把手；录制中越界时夹紧到可视区，保证 ■ 始终可点 */
function showRecHandleAt(boundary: number) {
  let y = boundaryY(boundary);
  const h = codeEditor.clientHeight;
  if (recording) {
    y = Math.max(12, Math.min(h - 12, y));
  } else if (y < 2 || y > h - 2) {
    hideRecHandle();
    return;
  }
  recLine.style.top = `${y}px`;
  recFab.style.top = `${y}px`;
  recOverlay.classList.toggle('recording', recording);
  recOverlay.classList.add('show');
}
function hideRecHandle() { recOverlay.classList.remove('show'); }

function updateRecFab() {
  recFab.classList.toggle('recording', recording);
  recFab.textContent = recording ? `■ ${recordedBuffer.length}` : '⏺';
  recFab.title = recording
    ? 'Stop recording and insert (ESC)'
    : 'Record page actions and insert at this line';
}

// hover 跟随鼠标定位插入行；正在编辑（textarea 聚焦）或执行中不显示
codeEditor.addEventListener('mousemove', (e: MouseEvent) => {
  if (recording) { showRecHandleAt(recordIndex); return; }
  if (document.activeElement === codeTextEl || state === 'filling') { hideRecHandle(); return; }
  const rect = codeEditor.getBoundingClientRect();
  const raw = (e.clientY - rect.top - editorPadTop() + codeTextEl.scrollTop) / editorLineHeight();
  hoverBoundary = Math.max(0, Math.min(codeLineCount(), Math.round(raw)));
  showRecHandleAt(hoverBoundary);
});
codeEditor.addEventListener('mouseleave', () => { if (!recording) hideRecHandle(); });
codeTextEl.addEventListener('focus', () => { if (!recording) hideRecHandle(); });

recFab.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (recording) stopRecording(true);
  else startRecording(hoverBoundary);
});

async function startRecording(index: number) {
  if (recording || !activeTabId) return;
  recording = true; recordIndex = index; recordedBuffer = [];
  setRecordingUI(true);
  updateRecFab();
  showRecHandleAt(recordIndex);
  showStatus('info', '● Recording… operate the page; press ESC or click ■ to finish');
  try { await chrome.tabs.sendMessage(activeTabId, { type: 'startRecording' }); }
  catch {
    showStatus('error', 'Cannot start recording on this page (content script not available).');
    recording = false; setRecordingUI(false); updateRecFab(); hideRecHandle();
  }
}

async function stopRecording(insert: boolean) {
  if (!recording) return;
  recording = false;
  if (activeTabId) chrome.tabs.sendMessage(activeTabId, { type: 'stopRecording' }).catch(() => {});
  if (insert && recordedBuffer.length) {
    // 按原始行边界插入，保留既有空行/注释
    const lines = codeTextEl.value.split('\n');
    const newLines = recordedBuffer.map(a => actionLine(a));
    if (lines.length === 1 && lines[0].trim() === '') {
      lines.splice(0, 1, ...newLines); // 空编辑器：直接替换占位空行
    } else {
      lines.splice(Math.max(0, Math.min(lines.length, recordIndex)), 0, ...newLines);
    }
    const code = lines.join('\n');
    setCode(code);
    lastCode = code;
    try {
      const actions = codeToActions(code);
      lastActionsJson = JSON.stringify({ actions });
      actionsJsonEl.value = JSON.stringify({ actions }, null, 2);
    } catch { /* 解析失败不阻断 */ }
    showStatus('success', `✓ Inserted ${newLines.length} recorded statement(s)`);
  } else {
    hideStatus();
  }
  recordedBuffer = [];
  setRecordingUI(false);
  updateRecFab();
  hideRecHandle();
}

// ── Detected fields editor ──────────────────────────────────────────────────

function renderFields(fields: DetectedField[]) {
  fieldsList.innerHTML = '';
  for (const f of fields) addFieldRow(f.label, f.type);
}
function addFieldRow(label = '', type = 'text') {
  const row = document.createElement('div');
  row.className = 'field-row';
  row.innerHTML =
    '<input class="field-label" placeholder="Field label" />' +
    '<input class="field-type" placeholder="Type" />' +
    '<button class="field-del" title="Delete">✕</button>';
  (row.querySelector('.field-label') as HTMLInputElement).value = label;
  (row.querySelector('.field-type') as HTMLInputElement).value = type || 'text';
  row.querySelector('.field-del')!.addEventListener('click', () => row.remove());
  fieldsList.appendChild(row);
}
function collectFields(): DetectedField[] {
  const out: DetectedField[] = [];
  fieldsList.querySelectorAll('.field-row').forEach(row => {
    const label = (row.querySelector('.field-label') as HTMLInputElement).value.trim();
    const type = (row.querySelector('.field-type') as HTMLInputElement).value.trim() || 'text';
    if (label) out.push({ label, type });
  });
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function uuid(): string {
  return (crypto as any).randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2);
}

// ── Init ──────────────────────────────────────────────────────────────────

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    activeTabId = tab.id;
    currentUrl = tab.url ?? '';
    urlBar.textContent = currentUrl || '—';
    urlBar.title = currentUrl;
  }
  const cfg = await chrome.storage.local.get(['aiConfig']);
  if (!(cfg.aiConfig as any)?.apiKey) noConfigBanner.classList.add('show');
  await loadProfiles();
  await loadPendingContextSelection(); // 若由右键 Pick DOM 打开，载入暂存的所选区域
  await loadPendingDebug();            // 若由右键 调试 打开，强制载入该缓存项
}
async function loadProfiles() {
  const res = await chrome.storage.local.get('profiles');
  const profiles = (res.profiles ?? []) as Array<{ id: string; name: string }>;
  while (profileSelect.options.length > 1) profileSelect.remove(1);
  for (const p of profiles) {
    const opt = document.createElement('option');
    opt.value = p.id; opt.textContent = p.name;
    profileSelect.appendChild(opt);
  }
}

// ── Event handlers ──────────────────────────────────────────────────────────

btnOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());
linkOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());
btnCache.addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('cache.html') }));

btnSelect.addEventListener('click', async () => {
  if (!activeTabId) return;
  if (state === 'selecting') {
    await chrome.tabs.sendMessage(activeTabId, { type: 'stopSelection' });
    setState('idle');
    return;
  }
  oneClickLocal = false;
  setState('selecting');
  hideSnapshot(); hideFields(); resetDownstream(); hideStatus(); resetSteps();
  await chrome.runtime.sendMessage({ type: 'startSelection', tabId: activeTabId });
});

// 一键本地填充：开始选元素（带 oneClickLocal 标记），选完自动跑本地流程直至生成代码
btnOneClickLocal.addEventListener('click', async () => {
  if (!activeTabId) return;
  if (state === 'selecting') {
    await chrome.tabs.sendMessage(activeTabId, { type: 'stopSelection' });
    oneClickLocal = false;
    setState('idle');
    return;
  }
  oneClickLocal = true;
  setState('selecting');
  hideSnapshot(); hideFields(); resetDownstream(); hideStatus(); resetSteps();
  showStatus('info', '⚡ One-click local: pick the form container on the page…');
  await chrome.runtime.sendMessage({ type: 'startSelection', tabId: activeTabId });
});

// 把侧边栏重置为初始态（清空所选/快照/字段/动作/代码与状态区）
function resetPanel() {
  selectedSelector = ''; detectedSnapshot = ''; detectedDomHash = '';
  currentEntryId = null; cacheHit = false; oneClickLocal = false;
  lastActionsJson = ''; lastCode = '';
  setState('idle');
  hideSnapshot(); hideFields(); resetDownstream(); hideStatus(); resetSteps();
  hideStream();
}

btnClear.addEventListener('click', resetPanel);

// 页面 URL 改变 / 切换标签：把侧边栏刷新成初始态，并对准新的活动标签
function applyActiveTab(tabId: number, url: string) {
  activeTabId = tabId;
  currentUrl = url || '';
  urlBar.textContent = currentUrl || '—';
  urlBar.title = currentUrl;
}
async function refreshForActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id != null) applyActiveTab(tab.id, tab.url ?? '');
  } catch { /* ignore */ }
  resetPanel();
}
// 同一标签内 URL 变化（含 SPA 的 history 更新会触发 onUpdated 的 url 字段）
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId !== activeTabId) return;
  // 录制中：URL 变化（SPA 跳步/导航）不重置面板，已录动作与计数保留；
  // 整页加载完成后向新文档的 content script 重新拉起录制（跨页续录）
  if (recording) {
    if (changeInfo.url) applyActiveTab(tabId, changeInfo.url);
    if (changeInfo.status === 'complete') {
      chrome.tabs.sendMessage(tabId, { type: 'startRecording' }).catch(() => {});
    }
    return;
  }
  if (changeInfo.url && changeInfo.url !== currentUrl) {
    applyActiveTab(tabId, changeInfo.url);
    resetPanel();
  }
});
// 切换活动标签：对准新标签并重置
chrome.tabs.onActivated.addListener(() => { refreshForActiveTab(); });

// ESC：当焦点在侧边栏时也能退出选择模式（content.js 处理焦点在页面的情况）
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && recording) { stopRecording(true); return; }
  if (e.key === 'Escape' && pickingIndex != null) { cancelPicking(true); renderIssues(); hideStatus(); return; }
  if (e.key === 'Escape' && state === 'selecting' && activeTabId) {
    chrome.tabs.sendMessage(activeTabId, { type: 'stopSelection' }).catch(() => {});
    oneClickLocal = false;
    setState('idle');
    hideStatus();
  }
});

// ① 分析字段
btnFill.addEventListener('click', async () => {
  if (state !== 'selected' || !detectedSnapshot) return;
  setState('analyzing');
  resetSteps();
  hideStream();
  showStatus('info', 'Analyzing form fields (streaming)...');
  await chrome.runtime.sendMessage({ type: 'analyzeForm', snapshot: detectedSnapshot, mode: detectedMode });
});

// ①' 本地分析字段（不调用 AI，纯浏览器内解析所选区域的 DOM）
btnFillLocal.addEventListener('click', async () => {
  if (state !== 'selected' || !selectedSelector || !activeTabId) return;
  setState('analyzing');
  resetSteps();
  hideStream();
  showStatus('info', 'Analyzing form fields locally (no AI)...');
  await chrome.runtime.sendMessage({ type: 'localAnalyzeForm', tabId: activeTabId, selector: selectedSelector });
});

btnAddField.addEventListener('click', () => addFieldRow());

function updateRegenLabel() {
  btnRegen.textContent = actionsJsonEl.value.trim() ? '🤖 AI regenerate' : '🤖 AI generate fill code';
}

// ② 确认并保存字段（含唯一性校验）—— 与动作生成解耦：保存后即可命中缓存
btnConfirmFields.addEventListener('click', async () => {
  const fields = collectFields();
  if (fields.length === 0) { showStatus('error', 'Keep at least one field'); return; }

  const formName = formNameInput.value.trim();
  const urlPattern = urlPatternInput.value.trim();
  if (!formName) { showStatus('error', 'Please enter a form name — a name is required to save'); return; }
  if (!urlPattern) { showStatus('error', 'Please enter a match URL'); return; }
  try { new RegExp(urlPattern); } catch { showStatus('error', 'Invalid URL regular expression'); return; }

  // 表单名必须唯一（全局，忽略大小写/首尾空白；排除当前正在编辑的条目）
  const existing = await loadCache();
  const dupe = existing.find(e => e.id !== currentEntryId && e.formName.trim().toLowerCase() === formName.toLowerCase());
  if (dupe) {
    showStatus('error', `表单名“${formName}”已存在，请改用唯一名称后再保存`);
    formNameInput.focus();
    return;
  }

  const now = Date.now();
  const entry: FormCacheEntry = {
    id: currentEntryId ?? uuid(),
    urlPattern, formName, domHash: detectedDomHash, selector: selectedSelector,
    fields,
    // 保留已有动作/代码（缓存命中或本次已生成），否则先存空——下次仍可命中缓存
    actions: lastActionsJson || '',
    code: lastCode || '',
    createdAt: now, updatedAt: now,
  };
  const res = await upsertCache(entry);   // 按 (URL+表单名) upsert：已存在则修改，不再报重复
  currentEntryId = res.id;
  cacheHit = true; // 已存在于缓存

  // 揭示动作区（折叠）；有代码用代码，否则由动作 JSON 自动生成代码
  showActions(lastActionsJson || '');
  if (lastCode) showCode(lastCode);
  else if (lastActionsJson) regenCodeFromActions();
  else hideCode();
  updateRegenLabel();
  setCollapsed(fieldsHeader, fieldsBody, true); // 保存字段后折叠字段区，节省空间
  showStatus('success', (lastCode || lastActionsJson)
    ? '✓ Fields saved. Actions and code loaded — run or edit directly'
    : '✓ Fields saved (will auto-hit the cache next time). Click “Generate fill code” to continue');
});

// 生成 / 重新生成动作（与保存解耦，由用户显式触发）
btnRegen.addEventListener('click', async () => {
  if (state === 'generating' || state === 'filling') return;
  if (!detectedSnapshot) { showStatus('error', 'Analyze and confirm fields first'); return; }
  const fields = collectFields();
  setState('generating');
  resetSteps();
  hideStream();
  hideIssues();
  showStatus('info', 'Generating action JSON (streaming)...');
  await chrome.runtime.sendMessage({
    type: 'generateFill',
    instruction: '',
    profileId: profileSelect.value || undefined,
    fields,
    snapshot: detectedSnapshot,
    mode: detectedMode,
    tabId: activeTabId,
    scopeSelector: selectedSelector,
  });
});

// 本地生成填充代码（不调用 AI）：用所选区域 DOM 为已确认字段生成唯一定位 + 默认值
btnRegenLocal.addEventListener('click', async () => {
  if (state === 'generating' || state === 'filling') return;
  if (!activeTabId || !selectedSelector) { showStatus('error', 'Pick a form container first'); return; }
  const fields = collectFields();
  if (!fields.length) { showStatus('error', 'Analyze and confirm fields first'); return; }
  setState('generating');
  resetSteps();
  hideStream();
  hideIssues();
  showStatus('info', 'Generating fill code locally (no AI)...');
  await chrome.runtime.sendMessage({
    type: 'localGenerateFill',
    fields,
    tabId: activeTabId,
    scopeSelector: selectedSelector,
  });
});

// 手动校验定位：count 检查 + ref 固化（不调 AI），结果渲染为报告
btnValidate.addEventListener('click', async () => {
  if (!activeTabId || state === 'filling' || state === 'generating') return;
  // 以代码区为准同步出动作 JSON
  const acts = codeToActions(codeTextEl.value);
  const actionsJson = acts.length ? JSON.stringify({ actions: acts }) : (actionsJsonEl.value || lastActionsJson);
  if (!actionsJson.trim()) { showStatus('error', 'Nothing to validate — generate code first'); return; }
  hideIssues();
  showStatus('info', 'Validating locators on the page...');
  await chrome.runtime.sendMessage({
    type: 'validateActions',
    tabId: activeTabId,
    actionsJson,
    scopeSelector: selectedSelector,
  });
});

// ④ 动作 JSON 区折叠/展开（默认折叠）
actionsToggle.addEventListener('click', () => {
  const collapsed = actionsBody.classList.toggle('collapsed');
  actionsToggle.classList.toggle('open', !collapsed);
  actionsCaret.textContent = collapsed ? '▸' : '▾';
});

// 快照区 / 字段区：点击标题折叠/展开
snapshotHeader.addEventListener('click', () =>
  setCollapsed(snapshotHeader, snapshotBody, !snapshotBody.classList.contains('collapsed')));
fieldsHeader.addEventListener('click', () =>
  setCollapsed(fieldsHeader, fieldsBody, !fieldsBody.classList.contains('collapsed')));

// 防抖工具
function debounce<T extends (...a: any[]) => void>(fn: T, ms: number): T {
  let t: any;
  return ((...a: any[]) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }) as T;
}

// 标记当前正由代码同步触发，避免两个 input 监听互相循环
let syncing = false;

// JSON 编辑 → 实时同步代码（防抖）
const syncFromJson = debounce(() => {
  if (syncing) return;
  if (codeSection.style.display === 'none') return; // 代码区未展开则不联动
  try {
    const actions = parseActionsJson(actionsJsonEl.value);
    lastActionsJson = JSON.stringify({ actions });
    syncing = true;
    setCode(actionsToCode(actions));
    syncing = false;
  } catch { /* 编辑中途的非法 JSON 静默忽略，不打断输入 */ }
}, 300);
actionsJsonEl.addEventListener('input', syncFromJson);

// 代码编辑 → 实时同步动作 JSON（防抖）
const syncFromCode = debounce(() => {
  if (syncing) return;
  try {
    const actions = codeToActions(codeTextEl.value);
    lastActionsJson = JSON.stringify({ actions });
    syncing = true;
    actionsJsonEl.value = JSON.stringify({ actions }, null, 2);
    syncing = false;
  } catch { /* 编辑中途的非法代码静默忽略 */ }
}, 300);
codeTextEl.addEventListener('input', () => { renderHighlight(); syncFromCode(); });
// 高亮层与输入框滚动同步；录制把手随滚动重定位
codeTextEl.addEventListener('scroll', () => {
  codeHl.scrollTop = codeTextEl.scrollTop;
  codeHl.scrollLeft = codeTextEl.scrollLeft;
  if (recOverlay.classList.contains('show')) showRecHandleAt(recording ? recordIndex : hoverBoundary);
});

// ⑤ 执行 —— 始终以代码区内容为准，由后台的通用解释器执行
btnExecute.addEventListener('click', async () => {
  if (!activeTabId || state === 'filling') return;

  const code = codeTextEl.value.trim();
  if (!code) { showStatus('error', 'Code is empty — generate or write it first'); return; }
  lastCode = code;

  // 尽力把代码同步进动作 JSON 显示（不影响执行）
  const acts = codeToActions(code);
  if (acts.length) {
    lastActionsJson = JSON.stringify({ actions: acts });
    actionsJsonEl.value = JSON.stringify({ actions: acts }, null, 2);
  }

  // 执行前让用户点一下页面，使页面获得真实焦点
  // （sidepanel 是独立 web contents，window.focus() 无法跨文档抢焦点）
  btnExecute.disabled = true;
  showStatus('info', 'Click anywhere on the page to start filling...');
  try {
    const gate = await chrome.tabs.sendMessage(activeTabId, { type: 'armFillGate' });
    if (!gate?.ok) {
      showStatus('error', 'Timed out waiting for page click — try again');
      return;
    }
  } catch (e) {
    showStatus('error', 'Cannot reach the page — refresh it and try again');
    return;
  } finally {
    btnExecute.disabled = false;
  }

  setState('filling');
  resetSteps();
  showStatus('info', 'Executing...');
  await chrome.runtime.sendMessage({
    type: 'executeFill',
    tabId: activeTabId,
    code,
    scopeSelector: selectedSelector, // 定位链 rebase 到所选容器内，避免容器外同名元素干扰
  });
});

// ── Background messages ───────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg: any) => {
  switch (msg.type) {
    case 'fillProgress':
      showStatus('info', msg.status);
      if (msg.step && msg.total) addStep(msg.status, msg.step, msg.total);
      break;

    case 'aiStream':
      // AI 实时输出（识别 / 生成阶段）
      showStream(msg.text);
      break;

    case 'snapshotReady':
      detectedSnapshot = msg.snapshot;
      detectedDomHash = msg.domHash;
      detectedMode = msg.mode ?? captureMode;
      onSnapshotReady();
      break;

    case 'formAnalyzed':
      hideStream();
      renderFields(msg.fields);
      formNameInput.value = msg.formName || 'Untitled form';
      if (!currentEntryId) urlPatternInput.value = escapeRegExp(currentUrl);
      domHashView.value = detectedDomHash;
      cacheHit = false;
      cacheHitHint.classList.remove('show');
      showFields(); resetDownstream();
      setCollapsed(snapshotHeader, snapshotBody, true); // 分析完成后折叠快照区，节省空间
      if (oneClickLocal) {
        // 一键本地：识别完成 → 自动本地生成代码（fields JSON 已展开；action JSON 保持默认折叠）
        finishSteps(true);
        setState('generating');
        showStatus('info', '⚡ One-click local: generating fill code locally…');
        chrome.runtime.sendMessage({
          type: 'localGenerateFill',
          fields: collectFields(),
          tabId: activeTabId,
          scopeSelector: selectedSelector,
        });
      } else {
        setState('selected'); finishSteps(true);
        showStatus('success', `✓ Detected ${msg.fields.length} field(s) — confirm and save`);
      }
      break;

    case 'fillGenerated': {
      hideStream();
      lastActionsJson = msg.script;
      showActions(msg.script);    // 折叠展示动作 JSON
      regenCodeFromActions();     // 自动生成并展示代码（无需手动确认）
      updateRegenLabel();
      setState('selected'); finishSteps(true);
      lastIssues = (msg.issues ?? []) as ValidationIssue[];
      renderIssues();
      const wasOneClick = oneClickLocal;
      oneClickLocal = false;
      const unfixed = lastIssues.filter(i => !i.fixed);
      const errors = unfixed.filter(i => i.severity === 'error').length;
      if (wasOneClick && !errors) showStatus('success', `⚡ One-click local: code generated${unfixed.length ? ` (${unfixed.length} locator(s) need a look)` : ' and validated'} — review or run`);
      else if (errors) showStatus('error', `Generated, but ${errors} locator(s) still match multiple/none — fix below (🎯) or edit code`);
      else if (unfixed.length) showStatus('success', `✓ Generated. ${unfixed.length} locator(s) matched nothing (may be dynamic) — see report below`);
      else if (lastIssues.length) showStatus('success', `✓ Generated; ${lastIssues.length} locator issue(s) auto-fixed (validated on page)`);
      else showStatus('success', '✓ Actions and code generated — locators validated on the page');
      break;
    }

    case 'validationResult': {
      lastActionsJson = msg.script;
      actionsJsonEl.value = prettyActions(msg.script);
      try { // ref 固化可能改写了 target → 同步代码
        const acts = parseActionsJson(msg.script);
        const code = actionsToCode(acts);
        setCode(code);
        lastCode = code;
      } catch { /* ignore */ }
      setState('selected'); finishSteps(true);
      lastIssues = (msg.issues ?? []) as ValidationIssue[];
      renderIssues();
      const bad = lastIssues.filter(i => !i.fixed);
      if (!lastIssues.length) showStatus('success', '✓ All locators resolve to exactly one element');
      else if (!bad.length) showStatus('success', `✓ ${lastIssues.length} issue(s) found and auto-fixed`);
      else showStatus('error', `${bad.length} locator issue(s) need attention — fix below (🎯) or edit code`);
      break;
    }

    case 'targetPicked':
      if (pickingIndex != null) applyPickedSelector(msg.selector, msg.locator);
      break;

    case 'pickCancelled':
      if (pickingIndex != null) {
        pickingIndex = null;
        renderIssues();
        hideStatus();
      }
      break;

    case 'fillComplete':
      if (msg.success) {
        finishSteps(true);
        showStatus('success', '✓ Filled successfully and cached (with executable code)');
        // 缓存动作 JSON 与可执行代码（代码为权威可复用内容）
        if (currentEntryId) updateCacheActions(currentEntryId, lastActionsJson, lastCode);
        setState('selected');
        // 成功后清空状态区
        setTimeout(() => { hideStatus(); resetSteps(); }, 1500);
      }
      break;

    case 'opError':
      hideStream();
      finishSteps(false);
      oneClickLocal = false; // 一键流程中断
      showStatus('error', `❌ ${msg.error ?? 'Operation failed'}`);
      // 恢复可编辑 / 可重试
      setState('selected');
      break;

    case 'elementSelected':
      selectedSelector = msg.selector;
      selectedSelectorEl.textContent = msg.selector;
      selectedSelectorEl.title = msg.selector;
      currentEntryId = null; cacheHit = false;
      hideSnapshot(); hideFields(); resetDownstream(); resetSteps();
      // 选中后立刻采集快照（用于缓存匹配）
      setState('snapshotting');
      showStatus('info', 'Reading the selected region...');
      if (activeTabId) {
        chrome.runtime.sendMessage({ type: 'snapshotForm', tabId: activeTabId, selector: selectedSelector, mode: captureMode });
      }
      break;

    case 'selectionCancelled':
      oneClickLocal = false;
      if (state === 'selecting') setState('idle');
      break;

    case 'contextSelected':
      // 右键 Pick DOM 未命中：读取暂存的所选区域并进入分析流程
      loadPendingContextSelection();
      break;

    case 'debugLoadEntry':
      // 右键 调试：把指定缓存项强制载入（侧边栏已打开的场景）
      chrome.storage.local.remove('pendingDebugLoad');
      if (typeof msg.id === 'string') loadDebugEntry(msg.id);
      break;

    case 'recordedAction':
      // 录制中捕获到一个动作：累计并刷新「■ N」计数
      if (recording && msg.action) {
        recordedBuffer.push(msg.action);
        updateRecFab();
        showRecHandleAt(recordIndex);
      }
      break;

    case 'recordingStopped':
      // 页面内按 ESC 结束：插入已录内容
      if (recording) stopRecording(true);
      break;
  }
});

// 读取 background 暂存的右键所选区域（selector + 已采集的快照/domHash），直接进入分析流程
async function loadPendingContextSelection() {
  const r = await chrome.storage.local.get('pendingContextSelection');
  const p = r.pendingContextSelection as
    | { selector: string; snapshot: string; domHash: string; url: string; ts: number }
    | undefined;
  if (!p) return;
  await chrome.storage.local.remove('pendingContextSelection');
  if (Date.now() - (p.ts ?? 0) > 20000) return;            // 过期丢弃
  if (state === 'analyzing' || state === 'generating' || state === 'filling') return; // 繁忙不打断
  selectedSelector = p.selector;
  selectedSelectorEl.textContent = p.selector;
  selectedSelectorEl.title = p.selector;
  currentEntryId = null; cacheHit = false;
  detectedSnapshot = p.snapshot;
  detectedDomHash = p.domHash;
  detectedMode = 'html';            // 右键流程也采集真实 DOM HTML
  setState('selected');
  await onSnapshotReady();           // 命中缓存则载入字段，未命中则提示分析
}

// 读取 background 暂存的"调试加载"请求（右键 → 调试），把指定缓存项强制载入面板
async function loadPendingDebug() {
  const r = await chrome.storage.local.get('pendingDebugLoad');
  const p = r.pendingDebugLoad as { id: string; ts: number } | undefined;
  if (!p) return;
  await chrome.storage.local.remove('pendingDebugLoad');
  if (Date.now() - (p.ts ?? 0) > 20000) return; // 过期丢弃
  await loadDebugEntry(p.id);
}

/**
 * 调试加载：把某缓存项强制载入侧边栏（替换任何进行中/未保存的状态）。
 * 没有新快照，因此 AI 分析按钮不可用；本地分析、校验、执行（基于已存代码）均可用。
 */
async function loadDebugEntry(id: string) {
  const list = await loadCache();
  const e = list.find(x => x.id === id);
  if (!e) { showStatus('error', 'Cached form not found (it may have been deleted).'); return; }

  // 强制中断进行中的录制/点选，替换全部状态
  if (recording) await stopRecording(false);
  cancelPicking(true);

  selectedSelector = e.selector || '';
  selectedSelectorEl.textContent = selectedSelector || '(loaded from cache)';
  selectedSelectorEl.title = selectedSelector;
  currentEntryId = e.id;
  cacheHit = true;
  detectedSnapshot = '';
  detectedDomHash = e.domHash || '';
  detectedMode = 'html';
  lastActionsJson = e.actions || '';
  lastCode = e.code || '';

  hideSnapshot();
  renderFields(e.fields || []);
  formNameInput.value = e.formName || '';
  urlPatternInput.value = e.urlPattern || '';
  domHashView.value = e.domHash || '';
  cacheHitHint.classList.add('show');
  showFields();

  if (e.actions || e.code) {
    showActions(e.actions || '');
    if (e.code) showCode(e.code);
    else regenCodeFromActions();
  } else {
    hideActions(); hideCode();
  }
  hideIssues();
  updateRegenLabel();
  resetSteps();
  setState('selected');
  showStatus('success', `🐞 Debug: loaded “${e.formName}” — edit code, validate, or run directly`);
}

// 快照就绪后：尝试命中缓存
async function onSnapshotReady() {
  // 展示获取到的 aria snapshot 供用户确认
  showSnapshot(detectedSnapshot);
  const list = await loadCache();
  const hit = matchCache(list, currentUrl, detectedDomHash);
  if (hit) {
    currentEntryId = hit.id;
    cacheHit = true;
    lastActionsJson = hit.actions || '';
    lastCode = hit.code || '';
    renderFields(hit.fields);
    formNameInput.value = hit.formName;
    urlPatternInput.value = hit.urlPattern;
    domHashView.value = detectedDomHash;
    cacheHitHint.classList.add('show');
    if (oneClickLocal) {
      // 一键本地：命中缓存 → 直接展示代码识别结果（折叠状态按默认）
      oneClickLocal = false;
      showFields();
      showActions(lastActionsJson || '');
      if (lastCode) showCode(lastCode);
      else if (lastActionsJson) regenCodeFromActions();
      else hideCode();
      updateRegenLabel();
      setState('selected'); finishSteps(true);
      showStatus('success', '⚡ One-click local: cache hit — code loaded, review or run');
    } else {
      showFields(); hideActions(); hideCode(); // 隐藏动作区但保留已载入的 lastActionsJson/lastCode
      setState('selected'); finishSteps(true);
      showStatus('success', hit.code
        ? '⚡ Cache hit: fields and executable code loaded — confirm fields, then run'
        : '⚡ Cache hit: fields loaded — confirm directly');
    }
  } else {
    currentEntryId = null;
    cacheHit = false;
    lastActionsJson = '';
    lastCode = '';
    cacheHitHint.classList.remove('show');
    if (oneClickLocal) {
      // 一键本地：未命中 → 自动本地识别（随后在 formAnalyzed 里继续本地生成）
      setState('analyzing');
      showStatus('info', '⚡ One-click local: analyzing fields locally…');
      if (activeTabId) chrome.runtime.sendMessage({ type: 'localAnalyzeForm', tabId: activeTabId, selector: selectedSelector });
    } else {
      setState('selected');
      showStatus('info', 'No cache match — click “Local analyze” or “AI analyze” to detect fields');
    }
  }
}

init();
