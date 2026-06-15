/**
 * AI Form Filler — Background Service Worker
 *
 * 阶段化流程：
 *   snapshotForm → content(injected) 采集 aria 快照（含 [ref=eN]）+ 计算 domHash
 *   analyzeForm  → AI 识别表单字段 + 表单名
 *   generateFill → AI 生成动作 JSON → 页面上自动校验/固化/AI 修复
 *   executeFill  → 定位链转换为 playwright selector，逐条发给 content 执行
 *
 * 本文件不再依赖 playwright-crx / chrome.debugger：
 * 页面侧能力由 public/injected.js（官方 playwright InjectedScript bundle）提供，
 * 通过 content.js 的消息桥（pwAriaSnapshot / pwCount / pwSolidifyRef / pwExecStep）访问。
 */

import { callAI, detectFields, repairActions } from './utils/ai';
import { getFingerprint, getAIConfig, getProfile } from './utils/storage';
import type {
  AIConfig, CaptureMode, DetectedField, FillAction, FillTarget,
  FormCacheEntry, OuterHtmlResponse, ValidationIssue,
} from './utils/types';

// ── Side panel ────────────────────────────────────────────────────────────

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.windowId) {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  }
});

// ── Message router ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case 'startSelection':
          await handleStartSelection(message.tabId);
          sendResponse({ ok: true });
          break;
        case 'snapshotForm':
          await withLock(() => handleSnapshotForm(message));
          sendResponse({ ok: true });
          break;
        case 'analyzeForm':
          await withLock(() => handleAnalyzeForm(message));
          sendResponse({ ok: true });
          break;
        case 'localAnalyzeForm':
          await withLock(() => handleLocalAnalyzeForm(message));
          sendResponse({ ok: true });
          break;
        case 'generateFill':
          await withLock(() => handleGenerateFill(message));
          sendResponse({ ok: true });
          break;
        case 'localGenerateFill':
          await withLock(() => handleLocalGenerateFill(message));
          sendResponse({ ok: true });
          break;
        case 'executeFill':
          await withLock(() => handleExecuteFill(message));
          sendResponse({ ok: true });
          break;
        case 'validateActions':
          await withLock(() => handleValidateActions(message));
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: false, error: 'Unknown message type' });
      }
    } catch (e: any) {
      // 统一错误：交给侧边栏决定如何恢复可编辑状态
      broadcast({ type: 'opError', error: e?.message ?? String(e) });
      sendResponse({ ok: false, error: e?.message ?? String(e) });
    }
  })();
  return true; // keep message channel open for async
});

// ── Execution lock ─────────────────────────────────────────────────────────

let executionLock = false;

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  if (executionLock) {
    throw new Error('Busy, please wait...');
  }
  executionLock = true;
  return fn().finally(() => { executionLock = false; });
}

// ── Content script 桥 ──────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** 向 tab 的 content script 发消息；不可达时给出可操作的提示 */
async function sendToTab<T = any>(tabId: number, msg: object): Promise<T> {
  try {
    return (await chrome.tabs.sendMessage(tabId, msg)) as T;
  } catch {
    throw new Error('无法连接页面脚本（content script 未注入）。请刷新目标页面后重试；浏览器内置页面（chrome:// 等）不受支持。');
  }
}

/** 采集所选容器的 aria 快照：plain（无 ref，算 domHash）+ ref 版（发给 AI / 固化用） */
async function captureSnapshot(tabId: number, selector: string): Promise<{ plain: string; ref: string }> {
  const res = await sendToTab<{ snapshot?: string; refSnapshot?: string; error?: string }>(
    tabId, { type: 'pwAriaSnapshot', selector });
  if (!res || res.error || !res.snapshot) {
    throw new Error(`页面快照失败：${res?.error ?? '无响应'}（若刚更新扩展，请刷新目标页面）`);
  }
  return { plain: res.snapshot, ref: res.refSnapshot || res.snapshot };
}

/** 统计 playwright selector 在页面/容器内的命中数；通信或解析失败返回 -1 */
async function countSelector(tabId: number, selector: string, scopeSelector?: string): Promise<number> {
  try {
    const res = await sendToTab<{ count?: number; error?: string }>(
      tabId, { type: 'pwCount', selector, scopeSelector: scopeSelector || undefined });
    if (!res || res.error || typeof res.count !== 'number') return -1;
    return res.count;
  } catch { return -1; }
}

// ── Handlers ──────────────────────────────────────────────────────────────

async function handleStartSelection(tabId: number) {
  await chrome.tabs.sendMessage(tabId, { type: 'startSelection' });
}

async function requireAIConfig() {
  const aiConfig = await getAIConfig();
  if (!aiConfig?.apiKey) {
    throw new Error('AI not configured. Please set your API Key in the Settings page first.');
  }
  return aiConfig;
}

// 选中 DOM 后：采集 payload 并计算 domHash（侧边栏据此匹配缓存）
// 说明：domHash 始终基于无 ref 的 aria 快照计算，缓存键与模式无关且稳定；
//      html 模式下 payload = 清洗后的真实 DOM HTML + ref 快照（AI 用 HTML 拿属性、用 ref 标元素）。
async function handleSnapshotForm(message: { tabId: number; selector: string; mode: CaptureMode }) {
  const { tabId, selector, mode } = message;

  progress('Reading the selected region...', 1, 1);
  const { plain, ref } = await captureSnapshot(tabId, selector);
  const domHash = getFingerprint(plain);

  let snapshot = ref;
  if (mode === 'html') {
    const html = await fetchOuterHtml(tabId, selector);
    if (html) {
      snapshot = html + '\n\n===== ARIA SNAPSHOT of the same container (with [ref=eN] markers) =====\n' + ref;
    } else {
      broadcast({ type: 'fillProgress', status: 'Could not read raw HTML; falling back to ARIA snapshot.' });
    }
  }

  broadcast({ type: 'snapshotReady', snapshot, domHash, mode });
}

