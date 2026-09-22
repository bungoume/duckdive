import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const connection = vi.hoisted(() => ({ query: vi.fn(), send: vi.fn(), cancelSent: vi.fn() }));
vi.mock('@duckdb/duckdb-wasm', () => ({
  VoidLogger: class {},
  AsyncDuckDB: class {
    async instantiate() {}
    async open() {}
    async connect() {
      return connection;
    }
  },
  DuckDBDataProtocol: {},
}));
vi.mock('../src/worker/duckdb-cache-worker?worker', () => ({
  default: class {
    postMessage() {}
  },
}));
vi.mock('../src/cache', () => ({ cacheWorkerPort: () => ({}) }));

import { exec, initDuckDB, query } from '../src/duck';
import { CancelledError } from '../src/net';

beforeAll(() => initDuckDB());
beforeEach(() => {
  connection.query.mockReset().mockResolvedValue(undefined);
  connection.send.mockReset().mockImplementation(async () => (async function* () {})());
  connection.cancelSent.mockReset().mockResolvedValue(undefined);
});

describe('query cancellation', () => {
  it('skips cancelled queued SQL and still runs the next owner', async () => {
    let release!: () => void;
    connection.query.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const blocking = exec('BLOCK');
    await Promise.resolve();
    const controller = new AbortController();
    const obsolete = query('old search', controller.signal);
    const rejected = expect(obsolete).rejects.toBeInstanceOf(CancelledError);
    const next = query('next search');
    controller.abort();
    release();
    await Promise.all([blocking, rejected, next]);
    expect(connection.send.mock.calls).toEqual([['next search']]);
    expect(connection.cancelSent).not.toHaveBeenCalled();
  });

  it('discards a cancelled stream and waits for cancellation before starting another query', async () => {
    let release!: () => void;
    let started!: () => void;
    let cancelled!: () => void;
    const reached = new Promise<void>((resolve) => {
      started = resolve;
    });
    connection.send.mockImplementationOnce(async () =>
      (async function* () {
        started();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        yield { schema: { fields: [] }, *[Symbol.iterator]() {} };
      })(),
    );
    connection.cancelSent.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          cancelled = resolve;
        }),
    );
    const controller = new AbortController();
    const first = query('first', controller.signal);
    const rejected = expect(first).rejects.toBeInstanceOf(CancelledError);
    await reached;
    const next = query('next');
    controller.abort();
    release();
    await Promise.resolve();
    expect(connection.send).toHaveBeenCalledOnce();
    cancelled();
    await Promise.all([rejected, next]);
    expect(connection.send.mock.calls).toEqual([['first'], ['next']]);
  });
});
