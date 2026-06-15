import type { AIConfig, CaptureMode, DetectedField, FillAction, FormAnalysis } from './types';

const SYSTEM_PROMPT = `You are a web form automation assistant.
Given an ARIA accessibility snapshot of a web form and user instructions, output a JSON object describing the actions to fill the form.
The snapshot covers ONLY the user-selected form container, and locators are resolved INSIDE that container — they must be unique within this snapshot region (not the whole page).
Elements in the snapshot may carry a reference marker like [ref=e12].

STRICT RULES:
1. Output ONLY raw JSON — NO markdown, NO code fences, NO explanations.
2. Shape: { "actions": [ Action, ... ] }
3. Each Action:
   {
     "type": "<Playwright Locator method name>",
     "target": { "by": "<strategy>", "value": "<string>", "role": "<aria-role>"? },
     "ref": "<eN>"?,  // REQUIRED whenever the target element has a [ref=eN] marker in the snapshot. The executor resolves the ref first (exact element); target/raw is the durable fallback for cached replays. ref NEVER replaces target — always provide BOTH.
     "raw": "<full Playwright locator chain starting with page., WITHOUT the trailing action call>"?,  // optional; overrides target. Use for relative/ambiguous locators.
     "value": "<string>"?,
     "label": "<short human description>"?  // optional, for progress UI
   }
4. "type" MUST be the EXACT Playwright Locator method appropriate for the ELEMENT TYPE — the action string maps 1:1 to a Playwright method:
   - text / email / password / number / tel / url / search / textarea / date / time / datetime-local / color → "fill"  (value REQUIRED)
   - range slider (input[type=range]) → "fill"  (value = the number as a string, e.g. "50")
   - checkbox → "check" to tick, "uncheck" to untick (no value); radio → "check" (no value).
     ⚠ RADIO/CHECKBOX DISAMBIGUATION: option labels like "Yes"/"No"/"Male" often REPEAT across multiple questions on the same page. getByRole('radio',{name:'Yes'}) would then match MORE THAN ONE element and FAIL with a strict-mode violation. You MUST make the locator resolve to EXACTLY ONE element:
       • BEST (esp. in HTML mode): use "css" with a stable unique attribute on the input OR a wrapping container, e.g. {"by":"css","value":"#hasConflict-Yes input[type=radio]"} or {"by":"css","value":"input[name='hasConflict'][value='yes']"}.
       • OTHERWISE: use a "raw" relative-locator anchored on the QUESTION text, e.g. "raw":"page.getByText('Conflict of interest').locator('..').getByRole('radio', { name: 'Yes' })" (add more .locator('..') to climb to the common ancestor of the question and its options if needed).
       • Do NOT emit a bare getByRole('radio',{name:'Yes'}) when that name repeats.
   - button / link → "click" (no value)
   - DROPDOWN / SELECT (native <select> OR custom overlay) — ALWAYS use the SAME two-step strategy: (1) "click" the trigger to open it; (2) "click" an option located by role "option" WITHOUT a "value" → target {"by":"role","role":"option"} → executes as page.getByRole('option').first().click() (picks the first option). Only set "value" to the option text if the user asked for a specific option. Do NOT use "selectOption".
   - RICH TEXT EDITOR / WYSIWYG (contenteditable; TinyMCE, CKEditor, Quill, ProseMirror, Slate 等) — its "placeholder" is usually a SIMULATED <p>, NOT a real input placeholder, so NEVER use getByPlaceholder on it. Use "fill" with the text (wrap multi-line text — it will be emitted with backticks so newlines work). Locate by role "textbox" (often aria-multiline) using the field's accessible name. IF TWO OR MORE editors share the same name/role (ambiguous), DISAMBIGUATE with a "raw" relative-locator chain instead of target, e.g. "raw":"page.locator('text=Aims and Scope').locator('..').getByRole('textbox')" (the action then runs <raw>.fill(...)). You may use "raw" for ANY action when a structured target can't express the locator.
   - keyboard entry into a custom widget → "press" (value = key, e.g. "Enter")
   Do NOT use "fill" on a <select>, checkbox, radio, or button.
5. LOCATOR (target.by) — pick the MOST RELIABLE for the snapshot. The snapshot is ARIA/role-based, so prefer in THIS order:
   a) "role"  — set "role" to the ARIA role ("textbox", "combobox", "checkbox", "radio", "slider", "button", "link", "spinbutton", "searchbox") and "value" to the accessible name. THIS IS USUALLY THE BEST CHOICE.
   b) "placeholder" — when the field shows placeholder text.
   c) "css" — a CSS selector (by id / name / data-* / class) when role & placeholder are ambiguous. ⚠ If you target by id and the id contains characters that are unsafe in a CSS selector (e.g. "/", ":", ".", spaces, like id="Country/Region_autocomplete"), do NOT write a bare "#Country/Region_autocomplete" (it fails to parse). Instead use {"by":"id","value":"Country/Region_autocomplete"} (the tool emits a safe [id="…"]) OR a css attribute selector value like [id="Country/Region_autocomplete"].
   d) "text" — for clickable text or links.
   e) "name" / "id" — attribute values.
   ⚠ DO NOT use "label" for <div>-based custom fields. Many forms (and this one) have NO real <label> element — getByLabel WILL FAIL there. Only use "label" if the snapshot clearly shows a proper <label for> / aria-label association; otherwise use "role" or "css".
   ⚠ UNIQUENESS (STRICT MODE): EVERY locator MUST resolve to EXACTLY ONE element WITHIN THE SNAPSHOT REGION. Playwright runs in strict mode, so a locator that matches 2+ elements THROWS. If the same accessible name / role / placeholder / text appears more than once in the snapshot (very common for repeated "Yes"/"No" radios, "Add"/"Remove" buttons, repeated rows), you MUST narrow it — scope by a unique id/name via "css", anchor on nearby unique text with a "raw" relative locator, or as a LAST resort append .first()/.nth(n) inside a "raw" chain. Never rely on a non-unique target.
   ⚠ REF: regardless of which target strategy you pick, ALSO set "ref" to the element's [ref=eN] marker whenever present — it lets the tool verify and self-heal the locator.
6. If the user provides specific data values, use them exactly. Otherwise generate realistic, plausible fake data. RESPECT LENGTH REQUIREMENTS: if a field indicates a minimum length / word count (e.g. minlength, "at least N characters/words", "最少N字", "不少于N字", or a long textarea like Aims/Scope/Abstract that clearly expects a paragraph), generate ENOUGH text to MEET that minimum — do NOT output something shorter than required. When there is NO length requirement, keep values reasonably concise.
7. Do NOT include navigation, waits, page.goto, or anything outside the actions array.
8. Output a SINGLE, COMPLETE, valid JSON object. Do NOT wrap it in markdown/code fences. Do NOT add any text before or after the JSON. Ensure every bracket and quote is closed.

Example output:
{"actions":[
  {"type":"fill","target":{"by":"role","role":"textbox","value":"Email"},"ref":"e3","value":"test@example.com","label":"邮箱"},
  {"type":"fill","target":{"by":"placeholder","value":"Enter Topic 1"},"ref":"e7","value":"Renewable Energy","label":"主题1"},
  {"type":"click","target":{"by":"role","role":"button","value":"Journal Name"},"label":"打开下拉"},
  {"type":"click","target":{"by":"role","role":"option"},"label":"选择第一个选项"},
  {"type":"fill","target":{"by":"role","role":"slider","value":"Volume"},"value":"50","label":"音量"},
  {"type":"fill","target":{"by":"role","role":"textbox","value":"Aims and Scope"},"value":"段落正文……","label":"富文本(唯一)"},
  {"type":"fill","raw":"page.locator('text=References').locator('..').getByRole('textbox')","value":"[1] ...\n[2] ...","label":"富文本(同名消歧)"},
  {"type":"check","target":{"by":"css","value":"#hasConflict-Yes input[type=radio]"},"ref":"e21","label":"是否有利益冲突:是(按唯一id消歧)"},
  {"type":"check","raw":"page.getByText('Funding received').locator('..').getByRole('radio', { name: 'No' })","label":"是否有资助:否(按问题文本消歧)"},
  {"type":"check","target":{"by":"role","role":"checkbox","value":"I agree"},"label":"同意条款"},
  {"type":"click","target":{"by":"role","role":"button","value":"Submit"},"label":"提交"}
]}`;

