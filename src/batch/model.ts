export type TaskStatus = 'READY' | 'RUNNING' | 'SUCCESS' | 'PENDING_MODERATION' | 'FORM_NOT_FOUND' | 'SUBMIT_FAILED' | 'LOAD_FAILED' | 'AI_FAILED' | 'CONTENT_GENERATION_FAILED';
export type BatchState = 'IDLE' | 'RUNNING' | 'PAUSING' | 'PAUSED' | 'STOPPING' | 'STOPPED' | 'COMPLETED';
export type ContentSource = 'CSV' | 'AI';
export type GenerationStatus = 'SUCCESS' | 'FAILED';
export type Identity = { name: string; email: string; website: string };
export type FieldKey = 'content' | keyof Identity;
export type FieldLocator = { locator: string; required: boolean };
export type EntryStrategy = 'DIRECT_FORM' | 'REPLY_TRIGGER_LOCAL' | 'REPLY_TRIGGER_AI';
export type Detection = { found: false } | {
  found: true; formType: string; confidence: number;
  fields: { content: FieldLocator } & Partial<Record<keyof Identity, FieldLocator>>;
  submit: { locator: string };
};
export type ReplyTriggerDetection = { found: true; strategy: 'reply_trigger'; replyLocator: string; confidence: number };
export type EntryDetection = Detection | ReplyTriggerDetection;
export interface Evidence {
  url: string;
  comments: string[];
  moderation: string[];
  success: string[];
  errors: string[];
}
export interface BatchTask {
  id: string; url: string; content: string; status: TaskStatus;
  contentSource?: ContentSource;
  generationStatus?: GenerationStatus;
  generatedContent?: string;
  startedAt?: number; completedAt?: number;
  screenshotFilename?: string;
  detectedFormType?: string; detectionMethod?: 'local' | 'ai';
  entryStrategy?: EntryStrategy;
  finalUrl?: string; error?: string;
  phase?: 'loading' | 'extracting' | 'generating' | 'detecting' | 'filling' | 'submitting' | 'observing' | 'screenshot' | 'done';
  baseline?: Evidence;
}
export interface BatchRun {
  id: string; folder: string; workerTabId?: number; windowId?: number;
  commentGenerationPrompt?: string;
  resultsFilename?: string; exportPending?: boolean; error?: string;
}
export interface BatchData {
  batchTasks: BatchTask[]; batchState: BatchState; currentTaskIndex: number;
  batchRun?: BatchRun; rememberIdentity?: boolean;
}
export const EMPTY_BATCH: BatchData = { batchTasks: [], batchState: 'IDLE', currentTaskIndex: 0 };
export const EMPTY_IDENTITY: Identity = { name: '', email: '', website: '' };
export const isBusy = (s: BatchState) => ['RUNNING', 'PAUSING', 'STOPPING'].includes(s);
export const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

export function validateUrl(value: string): string {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an http(s) URL without embedded credentials.');
  return url.href;
}

