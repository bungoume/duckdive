import { afterEach, describe, expect, it, vi } from 'vitest';
import { checksum, rawHeaders } from '../src/worker/cache-util';

/** Boot the real cache worker against an in-memory OPFS slab and a controllable origin. */
async function cachedRequest(status: number, body: string, etag: string) {
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
    write: (buf: Uint8Array, { at }: { at: number }) => {
      disk.set(buf, at);
      return buf.length;
    },
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
  const worker = { XMLHttpRequest: OriginXHR as unknown as typeof XMLHttpRequest, location: { origin: 'chrome-extension://test', href: 'chrome-extension://test/worker.js' } };
  vi.stubGlobal('self', worker);
  vi.stubGlobal('navigator', {
    locks: { request: (_name: string, _options: unknown, callback: (lock: object) => Promise<void>) => callback({}) },
    storage: { getDirectory: async () => ({ getDirectoryHandle: async () => dir }) },
  });
  const booted = vi.fn();
  vi.stubGlobal('importScripts', booted);
  await import('../src/worker/duckdb-cache-worker');
  await vi.waitFor(() => expect(booted).toHaveBeenCalledOnce());
  vi.useFakeTimers(); // index persistence must not outlive this worker's stubbed globals
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
