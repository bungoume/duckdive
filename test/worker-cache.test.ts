import { afterEach, describe, expect, it, vi } from 'vitest';
import { checksum, rawHeaders } from '../src/worker/cache-util';

/** Boot the real cache worker against an in-memory OPFS slab and a controllable origin. */
async function bootCache(status: number, body: string, etag: string, readOnly = false) {
  vi.useFakeTimers();
  vi.resetModules();
  const url = 'https://logs.example.com/data';
  const bytes = new TextEncoder().encode(body);
  const disk = new Uint8Array(128);
  disk.set(new TextEncoder().encode('AAAA'));
  const slab = {
    getSize: () => 4,
    read: (buf: Uint8Array, { at }: { at: number }) => {
      buf.set(disk.subarray(at, at + buf.length));
      return buf.length;
    },
    write: vi.fn((buf: Uint8Array, { at }: { at: number }) => {
      disk.set(buf, at);
      return buf.length;
    }),
    flush: () => undefined,
  };
  const index = {
    version: 2,
    slabSize: 4,
    wasted: 0,
    files: { [url]: { key: url, size: 8, etag: 'old', chunkSize: 4, seenAt: Date.now(), chunks: [[0, 0, 4, checksum(disk.subarray(0, 4))]] } },
    ext: {},
    config: { enabled: true },
  };
  const dir = {
    removeEntry: async () => undefined,
    getFileHandle: async (name: string) =>
      name === 'index.json'
        ? { getFile: async () => ({ text: async () => JSON.stringify(index) }), createWritable: async () => ({ write: async () => undefined, close: async () => undefined }) }
        : { createSyncAccessHandle: async () => slab },
  };
  class OriginXHR {
    status = status;
    statusText = '';
    response: ArrayBuffer | null = null;
    private range = '';
    private headers = {};
    open() {}
    setRequestHeader(name: string, value: string) {
      if (name === 'range') this.range = value;
    }
    send() {
      const [, start, end] = /bytes=(\d+)-(\d+)/.exec(this.range)!;
      this.response = (status === 206 ? bytes.slice(+start, +end + 1) : bytes).buffer;
      this.headers = { etag, 'content-length': String(this.response.byteLength), ...(status === 206 ? { 'content-range': `bytes ${start}-${end}/${bytes.length}` } : {}) };
    }
    getAllResponseHeaders() {
      return rawHeaders(this.headers);
    }
  }
  const worker = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    XMLHttpRequest: OriginXHR as unknown as typeof XMLHttpRequest,
    location: { origin: 'chrome-extension://test', href: 'chrome-extension://test/worker.js' },
  };
  vi.stubGlobal('self', worker);
  vi.stubGlobal('navigator', {
    locks: { request: (_name: string, _options: unknown, callback: (lock: object) => Promise<void>) => (readOnly ? Promise.reject(new Error('held by another tab')) : callback({})) },
    storage: { getDirectory: async () => ({ getDirectoryHandle: async () => dir }) },
  });
  const booted = vi.fn();
  vi.stubGlobal('importScripts', booted);
  await import('../src/worker/duckdb-cache-worker');
  await vi.waitFor(() => expect(booted).toHaveBeenCalledOnce());
  const control = (data: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const port = { onmessage: null as ((event: MessageEvent) => void) | null, postMessage: resolve };
      worker.onmessage!({ data: { type: 'ddv-cache-port' }, ports: [port] } as unknown as MessageEvent);
      port.onmessage!({ data: { id: 'test', ...data } } as MessageEvent);
    });
  return { worker, control, slab };
}

async function cachedRequest(status: number, body: string, etag: string) {
  const { worker } = await bootCache(status, body, etag);
  const url = 'https://logs.example.com/data';
  const xhr = new worker.XMLHttpRequest();
  xhr.open('GET', url, false);
  xhr.responseType = 'arraybuffer';
  xhr.setRequestHeader('Range', 'bytes=0-7');
  xhr.send();
  return { status: xhr.status, body: new TextDecoder().decode(xhr.response), etag: xhr.getResponseHeader('etag') };
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('range cache object replacement', () => {
  it.each([200, 206])('discards old chunks when a %i response has a new ETag', async (status) => {
    expect(await cachedRequest(status, 'BBBBBBBB', 'new')).toEqual({ status: 206, body: 'BBBBBBBB', etag: 'new' });
  });

  it('updates the size too when a server ignores Range for a larger replacement', async () => {
    expect(await cachedRequest(200, 'BBBBBBBBBBBB', 'new')).toEqual({ status: 206, body: 'BBBBBBBB', etag: 'new' });
  });

  it('continues serving unchanged objects when the origin ignores Range', async () => {
    expect(await cachedRequest(200, 'AAAABBBB', 'old')).toEqual({ status: 206, body: 'AAAABBBB', etag: 'old' });
  });

  it('passes an authorization failure through instead of returning cached success', async () => {
    expect((await cachedRequest(403, 'denied', 'error')).status).toBe(403);
  });
});

it('refuses cache mutations in a read-only tab, including a lower size limit', async () => {
  const { control, slab } = await bootCache(206, 'AAAABBBB', 'old', true);
  const before = await control({ type: 'files' });
  for (const command of [{ type: 'config', config: { maxBytes: 1 } }, { type: 'compact' }, { type: 'clear' }, { type: 'purge', url: 'https://logs.example.com/data' }]) {
    expect(await control(command)).toMatchObject({ ok: false, error: expect.stringContaining('read-only') });
  }
  await vi.advanceTimersByTimeAsync(20_000);
  expect(await control({ type: 'files' })).toEqual(before);
  expect(slab.write).not.toHaveBeenCalled();
});

describe('single-file cache budget', () => {
  it.each([4, 6, 8, 0])('serves complete responses within a %i-byte cache budget (0 is unlimited)', async (maxBytes) => {
    const { worker, control } = await bootCache(206, 'AAAABBBB', 'old');
    await control({ type: 'config', config: { maxBytes } });
    const read = () => {
      const xhr = new worker.XMLHttpRequest();
      xhr.open('GET', 'https://logs.example.com/data', false);
      xhr.responseType = 'arraybuffer';
      xhr.setRequestHeader('Range', 'bytes=0-7');
      xhr.send();
      expect(xhr.status).toBe(206);
      expect(new TextDecoder().decode(xhr.response)).toBe('AAAABBBB');
    };
    read();
    read(); // an uncached tail remains readable on subsequent requests
    const result = await control({ type: 'files' });
    expect(result.summary).toMatchObject({ cachedBytes: maxBytes && maxBytes < 8 ? 4 : 8, slabSize: maxBytes && maxBytes < 8 ? 4 : 8 });
  });
});
