// Connect-time "re-packing" of gzip objects.
//
// DuckDB-Wasm reads a .gz object through HTTP range requests and its gzip reader loses rows, or
// fails with "Unsupported GZIP compression method" / "Input is not a GZIP stream", when the
// object consists of several concatenated gzip members (AWS log delivery produces such files).
// Before the view is created, every listed .gz object is fetched once here (in parallel, from
// the page, cancellable), re-compressed as a single member when it is multi-member, and stored
// complete in the range cache. DuckDB then reads the cached copy and never sees a member
// boundary. Single-member objects are stored as they are, so later queries are local too.
import { describeError } from './errors';
import { cacheComplete, cacheStore, cacheStats } from './cache';
import { expose } from './debug';
import NormalizeWorker from './worker/gz-normalize-worker?worker';

export interface NormalizeFile {
  /** URL as DuckDB requests it (cache key) */
  url: string;
  /** URL to fetch from the page (may differ in style) with the headers to send (SigV4) */
  fetchUrl: string;
  headers: Record<string, string>;
  etag: string;
  size: number;
  lastModified?: string;
}

export interface NormalizeResult {
  total: number;
  skipped: number;
  fetched: number;
  repacked: number;
  bytes: number;
  failed: { url: string; error: string }[];
}

interface WorkerReply {
  id: number;
  url: string;
  bytes?: ArrayBuffer;
  repacked?: boolean;
  origSize?: number;
  gzip?: boolean;
  inflateError?: string | null;
  members?: number;
  etag?: string;
  error?: string;
}

/** True when the cache worker will keep re-packed copies (cache on, storage available, option on). */
export async function normalizationAvailable(): Promise<{ ok: boolean; reason: string | null }> {
  try {
    const s = await cacheStats();
    if (!s.config.enabled) return { ok: false, reason: 'range cache disabled' };
    if (!s.config.normalizeGzip) return { ok: false, reason: 'gzip re-packing disabled' };
    if (s.opfsError) return { ok: false, reason: s.opfsError };
    if (s.readOnly) return { ok: false, reason: 'the cache is read-only in this tab (another tab holds it)' };
    return { ok: true, reason: null };
  } catch (e) {
    return { ok: false, reason: describeError(e) };
  }
}

expose({ normalizeGzipFiles });

export async function normalizeGzipFiles(
  files: NormalizeFile[],
  opts: { signal?: AbortSignal | null; onProgress?: (done: number, total: number, bytes: number) => void; concurrency?: number } = {},
): Promise<NormalizeResult> {
  const result: NormalizeResult = { total: files.length, skipped: 0, fetched: 0, repacked: 0, bytes: 0, failed: [] };
  if (!files.length) return result;
  const done = new Set((await cacheComplete(files.map((f) => ({ url: f.url, etag: f.etag })))).complete);
  const todo = files.filter((f) => !done.has(f.url));
  result.skipped = files.length - todo.length;
  if (!todo.length) return result;
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 4, todo.length));
  const workers = Array.from({ length: concurrency }, () => new NormalizeWorker());
  let next = 0;
  let finished = 0;
  const report = () => opts.onProgress?.(result.skipped + finished, files.length, result.bytes);
  /**
   * A terminated worker never calls onmessage or onerror again, so a job that was in flight would
   * leave its promise pending for good and the whole connect would never settle. Each worker's
   * reject is kept here and called right after the terminate.
   */
  const pending = new Set<(e: Error) => void>();
  const abort = () => {
    for (const w of workers) w.terminate();
    for (const reject of pending) reject(new DOMException('aborted', 'AbortError'));
    pending.clear();
  };
  opts.signal?.addEventListener('abort', abort, { once: true });
  try {
    await Promise.all(
      workers.map(
        (w) =>
          new Promise<void>((resolve, reject) => {
            pending.add(reject);
            const settle = (f: () => void) => {
              pending.delete(reject);
              f();
            };
            const pump = () => {
              if (opts.signal?.aborted) return settle(() => reject(new DOMException('aborted', 'AbortError')));
              if (next >= todo.length) return settle(resolve);
              const f = todo[next++];
              w.onmessage = async (ev: MessageEvent<WorkerReply>) => {
                const r = ev.data;
                if (r.error || !r.bytes) {
                  result.failed.push({ url: f.url, error: r.error ?? 'no data' });
                } else {
                  try {
                    const note = !r.gzip ? 'not-gzip' : r.inflateError ? `inflate-error:${r.inflateError.slice(0, 60)}` : r.members !== undefined ? `members:${r.members}` : undefined;
                    // the buffer is transferred to the cache worker (detached afterwards): read its size first
                    const origSize = r.origSize ?? r.bytes.byteLength;
                    await cacheStore({ url: f.url, etag: f.etag || r.etag || '', lastModified: f.lastModified, bytes: r.bytes, repacked: !!r.repacked, origSize, note });
                    result.fetched++;
                    result.bytes += origSize;
                    if (r.repacked) result.repacked++;
                  } catch (e) {
                    result.failed.push({ url: f.url, error: `cache store failed: ${describeError(e)}` });
                  }
                }
                finished++;
                report();
                pump();
              };
              w.onerror = (e) => {
                result.failed.push({ url: f.url, error: e.message || 'worker error' });
                finished++;
                report();
                pump();
              };
              w.postMessage({ id: next, url: f.url, fetchUrl: f.fetchUrl, headers: f.headers });
            };
            pump();
          }),
      ),
    );
  } finally {
    opts.signal?.removeEventListener('abort', abort);
    abort();
  }
  return result;
}
