import { describe, expect, it } from 'vitest';
import { captureRegex, concretePatterns, expandDateTokens, keyTimestamp, namedToGlob, namedTokens, parseS3Url, s3Target, substituteTokens, withinRange } from '../src/s3list';

const alb = 's3://logs/AWSLogs/{account}/elasticloadbalancing/{region}/{yyyy}/{MM}/{dd}/{account}_elasticloadbalancing_{region}_app.{alb}.*.log.gz';

describe('named tokens', () => {
  it('lists the non-date tokens once, in order', () => {
    expect(namedTokens(alb)).toEqual(['account', 'region', 'alb']);
    expect(namedTokens('s3://b/{yyyy}/*.gz')).toEqual([]);
  });

  it('turns them into wildcards for listing', () => {
    expect(namedToGlob('s3://b/{x}/{yyyy}/{y}.gz')).toBe('s3://b/*/{yyyy}/*.gz');
  });

  it('captures their values from a concrete key', () => {
    const cap = captureRegex(alb);
    expect(cap.names).toEqual(['account', 'region', 'alb']);
    const m = new RegExp(cap.source).exec(
      's3://logs/AWSLogs/123456789012/elasticloadbalancing/ap-northeast-1/2026/09/16/123456789012_elasticloadbalancing_ap-northeast-1_app.my-alb.abc_20260916T0105Z_1.2.3.4_xyz.log.gz',
    );
    expect(m?.slice(1)).toEqual(['123456789012', 'ap-northeast-1', 'my-alb']);
    expect(new RegExp(cap.source).exec('s3://logs/AWSLogs/1/elasticloadbalancing/r/2026/09/16/other.log.gz')).toBeNull();
  });

  it('escapes regex characters and treats ** as any depth', () => {
    expect(new RegExp(captureRegex('s3://b/a.b/**/x?.parquet').source).test('s3://b/a.b/1/2/x1.parquet')).toBe(true);
    expect(new RegExp(captureRegex('s3://b/a.b/*.parquet').source).test('s3://b/aXb/y.parquet')).toBe(false);
  });

  it('substitutes selected values, up to a limit', () => {
    expect(substituteTokens('s3://b/{a}/{c}/x', { a: ['1', '2'], c: ['z'] })).toEqual(['s3://b/1/z/x', 's3://b/2/z/x']);
    expect(substituteTokens('s3://b/{a}/x', { a: Array.from({ length: 65 }, (_, i) => String(i)) })).toEqual(['s3://b/{a}/x']);
    expect(substituteTokens('s3://b/{a}/x', {})).toEqual(['s3://b/{a}/x']);
  });
});

describe('date tokens', () => {
  it('expand day by day over the range, UTC', () => {
    expect(expandDateTokens('s3://b/{yyyy}/{MM}/{dd}/*.gz', new Date('2026-09-15T23:00:00Z'), new Date('2026-09-16T01:00:00Z'))).toEqual(['s3://b/2026/09/15/*.gz', 's3://b/2026/09/16/*.gz']);
  });

  it('expand hourly and monthly patterns', () => {
    expect(expandDateTokens('s3://b/{yyyy}/{MM}/{dd}/{HH}/*', new Date('2026-09-15T23:10:00Z'), new Date('2026-09-16T01:00:00Z'))).toHaveLength(3);
    expect(expandDateTokens('s3://b/{yyyy}/{MM}/*', new Date('2026-08-31T00:00:00Z'), new Date('2026-09-01T00:00:00Z'))).toEqual(['s3://b/2026/08/*', 's3://b/2026/09/*']);
    expect(expandDateTokens('s3://b/{yy}/*', new Date('2026-08-31T00:00:00Z'), new Date('2026-09-01T00:00:00Z'))).toEqual(['s3://b/26/*']);
  });

  it('reach past the range far enough for a late-delivered file', () => {
    // 23:58 is delivered in a file named 00:00 under tomorrow's prefix, and withinRange accepts it
    const day = concretePatterns('s3://b/{yyyy}/{MM}/{dd}/*.gz', { from: new Date('2026-09-15T00:00:00Z'), to: new Date('2026-09-15T23:59:59Z') });
    expect(day).toEqual(['s3://b/2026/09/15/*.gz', 's3://b/2026/09/16/*.gz']);
    // mid-day there is nothing to reach for
    expect(concretePatterns('s3://b/{yyyy}/{MM}/{dd}/*.gz', { from: new Date('2026-09-15T00:00:00Z'), to: new Date('2026-09-15T12:00:00Z') })).toEqual(['s3://b/2026/09/15/*.gz']);
    const hours = concretePatterns('s3://b/{yyyy}/{MM}/{dd}/{HH}/*', { from: new Date('2026-09-15T02:00:00Z'), to: new Date('2026-09-15T03:00:00Z') });
    expect(hours).toEqual(['s3://b/2026/09/15/02/*', 's3://b/2026/09/15/03/*', 's3://b/2026/09/15/04/*', 's3://b/2026/09/15/05/*', 's3://b/2026/09/15/06/*']);
    expect(concretePatterns('s3://b/{yyyy}/{MM}/{dd}/*.gz', null)).toEqual([]);
    expect(concretePatterns('s3://b/plain/*.gz', null)).toEqual(['s3://b/plain/*.gz']);
  });

  it('leaves patterns without tokens alone and refuses absurd ranges', () => {
    expect(expandDateTokens('s3://b/x', new Date(0), new Date(1))).toEqual(['s3://b/x']);
    expect(() => expandDateTokens('s3://b/{yyyy}/{MM}/{dd}/{HH}/*', new Date('2020-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'))).toThrow();
  });
});

