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
 * The page talks to the cache over a MessagePort that arrives as the worker's first message
 * (src/cache.ts): stats / files / config / clear / purge / seed / store / complete.
 */

import {
  cacheKey,
  checksum,
  etagFrom,
  hashName,
  hexHead,
  isDataUrl,
  isExtensionUrl,
  looksGzip,
  parseHeaders,
  parseRange,
  rawHeaders,
  totalSizeFrom,
  type HeaderMap,
  type NativeResult,
  evictionPlan,
} from './cache-util';

declare function importScripts(...urls: string[]): void;

interface FileMeta {
  key: string;
  size: number;
  etag: string;
  chunkSize: number;
  seenAt: number;
  /** last time chunks of the file were read or written (eviction order); absent in entries of older builds */
  usedAt?: number;
  lastModified?: string;
}

/**
 * HEAD requests are answered locally while the file's metadata is this fresh. Metadata comes
 * from the page's ListObjectsV2 results (seeded before the view is created) or from a real
 * HEAD; duckdb-wasm issues one HEAD per file every time the view is bound, so without this a
 * 10,000-file source costs 10,000 sequential requests per query. A long window is safe: every
 * chunk GET checks the ETag, and an object replaced meanwhile resets its entry (new size and
 * ETag) so the next HEAD is answered correctly after one failed query.
 */
const HEAD_FRESH_MS = 6 * 3600_000;

interface ChunkRef {
  off: number;
  len: number;
  /** FNV-1a 32-bit checksum of the bytes (0 = unknown, for entries written by older builds) */
  sum: number;
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
  config: { enabled: boolean; chunkSize: number; maxBytes?: number };
}

const INDEX_VERSION = 2;
let slab: FileSystemSyncAccessHandle | null = null;
let slabSize = 0;
let wasted = 0;
const COMPACT_MIN_WASTE = 64 * 1024 * 1024;
const DIR = 'ddv-cache';
const NativeXHR = self.XMLHttpRequest;

/** maxBytes: cached data allowed on disk (0 = no limit); beyond it whole files go, least recently used first */
const config = { enabled: true, chunkSize: 1024 * 1024, maxBytes: 4 * 1024 * 1024 * 1024 };
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
const stats = {
  requests: 0,
  passthrough: 0,
  chunkHits: 0,
  chunkMisses: 0,
  bytesFromCache: 0,
  bytesFromNetwork: 0,
  bytesDownloaded: 0,
  headsSynthesized: 0,
  headsNetwork: 0,
  corruptions: 0,
  evictions: 0,
  log: [] as LogEntry[],
};
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
/**
 * Another tab owns the cache: this worker opened the slab read-only, serves what the index
 * lists (re-read every few seconds) and downloads the rest without keeping it. Nothing is written.
 */
let readOnly = false;
const INDEX_RELOAD_MS = 5000;
let indexSaveTimer: ReturnType<typeof setTimeout> | null = null;
/** when the index first became dirty since the last save (0 = clean) */
let indexDirtySince = 0;
/** the index is written this soon after a change, or at the latest this long after the first unsaved one */
const INDEX_SAVE_DEBOUNCE_MS = 300;
const INDEX_SAVE_MAX_DELAY_MS = 5000;

function log(entry: Omit<LogEntry, 't'>): LogEntry {
  // The cache panel offers this log as JSON to paste into a bug report, and a presigned URL
  // carries a working signature in its query string. cacheKey strips exactly those parameters,
  // which is also how the entries are keyed, so the log reads like the rest of the panel.
  let url = entry.url;
  try {
    url = cacheKey(url);
  } catch {
    /* not a URL (an internal marker such as "(cache)") */
  }
  const e: LogEntry = { t: Date.now(), ...entry, url };
  stats.log.push(e);
  if (stats.log.length > LOG_SIZE) stats.log.shift();
  return e;
}

