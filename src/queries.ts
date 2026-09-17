import { query, type Row } from './duck';
import type { Field } from './fields';
import { findField } from './fields';
import { SearchQueryError, searchToSql } from './search';
import { VIEW, bucketExpr, buildWhere, fieldCompareExpr, lit, type Interval } from './sql';
import type { MetricDef, SearchState, SortDir, VisState } from './state';
import { t, type MsgKey } from './i18n';

export interface Compiled {
  where: string;
  from: Date | null;
  to: Date | null;
  error: string | null;
}

export function compileSearch(search: SearchState, fields: Field[], timeExpr: string | null): Compiled {
  let querySql: string;
  let error: string | null = null;
  try {
    querySql = searchToSql(search.query, fields);
  } catch (e) {
    error = e instanceof SearchQueryError ? e.message : String(e);
    querySql = 'FALSE';
  }
  const w = buildWhere({ timeExpr, range: search.range, querySql, filters: search.filters, fields });
  return { where: w.sql, from: w.from, to: w.to, error };
}

export interface Bucket {
  t: number;
  c: number;
}

export async function fetchHistogram(where: string, timeExpr: string, iv: Interval, tzOffset: number): Promise<Bucket[]> {
  const r = await query(`SELECT ${bucketExpr(timeExpr, iv, tzOffset)} AS t, count(*)::DOUBLE AS c FROM ${VIEW} WHERE ${where} GROUP BY 1 ORDER BY 1`);
  return r.rows.map((x) => ({ t: Number(x.t), c: Number(x.c) }));
}

export async function fetchCount(where: string): Promise<number> {
  const r = await query(`SELECT count(*)::DOUBLE AS n FROM ${VIEW} WHERE ${where}`);
  return Number(r.rows[0]?.n ?? 0);
}

export interface Doc {
  ts: number | null;
  source: Record<string, unknown>;
  cols: Record<string, unknown>;
}

export async function fetchDocs(where: string, timeExpr: string | null, fields: Field[], sort: { field: string; dir: SortDir }[], columns: string[], limit: number, offset: number): Promise<Doc[]> {
  const sel: string[] = [];
  sel.push(timeExpr ? `epoch_ms(${timeExpr})::DOUBLE AS "__ts"` : `NULL AS "__ts"`);
  sel.push(`to_json(t)::VARCHAR AS "__src"`);
  const colFields = columns.map((c) => findField(fields, c)).filter((f): f is Field => !!f);
  colFields.forEach((f, i) => sel.push(`(${f.expr})::VARCHAR AS "__c${i}"`));
  const order: string[] = [];
  for (const s of sort) {
    const f = findField(fields, s.field);
    if (f) order.push(`${fieldCompareExpr(f)} ${s.dir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST`);
  }
  if (!order.length && timeExpr) order.push(`${timeExpr} DESC NULLS LAST`);
  const sql = `SELECT ${sel.join(', ')} FROM ${VIEW} t WHERE ${where}${order.length ? ' ORDER BY ' + order.join(', ') : ''} LIMIT ${limit} OFFSET ${offset}`;
  const r = await query(sql);
  return r.rows.map((row) => {
    let source: Record<string, unknown>;
    try {
      source = JSON.parse(String(row.__src));
    } catch {
      source = { _raw: row.__src };
    }
    const cols: Record<string, unknown> = {};
    colFields.forEach((f, i) => (cols[f.name] = row[`__c${i}`]));
    return { ts: row.__ts === null ? null : Number(row.__ts), source, cols };
  });
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

// ---------- Visualize aggregations ----------

/** How a metric is computed: the column expression it reads (null for count) and the aggregate over that column. */
export function metricPlan(m: MetricDef, fields: Field[]): { input: string | null; agg: (col: string) => string } {
  if (m.agg === 'count') return { input: null, agg: () => 'count(*)::DOUBLE' };
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
    case 'unique':
      return { input: f.expr, agg: (c) => `count(DISTINCT ${c})::DOUBLE` };
  }
}

export function metricLabel(m: MetricDef): string {
  if (m.label) return m.label;
  if (m.agg === 'count') return t('metric.count');
  return t('metric.of', { agg: t(`vis.agg.${m.agg}` as MsgKey), field: m.field ?? '?' });
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
  sql: string;
}

/** Sentinel group values (not shown as such: see groupLabel). */
export const OTHER = 'Other';
export const NULL_GROUP = '(null)';

/** Display text of a group / series value. */
export function groupLabel(g: string): string {
  return g === OTHER ? t('vis.other') : g === NULL_GROUP ? t('common.null') : g;
}

/**
 * One statement per chart. The rows of the time window are projected once (x, group and the
 * metric inputs only) into a materialised CTE; the top-N of x, the top-N of the group and the
 * final aggregation all read that instead of scanning the source view again, which for gzip
 * sources means one decompression instead of three or four.
 */