describe('file-name timestamps', () => {
  it('reads ALB-style and hourly-style stamps', () => {
    expect(keyTimestamp('a/b/123_elb_r_app.x.y_20260909T0105Z_1.2.3.4_z.log.gz')).toEqual({ ts: new Date('2026-09-09T01:05:00Z'), kind: 'minute' });
    expect(keyTimestamp('cf/E123ABC.2026-09-09-01.abcdef12.gz')).toEqual({ ts: new Date('2026-09-09T01:00:00Z'), kind: 'hour' });
    expect(keyTimestamp('s3-logs/2026-09-09-01-15-30-0123456789ABCDEF')).toEqual({ ts: new Date('2026-09-09T01:15:30Z'), kind: 'hour' });
    expect(keyTimestamp('data/part-0001.parquet')).toBeNull();
  });

  it('keeps files whose stamp can cover the range and drops the rest', () => {
    const range = { from: new Date('2026-09-09T02:00:00Z'), to: new Date('2026-09-09T03:00:00Z') };
    expect(withinRange('x_20260909T0205Z_y.log.gz', range)).toBe(true);
    expect(withinRange('x_20260909T0100Z_y.log.gz', range)).toBe(true); // within the 65-minute grace
    expect(withinRange('x_20260909T0000Z_y.log.gz', range)).toBe(false);
    expect(withinRange('x_20260909T0310Z_y.log.gz', range)).toBe(false);
    expect(withinRange('E1.2026-09-09-05.a.gz', range)).toBe(true); // hourly delivery lags up to 3 h
    expect(withinRange('E1.2026-09-09-07.a.gz', range)).toBe(false);
    expect(withinRange('part-1.parquet', range)).toBe(true);
    expect(withinRange('x_20260909T0000Z_y.log.gz', null)).toBe(true);
  });
});

describe('S3 addressing', () => {
  const base = { region: 'ap-northeast-1', accessKeyId: '', secretAccessKey: '', sessionToken: '', endpoint: '', urlStyle: 'vhost' as const };

  it('parses s3:// URLs', () => {
    expect(parseS3Url('s3://bucket/a/b.gz')).toEqual({ bucket: 'bucket', key: 'a/b.gz' });
    expect(parseS3Url('s3://bucket')).toEqual({ bucket: 'bucket', key: '' });
    expect(parseS3Url('https://x')).toBeNull();
  });

  it('builds virtual-hosted and path-style targets', () => {
    expect(s3Target('b', base)).toEqual({ bucket: 'b', baseUrl: 'https://b.s3.amazonaws.com', canonicalBase: '/', host: 'b.s3.amazonaws.com' });
    expect(s3Target('b', { ...base, endpoint: 's3.ap-northeast-1.amazonaws.com' }).baseUrl).toBe('https://b.s3.ap-northeast-1.amazonaws.com');
    expect(s3Target('b', { ...base, endpoint: 'http://localhost:9000/' })).toEqual({ bucket: 'b', baseUrl: 'http://localhost:9000/b', canonicalBase: '/b/', host: 'localhost:9000' });
    expect(s3Target('b', { ...base, urlStyle: 'path' }).baseUrl).toBe('https://s3.ap-northeast-1.amazonaws.com/b');
  });
});