/** RFC 4180: quoted newlines, escaped quotes, BOM and CRLF. No silent row loss. */
export function parseCSV(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], field = '', quoted = false, closed = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else field += c;
    } else if (c === ',') { row.push(field); field = ''; closed = false; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = ''; closed = false;
    } else if (c === '"' && !field && !closed) quoted = true;
    else if (closed || c === '"') throw new Error('Invalid CSV quoting. Quote the entire content cell.');
    else field += c;
  }
  if (quoted) throw new Error('Unclosed CSV quote.');
  if (row.length || field || closed) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(s => s.trim()));
}
export function parseTasks(text: string, format: 'csv' | 'tsv'): BatchTask[] {
  let rows: string[][];
  if (format === 'csv') {
    rows = parseCSV(text);
    const header = rows.shift()?.map(s => s.trim().toLowerCase());
    if (header?.length !== 2 || header[0] !== 'url' || header[1] !== 'content') throw new Error('CSV header must be: url,content');
  } else rows = text.split(/\r?\n/).filter(s => s.trim()).map(line => {
    const tab = line.indexOf('\t');
    return tab < 0 ? [line] : [line.slice(0, tab), line.slice(tab + 1)];
  });
  if (!rows.length) throw new Error('Add at least one task.');
  return rows.map((r, i) => {
    if (r.length !== 2 || !r[1].trim()) throw new Error(`Row ${i + 1}: provide URL and non-empty Content.`);
    let url: string;
    try { url = validateUrl(r[0]); } catch { throw new Error(`Row ${i + 1}: invalid http(s) URL.`); }
    return { id: crypto.randomUUID(), url, content: r[1].replace(/\r\n/g, '\n'), status: 'READY' };
  });
}
export function defaultFolder(): string {
  const now = new Date();
  return `backlink-results/${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
export function validateFolder(value: string): string {
  const folder = value.trim().replace(/\/+$/, '');
  if (!folder || folder.startsWith('/') || /[\\:*?"<>|\x00-\x1f]/.test(folder) || folder.split('/').some(p => !p || /^\.+$/.test(p) || /[. ]$/.test(p))) {
    throw new Error('Use a relative Downloads folder, such as backlink-results/2026-10-02 (no .. or absolute paths).');
  }
  return folder;
}
export function screenshotName(task: BatchTask, index: number): string {
  const label = task.status === 'SUCCESS' ? 'success' : task.status === 'PENDING_MODERATION' ? 'pending' : 'failed';
  return `${String(index + 1).padStart(3, '0')}-${new URL(task.url).hostname.replace(/[^a-z0-9.-]/gi, '_')}-${label}.png`;
}
export function resultsCSV(tasks: BatchTask[]): string {
  const escape = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const date = (v?: number) => v ? new Date(v).toISOString() : '';
  return '\uFEFF' + [
    ['index', 'url', 'content', 'content_source', 'generation_status', 'generated_content', 'status', 'detection_method', 'entry_strategy', 'form_type', 'started_at', 'completed_at', 'final_url', 'screenshot_filename', 'error'],
    ...tasks.map((t, i) => [i + 1, t.url, t.content, t.contentSource || 'CSV', t.generationStatus, t.generatedContent, t.status, t.detectionMethod, t.entryStrategy, t.detectedFormType, date(t.startedAt), date(t.completedAt), t.finalUrl, t.screenshotFilename, t.error]),
  ].map(row => row.map(escape).join(',')).join('\r\n') + '\r\n';
}
/** Treat AI output as untrusted data, never as executable code. */
export function validateDetection(value: unknown): EntryDetection {
  const d = value as any;
  if (d?.found === false) return { found: false };
  if (d?.found === true && d.strategy === 'reply_trigger') {
    if (typeof d.replyLocator !== 'string' || !d.replyLocator.trim() || d.replyLocator.length > 1500 || /^\s*(page\.|javascript:)/.test(d.replyLocator) || typeof d.confidence !== 'number' || !Number.isFinite(d.confidence) || d.confidence < 0.8 || d.confidence > 1) throw new Error('AI returned an invalid or low-confidence reply trigger.');
    return { found: true, strategy: 'reply_trigger', replyLocator: d.replyLocator, confidence: d.confidence };
  }
  if (d?.found !== true || typeof d.formType !== 'string' || !['comment', 'reply', 'submission', 'wordpress_comment'].includes(d.formType) || typeof d.confidence !== 'number' || !Number.isFinite(d.confidence) || d.confidence < 0.8 || d.confidence > 1) throw new Error('AI returned an invalid or low-confidence form mapping.');
  const locator = (f: any): FieldLocator => {
    if (typeof f?.locator !== 'string' || !f.locator.trim() || f.locator.length > 1500 || /^\s*(page\.|javascript:)/.test(f.locator) || typeof f.required !== 'boolean') throw new Error('AI returned an invalid field locator.');
    return { locator: f.locator, required: f.required };
  };
  const fields: Extract<Detection, {found: true}>['fields'] = { content: locator(d.fields?.content) };
  for (const key of ['name', 'email', 'website'] as const) if (d.fields?.[key] != null) fields[key] = locator(d.fields[key]);
  const submit = locator({ locator: d.submit?.locator, required: true });
  return { found: true, formType: d.formType, confidence: d.confidence, fields, submit: { locator: submit.locator } };
}
