import type { TimeRange } from './datemath';
import type { Field } from './fields';
import { findField } from './fields';
import { templateExpr } from './patterns';
import { compileSearch, type Compiled, type QueryPlan } from './queryPlans';
import { lit, newId, tsLit, VIEW, type Filter } from './sql';
import type { DiffState, SearchState } from './state';

export interface DiffRow {
  value: string;
  example: string;
  current: number;
  previous: number;
  delta: number;
}
export interface DiffResult {
  rows: DiffRow[];
  currentTotal: number;
  previousTotal: number;
  totalChanges: number;
}
export interface DiffPlan extends QueryPlan<DiffResult> {
  currentRange: TimeRange;
  previousRange: TimeRange;
  /** The exact grouping expression also defines drill-down membership. */
  groupExpr: string;
  errorWhere: string;
}

export function defaultDiffField(fields: Field[], mode: DiffState['mode']): Field | null {
  const names =
    mode === 'urls'
      ? [
          'url.path',
          'http.path',
          'httpRequest.requestUrl',
          'cs_uri_stem',
          'uri',
          'path',
          'url.full',
          'url',
          'request_url',
          'request',
        ]
      : [
          'message',
          'body.message',
          'jsonPayload.message',
          'textPayload',
          'body',
          'msg',
          'log',
          'line',
          'text',
          'raw',
          'request',
        ];
  const strings = fields.filter((f) => f.kind === 'string');
  return names.map((name) => findField(strings, name)).find((f) => !!f) ?? strings[0] ?? null;
}

/** Group URL query variants together, including ALB's "METHOD URL HTTP/version" field. */
export function urlPathExpr(expr: string): string {
  const target = `regexp_replace(trim(${expr}), '^[A-Z]+\\s+(\\S+)\\s+HTTP/[^ ]+$', '\\1')`;
  const path = `regexp_replace(regexp_replace(${target}, '^[a-zA-Z][a-zA-Z0-9+.-]*://[^/?#]+', ''), '[?#].*$', '')`;
  return `CASE WHEN ${expr} IS NULL OR trim(${expr}) IN ('', '-') THEN NULL ELSE coalesce(nullif(${path}, ''), '/') END`;
}

/** Prefer explicit severity/status fields; only unstructured logs use message keywords. */
export function diffErrorWhere(fields: Field[], message: Field): string {
  const conditions: string[] = [];
  for (const name of ['level', 'severity', 'severity_text', 'log.level', 'severityText']) {
    const f = findField(fields, name);
    if (f)
      conditions.push(
        `upper(CAST(${f.expr} AS VARCHAR)) IN ('ERROR', 'ERR', 'FATAL', 'CRITICAL', 'CRIT', 'ALERT', 'EMERGENCY', 'EMERG', 'PANIC')`,
      );
  }
  const severity = findField(fields, 'severity_number') ?? findField(fields, 'severityNumber');
  if (severity) conditions.push(`TRY_CAST(${severity.expr} AS DOUBLE) BETWEEN 17 AND 24`);
  for (const name of [
    'http.response.status_code',
    'http.status',
    'httpRequest.status',
    'status',
    'status_code',
    'elb_status_code',
    'target_status_code',
    'sc_status',
  ]) {
    const f = findField(fields, name);
    if (f) conditions.push(`TRY_CAST(${f.expr} AS DOUBLE) BETWEEN 500 AND 599`);
  }
  return conditions.length
    ? `(${conditions.join(' OR ')})`
    : `regexp_matches(${message.expr}, '(?i)\\b(error|exception|fatal|panic|failed|failure|timeout)\\b')`;
}

/** Aggregate BOTH periods before ranking; a top-N per period would invent "new" values. */
export function buildDiffQuery(
  settings: DiffState,
  field: Field,
  fields: Field[],
  timeExpr: string | null,
  search: SearchState,
  compiled: Compiled,
): DiffPlan | null {
  const { from, to, context } = compiled;
  if (!timeExpr || compiled.error || !from || !to || to.getTime() <= from.getTime()) return null;
  const previousFrom = new Date(from.getTime() - (to.getTime() - from.getTime()));
  if (!Number.isFinite(previousFrom.getTime())) return null;
  const base = compileSearch(search, fields, null, context);
  if (base.error) return null;
  const groupExpr = settings.mode === 'patterns' ? templateExpr(field.expr) : urlPathExpr(field.expr);
  const errorWhere = settings.errorsOnly
    ? diffErrorWhere(fields, settings.mode === 'patterns' ? field : (defaultDiffField(fields, 'patterns') ?? field))
    : 'TRUE';
  const currentRange = { from: from.toISOString(), to: to.toISOString() };
  const previousRange = { from: previousFrom.toISOString(), to: from.toISOString() };
  const sql = `WITH grouped AS MATERIALIZED (
    SELECT k, count(*) FILTER (WHERE current_period)::DOUBLE AS current_count,
      count(*) FILTER (WHERE NOT current_period)::DOUBLE AS previous_count,
      min(example) FILTER (WHERE current_period) AS example
    FROM (SELECT ${groupExpr} AS k, ${field.expr} AS example, ${timeExpr} >= ${tsLit(from)} AS current_period
      FROM ${VIEW} WHERE (${base.where}) AND (${errorWhere})
        AND ${timeExpr} >= ${tsLit(previousFrom)} AND ${timeExpr} <= ${tsLit(to)}) input
    WHERE k IS NOT NULL AND k <> '' GROUP BY k
  ), totals AS (
    SELECT coalesce(sum(current_count), 0)::DOUBLE AS current_total,
      coalesce(sum(previous_count), 0)::DOUBLE AS previous_total FROM grouped
  ), changes AS (
    SELECT *, current_count - previous_count AS delta, count(*) OVER ()::DOUBLE AS total_changes
    FROM grouped WHERE current_count > previous_count${settings.newOnly ? ' AND previous_count = 0' : ''}
    ORDER BY delta DESC, current_count DESC, k ASC LIMIT 50
  ) SELECT totals.*, changes.* FROM totals LEFT JOIN changes ON TRUE
    ORDER BY delta DESC, current_count DESC, k ASC`;
  return {
    sql,
    currentRange,
    previousRange,
    groupExpr,
    errorWhere,
    read(rows) {
      return {
        currentTotal: Number(rows[0]?.current_total ?? 0),
        previousTotal: Number(rows[0]?.previous_total ?? 0),
        totalChanges: Number(rows[0]?.total_changes ?? 0),
        rows: rows
          .filter((r) => r.k !== null && r.k !== undefined)
          .map((r) => ({
            value: String(r.k),
            example: String(r.example ?? ''),
            current: Number(r.current_count),
            previous: Number(r.previous_count),
            delta: Number(r.delta),
          })),
      };
    },
  };
}

/** Freeze relative time and use exactly the same grouping predicate as the comparison. */
export function diffDrillDown(plan: DiffPlan, row: DiffRow, search: SearchState): SearchState {
  const filter: Filter = {
    id: newId(),
    field: '',
    op: 'query',
    label: row.value,
    sql: `(${plan.groupExpr}) = ${lit(row.value)} AND (${plan.errorWhere})`,
  };
  return { ...search, range: plan.currentRange, filters: [...search.filters, filter] };
}