const DETECT_SYSTEM_PROMPT = `You are a web form analyzer.
Given an ARIA accessibility snapshot of a web page region, name the form and list EVERY fillable form field a user could complete.

STRICT RULES:
1. Output ONLY raw JSON — NO markdown, NO code fences, NO explanations.
2. Shape: { "formName": "<short descriptive name of the form>", "fields": [ { "label": "<visible label or accessible name>", "type": "<field type>", "required": true|false }, ... ] }
3. "formName" is a concise human label for this form (e.g. "注册表单", "结账地址", "登录"). Infer it from headings / context.
4. "type" should be one of: "text", "email", "password", "number", "tel", "url", "textarea", "select", "checkbox", "radio", "date", "range", "file". Pick the closest.
5. Use the human-visible label / accessible name as "label".
6. Include text inputs, textareas, selects, checkboxes and radios. Do NOT include submit/reset/cancel buttons or pure navigation links.
7. List fields in the order they appear. Do not invent fields that are not in the snapshot.
8. The snapshot may contain [ref=eN] markers on elements — ignore them for this task.

Example output:
{"formName":"注册表单","fields":[
  {"label":"邮箱","type":"email","required":true},
  {"label":"密码","type":"password","required":true},
  {"label":"国家","type":"select","required":false},
  {"label":"同意条款","type":"checkbox","required":true}
]}`;

