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
  const r = await query(
    `WITH b AS (SELECT ${e} AS v FROM ${VIEW} WHERE ${where}),
     t AS (SELECT count(*)::DOUBLE AS n FROM b)
     SELECT v::VARCHAR AS v, count(*)::DOUBLE AS c, (SELECT n FROM t) AS n FROM b GROUP BY v ORDER BY c DESC LIMIT ${size}`,
  );
  const total = Number(r.rows[0]?.n ?? 0);
  return { total, values: r.rows.map((x) => ({ value: x.v === null ? null : String(x.v), count: Number(x.c), pct: total ? Number(x.c) / total : 0 })) };
}

// ---------- Visualize aggregations ----------

export function metricSql(m: MetricDef, fields: Field[]): string {
  if (m.agg === 'count') return 'count(*)::DOUBLE';
  const f = m.field ? findField(fields, m.field) : undefined;
  if (!f) return 'NULL::DOUBLE';
  const num = f.kind === 'number' ? f.expr : `TRY_CAST(${f.expr} AS DOUBLE)`;
  switch (m.agg) {
    case 'sum':
      return `sum(${num})::DOUBLE`;
    case 'avg':
      return `avg(${num})::DOUBLE`;
    case 'min':
      return f.kind === 'number' ? `min(${f.expr})::DOUBLE` : `min(${num})::DOUBLE`;
    case 'max':
      return f.kind === 'number' ? `max(${f.expr})::DOUBLE` : `max(${num})::DOUBLE`;
    case 'median':
      return `median(${num})::DOUBLE`;
    case 'p95':
      return `quantile_cont(${num}, 0.95)::DOUBLE`;
    case 'p99':
      return `quantile_cont(${num}, 0.99)::DOUBLE`;
    case 'unique':
      return `count(DISTINCT ${f.expr})::DOUBLE`;
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

export async function fetchVis(vis: VisState, where: string, timeExpr: string | null, fields: Field[], iv: Interval | null, tzOffset: number): Promise<VisResult> {
  const ms = vis.metrics.map((m) => metricSql(m, fields));
  const mSel = ms.map((s, i) => `${s} AS m${i}`).join(', ');
  const xf = vis.x.field ? findField(fields, vis.x.field) : undefined;
  let xExpr: string | null = null;
  let xOrderSql = '';
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

  const ctes: string[] = [`base AS (SELECT * FROM ${VIEW} WHERE ${where})`];
  const xSel = xExpr ? `${xExpr} AS x` : `NULL AS x`;
  let gSel = gExpr ? `${gExpr} AS g` : `NULL AS g`;
  const joins: string[] = [];

  if (xKind === 'terms' && xExpr) {
    const ord = vis.x.orderBy === 'alpha' ? `x ${vis.x.orderDir.toUpperCase()}` : `m0 ${vis.x.orderDir.toUpperCase()} NULLS LAST`;
    ctes.push(`topx AS (SELECT ${xExpr} AS x, ${ms[0]} AS m0 FROM base GROUP BY 1 ORDER BY ${ord} LIMIT ${Math.max(1, vis.x.size)})`);
    joins.push(`${xExpr} IN (SELECT x FROM topx)`);
    xOrderSql = 'topx';
  }
  if (gExpr) {
    ctes.push(`topg AS (SELECT ${gExpr} AS g, ${ms[0]} AS m0 FROM base GROUP BY 1 ORDER BY m0 DESC NULLS LAST LIMIT ${Math.max(1, vis.breakdown.size)})`);
    if (vis.breakdown.other) gSel = `CASE WHEN ${gExpr} IN (SELECT g FROM topg) THEN ${gExpr} ELSE ${lit(OTHER)} END AS g`;
    else joins.push(`${gExpr} IN (SELECT g FROM topg)`);
  }
  const whereExtra = joins.length ? ` WHERE ${joins.join(' AND ')}` : '';
  const sql = `WITH ${ctes.join(',\n')}\nSELECT ${xSel}, ${gSel}, ${mSel} FROM base${whereExtra} GROUP BY 1, 2 ORDER BY 1, 2`;
  const r = await query(sql);
  const rows: VisRow[] = r.rows.map((row: Row) => ({
    x: row.x === null || row.x === undefined ? null : xKind === 'terms' ? String(row.x) : Number(row.x),
    g: row.g === null || row.g === undefined ? (gExpr ? NULL_GROUP : null) : String(row.g),
    m: ms.map((_, i) => (row[`m${i}`] === null || row[`m${i}`] === undefined ? NaN : Number(row[`m${i}`]))),
  }));

  let xOrder: (string | number)[];
  if (xOrderSql) {
    const o = await query(`WITH ${ctes.join(',\n')} SELECT x FROM topx`);
    xOrder = o.rows.map((x) => String(x.x));
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
