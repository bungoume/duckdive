// Downloads of query results. DuckDB writes the file into its in-memory file system with
// COPY, the bytes are copied out of the worker and handed to the browser as a download.

import { getDB, query } from './duck';
import { lit } from './sql';

export type ExportFormat = 'csv' | 'jsonl' | 'parquet';

export const EXPORT_FORMATS: ExportFormat[] = ['csv', 'jsonl', 'parquet'];

const COPY_OPTIONS: Record<ExportFormat, string> = { csv: 'FORMAT CSV, HEADER true', jsonl: 'FORMAT JSON', parquet: 'FORMAT PARQUET' };
const MIME: Record<ExportFormat, string> = { csv: 'text/csv', jsonl: 'application/x-ndjson', parquet: 'application/vnd.apache.parquet' };

/** Run `sql` and return its rows as a file of the given format. */
export async function exportToBlob(sql: string, format: ExportFormat): Promise<Blob> {
  const db = getDB();
  const name = `ddv-export-${Date.now()}.${format}`;
  try {
    await query(`COPY (${sql}) TO ${lit(name)} (${COPY_OPTIONS[format]})`);
    const bytes = await db.copyFileToBuffer(name);
    // a copy: the worker's buffer may be a view into shared memory, which Blob does not accept
    return new Blob([new Uint8Array(bytes).buffer as ArrayBuffer], { type: MIME[format] });
  } finally {
    await db.dropFile(name).catch(() => undefined);
  }
}

/** File name for a download made now: duckdive-20260917T031530.csv */
export function exportFileName(format: ExportFormat, now = new Date()): string {
  return `duckdive-${now.toISOString().replace(/[-:]/g, '').slice(0, 15)}.${format}`;
}

export function downloadBlob(blob: Blob, filename: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
