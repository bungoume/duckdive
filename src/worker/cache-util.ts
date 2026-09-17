// Pure helpers of the range cache worker: cache keys, checksums, HTTP header and Range parsing.
// No worker globals here, so the unit tests cover them (test/cache-util.test.ts).

export type HeaderMap = Record<string, string>;

/** What the worker's synchronous requests return and what it synthesizes for DuckDB. */
export interface NativeResult {
  status: number;
  statusText: string;
  headers: HeaderMap;
  rawHeaders: string;
  body: ArrayBuffer | null;
}

/** FNV-1a 32-bit checksum of a chunk (never 0, which marks "unknown" in old index entries). */
export function checksum(buf: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < buf.length; i++) h = Math.imul(h ^ buf[i], 0x01000193) >>> 0;
  return h || 1;
}

/**
 * The cache key of a URL: the URL without its fragment and without the query parameters that
 * carry a signature (AWS SigV4 / V2 presigning, Google Cloud Storage, Azure SAS), so that a
 * re-signed URL for the same object hits the same entry.
 */
export function cacheKey(url: string): string {
  const u = new URL(url);
  for (const k of [...u.searchParams.keys()]) {
    if (/^(x-amz-|awsaccesskeyid$|signature$|expires$|x-goog-|sig$|se$|sv$|sp$|sr$|st$|skoid$|sktid$|skt$|ske$|sks$|skv$)/i.test(k)) u.searchParams.delete(k);
  }
  u.hash = '';
  return u.toString();
}

/** OPFS file name for a cached DuckDB extension (FNV-1a, two 32-bit lanes). */
export function hashName(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x811c9dc5) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/** An http(s) URL on another origin: data DuckDB reads remotely, as opposed to the app's own files. */
export function isDataUrl(url: string, ownOrigin: string): boolean {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) && u.origin !== ownOrigin;
  } catch {
    return false;
  }
}

export function isExtensionUrl(url: string): boolean {
  try {
    return /\.duckdb_extension\.wasm$/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export function looksGzip(url: string): boolean {
  try {
    return /\.gz$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** XHR's getAllResponseHeaders() text → lower-cased name → value. */
export function parseHeaders(raw: string): HeaderMap {
  const out: HeaderMap = {};
  for (const line of raw.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

/** The inverse of parseHeaders, in the form getAllResponseHeaders() returns. */
export function rawHeaders(h: HeaderMap): string {
  return (
    Object.entries(h)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n') + '\r\n'
  );
}

/** Total object size from a response: the Content-Range total when present, else Content-Length. */
export function totalSizeFrom(res: NativeResult): number {
  const cr = res.headers['content-range'];
  if (cr) {
    const m = /\/(\d+)$/.exec(cr);
    if (m) return Number(m[1]);
  }
  return Number(res.headers['content-length']);
}

export function etagFrom(res: NativeResult): string {
  return res.headers['etag'] || res.headers['last-modified'] || '';
}

/** A Range request header resolved against the object size; null when it cannot be satisfied. */
export function parseRange(h: string, size: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start: number;
  let end: number;
  if (m[1] === '') {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return { start, end };
}

/** Hex of the first `n` bytes (a .gz must start with 1f8b08). */
export function hexHead(body: ArrayBuffer | null | undefined, n = 8): string | undefined {
  if (!body) return undefined;
  const b = new Uint8Array(body, 0, Math.min(n, body.byteLength));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * Which files to drop so the cached data fits a limit: the least recently used first, until
 * `liveBytes` minus their bytes is at or below `target` (kept a little under the limit, so a
 * stream of writes does not evict on every chunk). `usedAt` falls back to `seenAt` for entries
 * written by older builds.
 */
export function evictionPlan<T extends { seenAt: number; usedAt?: number; bytes: number }>(entries: T[], liveBytes: number, target: number): T[] {
  const out: T[] = [];
  let live = liveBytes;
  if (live <= target) return out;
  for (const e of [...entries].sort((a, b) => (a.usedAt ?? a.seenAt) - (b.usedAt ?? b.seenAt))) {
    if (live <= target) break;
    if (!e.bytes) continue;
    out.push(e);
    live -= e.bytes;
  }
  return out;
}