// 向 content script 请求所选容器清洗后的真实 outerHTML
async function fetchOuterHtml(tabId: number, selector: string): Promise<string> {
  try {
    const res = (await chrome.tabs.sendMessage(tabId, { type: 'getOuterHtml', selector })) as OuterHtmlResponse | undefined;
    if (!res || res.error) return '';
    return res.html || '';
  } catch {
    return '';
  }
}

// 节流的流式回调：把 AI 实时输出转发到侧边栏
function streamTo(phase: 'detect' | 'generate') {
  let last = 0;
  return (text: string) => {
    const now = Date.now();
    if (now - last < 70) return;
    last = now;
    broadcast({ type: 'aiStream', phase, text });
  };
}

// 阶段 1：AI 识别表单字段 + 表单名（复用快照，无需再次连接页面）
async function handleAnalyzeForm(message: { snapshot: string; mode: CaptureMode }) {
  const aiConfig = await requireAIConfig();
  progress('Analyzing form fields (streaming)...', 1, 1);
  const { fields, formName } = await detectFields(aiConfig, message.snapshot, message.mode, streamTo('detect'));
  broadcast({ type: 'formAnalyzed', fields, formName });
}

// 阶段 1（本地版）：在页面内用 content script 解析所选容器的 DOM，识别表单字段——不调用 AI、无需 API Key。
// 适合标准 HTML 控件；自定义/JS 组件可能识别不全，此时用户可改用 AI 分析或手动增删字段。
async function handleLocalAnalyzeForm(message: { tabId: number; selector: string }) {
  progress('Analyzing form fields locally (no AI)...', 1, 1);
  const res = await sendToTab<{ formName?: string; fields?: DetectedField[]; error?: string }>(
    message.tabId, { type: 'localAnalyze', selector: message.selector });
  if (!res || res.error || !Array.isArray(res.fields)) {
    throw new Error(`本地分析失败：${res?.error ?? '无结果'}（若刚更新扩展，请刷新目标页面）`);
  }
  if (!res.fields.length) {
    throw new Error('本地分析未识别到任何表单字段。该表单可能是自定义/JS 组件——可改用“Analyze form fields (AI)”。');
  }
  broadcast({ type: 'formAnalyzed', fields: res.fields, formName: res.formName || '本地识别表单' });
}

// 阶段 2：根据用户确认的字段生成动作 JSON（不执行），随后在页面上自动校验定位：
//   count 检查 → aria-ref 固化（失败定位换成 generateSelector 语义定位）→ 仍失败的交 AI 重写一轮
async function handleGenerateFill(message: {
  instruction: string;
  profileId?: string;
  fields: DetectedField[];
  snapshot: string;
  mode: CaptureMode;
  tabId: number;
  scopeSelector: string;
}) {
  const { instruction, profileId, fields, snapshot, mode, tabId, scopeSelector } = message;
  const aiConfig = await requireAIConfig();

  let profileData: Record<string, string> | undefined;
  if (profileId) {
    const profile = await getProfile(profileId);
    profileData = profile?.fields;
  }

  progress('Generating action JSON (streaming)...', 1, 1);
  // callAI 已校验非空并归一化为 { actions: [...] }，为空/无效会抛错（→ opError）
  const script = await callAI(aiConfig, snapshot, instruction, profileData, fields, mode, streamTo('generate'));

  // 自动校验 + 修复（校验失败不阻断生成——降级为不带 issues 的旧行为）
  let actions = parseActionList(script);
  let issues: ValidationIssue[] = [];
  if (actions && tabId != null) {
    try {
      progress('Validating locators...', 1, 1);
      const r = await validateAndFix(tabId, scopeSelector, actions, { aiConfig, snapshot, mode });
      actions = r.actions;
      issues = r.issues;
    } catch { /* 页面不可达等：跳过校验 */ }
  }

  broadcast({
    type: 'fillGenerated',
    script: actions ? JSON.stringify({ actions }) : script,
    issues,
  });
}

// 阶段 2（本地版）：不调用 AI，在页面内根据已确认字段直接生成动作（唯一 CSS 定位 + 合理默认值）。
// 随后复用同一套页面校验（count 检查；无 AI 修复），把结果与 AI 生成完全一致地交给侧边栏。
async function handleLocalGenerateFill(message: {
  fields: DetectedField[];
  tabId: number;
  scopeSelector: string;
}) {
  const { fields, tabId, scopeSelector } = message;
  progress('Generating fill code locally (no AI)...', 1, 1);
  const res = await sendToTab<{ actions?: FillAction[]; error?: string }>(
    tabId, { type: 'localGenerate', selector: scopeSelector, fields });
  if (!res || res.error || !Array.isArray(res.actions) || !res.actions.length) {
    throw new Error(`本地生成失败：${res?.error ?? '未能为所选区域生成任何动作'}。可改用 AI 生成。`);
  }

  let actions = res.actions;
  let issues: ValidationIssue[] = [];
  try {
    progress('Validating locators...', 1, 1);
    const r = await validateAndFix(tabId, scopeSelector, actions, null); // repairCtx=null → 不调 AI
    actions = r.actions;
    issues = r.issues;
  } catch { /* 页面不可达等：跳过校验 */ }

  broadcast({ type: 'fillGenerated', script: JSON.stringify({ actions }), issues });
}

// 手动校验动作 JSON（count 检查 + ref 固化；不调 AI）
async function handleValidateActions(message: { tabId: number; actionsJson: string; scopeSelector?: string }) {
  const actions = parseActionList(message.actionsJson);
  if (!actions) throw new Error('动作 JSON 无效，无法校验。');
  progress('Validating locators...', 1, 1);
  const { actions: fixed, issues } = await validateAndFix(message.tabId, message.scopeSelector ?? '', actions, null);
  broadcast({ type: 'validationResult', script: JSON.stringify({ actions: fixed }), issues });
}