/** 流式增量回调：参数为「累计的完整文本」 */
export type StreamCallback = (fullText: string) => void;

/** 根据采集模式，描述发送给 AI 的 payload 是什么 */
function payloadLabel(mode: CaptureMode): string {
  return mode === 'html'
    ? 'Real (cleaned) DOM HTML of the form container'
    : 'Accessibility (ARIA) snapshot of the form container';
}

/** html 模式追加提示：可直接利用真实属性做更稳的定位 */
function modeHint(mode: CaptureMode): string {
  if (mode !== 'html') return '';
  return '\n\nNOTE: The content above starts with REAL DOM HTML of the selected container (an ARIA snapshot ' +
    'with [ref=eN] markers may follow it — use it to pick "ref" values). You may rely on actual ' +
    'attributes (id, name, type, placeholder, for, data-* , aria-*) — prefer "css" (by #id / [name] / ' +
    '[data-*]) or "id" / "name" locators when they are present and stable, otherwise fall back to "role" ' +
    '(getByRole works on real DOM too) or "placeholder" / "text". A real <label for="..."> association is ' +
    'reliable here, so "label" is acceptable when such a <label> exists.';
}

/** 把「检测阶段确认的字段类型」映射为「生成阶段必须使用的 Playwright 方法策略」。
 *  目的：避免模型在生成时按快照重新判定（例如把自定义下拉当成文本框而误用 fill）。 */
function methodHintForType(type: string): string {
  const t = (type || '').trim().toLowerCase();
  switch (t) {
    case 'select':
    case 'dropdown':
    case 'combobox':
      return 'use type "click" TWICE (the two-step dropdown strategy): first "click" the trigger to open it, then "click" the option by {"by":"role","role":"option"}. NEVER use "fill" or "selectOption" for this field.';
    case 'checkbox':
      return 'use "check" (or "uncheck"); NO value. If the option label repeats across questions, disambiguate via unique css id/name or a raw locator anchored on the question text.';
    case 'radio':
      return 'use "check"; NO value. If the option label (Yes/No/…) repeats across questions, you MUST disambiguate via unique css id/name or a raw locator anchored on the question text — a bare role+name would match multiple radios and fail.';
    case 'file':
      return 'use "setInputFiles".';
    case 'range':
      return 'use "fill" with the number as a string (e.g. "50").';
    case 'textarea':
      return 'use "fill" (this is a multi-line / paragraph field — respect any minimum length).';
    case 'date':
    case 'time':
    case 'datetime-local':
    case 'color':
    case 'text':
    case 'email':
    case 'password':
    case 'number':
    case 'tel':
    case 'url':
    case 'search':
      return 'use "fill" with the value.';
    default:
      return 'pick the Playwright method that matches this type per the rules above.';
  }
}

