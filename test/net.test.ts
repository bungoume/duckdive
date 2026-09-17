import { describe, expect, it, vi } from 'vitest';
import { CancelledError, TimeoutError, fetchWithTimeout, mapLimit, throwIfAborted } from '../src/net';

describe('mapLimit', () => {
  it('keeps the input order and never runs more than the limit at once', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([10, 4, 8, 1, 6, 2], 2, async (n, i) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, n));
      running--;
      return `${i}:${n}`;
    });
    expect(out).toEqual(['0:10', '1:4', '2:8', '3:1', '4:6', '5:2']);
    expect(peak).toBe(2);
  });

  it('stops handing out work after a failure and rethrows it', async () => {
    const started: number[] = [];
    await expect(
      mapLimit([1, 2, 3, 4, 5, 6], 1, async (n) => {
        started.push(n);
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
    expect(started).toEqual([1, 2]);
  });

  it('does nothing for an empty list', async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
  });
});

describe('fetchWithTimeout', () => {
  it('turns a deadline into a TimeoutError that names what did not answer', async () => {
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => new Promise((_r, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))));
    const e = await fetchWithTimeout('https://example.com', {}, 'the listing', null, 10).catch((x) => x);
    expect(e).toBeInstanceOf(TimeoutError);
    expect(String(e)).toContain('the listing');
    vi.unstubAllGlobals();
  });

  it('turns the caller cancelling into a CancelledError, before the request and during it', async () => {
    const done = new AbortController();
    done.abort();
    await expect(fetchWithTimeout('https://example.com', {}, 'the listing', done.signal)).rejects.toBeInstanceOf(CancelledError);

    const ctl = new AbortController();
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => new Promise((_r, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))));
    const p = fetchWithTimeout('https://example.com', {}, 'the listing', ctl.signal, 5000).catch((x) => x);
    ctl.abort();
    expect(await p).toBeInstanceOf(CancelledError);
    vi.unstubAllGlobals();
  });
});

describe('throwIfAborted', () => {
  it('throws only for a signal that has been aborted', () => {
    const ctl = new AbortController();
    expect(() => throwIfAborted(ctl.signal)).not.toThrow();
    expect(() => throwIfAborted(null)).not.toThrow();
    expect(() => throwIfAborted(undefined)).not.toThrow();
    ctl.abort();
    expect(() => throwIfAborted(ctl.signal)).toThrow(CancelledError);
  });
});
