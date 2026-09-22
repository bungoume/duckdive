import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const run = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@duckdb/duckdb-wasm', () => ({
  VoidLogger: class {},
  AsyncDuckDB: class {
    async instantiate() {}
    async open() {}
    async connect() {
      return { query: run };
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

import { exec, execAll, initDuckDB } from '../src/duck';
import { applyS3 } from '../src/datasource';
import { DEFAULT_SOURCE } from '../src/sources';

beforeAll(() => initDuckDB());
beforeEach(() => run.mockClear());

describe('queued credentials', () => {
  it('checks the connection again when a queued refresh reaches DuckDB', async () => {
    let release!: () => void;
    run.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
    const blocking = exec('BLOCK');
    await Promise.resolve();
    let current = true;
    const refresh = applyS3(DEFAULT_SOURCE, null, () => current);
    current = false;
    release();
    await Promise.all([blocking, refresh]);
    expect(run.mock.calls.map(([sql]) => sql)).toEqual(['BLOCK']);
  });

  it('still applies a current credential set without interleaving other statements', async () => {
    await Promise.all([execAll(['key', 'secret', 'token'], undefined, () => true), exec('query')]);
    expect(run.mock.calls.map(([sql]) => sql)).toEqual(['key', 'secret', 'token', 'query']);
  });
});
