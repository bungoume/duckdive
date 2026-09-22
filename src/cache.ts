// Page-side client for the range cache living inside the DuckDB worker (src/worker/duckdb-cache-worker.ts).
import { expose } from './debug';

import type { CacheConfig, CacheRequests, CacheResponses, SeedFile } from './cacheProtocol';

/**
 * The control channel is a MessageChannel: this page keeps one port, the other one is handed
 * to the DuckDB worker (duck.ts, `cacheWorkerPort()`) as its first message. Messages posted
 * before the worker listens are queued by the port.
 */
const { port1: port, port2: workerPort } = new MessageChannel();
let portHandedOver = false;

/** The worker's end of the channel; transfer it to the worker exactly once. */
export function cacheWorkerPort(): MessagePort {
  if (portHandedOver) throw new Error('cache worker port already handed over');
  portHandedOver = true;
  return workerPort;
}

const waiting = new Map<
  string,
  { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
>();
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

function send<K extends keyof CacheRequests>(
  type: K,
  payload: CacheRequests[K],
  timeoutMs = 5000,
): Promise<CacheResponses[K]> {
  const id = Math.random().toString(36).slice(2);
  return new Promise<CacheResponses[K]>((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error('cache worker did not answer'));
    }, timeoutMs);
    waiting.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    port.postMessage({ id, type, ...payload });
  });
}

export const cachePing = () => send('ping', {}, 15000);
/** Seed metadata from listings to avoid a HEAD request for every file. */
export const cacheSeed = (files: SeedFile[]) => send('seed', { files }, 60000);
export const cacheCached = (urls: string[]) => send('cached', { urls }, 30000);
export const cacheStats = () => send('stats', {});
export const cacheFiles = (opts: { limit?: number; all?: boolean } = {}) => send('files', opts, 30000);
export const cacheCompact = () => send('compact', {}, 600000);
export const cacheClear = () => send('clear', {}, 30000);
export const cachePurge = (url: string) => send('purge', { url });
export const cacheSetConfig = (config: Partial<CacheConfig>) => send('config', { config });

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

expose({
  cacheStats,
  cacheFiles,
  cacheClear,
  cachePurge,
  cacheSetConfig,
  storageEstimate,
  cachePing,
  cacheCompact,
  cacheSeed,
});
