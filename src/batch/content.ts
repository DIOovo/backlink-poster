import { validateDetection, type Detection, type Evidence, type FieldKey, type Identity } from './model';
import { selectReplyEntry, type ReplyCandidateDescriptor } from './reply';

type Bridge = {
  selector(el: Element): string;
  label(el: Element): string;
  query(selector: string): Element[];
  fill(el: Element, value: string): Promise<string> | string;
  click(selector: string): Promise<{ ok: boolean; error?: string }>;
  snapshot(el: Element): string;
  html(el: Element): string;
};
const EDITOR = 'textarea,[contenteditable="true"],[role="textbox"][aria-multiline="true"]';
const BUTTON = 'button,input[type="submit"],input[type="button"],[role="button"]';
const REPLY_CONTROL = 'a,button,[role="button"]';
const COMMENT_CONTEXT = '[id^="comment-"],.comment,.comment-body,.comment-content,.comment-list,.comments,.children,.reply,.discussion,.review,[data-comment-id],[data-testid*="comment"],[class*="comment"]';
const EXCLUDED_REGION = 'nav,header,footer,article p,main > p';
const COMMENT = /comment|reply|message|feedback|submission|投稿|评论|留言|回复/i;
const SEND = /submit|post|send|publish|reply|comment|提交|发布|发送|回复|评论/i;
const EXCLUDE = /search|newsletter|subscribe|log[ -]?in|sign[ -]?in|register|password|搜索|订阅|登录|注册/i;
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const visible = (el: Element) => {
  const style = getComputedStyle(el);
  return el.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none' && !el.closest('[hidden],[inert]');
};
const usable = (el: Element) => visible(el) && !el.matches(':disabled,[aria-disabled="true"],[readonly]');
const attributes = (el: Element) => ['id', 'name', 'placeholder', 'aria-label', 'action'].map(k => el.getAttribute(k) || '').join(' ');