/** 输出上限：表单字段多、文本长，2048 会被截断，统一提到 8192 */
const MAX_TOKENS = 8192;

/** 低层调用结果：完整文本 + 是否因达到 max_tokens 而被截断 */
interface LLMResult { text: string; truncated: boolean; }

/** 是否使用 Anthropic 报文格式（anthropic / custom-anthropic） */
function useAnthropicFormat(config: AIConfig): boolean {
  return config.provider === 'anthropic' || config.provider === 'custom-anthropic';
}

async function dispatch(config: AIConfig, system: string, userMessage: string, onDelta?: StreamCallback): Promise<LLMResult> {
  return useAnthropicFormat(config)
    ? callAnthropic(config, system, userMessage, onDelta)
    : callOpenAI(config, system, userMessage, onDelta);
}

/**
 * 阶段 1：识别表单字段，供用户确认 / 增删改。
 */
export async function detectFields(config: AIConfig, snapshot: string, mode: CaptureMode, onDelta?: StreamCallback): Promise<FormAnalysis> {
  const userMessage =
    `${payloadLabel(mode)}:\n\`\`\`\n${snapshot}\n\`\`\`\n\n` +
    `Name the form and list every fillable field.${modeHint(mode)}`;

  const { text, truncated } = await dispatch(config, DETECT_SYSTEM_PROMPT, userMessage, onDelta);
  const json = extractJson(text);

  let data: any;
  try {
    data = JSON.parse(json);
  } catch {
    if (truncated) throw new Error('AI 输出被截断（达到 max_tokens 上限）。请减少字段或换更大上下文的模型后重试。');
    throw new Error('AI 返回的字段列表不是有效 JSON，请重试或更换模型。');
  }
  const list = Array.isArray(data) ? data : data?.fields;
  if (!Array.isArray(list)) {
    throw new Error('未识别到任何表单字段。');
  }
  const fields = list
    .map((f: any): DetectedField => ({
      label: String(f?.label ?? '').trim(),
      type: String(f?.type ?? 'text').trim() || 'text',
      required: !!f?.required,
    }))
    .filter((f: DetectedField) => f.label.length > 0);

  const formName = String(data?.formName ?? '').trim() || '未命名表单';
  return { formName, fields };
}

/**
 * 阶段 2：根据快照、指令、(可选) Profile 与用户已确认的字段，生成填充指令 JSON。
 */
export async function callAI(
  config: AIConfig,
  snapshot: string,
  instruction: string,
  profileData?: Record<string, string>,
  fields?: DetectedField[],
  mode: CaptureMode = 'aria',
  onDelta?: StreamCallback
): Promise<string> {
  const profileSection = profileData && Object.keys(profileData).length > 0
    ? `\n\nProfile data to use for filling:\n${Object.entries(profileData).map(([k, v]) => `  ${k}: ${v}`).join('\n')}`
    : '';

  const fieldsSection = fields && fields.length > 0
    ? `\n\nThe user has CONFIRMED the following fields to fill, with the REQUIRED action method for each. ` +
      `The confirmed TYPE is authoritative: choose the method strictly from the type below — do NOT re-classify the element from the snapshot. ` +
      `Produce one action per field, in this order, and do NOT add fields that are not listed:\n${
        fields.map(f => `  - ${f.label} (${f.type})${f.required ? ' [required]' : ''} → ${methodHintForType(f.type)}`).join('\n')
      }`
    : '';

  const userMessage =
    `${payloadLabel(mode)}:\n\`\`\`\n${snapshot}\n\`\`\`\n\n` +
    `User instruction: ${instruction || '(none — generate realistic plausible data)'}` +
    fieldsSection + profileSection + modeHint(mode);

  const { text, truncated } = await dispatch(config, SYSTEM_PROMPT, userMessage, onDelta);
  const json = extractJson(text);

  // 校验：必须是非空 actions（修复"提示生成成功但内容为空/截断"的问题）
  let data: any;
  try {
    data = JSON.parse(json);
  } catch {
    if (truncated) {
      throw new Error('AI 输出被截断（达到 max_tokens 上限），JSON 不完整。请减少字段、缩短填充文本，或更换更大上下文的模型后重试。');
    }
    throw new Error('AI 生成的动作不是有效 JSON，请重试或更换模型。原始返回片段：' + text.slice(0, 200));
  }
  const actions = Array.isArray(data) ? data : data?.actions;
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new Error('AI 生成的动作为空（actions 为空），请重试或更换模型。');
  }
  // 归一化为标准 { actions: [...] } 字符串，保证 UI 拿到的一定是有效内容
  return JSON.stringify({ actions });
}

