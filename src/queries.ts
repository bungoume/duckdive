import { query } from './duck';
import type { Field } from './fields';
import { templateExpr } from './patterns';
import { VIEW, bucketExpr, niceStep, type Interval } from './sql';
import type { SortDir, VisState } from './state';
import { timeContext } from './datemath';
import { buildDocsQuery, buildVisQuery, visBoundsSql } from './queryPlans';

export interface Bucket {
  t: number;
  c: number;
}

export async function fetchHistogram(where: string, timeExpr: string, iv: Interval, tzOffset: number, signal?: AbortSignal, context = timeContext()): Promise<Bucket[]> {
  const r = await query(`SELECT ${bucketExpr(timeExpr, iv, tzOffset, context.dayOfWeek)} AS t, count(*)::DOUBLE AS c FROM ${VIEW} WHERE ${where} GROUP BY 1 ORDER BY 1`, signal);
  return r.rows.map((x) => ({ t: Number(x.t), c: Number(x.c) }));
}

export async function fetchCount(where: string, signal?: AbortSignal): Promise<number> {
  const r = await query(`SELECT count(*)::DOUBLE AS n FROM ${VIEW} WHERE ${where}`, signal);
  return Number(r.rows[0]?.n ?? 0);
}

export async function fetchDocs(
  where: string,
  timeExpr: string | null,
  fields: Field[],
  sort: { field: string; dir: SortDir }[],
  columns: string[],
  limit: number,
  offset: number,
  timeDir: SortDir = 'desc',
  signal?: AbortSignal,
) {
  const plan = buildDocsQuery(where, timeExpr, fields, sort, columns, limit, offset, timeDir);
  return plan.read((await query(plan.sql, signal)).rows);
}

export async function fetchVis(
  vis: VisState,
  where: string,
  timeExpr: string | null,
  fields: Field[],
  iv: Interval | null,
  tzOffset: number,
  spanSec: number,
  signal?: AbortSignal,
  context = timeContext(),
) {
  const boundsSql = visBoundsSql(vis, fields, where);
  let step: number | undefined;
  if (boundsSql) {
    const bounds = await query(boundsSql, signal);
    const min = Number(bounds.rows[0]?.mn);
    const max = Number(bounds.rows[0]?.mx);
    step = Number.isFinite(min) && Number.isFinite(max) && max > min ? niceStep((max - min) / 25) : 1;
  }
  const plan = buildVisQuery(vis, where, timeExpr, fields, iv, tzOffset, spanSec, context, step);
  return plan.read((await query(plan.sql, signal)).rows);
}

export interface TopValue {
  value: string | null;
  count: number;
  pct: number;
}

export async function fetchTopValues(where: string, f: Field, size = 5): Promise<{ values: TopValue[]; total: number }> {
  const e = f.kind === 'string' || f.kind === 'number' || f.kind === 'boolean' ? f.expr : `(${f.expr})::VARCHAR`;
  // one pass: the total is a window over the grouped counts, not a second scan of the view
  const r = await query(
    `SELECT v::VARCHAR AS v, count(*)::DOUBLE AS c, sum(count(*)) OVER ()::DOUBLE AS n
     FROM (SELECT ${e} AS v FROM ${VIEW} WHERE ${where}) b GROUP BY v ORDER BY c DESC LIMIT ${size}`,
  );
  const total = Number(r.rows[0]?.n ?? 0);
  return { total, values: r.rows.map((x) => ({ value: x.v === null ? null : String(x.v), count: Number(x.c), pct: total ? Number(x.c) / total : 0 })) };
}

export interface NumberStats {
  count: number;
  min: number;
  max: number;
  avg: number;
  p50: number;
  p95: number;
  /** counts of `bins` equal-width buckets from min to max */
  bins: number[];
  width: number;
}

/** Summary and a small distribution of a numeric field (two statements: the bounds decide the buckets). */
export async function fetchNumberStats(where: string, f: Field, bins = 10): Promise<NumberStats | null> {
  const x = f.kind === 'number' ? f.expr : `TRY_CAST(${f.expr} AS DOUBLE)`;
  const s = await query(
    `SELECT count(${x})::DOUBLE AS n, min(${x})::DOUBLE AS mn, max(${x})::DOUBLE AS mx, avg(${x})::DOUBLE AS av, quantile_cont(${x}, 0.5)::DOUBLE AS p50, quantile_cont(${x}, 0.95)::DOUBLE AS p95 FROM ${VIEW} WHERE ${where}`,
  );
  const r = s.rows[0];
  if (!r || !Number(r.n)) return null;
  const mn = Number(r.mn);
  const mx = Number(r.mx);
  const width = (mx - mn) / bins;
  const counts: number[] = new Array<number>(bins).fill(0);
  if (width > 0) {
    const h = await query(`SELECT least(${bins - 1}, floor((${x} - (${mn})) / ${width}))::INT AS b, count(*)::DOUBLE AS c FROM ${VIEW} WHERE ${where} AND ${x} IS NOT NULL GROUP BY 1`);
    for (const row of h.rows) counts[Number(row.b)] = Number(row.c);
  } else counts[0] = Number(r.n);
  return { count: Number(r.n), min: mn, max: mx, avg: Number(r.av), p50: Number(r.p50), p95: Number(r.p95), bins: counts, width };
}

export interface LogPattern {
  tpl: string;
  count: number;
  pct: number;
  example: string;
}

/** The templates of a text field's values in the search (see patterns.ts), most frequent first. */
export async function fetchPatterns(where: string, f: Field, limit = 50): Promise<{ patterns: LogPattern[]; total: number }> {
  const e = f.kind === 'string' ? f.expr : `(${f.expr})::VARCHAR`;
  const r = await query(
    `SELECT tpl, count(*)::DOUBLE AS c, any_value(v) AS ex, sum(count(*)) OVER ()::DOUBLE AS n
     FROM (SELECT ${templateExpr('v')} AS tpl, v FROM (SELECT ${e} AS v FROM ${VIEW} WHERE ${where}) s WHERE v IS NOT NULL) g
     GROUP BY tpl ORDER BY c DESC LIMIT ${limit}`,
  );
  const total = Number(r.rows[0]?.n ?? 0);
  return { total, patterns: r.rows.map((x) => ({ tpl: String(x.tpl), count: Number(x.c), pct: total ? Number(x.c) / total : 0, example: String(x.ex ?? '') })) };
}