export async function fetchVis(vis: VisState, where: string, timeExpr: string | null, fields: Field[], iv: Interval | null, tzOffset: number): Promise<VisResult> {
  const plans = vis.metrics.map((m) => metricPlan(m, fields));
  const ms = plans.map((p, i) => p.agg(`v${i}`));
  const mSel = ms.map((s, i) => `${s} AS m${i}`).join(', ');
  const xf = vis.x.field ? findField(fields, vis.x.field) : undefined;
  let xExpr: string | null = null;
  let xKind = vis.x.kind;
  if (xKind === 'date_histogram') {
    const te = xf ? `(${xf.expr})::TIMESTAMP` : timeExpr;
    if (te && iv) xExpr = bucketExpr(te, iv, tzOffset);
    else xKind = 'none';
  } else if (xKind === 'terms' && xf) {
    xExpr = `(${xf.expr})::VARCHAR`;
  } else if (xKind === 'histogram' && xf) {
    const step = Number(vis.x.interval) > 0 ? Number(vis.x.interval) : 10;
    xExpr = `(floor(TRY_CAST(${xf.expr} AS DOUBLE) / ${step}) * ${step})::DOUBLE`;
  } else xKind = 'none';

  const gf = vis.breakdown.field ? findField(fields, vis.breakdown.field) : undefined;
  const gExpr = gf ? `(${gf.expr})::VARCHAR` : null;

  const inputs = plans.map((p, i) => (p.input ? `, ${p.input} AS v${i}` : '')).join('');
  const ctes: string[] = [`base AS MATERIALIZED (SELECT ${xExpr ?? 'NULL'} AS x, ${gExpr ?? 'NULL'} AS g${inputs} FROM ${VIEW} WHERE ${where})`];
  let gSel = 'g';
  const conds: string[] = [];
  const dir = vis.x.orderDir.toUpperCase();
  const topX = xKind === 'terms' && !!xExpr;
  if (topX) {
    const ord = vis.x.orderBy === 'alpha' ? `x ${dir}` : `${ms[0]} ${dir} NULLS LAST`;
    ctes.push(`topx AS (SELECT x, row_number() OVER (ORDER BY ${ord}) AS rk FROM base GROUP BY x ORDER BY rk LIMIT ${Math.max(1, vis.x.size)})`);
  }
  if (gExpr) {
    ctes.push(`topg AS (SELECT g, ${ms[0]} AS m0 FROM base GROUP BY g ORDER BY m0 DESC NULLS LAST LIMIT ${Math.max(1, vis.breakdown.size)})`);
    if (vis.breakdown.other) gSel = `CASE WHEN g IN (SELECT g FROM topg) THEN g ELSE ${lit(OTHER)} END`;
    else conds.push(`g IN (SELECT g FROM topg)`);
  }
  const join = topX ? ' JOIN topx ON topx.x = base.x' : '';
  const sql = `WITH ${ctes.join(',\n')}\nSELECT base.x AS x, ${gSel} AS g, ${mSel}${topX ? ', min(topx.rk) AS xr' : ''} FROM base${join}${conds.length ? ' WHERE ' + conds.join(' AND ') : ''} GROUP BY 1, 2 ORDER BY 1, 2`;
  const r = await query(sql);
  const rows: VisRow[] = r.rows.map((row: Row) => ({
    x: row.x === null || row.x === undefined ? null : xKind === 'terms' ? String(row.x) : Number(row.x),
    g: row.g === null || row.g === undefined ? (gExpr ? NULL_GROUP : null) : String(row.g),
    m: ms.map((_, i) => (row[`m${i}`] === null || row[`m${i}`] === undefined ? NaN : Number(row[`m${i}`]))),
  }));

  let xOrder: (string | number)[];
  if (topX) {
    // the rank of each x comes back with its rows (min over the groups of that x)
    const rank = new Map<string, number>();
    r.rows.forEach((row: Row) => {
      if (row.x !== null && row.x !== undefined) rank.set(String(row.x), Number(row.xr));
    });
    xOrder = [...rank.entries()].sort((a, b) => a[1] - b[1]).map((e) => e[0]);
  } else {
    xOrder = Array.from(new Set(rows.map((x) => x.x).filter((x): x is number => x !== null))).sort((a, b) => a - b);
  }
  let groups: string[] = [];
  if (gExpr) {
    const totals = new Map<string, number>();
    for (const row of rows) totals.set(row.g!, (totals.get(row.g!) ?? 0) + (Number.isFinite(row.m[0]) ? row.m[0] : 0));
    groups = Array.from(totals.entries())
      .sort((a, b) => b[1] - a[1])
      .map((e) => e[0]);
    if (groups.includes(OTHER)) groups = [...groups.filter((g) => g !== OTHER), OTHER];
  }
  return { rows, xKind, xOrder, groups, interval: xKind === 'date_histogram' ? iv : null, tzOffset, sql };
}