// 阶段 3：执行 Playwright 代码（以代码区为准；缓存由侧边栏在成功后写入）
async function handleExecuteFill(message: { tabId: number; code: string; scopeSelector?: string }) {
  await runOnTab(message.tabId, message.code, message.scopeSelector);
  broadcast({ type: 'fillComplete', success: true });
}

/** 在指定标签页执行一段 Playwright 代码（content script 内逐条执行） */
async function runOnTab(tabId: number, code: string, scopeSelector?: string): Promise<void> {
  progress('Executing...', 1, 1);
  await runCode(tabId, code, (i, n, label) => progress(`Step ${i}/${n}: ${label}`), scopeSelector);
}

// ── 执行器：定位链 → playwright selector → content 内执行 ────────────────────

/** 单步超时（毫秒） */
const EXEC_TIMEOUT = 5000;

type StepCallback = (index: number, total: number, label: string) => void;

async function runCode(tabId: number, code: string, onStep?: StepCallback, scopeSelector?: string): Promise<void> {
  const stmts = splitStatements(code);
  if (stmts.length === 0) throw new Error('No executable code.');
  for (let i = 0; i < stmts.length; i++) {
    const stmt = stmts[i];
    onStep?.(i + 1, stmts.length, truncate(stmt, 60));
    await execStatementRemote(tabId, stmt, scopeSelector);
  }
}

/** 执行一条语句：解析链 → 转 selector → 发给 content 执行（容器内优先，弹层自动回退页面级） */
async function execStatementRemote(tabId: number, stmt: string, scopeSelector?: string): Promise<void> {
  const segs = parseChain(stmt);
  if (!segs.length) return;

  // page.waitForTimeout(ms)：后台直接 sleep
  if (segs[0].call && segs[0].name === 'waitForTimeout') {
    await sleep(Math.min(Number(segs[0].args[0]) || 0, 30_000));
    return;
  }
  // page.keyboard.press/insertText：作用于页面当前焦点元素
  if (!segs[0].call && segs[0].name === 'keyboard') {
    const act = segs[1];
    if (!act?.call || !['press', 'insertText', 'type'].includes(act.name)) {
      throw new Error('不支持的 keyboard 用法：' + truncate(stmt, 60));
    }
    await execStep(tabId, { selector: '', action: 'keyboard:' + act.name, args: act.args, scopeSelector }, stmt);
    return;
  }
  if (!segs[0].call && segs[0].name === 'mouse') {
    throw new Error('page.mouse 在无 debugger 模式下不支持，请改用元素定位 + click/hover。');
  }

  const ai = firstActionIndex(segs);
  if (ai < 0) throw new Error('语句缺少动作方法（fill/click/check…）：' + truncate(stmt, 60));
  if (ai === 0) throw new Error('动作前缺少定位链：' + truncate(stmt, 60));
  const selector = chainToSelector(segs.slice(0, ai));
  const act = segs[ai];
  await execStep(tabId, { selector, action: act.name, args: act.args, scopeSelector }, stmt);
}

async function execStep(
  tabId: number,
  step: { selector: string; action: string; args: any[]; scopeSelector?: string },
  stmt?: string
): Promise<void> {
  const res = await sendToTab<{ ok?: boolean; error?: string; note?: string }>(tabId, {
    type: 'pwExecStep',
    selector: step.selector,
    action: step.action,
    args: step.args ?? [],
    scopeSelector: step.scopeSelector || undefined,
    timeout: EXEC_TIMEOUT,
  });
  if (res?.ok) {
    if (res.note === 'page-level') {
      progress(`↪ Target is outside the selected container (overlay/portal) — used page-level locator${stmt ? ': ' + truncate(stmt, 60) : ''}`);
    }
    return;
  }
  const msg = String(res?.error ?? '执行无响应');
  // 严格模式：定位器命中多个元素 → 给出可操作的中文消歧提示
  if (/strict mode violation|resolved to \d+ elements/i.test(msg)) {
    throw new Error(
      `定位器命中了多个元素（严格模式），无法确定操作哪一个：\n${truncate(stmt ?? step.selector, 120)}\n` +
      `请把它改写成唯一定位，例如：用唯一 id/name 的 CSS —— page.locator('#某容器 input[type=radio]')；` +
      `或按所在问题文本相对定位 —— page.getByText('问题文本').locator('..').getByRole('radio', { name: 'Yes' })；` +
      `必要时在链尾加 .first()/.nth(n)。\n原始错误：${msg}`
    );
  }
  throw new Error(msg + (stmt ? `\n语句：${truncate(stmt, 100)}` : ''));
}

// ── 定位链 → playwright selector 转换 ────────────────────────────────────────
// playwright 的 locator 链本质是用 " >> " 连接的 selector 字符串：
//   page.getByText('Q').locator('..').getByRole('radio', { name: 'No' }).first()
//   → internal:text="Q"i >> xpath=.. >> internal:role=radio[name="No"i] >> nth=0
// 转义规则与 playwright-core utils/isomorphic/{locatorUtils,stringUtils}.ts 保持一致（vendored）。

function escTextSel(text: any, exact: boolean): string {
  if (typeof text !== 'string') return String(text); // RegExp：原样字符串化（/pat/flags）
  return `${JSON.stringify(text)}${exact ? 's' : 'i'}`;
}
function escAttrSel(value: any, exact: boolean): string {
  if (typeof value !== 'string') return String(value);
  return `"${value.replace(/\\/g, '\\\\').replace(/["]/g, '\\"')}"${exact ? 's' : 'i'}`;
}

