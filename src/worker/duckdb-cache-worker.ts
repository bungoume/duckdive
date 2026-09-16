/*
 * DuckDB worker with a local range cache.
 *
 * duckdb-wasm reads remote files through synchronous XMLHttpRequest calls made
 * inside its worker. This classic worker installs a replacement XMLHttpRequest
 * that keeps every file in fixed-size chunks inside OPFS (the browser's origin
 * private file system, accessed here with synchronous access handles) and only
 * downloads chunks that were never read. It then loads the stock duckdb-wasm
 * worker bundle with importScripts(), so DuckDB itself is unmodified.
 *
 * The page talks to the cache through a BroadcastChannel ('ddv-cache'):
 * stats / files / config / clear / purge.
 */

declare function importScripts(...urls: string[]): void;

// OPFS synchronous access handles are only typed in lib.webworker; declare what we use.
interface FileSystemSyncAccessHandle {
  read(buffer: ArrayBufferView, options?: { at?: number }): number;
  write(buffer: ArrayBufferView, options?: { at?: number }): number;
  truncate(size: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}
interface FileSystemFileHandle {
  createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>;
}

type HeaderMap = Record<string, string>;

interface FileMeta {
  key: string;
  name: string; // OPFS file name
  size: number;
  etag: string;
  chunkSize: number;
  seenAt: number;
  lastModified?: string;
  /**
   * Set when the cached bytes are a re-packed copy of the object rather than the object itself
   * (a concatenated gzip re-compressed as a single member, see src/gznorm.ts): `size` is the
   * re-packed size, `etag` the origin's. Such an entry must be complete; it can never be
   * partially refetched from the origin because the offsets do not correspond.
   */
  norm?: { origSize: number };
}

/**
 * HEAD requests are answered locally while the file's metadata is this fresh. Metadata comes
 * from the page's ListObjectsV2 results (seeded before the view is created) or from a real
 * HEAD; duckdb-wasm issues one HEAD per file every time the view is bound, so without this a
 * 10,000-file source costs 10,000 sequential requests per query.
 */
const HEAD_FRESH_MS = 15 * 60_000;

interface ChunkRef {
  off: number;
  len: number;
  /** FNV-1a 32-bit checksum of the bytes (0 = unknown, for entries written by older builds) */
  sum: number;
}

function checksum(buf: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < buf.length; i++) h = Math.imul(h ^ buf[i], 0x01000193) >>> 0;
  return h || 1;
}

/**
 * Storage layout: all chunks of all files live in ONE OPFS file ("slab.bin", append-only) and
 * index.json maps (file, chunk) → offset. One open handle regardless of how many files are
 * cached, so a source of 10,000+ files costs nothing but a few index entries. Overwritten or
 * purged chunks leave holes that are reclaimed by compaction (at start-up, when the waste is
 * large).
 */
interface CacheEntry extends FileMeta {
  chunks: Map<number, ChunkRef>;
  stat: { hits: number; misses: number; bytesFromCache: number; bytesFromNetwork: number; bytesDownloaded: number };
}

interface Index {
  version: number;
  slabSize: number;
  wasted: number;
  files: Record<string, FileMeta & { chunks: [number, number, number, number?][] }>;
  ext: Record<string, { name: string; size: number }>;
  config: { enabled: boolean; chunkSize: number; normalizeGzip?: boolean };
}

const INDEX_VERSION = 2;
let slab: FileSystemSyncAccessHandle | null = null;
let slabSize = 0;
let wasted = 0;
const COMPACT_MIN_WASTE = 64 * 1024 * 1024;
const DIR = 'ddv-cache';
const NativeXHR = self.XMLHttpRequest;

const config = { enabled: true, chunkSize: 1024 * 1024, normalizeGzip: true };
/** One line of the request log (last LOG_SIZE requests seen by the worker); shown on the Data source page. */
interface LogEntry {
  t: number;
  method: string;
  url: string;
  range: string | null;
  outcome: string;
  /** HTTP status the caller (DuckDB) received */
  status?: number;
  /** body bytes handed to the caller */
  bytes?: number;
  /** Content-Encoding of a network answer: if set, the browser already inflated the body */
  enc?: string;
  /** hex of the first bytes when the answer starts at offset 0 (a .gz must start with 1f8b08) */
  head?: string;
}
const LOG_SIZE = 300;
const stats = { requests: 0, passthrough: 0, chunkHits: 0, chunkMisses: 0, bytesFromCache: 0, bytesFromNetwork: 0, bytesDownloaded: 0, headsSynthesized: 0, headsNetwork: 0, corruptions: 0, log: [] as LogEntry[] };
const files = new Map<string, CacheEntry>();
interface ExtEntry {
  name: string;
  size: number;
  handle: FileSystemSyncAccessHandle | null;
  opening: Promise<void> | null;
}
const extFiles = new Map<string, ExtEntry>();
let root: FileSystemDirectoryHandle | null = null;
let dir: FileSystemDirectoryHandle | null = null;
let opfsError: string | null = null;
let indexSaveTimer: ReturnType<typeof setTimeout> | null = null;

function log(entry: Omit<LogEntry, 't'>): LogEntry {
  const e: LogEntry = { t: Date.now(), ...entry };
  stats.log.push(e);
  if (stats.log.length > LOG_SIZE) stats.log.shift();
  return e;
}

