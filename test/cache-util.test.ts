import { describe, expect, it } from 'vitest';
import {
  cacheKey,
  evictionPlan,
  checksum,
  etagFrom,
  hashName,
  hexHead,
  isDataUrl,
  isExtensionUrl,
  looksGzip,
  parseHeaders,
  parseRange,
  rawHeaders,
  totalSizeFrom,
  type NativeResult,
} from '../src/worker/cache-util';

const res = (headers: Record<string, string>): NativeResult => ({ status: 200, statusText: 'OK', headers, rawHeaders: '', body: null });

describe('cacheKey', () => {
  it('strips signatures of the usual presigning schemes and the fragment, keeps the rest', () => {
    expect(cacheKey('https://b.s3.amazonaws.com/k?X-Amz-Signature=abc&X-Amz-Date=1&x-amz-security-token=t&keep=1#frag')).toBe('https://b.s3.amazonaws.com/k?keep=1');
    expect(cacheKey('https://b.s3.amazonaws.com/k?AWSAccessKeyId=A&Signature=s&Expires=1')).toBe('https://b.s3.amazonaws.com/k');
    expect(cacheKey('https://a.blob.core.windows.net/c/k?sv=2024&sig=x&se=2026&sp=r&sr=b&st=2025&skoid=1')).toBe('https://a.blob.core.windows.net/c/k');
    expect(cacheKey('https://storage.googleapis.com/b/k?X-Goog-Signature=x&X-Goog-Algorithm=y')).toBe('https://storage.googleapis.com/b/k');
  });

  it('is stable for the same object signed twice', () => {
    expect(cacheKey('https://h/k?X-Amz-Signature=1')).toBe(cacheKey('https://h/k?X-Amz-Signature=2'));
  });
});

describe('URL classification', () => {
  it('treats http(s) URLs on other origins as data', () => {
    expect(isDataUrl('https://b.s3.amazonaws.com/k', 'chrome-extension://abc')).toBe(true);
    expect(isDataUrl('chrome-extension://abc/duckdb/duckdb-eh.wasm', 'chrome-extension://abc')).toBe(false);
    expect(isDataUrl('http://localhost:5299/x', 'http://localhost:5299')).toBe(false);
    expect(isDataUrl('data:text/plain,x', 'chrome-extension://abc')).toBe(false);
    expect(isDataUrl('not a url', 'chrome-extension://abc')).toBe(false);
  });

  it('recognises DuckDB extension bundles and gzip objects by path', () => {
    expect(isExtensionUrl('https://extensions.duckdb.org/v1.4.3/wasm_eh/json.duckdb_extension.wasm')).toBe(true);
    expect(isExtensionUrl('https://h/data.parquet')).toBe(false);
    expect(looksGzip('https://h/a/b.log.GZ?x=1')).toBe(true);
    expect(looksGzip('https://h/a/b.parquet')).toBe(false);
    expect(looksGzip('nope')).toBe(false);
  });
});

describe('headers', () => {
  it('parses and re-serialises header blocks', () => {
    const h = parseHeaders('Content-Length: 12\r\nETag: "abc"\r\nX-Odd:  spaced : value \r\n\r\n');
    expect(h).toEqual({ 'content-length': '12', etag: '"abc"', 'x-odd': 'spaced : value' });
    expect(rawHeaders({ a: '1', b: '2' })).toBe('a: 1\r\nb: 2\r\n');
  });

  it('takes the total size from Content-Range when present', () => {
    expect(totalSizeFrom(res({ 'content-range': 'bytes 0-99/12345', 'content-length': '100' }))).toBe(12345);
    expect(totalSizeFrom(res({ 'content-length': '100' }))).toBe(100);
    expect(Number.isNaN(totalSizeFrom(res({})))).toBe(true);
  });

  it('falls back from ETag to Last-Modified', () => {
    expect(etagFrom(res({ etag: '"e"', 'last-modified': 'x' }))).toBe('"e"');
    expect(etagFrom(res({ 'last-modified': 'Tue, 16 Sep 2026 00:00:00 GMT' }))).toBe('Tue, 16 Sep 2026 00:00:00 GMT');
    expect(etagFrom(res({}))).toBe('');
  });
});

describe('parseRange', () => {
  it('resolves closed, open-ended and suffix ranges against the size', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=900-', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=0-5000', 1000)).toEqual({ start: 0, end: 999 });
    expect(parseRange(' bytes=10-10 ', 1000)).toEqual({ start: 10, end: 10 });
  });

  it('rejects ranges it cannot satisfy', () => {
    expect(parseRange('bytes=1000-', 1000)).toBeNull();
    expect(parseRange('bytes=50-10', 1000)).toBeNull();
    expect(parseRange('bytes=-', 1000)).toBeNull();
    expect(parseRange('items=0-1', 1000)).toBeNull();
  });
});

describe('hashes', () => {
  it('checksums are deterministic, sensitive and never zero', () => {
    const a = new Uint8Array([1, 2, 3]);
    expect(checksum(a)).toBe(checksum(new Uint8Array([1, 2, 3])));
    expect(checksum(a)).not.toBe(checksum(new Uint8Array([1, 2, 4])));
    expect(checksum(new Uint8Array(0))).not.toBe(0);
  });

  it('names are 16 hex characters and differ per input', () => {
    expect(hashName('https://h/a')).toMatch(/^[0-9a-f]{16}$/);
    expect(hashName('https://h/a')).not.toBe(hashName('https://h/b'));
  });

  it('shows the first bytes as hex', () => {
    expect(hexHead(new Uint8Array([0x1f, 0x8b, 0x08, 0, 1, 2, 3, 4, 5, 6]).buffer)).toBe('1f8b080001020304');
    expect(hexHead(new Uint8Array([0x1f]).buffer, 4)).toBe('1f');
    expect(hexHead(null)).toBeUndefined();
  });
});

describe('evictionPlan', () => {
  const e = (name: string, usedAt: number, bytes: number) => ({ name, seenAt: 0, usedAt, bytes });
  it('drops the least recently used files until the data fits the target', () => {
    const entries = [e('c', 30, 100), e('a', 10, 100), e('b', 20, 100), e('empty', 5, 0)];
    expect(evictionPlan(entries, 300, 150).map((x) => x.name)).toEqual(['a', 'b']);
    expect(evictionPlan(entries, 300, 300)).toEqual([]);
    expect(evictionPlan(entries, 300, 0).map((x) => x.name)).toEqual(['a', 'b', 'c']);
  });
  it('orders entries of older builds by the time they were seen', () => {
    expect(
      evictionPlan(
        [
          { seenAt: 50, bytes: 10 },
          { seenAt: 40, bytes: 10 },
          { seenAt: 60, usedAt: 1, bytes: 10 },
        ],
        30,
        15,
      ).map((x) => x.seenAt),
    ).toEqual([60, 40]);
  });
});