export function setupBatchContent(bridge: Bridge) {
  const metadata = (el: Element) => attributes(el) + ' ' + bridge.label(el);
  const buttons = (root: Element) => [...root.querySelectorAll(BUTTON)].filter(usable);
  function candidates(): Element[] {
    const roots = new Set<Element>();
    for (const editor of document.querySelectorAll(EDITOR)) {
      if (!usable(editor)) continue;
      const form = editor.closest('form');
      if (form) { roots.add(form); continue; }
      let parent = editor.parentElement;
      for (let i = 0; parent && parent !== document.body && i < 5; i++, parent = parent.parentElement) {
        if (buttons(parent).some(b => SEND.test(metadata(b) + ' ' + b.textContent))) { roots.add(parent); break; }
      }
    }
    return [...roots].filter(root => !root.querySelector('input[type="password"]') && !EXCLUDE.test(attributes(root))).sort((a, b) => Number(b.matches('form#commentform')) - Number(a.matches('form#commentform'))).slice(0, 8);
  }
  function localDetect(): Detection {
    const detected: Extract<Detection, {found: true}>[] = [];
    for (const root of candidates()) {
      const wordpress = root.matches('form#commentform');
      const editors = [...root.querySelectorAll(EDITOR)].filter(usable);
      const content = wordpress
        ? editors.filter(e => e.matches('textarea#comment,textarea[name="comment"]'))
        : editors.filter(e => COMMENT.test(metadata(e)));
      const heading = root.querySelector('h1,h2,h3,h4,legend')?.textContent || root.previousElementSibling?.textContent?.slice(0, 200) || '';
      const eligible = content.length ? content : COMMENT.test(attributes(root) + ' ' + heading) ? editors : [];
      if (eligible.length !== 1) continue;
      const controls = buttons(root).filter(b => !EXCLUDE.test(metadata(b) + ' ' + b.textContent));
      const specific = controls.filter(b => SEND.test(metadata(b) + ' ' + b.textContent));
      const submits = specific.length ? specific : controls.filter(b => b.matches('input[type="submit"],button[type="submit"],button:not([type])'));
      if (submits.length !== 1) continue;
      const field = (el: Element) => ({ locator: bridge.selector(el), required: el.hasAttribute('required') || el.getAttribute('aria-required') === 'true' });
      const fields: Extract<Detection, {found: true}>['fields'] = { content: field(eligible[0]) };
      let ambiguous = false;
      for (const key of ['name', 'email', 'website'] as const) {
        const expressions = { name: /\b(name|author)\b|姓名/i, email: /e-?mail|邮箱/i, website: /website|\burl\b|homepage|\bsite\b|网址/i };
        const inputs = [...root.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"])')].filter(usable);
        const matches = inputs.filter(el => expressions[key].test(metadata(el)) || (key === 'email' && el.matches('input[type="email"]')) || (key === 'website' && el.matches('input[type="url"]')));
        if (matches.length === 1) fields[key] = field(matches[0]);
        else if (matches.length > 1) ambiguous = true;
      }
      if (!ambiguous) detected.push({ found: true, formType: wordpress ? 'wordpress_comment' : 'comment', confidence: wordpress ? 1 : 0.9, fields, submit: { locator: bridge.selector(submits[0]) } });
    }
    // Multiple plausible comment forms require disambiguation, never an arbitrary first().
    const wp = detected.filter(d => d.formType === 'wordpress_comment');
    return wp.length === 1 ? wp[0] : detected.length === 1 ? detected[0] : { found: false };
  }
  const replyDescriptor = (el: Element): ReplyCandidateDescriptor => ({
    locator: bridge.selector(el),
    text: norm(el.textContent || ''),
    ariaLabel: el.getAttribute('aria-label') || '',
    title: el.getAttribute('title') || '',
    className: typeof el.className === 'string' ? el.className : '',
    id: el.id,
    visible: visible(el),
    enabled: !el.matches(':disabled,[aria-disabled="true"]'),
    inCommentContext: !!el.closest(COMMENT_CONTEXT),
    highConfidence: el.matches('a.comment-reply-link,[data-commentid],[data-postid],[data-belowelement],[data-respondelement],[data-comment-id][role="button"],[data-testid*="reply"]'),
    inExcludedRegion: !!el.closest(EXCLUDED_REGION),
  });
  function localReplyEntry() {
    return selectReplyEntry([...document.querySelectorAll(REPLY_CONTROL)].map(replyDescriptor));
  }
  function aiReplyCandidates(): Element[] {
    return [...document.querySelectorAll(REPLY_CONTROL)].filter(el => {
      const d = replyDescriptor(el);
      return d.visible && d.enabled && !d.inExcludedRegion && (d.inCommentContext || d.highConfidence);
    }).slice(0, 30);
  }
  function validateReplyLocator(locator: string): Element {
    const matches = bridge.query(locator);
    if (matches.length !== 1) throw new Error(`Reply locator must identify exactly one element: ${locator}`);
    const el = matches[0];
    if (!el.matches(REPLY_CONTROL)) throw new Error('Reply trigger must be a link or button.');
    const d = replyDescriptor(el);
    if (!d.visible || !d.enabled || d.inExcludedRegion || (!d.inCommentContext && !d.highConfidence)) throw new Error('Reply trigger is not a safe visible control in comment context.');
    const auth = selectReplyEntry([{ ...d, highConfidence: false, inCommentContext: true }]);
    if (auth && 'requiresAuth' in auth) throw new Error('Reply requires authentication');
    if (/\breply\s+by\s+e-?mail\b|\be-?mail\s+reply\b|\bshare\b|\breport\b|邮件回复|通过邮件回复|分享|举报/i.test([d.text, d.ariaLabel, d.title].join(' '))) throw new Error('Unsafe reply trigger.');
    return el;
  }
  function one(selector: string): HTMLElement {
    const els = bridge.query(selector);
    if (els.length !== 1 || !usable(els[0])) throw new Error(`Locator must identify one visible, enabled field: ${selector}`);
    return els[0] as HTMLElement;
  }
  function mapping(raw: Detection) {
    const d = validateDetection(raw);
    if (!d.found || 'strategy' in d) throw new Error('Form not found.');
    const content = one(d.fields.content.locator);
    if (!content.matches(EDITOR)) throw new Error('Content locator is not a large text input.');
    const root = content.closest('form') || candidates().find(r => r.contains(content));
    if (!root) throw new Error('No form container for Content.');
    const submit = one(d.submit.locator);
    if (!root.contains(submit) || !submit.matches(BUTTON) || EXCLUDE.test(metadata(submit) + ' ' + submit.textContent)) throw new Error('Submit must be a button in the same comment form.');
    if (root.querySelector('input[type="password"]')) throw new Error('Login forms are not supported.');
    const seen = new Set<Element>([submit]);
    for (const f of Object.values(d.fields)) {
      const el = one(f.locator);
      if (!root.contains(el) || seen.has(el) || !el.matches('input:not([type="hidden"]):not([type="password"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]),textarea,[contenteditable="true"],[role="textbox"]')) throw new Error('Invalid, duplicate or out-of-form field locator.');
      seen.add(el);
    }
    return { d, content, root, submit };
  }
  const valueOf = (el: HTMLElement) => 'value' in el ? String((el as HTMLInputElement).value) : el.innerText;
  const exact = (s: string) => s.replace(/\r\n/g, '\n');
  async function fill(raw: Detection, identity: Identity, text: string) {
    const { d } = mapping(raw);
    for (const key of ['name', 'email', 'website', 'content'] as FieldKey[]) {
      const f = d.fields[key];
      if (!f) continue;
      const value = key === 'content' ? text : identity[key];
      if (!value && key !== 'content') continue;
      try {
        const err = await bridge.fill(one(f.locator), value);
        if (err) throw new Error(err);
        if (key === 'website') {
          const el = one(f.locator) as HTMLInputElement;
          if (!el.required && el.validity && !el.validity.valid) await bridge.fill(el, '');
        }
      } catch (e) { if (key !== 'website') throw e; }
    }
    await new Promise(r => setTimeout(r, 150));
    return validate(raw, identity, text);
  }
  function validate(raw: Detection, identity: Identity, text: string) {
    const { d, root } = mapping(raw);
    if (!text || exact(valueOf(one(d.fields.content.locator))) !== exact(text)) throw new Error('Content did not retain the exact supplied text.');
    for (const key of ['name', 'email'] as const) {
      const f = d.fields[key];
      if (f && identity[key] && exact(valueOf(one(f.locator))) !== exact(identity[key])) throw new Error(`${key} did not retain the supplied value.`);
    }
    const invalid = [...root.querySelectorAll('input,textarea,select')].find(el => !el.matches('input[type="url"]') && 'checkValidity' in el && !(el as HTMLInputElement).checkValidity());
    if (invalid) throw new Error(`Required or invalid field: ${bridge.label(invalid) || invalid.getAttribute('name') || invalid.tagName}`);
    return { ok: true };
  }
  function challenge(): string | undefined {
    if ([...document.querySelectorAll('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="challenges.cloudflare"],.g-recaptcha,.h-captcha,.cf-turnstile,#challenge-running')].some(visible) || /^(Just a moment|Attention Required)/i.test(document.title)) return 'CAPTCHA or access challenge detected; not bypassed.';
  }
  function evidence(): Evidence {
    const texts = (selector: string) => [...document.querySelectorAll(selector)].filter(visible).map(e => `${e.id}|${norm((e as HTMLElement).innerText || e.textContent || '').slice(0, 8000)}`);
    const body = document.body.innerText;
    const moderation = texts('.comment-awaiting-moderation,[class*="moderation"],[class*="pending-approval"]');
    const success = texts('[role="status"],.success,.success-message,.comment-success,.notice-success');
    const errors = texts('[role="alert"],.error,.errors,.error-message,.comment-error,.notice-error');
    for (const match of body.matchAll(/(?:your comment is |comment )?(?:awaiting moderation|pending approval)|评论正在审核|等待审核/gi)) moderation.push(match[0]);
    for (const match of body.matchAll(/(?:your (?:comment|reply|submission|message) (?:has been |was |is )?(?:successfully )?(?:submitted|posted|published|received|sent))|(?:thank you for your (?:comment|submission|message))/gi)) success.push(match[0]);
    for (const match of body.matchAll(/duplicate comment detected[^\n]*|you are posting comments too quickly[^\n]*|sorry, (?:comments are closed|you must be logged in)[^\n]*|error:\s*please[^\n]*/gi)) errors.push(match[0]);
    return { url: location.href, comments: texts('[id^="comment-"],.comment-body,.comment-content,[data-comment-id]'), moderation, success, errors };
  }
  function outcome(before: Evidence, text: string) {
    const after = evidence();
    const fresh = (key: keyof Omit<Evidence, 'url'>) => after[key].filter(s => !before[key].includes(s));
    const errors = fresh('errors');
    if (errors.length) return { status: 'SUBMIT_FAILED', error: errors.join('; ').slice(0, 1500) };
    if (fresh('moderation').length || fresh('comments').some(s => s.includes(norm(text)) && /awaiting moderation|pending approval|等待审核|正在审核/i.test(s))) return { status: 'PENDING_MODERATION' };
    if (fresh('comments').some(s => s.includes(norm(text))) || fresh('success').some(s => /(?:comment|reply|submission|message).*(?:submitted|posted|published|received|sent|success)|thank you/i.test(s))) return { status: 'SUCCESS' };
    // A changed URL alone is not proof; the new comment anchor must contain this task's text.
    const hash = location.hash;
    if (after.url !== before.url && /^#comment-\d+$/.test(hash) && norm(document.getElementById(hash.slice(1))?.textContent || '').includes(norm(text))) return { status: 'SUCCESS' };
    const blocked = challenge();
    return blocked ? { status: 'SUBMIT_FAILED', error: blocked } : { status: null };
  }
  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (!String(msg?.type).startsWith('batchPage:')) return;
    (async () => {
      switch (msg.type) {
        case 'batchPage:detect': return { detection: localDetect(), challenge: challenge() };
        case 'batchPage:findReply': return localReplyEntry() || { found: false };
        case 'batchPage:activateReply': {
          const target = validateReplyLocator(String(msg.locator || ''));
          const locator = bridge.selector(target);
          return bridge.click(locator);
        }
        case 'batchPage:snapshot': {
          const roots = candidates();
          const entries = aiReplyCandidates();
          const all = [...roots, ...entries.filter(entry => !roots.some(root => root.contains(entry)))];
          const snapshot = all.map((root, i) => `CANDIDATE ${i + 1}\n${bridge.html(root).slice(0, 10000)}`).join('\n').slice(0, 45000);
          // One snapshot call keeps the InjectedScript ARIA reference registry intact.
          return { snapshot: snapshot + '\nARIA SNAPSHOT\n' + bridge.snapshot(document.body).slice(0, 30000), candidateCount: all.length };
        }
        case 'batchPage:prepare': {
          const { d } = mapping(msg.detection);
          // Solidify ephemeral ARIA refs before filling can re-render a controlled form.
          for (const f of Object.values(d.fields)) f.locator = bridge.selector(one(f.locator));
          d.submit.locator = bridge.selector(one(d.submit.locator));
          mapping(d);
          return { detection: d };
        }
        case 'batchPage:fill': return fill(msg.detection, msg.identity, msg.content);
        case 'batchPage:baseline': validate(msg.detection, msg.identity, msg.content); return { evidence: evidence() };
        case 'batchPage:submit': {
          if (challenge()) throw new Error(challenge());
          validate(msg.detection, msg.identity, msg.content);
          const { submit } = mapping(msg.detection);
          // Keep navigation in the dedicated worker tab, including target=_blank forms.
          submit.removeAttribute('formtarget');
          submit.closest('form')?.setAttribute('target', '_self');
          return bridge.click(msg.detection.submit.locator);
        }
        case 'batchPage:outcome': return outcome(msg.baseline, msg.content);
        case 'batchPage:scrollResult': {
          const hash = location.hash.slice(1);
          const target = (hash && document.getElementById(hash)) || [...document.querySelectorAll('.comment-awaiting-moderation,.comment-content,.comment-body,[id^="comment-"]')].reverse().find(e => norm(e.textContent || '').includes(norm(msg.content))) || document.querySelector('form#commentform') || candidates()[0];
          if (target) target.scrollIntoView({ block: 'center' });
          return { ok: true };
        }
        default: throw new Error('Unknown batch page message.');
      }
    })().then(respond).catch(e => respond({ error: e instanceof Error ? e.message : String(e) }));
    return true;
  });
}
