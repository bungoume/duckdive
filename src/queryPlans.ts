import { timeContext, type TimeContext } from './datemath';
import type { Row } from './duck';
import type { Field } from './fields';
import { findField, quoteIdent } from './fields';
import { describeError } from './errors';
import { searchToSql } from './search';
import { VIEW, bucketExpr, buildWhere, fieldCompareExpr, nextBucketStart, type Interval } from './sql';
import {
  MAX_BREAKDOWN_VALUES,
  MAX_TERM_VALUES,
  type MetricDef,
  type SearchState,
  type SortDir,
  type VisState,
} from './state';
import { t } from './i18n';
import { supportsComparison } from './comparison';

export interface QueryPlan<T> {
  sql: string;
  read(rows: Row[]): T;
}

export interface Compiled {
  context: TimeContext;
  where: string;
  from: Date | null;
  to: Date | null;
  error: string | null;
}

export function compileSearch(
  search: SearchState,
  fields: Field[],
  timeExpr: string | null,
  context = timeContext(),
): Compiled {
  try {
    const querySql = searchToSql(search.query, fields, context);
    const w = buildWhere({ timeExpr, range: search.range, querySql, filters: search.filters, fields }, context);
    return { context, where: w.sql, from: w.from, to: w.to, error: null };
  } catch (e) {
    return { context, where: 'FALSE', from: null, to: null, error: describeError(e) };
  }
}

export interface Doc {
  ts: number | null;
  source: Record<string, unknown>;
  cols: Record<string, unknown>;
}

export function buildDocsQuery(
  where: string,
  timeExpr: string | null,
  fields: Field[],
  sort: { field: string; dir: SortDir }[],
  columns: string[],
  limit: number,
  offset: number,
  timeDir: SortDir = 'desc',
): QueryPlan<{ docs: Doc[]; sql: string }> {
  const sel: string[] = [];
  sel.push(timeExpr ? `epoch_ms(${timeExpr})::DOUBLE AS "__ts"` : `NULL AS "__ts"`);
  sel.push(`to_json(t)::VARCHAR AS "__src"`);
  const colFields = columns.map((c) => findField(fields, c)).filter((f): f is Field => !!f);
  colFields.forEach((f, i) => sel.push(`(${f.expr})::VARCHAR AS "__c${i}"`));
  const sql = `SELECT ${sel.join(', ')} FROM ${VIEW} t WHERE ${where}${docsOrder(sort, fields, timeExpr, timeDir)} LIMIT ${limit} OFFSET ${offset}`;
  return {
    sql,
    read(rows: Row[]) {
      const docs = rows.map((row) => {
        let source: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(String(row.__src));
          source =
            parsed && typeof parsed === 'object' && !Array.isArray(parsed)
              ? (parsed as Record<string, unknown>)
              : { _raw: row.__src };
        } catch {
          source = { _raw: row.__src };
        }
        const cols: Record<string, unknown> = {};
        colFields.forEach((f, i) => (cols[f.name] = row[`__c${i}`]));
        return { ts: row.__ts === null ? null : Number(row.__ts), source, cols };
      });
      return { docs, sql };
    },
  };
}

/** ORDER BY of the document table: the chosen sorts, else by time (newest first unless `timeDir` says asc; '' without a time field). */
export function docsOrder(
  sort: { field: string; dir: SortDir }[],
  fields: Field[],
  timeExpr: string | null,
  timeDir: SortDir = 'desc',
): string {
  const order: string[] = [];
  for (const s of sort) {
    const f = findField(fields, s.field);
    if (f) order.push(`${fieldCompareExpr(f)} ${s.dir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST`);
  }
  if (!order.length && timeExpr) order.push(`${timeExpr} ${timeDir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST`);
  return order.length ? ' ORDER BY ' + order.join(', ') : '';
}

/**
 * SELECT behind an export of the document table: the time column and the selected columns
 * under their field names, or every column of the source when none is selected; sorted like
 * the table and cut at `limit` rows.
 */
