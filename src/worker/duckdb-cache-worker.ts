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
 * (src/cache.ts); cacheProtocol.ts defines its requests and replies.
 */

import {
  cacheKey,
  etagFrom,
  hexHead,
  looksGzip,
  parseRange,
  rawHeaders,
  totalSizeFrom,
  type HeaderMap,
  type NativeResult,
} from './cache-util';

declare function importScripts(...urls: string[]): void;

import { createCacheStorage, type CacheEntry } from './cache-storage';
import { createNativeRequest, WHOLE_FILE_TIMEOUT_MS } from './cache-network';
import { createCachingXHR } from './cache-xhr';
import type { CacheLogEntry as LogEntry, CacheRequest, CacheReply, CacheStats } from '../cacheProtocol';

const NativeXHR = self.XMLHttpRequest;
const nativeSync = createNativeRequest(NativeXHR);
/**
 * HEAD requests are answered locally while the file's metadata is this fresh. Metadata comes
 * from the page's ListObjectsV2 results (seeded before the view is created) or from a real
 * HEAD; duckdb-wasm issues one HEAD per file every time the view is bound, so without this a
 * 10,000-file source costs 10,000 sequential requests per query. A long window is safe: every
 * chunk GET checks the ETag, and an object replaced meanwhile resets its entry (new size and
 * ETag) so the next HEAD is answered correctly after one failed query.
 */
const HEAD_FRESH_MS = 6 * 3600_000;

const LOG_SIZE = 300;
const stats: Omit<CacheStats, 'files'> = {
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
  log({
    method: 'GET',
    url,
    range,
    outcome: `net:${res.status}`,
    status: res.status,
    bytes: res.body?.byteLength,
    enc: enc || undefined,
    head: offset === 0 ? hexHead(res.body) : undefined,
  });
}

const storage = createCacheStorage(stats, log);
const {
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
} = storage;

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

function handleRangeGet(
  url: string,
  headers: HeaderMap,
  rangeHeader: string,
  retry = true,
  retryEtag = true,
): NativeResult {
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
      // Validate every successful response before slicing or combining it with cached bytes.
      if ((res.status === 200 || res.status === 206) && res.body) {
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
      }
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
        buf = new Uint8Array(res.body);
      }
      if (buf.byteLength !== chunkEnd - chunkStart + 1) {
        // a truncated body would leave a hole in the assembled range: answer this request
        // straight from the origin and cache nothing
        stats.passthrough++;
        log({
          method: 'GET',
          url,
          range: rangeHeader,
          outcome: `short-body:${buf.byteLength}/${chunkEnd - chunkStart + 1}`,
        });
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
  const cached = storage.readExtension(url);
  if (cached) {
    log({ method: 'GET', url, range: null, outcome: 'extension-cache' });
    const headers: HeaderMap = {
      'content-type': 'application/wasm',
      'content-length': String(cached.byteLength),
      'x-ddv-cache': 'extension',
    };
    return {
      status: 200,
      statusText: 'OK',
      headers,
      rawHeaders: rawHeaders(headers),
      body: cached.buffer as ArrayBuffer,
    };
  }
  const response = nativeSync('GET', url, headers, true, WHOLE_FILE_TIMEOUT_MS);
  if (response.status === 200 && response.body) void storage.writeExtension(url, response.body);
  return response;
}

const CachingXHR = createCachingXHR(NativeXHR, self.location.origin, {
  available: () => config.enabled && !storage.opfsError,
  log,
  onFallback: () => {
    stats.passthrough++;
  },
  handle(method, url, headers) {
    stats.requests++;
    if (method === 'HEAD') return handleHead(url, headers);
    return headers.range ? handleRangeGet(url, headers, headers.range) : handleExtensionGet(url, headers);
  },
});

// ---------- control channel ----------

/** Serve one control request from the page; `reply` answers it on the same port. */
async function handleControl(data: unknown, reply: (payload: CacheReply) => void) {
  const command = (data ?? {}) as CacheRequest;
  const { id, type } = command;
  if (!id || !type) return;
  try {
    switch (command.type) {
      case 'stats': {
        // per-file counters only for files that saw traffic (a source may have 10,000+ entries)
        const filesStat: Record<string, CacheEntry['stat']> = {};
        let n = 0;
        for (const [k, e] of files) {
          if (!e.stat.hits && !e.stat.misses) continue;
          filesStat[k] = e.stat;
          if (++n >= 200) break;
        }
        reply({
          ok: true,
          stats: { ...stats, files: filesStat },
          config: { ...config },
          opfsError: storage.opfsError,
          readOnly: storage.readOnly,
        });
        break;
      }
      case 'config': {
        if (storage.readOnly) throw new Error('the cache is read-only in this tab');
        const c = command.config;
        if (typeof c.enabled === 'boolean') config.enabled = c.enabled;
        if (typeof c.chunkSize === 'number' && c.chunkSize >= 64 * 1024) config.chunkSize = c.chunkSize;
        if (typeof c.maxBytes === 'number' && c.maxBytes >= 0) config.maxBytes = Math.floor(c.maxBytes);
        enforceLimit(null);
        await saveIndex();
        reply({ ok: true, config: { ...config } });
        break;
      }
      case 'files': {
        // only files holding data, largest first; `limit` (default 100) or `all: true`
        const limit = typeof command.limit === 'number' ? command.limit : 100;
        const list: {
          url: string;
          size: number;
          etag: string;
          cachedChunks: number;
          cachedBytes: number;
          chunkSize: number;
        }[] = [];
        let cachedBytes = 0;
        for (const e of files.values()) {
          if (!e.chunks.size) continue;
          const bytes = cachedBytesOf(e);
          cachedBytes += bytes;
          list.push({
            url: e.key,
            size: e.size,
            etag: e.etag,
            cachedChunks: e.chunks.size,
            cachedBytes: bytes,
            chunkSize: e.chunkSize,
          });
        }
        list.sort((a, b) => b.cachedBytes - a.cachedBytes);
        reply({
          ok: true,
          files: command.all === true ? list : list.slice(0, limit),
          summary: {
            known: files.size,
            cachedFiles: list.length,
            cachedBytes,
            slabSize: storage.slabSize,
            wasted: storage.wasted,
          },
        });
        break;
      }
      case 'purge':
        if (storage.readOnly) throw new Error('the cache is read-only in this tab');
        reply({ ok: true, removed: (await purgeEntry(cacheKey(String(command.url)))) ? 1 : 0 });
        break;
      case 'compact':
        if (storage.readOnly) throw new Error('the cache is read-only in this tab');
        await compact();
        reply({ ok: true, slabSize: storage.slabSize, wasted: storage.wasted });
        break;
      case 'clear':
        if (storage.readOnly) throw new Error('the cache is read-only in this tab');
        await clearAll();
        reply({ ok: true, cleared: true });
        break;
      case 'ping':
        reply({ ok: true, opfsError: storage.opfsError, readOnly: storage.readOnly });
        break;
      case 'cached': {
        // which of these URLs hold at least one cached chunk (the query-time download guard)
        const list = command.urls ?? [];
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
        const list = command.files ?? [];
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
const isPortMessage = (ev: MessageEvent) =>
  (ev.data as { type?: string } | null)?.type === 'ddv-cache-port' && ev.ports.length > 0;
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
