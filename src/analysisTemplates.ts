import { findField, type Field } from './fields';
import { reqLine } from './formats/shared';
import type { Compiled, QueryPlan } from './queryPlans';
import { lit, newId, VIEW, type Filter } from './sql';
import type { SearchState } from './state';

/** Built-in analysis templates bind to the connected schema, including converted files. */
export interface AnalysisTemplate {
  id: 'alb' | 'cloudfront';
  status: Field;
  duration: Field;
  methodExpr: string;
  urlExpr: string;
  cache?: { result: Field; eligibleExpr: string };
}

function albTemplate(fields: Field[]): AnalysisTemplate | null {
  for (const naming of ['native', 'otel'] as const) {
    const status = findField(fields, naming === 'native' ? 'elb_status_code' : 'http.response.status_code');
    const duration = findField(
      fields,
      naming === 'native' ? 'target_processing_time' : 'aws.alb.target_processing_time',
    );
    const request = findField(fields, naming === 'native' ? 'request' : 'url.full');
    if (
      !status ||
      !duration ||
      !request ||
      request.kind !== 'string' ||
      !['number', 'string'].includes(status.kind) ||
      !['number', 'string'].includes(duration.kind)
    )
      continue;
    const method =
      naming === 'native'
        ? reqLine(request.expr, 1)
        : (findField(fields, 'http.request.method')?.expr ?? 'NULL::VARCHAR');
    const target = naming === 'native' ? reqLine(request.expr, 2) : request.expr;
    // Keep host and method distinct; query parameters must not split the same endpoint.
    const url = `nullif(nullif(regexp_replace(${target}, '[?#].*$', ''), ''), '-')`;
    return { id: 'alb', status, duration, methodExpr: method, urlExpr: url };
  }
  return null;
}

/** Empty and dash placeholders are unknown, never URL components or cache decisions. */
function textExpr(field: Field | undefined): string {
  return field?.kind === 'string' ? `nullif(nullif(${field.expr}, ''), '-')` : 'NULL::VARCHAR';
}

function cloudfrontTemplate(fields: Field[]): AnalysisTemplate | null {
  const names = [
    [
      'sc_status',
      'time_taken',
      'cs_uri_stem',
      'x_edge_result_type',
      'cs_method',
      'x_host_header',
      'cs_host',
      'cs_protocol',
    ],
    [
      'http.response.status_code',
      'aws.cloudfront.time_taken',
      'url.path',
      'aws.cloudfront.result_type',
      'http.request.method',
      'server.address',
      'aws.cloudfront.domain',
      'url.scheme',
    ],
    [
      'sc-status',
      'time-taken',
      'cs-uri-stem',
      'x-edge-result-type',
      'cs-method',
      'x-host-header',
      'cs(Host)',
      'cs-protocol',
    ],
  ];
  for (const naming of names) {
    const [status, duration, path, result, method, host, domain, scheme] = naming.map((name) =>
      findField(fields, name),
    );
    if (
      !status ||
      !duration ||
      !path ||
      !result ||
      path.kind !== 'string' ||
      result.kind !== 'string' ||
      !['number', 'string'].includes(status.kind) ||
      !['number', 'string'].includes(duration.kind)
    )
      continue;
    const methodExpr = textExpr(method);
    const hostname = `coalesce(${textExpr(host)}, ${textExpr(domain)})`;
    const pathname = `nullif(regexp_replace(${textExpr(path)}, '[?#].*$', ''), '')`;
    // Preserve viewer host and protocol. Missing hosts still leave an addressable path.
    const urlExpr = `CASE WHEN ${pathname} IS NOT NULL THEN
      (CASE WHEN ${hostname} IS NULL THEN '' ELSE coalesce(${textExpr(scheme)} || ':', '') || '//' || ${hostname} END) || ${pathname} END`;
    return {
      id: 'cloudfront',
      status,
      duration,
      methodExpr,
      urlExpr,
      cache: {
        result,
        // A log-derived ratio: completed cache outcomes for cacheable methods and non-error
        // statuses. Final Error (including a disconnected viewer), redirects and unknowns are excluded.
        eligibleExpr: `${methodExpr} IN ('GET', 'HEAD', 'OPTIONS') AND TRY_CAST(${status.expr} AS DOUBLE) BETWEEN 200 AND 399 AND ${result.expr} IN ('Hit', 'RefreshHit', 'Miss')`,
      },
    };
  }
  return null;
}

