import { describe, expect, it } from 'vitest';
import { s3EndpointFor, s3HttpsUrl } from '../src/datasource';
import { s3Target } from '../src/s3list';
import { DEFAULT_SOURCE } from '../src/sources';

const s3 = (patch: Partial<typeof DEFAULT_SOURCE.s3> = {}) => ({ ...DEFAULT_SOURCE.s3, region: 'ap-northeast-1', ...patch });

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