export function exportDocsSql(
  where: string,
  timeField: Field | null,
  timeExpr: string | null,
  fields: Field[],
  sort: { field: string; dir: SortDir }[],
  columns: string[],
  limit: number,
): string {
  const colFields = columns.map((c) => findField(fields, c)).filter((f): f is Field => !!f);
  const sel: string[] = [];
  if (!colFields.length) sel.push('*');
  else {
    if (timeField && timeExpr && !colFields.includes(timeField))
      sel.push(`${timeExpr} AS ${quoteIdent(timeField.name)}`);
    for (const f of colFields) sel.push(`${f.expr} AS ${quoteIdent(f.name)}`);
  }
  return `SELECT ${sel.join(', ')} FROM ${VIEW} t WHERE ${where}${docsOrder(sort, fields, timeExpr)} LIMIT ${Math.max(1, Math.floor(limit))}`;
}

// ---------- Visualize aggregations ----------

/**
 * How a metric is computed: the column expression it reads (null for count) and the aggregate over
 * that column. `secs` is the length of one bucket (or of the whole range) for the rate per second.
 */
export function metricPlan(
  m: MetricDef,
  fields: Field[],
  secs = 1,
): { input: string | null; agg: (col: string) => string } {
  if (m.agg === 'count') return { input: null, agg: () => 'count(*)::DOUBLE' };
  if (m.agg === 'rate') return { input: null, agg: () => `(count(*)::DOUBLE / ${secs > 0 ? secs : 1})` };
  const f = m.field ? findField(fields, m.field) : undefined;
  if (!f) return { input: null, agg: () => 'NULL::DOUBLE' };
  const num = f.kind === 'number' ? f.expr : `TRY_CAST(${f.expr} AS DOUBLE)`;
  switch (m.agg) {
    case 'sum':
      return { input: num, agg: (c) => `sum(${c})::DOUBLE` };
    case 'avg':
      return { input: num, agg: (c) => `avg(${c})::DOUBLE` };
    case 'min':
      return { input: num, agg: (c) => `min(${c})::DOUBLE` };
    case 'max':
      return { input: num, agg: (c) => `max(${c})::DOUBLE` };
    case 'median':
      return { input: num, agg: (c) => `median(${c})::DOUBLE` };
    case 'p95':
      return { input: num, agg: (c) => `quantile_cont(${c}, 0.95)::DOUBLE` };
    case 'p99':
      return { input: num, agg: (c) => `quantile_cont(${c}, 0.99)::DOUBLE` };
    case 'percentile':
      return {
        input: num,
        agg: (c) => `quantile_cont(${c}, ${Math.min(100, Math.max(0, m.param ?? 90)) / 100})::DOUBLE`,
      };
    case 'unique':
      return { input: f.expr, agg: (c) => `count(DISTINCT ${c})::DOUBLE` };
  }
}

export function metricLabel(m: MetricDef): string {
  if (m.label) return m.label;
  if (m.agg === 'count') return t('metric.count');
  if (m.agg === 'rate') return t('metric.rate');
  if (m.agg === 'percentile') return t('metric.percentile', { p: m.param ?? 90, field: m.field ?? '?' });
  return t('metric.of', { agg: t(`vis.agg.${m.agg}`), field: m.field ?? '?' });
}

export interface VisRow {
  x: number | string | null;
  g: string | null;
  m: number[];
}

export interface VisResult {
  rows: VisRow[];
  xKind: VisState['x']['kind'];
  xOrder: (string | number)[];
  groups: string[];
  interval: Interval | null;
  /** offset (minutes east of UTC) the date-histogram buckets were aligned with */
  tzOffset: number;
  /** bucket width of a numeric histogram (chosen from the data when the definition says auto) */
  step: number | null;
  sql: string;
}

/** The same search constraints over the preceding period; dashboard tiles add their saved search. */
export function previousPeriodWhere(
  vis: VisState,
  compiled: Compiled,
  searches: SearchState[],
  fields: Field[],
  timeExpr: string | null,
): string | null {
  const span = compiled.from && compiled.to ? compiled.to.getTime() - compiled.from.getTime() : 0;
  if (!supportsComparison(vis) || span <= 0 || !compiled.from || !compiled.to) return null;
  const range = { from: new Date(compiled.from.getTime() - span).toISOString(), to: compiled.from.toISOString() };
  return searches
    .map((search) => `(${compileSearch({ ...search, range }, fields, timeExpr, compiled.context).where})`)
    .join(' AND ');
}

