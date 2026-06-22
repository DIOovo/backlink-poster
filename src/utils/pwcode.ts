/**
 * Playwright 代码 ⇄ 结构化动作 ⇄ selector 的统一转换（service worker 与 side panel 共享）。
 *
 * 抽到单一模块的目的：执行端（background：target/链 → playwright selector）与展示端
 * （sidepanel：动作 ⇄ 代码）必须在定位语义上保持一致，分散在两处极易漂移（历史上出现过
 * 丢失 .first()、未覆盖方法被还原成 click() 等 bug）。本模块为纯函数、无 i18n / DOM 依赖，
 * 可用 Node 直接做往返单测（见 test/pwcode.test.cjs）。
 */
import type { FillTarget, FillAction } from './types';

// ── JS 字符串字面量 / CSS 转义 ───────────────────────────────────────────────

export function escStr(v: string): string {
  return String(v ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
/** 生成 JS 字符串字面量：含换行用反引号模板串（避免单引号换行报错），否则用单引号 */
export function jsStr(v: string): string {
  const s = String(v ?? '');
  if (/[\r\n]/.test(s)) {
    return '`' + s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${') + '`';
  }
  return `'${escStr(s)}'`;
}
/** 始终用反引号模板串包裹（富文本等场景，正确处理换行） */
export function tpl(v: string): string {
  return '`' + String(v ?? '').replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${') + '`';
}
/** 还原 JS 字符串字面量内容（单/双/反引号转义） */
export function unescStr(v: string): string {
  return String(v ?? '').replace(/\\(\$\{|[`'"\\])/g, (_m, g) => g);
}

/**
 * 修正不安全的 CSS 选择器：若是单一 #id 形式且 id 含 CSS 不安全字符（如 / : . 空格等），
 * 改写为属性选择器 [id="..."]，避免 Playwright 解析 CSS 时报 "Unexpected token"。
 * 其它复杂选择器（含组合符、属性、类等）原样保留。
 */
export function safeCss(sel: string): string {
  const s = String(sel ?? '').trim();
  const m = s.match(/^#([^\s>+~,\[\]()]+)$/);
  if (m && /[^A-Za-z0-9_-]/.test(m[1])) {
    return `[id="${m[1].replace(/(["\\])/g, '\\$1')}"]`;
  }
  return s;
}

// ── 结构化 target → playwright selector（执行/校验用）─────────────────────────
// playwright 的 locator 链本质是用 " >> " 连接的 selector 字符串。
// 转义规则与 playwright-core utils/isomorphic/{locatorUtils,stringUtils}.ts 保持一致。

export function escTextSel(text: any, exact: boolean): string {
  if (typeof text !== 'string') return String(text); // RegExp：原样字符串化
  return `${JSON.stringify(text)}${exact ? 's' : 'i'}`;
}
export function escAttrSel(value: any, exact: boolean): string {
  if (typeof value !== 'string') return String(value);
  return `"${value.replace(/\\/g, '\\\\').replace(/["]/g, '\\"')}"${exact ? 's' : 'i'}`;
}
export function roleSelector(role: string, options: any = {}): string {
  const props: string[] = [];
  for (const key of ['checked', 'disabled', 'selected', 'expanded', 'pressed'] as const) {
    if (options[key] !== undefined) props.push(`[${key}=${String(options[key])}]`);
  }
  if (options.includeHidden !== undefined) props.push(`[include-hidden=${String(options.includeHidden)}]`);
  if (options.level !== undefined) props.push(`[level=${String(options.level)}]`);
  if (options.name !== undefined) props.push(`[name=${escAttrSel(options.name, !!options.exact)}]`);
  return `internal:role=${role}${props.join('')}`;
}
export function attrTextSelector(attr: string, text: any, options?: any): string {
  return `internal:attr=[${attr}=${escAttrSel(text, !!options?.exact)}]`;
}

/** 结构化 target → playwright selector（与 locatorCode 语义一致） */
export function targetToSelector(t: FillTarget): string {
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
    default:            return safeCss(t.value);
  }
}

// ── 定位段（Segment）→ selector（背景执行链路与 rawToSelector 共用）────────────

export interface Segment { name: string; call: boolean; args: any[]; }

/** 单个链段 → selector 片段（数组：locator(sel,{hasText}) 会产出两段）；不支持的方法抛错 */
export function segToSelectorParts(seg: Segment): string[] {
  const a0 = seg.args[0];
  const a1 = seg.args[1];
  switch (seg.name) {
    case 'locator': {
      if (typeof a0 !== 'string') throw new Error('locator() 参数必须是字符串');
      const parts = [safeCss(a0)];
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
export function chainToSelector(segs: Segment[]): string {
  const parts: string[] = [];
  for (const seg of segs) {
    if (!seg.call) throw new Error(`定位链不支持属性访问 .${seg.name}`);
    parts.push(...segToSelectorParts(seg));
  }
  if (!parts.length) throw new Error('空定位链');
  return parts.join(' >> ');
}

// ── 动作方法名 / 第一个动作段 ────────────────────────────────────────────────

/** 动作方法名（链中第一个动作段之前为纯定位链） */
export const ACTION_METHOD_NAMES = new Set([
  'fill', 'selectOption', 'check', 'uncheck', 'setChecked', 'click', 'dblclick',
  'press', 'pressSequentially', 'type', 'clear', 'setInputFiles', 'hover',
  'focus', 'blur', 'tap', 'dragTo', 'selectText', 'scrollIntoViewIfNeeded',
  // 调试用低层事件：locator.mousedown()/mouseup()/… 与 Playwright 原生 dispatchEvent()
  'mousedown', 'mouseup', 'mousemove', 'pointerdown', 'pointerup', 'pointermove', 'dispatchEvent',
]);

/** 链中第一个动作方法的下标；无动作段返回 -1 */
export function firstActionIndex(segs: Segment[]): number {
  return segs.findIndex(s => s.call && ACTION_METHOD_NAMES.has(s.name));
}

// ── 结构化动作 → Playwright 代码 ─────────────────────────────────────────────

export function locatorCode(t: FillTarget): string {
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
export function methodCode(a: FillAction): string {
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
export function actionLine(a: FillAction): string {
  const base = (a.raw && a.raw.trim()) ? a.raw.trim() : `page.${locatorCode(a.target)}`;
  return `await ${base}.${methodCode(a)};`;
}
export function actionsToCode(actions: FillAction[]): string {
  return actions.map(actionLine).join('\n');
}

// ── Playwright 代码 → 结构化动作（展示同步用，尽力而为）──────────────────────

/** 按顶层分号切分语句；引号（'、"、`）内的分号不切分 */
export function splitStatements(code: string): string[] {
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

export function parseLocator(s: string): { target: FillTarget; rest: string } {
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

export function firstString(a: string): string {
  const m = a.match(/(['"`])([\s\S]*?)\1/);
  return m ? unescStr(m[2]) : '';
}

/**
 * 尝试把链式表达式解析为单一结构化 target（仅 page.<一个定位器>，且其后无任何后缀）。
 * ⚠ 必须没有 .first()/.last()/.nth() 等后缀——这些定位修饰若被折叠会丢失，
 *   导致原本唯一的定位变成命中多个元素（strict 模式失败）。带后缀的一律保留为 raw。
 */
export function trySimpleTarget(chain: string): FillTarget | null {
  if (!chain.startsWith('page.')) return null;
  try {
    const { target, rest } = parseLocator(chain.slice('page.'.length));
    if (rest.trim() === '') return target;
  } catch { /* not simple */ }
  return null;
}

/**
 * 把 Playwright 代码解析为动作 JSON（仅用于显示同步，尽力而为）：
 * 简单单定位器 → 结构化 target；复杂链（相对定位 / keyboard / frameLocator 等）→ raw。
 * 不抛错；无法解析的行跳过。执行始终以代码为准，不依赖本函数。
 */
export function codeToActions(code: string): FillAction[] {
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
