/**
 * AI Form Filler — Content Script
 * Handles element hover-selection on the page.
 */

import { initI18n, t, onLocaleChange } from './i18n';
import { CONFIG } from './utils/config';
import { setupBatchContent } from './batch/content';
declare const __aifillInjected: any;

(function () {
  'use strict';

  let lastQuickMenuForms: Array<{ id: string; formName: string }> | null = null;
  let lastQuickMenuPickDom = false;

  function refreshContentUi() {
    const banner = document.getElementById('__aifill_rec_banner__');
    if (banner) banner.textContent = t('content.recording');
    const gate = document.querySelector('[data-aifill-fill-gate]') as HTMLElement | null;
    if (gate) gate.textContent = t('content.fillGate');
    if (lastQuickMenuForms !== null) showQuickMenu(lastQuickMenuForms, lastQuickMenuPickDom);
  }

  let isSelecting = false;
  let hoveredEl = null;
  // 最近一次被选中的元素引用（供 html 模式直接读取真实 outerHTML，避免选择器再查询失配）
  let lastSelectedEl = null;
  // 高亮 tooltip 的文案提供器（pick/录制模式下换成 playwright 定位展示；null = 默认 buildSelector）
  let tooltipTextFor = null;
  // 轻量高亮：仅描边不压暗页面（录制模式用，避免遮挡操作视线）
  let highlightLight = false;
  // 高亮重定位器（录制/拾取模式 = recClickTarget，使高亮/提示与实际目标一致）
  let highlightRetarget = null;
  // 高亮元素与实际目标不同时（如隐藏的美化 radio：高亮可见元素、目标是隐藏控件），
  // tooltip 按实际目标显示
  let tooltipEl = null;

  // outerHTML 长度上限（清洗后），避免超大页面撑爆 token
  const MAX_HTML_LEN = CONFIG.MAX_HTML_LEN;

  // ── DOM helpers ─────────────────────────────────────────────────────────

  function removeInjected() {
    document.getElementById('__aifill_highlight__')?.remove();
    document.getElementById('__aifill_tooltip__')?.remove();
  }

  function highlight(el) {
    removeInjected();
    if (!el) return;
    hoveredEl = el;

    const rect = el.getBoundingClientRect();

    const box = document.createElement('div');
    box.id = '__aifill_highlight__';
    box.style.cssText = [
      'position:fixed',
      `top:${rect.top - 2}px`,
      `left:${rect.left - 2}px`,
      `width:${rect.width + 4}px`,
      `height:${rect.height + 4}px`,
      'border:2px solid #4f46e5',
      'background:rgba(79,70,229,0.07)',
      'border-radius:4px',
      'box-shadow:' + (highlightLight ? '0 0 0 1px rgba(79,70,229,0.35)' : '0 0 0 3000px rgba(0,0,0,0.15)'),
      'z-index:2147483646',
      'pointer-events:none',
      'transition:all 0.1s ease',
    ].join(';');
    document.documentElement.appendChild(box);

    const tipTarget = tooltipEl || el;
    const selectorText = (tooltipTextFor ? tooltipTextFor(tipTarget) : buildSelector(tipTarget)).slice(0, 88);
    const tip = document.createElement('div');
    tip.id = '__aifill_tooltip__';
    tip.style.cssText = [
      'position:fixed',
      `top:${Math.max(rect.top - 28, 6)}px`,
      `left:${Math.max(rect.left, 6)}px`,
      'background:#4f46e5',
      'color:#fff',
      'font:500 11px/1 monospace',
      'padding:4px 8px',
      'border-radius:4px',
      'z-index:2147483647',
      'pointer-events:none',
      'white-space:nowrap',
      'max-width:320px',
      'overflow:hidden',
      'text-overflow:ellipsis',
    ].join(';');
    tip.textContent = selectorText;
    document.documentElement.appendChild(tip);
  }

  // ── Selector builder ─────────────────────────────────────────────────────

  function cssEscape(str) {
    return str.replace(/[!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~]/g, '\\$&').replace(/^\d/, '\\3$& ');
  }

  function buildSelector(el) {
    // Prefer stable attributes
    if (el.id) return `#${cssEscape(el.id)}`;

    for (const attr of ['data-testid', 'data-cy', 'data-qa', 'name']) {
      const val = el.getAttribute(attr);
      if (val) return `${el.tagName.toLowerCase()}[${attr}="${val}"]`;
    }

    // Class-based with tag
    const tag = el.tagName.toLowerCase();
    if (el.className && typeof el.className === 'string') {
      const classes = el.className.trim().split(/\s+/).slice(0, 2).map(c => `.${cssEscape(c)}`).join('');
      if (classes) return `${tag}${classes}`;
    }

    // Positional fallback
    const parent = el.parentElement;
    if (parent) {
      const idx = Array.from(parent.children).indexOf(el) + 1;
      return `${buildSelector(parent)} > ${tag}:nth-child(${idx})`;
    }

    return tag;
  }

  // ── Playwright injected 桥 ─────────────────────────────────────────────────
  // public/injected.js（manifest 中先于本文件注入，同一 isolated world）暴露全局
  // __aifillInjected = Playwright InjectedScript 实例。初始化失败时为 null，
  // 所有调用方必须回退到自研实现。

  function pwInjected() {
    try {
      return (typeof __aifillInjected !== 'undefined' && __aifillInjected) || null;
    } catch (_) { return null; }
  }

  /**
   * 用 playwright codegen 同款 generateSelector 为元素生成语义定位。
   * 返回 { locator, pwSelector }；不可用/失败返回 null。
   * locator 形如 "page.getByRole('button', { name: '提交' })"。
   */
  function pwLocatorFor(el) {
    const injected = pwInjected();
    if (!injected || !el || el.nodeType !== 1) return null;
    try {
      const r = injected.generateSelector(el, { testIdAttributeName: 'data-testid' });
      if (!r || !r.selector) return null;
      // 唯一性复核（generateSelector 自带验证，保险起见再查一次）
      const n = injected.querySelectorAll(injected.parseSelector(r.selector), document).length;
      if (n !== 1) return null;
      return {
        locator: 'page.' + injected.utils.asLocator('javascript', r.selector),
        pwSelector: r.selector,
      };
    } catch (_) { return null; }
  }

  // ── 唯一 selector 生成器（拾取修复用：带唯一性验证，与后台固化逻辑一致）──────

  function attrEsc(v) { return String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }
  function isUnique(sel) {
    try { return document.querySelectorAll(sel).length === 1; } catch (_) { return false; }
  }
  function uniqueAttrCandidates(e) {
    const tag = e.tagName.toLowerCase();
    const out = [];
    if (e.id) out.push(`[id="${attrEsc(e.id)}"]`);
    const name = e.getAttribute('name');
    const type = (e.getAttribute('type') || '').toLowerCase();
    if (name && (type === 'radio' || type === 'checkbox') && e.getAttribute('value') != null) {
      out.push(`${tag}[name="${attrEsc(name)}"][value="${attrEsc(e.getAttribute('value'))}"]`);
    }
    for (const attr of ['data-testid', 'data-test-id', 'data-qa', 'data-cy', 'name', 'aria-label', 'placeholder']) {
      const v = e.getAttribute(attr);
      if (v) out.push(`${tag}[${attr}="${attrEsc(v)}"]`);
    }
    return out;
  }
  /** 生成「稳定且文档内唯一」的 CSS selector；找不到唯一锚点时退回 buildSelector */
  function buildUniqueSelector(el) {
    for (const c of uniqueAttrCandidates(el)) if (isUnique(c)) return c;
    const seg = (e) => {
      const tag = e.tagName.toLowerCase();
      const p = e.parentElement;
      if (!p) return tag;
      const sibs = Array.prototype.filter.call(p.children, (c) => c.tagName === e.tagName);
      return sibs.length === 1 ? tag : `${tag}:nth-of-type(${Array.prototype.indexOf.call(sibs, e) + 1})`;
    };
    let path = seg(el);
    let cur = el.parentElement;
    for (let depth = 0; cur && depth < 12; depth++) {
      for (const c of uniqueAttrCandidates(cur)) {
        const full = `${c} ${path}`;
        if (isUnique(full)) return full;
      }
      if (isUnique(path)) return path;
      path = `${seg(cur)} > ${path}`;
      cur = cur.parentElement;
    }
    return isUnique(path) ? path : buildSelector(el);
  }

  // ── Selection mode ───────────────────────────────────────────────────────

  function onMouseMove(e) {
    let el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el.id?.startsWith('__aifill')) return;
    // 录制/拾取模式：高亮/提示重定位到「实际会被记录的元素」，保证所见即所录
    tooltipEl = null;
    if (highlightRetarget) {
      const r = highlightRetarget(el);
      if (r && r.nodeType === 1 && r !== el) {
        const rect = r.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          el = r;          // 目标可见：高亮即目标
        } else {
          tooltipEl = r;   // 目标隐藏（美化控件）：高亮保持可见元素，提示按实际目标
        }
      }
    }
    if (el !== hoveredEl) highlight(el);
  }

  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const el = hoveredEl;
    stopSelection();
    if (el) {
      lastSelectedEl = el; // 记录引用，供 html 模式读取真实 outerHTML
      chrome.runtime.sendMessage({
        type: 'elementSelected',
        selector: buildSelector(el),
        tagName: el.tagName.toLowerCase(),
      });
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Escape' || e.key === 'Esc') {
      e.preventDefault();
      e.stopPropagation();
      stopSelection();
      chrome.runtime.sendMessage({ type: 'selectionCancelled' });
    }
  }

  function startSelection() {
    if (isSelecting) return;
    isSelecting = true;
    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('click', onClick, true);
    // 同时监听 document 与 window（捕获阶段），提高 ESC 命中率
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    document.documentElement.style.cursor = 'crosshair';
    // 让页面获得键盘焦点，否则 ESC 可能被其它上下文吞掉
    try { window.focus(); } catch (_) {}
  }

  function stopSelection() {
    isSelecting = false;
    hoveredEl = null;
    removeInjected();
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keydown', onKeyDown, true);
    document.documentElement.style.cursor = '';
  }

  // ── Pick-target mode（拾取修复：点选元素 → 唯一 selector 回传侧边栏）────────

  let isPicking = false;

  function onPickClick(e) {
    e.preventDefault();
    e.stopPropagation();
    // 与高亮一致地重定位到实际目标（隐藏控件场景 hoveredEl 是可见元素，目标是控件本身）
    let el = hoveredEl;
    if (el && highlightRetarget) el = highlightRetarget(el) || el;
    stopPicking();
    if (el) {
      // 优先 playwright generateSelector（语义定位），CSS 兜底始终携带
      const pw = pwLocatorFor(el);
      chrome.runtime.sendMessage({
        type: 'targetPicked',
        selector: buildUniqueSelector(el),
        locator: pw ? pw.locator : '',
      });
    }
  }

  function onPickKeyDown(e) {
    if (e.key === 'Escape' || e.key === 'Esc') {
      e.preventDefault();
      e.stopPropagation();
      stopPicking();
      chrome.runtime.sendMessage({ type: 'pickCancelled' });
    }
  }

  function startPicking() {
    if (isPicking) return;
    if (isSelecting) stopSelection();
    isPicking = true;
    // pick 模式：智能选中可交互元素（同录制），tooltip 实时显示 playwright 语义定位
    highlightRetarget = recClickTarget;
    tooltipTextFor = (el) => {
      const pw = pwLocatorFor(el);
      return pw ? pw.locator : buildUniqueSelector(el);
    };
    document.addEventListener('mousemove', onMouseMove, true); // 复用悬停高亮
    document.addEventListener('click', onPickClick, true);
    document.addEventListener('keydown', onPickKeyDown, true);
    window.addEventListener('keydown', onPickKeyDown, true);
    document.documentElement.style.cursor = 'crosshair';
    try { window.focus(); } catch (_) {}
  }

  function stopPicking() {
    if (!isPicking) return;
    isPicking = false;
    hoveredEl = null;
    tooltipTextFor = null;
    highlightRetarget = null;
    tooltipEl = null;
    removeInjected();
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('click', onPickClick, true);
    document.removeEventListener('keydown', onPickKeyDown, true);
    window.removeEventListener('keydown', onPickKeyDown, true);
    document.documentElement.style.cursor = '';
  }

  // ── HTML capture (real DOM) ───────────────────────────────────────────────

  // 整段移除的元素（对表单识别无意义且体积大）
  const STRIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'SVG', 'CANVAS', 'TEMPLATE', 'PATH',
  ]);
  // 逐元素移除的噪音属性（保留 id/name/type/placeholder/role/aria-*/data-*/for/value 等语义属性）
  const STRIP_ATTRS = new Set(['style', 'class']);

  /** 深度清洗克隆出来的 DOM 子树：删脚本/样式/注释、剥离噪音属性 */
  function cleanNode(node: Node) {
    // 元素节点
    if (node.nodeType === 1) {
      // 删除事件处理器与噪音属性
      for (const attr of Array.from((node as Element).attributes)) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on') || STRIP_ATTRS.has(name)) (node as Element).removeAttribute(attr.name);
      }
      // 递归处理子节点（先收集，避免边遍历边删）
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 1 && STRIP_TAGS.has((child as Element).tagName)) {
          child.remove();
        } else if (child.nodeType === 8) {
          child.remove(); // 注释
        } else {
          cleanNode(child);
        }
      }
    }
  }

  /** 取所选元素清洗后的 outerHTML，并折叠多余空白 */
  function captureCleanHtml(el) {
    if (!el) return { html: '', error: 'element not found' };
    const clone = el.cloneNode(true);
    cleanNode(clone);
    let html = clone.outerHTML || '';
    // 折叠空白：去掉标签之间的纯空白、压缩连续空白
    html = html.replace(/>\s+</g, '><').replace(/[ \t]{2,}/g, ' ').trim();
    let truncated = false;
    if (html.length > MAX_HTML_LEN) {
      html = html.slice(0, MAX_HTML_LEN);
      truncated = true;
    }
    return { html, truncated };
  }

  /** 优先用记录的引用，失配则按 selector 再查询 */
  function resolveSelected(selector) {
    if (lastSelectedEl && lastSelectedEl.isConnected) return lastSelectedEl;
    if (selector) {
      try { return document.querySelector(selector); } catch (_) { /* 非法选择器 */ }
    }
    return null;
  }

  // ── 本地表单分析（纯 DOM 解析，不调用 AI）──────────────────────────────────────
  // 在浏览器内直接遍历所选容器，识别可填写字段及其标签/类型，产出与 AI 分析相同的
  // { formName, fields:[{label,type,required}] }。标准 HTML 控件可靠；自定义/JS 组件
  // （非语义化的下拉、富文本等）可能识别不全——这是本地分析相较 AI 的固有局限。

  // 可填写控件选择器：原生表单控件 + contenteditable + 常见可填写 ARIA role
  const LOCAL_FIELD_SELECTOR = [
    'input', 'textarea', 'select',
    '[contenteditable]:not([contenteditable="false"])',
    '[role="textbox"]', '[role="searchbox"]', '[role="combobox"]', '[role="listbox"]',
    '[role="checkbox"]', '[role="switch"]', '[role="radio"]', '[role="slider"]', '[role="spinbutton"]',
  ].join(',');

  function collapseWs(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

  /** aria-labelledby → 拼接被引用元素的文本 */
  function ariaLabelledbyText(el) {
    const ids = (el.getAttribute && el.getAttribute('aria-labelledby')) || '';
    if (!ids) return '';
    const parts = [];
    ids.split(/\s+/).forEach((id) => {
      const n = id && document.getElementById(id);
      if (n) parts.push(collapseWs(n.textContent));
    });
    return collapseWs(parts.join(' '));
  }

  /** <label for="id"> 关联文本 */
  function labelForText(el) {
    if (!el.id) return '';
    try {
      const lbl = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]');
      if (lbl) return collapseWs(lbl.textContent);
    } catch (_) {}
    return '';
  }

  /** 包裹控件的 <label> 文本（去掉控件自身的值/占位影响，取整体文本即可） */
  function wrappingLabelText(el) {
    const lbl = el.closest && el.closest('label');
    return lbl ? collapseWs(lbl.textContent) : '';
  }

  /** 单个控件的可读标签（按可靠度排序回退） */
  function localFieldLabel(el) {
    return collapseWs(el.getAttribute && el.getAttribute('aria-label'))
      || ariaLabelledbyText(el)
      || labelForText(el)
      || wrappingLabelText(el)
      || collapseWs(el.getAttribute && el.getAttribute('placeholder'))
      || collapseWs(el.getAttribute && el.getAttribute('title'))
      || collapseWs(el.getAttribute && el.getAttribute('name'))
      || '';
  }

  /** radio/checkbox 组的“问题”标签：fieldset>legend 或 [role=radiogroup] 的可读名 */
  function groupLabel(el) {
    const fs = el.closest && el.closest('fieldset');
    if (fs) {
      const lg = fs.querySelector('legend');
      if (lg && collapseWs(lg.textContent)) return collapseWs(lg.textContent).slice(0, 80);
    }
    const rg = el.closest && el.closest('[role="radiogroup"],[role="group"]');
    if (rg) {
      const name = collapseWs(rg.getAttribute('aria-label')) || ariaLabelledbyText(rg);
      if (name) return name.slice(0, 80);
    }
    return '';
  }

  /** 控件类型 → DetectedField.type（与 AI 分析口径一致） */
  function localFieldType(el) {
    const tag = el.tagName;
    if (tag === 'TEXTAREA') return 'textarea';
    if (tag === 'SELECT') return 'select';
    if (el.isContentEditable) return 'textarea';
    if (tag === 'INPUT') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      const known = ['text', 'email', 'password', 'number', 'tel', 'url', 'search',
        'date', 'time', 'datetime-local', 'month', 'week', 'color', 'range', 'file'];
      return known.indexOf(t) >= 0 ? t : 'text';
    }
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (role === 'textbox' || role === 'searchbox') return 'text';
    if (role === 'combobox' || role === 'listbox') return 'select';
    if (role === 'checkbox' || role === 'switch') return 'checkbox';
    if (role === 'radio') return 'radio';
    if (role === 'slider') return 'range';
    if (role === 'spinbutton') return 'number';
    return 'text';
  }

  /** 是否应纳入分析：剔除隐藏/按钮类；radio/checkbox 即便被样式隐藏也保留（常被美化替换） */
  function localFieldVisible(el) {
    if (!el || !el.isConnected) return false;
    const type = (el.getAttribute && (el.getAttribute('type') || '')).toLowerCase();
    if (el.tagName === 'INPUT' && (type === 'radio' || type === 'checkbox')) return true;
    try {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    } catch (_) {}
    return true;
  }

  /** 容器自身首行可见文本（“最上级元素的文本”）：取第一句/前若干字符 */
  function firstLineText(el) {
    const t = collapseWs(el && el.textContent);
    if (!t) return '';
    return t.split(/[.。!！?？\n]/)[0].trim().slice(0, 60);
  }

  /** 容器前方最近的标题/标签文本（沿祖先链向上、各级向前查找） */
  function precedingHeadingText(el) {
    let cur = el;
    for (let depth = 0; cur && depth < 4; depth++) {
      let sib = cur.previousElementSibling;
      while (sib) {
        const isHeading = /^(H[1-6]|LEGEND|LABEL)$/.test(sib.tagName)
          || (sib.getAttribute && sib.getAttribute('role') === 'heading');
        if (isHeading) {
          const tx = collapseWs(sib.textContent);
          if (tx) return tx;
        }
        sib = sib.previousElementSibling;
      }
      cur = cur.parentElement;
    }
    return '';
  }

  /**
   * 表单名（本地识别没有现成 formName，从 DOM 选最合适的）：
   *   ① 容器内首个标题/legend
   *   ② 容器自身可读名（aria-label / aria-labelledby）
   *   ③ 所属 <form> 的可读名（aria-label / name / id）
   *   ④ 容器前方最近的标题/label
   *   ⑤ 容器自身首行文本（最上级元素的文本）
   *   ⑥ 页面标题兜底
   */
  function localFormName(el) {
    const h = el.querySelector && el.querySelector('h1,h2,h3,h4,h5,h6,legend,[role="heading"]');
    if (h && collapseWs(h.textContent)) return collapseWs(h.textContent).slice(0, 60);

    const selfName = collapseWs(el.getAttribute && el.getAttribute('aria-label')) || ariaLabelledbyText(el);
    if (selfName) return selfName.slice(0, 60);

    const form = el.closest && el.closest('form');
    if (form) {
      const n = collapseWs(form.getAttribute('aria-label')) || collapseWs(form.getAttribute('name')) || collapseWs(form.id);
      if (n) return n.slice(0, 60);
    }

    const prev = precedingHeadingText(el);
    if (prev) return prev.slice(0, 60);

    const own = firstLineText(el);
    if (own) return own;

    return collapseWs(document.title).slice(0, 60) || '本地识别表单';
  }

  /** 遍历所选容器，收集候选控件 [{ el, label, type }]（radio 按 name 归组，取首个为代表）。
   *  字段识别与代码生成共用，保证两者口径一致。 */
  function localCollectControls(el) {
    const nodes = [];
    if (el.matches && el.matches(LOCAL_FIELD_SELECTOR)) nodes.push(el);
    if (el.querySelectorAll) nodes.push.apply(nodes, Array.prototype.slice.call(el.querySelectorAll(LOCAL_FIELD_SELECTOR)));

    const out = [];
    const seen = new Set();
    const seenRadioGroups = new Set();
    for (const node of nodes) {
      if (seen.has(node)) continue;
      seen.add(node);
      const tag = node.tagName;
      const type = (node.getAttribute && (node.getAttribute('type') || '')).toLowerCase();
      if (tag === 'BUTTON') continue;
      if (tag === 'INPUT' && ['hidden', 'submit', 'reset', 'button', 'image'].indexOf(type) >= 0) continue;
      if (!localFieldVisible(node)) continue;

      if (tag === 'INPUT' && type === 'radio') {
        const key = node.getAttribute('name') || ('__noname_' + out.length);
        if (seenRadioGroups.has(key)) continue;
        seenRadioGroups.add(key);
        out.push({ el: node, label: (groupLabel(node) || localFieldLabel(node) || key).slice(0, 80), type: 'radio' });
        continue;
      }
      const ftype = localFieldType(node);
      out.push({ el: node, label: (localFieldLabel(node) || groupLabel(node) || ftype).slice(0, 80), type: ftype });
    }
    return out;
  }

  /** 解析所选容器，返回 { formName, fields } */
  function localDetectFields(el) {
    if (!el) return { error: 'element not found' };
    const fields = localCollectControls(el).map((c) => ({
      label: c.label, type: c.type, required: !!c.el.required,
    }));
    return { formName: localFormName(el), fields };
  }

  // ── 本地生成填充动作（不调用 AI）──────────────────────────────────────────────
  // 为每个已确认字段：用 buildUniqueSelector 生成「文档内唯一」的 CSS 定位，并按类型
  // 产出合理的默认值（满足 minlength 等长度要求）。下游与 AI 生成完全同构，可直接执行/校验。

  /** 把各种细分类型收敛为粗类，便于字段与候选控件匹配 */
  function coarseType(t) {
    const x = (t || '').toLowerCase();
    if (x === 'textarea') return 'textarea';
    // 下拉 / 选择 / 选择器 / 自动完成：统一按 select 处理（点击+选择）
    if (['select', 'combobox', 'dropdown', 'listbox', 'picker', 'datepicker', 'date-picker',
      'timepicker', 'time-picker', 'autocomplete', 'multiselect', '下拉', '选择', '选择器'].indexOf(x) >= 0
      || /picker|dropdown|select|combobox|autocomplete|下拉|选择/.test(x)) return 'select';
    if (x === 'checkbox' || x === 'switch') return 'checkbox';
    if (x === 'radio') return 'radio';
    if (x === 'range' || x === 'slider') return 'range';
    if (x === 'file') return 'file';
    if (['text', 'email', 'password', 'number', 'tel', 'url', 'search', 'date', 'time',
      'datetime-local', 'month', 'week', 'color'].indexOf(x) >= 0) return 'text';
    return 'text';
  }

  function typeCompatible(a, b) {
    const ca = coarseType(a), cb = coarseType(b);
    if (ca === cb) return true;
    // 文本框/文本域可互通
    return (ca === 'text' && cb === 'textarea') || (ca === 'textarea' && cb === 'text');
  }

  function labelMatch(a, b) {
    if (!a || !b) return false;
    return a === b || a.indexOf(b) >= 0 || b.indexOf(a) >= 0;
  }

  function ensureLen(s, min) {
    if (!min || s.length >= min) return s;
    let out = s;
    const filler = ' Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.';
    while (out.length < min) out += filler;
    return out;
  }

  function firstSelectValue(sel) {
    const opts = Array.prototype.filter.call(sel.options || [], (o) => o.value !== '' && !o.disabled);
    return opts.length ? opts[0].value : '';
  }

  /** 按字段类型/标签生成合理默认值（文本满足 minlength） */
  function localValueFor(type, label, el) {
    const L = (label || '').toLowerCase();
    const min = el && typeof el.minLength === 'number' && el.minLength > 0 ? el.minLength : 0;
    switch ((type || '').toLowerCase()) {
      case 'email': return 'test@example.com';
      case 'password': return 'Password123!';
      case 'tel': return '13800138000';
      case 'url': return 'https://example.com';
      case 'number': return '42';
      case 'date': return '2025-01-01';
      case 'time': return '12:00';
      case 'datetime-local': return '2025-01-01T12:00';
      case 'month': return '2025-01';
      case 'week': return '2025-W01';
      case 'color': return '#4f46e5';
      case 'range': return (el && el.getAttribute && el.getAttribute('value')) || '50';
      case 'file': return 'mock.txt';
      case 'textarea':
        return ensureLen('This is automatically generated placeholder text used to fill the field. '
          + 'It contains enough content to satisfy typical minimum-length requirements and to demonstrate the form filling.', min);
      default:
        if (/mail/.test(L)) return 'test@example.com';
        if (/phone|tel|mobile|手机|电话/.test(L)) return '13800138000';
        if (/first ?name|名$/.test(L)) return 'Test';
        if (/last ?name|surname|姓$/.test(L)) return 'User';
        if (/name|姓名|名字|昵称|用户名|user/.test(L)) return 'Test User';
        if (/url|网址|link|website/.test(L)) return 'https://example.com';
        if (/zip|postal|邮编/.test(L)) return '100000';
        if (/age|年龄/.test(L)) return '30';
        if (/city|城市/.test(L)) return 'Beijing';
        if (/address|地址/.test(L)) return '123 Example Street';
        return ensureLen('Test ' + (label || 'value'), min);
    }
  }

  /** 候选控件 + 字段 → 一个或多个 FillAction（数组；target 用唯一 CSS 定位）。
   *  下拉/选择/picker 类：原生 <select> 用 selectOption；自定义控件用「点击触发 + 点击首个选项」两步，
   *  绝不对其使用 fill。 */
  function localBuildActions(c, f) {
    const sel = buildUniqueSelector(c.el);
    const target = { by: 'css', value: sel };
    const label = (f.label || c.label || '').slice(0, 40);
    // 已确认的字段类型优先（与 AI 路径一致：确认类型权威），回退到本地识别到的控件类型
    const cat = coarseType(f.type || c.type);
    const el = c.el;
    if (cat === 'radio') return [{ type: 'check', target, label }];
    if (cat === 'checkbox') return [{ type: 'check', target, label }];
    if (cat === 'file') return [{ type: 'setInputFiles', target, value: 'mock.txt', label }];
    if (cat === 'select') {
      if (el.tagName === 'SELECT') {
        // 原生下拉：直接选择（非 fill）
        return [{ type: 'selectOption', target, value: firstSelectValue(el), label }];
      }
      // 自定义下拉 / picker：点击触发打开，再按 role=option 点选第一个选项（执行器自动回退页面级弹层）
      return [
        { type: 'click', target, label: label + t('content.openDropdown') },
        { type: 'click', target: { by: 'role', role: 'option', value: '' }, label: label + t('content.selectFirst') },
      ];
    }
    if (cat === 'range') return [{ type: 'fill', target, value: (el.getAttribute('value') || '50'), label }];
    return [{ type: 'fill', target, value: localValueFor(f.type || c.type, f.label || c.label, el), label }];
  }

  /** 为已确认字段在所选容器内生成动作列表 */
  function localGenerateActions(el, fields) {
    if (!el) return { error: 'element not found' };
    const cands = localCollectControls(el);
    if (!cands.length) return { actions: [] };
    const list = Array.isArray(fields) && fields.length
      ? fields
      : cands.map((c) => ({ label: c.label, type: c.type })); // 未传字段则按全部候选
    const used = new Set();
    const actions = [];
    for (const f of list) {
      const fl = collapseWs(f.label).toLowerCase();
      let idx = cands.findIndex((c, i) => !used.has(i) && typeCompatible(c.type, f.type) && labelMatch(collapseWs(c.label).toLowerCase(), fl));
      if (idx < 0) idx = cands.findIndex((c, i) => !used.has(i) && typeCompatible(c.type, f.type));
      if (idx < 0) idx = cands.findIndex((c, i) => !used.has(i));
      if (idx < 0) continue;
      used.add(idx);
      const built = localBuildActions(cands[idx], f);
      if (built && built.length) actions.push.apply(actions, built);
    }
    return { actions };
  }

  // ── 页面内快速菜单 + 提示条（快捷键触发）──────────────────────────────────────

  // 记录最近鼠标位置，使快捷键菜单在鼠标处弹出。内容脚本随页面常驻注入，
  // 此监听从页面加载即生效，故首次按快捷键也能拿到光标位置。
  let lastMouse = { x: Math.round(window.innerWidth / 2), y: Math.round(window.innerHeight / 3) };
  window.addEventListener('mousemove', (e) => { lastMouse = { x: e.clientX, y: e.clientY }; }, { passive: true, capture: true });

  let quickMenuEl = null;
  let quickMenuCleanup = null;

  function removeQuickMenu() {
    if (quickMenuCleanup) { quickMenuCleanup(); quickMenuCleanup = null; }
    if (quickMenuEl) { quickMenuEl.remove(); quickMenuEl = null; }
  }

  function showQuickMenu(forms, pickDom) {
    lastQuickMenuForms = forms;
    lastQuickMenuPickDom = !!pickDom;
    removeQuickMenu();
    const menu = document.createElement('div');
    menu.id = '__aifill_quickmenu__';
    menu.style.cssText = [
      'position:fixed', 'z-index:2147483647', 'min-width:220px', 'max-width:340px',
      'background:#fff', 'border:1px solid #e5e7eb', 'border-radius:10px',
      'box-shadow:0 8px 30px rgba(0,0,0,0.18)', 'padding:6px',
      'font:13px/1.4 system-ui,-apple-system,sans-serif', 'color:#111827', 'user-select:none',
    ].join(';');

    const title = document.createElement('div');
    title.textContent = t('content.quickMenuTitle');
    title.style.cssText = 'font-weight:600;font-size:11px;color:#6b7280;padding:4px 8px 6px;letter-spacing:.02em;';
    menu.appendChild(title);

    const makeItem = (text, onClick) => {
      const item = document.createElement('div');
      item.textContent = text;
      item.style.cssText = 'padding:8px 10px;border-radius:6px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      item.addEventListener('mouseenter', () => { item.style.background = '#eef2ff'; });
      item.addEventListener('mouseleave', () => { item.style.background = 'transparent'; });
      item.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onClick(); });
      return item;
    };

    if (forms && forms.length) {
      for (const f of forms) {
        menu.appendChild(makeItem(t('content.fillItem', { name: f.formName }), () => {
          removeQuickMenu();
          chrome.runtime.sendMessage({ type: 'quickMenuFill', id: f.id });
        }));
      }
    } else {
      const empty = document.createElement('div');
      empty.textContent = t('content.noForms');
      empty.style.cssText = 'padding:8px 10px;color:#9ca3af;font-style:italic;';
      menu.appendChild(empty);
    }

    if (pickDom) {
      const sep = document.createElement('div');
      sep.style.cssText = 'height:1px;background:#f0f0f0;margin:4px 2px;';
      menu.appendChild(sep);
      menu.appendChild(makeItem(t('content.pickDom'), () => {
        removeQuickMenu();
        chrome.runtime.sendMessage({ type: 'quickMenuPickDom' });
      }));
    }

    document.documentElement.appendChild(menu);

    // 定位：以鼠标为锚点，超出视口则向内夹紧
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    let x = lastMouse.x + 4, y = lastMouse.y + 4;
    if (x + mw > window.innerWidth - 8) x = Math.max(8, window.innerWidth - mw - 8);
    if (y + mh > window.innerHeight - 8) y = Math.max(8, window.innerHeight - mh - 8);
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    // 关闭交互：点击菜单外 / ESC / 滚动
    const onDocClick = (e) => { if (quickMenuEl && !quickMenuEl.contains(e.target)) removeQuickMenu(); };
    const onKey = (e) => { if (e.key === 'Escape' || e.key === 'Esc') { e.preventDefault(); e.stopPropagation(); removeQuickMenu(); } };
    const onScroll = () => removeQuickMenu();
    setTimeout(() => {
      document.addEventListener('mousedown', onDocClick, true);
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('scroll', onScroll, true);
    }, 0);
    quickMenuCleanup = () => {
      document.removeEventListener('mousedown', onDocClick, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
    };
    quickMenuEl = menu;
  }

  let toastTimer = null;
  function showAifillToast(text, kind) {
    let t = document.getElementById('__aifill_toast__');
    if (!t) {
      t = document.createElement('div');
      t.id = '__aifill_toast__';
      document.documentElement.appendChild(t);
    }
    const bg = kind === 'success' ? '#16a34a' : kind === 'error' ? '#dc2626' : '#4f46e5';
    t.style.cssText = [
      'position:fixed', 'bottom:20px', 'left:50%', 'transform:translateX(-50%)',
      'background:' + bg, 'color:#fff', 'font:600 13px/1.4 system-ui,sans-serif',
      'padding:10px 16px', 'border-radius:10px', 'z-index:2147483647', 'max-width:80vw',
      'box-shadow:0 4px 20px rgba(0,0,0,0.25)', 'pointer-events:none', 'text-align:center',
    ].join(';');
    t.textContent = text;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { if (t) t.remove(); }, kind === 'error' ? CONFIG.TOAST_ERROR_MS : CONFIG.TOAST_MS);
  }

  // ── Action recorder（自研：捕获用户真实操作 → 结构化动作）────────────────────
  // 参考 playwright-crx 录制器的动作模型：click→click、checkbox→check/uncheck、
  // input→fill、select→selectOption、Enter→press；但不依赖 crx/debugger，纯 DOM 监听。

  let isRecording = false;

  /** CSS 属性值转义（用于 [name="..."] / [value="..."]） */
  function cssAttr(v) { return String(v == null ? '' : v).replace(/(["\\])/g, '\\$1'); }

  function isTextLike(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    if (tag === 'INPUT') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      return !['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file'].includes(t);
    }
    return false;
  }

  /** 为元素构造“尽量唯一”的结构化定位 target（供白名单链式定位使用） */
  function recTarget(el) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute && (el.getAttribute('type') || '')).toLowerCase();
    const name = el.getAttribute && el.getAttribute('name');
    // radio/checkbox：name 常重复，必须带 value 才唯一
    if (type === 'radio' || type === 'checkbox') {
      if (el.id) return { by: 'id', value: el.id };
      if (name && el.value !== '' && el.value != null)
        return { by: 'css', value: `${tag}[name="${cssAttr(name)}"][value="${cssAttr(el.value)}"]` };
      if (name) return { by: 'css', value: `${tag}[name="${cssAttr(name)}"]` };
    }
    if (el.id) return { by: 'id', value: el.id };
    if (name) return { by: 'name', value: name };
    const ph = el.getAttribute && el.getAttribute('placeholder');
    if (ph) return { by: 'placeholder', value: ph };
    const al = el.getAttribute && el.getAttribute('aria-label');
    if (al) return { by: 'css', value: `${tag}[aria-label="${cssAttr(al)}"]` };
    return { by: 'css', value: buildSelector(el) };
  }

  /** 录制定位：优先 playwright generateSelector（raw 语义定位链），失败回退结构化 recTarget */
  function recLocate(el) {
    const pw = pwLocatorFor(el);
    if (pw) return { target: { by: 'css', value: '' }, raw: pw.locator };
    return { target: recTarget(el) };
  }

  /** 可交互元素匹配器：表单控件 + 链接/按钮 + 仅限「交互性 role」。
   *  注意不能用裸 [role]——它会命中 role="group"/"presentation" 之类的外层大容器。 */
  const INTERACTIVE_SELECTOR = [
    'input', 'textarea', 'select', 'button', 'a', 'summary',
    '[contenteditable]:not([contenteditable="false"])',
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
    '[role="combobox"]', '[role="listbox"]', '[role="option"]',
    '[role="menuitem"]', '[role="menuitemcheckbox"]', '[role="menuitemradio"]',
    '[role="tab"]', '[role="switch"]', '[role="slider"]', '[role="spinbutton"]',
    '[role="textbox"]', '[role="searchbox"]',
  ].join(',');

  /** 点击实际会被记录的元素（录制高亮/tooltip/点选修复共用，保证「所见 = 所录」）：
   *  ① 自身就是可交互元素（输入框/下拉/按钮…）→ 直接命中，绝不外溢到容器；
   *  ② label（或其内部文本）→ 关联控件；
   *  ③ 否则向上找最近的可交互祖先（仅交互性 role）；都没有才落回原元素。 */
  function recClickTarget(t) {
    if (!t || t.nodeType !== 1) return null;
    if (t.matches && t.matches(INTERACTIVE_SELECTOR)) return t;
    const lbl = t.closest && t.closest('label');
    if (lbl && lbl.control) return lbl.control;
    return (t.closest && t.closest(INTERACTIVE_SELECTOR)) || t;
  }

  function emitAction(action) {
    if (!action) return;
    chrome.runtime.sendMessage({ type: 'recordedAction', action });
  }

  // mousedown 兜底：有些自定义控件在 mousedown 阶段就响应并重渲染 DOM，后续 click 不会触发。
  // 在 mousedown 时预生成定位，若 400ms 内没等到 click 且目标已脱离文档，则补记一次 click。
  let recPendingDown = null; // { timer }

  function clearPendingDown() {
    if (recPendingDown) { clearTimeout(recPendingDown.timer); recPendingDown = null; }
  }

  function onRecMouseDown(e) {
    const t = e.target;
    if (!t || t.nodeType !== 1) return;
    if (t.id && String(t.id).startsWith('__aifill')) return;
    const lbl = t.closest && t.closest('label');
    const ctrl = (lbl && lbl.control) || t;
    const type = ctrl && ctrl.tagName === 'INPUT' ? (ctrl.getAttribute('type') || '').toLowerCase() : '';
    if (type === 'radio' || type === 'checkbox' || type === 'file') return; // 这些走 click/change 通道
    const actionEl = recClickTarget(t);
    const located = recLocate(actionEl); // 立即生成定位（元素稍后可能被移除）
    const label = recLabel(actionEl);
    clearPendingDown();
    recPendingDown = {
      timer: setTimeout(() => {
        recPendingDown = null;
        if (!actionEl.isConnected) {
          emitAction(Object.assign({ type: 'click', label }, located));
        }
      }, 400),
    };
  }

  function onRecClick(e) {
    const t = e.target;
    if (!t || t.nodeType !== 1) return;
    if (t.id && String(t.id).startsWith('__aifill')) return;
    clearPendingDown(); // click 正常到达，取消 mousedown 兜底
    const lbl = t.closest && t.closest('label');
    const ctrl = (lbl && lbl.control) || t;
    const type = ctrl && ctrl.tagName === 'INPUT' ? (ctrl.getAttribute('type') || '').toLowerCase() : '';
    if (type === 'radio') {
      // 点 label 时浏览器还会向控件转发一次合成 click——只处理落在控件上的那次，避免重复
      if (t !== ctrl) return;
      // 未选中 → 紧随的 change 会记录 check；已选中 → 不会有 change，在此补记（计数不丢）
      if (ctrl.checked) emitAction(Object.assign({ type: 'check', label: recLabel(ctrl) }, recLocate(ctrl)));
      return;
    }
    if (type === 'checkbox') return; // 点击必触发 change，由 change 记录
    if (type === 'file') return;     // 文件选择无法回放
    // 命中最近的可交互元素（按钮/链接/role 等），否则用原始目标 —— 与录制高亮所见一致
    const actionEl = recClickTarget(t);
    emitAction(Object.assign({ type: 'click', label: recLabel(actionEl) }, recLocate(actionEl)));
  }

  function onRecChange(e) {
    const el = e.target;
    if (!el || el.nodeType !== 1) return;
    const tag = el.tagName;
    if (tag === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'radio') { emitAction(Object.assign({ type: 'check', label: recLabel(el) }, recLocate(el))); return; }
      if (type === 'checkbox') { emitAction(Object.assign({ type: el.checked ? 'check' : 'uncheck', label: recLabel(el) }, recLocate(el))); return; }
      if (type === 'file') return; // 文件无法回放，跳过
      emitAction(Object.assign({ type: 'fill', value: el.value, label: recLabel(el) }, recLocate(el)));
      return;
    }
    if (tag === 'TEXTAREA') { emitAction(Object.assign({ type: 'fill', value: el.value, label: recLabel(el) }, recLocate(el))); return; }
    if (tag === 'SELECT') { emitAction(Object.assign({ type: 'selectOption', value: el.value, label: recLabel(el) }, recLocate(el))); return; }
  }

  function onRecBlur(e) {
    const el = e.target;
    if (el && el.nodeType === 1 && el.isContentEditable)
      emitAction(Object.assign({ type: 'fill', value: el.innerText, label: recLabel(el) }, recLocate(el)));
  }

  function onRecKeyDown(e) {
    if (e.key === 'Escape' || e.key === 'Esc') {
      e.preventDefault(); e.stopPropagation();
      stopRecording();
      chrome.runtime.sendMessage({ type: 'recordingStopped' });
      return;
    }
    // 仅录制 Enter（常用于提交/触发），其它按键噪音大，留给用户手动补
    if (e.key === 'Enter') {
      const el = e.target;
      if (el && el.tagName === 'TEXTAREA') return; // 文本域里的回车是换行，不录
      emitAction(Object.assign({ type: 'press', value: 'Enter', label: 'Enter' }, recLocate(el)));
    }
  }

  /** 给动作一个简短可读 label（用于侧边栏进度/注释） */
  function recLabel(el) {
    if (!el || el.nodeType !== 1) return '';
    const t = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name')))
      || (el.textContent || '').trim();
    return (t || el.tagName.toLowerCase()).slice(0, 40);
  }

  function recBanner(show) {
    let b = document.getElementById('__aifill_rec_banner__');
    if (!show) { if (b) b.remove(); return; }
    if (!b) {
      b = document.createElement('div');
      b.id = '__aifill_rec_banner__';
      b.style.cssText = [
        'position:fixed', 'top:10px', 'left:50%', 'transform:translateX(-50%)',
        'background:#dc2626', 'color:#fff', 'font:600 12px/1 system-ui,sans-serif',
        'padding:8px 14px', 'border-radius:20px', 'z-index:2147483647',
        'box-shadow:0 2px 10px rgba(0,0,0,0.25)', 'pointer-events:none',
      ].join(';');
      b.textContent = t('content.recording');
      document.documentElement.appendChild(b);
    }
  }

  function startRecording() {
    if (isRecording) return;
    if (isSelecting) stopSelection();
    isRecording = true;
    // 悬停高亮 + playwright 定位提示（轻量描边、不压暗页面、不拦截任何交互）。
    // 高亮/提示均重定位到「实际会被记录的元素」，与点击后生成的代码一致。
    highlightLight = true;
    highlightRetarget = recClickTarget;
    tooltipTextFor = (el) => {
      const pw = pwLocatorFor(el);
      return pw ? pw.locator : buildSelector(el);
    };
    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('mousedown', onRecMouseDown, true);
    document.addEventListener('click', onRecClick, true);
    document.addEventListener('change', onRecChange, true);
    document.addEventListener('blur', onRecBlur, true);
    document.addEventListener('keydown', onRecKeyDown, true);
    recBanner(true);
    try { window.focus(); } catch (_) {}
  }

  function stopRecording() {
    if (!isRecording) return;
    isRecording = false;
    highlightLight = false;
    highlightRetarget = null;
    tooltipTextFor = null;
    tooltipEl = null;
    hoveredEl = null;
    clearPendingDown();
    removeInjected();
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('mousedown', onRecMouseDown, true);
    document.removeEventListener('click', onRecClick, true);
    document.removeEventListener('change', onRecChange, true);
    document.removeEventListener('blur', onRecBlur, true);
    document.removeEventListener('keydown', onRecKeyDown, true);
    recBanner(false);
  }

  // ── Playwright 动作执行器（去 debugger 化：在页面内解析 selector 并执行动作）──
  // background 把定位链转换成 playwright selector 字符串（如 internal:role=... >> nth=0），
  // 这里用 injected 解析与求值：容器内优先、弹层自动回退页面级、strict 唯一性、状态等待。

  function sleepMs(ms) { return new Promise((r) => setTimeout(r, ms)); }

  /** 动作所需的元素状态（等待到满足或超时）；stable 含 rAF 位置稳定检查 */
  const ACTION_WAIT_STATES = {
    click: ['visible', 'enabled', 'stable'],
    dblclick: ['visible', 'enabled', 'stable'],
    tap: ['visible', 'enabled', 'stable'],
    hover: ['visible', 'stable'],
    check: ['visible', 'enabled', 'stable'],
    uncheck: ['visible', 'enabled', 'stable'],
    setChecked: ['visible', 'enabled', 'stable'],
    fill: ['visible', 'enabled', 'editable'],
    clear: ['visible', 'enabled', 'editable'],
    selectOption: ['visible', 'enabled'],
    press: ['visible', 'enabled'],
    pressSequentially: ['visible', 'enabled', 'editable'],
    type: ['visible', 'enabled', 'editable'],
    selectText: ['visible'],
    focus: [],
    blur: [],
    scrollIntoViewIfNeeded: [],
    setInputFiles: [], // 自定义上传控件的 input 常为 display:none，不做可见性要求
    // 调试用：低层鼠标/指针事件（只等可见），以及 Playwright 原生 dispatchEvent（仅等出现）
    mousedown: ['visible'], mouseup: ['visible'], mousemove: ['visible'],
    pointerdown: ['visible'], pointerup: ['visible'], pointermove: ['visible'],
    dispatchEvent: [],
  };

  function mouseEventBase(el) {
    const rect = el.getBoundingClientRect();
    return {
      bubbles: true, cancelable: true, composed: true, view: window, button: 0,
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
    };
  }

  function shouldFocusOnClick(el) {
    const tag = el && el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'A';
  }

  // ── 下拉/选项识别（决定 click 是否走「无焦点 mousedown 序列」doClickOption）──────
  const OPTION_ROLES = ['option', 'menuitem', 'menuitemradio', 'menuitemcheckbox', 'treeitem'];
  const OPTION_ANCESTOR_SELECTOR = OPTION_ROLES.map((r) => '[role="' + r + '"]').join(',');
  // 已知的下拉/选择/日期浮层容器（尽量具体，避免误伤普通导航菜单/链接）
  const POPUP_SELECTOR = [
    '[role="listbox"]', '[role="grid"]',
    '.MuiAutocomplete-popper', '.MuiMenu-paper', '.MuiMenu-list', '.MuiPopover-paper', '.MuiPickersPopper-root',
    '.ant-select-dropdown', '.ant-cascader-dropdown', '.ant-picker-dropdown',
    '.el-select-dropdown', '.el-autocomplete-suggestion', '.el-picker__popper',
    '.rc-select-dropdown', '.react-datepicker',
    '[class*="Select__menu"]', '[class*="select__menu"]', '[class*="-menu-list"]',
  ].join(',');

  function isVisibleEl(el) {
    if (!el || el.nodeType !== 1) return false;
    const injected = pwInjected();
    if (injected) { try { const r = injected.elementState(el, 'visible'); if (r) return !!r.matches; } catch (_) {} }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  /** el 是否落在一个「可见的下拉/选择浮层」里 */
  function openPopupAncestor(el) {
    let node = el.closest && el.closest(POPUP_SELECTOR);
    while (node) {
      if (isVisibleEl(node)) return node;
      const p = node.parentElement;
      node = p && p.closest ? p.closest(POPUP_SELECTOR) : null;
    }
    return null;
  }

  /** 当前是否存在可见的下拉浮层（点完触发器后判断「是否刚打开了下拉」） */
  function anyOpenPopup() {
    let nodes;
    try { nodes = document.querySelectorAll(POPUP_SELECTOR); } catch (_) { return false; }
    for (let i = 0; i < nodes.length; i++) if (isVisibleEl(nodes[i])) return true;
    return false;
  }

  // 方案 B：跨步骤「刚打开下拉、下一次 click 很可能是选项」的标记（带时间窗，防止过期误判）
  let expectingOptionUntil = 0;
  function armExpectingOption() { expectingOptionUntil = Date.now() + CONFIG.EXPECT_OPTION_MS; }
  function clearExpectingOption() { expectingOptionUntil = 0; }
  function expectingOption() { return Date.now() < expectingOptionUntil; }

  /** expectingOption 兜底点选时，排除明显需要原生行为的元素（链接/提交/原生表单控件） */
  function optionEligible(el) {
    const tag = el.tagName;
    if (tag === 'A' && el.getAttribute('href')) return false;
    if (tag === 'BUTTON' && (el.getAttribute('type') || '').toLowerCase() === 'submit') return false;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return false;
    return true;
  }

  function isOptionLike(el) {
    if (!el || el.nodeType !== 1) return false;
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (OPTION_ROLES.indexOf(role) >= 0) return true;
    if (el.closest && el.closest(OPTION_ANCESTOR_SELECTOR)) return true;     // 点到选项内部的 span/div 等
    const listbox = el.closest && el.closest('[role="listbox"]');
    if (listbox && listbox.contains(el)) return true;
    if (openPopupAncestor(el)) return true;                                   // 落在可见下拉浮层里
    try {                                                                     // 展开态 combobox 经 aria-controls 指向的浮层
      const expanded = document.querySelector('[role="combobox"][aria-expanded="true"][aria-controls]');
      if (expanded) {
        const panel = document.getElementById(expanded.getAttribute('aria-controls'));
        if (panel && panel.contains(el)) return true;
      }
    } catch (_) {}
    return false;
  }

  function isComboboxLike(el) {
    if (!el || el.nodeType !== 1) return false;
    if ((el.getAttribute('role') || '').toLowerCase() === 'combobox') return true;
    const combo = el.closest && el.closest('[role="combobox"]');
    if (!combo) return false;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'BUTTON') return true;
    if ((el.getAttribute('role') || '').toLowerCase() === 'searchbox') return true;
    return el === combo;
  }

  function dispatchClickSeq(el, detail, opts: { focus?: boolean } = {}) {
    opts = opts || {};
    const doFocus = opts.focus === true || (opts.focus !== false && shouldFocusOnClick(el));
    try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (_) {}
    const base = mouseEventBase(el);
    el.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ pointerId: 1, isPrimary: true, pointerType: 'mouse' }, base)));
    el.dispatchEvent(new MouseEvent('mousedown', Object.assign({ detail: detail || 1 }, base)));
    if (doFocus) { try { el.focus({ preventScroll: true }); } catch (_) {} }
    el.dispatchEvent(new PointerEvent('pointerup', Object.assign({ pointerId: 1, isPrimary: true, pointerType: 'mouse' }, base)));
    el.dispatchEvent(new MouseEvent('mouseup', Object.assign({ detail: detail || 1 }, base)));
    el.dispatchEvent(new MouseEvent('click', Object.assign({ detail: detail || 1 }, base)));
  }

  function doClick(el) {
    try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (_) {}
    const base = mouseEventBase(el);
    const pbase = Object.assign({ pointerId: 1, isPrimary: true, pointerType: 'mouse' }, base);
    // 完整按压序列：唤醒只监听 pointerdown/mousedown 的组件（如自定义下拉/picker 触发器），
    // 再用原生 click() 收尾——保证导航/提交/勾选/label 转发等默认行为，且 click 只触发一次。
    try {
      el.dispatchEvent(new PointerEvent('pointerover', pbase));
      el.dispatchEvent(new PointerEvent('pointerenter', pbase));
    } catch (_) {}
    el.dispatchEvent(new MouseEvent('mouseover', base));
    el.dispatchEvent(new MouseEvent('mousemove', base));
    try { el.dispatchEvent(new PointerEvent('pointerdown', pbase)); } catch (_) {}
    el.dispatchEvent(new MouseEvent('mousedown', Object.assign({ detail: 1 }, base)));
    if (shouldFocusOnClick(el)) { try { el.focus({ preventScroll: true }); } catch (_) {} }
    try { el.dispatchEvent(new PointerEvent('pointerup', pbase)); } catch (_) {}
    el.dispatchEvent(new MouseEvent('mouseup', Object.assign({ detail: 1 }, base)));
    // 原生 click 收尾（元素若在 mousedown 后脱离文档，这步无副作用）
    try { HTMLElement.prototype.click.call(el); }
    catch (_) { el.dispatchEvent(new MouseEvent('click', Object.assign({ detail: 1 }, base))); }
    return '';
  }

  function doClickCombobox(el) {
    const combo = (el.getAttribute('role') || '').toLowerCase() === 'combobox'
      ? el : (el.closest && el.closest('[role="combobox"]'));
    const target = combo || el;
    try { target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (_) {}
    const base = mouseEventBase(target);
    target.dispatchEvent(new MouseEvent('mousedown', Object.assign({ detail: 1 }, base)));
    try {
      const inner = combo && combo.querySelector('input:not([type="hidden"]), [role="searchbox"]');
      if (inner) inner.focus({ preventScroll: true });
      else if (shouldFocusOnClick(target)) target.focus({ preventScroll: true });
    } catch (_) {}
    try { HTMLElement.prototype.click.call(target); }
    catch (_) { target.dispatchEvent(new MouseEvent('click', Object.assign({ detail: 1 }, base))); }
    return '';
  }

  function optionDisplayLabel(el) {
    return (el.getAttribute('aria-label') || el.textContent || '').trim();
  }

  function findComboboxInput(optionEl) {
    const combo = optionEl.closest && optionEl.closest('[role="combobox"]');
    if (combo) return combo.querySelector('input:not([type="hidden"]), [role="searchbox"]');

    // Portal listbox (MUI/AntD): option is outside combobox subtree — match via aria-controls or expanded state.
    const listbox = optionEl.closest && optionEl.closest('[role="listbox"]');
    if (listbox && listbox.id) {
      try {
        const linked = document.querySelector('[role="combobox"][aria-controls="' + CSS.escape(listbox.id) + '"]');
        if (linked) return linked.querySelector('input:not([type="hidden"]), [role="searchbox"]');
      } catch (_) {}
    }
    const expanded = document.querySelector('[role="combobox"][aria-expanded="true"]');
    if (expanded) return expanded.querySelector('input:not([type="hidden"]), [role="searchbox"]');
    return null;
  }

  /** If React blur rolls back the selection, re-sync combobox input value. */
  async function stabilizeComboboxAfterOption(optionEl, label) {
    if (!label) return;
    await sleepMs(50);
    const input = findComboboxInput(optionEl);
    if (!input || !input.isConnected) return;
    const current = (input.value || '').trim();
    if (current === label || current.includes(label)) return;
    setNativeValue(input, label);
    fireInputChange(input, label);
    try { input.dispatchEvent(new FocusEvent('blur', { bubbles: true })); } catch (_) {}
  }

  function doClickOption(el) {
    try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (_) {}
    const base = mouseEventBase(el);
    const pbase = Object.assign({ pointerId: 1, isPrimary: true, pointerType: 'mouse' }, base);
    // React Select / MUI / AntD：选项处理常挂在 pointerdown/mousedown 上；
    // 发完整 pointer + mouse 序列、且不 focus（避免 combobox 失焦回滚）。
    try {
      el.dispatchEvent(new PointerEvent('pointerover', pbase));
      el.dispatchEvent(new PointerEvent('pointerenter', pbase));
    } catch (_) {}
    el.dispatchEvent(new MouseEvent('mouseover', base));
    el.dispatchEvent(new MouseEvent('mousemove', base));
    try { el.dispatchEvent(new PointerEvent('pointerdown', pbase)); } catch (_) {}
    el.dispatchEvent(new MouseEvent('mousedown', Object.assign({ detail: 1 }, base)));
    try { el.dispatchEvent(new PointerEvent('pointerup', pbase)); } catch (_) {}
    el.dispatchEvent(new MouseEvent('mouseup', Object.assign({ detail: 1 }, base)));
    el.dispatchEvent(new MouseEvent('click', Object.assign({ detail: 1 }, base)));
    stabilizeComboboxAfterOption(el, optionDisplayLabel(el)).catch(function () {});
    return '';
  }

  /** 原生 value setter（绕过 React/Vue 受控组件的包装，必需） */
  function setNativeValue(el, value) {
    const proto = el && el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  function resetValueTracker(el) {
    const tracker = el._valueTracker;
    if (tracker && 'value' in el) tracker.setValue(el.value);
  }

  function fireInputEvent(el, data) {
    resetValueTracker(el);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: data == null ? null : String(data) }));
  }

  function fireInputChange(el, data) {
    // Leave React's tracker at its old value so the native setter + input event is observed.
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: data == null ? null : String(data) }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** fill：injected.fill 完成校验/聚焦/全选（date/range 等直接完成）；needsinput 时补原生输入 */
  function doFill(injected, el, value) {
    const v = String(value == null ? '' : value);
    const r = injected.fill(el, v); // 可能 throw（类型不可填等）
    if (r === 'error:notconnected') return '元素已脱离文档';
    if (r === 'done') return '';
    const target = (injected.retarget && injected.retarget(el, 'follow-label')) || el;
    if (target.isContentEditable) {
      return fillContentEditable(target, v); // async：内部含校验与多级回退
    }
    setNativeValue(target, v);
    fireInputChange(target, v);
    return '';
  }

  /**
   * 富文本（contenteditable）填充：聚焦+全选 → execCommand('insertText') → 校验；
   * 失败再走 beforeinput 协议（Slate/Lexical/ProseMirror 等会接管并更新内部模型），
   * 最后兜底直改 DOM。每步后等待编辑器异步重渲染再校验。
   * 注意：execCommand 依赖真实选区与文档焦点 —— 执行前需确保页面已获得焦点。
   */
  async function fillContentEditable(target, value) {
    const v = String(value == null ? '' : value);
    const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    const want = norm(v);
    const got = () => norm(target.innerText != null ? target.innerText : target.textContent);
    const settle = () => new Promise((r) => setTimeout(r, 80));

    const selectAll = () => {
      try {
        target.focus({ preventScroll: true });
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(target);
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (_) {}
    };

    // 清空（fill('') / clear）：insertText 不接受空串，用 delete
    if (!want) {
      selectAll();
      try { document.execCommand('delete', false); } catch (_) {}
      await settle();
      if (got() === '') return '';
      target.textContent = '';
      target.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'deleteContentBackward', data: null }));
      return '';
    }

    // 0：完整点击序列激活编辑器（受控编辑器靠 mousedown/click 建立内部选区）
    dispatchClickSeq(target, 1, { focus: true });
    await settle();

    // 路径1：execCommand —— 产生带 inputType 的受认可 beforeinput/input，主流编辑器按用户输入处理
    selectAll();
    try { document.execCommand('insertText', false, v); } catch (_) {}
    await settle();
    if (got() === want) return '';

    // 路径2：合成 paste —— Draft.js/Quill/Slate 等都走 clipboardData 处理粘贴，不检查 isTrusted
    selectAll();
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', v);
      target.dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: dt, bubbles: true, cancelable: true, composed: true,
      }));
    } catch (_) {}
    await settle();
    if (got() === want) return '';

    // 路径3：手动 beforeinput 协议 —— 编辑器若 preventDefault 则由其自行更新模型
    selectAll();
    try {
      const notPrevented = target.dispatchEvent(new InputEvent('beforeinput', {
        bubbles: true, cancelable: true, composed: true, inputType: 'insertText', data: v,
      }));
      if (notPrevented) {
        // 编辑器未接管：手动落 DOM 并补 input 事件（可能被受控编辑器回滚，故仍需校验）
        target.textContent = v;
        target.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: v }));
      }
    } catch (_) {}
    await settle();
    if (got() === want) return '';

    return `富文本填充未生效（当前内容: "${got().slice(0, 60)}"，` +
      `hasFocus=${document.hasFocus()}, 编辑器=${editorHint(target)}）。` +
      '若 hasFocus=false 请先点击页面；否则该编辑器拒绝所有合成输入。';
  }

  /** 识别常见富文本编辑器框架（用于错误诊断） */
  function editorHint(el) {
    const probes = [
      ['Lexical', '[data-lexical-editor]'],
      ['Slate', '[data-slate-editor]'],
      ['ProseMirror/TipTap', '.ProseMirror'],
      ['Quill', '.ql-editor'],
      ['Draft.js', '.DraftEditor-root, .public-DraftEditor-content'],
      ['CKEditor', '[class*="ck-editor"], [class*="cke_"]'],
      ['TinyMCE', '.tox-edit-area, .mce-content-body'],
    ];
    for (const [name, sel] of probes) {
      try { if ((el.closest && el.closest(sel)) || el.querySelector(sel)) return name; } catch (_) {}
    }
    return 'unknown';
  }

  function doSetChecked(injected, el, want) {
    const input = (injected.retarget && injected.retarget(el, 'follow-label')) || el;
    if (!!input.checked === want) return '';
    dispatchClickSeq(input, 1);
    if (!!input.checked !== want) {
      // 合成点击未触发默认行为（极少数自定义实现）：直接置位 + 补事件
      const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
      if (desc && desc.set) desc.set.call(input, want); else input.checked = want;
      fireInputChange(input, null);
    }
    return '';
  }

  function doSelectOption(injected, el, arg) {
    let list;
    if (Array.isArray(arg)) list = arg.map((x) => (typeof x === 'object' && x ? x : { valueOrLabel: String(x) }));
    else if (arg && typeof arg === 'object') list = [arg]; // {index}/{label}/{value}
    else if (arg == null) list = [{ index: 0 }];
    else list = [{ valueOrLabel: String(arg) }];
    const r = injected.selectOptions(el, list); // 自带 input/change 事件
    if (r === 'error:notconnected') return '元素已脱离文档';
    if (r === 'error:optionsnotfound') return '未找到匹配的下拉选项';
    return '';
  }

  function doPress(el, key) {
    const k = String(key || 'Enter');
    const opts = { bubbles: true, cancelable: true, composed: true, key: k };
    try { el.focus({ preventScroll: true }); } catch (_) {}
    const prevented = !el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
    if (!prevented && k === 'Enter') {
      const form = el.form || (el.closest && el.closest('form'));
      if (form && form.requestSubmit) { try { form.requestSubmit(); } catch (_) {} }
    }
    return '';
  }

  function doTypeSequentially(injected, el, text) {
    const v = String(text == null ? '' : text);
    try { el.focus({ preventScroll: true }); } catch (_) {}
    for (const ch of v) {
      const opts = { bubbles: true, cancelable: true, composed: true, key: ch };
      el.dispatchEvent(new KeyboardEvent('keydown', opts));
      if (el.isContentEditable) {
        try { document.execCommand('insertText', false, ch); } catch (_) {}
      } else {
        setNativeValue(el, (el.value || '') + ch);
        fireInputEvent(el, ch);
      }
      el.dispatchEvent(new KeyboardEvent('keyup', opts));
    }
    if (!el.isContentEditable) {
      resetValueTracker(el);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return '';
  }

  function doSetInputFiles(el, value) {
    if (!el || el.tagName !== 'INPUT' || (el.getAttribute('type') || '').toLowerCase() !== 'file') {
      return 'setInputFiles 目标必须是 input[type=file]';
    }
    const dt = new DataTransfer();
    const name = String(value == null ? '' : value).split(/[\\/]/).pop() || 'mock.txt';
    dt.items.add(new File(['mock content generated by AI Form Filler'], name));
    el.files = dt.files;
    fireInputChange(el, null);
    return '';
  }

  /** 调试用：在元素上派发单个 mouse/pointer 事件（带中心点坐标） */
  function dispatchMouseLike(el, type) {
    try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (_) {}
    const base = mouseEventBase(el);
    const isPointer = type.indexOf('pointer') === 0;
    const ev = isPointer
      ? new PointerEvent(type, Object.assign({ pointerId: 1, isPrimary: true, pointerType: 'mouse' }, base))
      : new MouseEvent(type, Object.assign({ detail: 1 }, base));
    el.dispatchEvent(ev);
    return '';
  }

  /** Playwright 同名 API：dispatchEvent(type, eventInit?) —— 按事件名选构造器并派发 */
  function doDispatchEvent(el, type, init) {
    if (!type || typeof type !== 'string') return 'dispatchEvent 需要事件名，如 dispatchEvent("mousedown")';
    const opts = Object.assign({ bubbles: true, cancelable: true, composed: true }, init || {});
    let ev;
    try {
      if (/^pointer/.test(type)) ev = new PointerEvent(type, Object.assign(mouseEventBase(el), { pointerId: 1, isPrimary: true, pointerType: 'mouse' }, opts));
      else if (/^(mouse|click|dblclick|contextmenu|auxclick)/.test(type)) ev = new MouseEvent(type, Object.assign(mouseEventBase(el), opts));
      else if (/^key/.test(type)) ev = new KeyboardEvent(type, opts);
      else if (/^(focus|blur|focusin|focusout)/.test(type)) ev = new FocusEvent(type, opts);
      else if (/^(input|beforeinput)/.test(type)) ev = new InputEvent(type, opts);
      else if (/^(drag|drop)/.test(type)) ev = new DragEvent(type, opts);
      else ev = new Event(type, opts);
    } catch (_) {
      ev = new Event(type, opts);
    }
    try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (_) {}
    el.dispatchEvent(ev);
    return '';
  }

  /** 执行单个动作；返回 '' 表示成功，其它为错误信息 */
  function performAction(injected, el, action, args) {
    // 非 click 动作（fill/check/selectOption/press…）会打断「下拉打开」序列，清除标记防止过期误判
    if (action !== 'click' && action !== 'tap') clearExpectingOption();
    switch (action) {
      case 'click':
      case 'tap': {
        // ① 选项：role / 选项祖先 / 可见浮层命中，或「刚打开下拉」窗口内的合格元素 → 无焦点 mousedown 序列
        if (isOptionLike(el) || (expectingOption() && optionEligible(el))) {
          clearExpectingOption();
          return doClickOption(el);
        }
        // ② 下拉触发器：点开后武装 expectingOption，下一次 click 即按选项处理（方案 B）
        if (isComboboxLike(el)) {
          armExpectingOption();
          return doClickCombobox(el);
        }
        // ③ 普通点击：若点完浮层已出现（触发器不是标准 combobox 的情况），也武装一次
        const r = doClick(el);
        if (anyOpenPopup()) armExpectingOption(); else clearExpectingOption();
        return r;
      }
      case 'dblclick': {
        dispatchClickSeq(el, 1);
        dispatchClickSeq(el, 2);
        const rect = el.getBoundingClientRect();
        el.dispatchEvent(new MouseEvent('dblclick', {
          bubbles: true, cancelable: true, composed: true, view: window, detail: 2,
          clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
        }));
        return '';
      }
      case 'hover': {
        try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (_) {}
        const rect = el.getBoundingClientRect();
        const base = {
          bubbles: true, cancelable: true, composed: true, view: window,
          clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
        };
        el.dispatchEvent(new PointerEvent('pointerover', Object.assign({ pointerId: 1, pointerType: 'mouse' }, base)));
        el.dispatchEvent(new MouseEvent('mouseover', base));
        el.dispatchEvent(new MouseEvent('mousemove', base));
        return '';
      }
      case 'fill':   return doFill(injected, el, args[0]);
      case 'clear':  return doFill(injected, el, '');
      case 'check':      return doSetChecked(injected, el, true);
      case 'uncheck':    return doSetChecked(injected, el, false);
      case 'setChecked': return doSetChecked(injected, el, !!args[0]);
      case 'selectOption': return doSelectOption(injected, el, args[0]);
      case 'press': return doPress(el, args[0]);
      case 'pressSequentially':
      case 'type':  return doTypeSequentially(injected, el, args[0]);
      case 'selectText': {
        const r = injected.selectText(el);
        return r === 'error:notconnected' ? '元素已脱离文档' : '';
      }
      case 'focus': { const r = injected.focusNode(el, true); return r === 'error:notconnected' ? '元素已脱离文档' : ''; }
      case 'blur':  { const r = injected.blurNode(el); return r === 'error:notconnected' ? '元素已脱离文档' : ''; }
      case 'scrollIntoViewIfNeeded': {
        try {
          if (el.scrollIntoViewIfNeeded) el.scrollIntoViewIfNeeded(false);
          else el.scrollIntoView({ block: 'center', inline: 'center' });
        } catch (_) {}
        return '';
      }
      case 'setInputFiles': return doSetInputFiles(el, args[0]);
      case 'dragTo': return 'dragTo 在无 debugger 模式下不支持';
      // ── 调试用：低层鼠标/指针事件 + Playwright 原生 dispatchEvent ──────────────
      case 'mousedown': case 'mouseup': case 'mousemove':
      case 'pointerdown': case 'pointerup': case 'pointermove':
        return dispatchMouseLike(el, action);
      case 'dispatchEvent': return doDispatchEvent(el, args[0], args[1]);
      default: return `不支持的动作 .${action}()`;
    }
  }

  /**
   * 执行一步：解析 selector → 等待出现（容器优先，弹层回退页面级）→ strict 唯一性
   * → 等待动作所需状态 → 执行动作。返回 { ok } 或 { ok:false, error }。
   */
  async function pwExecStep(msg) {
    const injected = pwInjected();
    if (!injected) return { ok: false, error: 'Playwright injected 未初始化（请刷新页面）' };
    const timeout = Number(msg.timeout) || CONFIG.EXEC_STEP_TIMEOUT_MS;
    const deadline = Date.now() + timeout;

    // 页面级键盘动作：作用于当前焦点元素
    if (msg.action && msg.action.indexOf('keyboard:') === 0) {
      const el = document.activeElement && document.activeElement !== document.body
        ? document.activeElement : document.body;
      const sub = msg.action.slice('keyboard:'.length);
      const err = sub === 'press'
        ? doPress(el, msg.args && msg.args[0])
        : sub === 'insertText' || sub === 'type'
          ? doTypeSequentially(injected, el, msg.args && msg.args[0])
          : `不支持的 keyboard 动作 ${sub}`;
      return err ? { ok: false, error: err } : { ok: true };
    }

    let parsed;
    try { parsed = injected.parseSelector(msg.selector); }
    catch (e) { return { ok: false, error: 'selector 解析失败：' + String(e && e.message || e) }; }

    const optionSelector = /internal:role=option\b/i.test(msg.selector);

    function filterVisible(els) {
      return els.filter(function (e) {
        const r = injected.elementState(e, 'visible');
        return r && r.matches;
      });
    }

    function resolveElements(root) {
      let scoped = [];
      try { scoped = injected.querySelectorAll(parsed, root); } catch (e) { throw e; }
      let usedPage = false;

      if (optionSelector) {
        const scopedVis = filterVisible(scoped);
        let pageEls = scoped;
        if (root !== document) {
          pageEls = injected.querySelectorAll(parsed, document);
          usedPage = true;
        }
        const pageVis = filterVisible(pageEls);

        if (scopedVis.length === 1) return { els: scopedVis, usedPage: false };
        if (scopedVis.length > 1) return { els: scopedVis, usedPage: false };
        if (pageVis.length === 1 && scopedVis.length === 0) return { els: pageVis, usedPage: root !== document };
        if (pageVis.length > 1 && scopedVis.length === 0) return { els: pageVis, usedPage: root !== document };
        if (scoped.length === 1 && scopedVis.length === 0) return { els: scoped, usedPage: false };
        if (pageVis.length === 1) return { els: pageVis, usedPage: root !== document };
        if (scopedVis.length) return { els: scopedVis, usedPage: false };
        if (pageVis.length) return { els: pageVis, usedPage: root !== document };
      }

      let els = scoped;
      if (!els.length && root !== document) {
        const p = injected.querySelectorAll(parsed, document);
        if (p.length) { els = p; usedPage = true; }
      }
      if (optionSelector && els.length > 1) {
        const vis = filterVisible(els);
        if (vis.length === 1) els = vis;
      }
      return { els: els, usedPage: usedPage };
    }

    let usedPage = false;
    let lastState = '';
    for (;;) {
      // 每轮重新解析容器与元素（页面可能重渲染）
      let root = document;
      if (msg.scopeSelector) {
        try { const s = document.querySelector(msg.scopeSelector); if (s) root = s; } catch (_) {}
      }
      let els = [];
      try {
        const resolved = resolveElements(root);
        els = resolved.els;
        usedPage = resolved.usedPage;
      } catch (e) {
        return { ok: false, error: 'selector 求值失败：' + String(e && e.message || e) };
      }
      if (els.length > 1) {
        return { ok: false, error: `strict mode violation: "${msg.selector}" resolved to ${els.length} elements` };
      }
      if (els.length === 1) {
        const el = els[0];
        const states = ACTION_WAIT_STATES[msg.action] || ['visible'];
        let stateResult;
        try { stateResult = await injected.checkElementStates(el, states); }
        catch (e) { return { ok: false, error: '状态检查失败：' + String(e && e.message || e) }; }
        if (!stateResult) {
          // 状态满足 → 执行
          try {
            const err = await performAction(injected, el, msg.action, msg.args || []); // doFill 对富文本返回 Promise
            if (err) return { ok: false, error: err };
            return usedPage ? { ok: true, note: 'page-level' } : { ok: true };
          } catch (e) {
            return { ok: false, error: String(e && e.message || e) };
          }
        }
        lastState = stateResult.missingState || 'attached';
        // 状态未满足：继续轮询直至超时
      }
      if (Date.now() >= deadline) {
        const what = els.length === 0
          ? `定位不到元素（容器内${msg.scopeSelector ? '与页面级均' : ''}无命中）`
          : `元素未达到可操作状态（等待 ${lastState}）`;
        return { ok: false, error: `Timeout ${timeout}ms exceeded: ${what}\nselector: ${msg.selector}` };
      }
      await sleepMs(CONFIG.POLL_INTERVAL_MS);
    }
  }

  // ── Fill gate：执行前让用户点一下页面，使页面获得真实焦点 ─────────────────
  // sidepanel 是独立 web contents，无法用 window.focus() 跨文档抢焦点；
  // 真实用户点击是唯一无需 debugger 权限就能把焦点交还页面的方式。

  let fillGateEl = null;
  let fillGateTimer = null;

  function dismissFillGate() {
    if (fillGateTimer) { clearTimeout(fillGateTimer); fillGateTimer = null; }
    if (fillGateEl) { fillGateEl.remove(); fillGateEl = null; }
  }

  function armFillGate(sendResponse) {
    dismissFillGate(); // 防重复
    const el = document.createElement('div');
    el.setAttribute('data-aifill-fill-gate', '1');
    el.setAttribute('style',
      'position:fixed;inset:0;z-index:2147483647;background:rgba(15,23,42,.45);' +
      'display:flex;align-items:center;justify-content:center;cursor:pointer;' +
      'font:600 18px/1.6 system-ui,sans-serif;color:#fff;text-align:center;user-select:none;');
    el.textContent = t('content.fillGate');
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      dismissFillGate();
      try { sendResponse({ ok }); } catch (_) {}
    };
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      window.focus(); // 此时有用户激活，确保焦点落到页面文档
      finish(true);
    }, { once: true });
    fillGateTimer = setTimeout(() => finish(false), CONFIG.FILL_GATE_MS); // 60s 未点击则取消
    document.documentElement.appendChild(el);
    fillGateEl = el;
  }

  setupBatchContent({
    selector: buildUniqueSelector,
    label: localFieldLabel,
    query: selector => {
      const injected = pwInjected();
      if (!injected) throw new Error('InjectedScript unavailable.');
      return injected.querySelectorAll(injected.parseSelector(selector), document);
    },
    fill: (el, value) => doFill(pwInjected(), el, value),
    click: selector => pwExecStep({ selector, action: 'click', args: [], timeout: 5000 }),
    snapshot: el => pwInjected().ariaSnapshot(el, { forAI: true }),
    html: el => captureCleanHtml(el).html || '',
  });

  // ── Message listener ─────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'armFillGate') { armFillGate(sendResponse); return true; }
    if (msg.type === 'startSelection') { startSelection(); return; }
    if (msg.type === 'stopSelection') { stopSelection(); return; }
    if (msg.type === 'startRecording') { startRecording(); return; }
    if (msg.type === 'stopRecording') { stopRecording(); return; }
    if (msg.type === 'startPickTarget') { startPicking(); return; }
    if (msg.type === 'stopPickTarget') { stopPicking(); return; }
    if (msg.type === 'getOuterHtml') {
      try {
        const el = resolveSelected(msg.selector);
        sendResponse(captureCleanHtml(el));
      } catch (e) {
        sendResponse({ html: '', error: String(e && e.message || e) });
      }
      return true; // 同步已响应；返回 true 兼容异步通道
    }
    if (msg.type === 'localAnalyze') {
      // 本地解析所选容器的表单字段（不调用 AI）
      try {
        const el = resolveSelected(msg.selector)
          || (msg.selector ? document.querySelector(msg.selector) : null)
          || document.body;
        sendResponse(localDetectFields(el));
      } catch (e) {
        sendResponse({ error: String(e && e.message || e) });
      }
      return true;
    }
    if (msg.type === 'localGenerate') {
      // 本地为已确认字段生成动作（不调用 AI）
      try {
        const el = resolveSelected(msg.selector)
          || (msg.selector ? document.querySelector(msg.selector) : null)
          || document.body;
        sendResponse(localGenerateActions(el, msg.fields || []));
      } catch (e) {
        sendResponse({ error: String(e && e.message || e) });
      }
      return true;
    }
    if (msg.type === 'showQuickMenu') { showQuickMenu(msg.forms || [], !!msg.pickDom); return; }
    if (msg.type === 'aifillToast') { showAifillToast(msg.text || '', msg.kind || 'info'); return; }
    // ── Playwright injected 桥（供 background 后续阶段使用）──────────────────
    if (msg.type === 'pwAriaSnapshot') {
      // { selector } → { snapshot(无ref，供 domHash), refSnapshot(带 [ref=eN]) }
      try {
        const injected = pwInjected();
        if (!injected) { sendResponse({ error: 'injected unavailable' }); return true; }
        const el = resolveSelected(msg.selector)
          || (msg.selector ? document.querySelector(msg.selector) : null)
          || document.body;
        sendResponse({
          snapshot: injected.ariaSnapshot(el, {}),
          refSnapshot: injected.ariaSnapshot(el, { forAI: true }), // 后取：保持 ref 注册表为带 ref 版本
        });
      } catch (e) {
        sendResponse({ error: String(e && e.message || e) });
      }
      return true;
    }
    if (msg.type === 'pwCount') {
      // { selector(playwright selector 语法), scopeSelector? } → { count }
      try {
        const injected = pwInjected();
        if (!injected) { sendResponse({ error: 'injected unavailable' }); return true; }
        let root = document;
        if (msg.scopeSelector) {
          const scoped = document.querySelector(msg.scopeSelector);
          if (scoped) root = scoped;
        }
        const count = injected.querySelectorAll(injected.parseSelector(msg.selector), root).length;
        sendResponse({ count });
      } catch (e) {
        sendResponse({ error: String(e && e.message || e) });
      }
      return true;
    }
    if (msg.type === 'pwSolidifyRef') {
      // { ref: "e12" } → { locator: "page.getByRole(...)", pwSelector, css }（固化用）
      try {
        const injected = pwInjected();
        if (!injected) { sendResponse({ error: 'injected unavailable' }); return true; }
        const els = injected.querySelectorAll(injected.parseSelector('aria-ref=' + msg.ref), document);
        if (els.length !== 1) { sendResponse({ error: 'ref 已失效或不唯一' }); return true; }
        const el = els[0];
        const pw = pwLocatorFor(el); // generateSelector + 唯一性复核
        sendResponse({
          locator: pw ? pw.locator : '',
          pwSelector: pw ? pw.pwSelector : '',
          css: buildUniqueSelector(el),
        });
      } catch (e) {
        sendResponse({ error: String(e && e.message || e) });
      }
      return true;
    }
    if (msg.type === 'pwExecStep') {
      // 异步执行单步动作
      pwExecStep(msg)
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
      return true;
    }
  });

  initI18n().then(() => refreshContentUi());
  onLocaleChange(refreshContentUi);
})();