const TEMPLATES = [albTemplate, cloudfrontTemplate];
export function analysisTemplateFor(fields: Field[]): AnalysisTemplate | null {
  for (const match of TEMPLATES) {
    const template = match(fields);
    if (template) return template;
  }
  return null;
}

export interface SlowUrl {
  method: string | null;
  url: string;
  requests: number;
  measured: number;
  errors: number;
  clientErrors: number;
  p95Ms: number;
}
export interface AnalysisResult {
  requests: number;
  errors: number;
  unknownStatus: number;
  errorRate: number | null;
  clientErrors: number;
  clientErrorRate: number | null;
  cache: {
    hits: number;
    refreshHits: number;
    misses: number;
    eligible: number;
    excluded: number;
    hitRate: number | null;
  } | null;
  measured: number;
  p95Ms: number | null;
  slowUrls: SlowUrl[];
}

/** Log seconds → milliseconds; -1, missing and non-finite measurements are not latencies. */
export function responseTimeExpr(template: AnalysisTemplate): string {
  const seconds = `TRY_CAST(${template.duration.expr} AS DOUBLE)`;
  return `CASE WHEN ${seconds} >= 0 AND isfinite(${seconds} * 1000) THEN ${seconds} * 1000 END`;
}
export function errorStatusExpr(template: AnalysisTemplate, statusClass: 4 | 5 = 5): string {
  return `TRY_CAST(${template.status.expr} AS DOUBLE) BETWEEN ${statusClass * 100} AND ${statusClass * 100 + 99}`;
}

/** Use the same eligibility and outcomes as the displayed cache-hit ratio. */
export function cacheResultFilter(template: AnalysisTemplate, outcome: 'hit' | 'miss', label: string): Filter {
  const cache = template.cache;
  return {
    id: newId(),
    field: '',
    op: 'query',
    label,
    sql: cache
      ? `(${cache.eligibleExpr}) AND ${cache.result.expr} IN (${outcome === 'hit' ? "'Hit', 'RefreshHit'" : "'Miss'"})`
      : 'FALSE',
  };
}