function roleSelector(role: string, options: any = {}): string {
  const props: string[] = [];
  for (const key of ['checked', 'disabled', 'selected', 'expanded', 'pressed'] as const) {
    if (options[key] !== undefined) props.push(`[${key}=${String(options[key])}]`);
  }
  if (options.includeHidden !== undefined) props.push(`[include-hidden=${String(options.includeHidden)}]`);
  if (options.level !== undefined) props.push(`[level=${String(options.level)}]`);
  if (options.name !== undefined) props.push(`[name=${escAttrSel(options.name, !!options.exact)}]`);
  return `internal:role=${role}${props.join('')}`;
}
function attrTextSelector(attr: string, text: any, options?: any): string {
  return `internal:attr=[${attr}=${escAttrSel(text, !!options?.exact)}]`;
}

/** 单个链段 → selector 片段（数组：locator(sel,{hasText}) 会产出两段）；不支持的方法抛错 */
function segToSelectorParts(seg: Segment): string[] {
  const a0 = seg.args[0];
  const a1 = seg.args[1];
  switch (seg.name) {
    case 'locator': {
      if (typeof a0 !== 'string') throw new Error('locator() 参数必须是字符串');
      const parts = [safeCssSelector(a0)];
      if (a1 && typeof a1 === 'object') {
        if (a1.hasText !== undefined) parts.push('internal:has-text=' + escTextSel(a1.hasText, false));
        if (a1.hasNotText !== undefined) parts.push('internal:has-not-text=' + escTextSel(a1.hasNotText, false));
        if (a1.has !== undefined || a1.hasNot !== undefined) throw new Error('locator() 的 has/hasNot 选项暂不支持');
      }
      return parts;
    }
    case 'getByRole':      return [roleSelector(String(a0 ?? ''), a1 ?? {})];
    case 'getByText':      return ['internal:text=' + escTextSel(a0, !!a1?.exact)];
    case 'getByLabel':     return ['internal:label=' + escTextSel(a0, !!a1?.exact)];
    case 'getByPlaceholder': return [attrTextSelector('placeholder', a0, a1)];
    case 'getByAltText':   return [attrTextSelector('alt', a0, a1)];
    case 'getByTitle':     return [attrTextSelector('title', a0, a1)];
    case 'getByTestId':    return [`internal:testid=[data-testid=${escAttrSel(a0, true)}]`];
    case 'filter': {
      const parts: string[] = [];
      if (a0 && typeof a0 === 'object') {
        if (a0.hasText !== undefined) parts.push('internal:has-text=' + escTextSel(a0.hasText, false));
        if (a0.hasNotText !== undefined) parts.push('internal:has-not-text=' + escTextSel(a0.hasNotText, false));
      }
      if (!parts.length) throw new Error('filter() 仅支持 hasText/hasNotText');
      return parts;
    }
    case 'first': return ['nth=0'];
    case 'last':  return ['nth=-1'];
    case 'nth':   return [`nth=${Number(a0) || 0}`];
    default:
      throw new Error(`定位链不支持 .${seg.name}()（无 debugger 执行模式）`);
  }
}

/** 定位段序列 → playwright selector 字符串 */
function chainToSelector(segs: Segment[]): string {
  const parts: string[] = [];
  for (const seg of segs) {
    if (!seg.call) throw new Error(`定位链不支持属性访问 .${seg.name}`);
    parts.push(...segToSelectorParts(seg));
  }
  if (!parts.length) throw new Error('空定位链');
  return parts.join(' >> ');
}

/** 结构化 target → playwright selector（与侧边栏 locatorCode 语义一致） */
function targetToSelector(t: FillTarget): string {
  switch (t.by) {
    case 'label':       return 'internal:label=' + escTextSel(t.value, false);
    case 'placeholder': return attrTextSelector('placeholder', t.value);
    case 'role':        return t.value
                          ? roleSelector(t.role || 'textbox', { name: t.value })
                          : roleSelector(t.role || 'textbox') + ' >> nth=0';
    case 'text':        return 'internal:text=' + escTextSel(t.value, false);
    case 'altText':     return attrTextSelector('alt', t.value);
    case 'title':       return attrTextSelector('title', t.value);
    case 'name':        return `[name="${String(t.value).replace(/(["\\])/g, '\\$1')}"]`;
    case 'id':          return `[id="${String(t.value).replace(/(["\\])/g, '\\$1')}"]`;
    case 'css':
    default:            return safeCssSelector(t.value);
  }
}

/** raw 定位链（可含动作段，自动截断）→ playwright selector */
function rawToSelector(raw: string): string {
  const segs = parseChain(raw);
  const ai = firstActionIndex(segs);
  return chainToSelector(ai > 0 ? segs.slice(0, ai) : segs);
}

/** 动作 → 校验/执行用 selector（raw 优先） */
function actionToSelector(a: FillAction): string {
  return (a.raw && a.raw.trim()) ? rawToSelector(a.raw) : targetToSelector(a.target);
}

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/**
 * 把单一 #id 形式且含 CSS 不安全字符（/ : . 空格 等）的选择器改写为 [id="..."]，
 * 防止 playwright 解析 CSS 时报 "Unexpected token"。非 #id 形式（text=/xpath= 等）原样返回。
 */
