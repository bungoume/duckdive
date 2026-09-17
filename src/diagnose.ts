// Locates the file(s) DuckDB cannot read (e.g. "Unsupported GZIP compression method") by bisecting
// the attached file list with count(*) queries, then inspects the raw bytes of each culprit through
// the same read path (read_blob → httpfs → range cache) so the report shows what DuckDB actually saw.
import { cacheStats, type CacheLogEntry } from './cache';
import { expose } from './debug';
import { t } from './i18n';
import { viewSelect } from './datasource';
import { query } from './duck';
import { describeError } from './errors';
import { CancelledError } from './net';
import { resolveFormat, type FormatId } from './formats';
import { inflateGzipMembers } from './gzmembers';
import { lit } from './sql';
import { toHex } from './util';

export interface DiagnoseContext {
  files: string[];
  fileSizes: (number | null)[];
  format: FormatId;
}

let ctx: DiagnoseContext | null = null;
export function setDiagnoseContext(c: DiagnoseContext | null) {
  ctx = c;
}
export function canDiagnose(): boolean {
  return !!ctx && ctx.files.length > 0;
}

/** Error messages that point at damaged / unexpected file bytes rather than at the query. */
export const FILE_ERROR = /gzip|zstd|magic|corrupt|Parquet file|invalid|not a valid|sniff/i;

/** Such errors get a pointer to the diagnosis button and the cache controls. */
export function withCacheHint(msg: string): string {
  return FILE_ERROR.test(msg) ? t('disc.cacheHint', { error: msg, button: t('diag.find'), clear: t('cache.clear'), enable: t('cache.enable') }) : msg;
}

export interface FileReport {
  file: string;
  /** size from the S3 listing (what HEAD answers are synthesized from) */
  listedSize: number | null;
  /** size DuckDB read via read_blob */
  readSize: number | null;
  /** hex of the first 10 bytes */
  head: string | null;
  gzip: null | {
    magicOk: boolean;
    method: number;
    flags: number;
    /** ISIZE from the trailer: uncompressed size (mod 2^32) of the last member */
    isize: number;
    /** bytes produced by the browser's DecompressionStream, or null when it threw */
    inflated: number | null;
    inflateError: string | null;
    /** number of "1f 8b 08" sequences found (1 = single member; >1 hints at concatenated members) */
    headerSignatures: number;
    /** gzip members found by walking the file (0 when it cannot be walked; see membersError) */
    members: number;
    membersError: string | null;
    verdict: string;
  };
  /** DuckDB's error when the file is read alone */
  error: string;
}

export interface DiagnoseReport {
  startedAt: string;
  totalFiles: number;
  queries: number;
  /** true when the whole file set read fine with count(*) (the failure may be query-specific or transient) */
  allReadable: boolean;
  failing: FileReport[];
  truncated: boolean;
  requestLog: CacheLogEntry[];
}

const MAX_INSPECT_BYTES = 32 * 1024 * 1024;

function fromHex(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

async function inflateGzip(buf: Uint8Array): Promise<{ inflated: number | null; error: string | null }> {
  try {
    const ds = new DecompressionStream('gzip');
    const stream = new Blob([buf as BlobPart]).stream().pipeThrough(ds);
    const reader = stream.getReader();
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
    }
    return { inflated: n, error: null };
  } catch (e) {
    return { inflated: null, error: describeError(e) };
  }
}

export async function inspectGzip(buf: Uint8Array): Promise<NonNullable<FileReport['gzip']>> {
  const magicOk = buf.length >= 10 && buf[0] === 0x1f && buf[1] === 0x8b;
  const method = buf.length > 2 ? buf[2] : -1;
  const flags = buf.length > 3 ? buf[3] : -1;
  const isize = buf.length >= 8 ? (buf[buf.length - 4] | (buf[buf.length - 3] << 8) | (buf[buf.length - 2] << 16) | (buf[buf.length - 1] << 24)) >>> 0 : 0;
  let headerSignatures = 0;
  for (let i = 0; i + 2 < buf.length; i++) if (buf[i] === 0x1f && buf[i + 1] === 0x8b && buf[i + 2] === 0x08) headerSignatures++;
  const { inflated, error } = await inflateGzip(buf);
  let members = 0;
  let membersError: string | null = null;
  if (magicOk && method === 8) {
    try {
      members = inflateGzipMembers(buf).members;
    } catch (e) {
      membersError = describeError(e);
    }
  }
  let verdict: string;
  if (buf.length === 0) verdict = 'empty object (0 bytes): not a gzip stream';
  else if (!magicOk) verdict = 'does not start with the gzip magic (1f 8b): the bytes DuckDB received are not this .gz file, or the object is not gzip';
  else if (method !== 8) verdict = `gzip header says compression method ${method} (only 8 = deflate is valid): header is damaged or the object is not a standard gzip`;
  else if (members > 1)
    verdict = `concatenated (multi-member) gzip with ${members} members. DuckDB-Wasm mis-reads member boundaries over HTTP (rows go missing or the header check fails mid-file); enable "Re-pack concatenated gzip files at connect" under Data source → Local range cache and reconnect`;
  else if (membersError) verdict = `damaged gzip: ${membersError}`;
  else if (error) verdict = `single member, but the browser cannot inflate it: ${error}`;
  else if (inflated !== null && inflated !== isize) verdict = `inflates to ${inflated} bytes but the trailer says ${isize}`;
  else verdict = 'looks like a normal single-member gzip; DuckDB fails on it anyway (see its message)';
  return { magicOk, method, flags, isize, inflated, inflateError: error, headerSignatures, members, membersError, verdict };
}