// ── 修复回路：只重写校验失败的动作 ───────────────────────────────────────────

const REPAIR_SYSTEM_PROMPT = `You are a web form automation assistant FIXING broken Playwright locators.
You are given a snapshot of the user-selected form container (elements may carry [ref=eN] markers) and a list of actions whose locator FAILED validation — each with the failure reason (matched 0 elements, or matched 2+ elements / strict-mode violation).
Rewrite ONLY these actions so each locator resolves to EXACTLY ONE element within the snapshot region.

STRICT RULES:
1. Output ONLY raw JSON — NO markdown, NO code fences, NO explanations.
2. Shape: { "repairs": [ { "index": <original action index>, "action": { ...full corrected Action... } } ] }
3. Action shape is the same as before: { "type", "target": {"by","value","role"?}, "ref"?, "raw"?, "value"?, "label"? }. Keep the original "type", "value" and "label" unless they are clearly wrong.
4. Disambiguation toolbox (in order of preference):
   a) set "ref" to the element's [ref=eN] marker AND give a corrected semantic target;
   b) unique attribute css, e.g. {"by":"css","value":"input[name='q1'][value='yes']"} or [id="..."];
   c) "raw" relative chain anchored on nearby unique text, e.g. "page.getByText('Question text').locator('..').getByRole('radio', { name: 'Yes' })";
   d) LAST resort: append .first()/.nth(n) inside a "raw" chain.
5. A locator that matched 0 elements usually means the strategy was wrong for this DOM (e.g. getByLabel without a real <label>, or a guessed css id) — switch strategy instead of tweaking the value.`;

/** 把校验失败的动作交给 AI 重写，返回 { index, action } 修复列表 */
export async function repairActions(
  config: AIConfig,
  snapshot: string,
  mode: CaptureMode,
  failures: Array<{ index: number; action: FillAction; problem: string }>,
  onDelta?: StreamCallback
): Promise<Array<{ index: number; action: FillAction }>> {
  const userMessage =
    `${payloadLabel(mode)}:\n\`\`\`\n${snapshot}\n\`\`\`\n\n` +
    `These actions FAILED locator validation. Fix each one:\n` +
    failures.map(f =>
      `- index ${f.index}: ${JSON.stringify(f.action)}\n  PROBLEM: ${f.problem}`
    ).join('\n') +
    modeHint(mode);

  const { text, truncated } = await dispatch(config, REPAIR_SYSTEM_PROMPT, userMessage, onDelta);
  const json = extractJson(text);
  let data: any;
  try { data = JSON.parse(json); } catch {
    if (truncated) throw new Error('AI 修复输出被截断，请重试。');
    throw new Error('AI 修复结果不是有效 JSON。');
  }
  const repairs = Array.isArray(data) ? data : data?.repairs;
  if (!Array.isArray(repairs)) throw new Error('AI 修复结果缺少 repairs 数组。');
  return repairs
    .filter((r: any) => typeof r?.index === 'number' && r?.action && typeof r.action === 'object')
    .map((r: any) => ({ index: r.index, action: r.action as FillAction }));
}