function safeCssSelector(sel: string): string {
  const s = String(sel ?? '').trim();
  const m = s.match(/^#([^\s>+~,\[\]()]+)$/);
  if (m && /[^A-Za-z0-9_-]/.test(m[1])) {
    return `[id="${m[1].replace(/(["\\])/g, '\\$1')}"]`;
  }
  return s;
}

// ── Playwright 代码解析（语句切分 + 链式解析；执行与校验共用）────────────────

/** 按顶层分号切分（引号 ' " ` 内的分号不切分） */
function splitStatements(code: string): string[] {
  const out: string[] = [];
  let buf = '', quote: string | null = null;
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

interface Segment { name: string; call: boolean; args: any[]; }

/** 解析一条语句为链段序列（base 必须是 page） */
function parseChain(stmt: string): Segment[] {
  let s = stmt.replace(/^await\s+/, '').trim().replace(/;+$/, '').trim();
  if (!/^page\b/.test(s)) throw new Error('Code must start with page. : ' + truncate(stmt, 50));
  let i = 4; // 跳过 'page'
  const segs: Segment[] = [];
  while (i < s.length) {
    if (s[i] !== '.') throw new Error('Syntax error, expected . : ' + truncate(s.slice(i), 30));
    i++;
    const nameMatch = /^[a-zA-Z_$][\w$]*/.exec(s.slice(i));
    if (!nameMatch) throw new Error('Cannot parse method name: ' + truncate(s.slice(i), 30));
    const name = nameMatch[0];
    i += name.length;
    if (s[i] === '(') {
      const { argsStr, end } = readParens(s, i);
      i = end;
      segs.push({ name, call: true, args: parseArgs(argsStr) });
    } else {
      segs.push({ name, call: false, args: [] });
    }
  }
  return segs;
}

/** 从 s[start]==='(' 起读取配平的括号内容（字符串感知） */
function readParens(s: string, start: number): { argsStr: string; end: number } {
  let depth = 0, quote: string | null = null;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return { argsStr: s.slice(start + 1, i), end: i + 1 };
    }
  }
  throw new Error('Unbalanced parentheses: ' + truncate(s.slice(start), 40));
}

/** 解析参数列表（顶层逗号分隔，每个为 JS 字面量） */
function parseArgs(src: string): any[] {
  const args: any[] = [];
  let i = 0;
  i = skipWs(src, i);
  if (i >= src.length) return args;
  for (;;) {
    const r = parseValue(src, i);
    args.push(r.value);
    i = skipWs(src, r.end);
    if (i >= src.length) break;
    if (src[i] === ',') { i = skipWs(src, i + 1); continue; }
    break;
  }
  return args;
}

function skipWs(s: string, i: number): number {
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
}

/** 解析单个 JS 字面量：字符串/数字/布尔/null/对象/数组/正则 */
function parseValue(s: string, i: number): { value: any; end: number } {
  i = skipWs(s, i);
  const c = s[i];
  if (c === '\'' || c === '"' || c === '`') return parseString(s, i);
  if (c === '{') return parseObject(s, i);
  if (c === '[') return parseArray(s, i);
  if (c === '/') return parseRegex(s, i);
  // 标识符字面量
  const idm = /^(true|false|null|undefined)\b/.exec(s.slice(i));
  if (idm) {
    const map: any = { true: true, false: false, null: null, undefined: undefined };
    return { value: map[idm[1]], end: i + idm[1].length };
  }
  // 数字
  const num = /^-?\d+(?:\.\d+)?/.exec(s.slice(i));
  if (num) return { value: Number(num[0]), end: i + num[0].length };
  throw new Error('Cannot parse argument: ' + truncate(s.slice(i), 30));
}

function parseString(s: string, i: number): { value: string; end: number } {
  const q = s[i]; i++;
  let out = '';
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      const n = s[i + 1];
      const map: any = { n: '\n', t: '\t', r: '\r', '\\': '\\', '\'': '\'', '"': '"', '`': '`', '$': '$' };
      out += map[n] ?? n; i += 2; continue;
    }
    if (c === q) return { value: out, end: i + 1 };
    out += c; i++;
  }
  throw new Error('Unterminated string');
}

function parseRegex(s: string, i: number): { value: RegExp; end: number } {
  i++; let pat = ''; let inClass = false;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') { pat += c + (s[i + 1] ?? ''); i += 2; continue; }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) { i++; break; }
    pat += c; i++;
  }
  const fm = /^[a-z]*/.exec(s.slice(i));
  const flags = fm ? fm[0] : '';
  return { value: new RegExp(pat, flags), end: i + flags.length };
}

function parseArray(s: string, i: number): { value: any[]; end: number } {
  i++; const arr: any[] = []; i = skipWs(s, i);
  if (s[i] === ']') return { value: arr, end: i + 1 };
  for (;;) {
    const r = parseValue(s, i); arr.push(r.value); i = skipWs(s, r.end);
    if (s[i] === ',') { i = skipWs(s, i + 1); continue; }
    if (s[i] === ']') return { value: arr, end: i + 1 };
    throw new Error('Array parse error');
  }
}

function parseObject(s: string, i: number): { value: any; end: number } {
  i++; const obj: any = {}; i = skipWs(s, i);
  if (s[i] === '}') return { value: obj, end: i + 1 };
  for (;;) {
    i = skipWs(s, i);
    let key: string;
    if (s[i] === '\'' || s[i] === '"' || s[i] === '`') { const r = parseString(s, i); key = r.value; i = r.end; }
    else { const km = /^[a-zA-Z_$][\w$]*/.exec(s.slice(i)); if (!km) throw new Error('Object key parse error'); key = km[0]; i += key.length; }
    i = skipWs(s, i);
    if (s[i] !== ':') throw new Error('Object missing :');
    const r = parseValue(s, i + 1); obj[key] = r.value; i = skipWs(s, r.end);
    if (s[i] === ',') { i++; continue; }
    if (s[i] === '}') return { value: obj, end: i + 1 };
    throw new Error('Object parse error');
  }
}

