import { describe, expect, it } from 'vitest';
import {
  analysisSearch,
  analysisTemplateFor,
  buildAnalysisQuery,
  cacheResultFilter,
  errorStatusExpr,
  slowUrlFilter,
} from '../src/analysisTemplates';
import { timeContext } from '../src/datemath';
import type { Field } from '../src/fields';
import { compileSearch } from '../src/queryPlans';
import type { SearchState } from '../src/state';
import { restoreSearch } from '../src/stateCodec';

const field = (name: string, kind: Field['kind'] = 'string'): Field => ({
  name,
  column: name,
  expr: `"${name}"`,
  kind,
  duckType: kind === 'number' ? 'DOUBLE' : 'VARCHAR',
  searchable: kind === 'string',
});
const native = [field('elb_status_code', 'number'), field('target_processing_time', 'number'), field('request')];
const otel = [
  field('http.response.status_code', 'number'),
  field('aws.alb.target_processing_time', 'number'),
  field('url.full'),
  field('http.request.method'),
];
const search: SearchState = { query: 'elb_status_code:>=200', filters: [], range: { from: 'now-1h', to: 'now' } };
const compiled = compileSearch(search, native, '"time"', timeContext(new Date('2026-09-22T12:00:00Z')));

describe('built-in ALB analysis templates', () => {
  it('recognizes native, OpenTelemetry and converted ALB schemas without treating generic HTTP logs as ALB', () => {
    expect(analysisTemplateFor(native)?.id).toBe('alb');
    expect(analysisTemplateFor(otel)?.duration.name).toBe('aws.alb.target_processing_time');
    expect(analysisTemplateFor(native.map((f) => ({ ...f, kind: 'string' })))?.id).toBe('alb');
    expect(analysisTemplateFor([field('status'), field('latency_ms'), field('url')])).toBeNull();
    expect(analysisTemplateFor(otel.filter((f) => !f.name.startsWith('aws.alb.')))).toBeNull();
    expect(analysisTemplateFor([])).toBeNull();
    expect(analysisTemplateFor(native.map((f) => (f.name === 'request' ? { ...f, kind: 'object' } : f)))).toBeNull();
  });

  it('keeps query and time constraints on the source scan for both metrics and ranking', () => {
    const plan = buildAnalysisQuery(analysisTemplateFor(native)!, compiled);
    expect(plan.sql).toContain(`FROM src WHERE ${compiled.where}`);
    expect(plan.sql.match(/FROM src/g)).toHaveLength(1);
  });

  it('uses all logged requests for 5xx rate and reports unknown statuses separately', () => {
    const plan = buildAnalysisQuery(analysisTemplateFor(native)!, compiled);
    expect(plan.read([{ requests: 10, errors: 2, unknown_status: 1, measured: 8, p95: 1500, url: null }])).toEqual({
      requests: 10,
      errors: 2,
      unknownStatus: 1,
      errorRate: 20,
      clientErrors: 0,
      clientErrorRate: 0,
      cache: null,
      measured: 8,
      p95Ms: 1500,
      slowUrls: [],
    });
  });

  it('distinguishes absent observations from measured zero latency and zero errors', () => {
    const plan = buildAnalysisQuery(analysisTemplateFor(native)!, compiled);
    expect(plan.read([])).toMatchObject({ requests: 0, errorRate: null, measured: 0, p95Ms: null, slowUrls: [] });
    expect(plan.read([{ requests: 3, errors: 0, unknown_status: 3, measured: 0, p95: null, url: null }])).toMatchObject(
      { errorRate: null, p95Ms: null },
    );
    expect(plan.read([{ requests: 3, errors: 0, unknown_status: 0, measured: 3, p95: 0, url: null }])).toMatchObject({
      errorRate: 0,
      p95Ms: 0,
    });
  });

  it('drills into the exact method and URL, escaping values and preserving existing filters', () => {
    const template = analysisTemplateFor(native)!;
    const filter = slowUrlFilter(template, {
      method: 'GET',
      url: "https://api.example/o'hare",
      requests: 2,
      measured: 2,
      errors: 1,
      clientErrors: 0,
      p95Ms: 900,
    });
    expect(filter.sql).toContain("'https://api.example/o''hare'");
    expect(filter.sql).toContain(`(${template.urlExpr})`);
    expect(filter.sql).toContain(`(${template.methodExpr}) IS NOT DISTINCT FROM 'GET'`);
    const prior = { id: 'previous', field: 'elb_status_code', op: 'exists' as const };
    const next = analysisSearch({ ...search, filters: [prior] }, compiled, filter);
    expect(next.query).toBe(search.query);
    expect(next.filters).toEqual([prior, filter]);
    expect(next.range).toEqual({ from: '2026-09-22T11:00:00.000Z', to: '2026-09-22T12:00:00.000Z' });
    expect(restoreSearch(next).filters[1].disabled).toBe(true);
  });

  it('keeps null methods addressable in an OpenTelemetry source', () => {
    const template = analysisTemplateFor(otel.filter((f) => f.name !== 'http.request.method'))!;
    const filter = slowUrlFilter(template, {
      method: null,
      url: '/x',
      requests: 1,
      measured: 1,
      errors: 0,
      clientErrors: 0,
      p95Ms: 0,
    });
    expect(filter.sql).toContain('IS NOT DISTINCT FROM NULL');
  });
});