function hexHead(body: ArrayBuffer | null | undefined, n = 8): string | undefined {
  if (!body) return undefined;
  const b = new Uint8Array(body, 0, Math.min(n, body.byteLength));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** Describe a network answer in the log (header chunk, odd status or transfer encoding only: 206 chunk bodies are routine). */
function logNet(url: string, range: string, res: NativeResult, offset: number) {
  const enc = res.headers['content-encoding'];
  if (res.status === 206 && !enc && offset !== 0) return;
  log({ method: 'GET', url, range, outcome: `net:${res.status}`, status: res.status, bytes: res.body?.byteLength, enc: enc || undefined, head: offset === 0 ? hexHead(res.body) : undefined });
}

// ---------- key / name helpers ----------

function cacheKey(url: string): string {
  const u = new URL(url);
  for (const k of [...u.searchParams.keys()]) {
    if (/^(x-amz-|awsaccesskeyid$|signature$|expires$|x-goog-|sig$|se$|sv$|sp$|sr$|st$|skoid$|sktid$|skt$|ske$|sks$|skv$)/i.test(k)) u.searchParams.delete(k);
  }
  u.hash = '';
  return u.toString();
}

function hashName(s: string): string {
  // FNV-1a 64-bit-ish (two 32-bit lanes) – good enough for file names
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x811c9dc5) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

function isDataUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return false;
    if (u.origin === self.location.origin) return false;
    return true;
  } catch {
    return false;
  }
}