/** 动作方法名（链中第一个动作段之前为纯定位链） */
const ACTION_METHOD_NAMES = new Set([
  'fill', 'selectOption', 'check', 'uncheck', 'setChecked', 'click', 'dblclick',
  'press', 'pressSequentially', 'type', 'clear', 'setInputFiles', 'hover',
  'focus', 'blur', 'tap', 'dragTo', 'selectText', 'scrollIntoViewIfNeeded',
  // 调试用低层事件：locator.mousedown()/mouseup()/… 与 Playwright 原生 dispatchEvent()
  'mousedown', 'mouseup', 'mousemove', 'pointerdown', 'pointerup', 'pointermove', 'dispatchEvent',
]);

/** 链中第一个动作方法的下标；无动作段返回 -1 */
function firstActionIndex(segs: Segment[]): number {
  return segs.findIndex(s => s.call && ACTION_METHOD_NAMES.has(s.name));
}

// ── 定位校验 + aria-ref 固化 + AI 自修复 ─────────────────────────────────────

/** 解析 { actions: [...] } / [...]，失败返回 null */
function parseActionList(text: string): FillAction[] | null {
  try {
    const data = JSON.parse(text);
    const list = Array.isArray(data) ? data : data?.actions;
    return Array.isArray(list) && list.length ? (list as FillAction[]) : null;
  } catch { return null; }
}

/** 人类可读的定位描述（用于校验报告） */
function describeLocator(a: FillAction): string {
  if (a.raw && a.raw.trim()) return a.raw.trim();
  const t = a.target ?? ({} as FillTarget);
  if (t.by === 'role') return t.value ? `getByRole('${t.role}', { name: '${t.value}' })` : `getByRole('${t.role}')`;
  return `${t.by}=${t.value}`;
}

