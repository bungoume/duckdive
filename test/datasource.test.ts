import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureSelect, capturedColumns, isRangeDependent, resolveFiles, s3EndpointFor, s3HttpsUrl } from '../src/datasource';
import { s3Target } from '../src/s3list';
import { DEFAULT_SOURCE } from '../src/sources';

const s3 = (patch: Partial<typeof DEFAULT_SOURCE.s3> = {}) => ({ ...DEFAULT_SOURCE.s3, region: 'ap-northeast-1', ...patch });

afterEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('file metadata', () => {
  it('keeps listed sizes and cache seeds when another file cannot be listed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => new Response('', { status: new URL(url).searchParams.get('prefix') === 'private.parquet' ? 403 : 200 })),
    );
    const metadata = { Key: 'listed.parquet', Size: '123', ETag: 'etag', LastModified: '2026-09-22T00:00:00Z' };
    vi.stubGlobal(
      'DOMParser',
      class {
        parseFromString() {
          return { getElementsByTagName: (tag: string) => (tag === 'Contents' ? [{ getElementsByTagName: (name: keyof typeof metadata) => [{ textContent: metadata[name] }] }] : []) };
        }
      },
    );
    const cfg = { ...DEFAULT_SOURCE, kind: 'url' as const, authMode: 'none' as const, urls: 's3://logs/listed.parquet\ns3://logs/private.parquet' };
    const result = await resolveFiles(cfg, null, null);
    expect(result.files.map((f) => [f.url, f.metadata?.size ?? null])).toEqual([
      ['s3://logs/listed.parquet', 123],
      ['s3://logs/private.parquet', null],
    ]);
    expect(result.seeds).toEqual([
      { url: s3HttpsUrl('s3://logs/listed.parquet', cfg.s3), size: 123, etag: 'etag', lastModified: metadata.LastModified, s3: { bucket: 'logs', key: 'listed.parquet' } },
    ]);
    expect(result.totalBytes).toBeNull();
    expect((await resolveFiles({ ...cfg, urls: 's3://logs/listed.parquet' }, null, null)).totalBytes).toBe(123);
  });
});

describe('captured columns across patterns', () => {
  it('uses each matching pattern and its own capture group for a shared column', () => {
    const sql = captureSelect({ ...DEFAULT_SOURCE, urls: 's3://a/{account}/*.parquet\ns3://b/{region}/{account}/*.parquet' });
    expect(sql).toContain("WHEN regexp_matches(filename, '^s3://a/([^/]*?)/[^/]*\\.parquet$') THEN regexp_extract(filename, '^s3://a/([^/]*?)/[^/]*\\.parquet$', 1)");
    expect(sql).toContain("WHEN regexp_matches(filename, '^s3://b/([^/]*?)/([^/]*?)/[^/]*\\.parquet$') THEN regexp_extract(filename, '^s3://b/([^/]*?)/([^/]*?)/[^/]*\\.parquet$', 2)");
    expect(sql.match(/AS "account"/g)).toHaveLength(1);
    expect(sql).toContain('ELSE \'\' END AS "account"');
    expect(sql).toContain('regexp_extract(filename, \'^s3://b/([^/]*?)/([^/]*?)/[^/]*\\.parquet$\', 1) AS "region"');
  });

  it('keeps single-pattern behavior and escapes SQL literals and column names', () => {
    expect(captureSelect({ ...DEFAULT_SOURCE, urls: "s3://a/it's/{account}/*.parquet" })).toBe(", regexp_extract(filename, '^s3://a/it''s/([^/]*?)/[^/]*\\.parquet$', 1) AS \"account\"");
    expect(captureSelect({ ...DEFAULT_SOURCE, urls: 's3://a/*.parquet' })).toBe('');
  });
});

describe('HTTPS file resolution', () => {
  const config = (urls: string) => ({ ...DEFAULT_SOURCE, kind: 'url' as const, urls });

  it('preserves signed query strings byte for byte', async () => {
    const url = 'https://example.com/log.parquet?X-Amz-Signature=abc%2F123&X-Amz-Credential=a%2Fb&literal=*?[x]{name}{yyyy}&a=1&a=2#fragment';
    expect((await resolveFiles(config(url), null, null)).files.map((f) => f.url)).toEqual([url]);
    expect(capturedColumns(config(url))).toEqual([]);
    expect(isRangeDependent(config(url))).toBe(false);
  });

  it('expands dates in paths while leaving the signed query unchanged', async () => {
    const cfg = config('https://example.com/{yyyy}/{MM}/{dd}.parquet?signature=abc%2Bdef');
    const range = { from: new Date('2026-09-22T00:00Z'), to: new Date('2026-09-22T01:00Z') };
    expect((await resolveFiles(cfg, null, range)).files.map((f) => f.url)).toEqual(['https://example.com/2026/09/22.parquet?signature=abc%2Bdef']);
  });

  it('still rejects actual path wildcards', async () => {
    await expect(resolveFiles(config('https://example.com/*.parquet?signature=abc'), null, null)).rejects.toThrow('Wildcards');
  });
});

describe('s3EndpointFor', () => {
  it('hands duckdb-wasm a string it reads the same way the listing does', () => {
    // duckdb-wasm takes a scheme in the endpoint to mean path style, so the scheme has to stay:
    // stripping it made DuckDB ask bucket.minio:9000 while the listing signed minio:9000/bucket
    expect(s3EndpointFor(s3({ endpoint: 'http://minio:9000' }))).toBe('http://minio:9000');
    expect(s3EndpointFor(s3({ endpoint: 'https://s3.example.com/' }))).toBe('https://s3.example.com');
    expect(s3EndpointFor(s3())).toBe('s3.amazonaws.com');
    expect(s3EndpointFor(s3({ endpoint: 's3.ap-northeast-1.amazonaws.com' }))).toBe('s3.ap-northeast-1.amazonaws.com');
    expect(s3EndpointFor(s3({ urlStyle: 'path' }))).toBe('https://s3.ap-northeast-1.amazonaws.com');
  });
});

describe('s3HttpsUrl', () => {
  it('is the URL the listing signs, for every endpoint style', () => {
    for (const cfg of [s3(), s3({ endpoint: 'http://minio:9000' }), s3({ endpoint: 's3.ap-northeast-1.amazonaws.com' }), s3({ urlStyle: 'path' })]) {
      expect(s3HttpsUrl('s3://b/p/x.gz', cfg)).toBe(`${s3Target('b', cfg).baseUrl}/p/x.gz`);
    }
    expect(s3HttpsUrl('s3://b/p/x.gz', s3())).toBe('https://b.s3.amazonaws.com/p/x.gz');
    expect(s3HttpsUrl('s3://b/p/x.gz', s3({ endpoint: 'http://minio:9000' }))).toBe('http://minio:9000/b/p/x.gz');
    expect(s3HttpsUrl('https://example.com/x.gz', s3())).toBeNull();
  });
});