/** Message of DuckDB's error when `files` are read as a whole, or null when they read fine. */
async function readError(format: FormatId, files: string[]): Promise<string | null> {
  const fmt = resolveFormat(format, files);
  try {
    await query(`SELECT count(*) AS n FROM (${viewSelect(fmt, files, null, true)})`);
    return null;
  } catch (e) {
    if (e instanceof CancelledError) throw e;
    return describeError(e);
  }
}

async function inspectFile(file: string, listedSize: number | null, error: string): Promise<FileReport> {
  const rep: FileReport = { file, listedSize, readSize: null, head: null, gzip: null, error };
  try {
    const sizeRes = await query(`SELECT size FROM read_blob(${lit(file)})`);
    const size = Number(sizeRes.rows[0]?.size ?? 0);
    rep.readSize = size;
    if (size > MAX_INSPECT_BYTES) {
      const r = await query(`SELECT hex(content[1:10]) AS h FROM read_blob(${lit(file)})`);
      rep.head = String(r.rows[0]?.h ?? '').toLowerCase() || null;
      return rep;
    }
    const r = await query(`SELECT hex(content) AS h FROM read_blob(${lit(file)})`);
    const buf = fromHex(String(r.rows[0]?.h ?? ''));
    rep.head = toHex(buf.subarray(0, 10));
    if (/\.gz$/i.test(file) || (buf[0] === 0x1f && buf[1] === 0x8b)) rep.gzip = await inspectGzip(buf);
  } catch (e) {
    if (e instanceof CancelledError) throw e;
    rep.error += `\n(inspection failed: ${describeError(e)})`;
  }
  return rep;
}

/**
 * Bisect the attached files until the failing ones are isolated (at most `maxFailing`), then
 * inspect their bytes. Every step re-reads the subset in full, so expect roughly 2× a full scan
 * per failing file.
 */
export async function diagnoseFiles(onProgress: (msg: string) => void, maxFailing = 3): Promise<DiagnoseReport> {
  if (!ctx) throw new Error(t('diag.noSource'));
  const { files, fileSizes, format } = ctx;
  const report: DiagnoseReport = { startedAt: new Date().toISOString(), totalFiles: files.length, queries: 0, allReadable: false, failing: [], truncated: false, requestLog: [] };
  const found: { file: string; error: string }[] = [];
  const search = async (idx: number[]): Promise<void> => {
    if (found.length >= maxFailing) {
      report.truncated = true;
      return;
    }
    report.queries++;
    onProgress(t('diag.progress.reading', { n: idx.length, query: report.queries, found: found.length }));
    const err = await readError(
      format,
      idx.map((i) => files[i]),
    );
    if (!err) return;
    if (idx.length === 1) {
      found.push({ file: files[idx[0]], error: err });
      return;
    }
    const mid = Math.ceil(idx.length / 2);
    await search(idx.slice(0, mid));
    await search(idx.slice(mid));
  };
  await search(files.map((_, i) => i));
  report.allReadable = found.length === 0 && report.queries === 1;
  for (const f of found) {
    onProgress(t('diag.progress.inspecting', { file: f.file }));
    report.failing.push(await inspectFile(f.file, fileSizes[files.indexOf(f.file)] ?? null, f.error));
  }
  try {
    const names = report.failing.map((f) => f.file.split('/').pop() ?? '');
    report.requestLog = (await cacheStats()).stats.log.filter((l) => names.some((n) => n && l.url.includes(n)) || /net:|corrupt|short-body|passthrough:|handler-error|range-ignored/.test(l.outcome));
  } catch {
    /* worker unavailable */
  }
  return report;
}

expose({ diagnoseFiles, inspectGzip });