/** Describe a network answer in the log (header chunk, odd status or transfer encoding only: 206 chunk bodies are routine). */
function logNet(url: string, range: string, res: NativeResult, offset: number) {
  const enc = res.headers['content-encoding'];
  if (res.status === 206 && !enc && offset !== 0) return;
  log({ method: 'GET', url, range, outcome: `net:${res.status}`, status: res.status, bytes: res.body?.byteLength, enc: enc || undefined, head: offset === 0 ? hexHead(res.body) : undefined });
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
    root = await navigator.storage.getDirectory();
    dir = await root.getDirectoryHandle(DIR, { create: true });
    if (!locked) {
      // Share the owner's slab. Handles share a file only in the same mode, and the owner writes,
      // so both sides open "readwrite-unsafe" (Chrome 121+); the Web Lock keeps this side from writing.
      try {
        slab = await openSync(await dir.getFileHandle('slab.bin', { create: true }), 'readwrite-unsafe');
        readOnly = true;
        reloadTimer = setInterval(() => void reloadIndex(), INDEX_RELOAD_MS);
        awaitOwnership();
      } catch {
        opfsError = 'The range cache is in use by another Duckdive tab; this tab reads from the origin directly.';
        console.warn('[ddv-cache]', opfsError);
        return;
      }
    }
    // layout v1 kept one OPFS file per cached file; drop it
    if (!readOnly) await dir.removeEntry('files', { recursive: true }).catch(() => undefined);
    let index: Index | null = null;
    try {
      const fh = await dir.getFileHandle('index.json');
      index = JSON.parse(await (await fh.getFile()).text());
    } catch {
      index = null;
    }
    if (!slab) slab = await openShared(await dir.getFileHandle('slab.bin', { create: true }));
    const actual = slab.getSize();
    if (index && index.version === INDEX_VERSION) {
      config.enabled = index.config?.enabled ?? true;
      config.chunkSize = index.config?.chunkSize ?? config.chunkSize;
      config.maxBytes = index.config?.maxBytes ?? config.maxBytes;
      slabSize = Math.min(index.slabSize ?? 0, actual);
      wasted = index.wasted ?? 0;
      for (const meta of Object.values(index.files)) {
        // entries left by the gzip re-packing of older builds hold bytes the origin never served
        if ((meta as { norm?: unknown }).norm) continue;
        const entry = newEntry(meta);
        for (const [i, off, len, sum] of meta.chunks ?? []) if (off + len <= slabSize) entry.chunks.set(i, { off, len, sum: sum ?? 0 });
        if (entry.chunks.size) files.set(meta.key, entry);
      }
      for (const [url, e] of Object.entries(index.ext ?? {})) {
        const rec: ExtEntry = { name: e.name, size: e.size, handle: null, opening: null };
        extFiles.set(url, rec);
        void openExt(rec);
      }
    } else if (!readOnly) {
      slab.truncate(0);
      slabSize = 0;
      wasted = 0;
    }
    // not awaited: a compaction reads and writes the whole slab, and DuckDB is waiting to start
    if (!readOnly && needsCompaction()) scheduleCompact();
  } catch (e) {
    opfsError = `OPFS unavailable: ${String(e)}`;
    console.warn('[ddv-cache]', opfsError);
  }
}

/** A sync access handle in the given mode (the mode option is a Chrome 121+ addition that lib.dom does not declare). */
function openSync(fh: FileSystemFileHandle, mode: 'readwrite' | 'readwrite-unsafe'): Promise<FileSystemSyncAccessHandle> {
  return (fh as unknown as { createSyncAccessHandle(o?: { mode: string }): Promise<FileSystemSyncAccessHandle> }).createSyncAccessHandle({ mode });
}

/** The owner's handle: shareable with other tabs' readers where the browser allows it, exclusive otherwise. */
async function openShared(fh: FileSystemFileHandle): Promise<FileSystemSyncAccessHandle> {
  try {
    return await openSync(fh, 'readwrite-unsafe');
  } catch {
    return fh.createSyncAccessHandle();
  }
}

let reloadTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Keep asking for the lock the owner holds. The owner releases it when its tab closes, and this
 * request is granted then: without it a tab that started second would go on downloading
 * everything uncached for as long as it lives, even once it is the only tab left.
 */