/** One source scan supplies both the overall metrics and the endpoint ranking. */
export function buildAnalysisQuery(template: AnalysisTemplate, compiled: Compiled): QueryPlan<AnalysisResult> {
  const sql = `WITH base AS MATERIALIZED (
    SELECT TRY_CAST(${template.status.expr} AS DOUBLE) AS status,
      ${responseTimeExpr(template)} AS latency, ${template.methodExpr} AS method, ${template.urlExpr} AS url,
      ${template.cache?.result.expr ?? 'NULL::VARCHAR'} AS cache_result,
      (${template.cache?.eligibleExpr ?? 'FALSE'}) AS cache_eligible
    FROM ${VIEW} WHERE ${compiled.where}
  ), summary AS (
    SELECT count(*)::DOUBLE AS requests,
      count(*) FILTER (WHERE status BETWEEN 500 AND 599)::DOUBLE AS errors,
      count(*) FILTER (WHERE status BETWEEN 400 AND 499)::DOUBLE AS client_errors,
      count(*) FILTER (WHERE cache_eligible)::DOUBLE AS cache_eligible_count,
      count(*) FILTER (WHERE cache_eligible AND cache_result IN ('Hit', 'RefreshHit'))::DOUBLE AS cache_hits,
      count(*) FILTER (WHERE cache_eligible AND cache_result = 'RefreshHit')::DOUBLE AS cache_refresh_hits,
      count(*) FILTER (WHERE cache_eligible AND cache_result = 'Miss')::DOUBLE AS cache_misses,
      count(*) FILTER (WHERE status IS NULL OR NOT (status BETWEEN 100 AND 599))::DOUBLE AS unknown_status,
      count(latency)::DOUBLE AS measured, quantile_cont(latency, 0.95)::DOUBLE AS p95
    FROM base
  ), slow AS (
    SELECT method, url, count(*)::DOUBLE AS url_requests, count(latency)::DOUBLE AS url_measured,
      count(*) FILTER (WHERE status BETWEEN 500 AND 599)::DOUBLE AS url_errors,
      count(*) FILTER (WHERE status BETWEEN 400 AND 499)::DOUBLE AS url_client_errors,
      quantile_cont(latency, 0.95)::DOUBLE AS url_p95
    FROM base WHERE url IS NOT NULL GROUP BY method, url HAVING count(latency) > 0
    ORDER BY url_p95 DESC, url_requests DESC, url ASC, method ASC NULLS LAST LIMIT 10
  ) SELECT summary.*, slow.* FROM summary LEFT JOIN slow ON TRUE
    ORDER BY url_p95 DESC, url_requests DESC, url ASC, method ASC NULLS LAST`;
  const numberOrNull = (value: unknown) =>
    value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value);
  return {
    sql,
    read(rows) {
      const first = rows[0];
      const requests = Number(first?.requests ?? 0);
      const errors = Number(first?.errors ?? 0);
      const unknownStatus = Number(first?.unknown_status ?? 0);
      const clientErrors = Number(first?.client_errors ?? 0);
      const eligible = Number(first?.cache_eligible_count ?? 0);
      const hits = Number(first?.cache_hits ?? 0);
      return {
        requests,
        errors,
        unknownStatus,
        errorRate: requests > unknownStatus ? (errors / requests) * 100 : null,
        clientErrors,
        clientErrorRate: requests > unknownStatus ? (clientErrors / requests) * 100 : null,
        cache: template.cache
          ? {
              hits,
              eligible,
              refreshHits: Number(first?.cache_refresh_hits ?? 0),
              misses: Number(first?.cache_misses ?? 0),
              excluded: requests - eligible,
              hitRate: eligible ? (hits / eligible) * 100 : null,
            }
          : null,
        measured: Number(first?.measured ?? 0),
        p95Ms: numberOrNull(first?.p95),
        slowUrls: rows
          .filter((r) => r.url !== null && r.url !== undefined)
          .map((r) => ({
            method: r.method === null || r.method === undefined ? null : String(r.method),
            url: String(r.url),
            requests: Number(r.url_requests),
            measured: Number(r.url_measured),
            errors: Number(r.url_errors),
            clientErrors: Number(r.url_client_errors ?? 0),
            p95Ms: Number(r.url_p95),
          })),
      };
    },
  };
}

/** Use the exact grouping expression to retain the same endpoint, including quoted URLs. */
export function slowUrlFilter(template: AnalysisTemplate, row: SlowUrl): Filter {
  return {
    id: newId(),
    field: '',
    op: 'query',
    label: `${row.method ?? ''} ${row.url}`.trim(),
    sql: `(${template.urlExpr}) = ${lit(row.url)} AND (${template.methodExpr}) IS NOT DISTINCT FROM ${row.method === null ? 'NULL' : lit(row.method)}`,
  };
}

export function analysisSearch(search: SearchState, compiled: Compiled, filter: Filter): SearchState {
  return {
    ...search,
    range:
      compiled.from && compiled.to
        ? { from: compiled.from.toISOString(), to: compiled.to.toISOString() }
        : search.range,
    filters: [...search.filters, filter],
  };
}
