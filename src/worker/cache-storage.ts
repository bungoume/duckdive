import { checksum, evictionPlan, hashName } from './cache-util';
import type { CacheStats, CacheLogEntry } from '../cacheProtocol';

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
export interface CacheEntry extends FileMeta {
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

export function createCacheStorage(
  stats: Pick<CacheStats, 'evictions' | 'corruptions'>,
  log: (entry: Omit<CacheLogEntry, 't'>) => CacheLogEntry,
) {
  const INDEX_VERSION = 2;
  let slab: FileSystemSyncAccessHandle | null = null;
  let slabSize = 0;
  let wasted = 0;
  const COMPACT_MIN_WASTE = 64 * 1024 * 1024;
  const DIR = 'ddv-cache';
  /** maxBytes: cached data allowed on disk (0 = no limit); beyond it whole files go, least recently used first */
  const config = { enabled: true, chunkSize: 1024 * 1024, maxBytes: 4 * 1024 * 1024 * 1024 };
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
          for (const [i, off, len, sum] of meta.chunks ?? [])
            if (off + len <= slabSize) entry.chunks.set(i, { off, len, sum: sum ?? 0 });
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
  function openSync(
    fh: FileSystemFileHandle,
    mode: 'readwrite' | 'readwrite-unsafe',
  ): Promise<FileSystemSyncAccessHandle> {
    return (
      fh as unknown as { createSyncAccessHandle(o?: { mode: string }): Promise<FileSystemSyncAccessHandle> }
    ).createSyncAccessHandle({ mode });
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
      for (const [i, off, len, sum] of meta.chunks ?? [])
        if (off + len <= slabSize) entry.chunks.set(i, { off, len, sum: sum ?? 0 });
      entry.size = meta.size;
      entry.etag = meta.etag;
      // the owner may use a different chunk size; keeping ours would read every chunk as wrong-length
      entry.chunkSize = meta.chunkSize;
      files.set(meta.key, entry);
    }
    for (const [k, e] of files) if (!listed.has(k)) e.chunks.clear();
  }

  function newEntry(meta: FileMeta): CacheEntry {
    return {
      ...meta,
      chunks: new Map(),
      stat: { hits: 0, misses: 0, bytesFromCache: 0, bytesFromNetwork: 0, bytesDownloaded: 0 },
    };
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
      index.files[k] = {
        key: e.key,
        size: e.size,
        etag: e.etag,
        chunkSize: e.chunkSize,
        seenAt: e.seenAt,
        usedAt: e.usedAt,
        lastModified: e.lastModified,
        chunks,
      };
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
  function enforceLimit(keep: CacheEntry | null, incoming = 0) {
    if (!config.maxBytes || liveBytes() + incoming <= config.maxBytes) return;
    const candidates = [...files.values()]
      .filter((e) => e !== keep && e.chunks.size)
      .map((e) => ({ entry: e, seenAt: e.seenAt, usedAt: e.usedAt, bytes: cachedBytesOf(e) }));
    for (const c of evictionPlan(candidates, liveBytes() + incoming, config.maxBytes * 0.8)) {
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

  /** Compact a little later, once the burst of writes that caused the evictions has passed. */
  function scheduleCompact() {
    if (readOnly) return;
    if (compactTimer) return;
    compactTimer = setTimeout(() => {
      compactTimer = null;
      if (!compactRun && needsCompaction()) void compact();
    }, 10_000);
  }

  function writeChunk(entry: CacheEntry, idx: number, buf: Uint8Array) {
    if (!slab || readOnly) return;
    // Evict other files before reserving disk space. A single large object can fill the budget
    // on its own; serve its remaining chunks from the network without retaining them.
    if (config.maxBytes && buf.byteLength > config.maxBytes) return;
    enforceLimit(entry, buf.byteLength);
    if (config.maxBytes && liveBytes() + buf.byteLength > config.maxBytes) return;
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
      if (needsCompaction()) scheduleCompact();
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
    const bad =
      n !== ref.len
        ? 'short-read'
        : ref.len !== expectedChunkLen(entry, idx)
          ? 'wrong-length'
          : ref.sum && checksum(buf) !== ref.sum
            ? 'checksum'
            : null;
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
    if (!dir || !slab || readOnly) return;
    if (compactRun) return compactRun;
    compactRun = compactSlab().finally(() => {
      compactRun = null;
    });
    return compactRun;
  }

  /** Wait for a running compaction: it closes the slab for a moment and moves every chunk. */
  const settleCompaction = (): Promise<void> => compactRun ?? Promise.resolve();

  async function compactSlab(): Promise<void> {
    if (!dir || !slab || readOnly) return;
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

  function readExtension(url: string): Uint8Array | null {
    const rec = extFiles.get(url);
    if (!rec?.handle || rec.size <= 0 || rec.handle.getSize() !== rec.size) return null;
    const bytes = new Uint8Array(rec.size);
    return rec.handle.read(bytes, { at: 0 }) === rec.size ? bytes : null;
  }
  async function writeExtension(url: string, body: ArrayBuffer): Promise<void> {
    if (!dir || readOnly) return;
    const bytes = new Uint8Array(body.slice(0));
    const target = extFiles.get(url) ?? { name: hashName(url) + '.wasm', size: 0, handle: null, opening: null };
    extFiles.set(url, target);
    try {
      await openExt(target);
      if (!target.handle) return;
      target.handle.truncate(0);
      target.handle.write(bytes, { at: 0 });
      target.handle.flush();
      target.size = bytes.byteLength;
      scheduleSaveIndex();
    } catch (error) {
      console.warn('[ddv-cache] extension cache write failed', error);
    }
  }
  return {
    config,
    files,
    initOpfs,
    readChunk,
    writeChunk,
    resetEntry,
    recordMeta,
    dropChunks,
    cachedBytesOf,
    enforceLimit,
    scheduleSaveIndex,
    saveIndex,
    purgeEntry,
    compact,
    clearAll,
    readExtension,
    writeExtension,
    get opfsError() {
      return opfsError;
    },
    get readOnly() {
      return readOnly;
    },
    get slabSize() {
      return slabSize;
    },
    get wasted() {
      return wasted;
    },
  };
}