const cloudfront = [
  field('sc_status', 'number'),
  field('time_taken', 'number'),
  field('cs_uri_stem'),
  field('x_edge_result_type'),
  field('cs_method'),
  field('x_host_header'),
  field('cs_host'),
  field('cs_protocol'),
];
const cloudfrontOtel = [
  field('http.response.status_code', 'number'),
  field('aws.cloudfront.time_taken', 'number'),
  field('url.path'),
  field('aws.cloudfront.result_type'),
  field('http.request.method'),
  field('server.address'),
  field('aws.cloudfront.domain'),
  field('url.scheme'),
];

describe('CloudFront analysis templates', () => {
  it('recognizes native, OpenTelemetry and original AWS column names, including numeric strings', () => {
    expect(analysisTemplateFor(cloudfront)?.id).toBe('cloudfront');
    expect(analysisTemplateFor(cloudfrontOtel)?.duration.name).toBe('aws.cloudfront.time_taken');
    expect(analysisTemplateFor(cloudfront.map((f) => ({ ...f, kind: 'string' })))?.id).toBe('cloudfront');
    const awsNames = ['sc-status', 'time-taken', 'cs-uri-stem', 'x-edge-result-type', 'cs-method'];
    expect(analysisTemplateFor(awsNames.map((n) => field(n)))?.id).toBe('cloudfront');
    expect(analysisTemplateFor(cloudfront.filter((f) => f.name !== 'x_edge_result_type'))).toBeNull();
    expect(analysisTemplateFor(cloudfrontOtel.filter((f) => !f.name.startsWith('aws.cloudfront.')))).toBeNull();
    expect(
      analysisTemplateFor(cloudfront.map((f) => (f.name === 'time_taken' ? { ...f, kind: 'object' } : f))),
    ).toBeNull();
  });

  it('uses one filtered source scan and keeps cache eligibility identical in drill-down', () => {
    const template = analysisTemplateFor(cloudfront)!;
    const plan = buildAnalysisQuery(template, compiled);
    expect(plan.sql.match(/FROM src/g)).toHaveLength(1);
    expect(plan.sql).toContain(`WHERE ${compiled.where}`);
    for (const outcome of ['hit', 'miss'] as const) {
      const filter = cacheResultFilter(template, outcome, outcome);
      expect(filter.sql).toContain(template.cache!.eligibleExpr);
      expect(plan.sql).toContain(template.cache!.eligibleExpr);
      expect(filter.sql).toContain(outcome === 'hit' ? "'Hit', 'RefreshHit'" : "'Miss'");
      expect(restoreSearch(analysisSearch(search, compiled, filter)).filters[0].disabled).toBe(true);
    }
  });

  it('uses all requests for error rates and only classified eligible requests for cache-hit rate', () => {
    const plan = buildAnalysisQuery(analysisTemplateFor(cloudfront)!, compiled);
    expect(
      plan.read([
        {
          requests: 20,
          errors: 3,
          client_errors: 1,
          unknown_status: 1,
          measured: 16,
          p95: 6250,
          cache_eligible_count: 10,
          cache_hits: 7,
          cache_refresh_hits: 2,
          cache_misses: 3,
          url: null,
        },
      ]),
    ).toMatchObject({
      requests: 20,
      errorRate: 15,
      clientErrorRate: 5,
      unknownStatus: 1,
      cache: { hits: 7, refreshHits: 2, misses: 3, eligible: 10, excluded: 10, hitRate: 70 },
      p95Ms: 6250,
    });
    expect(plan.read([])).toMatchObject({ clientErrorRate: null, errorRate: null, cache: { hitRate: null } });
    expect(plan.read([{ requests: 4, errors: 0, unknown_status: 4 }])).toMatchObject({
      clientErrorRate: null,
      errorRate: null,
      cache: { hitRate: null, excluded: 4 },
    });
    expect(plan.read([{ requests: 4, cache_eligible_count: 4, cache_hits: 0, cache_misses: 4 }])).toMatchObject({
      clientErrorRate: 0,
      errorRate: 0,
      cache: { hitRate: 0, eligible: 4 },
    });
  });

  it('keeps the exact viewer host, scheme, path and method when filtering a quoted URL', () => {
    const template = analysisTemplateFor(cloudfrontOtel)!;
    const filter = slowUrlFilter(template, {
      method: 'GET',
      url: "https://cdn.example/o'hare",
      requests: 2,
      measured: 2,
      errors: 0,
      clientErrors: 1,
      p95Ms: 500,
    });
    expect(filter.sql).toContain("'https://cdn.example/o''hare'");
    for (const expr of [
      '"server.address"',
      '"aws.cloudfront.domain"',
      '"url.scheme"',
      '"url.path"',
      '"http.request.method"',
    ])
      expect(filter.sql).toContain(expr);
    expect(filter.sql).not.toContain('url.query');
    expect(errorStatusExpr(template, 4)).toContain('BETWEEN 400 AND 499');
  });
});