// ── Endpoint helpers ────────────────────────────────────────────────────────

const DEFAULT_BASE_URL: Record<AIConfig['provider'], string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  custom: '',
  'custom-anthropic': '',
};

/** 拼接 base url 与路径，自动处理结尾斜杠 */
function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '');
  const p = path.replace(/^\/+/, '');
  return `${b}/${p}`;
}

/** 取得有效 base url：优先用户自定义，否则用 provider 默认值 */
function resolveBaseUrl(config: AIConfig): string {
  const base = (config.baseUrl || '').trim() || DEFAULT_BASE_URL[config.provider];
  if (!base) {
    throw new Error('未配置 Base URL，请在设置中填写自定义 API 地址');
  }
  return base;
}

/** 从首个 { 或 [ 起做字符串感知的括号配平，返回第一个完整 JSON 的结束下标（不含）。截断则返回 -1 */
function matchBalanced(s: string): number {
  const open = s[0];
  const close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

function extractJson(text: string): string {
  let t = text.trim();
  // 1) 剥离任意位置的 ```json ... ``` 围栏（取第一个代码块内容）
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  // 2) 从首个 { 或 [ 开始，用括号配平截取第一个完整 JSON（忽略前后多余文字）
  const start = t.search(/[\[{]/);
  if (start < 0) return t;
  t = t.slice(start);
  const end = matchBalanced(t);
  return (end > 0 ? t.slice(0, end) : t).trim(); // 截断时返回部分内容（解析会失败 → 截断提示）
}

/** 读取 SSE 流，累计文本并通过 onDelta 实时回调；返回完整文本与截断标记 */
async function readSSE(res: Response, provider: 'openai' | 'anthropic', onDelta: StreamCallback): Promise<LLMResult> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let json: any;
      try { json = JSON.parse(data); } catch { continue; }
      if (provider === 'openai') {
        const choice = json?.choices?.[0];
        const delta = choice?.delta?.content ?? '';
        if (delta) { full += delta; onDelta(full); }
        if (choice?.finish_reason === 'length') truncated = true;
      } else {
        if (json?.type === 'content_block_delta') {
          const delta = json?.delta?.text ?? '';
          if (delta) { full += delta; onDelta(full); }
        } else if (json?.type === 'message_delta' && json?.delta?.stop_reason === 'max_tokens') {
          truncated = true;
        }
      }
    }
  }
  return { text: full, truncated };
}

async function callAnthropic(config: AIConfig, system: string, userMessage: string, onDelta?: StreamCallback): Promise<LLMResult> {
  const url = joinUrl(resolveBaseUrl(config), 'v1/messages');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.model || 'claude-sonnet-4-6',
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: 'user', content: userMessage }],
      ...(onDelta ? { stream: true } : {}),
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as any;
    throw new Error(`Anthropic API error ${res.status}: ${err?.error?.message ?? res.statusText}`);
  }

  if (onDelta && res.body) return readSSE(res, 'anthropic', onDelta);

  const data = await res.json() as any;
  return { text: (data.content?.[0]?.text ?? '') as string, truncated: data.stop_reason === 'max_tokens' };
}

async function callOpenAI(config: AIConfig, system: string, userMessage: string, onDelta?: StreamCallback): Promise<LLMResult> {
  const url = joinUrl(resolveBaseUrl(config), 'chat/completions');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model || 'gpt-4o',
      max_tokens: MAX_TOKENS,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userMessage },
      ],
      ...(onDelta ? { stream: true } : {}),
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as any;
    throw new Error(`API error ${res.status}: ${err?.error?.message ?? res.statusText}`);
  }

  if (onDelta && res.body) return readSSE(res, 'openai', onDelta);

  const data = await res.json() as any;
  const choice = data.choices?.[0];
  return { text: (choice?.message?.content ?? '') as string, truncated: choice?.finish_reason === 'length' };
}