function awaitOwnership(): void {
  void navigator.locks
    .request('ddv-cache-owner', async (lock) => {
      if (!lock) return;
      readOnly = false;
      if (reloadTimer) clearInterval(reloadTimer);
      reloadTimer = null;
      // one last read of what the departed owner left behind; the slab is already open in the
      // mode the owner uses, so from here this tab writes
      await reloadIndexInto();
      log({ method: 'OWN', url: '(cache)', range: null, outcome: 'took-over' });
      return new Promise<void>(() => undefined); // held for this worker's lifetime
    })
    .catch(() => undefined);
}

/**
 * Read-only tabs: take the owner's index again so chunks it wrote (or moved by compaction) are
 * found. A half-written index does not parse and is tried again next time; entries this tab
 * created from its own HEADs keep their metadata, only the chunk maps are replaced.
 */
async function reloadIndex(): Promise<void> {
  if (!dir || !readOnly) return;
  await reloadIndexInto();
}

/** The index file's own stamp, so an unchanged file is not parsed again every few seconds. */
let indexSeen = '';

async function reloadIndexInto(): Promise<void> {
  if (!dir) return;
  let index: Index;
  try {
    const file = await (await dir.getFileHandle('index.json')).getFile();
    const stamp = `${file.lastModified}:${file.size}`;
    if (stamp === indexSeen) return;
    index = JSON.parse(await file.text());
    indexSeen = stamp;
  } catch {
    return;
  }
  if (index.version !== INDEX_VERSION) return;
  slabSize = index.slabSize ?? slabSize;
  // carried over so that a tab taking the cache over knows what is already unreferenced in it
  wasted = index.wasted ?? wasted;
  const listed = new Set<string>();
  for (const meta of Object.values(index.files)) {
    if ((meta as { norm?: unknown }).norm) continue;
    listed.add(meta.key);
    const entry = files.get(meta.key) ?? newEntry(meta);
    entry.chunks = new Map();
    for (const [i, off, len, sum] of meta.chunks ?? []) if (off + len <= slabSize) entry.chunks.set(i, { off, len, sum: sum ?? 0 });
    entry.size = meta.size;
    entry.etag = meta.etag;
    // the owner may use a different chunk size; keeping ours would read every chunk as wrong-length
    entry.chunkSize = meta.chunkSize;
    files.set(meta.key, entry);
  }
  for (const [k, e] of files) if (!listed.has(k)) e.chunks.clear();
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
      rec.handle = await openShared(fh);
    } catch (e) {
      console.warn('[ddv-cache] failed to open extension cache', e);
    } finally {
      rec.opening = null;
    }
  })();
  return rec.opening;
}

/**
 * Save the index shortly after the last change. A steady stream of chunk writes would keep
 * postponing a plain debounce, and a tab that dies meanwhile leaves every chunk written since
 * the last save unreferenced (wasted slab space), so the delay is capped as well.
 */
function scheduleSaveIndex() {
  if (!dir || readOnly) return;
  const now = Date.now();
  if (!indexDirtySince) indexDirtySince = now;
  if (indexSaveTimer) clearTimeout(indexSaveTimer);
  const delay = Math.max(0, Math.min(INDEX_SAVE_DEBOUNCE_MS, indexDirtySince + INDEX_SAVE_MAX_DELAY_MS - now));
  indexSaveTimer = setTimeout(saveIndex, delay);
}

