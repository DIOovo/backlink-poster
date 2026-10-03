import { readSheet } from 'read-excel-file/browser';
import type { BatchTask } from './model';

export interface InvalidExcelUrl { row: number; value: string }
export interface ExcelImportResult {
  total: number;
  valid: number;
  duplicate: number;
  invalid: number;
  invalidRows: InvalidExcelUrl[];
  tasks: BatchTask[];
}

const isHttpUrl = (value: string) => {
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !!url.hostname;
  } catch { return false; }
};

/** Parse first-column values without canonicalizing them for duplicate comparison. */
export function parseExcelUrlRows(rows: unknown[][]): ExcelImportResult {
  const first = rows[0]?.[0] == null ? '' : String(rows[0][0]).trim();
  const hasHeader = first.toLowerCase() === 'url';
  const seen = new Set<string>();
  const tasks: BatchTask[] = [];
  const invalidRows: InvalidExcelUrl[] = [];
  let total = 0;
  let duplicate = 0;

  rows.forEach((row, index) => {
    if (hasHeader && index === 0) return;
    const value = row?.[0] == null ? '' : String(row[0]).trim();
    if (!value) return;
    total++;
    if (!isHttpUrl(value)) { invalidRows.push({ row: index + 1, value }); return; }
    if (seen.has(value)) { duplicate++; return; }
    seen.add(value);
    tasks.push({ id: crypto.randomUUID(), url: value, content: '', contentSource: 'AI', status: 'READY' });
  });

  return { total, valid: tasks.length, duplicate, invalid: invalidRows.length, invalidRows, tasks };
}

export async function parseExcelFile(file: Blob): Promise<ExcelImportResult> {
  const rows = await readSheet(file);
  return parseExcelUrlRows(rows as unknown[][]);
}