function isExtensionUrl(url: string): boolean {
  try {
    return /\.duckdb_extension\.wasm$/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

// ---------- OPFS ----------

async function initOpfs() {
  try {
    // OPFS sync access handles are exclusive, so only one DuckDB worker (tab) can own the
    // cache at a time. Hold a Web Lock for the worker's lifetime; other tabs run uncached.
    // Wait a few seconds for the lock: after a reload the previous worker's lock is released
    // only when its context is torn down, and that may happen slightly after we start.
    const locked = await new Promise<boolean>((resolve) => {
      navigator.locks
        .request('ddv-cache-owner', { signal: AbortSignal.timeout(5000) }, (lock) => {
          resolve(!!lock);
          return lock ? new Promise<void>(() => undefined) : undefined; // never released while alive
        })
        .catch(() => resolve(false));
    });
    if (!locked) {
      opfsError = 'The range cache is in use by another Duckdive tab; this tab reads from the origin directly.';
      console.warn('[ddv-cache]', opfsError);
      return;
    }
    root = await navigator.storage.getDirectory();
    dir = await root.getDirectoryHandle(DIR, { create: true });
    // layout v1 kept one OPFS file per cached file; drop it
    await dir.removeEntry('files', { recursive: true }).catch(() => undefined);
    let index: Index | null = null;
    try {
      const fh = await dir.getFileHandle('index.json');
      index = JSON.parse(await (await fh.getFile()).text());
    } catch {
      index = null;
    }
    slab = await (await dir.getFileHandle('slab.bin', { create: true })).createSyncAccessHandle();
    const actual = slab.getSize();
    if (index && index.version === INDEX_VERSION) {
      config.enabled = index.config?.enabled ?? true;
      config.chunkSize = index.config?.chunkSize ?? config.chunkSize;
      config.normalizeGzip = index.config?.normalizeGzip ?? true;
      slabSize = Math.min(index.slabSize ?? 0, actual);
      wasted = index.wasted ?? 0;
      for (const meta of Object.values(index.files)) {
        const entry = newEntry(meta);
        for (const [i, off, len, sum] of meta.chunks ?? []) if (off + len <= slabSize) entry.chunks.set(i, { off, len, sum: sum ?? 0 });
        if (entry.chunks.size) files.set(meta.key, entry);
      }
      for (const [url, e] of Object.entries(index.ext ?? {})) {
        const rec: ExtEntry = { name: e.name, size: e.size, handle: null, opening: null };
        extFiles.set(url, rec);
        void openExt(rec);
      }
    } else {
      slab.truncate(0);
      slabSize = 0;
      wasted = 0;
    }
    if (wasted > COMPACT_MIN_WASTE && wasted > slabSize / 2) await compact();
  } catch (e) {
    opfsError = `OPFS unavailable: ${String(e)}`;
    console.warn('[ddv-cache]', opfsError);
  }
}

function newEntry(meta: FileMeta): CacheEntry {
  return { ...meta, chunks: new Map(), stat: { hits: 0, misses: 0, bytesFromCache: 0, bytesFromNetwork: 0, bytesDownloaded: 0 } };
}

async function openExt(rec: ExtEntry): Promise<void> {
  if (!dir || rec.handle) return;
  if (rec.opening) return rec.opening;
  rec.opening = (async () => {
    try {
      const extDir = await dir!.getDirectoryHandle('ext', { create: true });
      const fh = await extDir.getFileHandle(rec.name, { create: true });
      rec.handle = await fh.createSyncAccessHandle();
    } catch (e) {
      console.warn('[ddv-cache] failed to open extension cache', e);
    } finally {
      rec.opening = null;
    }
  })();
  return rec.opening;
}

function scheduleSaveIndex() {
  if (!dir) return;
  if (indexSaveTimer) clearTimeout(indexSaveTimer);
  indexSaveTimer = setTimeout(saveIndex, 300);
}

/** Persist the chunk map (only files that actually hold data; seeded metadata is transient). */
async function saveIndex() {
  if (!dir) return;
  const index: Index = { version: INDEX_VERSION, slabSize, wasted, files: {}, ext: {}, config: { ...config } };
  for (const [k, e] of files) {
    if (!e.chunks.size) continue;
    const chunks: [number, number, number, number?][] = [];
    for (const [i, r] of e.chunks) chunks.push([i, r.off, r.len, r.sum ?? 0]);
    index.files[k] = { key: e.key, name: e.name, size: e.size, etag: e.etag, chunkSize: e.chunkSize, seenAt: e.seenAt, lastModified: e.lastModified, norm: e.norm, chunks };
  }
  for (const [url, e] of extFiles) index.ext[url] = { name: e.name, size: e.size };
  try {
    const fh = await dir.getFileHandle('index.json', { create: true });
    const w = await fh.createWritable();
    await w.write(JSON.stringify(index));
    await w.close();
  } catch (e) {
    console.warn('[ddv-cache] failed to save index', e);
  }
}

function cachedBytesOf(entry: CacheEntry): number {
  let n = 0;
  for (const r of entry.chunks.values()) n += r.len;
  return n;
}

function writeChunk(entry: CacheEntry, idx: number, buf: Uint8Array) {
  if (!slab) return;
  try {
    const off = slabSize;
    slab.write(buf, { at: off });
    slab.flush();
    slabSize += buf.byteLength;
    const prev = entry.chunks.get(idx);
    if (prev) wasted += prev.len;
    entry.chunks.set(idx, { off, len: buf.byteLength, sum: checksum(buf) });
    scheduleSaveIndex();
  } catch (e) {
    console.warn('[ddv-cache] chunk write failed', e);
  }
}

function expectedChunkLen(entry: CacheEntry, idx: number): number {
  return Math.min(entry.chunkSize, entry.size - idx * entry.chunkSize);
}

function chunkCount(entry: CacheEntry): number {
  return Math.ceil(entry.size / entry.chunkSize);
}

function isComplete(entry: CacheEntry): boolean {
  const n = chunkCount(entry);
  for (let i = 0; i < n; i++) if (!entry.chunks.has(i)) return false;
  return true;
}

/** Store a complete copy of an object (possibly re-packed, see FileMeta.norm) as cache chunks. */
function storeWhole(url: string, etag: string, lastModified: string | undefined, bytes: Uint8Array, norm: { origSize: number } | undefined): { ok: true; chunks: number } | { ok: false; error: string } {
  if (!slab) return { ok: false, error: opfsError ?? 'cache storage unavailable' };
  if (!bytes.byteLength) return { ok: false, error: 'empty body' };
  const key = cacheKey(url);
  let entry = files.get(key);
  if (entry) resetEntry(entry, bytes.byteLength, etag);
  else {
    entry = newEntry({ key, name: hashName(key), size: bytes.byteLength, etag, chunkSize: config.chunkSize, seenAt: Date.now(), lastModified });
    files.set(key, entry);
  }
  entry.seenAt = Date.now();
  entry.norm = norm;
  let n = 0;
  for (let off = 0; off < bytes.byteLength; off += entry.chunkSize) {
    writeChunk(entry, n, bytes.subarray(off, Math.min(bytes.byteLength, off + entry.chunkSize)));
    n++;
  }
  if (!isComplete(entry)) {
    dropChunks(entry);
    entry.norm = undefined;
    return { ok: false, error: 'chunk write failed' };
  }
  stats.bytesDownloaded += norm ? norm.origSize : bytes.byteLength;
  scheduleSaveIndex();
  return { ok: true, chunks: n };
}

function readChunk(entry: CacheEntry, idx: number): Uint8Array | null {
  const ref = entry.chunks.get(idx);
  if (!ref || !slab) return null;
  const buf = new Uint8Array(ref.len);
  const n = slab.read(buf, { at: ref.off });
  const bad = n !== ref.len ? 'short-read' : ref.len !== expectedChunkLen(entry, idx) ? 'wrong-length' : ref.sum && checksum(buf) !== ref.sum ? 'checksum' : null;
  if (bad) {
    // whatever happened to this chunk, do not serve it: drop it and let the caller refetch
    stats.corruptions++;
    log({ method: 'GET', url: entry.key, range: `chunk ${idx}`, outcome: `corrupt-cache:${bad}` });
    wasted += ref.len;
    entry.chunks.delete(idx);
    scheduleSaveIndex();
    return null;
  }
  return buf;
}

function dropChunks(entry: CacheEntry) {
  wasted += cachedBytesOf(entry);
  entry.chunks.clear();
}

function resetEntry(entry: CacheEntry, size: number, etag: string) {
  dropChunks(entry);
  entry.size = size;
  entry.etag = etag;
  entry.norm = undefined;
  entry.stat = { hits: 0, misses: 0, bytesFromCache: 0, bytesFromNetwork: 0, bytesDownloaded: 0 };
  scheduleSaveIndex();
}

/** Record size / etag learned from a response or a listing; returns the entry. */
function recordMeta(key: string, size: number, etag: string, lastModified?: string): CacheEntry | null {
  if (!Number.isFinite(size) || size <= 0) return null;
  let entry = files.get(key);
  if (entry) {
    // a re-packed copy stays valid while the origin's ETag is unchanged (its size differs by design)
    const same = entry.norm ? entry.etag === etag && (size === entry.size || size === entry.norm.origSize) : entry.etag === etag && entry.size === size;
    if (!same) resetEntry(entry, size, etag);
    entry.seenAt = Date.now();
    if (lastModified) entry.lastModified = lastModified;
    return entry;
  }
  entry = newEntry({ key, name: hashName(key), size, etag, chunkSize: config.chunkSize, seenAt: Date.now(), lastModified });
  files.set(key, entry);
  return entry;
}

async function purgeEntry(key: string): Promise<boolean> {
  const entry = files.get(key);
  if (!entry) return false;
  dropChunks(entry);
  files.delete(key);
  scheduleSaveIndex();
  return true;
}

async function clearAll() {
  files.clear();
  wasted = 0;
  slabSize = 0;
  try {
    slab?.truncate(0);
    slab?.flush();
  } catch (e) {
    console.warn('[ddv-cache] clear failed', e);
  }
  for (const [, e] of extFiles) e.handle?.close();
  extFiles.clear();
  try {
    await dir?.removeEntry('ext', { recursive: true });
  } catch {
    /* ignore */
  }
  await saveIndex();
}

/** Rewrite the slab with only the referenced chunks. */
async function compact(): Promise<void> {
  if (!dir || !slab) return;
  try {
    const tmpFh = await dir.getFileHandle('slab.tmp', { create: true });
    const tmp = await tmpFh.createSyncAccessHandle();
    tmp.truncate(0);
    let pos = 0;
    // new offsets are kept aside until the new slab is in place
    const moved = new Map<CacheEntry, Map<number, ChunkRef>>();
    for (const e of files.values()) {
      const refs = new Map<number, ChunkRef>();
      for (const [i, r] of e.chunks) {
        const buf = new Uint8Array(r.len);
        if (slab.read(buf, { at: r.off }) !== r.len) continue;
        tmp.write(buf, { at: pos });
        refs.set(i, { off: pos, len: r.len, sum: r.sum });
        pos += r.len;
      }
      moved.set(e, refs);
    }
    tmp.flush();
    tmp.close();
    slab.close();
    slab = null;
    const mover = tmpFh as unknown as { move?: (name: string) => Promise<void> };
    if (typeof mover.move === 'function') {
      await mover.move('slab.bin');
    } else {
      // no rename support: copy back through the old file
      const dst = await (await dir.getFileHandle('slab.bin', { create: true })).createSyncAccessHandle();
      const src = await tmpFh.createSyncAccessHandle();
      dst.truncate(0);
      const buf = new Uint8Array(4 * 1024 * 1024);
      for (let at = 0; at < pos; at += buf.byteLength) {
        const n = src.read(buf, { at });
        dst.write(n === buf.byteLength ? buf : buf.subarray(0, n), { at });
      }
      dst.flush();
      dst.close();
      src.close();
      await dir.removeEntry('slab.tmp').catch(() => undefined);
    }
    slab = await (await dir.getFileHandle('slab.bin', { create: true })).createSyncAccessHandle();
    if (slab.getSize() < pos) throw new Error('compacted slab is shorter than expected');
    for (const [e, refs] of moved) e.chunks = refs;
    slabSize = pos;
    wasted = 0;
    await saveIndex();
  } catch (e) {
    console.warn('[ddv-cache] compaction failed; keeping the old layout', e);
    if (!slab) slab = await (await dir.getFileHandle('slab.bin', { create: true })).createSyncAccessHandle().catch(() => null);
    await dir.removeEntry('slab.tmp').catch(() => undefined);
  }
}

// ---------- native request helpers (synchronous) ----------

interface NativeResult {
  status: number;
  statusText: string;
  headers: HeaderMap;
  rawHeaders: string;
  body: ArrayBuffer | null;
}

function parseHeaders(raw: string): HeaderMap {
  const out: HeaderMap = {};
  for (const line of raw.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

// Deadlines for the synchronous requests DuckDB's file system makes from this worker. Without
// them a stalled connection blocks the worker (and every queued query) forever. Synchronous
// XHR may set `timeout` inside a worker (only a Window forbids it); on expiry send() throws,
// which DuckDB reports as an IO error for that file.
const HEAD_TIMEOUT_MS = 10_000;
const CHUNK_TIMEOUT_MS = 60_000; // one 1 MB range chunk
const WHOLE_FILE_TIMEOUT_MS = 600_000; // passthrough GET of a whole (non-range) file

function nativeSync(method: string, url: string, headers: HeaderMap, wantBody: boolean, timeoutMs = method === 'HEAD' ? HEAD_TIMEOUT_MS : CHUNK_TIMEOUT_MS): NativeResult {
  const x = new NativeXHR();
  x.open(method, url, false);
  x.timeout = timeoutMs;
  if (wantBody) x.responseType = 'arraybuffer';
  for (const [k, v] of Object.entries(headers)) {
    try {
      x.setRequestHeader(k, v);
    } catch {
      /* forbidden header */
    }
  }
  x.send(null);
  const raw = x.getAllResponseHeaders();
  return { status: x.status, statusText: x.statusText, headers: parseHeaders(raw), rawHeaders: raw, body: wantBody ? (x.response as ArrayBuffer) : null };
}

function totalSizeFrom(res: NativeResult): number {
  const cr = res.headers['content-range'];
  if (cr) {
    const m = /\/(\d+)$/.exec(cr);
    if (m) return Number(m[1]);
  }
  return Number(res.headers['content-length']);
}

function etagFrom(res: NativeResult): string {
  return res.headers['etag'] || res.headers['last-modified'] || '';
}

function parseRange(h: string, size: number): { start: number; end: number } | null {
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

// ---------- cached request handling ----------

function synthesizedHead(entry: CacheEntry, rangeHeader: string | undefined): NativeResult {
  const h: HeaderMap = {
    'content-type': 'application/octet-stream',
    'accept-ranges': 'bytes',
    etag: entry.etag,
    'x-ddv-cache': 'head',
  };
  if (entry.lastModified) h['last-modified'] = entry.lastModified;
  let status = 200;
  const range = rangeHeader ? parseRange(rangeHeader, entry.size) : null;
  if (range) {
    status = 206;
    h['content-range'] = `bytes ${range.start}-${range.end}/${entry.size}`;
    h['content-length'] = String(entry.size); // duckdb-wasm reads the total size from Content-Length of a HEAD
  } else {
    h['content-length'] = String(entry.size);
  }
  return { status, statusText: status === 206 ? 'Partial Content' : 'OK', headers: h, rawHeaders: Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n', body: null };
}

function handleHead(url: string, headers: HeaderMap): NativeResult {
  const entry = files.get(cacheKey(url));
  if (entry && entry.size > 0 && Date.now() - entry.seenAt < HEAD_FRESH_MS) {
    stats.headsSynthesized++;
    return synthesizedHead(entry, headers['range']);
  }
  const res = nativeSync('HEAD', url, headers, false);
  stats.headsNetwork++;
  if (res.status === 200 || res.status === 206) recordMeta(cacheKey(url), totalSizeFrom(res), etagFrom(res));
  return res;
}

function looksGzip(url: string): boolean {
  try {
    return /\.gz$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function handleRangeGet(url: string, headers: HeaderMap, rangeHeader: string, retry = true, retryEtag = true): NativeResult {
  const key = cacheKey(url);
  let entry = files.get(key) ?? null;
  if (!entry) {
    const h = { ...headers };
    delete h['range'];
    const head = nativeSync('HEAD', url, h, false);
    if (head.status === 200 || head.status === 206) entry = recordMeta(key, totalSizeFrom(head), etagFrom(head));
  }
  const range = entry ? parseRange(rangeHeader, entry.size) : null;
  if (!entry || !range) {
    stats.passthrough++;
    return nativeSync('GET', url, headers, true, WHOLE_FILE_TIMEOUT_MS);
  }
  const { start, end } = range;
  const cs = entry.chunkSize;
  const first = Math.floor(start / cs);
  const last = Math.floor(end / cs);
  const out = new Uint8Array(end - start + 1);
  for (let idx = first; idx <= last; idx++) {
    const chunkStart = idx * cs;
    let buf = readChunk(entry, idx);
    let fromCache = true;
    if (!buf && entry.norm) {
      // a re-packed copy lost a chunk: the origin cannot fill the hole (different bytes / offsets)
      log({ method: 'GET', url, range: rangeHeader, outcome: 'repacked-copy-incomplete' });
      dropChunks(entry);
      entry.norm = undefined;
      scheduleSaveIndex();
      const h: HeaderMap = { 'content-type': 'text/plain', 'x-ddv-cache': 'error' };
      const msg = new TextEncoder().encode('Duckdive: the re-packed copy of this gzip file was lost from the local cache; reconnect the data source to rebuild it.');
      return { status: 503, statusText: 'Service Unavailable', headers: h, rawHeaders: 'content-type: text/plain\r\n', body: msg.buffer };
    }
    if (!buf) {
      fromCache = false;
      const chunkEnd = Math.min(entry.size, chunkStart + cs) - 1;
      const res = nativeSync('GET', url, { ...headers, range: `bytes=${chunkStart}-${chunkEnd}` }, true);
      logNet(url, `bytes=${chunkStart}-${chunkEnd}`, res, chunkStart);
      if (res.status === 200 && res.body && res.body.byteLength === entry.size) {
        // the origin ignored Range and sent the whole object: slice what was asked for
        log({ method: 'GET', url, range: rangeHeader, outcome: 'range-ignored-full-body' });
        buf = new Uint8Array(res.body.slice(chunkStart, chunkEnd + 1));
      } else if (res.status !== 206 || !res.body) {
        // server does not honour ranges (or auth failed): give DuckDB the real answer
        stats.passthrough++;
        log({ method: 'GET', url, range: rangeHeader, outcome: `passthrough:${res.status}` });
        return res.status === 206 ? nativeSync('GET', url, headers, true, WHOLE_FILE_TIMEOUT_MS) : res;
      } else {
        const etag = etagFrom(res);
        if (entry.etag && etag && etag !== entry.etag) {
          // the object was replaced under us: whatever was assembled so far belongs to the old
          // version, so drop the cached chunks and start this request over against the new one
          log({ method: 'GET', url, range: rangeHeader, outcome: `etag-changed:${entry.etag}->${etag}` });
          resetEntry(entry, totalSizeFrom(res) || entry.size, etag);
          if (retryEtag) return handleRangeGet(url, headers, rangeHeader, retry, false);
          stats.passthrough++;
          return nativeSync('GET', url, headers, true, WHOLE_FILE_TIMEOUT_MS);
        }
        buf = new Uint8Array(res.body);
      }
      if (buf.byteLength !== chunkEnd - chunkStart + 1) {
        // a truncated body would leave a hole in the assembled range: answer this request
        // straight from the origin and cache nothing
        stats.passthrough++;
        log({ method: 'GET', url, range: rangeHeader, outcome: `short-body:${buf.byteLength}/${chunkEnd - chunkStart + 1}` });
        return nativeSync('GET', url, headers, true);
      }
      writeChunk(entry, idx, buf);
      stats.chunkMisses++;
      entry.stat.misses++;
      stats.bytesDownloaded += buf.byteLength;
      entry.stat.bytesDownloaded += buf.byteLength;
    } else {
      stats.chunkHits++;
      entry.stat.hits++;
    }
    const s = Math.max(start, chunkStart) - chunkStart;
    const e = Math.min(end, chunkStart + buf.byteLength - 1) - chunkStart;
    out.set(buf.subarray(s, e + 1), Math.max(start, chunkStart) - start);
    const served = e - s + 1;
    if (fromCache) {
      stats.bytesFromCache += served;
      entry.stat.bytesFromCache += served;
    } else {
      stats.bytesFromNetwork += served;
      entry.stat.bytesFromNetwork += served;
    }
  }
  // Self-heal: the first bytes of a .gz object must be the gzip magic. If a cached copy does not
  // start with it, the cached chunks are wrong (whatever the cause): drop them and fetch again.
  if (retry && start === 0 && out.byteLength >= 2 && looksGzip(url) && !(out[0] === 0x1f && out[1] === 0x8b)) {
    stats.corruptions++;
    log({ method: 'GET', url, range: rangeHeader, outcome: 'corrupt-cache-refetch' });
    dropChunks(entry);
    scheduleSaveIndex();
    return handleRangeGet(url, headers, rangeHeader, false);
  }
  const h: HeaderMap = {
    'content-type': 'application/octet-stream',
    'content-length': String(out.byteLength),
    'content-range': `bytes ${start}-${end}/${entry.size}`,
    'accept-ranges': 'bytes',
    etag: entry.etag,
    'x-ddv-cache': 'range',
  };
  return { status: 206, statusText: 'Partial Content', headers: h, rawHeaders: Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n', body: out.buffer };
}

function handleExtensionGet(url: string, headers: HeaderMap): NativeResult {
  const rec = extFiles.get(url);
  if (rec?.handle && rec.size > 0 && rec.handle.getSize() === rec.size) {
    const buf = new Uint8Array(rec.size);
    const n = rec.handle.read(buf, { at: 0 });
    if (n === rec.size) {
      log({ method: 'GET', url, range: null, outcome: 'extension-cache' });
      const h: HeaderMap = { 'content-type': 'application/wasm', 'content-length': String(rec.size), 'x-ddv-cache': 'extension' };
      return { status: 200, statusText: 'OK', headers: h, rawHeaders: Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n', body: buf.buffer };
    }
  }
  const res = nativeSync('GET', url, headers, true, WHOLE_FILE_TIMEOUT_MS);
  if (res.status === 200 && res.body && dir) {
    const body = new Uint8Array(res.body.slice(0));
    let entry = rec;
    if (!entry) {
      entry = { name: hashName(url) + '.wasm', size: 0, handle: null, opening: null };
      extFiles.set(url, entry);
    }
    const target = entry;
    (async () => {
      try {
        await openExt(target);
        if (!target.handle) return;
        target.handle.truncate(0);
        target.handle.write(body, { at: 0 });
        target.handle.flush();
        target.size = body.byteLength;
        scheduleSaveIndex();
      } catch (e) {
        console.warn('[ddv-cache] extension cache write failed', e);
      }
    })();
  }
  return res;
}

// ---------- XMLHttpRequest replacement ----------

class CachingXHR {
  private method = 'GET';
  private url = '';
  private isAsync = true;
  private reqHeaders: HeaderMap = {};
  private native: XMLHttpRequest | null = null;
  private result: NativeResult | null = null;
  responseType: XMLHttpRequestResponseType = '';
  timeout = 0;
  withCredentials = false;
  onload: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onreadystatechange: ((ev?: unknown) => void) | null = null;
  onprogress: ((ev?: unknown) => void) | null = null;
  onabort: ((ev?: unknown) => void) | null = null;
  ontimeout: ((ev?: unknown) => void) | null = null;
  onloadend: ((ev?: unknown) => void) | null = null;
  readyState = 0;

  open(method: string, url: string, async = true) {
    this.method = method.toUpperCase();
    this.url = url;
    this.isAsync = async;
    this.readyState = 1;
  }
  setRequestHeader(k: string, v: string) {
    this.reqHeaders[k.toLowerCase()] = v;
  }
  overrideMimeType(_m: string) {
    /* ignored */
  }
  abort() {
    this.native?.abort();
  }
  addEventListener(type: string, fn: (ev?: unknown) => void) {
    (this as unknown as Record<string, unknown>)['on' + type] = fn;
  }
  removeEventListener() {
    /* not needed */
  }

  private cacheable(): boolean {
    if (!config.enabled || this.isAsync || opfsError) return false;
    if (!isDataUrl(this.url)) return false;
    if (this.method === 'HEAD') return true;
    if (this.method === 'GET' && (this.reqHeaders['range'] || isExtensionUrl(this.url))) return true;
    return false;
  }

  /** Fill in what the caller ends up seeing (status / size / first bytes) once an answer is known. */
  private describe(entry: LogEntry) {
    entry.status = this.status;
    const r = this.native ? this.native.response : this.result?.body;
    if (r instanceof ArrayBuffer) {
      entry.bytes = r.byteLength;
      const range = this.reqHeaders['range'];
      if (this.method === 'GET' && (!range || /^bytes=0-/.test(range))) entry.head = hexHead(r);
    }
    if (this.native) {
      const enc = this.native.getResponseHeader('content-encoding');
      if (enc) entry.enc = enc;
    }
  }

  send(body: unknown) {
    if (!this.cacheable()) {
      const entry = log({ method: this.method, url: this.url, range: this.reqHeaders['range'] ?? null, outcome: this.isAsync ? 'async-passthrough' : 'passthrough' });
      this.passthrough(body, entry);
      return;
    }
    stats.requests++;
    const range = this.reqHeaders['range'] ?? null;
    const entry = log({ method: this.method, url: this.url, range, outcome: 'handled' });
    try {
      if (this.method === 'HEAD') this.result = handleHead(this.url, this.reqHeaders);
      else if (range) this.result = handleRangeGet(this.url, this.reqHeaders, range);
      else this.result = handleExtensionGet(this.url, this.reqHeaders);
      this.describe(entry);
    } catch (e) {
      console.warn('[ddv-cache] falling back to network', e);
      entry.outcome = `handler-error:${String(e).slice(0, 80)}`;
      stats.passthrough++;
      this.passthrough(body, entry);
      return;
    }
    this.readyState = 4;
    this.onreadystatechange?.();
    this.onload?.();
    this.onloadend?.();
  }

  private passthrough(body: unknown, entry?: LogEntry) {
    const x = new NativeXHR();
    this.native = x;
    x.open(this.method, this.url, this.isAsync);
    if (this.responseType) x.responseType = this.responseType;
    // DuckDB never sets a timeout; give synchronous requests a deadline (see nativeSync)
    x.timeout = this.timeout || (this.isAsync ? 0 : this.method === 'HEAD' ? HEAD_TIMEOUT_MS : this.reqHeaders['range'] ? CHUNK_TIMEOUT_MS : WHOLE_FILE_TIMEOUT_MS);
    x.withCredentials = this.withCredentials;
    for (const [k, v] of Object.entries(this.reqHeaders)) {
      try {
        x.setRequestHeader(k, v);
      } catch {
        /* ignore */
      }
    }
    if (this.isAsync) {
      x.onreadystatechange = () => {
        this.readyState = x.readyState;
        this.onreadystatechange?.();
      };
      x.onload = (ev) => this.onload?.(ev);
      x.onerror = (ev) => this.onerror?.(ev);
      x.onprogress = (ev) => this.onprogress?.(ev);
      x.onabort = (ev) => this.onabort?.(ev);
      x.ontimeout = (ev) => this.ontimeout?.(ev);
      x.onloadend = (ev) => {
        if (entry) this.describe(entry);
        this.onloadend?.(ev);
      };
    }
    x.send(body as XMLHttpRequestBodyInit | null);
    if (!this.isAsync) {
      this.readyState = 4;
      if (entry) this.describe(entry);
    }
  }

  get status(): number {
    return this.native ? this.native.status : (this.result?.status ?? 0);
  }
  get statusText(): string {
    return this.native ? this.native.statusText : (this.result?.statusText ?? '');
  }
  get response(): unknown {
    if (this.native) return this.native.response;
    if (!this.result) return null;
    if (this.responseType === 'arraybuffer') return this.result.body;
    if (this.responseType === '' || this.responseType === 'text') return this.result.body ? new TextDecoder().decode(this.result.body) : '';
    if (this.responseType === 'json') {
      try {
        return this.result.body ? JSON.parse(new TextDecoder().decode(this.result.body)) : null;
      } catch {
        return null;
      }
    }
    return this.result.body;
  }
  get responseText(): string {
    if (this.native) return this.native.responseText;
    return this.result?.body ? new TextDecoder().decode(this.result.body) : '';
  }
  get responseURL(): string {
    return this.native ? this.native.responseURL : this.url;
  }
  getResponseHeader(name: string): string | null {
    if (this.native) return this.native.getResponseHeader(name);
    return this.result?.headers[name.toLowerCase()] ?? null;
  }
  getAllResponseHeaders(): string {
    if (this.native) return this.native.getAllResponseHeaders();
    return this.result?.rawHeaders ?? '';
  }
}

// ---------- control channel ----------

const channel = new BroadcastChannel(self.name || 'ddv-cache');
channel.onmessage = async (ev) => {
  const { id, type, ...rest } = (ev.data ?? {}) as { id: string; type: string; [k: string]: unknown };
  if (!id || !type) return;
  const reply = (payload: Record<string, unknown>) => channel.postMessage({ id, ...payload });
  try {
    switch (type) {
      case 'stats': {
        // per-file counters only for files that saw traffic (a source may have 10,000+ entries)
        const filesStat: Record<string, CacheEntry['stat']> = {};
        let n = 0;
        for (const [k, e] of files) {
          if (!e.stat.hits && !e.stat.misses) continue;
          filesStat[k] = e.stat;
          if (++n >= 200) break;
        }
        reply({ ok: true, stats: { ...stats, files: filesStat }, config: { ...config, concurrency: 1 }, opfsError });
        break;
      }
      case 'config': {
        const c = rest.config as Partial<typeof config>;
        if (typeof c.enabled === 'boolean') config.enabled = c.enabled;
        if (typeof c.chunkSize === 'number' && c.chunkSize >= 64 * 1024) config.chunkSize = c.chunkSize;
        if (typeof c.normalizeGzip === 'boolean') config.normalizeGzip = c.normalizeGzip;
        await saveIndex();
        reply({ ok: true, config: { ...config, concurrency: 1 } });
        break;
      }
      case 'files': {
        // only files holding data, largest first; `limit` (default 100) or `all: true`
        const limit = typeof rest.limit === 'number' ? rest.limit : 100;
        const list: { url: string; size: number; etag: string; cachedChunks: number; cachedBytes: number; chunkSize: number; repacked?: number }[] = [];
        let cachedBytes = 0;
        for (const e of files.values()) {
          if (!e.chunks.size) continue;
          const bytes = cachedBytesOf(e);
          cachedBytes += bytes;
          list.push({ url: e.key, size: e.size, etag: e.etag, cachedChunks: e.chunks.size, cachedBytes: bytes, chunkSize: e.chunkSize, repacked: e.norm?.origSize });
        }
        list.sort((a, b) => b.cachedBytes - a.cachedBytes);
        reply({ ok: true, files: rest.all === true ? list : list.slice(0, limit), summary: { known: files.size, cachedFiles: list.length, cachedBytes, slabSize, wasted } });
        break;
      }
      case 'purge':
        reply({ ok: true, removed: (await purgeEntry(cacheKey(String(rest.url)))) ? 1 : 0 });
        break;
      case 'compact':
        await compact();
        reply({ ok: true, slabSize, wasted });
        break;
      case 'clear':
        await clearAll();
        reply({ ok: true });
        break;
      case 'ping':
        reply({ ok: true, opfsError });
        break;
      case 'store': {
        // a complete copy of an object fetched by the page (possibly re-packed): see src/gznorm.ts
        const bytes = rest.bytes instanceof ArrayBuffer ? new Uint8Array(rest.bytes) : rest.bytes instanceof Uint8Array ? rest.bytes : null;
        if (!bytes) {
          reply({ ok: false, error: 'no bytes' });
          break;
        }
        const norm = rest.repacked ? { origSize: Number(rest.origSize) || bytes.byteLength } : undefined;
        const r = storeWhole(String(rest.url), String(rest.etag ?? ''), rest.lastModified ? new Date(String(rest.lastModified)).toUTCString() : undefined, bytes, norm);
        if (r.ok) log({ method: 'STORE', url: String(rest.url), range: null, outcome: (norm ? `repacked:${norm.origSize}->${bytes.byteLength}` : 'stored') + (rest.note ? ` ${String(rest.note)}` : ''), bytes: bytes.byteLength, head: hexHead(new Uint8Array(bytes.subarray(0, 8)).buffer as ArrayBuffer) });
        reply(r.ok ? { ok: true, chunks: r.chunks } : { ok: false, error: r.error });
        break;
      }
      case 'complete': {
        // which of these objects are fully cached (same ETag), so the page can skip fetching them
        const list = (rest.files ?? []) as { url: string; etag: string }[];
        const done: string[] = [];
        for (const f of list) {
          const e = files.get(cacheKey(f.url));
          if (e && e.etag === (f.etag || '') && e.chunks.size && isComplete(e)) done.push(f.url);
        }
        reply({ ok: true, complete: done });
        break;
      }
      case 'seed': {
        // metadata from the page's listing: lets HEADs be answered locally and validates ETags
        const list = (rest.files ?? []) as { url: string; size: number; etag: string; lastModified?: string }[];
        let n = 0;
        for (const f of list) {
          try {
            const lm = f.lastModified ? new Date(f.lastModified).toUTCString() : undefined;
            if (recordMeta(cacheKey(f.url), Number(f.size), f.etag || '', lm)) n++;
          } catch {
            /* skip bad entries */
          }
        }
        scheduleSaveIndex();
        reply({ ok: true, seeded: n });
        break;
      }
      default:
        reply({ ok: false, error: `unknown message ${type}` });
    }
  } catch (e) {
    reply({ ok: false, error: String(e) });
  }
};

// ---------- boot ----------

// Buffer messages from the page until the duckdb-wasm worker has installed its handler.
const buffered: MessageEvent[] = [];
self.onmessage = (ev: MessageEvent) => {
  buffered.push(ev);
};

(async () => {
  await initOpfs();
  (self as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = CachingXHR;
  importScripts(new URL('/duckdb/duckdb-browser-eh.worker.js', self.location.href).href);
  const handler = self.onmessage as ((ev: MessageEvent) => void) | null;
  for (const ev of buffered) handler?.(ev);
  buffered.length = 0;
})();