/** Persist the chunk map (only files that actually hold data; seeded metadata is transient). */
async function saveIndex() {
  if (!dir || readOnly) return;
  if (indexSaveTimer) clearTimeout(indexSaveTimer);
  indexSaveTimer = null;
  indexDirtySince = 0;
  const index: Index = { version: INDEX_VERSION, slabSize, wasted, files: {}, ext: {}, config: { ...config } };
  for (const [k, e] of files) {
    if (!e.chunks.size) continue;
    const chunks: [number, number, number, number?][] = [];
    for (const [i, r] of e.chunks) chunks.push([i, r.off, r.len, r.sum ?? 0]);
    index.files[k] = { key: e.key, size: e.size, etag: e.etag, chunkSize: e.chunkSize, seenAt: e.seenAt, usedAt: e.usedAt, lastModified: e.lastModified, chunks };
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

/** Bytes of the slab that are still referenced. */
const liveBytes = () => slabSize - wasted;

/**
 * Keep the cached data within config.maxBytes: drop whole files, least recently used first,
 * down to 80 % of the limit. `keep` is the file being written (it is never dropped under itself).
 * Dropped chunks become waste in the slab; a compaction is scheduled to give the disk back.
 */
function enforceLimit(keep: CacheEntry | null) {
  if (!config.maxBytes || liveBytes() <= config.maxBytes) return;
  const candidates = [...files.values()].filter((e) => e !== keep && e.chunks.size).map((e) => ({ entry: e, seenAt: e.seenAt, usedAt: e.usedAt, bytes: cachedBytesOf(e) }));
  for (const c of evictionPlan(candidates, liveBytes(), config.maxBytes * 0.8)) {
    dropChunks(c.entry);
    stats.evictions++;
    log({ method: 'EVICT', url: c.entry.key, range: null, outcome: `evicted:${c.bytes}` });
  }
  scheduleSaveIndex();
  if (needsCompaction()) scheduleCompact();
}

/** Waste worth a rewrite: more than half the slab, or a slab that outgrew the limit with a fifth of it unreferenced. */
function needsCompaction(): boolean {
  if (wasted <= 0) return false;
  if (wasted > COMPACT_MIN_WASTE && wasted > slabSize / 2) return true;
  return config.maxBytes > 0 && slabSize > config.maxBytes && wasted >= slabSize / 5;
}

let compactTimer: ReturnType<typeof setTimeout> | null = null;
let compacting = false;

/** Compact a little later, once the burst of writes that caused the evictions has passed. */
function scheduleCompact() {
  if (compactTimer) return;
  compactTimer = setTimeout(() => {
    compactTimer = null;
    if (!compacting && needsCompaction()) void compact();
  }, 10_000);
}

function writeChunk(entry: CacheEntry, idx: number, buf: Uint8Array) {
  if (!slab || readOnly) return;
  try {
    const off = slabSize;
    slab.write(buf, { at: off });
    slab.flush();
    slabSize += buf.byteLength;
    const prev = entry.chunks.get(idx);
    if (prev) wasted += prev.len;
    entry.chunks.set(idx, { off, len: buf.byteLength, sum: checksum(buf) });
    entry.usedAt = Date.now();
    scheduleSaveIndex();
    enforceLimit(entry);
  } catch (e) {
    console.warn('[ddv-cache] chunk write failed', e);
  }
}

function expectedChunkLen(entry: CacheEntry, idx: number): number {
  return Math.min(entry.chunkSize, entry.size - idx * entry.chunkSize);
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
  entry.stat = { hits: 0, misses: 0, bytesFromCache: 0, bytesFromNetwork: 0, bytesDownloaded: 0 };
  scheduleSaveIndex();
}

/** Record size / etag learned from a response or a listing; returns the entry. */
function recordMeta(key: string, size: number, etag: string, lastModified?: string): CacheEntry | null {
  if (!Number.isFinite(size) || size <= 0) return null;
  let entry = files.get(key);
  if (entry) {
    if (entry.etag !== etag || entry.size !== size) resetEntry(entry, size, etag);
    entry.seenAt = Date.now();
    if (lastModified) entry.lastModified = lastModified;
    return entry;
  }
  entry = newEntry({ key, size, etag, chunkSize: config.chunkSize, seenAt: Date.now(), lastModified });
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
  // a compaction holds a snapshot of the chunk table and writes it back when it finishes
  await settleCompaction();
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
let compactRun: Promise<void> | null = null;

async function compact(): Promise<void> {
  if (!dir || !slab) return;
  if (compactRun) return compactRun;
  compacting = true;
  compactRun = compactSlab().finally(() => {
    compacting = false;
    compactRun = null;
  });
  return compactRun;
}

/** Wait for a running compaction: it closes the slab for a moment and moves every chunk. */
const settleCompaction = (): Promise<void> => compactRun ?? Promise.resolve();

async function compactSlab(): Promise<void> {
  if (!dir || !slab) return;
  try {
    const tmpFh = await dir.getFileHandle('slab.tmp', { create: true });
    const tmp = await openShared(tmpFh);
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
      const dst = await openShared(await dir.getFileHandle('slab.bin', { create: true }));
      const src = await openShared(tmpFh);
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
    slab = await openShared(await dir.getFileHandle('slab.bin', { create: true }));
    if (slab.getSize() < pos) throw new Error('compacted slab is shorter than expected');
    // The slab was closed while the new one was moved into place, and the messages handled in
    // that window can drop chunks (an eviction, a changed ETag, a purge). Such an entry has an
    // empty chunk table now, and handing it the snapshot back would resurrect what was dropped.
    for (const [e, refs] of moved) if (e.chunks.size === refs.size) e.chunks = refs;
    slabSize = pos;
    wasted = pos - [...files.values()].reduce((a, e) => a + cachedBytesOf(e), 0);
    await saveIndex();
  } catch (e) {
    console.warn('[ddv-cache] compaction failed; keeping the old layout', e);
    if (!slab) slab = await openShared(await dir.getFileHandle('slab.bin', { create: true })).catch(() => null);
    await dir.removeEntry('slab.tmp').catch(() => undefined);
  }
}

// ---------- native request helpers (synchronous) ----------

// Deadlines for the synchronous requests DuckDB's file system makes from this worker. Without
// them a stalled connection blocks the worker (and every queued query) forever. Synchronous
// XHR may set `timeout` inside a worker (only a Window forbids it); on expiry send() throws,
// which DuckDB reports as an IO error for that file.
const HEAD_TIMEOUT_MS = 10_000;
const CHUNK_TIMEOUT_MS = 60_000; // one 1 MB range chunk
const WHOLE_FILE_TIMEOUT_MS = 600_000; // passthrough GET of a whole (non-range) file

/**
 * A request that did not come back: the connection failed or the deadline passed. It is kept
 * apart from the other errors of the handling because there is nothing to gain by asking again,
 * while OPFS raises DOMExceptions too and those are worth falling back to the network for.
 */
class RequestFailed extends Error {
  constructor(readonly reason: unknown) {
    super(String(reason));
    this.name = 'RequestFailed';
  }
}

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
  try {
    x.send(null);
  } catch (e) {
    throw new RequestFailed(e);
  }
  const raw = x.getAllResponseHeaders();
  return { status: x.status, statusText: x.statusText, headers: parseHeaders(raw), rawHeaders: raw, body: wantBody ? (x.response as ArrayBuffer) : null };
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
  return {
    status,
    statusText: status === 206 ? 'Partial Content' : 'OK',
    headers: h,
    rawHeaders: rawHeaders(h),
    body: null,
  };
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
    entry.usedAt = Date.now();
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
  return {
    status: 206,
    statusText: 'Partial Content',
    headers: h,
    rawHeaders: rawHeaders(h),
    body: out.buffer,
  };
}

function handleExtensionGet(url: string, headers: HeaderMap): NativeResult {
  const rec = extFiles.get(url);
  if (rec?.handle && rec.size > 0 && rec.handle.getSize() === rec.size) {
    const buf = new Uint8Array(rec.size);
    const n = rec.handle.read(buf, { at: 0 });
    if (n === rec.size) {
      log({ method: 'GET', url, range: null, outcome: 'extension-cache' });
      const h: HeaderMap = { 'content-type': 'application/wasm', 'content-length': String(rec.size), 'x-ddv-cache': 'extension' };
      return {
        status: 200,
        statusText: 'OK',
        headers: h,
        rawHeaders: rawHeaders(h),
        body: buf.buffer,
      };
    }
  }
  const res = nativeSync('GET', url, headers, true, WHOLE_FILE_TIMEOUT_MS);
  if (res.status === 200 && res.body && dir && !readOnly) {
    const body = new Uint8Array(res.body.slice(0));
    let entry = rec;
    if (!entry) {
      entry = { name: hashName(url) + '.wasm', size: 0, handle: null, opening: null };
      extFiles.set(url, entry);
    }
    const target = entry;
    void (async () => {
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
    if (!isDataUrl(this.url, self.location.origin)) return false;
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
      // A request that already waited out its deadline is not worth repeating: the second one
      // costs the same wait again with the worker, and every query behind it, blocked throughout.
      // Report it the way a plain XHR would. Any other error is a fault of the handling above,
      // and there the fallback is the point: the cache stays out of DuckDB's way.
      if (e instanceof RequestFailed) throw e.reason;
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

/** Serve one control request from the page; `reply` answers it on the same port. */
async function handleControl(data: unknown, reply: (payload: Record<string, unknown>) => void) {
  const { id, type, ...rest } = (data ?? {}) as { id: string; type: string; [k: string]: unknown };
  if (!id || !type) return;
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
        reply({ ok: true, stats: { ...stats, files: filesStat }, config: { ...config, concurrency: 1 }, opfsError, readOnly });
        break;
      }
      case 'config': {
        const c = rest.config as Partial<typeof config>;
        if (typeof c.enabled === 'boolean') config.enabled = c.enabled;
        if (typeof c.chunkSize === 'number' && c.chunkSize >= 64 * 1024) config.chunkSize = c.chunkSize;
        if (typeof c.maxBytes === 'number' && c.maxBytes >= 0) config.maxBytes = Math.floor(c.maxBytes);
        enforceLimit(null);
        await saveIndex();
        reply({ ok: true, config: { ...config, concurrency: 1 } });
        break;
      }
      case 'files': {
        // only files holding data, largest first; `limit` (default 100) or `all: true`
        const limit = typeof rest.limit === 'number' ? rest.limit : 100;
        const list: { url: string; size: number; etag: string; cachedChunks: number; cachedBytes: number; chunkSize: number }[] = [];
        let cachedBytes = 0;
        for (const e of files.values()) {
          if (!e.chunks.size) continue;
          const bytes = cachedBytesOf(e);
          cachedBytes += bytes;
          list.push({ url: e.key, size: e.size, etag: e.etag, cachedChunks: e.chunks.size, cachedBytes: bytes, chunkSize: e.chunkSize });
        }
        list.sort((a, b) => b.cachedBytes - a.cachedBytes);
        reply({ ok: true, files: rest.all === true ? list : list.slice(0, limit), summary: { known: files.size, cachedFiles: list.length, cachedBytes, slabSize, wasted } });
        break;
      }
      case 'purge':
        if (readOnly) throw new Error('the cache is read-only in this tab');
        reply({ ok: true, removed: (await purgeEntry(cacheKey(String(rest.url)))) ? 1 : 0 });
        break;
      case 'compact':
        if (readOnly) throw new Error('the cache is read-only in this tab');
        await compact();
        reply({ ok: true, slabSize, wasted });
        break;
      case 'clear':
        if (readOnly) throw new Error('the cache is read-only in this tab');
        await clearAll();
        reply({ ok: true });
        break;
      case 'ping':
        reply({ ok: true, opfsError, readOnly });
        break;
      case 'cached': {
        // which of these URLs hold at least one cached chunk (the query-time download guard)
        const list = (rest.urls ?? []) as string[];
        const cached = list.filter((u) => {
          try {
            const e = files.get(cacheKey(u));
            return !!e && e.chunks.size > 0;
          } catch {
            return false;
          }
        });
        reply({ ok: true, cached });
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
}

function attachControlPort(port: MessagePort) {
  port.onmessage = (ev) => {
    const id = (ev.data as { id?: string } | null)?.id;
    void handleControl(ev.data, (payload) => port.postMessage({ id, ...payload }));
  };
}

// ---------- boot ----------

// The page's first message carries the control port; everything else is duckdb-wasm traffic,
// buffered until the duckdb-wasm worker bundle has installed its own onmessage handler.
const isPortMessage = (ev: MessageEvent) => (ev.data as { type?: string } | null)?.type === 'ddv-cache-port' && ev.ports.length > 0;
const buffered: MessageEvent[] = [];
self.onmessage = (ev: MessageEvent) => {
  if (isPortMessage(ev)) attachControlPort(ev.ports[0]);
  else buffered.push(ev);
};

void (async () => {
  await initOpfs();
  (self as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = CachingXHR;
  importScripts(new URL('/duckdb/duckdb-browser-eh.worker.js', self.location.href).href);
  const duck = self.onmessage as ((ev: MessageEvent) => void) | null;
  self.onmessage = (ev: MessageEvent) => {
    if (isPortMessage(ev)) attachControlPort(ev.ports[0]);
    else duck?.(ev);
  };
  for (const ev of buffered) duck?.(ev);
  buffered.length = 0;
})();