/** 动态出现的元素（下拉选项等）跳过预校验——它们要等前序动作执行后才存在 */
function isDynamicAction(a: FillAction): boolean {
  if (a.target?.by === 'role' && (a.target.role || '') === 'option') return true;
  if (a.raw && /getByRole\(\s*['"`]option['"`]/.test(a.raw)) return true;
  return false;
}

/** 对动作列表逐条 count 校验；onlyIndices 提供时只查这些下标 */
async function validateActionList(
  tabId: number, scopeSelector: string, actions: FillAction[], onlyIndices?: number[]
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  for (let i = 0; i < actions.length; i++) {
    if (onlyIndices && !onlyIndices.includes(i)) continue;
    const a = actions[i];
    if (!a || typeof a !== 'object') continue;
    if (isDynamicAction(a)) continue;
    const label = a.label || describeLocator(a);
    let selector: string;
    try {
      selector = actionToSelector(a);
    } catch (e: any) {
      issues.push({
        index: i, label, locator: describeLocator(a), count: -1, severity: 'error',
        message: `定位表达式无法解析：${String(e?.message ?? e).slice(0, 120)}`,
      });
      continue;
    }
    const count = await countSelector(tabId, selector, scopeSelector || undefined);
    if (count === 1) continue;
    if (count < 0) continue; // 通信失败：不产报告（避免误报）
    if (count === 0) {
      // 容器内 0 命中：MUI/AntD 等的下拉/日期弹层挂在 body 下（容器外）。
      // 页面级唯一命中则视为通过——执行器会自动回退到页面级定位。
      if (scopeSelector) {
        const pageCount = await countSelector(tabId, selector);
        if (pageCount === 1) continue;
        if (pageCount > 1) {
          issues.push({
            index: i, label, locator: describeLocator(a), count: pageCount, severity: 'error',
            message: `容器内 0 命中，页面级命中 ${pageCount} 个（弹层元素？需收窄为唯一定位）`,
          });
          continue;
        }
      }
      issues.push({
        index: i, label, locator: describeLocator(a), count, severity: 'warn',
        message: '定位不到元素（可能是动态渲染，也可能定位有误）',
      });
    } else {
      issues.push({
        index: i, label, locator: describeLocator(a), count, severity: 'error',
        message: `命中 ${count} 个元素（严格模式下执行会失败），需收窄为唯一定位`,
      });
    }
  }
  return issues;
}

/** aria-ref → generateSelector 语义定位（content 内完成）；失败返回 null */
async function solidifyRef(
  tabId: number, ref: string
): Promise<{ locator: string; pwSelector: string; css: string } | null> {
  try {
    const res = await sendToTab<{ locator?: string; pwSelector?: string; css?: string; error?: string }>(
      tabId, { type: 'pwSolidifyRef', ref });
    if (!res || res.error || (!res.locator && !res.css)) return null;
    return { locator: res.locator || '', pwSelector: res.pwSelector || '', css: res.css || '' };
  } catch { return null; }
}

interface RepairContext { aiConfig: AIConfig; snapshot: string; mode: CaptureMode; }

/**
 * 校验 + 两级自修复：
 *   ① count 检查 → ② 失败项用 aria-ref 固化（generateSelector 语义定位写回 raw，CSS 兜底进 target）
 *   → ③ 仍为 error 的项交 AI 重写一轮（repairCtx 为 null 时跳过）→ 复检
 */
async function validateAndFix(
  tabId: number, scopeSelector: string, actions: FillAction[], repairCtx: RepairContext | null
): Promise<{ actions: FillAction[]; issues: ValidationIssue[] }> {
  const issues = await validateActionList(tabId, scopeSelector, actions);

  // ② ref 固化（error 与 warn 都尝试——ref 指向 AI 实际想要的那个元素）
  for (const issue of issues) {
    if (issue.fixed) continue;
    const a = actions[issue.index];
    if (!a?.ref) continue;
    const r = await solidifyRef(tabId, a.ref);
    if (!r) continue;
    // 复核唯一性：容器内 1 个，或容器内 0 个但页面级 1 个（弹层元素，执行时自动回退）
    const sel = r.pwSelector || r.css;
    const inScope = await countSelector(tabId, sel, scopeSelector || undefined);
    const ok = inScope === 1 || (inScope === 0 && (await countSelector(tabId, sel)) === 1);
    if (!ok) continue;
    if (r.locator) {
      a.raw = r.locator;
      if (r.css) a.target = { by: 'css', value: r.css };
    } else {
      a.target = { by: 'css', value: r.css };
      delete a.raw;
    }
    issue.fixed = true;
    issue.fixedBy = 'ref';
    issue.message += '（已自动固化为语义定位）';
  }

  // ③ AI 修复（仅 error 且未修复；一轮）
  const remaining = issues.filter(i => i.severity === 'error' && !i.fixed);
  if (remaining.length && repairCtx) {
    try {
      progress(`Repairing ${remaining.length} locator(s) with AI...`, 1, 1);
      const repairs = await repairActions(
        repairCtx.aiConfig, repairCtx.snapshot, repairCtx.mode,
        remaining.map(i => ({ index: i.index, action: actions[i.index], problem: i.message })),
        streamTo('generate')
      );
      const repairedIdx: number[] = [];
      for (const r of repairs) {
        if (r.index >= 0 && r.index < actions.length) {
          actions[r.index] = { ...actions[r.index], ...r.action };
          repairedIdx.push(r.index);
        }
      }
      if (repairedIdx.length) {
        const recheck = await validateActionList(tabId, scopeSelector, actions, repairedIdx);
        for (const i of remaining) {
          if (!repairedIdx.includes(i.index)) continue;
          const again = recheck.find(x => x.index === i.index);
          if (!again) {
            i.fixed = true;
            i.fixedBy = 'ai';
            i.message += '（已由 AI 修复并复检通过）';
          } else {
            i.count = again.count;
            i.message = `AI 修复后仍未通过：${again.message}`;
          }
        }
      }
    } catch { /* 修复失败保留原 issues */ }
  }

  return { actions, issues };
}

function progress(status: string, step?: number, total?: number) {
  broadcast({ type: 'fillProgress', status, step, total });
}

function broadcast(msg: object) {
  chrome.runtime.sendMessage(msg).catch(() => {
    // Side panel may not be open; ignore
  });
}

// ── 页面右键菜单（二级）：选取 DOM / 按当前 URL 匹配的缓存表单一键填充 ──────────

let contextSelectMode = false; // 由右键菜单"选取 DOM 模式"触发的选择

async function readFormCache(): Promise<FormCacheEntry[]> {
  const r = await chrome.storage.local.get('formCache');
  return (r.formCache as FormCacheEntry[]) ?? [];
}

function matchesUrl(pattern: string, url: string): boolean {
  try { return !!url && new RegExp(pattern).test(url); } catch { return false; }
}

/**
 * 根据某个 URL 重建右键菜单：
 *   AI Form Filler
 *     ├ 🎯 Pick DOM mode
 *     ├ ──────
 *     └ 📝 <表单名>            （三级子菜单）
 *          ├ ⚡ 填充 Fill
 *          └ 🐞 调试 Debug
 * 说明：含子菜单的「表单名」父项本身在 Chrome 中不可点击，其默认操作由子项「填充」承担。
 */
async function rebuildMenus(url: string): Promise<void> {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: 'aifill-parent', title: 'AI Form Filler', contexts: ['all'] });
  chrome.contextMenus.create({ id: 'select-dom', parentId: 'aifill-parent', title: '🎯 Pick DOM mode (auto-fill on cache hit)', contexts: ['all'] });
  // 「填充」需要可执行代码；「调试」对任何匹配当前 URL 的缓存项都可用（即便还没代码）
  const matched = (await readFormCache()).filter(e => matchesUrl(e.urlPattern, url));
  if (matched.length) {
    chrome.contextMenus.create({ id: 'aifill-sep', parentId: 'aifill-parent', type: 'separator', contexts: ['all'] });
    for (const e of matched) {
      const hasCode = !!(e.code && e.code.trim());
      const formNode = `form:${e.id}`;
      chrome.contextMenus.create({
        id: formNode,
        parentId: 'aifill-parent',
        title: `📝 ${e.formName}${hasCode ? '' : ' (no code yet)'}`,
        contexts: ['all'],
      });
      chrome.contextMenus.create({
        id: `fill:${e.id}`,
        parentId: formNode,
        title: hasCode ? '⚡ 填充 Fill' : '⚡ 填充 Fill (no code — generate first)',
        enabled: hasCode,
        contexts: ['all'],
      });
      chrome.contextMenus.create({
        id: `debug:${e.id}`,
        parentId: formNode,
        title: '🐞 调试 Debug (load into side panel)',
        contexts: ['all'],
      });
    }
  }
}

async function refreshMenusForActive(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await rebuildMenus(tab?.url ?? '');
  } catch { /* ignore */ }
}

chrome.runtime.onInstalled.addListener(() => { refreshMenusForActive(); });
chrome.runtime.onStartup?.addListener(() => { refreshMenusForActive(); });
chrome.tabs.onActivated.addListener(() => { refreshMenusForActive(); });
chrome.tabs.onUpdated.addListener((_id, info) => { if (info.status === 'complete') refreshMenusForActive(); });
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.formCache) refreshMenusForActive(); });
// 模块加载时也刷新一次
refreshMenusForActive();

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const tabId = tab?.id;
  if (!tabId) return;
  const itemId = typeof info.menuItemId === 'string' ? info.menuItemId : '';
  if (itemId === 'select-dom') {
    contextSelectMode = true;
    // 必须在用户手势内打开侧边栏（异步流程结束后再开会因手势失效而无效）
    openSidePanel(tab?.windowId);
    chrome.tabs.sendMessage(tabId, { type: 'startSelection' }).catch(() => {});
  } else if (itemId.startsWith('fill:')) {
    const id = itemId.slice('fill:'.length);
    readFormCache().then(list => {
      const e = list.find(x => x.id === id);
      if (e) fillFromCache(tabId, e);
    });
  } else if (itemId.startsWith('debug:')) {
    const id = itemId.slice('debug:'.length);
    // 必须在用户手势内打开侧边栏；随后让侧边栏强制加载该缓存项
    openSidePanel(tab?.windowId);
    requestDebugLoad(id);
  }
});