/** Move the preceding period's buckets onto the current chart without changing its result. */
export function shiftVisResult(result: VisResult | null, ms: number): VisResult | null {
  return result
    ? {
        ...result,
        rows: result.rows.map((row) => ({ ...row, x: typeof row.x === 'number' ? row.x + ms : row.x })),
        xOrder: result.xOrder.map((x) => (typeof x === 'number' ? x + ms : x)),
      }
    : null;
}

/** Internal visualization values. Raw strings are prefixed so they cannot collide with sentinels. */
const VALUE_PREFIX = '\u{e000}value:';
export const OTHER = '\u{e000}other';
export const NULL_GROUP = '\u{e000}null';

export function encodeVisValue(value: unknown): string {
  return value === null || value === undefined ? NULL_GROUP : VALUE_PREFIX + String(value);
}

export function decodeVisValue(value: string): string | null {
  if (value === NULL_GROUP) return null;
  return value.startsWith(VALUE_PREFIX) ? value.slice(VALUE_PREFIX.length) : value;
}

/** Display text of a group / series value. */
export function groupLabel(g: string): string {
  if (g === OTHER) return t('vis.other');
  const value = decodeVisValue(g);
  if (value === null) return t('common.null');
  return value === t('vis.other') || value === t('common.null') ? JSON.stringify(value) : value;
}

/**
 * One statement per chart. The rows of the time window are projected once (x, group and the
 * metric inputs only) into a materialised CTE; the top-N of x, the top-N of the group and the
 * final aggregation all read that instead of scanning the source view again, which for gzip
 * sources means one decompression instead of three or four.
 */
