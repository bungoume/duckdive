// Page-side client for the range cache living inside the DuckDB worker (src/worker/duckdb-cache-worker.ts).
import { expose } from './debug';

export interface CacheStats {
  requests: number;
  passthrough: number;
  chunkHits: number;
  chunkMisses: number;
  bytesFromCache: number;
  bytesFromNetwork: number;
  bytesDownloaded: number;
  headsSynthesized: number;
  headsNetwork: number;
  corruptions: number;
  /** files dropped to stay within the size limit (this session) */
  evictions: number;
  files: Record<string, { hits: number; misses: number; bytesFromCache: number; bytesFromNetwork: number; bytesDownloaded: number }>;
  log: CacheLogEntry[];
}

/** One request as seen by the worker (see LogEntry in the worker). */
export interface CacheLogEntry {
  t: number;
  method: string;
  url: string;
  range: string | null;
  outcome: string;
  status?: number;
  bytes?: number;
  enc?: string;
  head?: string;
}

export interface CacheConfig {
  enabled: boolean;
  chunkSize: number;
  /** re-pack concatenated gzip objects into single-member gzip at connect time (src/gznorm.ts) */
  normalizeGzip: boolean;
  /** cached data allowed on disk; 0 = no limit. Beyond it whole files are dropped, least recently used first */
  maxBytes: number;
}

export interface CachedFile {
  url: string;
  size: number;
  etag: string;
  cachedChunks: number;
  cachedBytes: number;
  chunkSize: number;
  /** original object size when the cached bytes are a re-packed copy */
  repacked?: number;
}

/**
 * The control channel is a MessageChannel: this page keeps one port, the other one is handed
 * to the DuckDB worker (duck.ts, `cacheWorkerPort()`) as its first message. Messages posted
 * before the worker listens are queued by the port, and large payloads (a whole object for
 * `store`) are transferred instead of copied.
 */
const { port1: port, port2: workerPort } = new MessageChannel();
let portHandedOver = false;

/** The worker's end of the channel; transfer it to the worker exactly once. */
export function cacheWorkerPort(): MessagePort {
  if (portHandedOver) throw new Error('cache worker port already handed over');
  portHandedOver = true;
  return workerPort;
}

const waiting = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
port.onmessage = (ev) => {
  const d = ev.data as { id?: string; ok?: boolean; error?: string };
  if (!d?.id) return;
  const w = waiting.get(d.id);
  if (!w) return;
  waiting.delete(d.id);
  clearTimeout(w.timer);
  if (d.ok === false) w.reject(new Error(d.error ?? 'cache error'));
  else w.resolve(d);
};

function send<T>(msg: Record<string, unknown>, timeoutMs = 5000, transfer: Transferable[] = []): Promise<T> {
  const id = Math.random().toString(36).slice(2);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error('cache worker did not answer'));
    }, timeoutMs);
    waiting.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    port.postMessage({ id, ...msg }, transfer);
  });
}

export const cachePing = () => send<{ opfsError: string | null }>({ type: 'ping' }, 15000);
export interface SeedFile {
  url: string;
  size: number;
  etag: string;
  lastModified?: string;
  /** bucket / key when the object came from an S3 listing (lets the page fetch it signed) */
  s3?: { bucket: string; key: string };
}
/** Hand listing metadata to the cache worker so DuckDB's per-file HEADs are answered locally. */
export const cacheSeed = (files: SeedFile[]) => send<{ seeded: number }>({ type: 'seed', files }, 60000);
/** Store a complete copy of an object (fetched by the page); `repacked` marks a re-compressed gzip. The buffer is transferred, not copied. */
export const cacheStore = (f: { url: string; etag: string; lastModified?: string; bytes: ArrayBuffer; repacked: boolean; origSize: number; note?: string }) =>
  send<{ chunks: number }>({ type: 'store', ...f }, 60000, [f.bytes]);
/** URLs among `urls` that hold at least one cached chunk (they were downloaded before). */
export const cacheCached = (urls: string[]) => send<{ cached: string[] }>({ type: 'cached', urls }, 30000);
/** URLs among `files` that are already completely cached with the same ETag. */
export const cacheComplete = (files: { url: string; etag: string }[]) => send<{ complete: string[] }>({ type: 'complete', files }, 30000);
export const cacheStats = () => send<{ stats: CacheStats; config: CacheConfig; opfsError: string | null }>({ type: 'stats' });
export interface CacheSummary {
  /** files with known metadata (seeded from listings or HEADs) */
  known: number;
  cachedFiles: number;
  cachedBytes: number;
  slabSize: number;
  wasted: number;
}
export const cacheFiles = (opts: { limit?: number; all?: boolean } = {}) => send<{ files: CachedFile[]; summary: CacheSummary }>({ type: 'files', ...opts }, 30000);
export const cacheCompact = () => send<{ slabSize: number; wasted: number }>({ type: 'compact' }, 600000);
export const cacheClear = () => send({ type: 'clear' }, 30000);
export const cachePurge = (url: string) => send<{ removed: number }>({ type: 'purge', url });
export const cacheSetConfig = (config: Partial<CacheConfig>) => send<{ config: CacheConfig }>({ type: 'config', config });

export async function storageEstimate(): Promise<{ usage: number; quota: number; persisted: boolean } | null> {
  if (!navigator.storage?.estimate) return null;
  const e = await navigator.storage.estimate();
  const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
  return { usage: e.usage ?? 0, quota: e.quota ?? 0, persisted };
}

export async function requestPersist(): Promise<boolean> {
  return navigator.storage?.persist ? navigator.storage.persist() : false;
}

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n)) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

expose({ cacheStats, cacheFiles, cacheClear, cachePurge, cacheSetConfig, storageEstimate, cachePing, cacheCompact, cacheSeed });