/** 通知侧边栏把某缓存项强制加载进来调试：storage 暂存（侧边栏可能正在打开）+ 广播双保险 */
async function requestDebugLoad(id: string): Promise<void> {
  await chrome.storage.local.set({ pendingDebugLoad: { id, ts: Date.now() } });
  broadcast({ type: 'debugLoadEntry', id });
}

// 监听内容脚本的选中结果——仅当处于右键"选取 DOM 模式"时由 background 处理
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'elementSelected' && contextSelectMode) {
    contextSelectMode = false;
    const tabId = sender.tab?.id;
    if (tabId) handleContextSelected(tabId, msg.selector);
  }
});

// 右键选取 DOM 后：算 domHash，命中缓存且有代码则自动执行
async function handleContextSelected(tabId: number, selector: string): Promise<void> {
  try {
    await withLock(async () => {
      progress('Reading the selected region...', 1, 1);
      const { plain, ref } = await captureSnapshot(tabId, selector);
      const domHash = getFingerprint(plain);
      const tab = await chrome.tabs.get(tabId);
      const url = tab.url ?? '';
      const entry = (await readFormCache()).find(e => matchesUrl(e.urlPattern, url) && e.domHash === domHash);
      if (entry?.code) {
        // 命中且有可执行代码：直接自动填充（rebase 到刚选中的容器内）
        await runCode(tabId, entry.code, (i, n, l) => progress(`Step ${i}/${n}: ${l}`), selector);
        broadcast({ type: 'fillComplete', success: true });
        toastTab(tabId, `✓ 已填充：${entry.formName}`, 'success');
      } else {
        // 未命中，或命中但无代码：把所选区域交给侧边栏，进入分析流程
        // （侧边栏已在右键手势内打开；用 storage 暂存 + 广播双保险，规避打开竞态）
        // 采集真实 DOM HTML（仅保留的采集模式）；失败则回退 aria 快照
        let snapshot = ref;
        const html = await fetchOuterHtml(tabId, selector);
        if (html) {
          snapshot = html + '\n\n===== ARIA SNAPSHOT of the same container (with [ref=eN] markers) =====\n' + ref;
        }
        await chrome.storage.local.set({
          pendingContextSelection: { selector, snapshot, domHash, url, ts: Date.now() },
        });
        openSidePanel(tab.windowId);
        broadcast({ type: 'contextSelected' });
      }
    });
  } catch (e: any) {
    broadcast({ type: 'opError', error: e?.message ?? String(e) });
  }
}

async function fillFromCache(tabId: number, entry: FormCacheEntry): Promise<void> {
  if (!entry.code) {
    broadcast({ type: 'opError', error: `"${entry.formName}" has no executable code — generate it in the side panel.` });
    toastTab(tabId, `“${entry.formName}” 还没有可执行代码，请先在侧边栏生成。`, 'error');
    return;
  }
  try {
    await withLock(() => runOnTab(tabId, entry.code!, entry.selector));
    broadcast({ type: 'fillComplete', success: true });
    toastTab(tabId, `✓ 已填充：${entry.formName}`, 'success');
  } catch (e: any) {
    const err = e?.message ?? String(e);
    broadcast({ type: 'opError', error: err });
    toastTab(tabId, `❌ 填充失败：${err}`, 'error');
  }
}

/** 向页面发送一个短暂提示条（侧边栏可能未打开时，给用户即时反馈） */
function toastTab(tabId: number, text: string, kind: 'success' | 'error' | 'info' = 'info'): void {
  chrome.tabs.sendMessage(tabId, { type: 'aifillToast', text, kind }).catch(() => {});
}

// ── 快捷键（Alt+Shift+F）：在页面内弹出"匹配当前 URL 的缓存表单"快速菜单 ──────────
// Chrome 扩展无法用代码打开原生右键菜单，因此用页面内浮层菜单复刻二级菜单内容。

chrome.commands?.onCommand.addListener((command) => {
  if (command === 'quick-fill-menu') showQuickMenuOnActive();
});

async function showQuickMenuOnActive(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    const url = tab.url ?? '';
    const forms = (await readFormCache())
      .filter(e => matchesUrl(e.urlPattern, url) && !!(e.code && e.code.trim()))
      .map(e => ({ id: e.id, formName: e.formName }));
    chrome.tabs.sendMessage(tab.id, { type: 'showQuickMenu', forms, pickDom: true }).catch(() => {
      /* content script 不可达（如 chrome:// 页面）：静默忽略 */
    });
  } catch { /* ignore */ }
}

// 页面内快速菜单的回传：选择某表单 → 填充；选择"Pick DOM" → 进入选取流程
chrome.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender.tab?.id;
  if (!tabId) return;
  if (msg?.type === 'quickMenuFill' && typeof msg.id === 'string') {
    readFormCache().then(list => {
      const e = list.find(x => x.id === msg.id);
      if (e) fillFromCache(tabId, e);
    });
  } else if (msg?.type === 'quickMenuPickDom') {
    contextSelectMode = true;
    openSidePanel(sender.tab?.windowId);
    chrome.tabs.sendMessage(tabId, { type: 'startSelection' }).catch(() => {});
  }
});

function openSidePanel(windowId?: number) {
  try { if (windowId != null) chrome.sidePanel.open({ windowId }).catch(() => {}); } catch { /* ignore */ }
}
