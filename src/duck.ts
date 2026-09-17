import * as duckdb from '@duckdb/duckdb-wasm';
import { cacheWorkerPort } from './cache';
import CacheWorker from './worker/duckdb-cache-worker?worker';

export type Row = Record<string, unknown>;

let db: duckdb.AsyncDuckDB | null = null;
let conn: duckdb.AsyncDuckDBConnection | null = null;
let initPromise: Promise<void> | null = null;

export async function initDuckDB(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    // The worker wraps the stock duckdb-wasm worker (public/duckdb/) with the OPFS range cache;
    // its first message hands over the page's end of the cache control channel (src/cache.ts).
    const worker = new CacheWorker();
    const port = cacheWorkerPort();
    worker.postMessage({ type: 'ddv-cache-port' }, [port]);
    const logger = new duckdb.VoidLogger();
    db = new duckdb.AsyncDuckDB(logger, worker);
    await db.instantiate(new URL('/duckdb/duckdb-eh.wasm', location.href).href);
    // Force HTTP range reads: with the defaults duckdb-wasm downloads whole files.
    await db.open({
      filesystem: { reliableHeadRequests: true, allowFullHTTPReads: false, forceFullHTTPReads: false },
    });
    conn = await db.connect();
    // All naive timestamps are interpreted as UTC. Display conversion happens in the browser.
    // (Setting TimeZone needs the icu extension; without it DuckDB-Wasm already behaves as UTC.)
    try {
      await conn.query(`SET TimeZone='UTC'`);
    } catch {
      /* icu not available: default is UTC */
    }
    // DuckDB 1.3+ has an in-memory cache of remote file bytes; the OPFS range cache in the worker
    // serves that purpose persistently and with ETag checks, so it is switched off to spare the
    // wasm heap. Note that DuckDB-Wasm 1.4 still keeps Parquet footers and blocks it has read
    // for the session regardless of this setting (see e2e/cache.mjs, the STS check).
    try {
      await conn.query(`SET enable_external_file_cache = false`);
    } catch {
      /* older DuckDB without the setting */
    }
  })();
  return initPromise;
}

export function getDB(): duckdb.AsyncDuckDB {
  if (!db) throw new Error('DuckDB is not initialised');
  return db;
}

export function getConn(): duckdb.AsyncDuckDBConnection {
  if (!conn) throw new Error('DuckDB is not initialised');
  return conn;
}

export const DataProtocol = duckdb.DuckDBDataProtocol;

/** Convert an Arrow value to a plain JS value that is safe for JSON / display. */
export function toPlain(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') {
    return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
  }
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) return `<${v.length} bytes>`;
  if (Array.isArray(v)) return v.map(toPlain);
  if (typeof v === 'object') {
    const o = v as { toArray?: () => unknown[]; toJSON?: () => unknown };
    if (typeof o.toArray === 'function') return o.toArray().map(toPlain);
    if (typeof o.toJSON === 'function') return toPlain(o.toJSON());
    const out: Row = {};
    for (const [k, val] of Object.entries(v as Row)) out[k] = toPlain(val);
    return out;
  }
  return v;
}

interface ArrowTableLike {
  schema: { fields: { name: string }[] };
  [Symbol.iterator](): Iterator<Record<string, unknown>>;
}

export function tableToRows(t: ArrowTableLike): Row[] {
  const names = t.schema.fields.map((f) => f.name);
  const rows: Row[] = [];
  for (const r of t) {
    const o: Row = {};
    for (const n of names) o[n] = toPlain(r[n]);
    rows.push(o);
  }
  return rows;
}

export interface QueryResult {
  rows: Row[];
  columns: string[];
  ms: number;
}

const queryLog: { sql: string; ms: number; error?: string }[] = [];
export function getQueryLog() {
  return queryLog;
}

/** Thrown for queries abandoned by cancelAllQueries(); callers should ignore it silently. */
export class QueryCancelled extends Error {
  constructor() {
    super('Query cancelled');
    this.name = 'QueryCancelled';
  }
}

// Statements run one at a time through a chain (DuckDB allows one pending query per
// connection). Queries use send() so the worker executes them in small steps and stays
// responsive (cache messages are answered, cancelSent() takes effect between steps).
let chain: Promise<unknown> = Promise.resolve();
let generation = 0;
let running = 0;

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn);
  chain = p.then(
    () => undefined,
    () => undefined,
  );
  return p;
}

export async function query(sql: string): Promise<QueryResult> {
  const gen = generation;
  return enqueue(async () => {
    if (gen !== generation) throw new QueryCancelled();
    const c = getConn();
    const t0 = performance.now();
    running++;
    try {
      const reader = await c.send(sql);
      const rows: Row[] = [];
      let columns: string[] = [];
      for await (const batch of reader as unknown as AsyncIterable<ArrowTableLike>) {
        if (!columns.length) columns = batch.schema.fields.map((f) => f.name);
        rows.push(...tableToRows(batch));
      }
      if (!columns.length) {
        const sch = (reader as unknown as { schema?: { fields: { name: string }[] } }).schema;
        if (sch) columns = sch.fields.map((f) => f.name);
      }
      // a cancelled stream ends early with a partial result: never hand that out as complete
      if (gen !== generation) throw new QueryCancelled();
      const ms = performance.now() - t0;
      queryLog.unshift({ sql, ms });
      if (queryLog.length > 50) queryLog.pop();
      return { rows, columns, ms };
    } catch (e) {
      const ms = performance.now() - t0;
      if (gen !== generation || /cancel|interrupt/i.test(String(e))) {
        queryLog.unshift({ sql, ms, error: 'cancelled' });
        throw new QueryCancelled();
      }
      queryLog.unshift({ sql, ms, error: String(e) });
      if (queryLog.length > 50) queryLog.pop();
      throw e;
    } finally {
      running--;
    }
  });
}

export async function exec(sql: string): Promise<void> {
  await enqueue(() => getConn().query(sql));
}

/**
 * Abandon every query that is running or queued (e.g. before the source view is replaced):
 * queued ones are rejected, the running one is interrupted between execution steps.
 */
export async function cancelAllQueries(maxWaitMs = 10_000): Promise<void> {
  generation++;
  if (!conn) return;
  const t0 = performance.now();
  while (running > 0 && performance.now() - t0 < maxWaitMs) {
    try {
      await conn.cancelSent();
    } catch {
      /* nothing pending */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

export function queriesRunning(): number {
  return running;
}