export function buildVisQuery(
  vis: VisState,
  where: string,
  timeExpr: string | null,
  fields: Field[],
  iv: Interval | null,
  tzOffset: number,
  spanSec: number,
  context: TimeContext,
  stepHint?: number,
): QueryPlan<VisResult> {
  // a rate is per bucket second on a date histogram, per second of the whole range otherwise
  const variableBucket = vis.x.kind === 'date_histogram' && (iv?.calendar === 'month' || iv?.calendar === 'year');
  const secs = variableBucket ? 1 : vis.x.kind === 'date_histogram' && iv ? iv.ms / 1000 : spanSec;
  const plans = vis.metrics.map((m) => metricPlan(m, fields, secs));
  const ms = plans.map((p, i) => p.agg(`v${i}`));
  const mSel = ms.map((s, i) => `${s} AS m${i}`).join(', ');
  const xf = vis.x.field ? findField(fields, vis.x.field) : undefined;
  let xExpr: string | null = null;
  let xKind = vis.x.kind;
  let step: number | null = null;
  if (xKind === 'date_histogram') {
    const te = xf ? `(${xf.expr})::TIMESTAMP` : timeExpr;
    if (te && iv) xExpr = bucketExpr(te, iv, tzOffset, context.dayOfWeek);
    else xKind = 'none';
  } else if (xKind === 'terms' && xf) {
    xExpr = `(${xf.expr})::VARCHAR`;
  } else if (xKind === 'histogram' && xf) {
    const num = xf.kind === 'number' ? xf.expr : `TRY_CAST(${xf.expr} AS DOUBLE)`;
    const requestedStep = Number(vis.x.interval);
    step = Number.isFinite(requestedStep) && requestedStep > 0 ? requestedStep : null;
    step ??= stepHint ?? 1;
    xExpr = `(floor(${num} / ${step}) * ${step})::DOUBLE`;
  } else xKind = 'none';

  const gf = vis.breakdown.field ? findField(fields, vis.breakdown.field) : undefined;
  const gExpr = gf ? `(${gf.expr})::VARCHAR` : null;

  const inputs = plans.map((p, i) => (p.input ? `, ${p.input} AS v${i}` : '')).join('');
  const ctes: string[] = [
    `base AS MATERIALIZED (SELECT ${xExpr ?? 'NULL'} AS x, ${gExpr ?? 'NULL'} AS g${inputs} FROM ${VIEW} WHERE ${where})`,
  ];
  let gSel = 'g';
  let otherSel = '';
  let groupBy = '1, 2';
  const conds: string[] = [];
  const dir = vis.x.orderDir.toUpperCase();
  const topX = xKind === 'terms' && !!xExpr;
  if (topX) {
    const ord = vis.x.orderBy === 'alpha' ? `x ${dir}` : `${ms[0]} ${dir} NULLS LAST`;
    const limit = Math.min(MAX_TERM_VALUES, Math.max(1, Number.isFinite(vis.x.size) ? Math.floor(vis.x.size) : 1));
    ctes.push(
      `topx AS (SELECT x, row_number() OVER (ORDER BY ${ord}) AS rk FROM base GROUP BY x ORDER BY rk LIMIT ${limit})`,
    );
  }
  if (gExpr) {
    const limit = Math.min(
      MAX_BREAKDOWN_VALUES,
      Math.max(1, Number.isFinite(vis.breakdown.size) ? Math.floor(vis.breakdown.size) : 1),
    );
    ctes.push(`topg AS (SELECT g, ${ms[0]} AS m0 FROM base GROUP BY g ORDER BY m0 DESC NULLS LAST LIMIT ${limit})`);
    const inTopG = `EXISTS (SELECT 1 FROM topg WHERE topg.g IS NOT DISTINCT FROM base.g)`;
    if (vis.breakdown.other) {
      gSel = `CASE WHEN ${inTopG} THEN g ELSE NULL END`;
      otherSel = `, NOT (${inTopG}) AS __other`;
      groupBy = '1, 2, 3';
    } else conds.push(inTopG);
  }
  const join = topX ? ' JOIN topx ON topx.x IS NOT DISTINCT FROM base.x' : '';
  const sql = `WITH ${ctes.join(',\n')}\nSELECT base.x AS x, ${gSel} AS g${otherSel}, ${mSel}${topX ? ', min(topx.rk) AS xr' : ''} FROM base${join}${conds.length ? ' WHERE ' + conds.join(' AND ') : ''} GROUP BY ${groupBy} ORDER BY 1, 2`;
  return {
    sql,
    read(rawRows: Row[]): VisResult {
      const rows: VisRow[] = rawRows.map((row: Row) => {
        const x =
          xKind === 'terms' ? encodeVisValue(row.x) : row.x === null || row.x === undefined ? null : Number(row.x);
        return {
          x,
          g: gExpr ? (row.__other ? OTHER : encodeVisValue(row.g)) : null,
          m: ms.map((_, i) => {
            const raw = row[`m${i}`];
            if (raw === null || raw === undefined) return NaN;
            const value = Number(raw);
            if (!variableBucket || vis.metrics[i].agg !== 'rate' || typeof x !== 'number' || !iv) return value;
            return value / ((nextBucketStart(x, iv, tzOffset) - x) / 1000);
          }),
        };
      });

      let xOrder: (string | number)[];
      if (topX) {
        // the rank of each x comes back with its rows (min over the groups of that x)
        const rank = new Map<string, number>();
        rawRows.forEach((row: Row) => {
          rank.set(encodeVisValue(row.x), Number(row.xr));
        });
        xOrder = [...rank.entries()].sort((a, b) => a[1] - b[1]).map((e) => e[0]);
      } else {
        xOrder = Array.from(new Set(rows.map((x) => x.x).filter((x): x is number => x !== null))).sort((a, b) => a - b);
      }
      let groups: string[] = [];
      if (gExpr) {
        const totals = new Map<string, number>();
        for (const row of rows)
          totals.set(row.g!, (totals.get(row.g!) ?? 0) + (Number.isFinite(row.m[0]) ? row.m[0] : 0));
        groups = Array.from(totals.entries())
          .sort((a, b) => b[1] - a[1])
          .map((e) => e[0]);
        if (groups.includes(OTHER)) groups = [...groups.filter((g) => g !== OTHER), OTHER];
      }
      return { rows, xKind, xOrder, groups, interval: xKind === 'date_histogram' ? iv : null, tzOffset, step, sql };
    },
  };
}

/** Numeric histograms need one bounds query only when their width is automatic. */
export function visBoundsSql(vis: VisState, fields: Field[], where: string): string | null {
  const field = vis.x.field ? findField(fields, vis.x.field) : undefined;
  const width = Number(vis.x.interval);
  if (vis.x.kind !== 'histogram' || !field || (Number.isFinite(width) && width > 0)) return null;
  const value = field.kind === 'number' ? field.expr : `TRY_CAST(${field.expr} AS DOUBLE)`;
  return `SELECT min(${value})::DOUBLE AS mn, max(${value})::DOUBLE AS mx FROM ${VIEW} WHERE ${where}`;
}
