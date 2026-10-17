import type { Filter, FilterOp } from './sql';
import {
  DEFAULT_SEARCH,
  DEFAULT_DISCOVER,
  DEFAULT_VIS,
  MAX_TERM_VALUES,
  MAX_BREAKDOWN_VALUES,
  type ChartType,
  type MetricAgg,
  type XAxisDef,
  type SearchState,
  type DiscoverState,
  type SortDir,
  type VisState,
  type MetricDef,
} from './state';
import { quarantineFilters } from './trust';

// ---------- validation of state that arrives from a URL or from localStorage ----------
//
// A hand-edited or truncated link must never take the page down: every field is checked and
// anything malformed falls back to its default.

export const isStr = (v: unknown): v is string => typeof v === 'string';
export const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strOrNull = (v: unknown): string | null => (isStr(v) ? v : null);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback;
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter(isStr) : []);

const FILTER_OPS: readonly FilterOp[] = [
  'is',
  'is_not',
  'is_one_of',
  'is_not_one_of',
  'exists',
  'does_not_exist',
  'between',
  'query',
];
const CHARTS: readonly ChartType[] = ['area', 'line', 'bar', 'table', 'metric'];
const AGGS: readonly MetricAgg[] = [
  'count',
  'sum',
  'avg',
  'min',
  'max',
  'median',
  'unique',
  'p95',
  'p99',
  'percentile',
  'rate',
];
const X_KINDS: readonly XAxisDef['kind'][] = ['date_histogram', 'terms', 'histogram', 'none'];

const boundedSize = (value: unknown, fallback: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(max, Math.floor(value)) : fallback;

/**
 * Validate structure only. Trust decisions are applied separately when restoring external data.
 */
function sanitizeFilters(raw: unknown): Filter[] {
  if (!Array.isArray(raw)) return [];
  const out: Filter[] = [];
  for (const item of raw) {
    if (!isObj(item) || !isStr(item.id) || !isStr(item.field) || !FILTER_OPS.includes(item.op as FilterOp)) continue;
    const f: Filter = { id: item.id, field: item.field, op: item.op as FilterOp };
    if (isStr(item.value)) f.value = item.value;
    if (Array.isArray(item.values)) f.values = item.values.filter(isStr);
    if (isStr(item.from)) f.from = item.from;
    if (isStr(item.to)) f.to = item.to;
    if (item.negate === true) f.negate = true;
    if (item.disabled === true) f.disabled = true;
    if (isStr(item.label)) f.label = item.label;
    if (f.op === 'query') {
      f.sql = isStr(item.sql) ? item.sql : '';
    }
    out.push(f);
  }
  return out;
}

export function sanitizeSearch(raw: unknown): SearchState {
  const r = isObj(raw) ? raw : {};
  const range =
    isObj(r.range) && isStr(r.range.from) && isStr(r.range.to)
      ? { from: r.range.from, to: r.range.to }
      : DEFAULT_SEARCH.range;
  return { query: isStr(r.query) ? r.query : '', range, filters: sanitizeFilters(r.filters) };
}

export function sanitizeDiscover(raw: unknown): DiscoverState {
  const r = isObj(raw) ? raw : {};
  const sort = Array.isArray(r.sort)
    ? r.sort
        .filter(
          (s): s is { field: string; dir: SortDir } =>
            isObj(s) && isStr(s.field) && (s.dir === 'asc' || s.dir === 'desc'),
        )
        .map((s) => ({ field: s.field, dir: s.dir }))
    : [];
  return {
    columns: strList(r.columns),
    sort,
    interval: isStr(r.interval) ? r.interval : DEFAULT_DISCOVER.interval,
    breakdown: strOrNull(r.breakdown),
    ...(isObj(r.diff)
      ? {
          diff: {
            mode: oneOf(r.diff.mode, ['patterns', 'urls'] as const, 'patterns'),
            field: strOrNull(r.diff.field),
            errorsOnly: r.diff.errorsOnly !== false,
            newOnly: r.diff.newOnly === true,
          },
        }
      : {}),
  };
}

export function sanitizeVis(raw: unknown): VisState {
  const r = isObj(raw) ? raw : {};
  const dx = DEFAULT_VIS.x;
  const x = isObj(r.x) ? r.x : {};
  const metrics: MetricDef[] = Array.isArray(r.metrics)
    ? r.metrics.filter(isObj).map((m, i) => {
        const def: MetricDef = {
          id: isStr(m.id) ? m.id : `m${i}`,
          agg: oneOf(m.agg, AGGS, 'count'),
          field: strOrNull(m.field),
        };
        if (isStr(m.label)) def.label = m.label;
        if (typeof m.param === 'number' && m.param >= 0 && m.param <= 100) def.param = m.param;
        return def;
      })
    : [];
  const b = isObj(r.breakdown) ? r.breakdown : {};
  return {
    chart: oneOf(r.chart, CHARTS, DEFAULT_VIS.chart),
    x: {
      kind: oneOf(x.kind, X_KINDS, dx.kind),
      field: strOrNull(x.field),
      interval: isStr(x.interval) ? x.interval : dx.interval,
      size: boundedSize(x.size, dx.size, MAX_TERM_VALUES),
      orderBy: oneOf(x.orderBy, ['metric', 'alpha'] as const, dx.orderBy),
      orderDir: oneOf(x.orderDir, ['asc', 'desc'] as const, dx.orderDir),
    },
    metrics: metrics.length ? metrics : DEFAULT_VIS.metrics,
    breakdown: {
      field: strOrNull(b.field),
      size: boundedSize(b.size, DEFAULT_VIS.breakdown.size, MAX_BREAKDOWN_VALUES),
      other: typeof b.other === 'boolean' ? b.other : DEFAULT_VIS.breakdown.other,
    },
    title: isStr(r.title) ? r.title : '',
    ...(r.percent === true ? { percent: true } : {}),
    ...(r.log === true ? { log: true } : {}),
    ...(r.compare === true ? { compare: true } : {}),
  };
}

/** Every external entry point applies both validation and the local SQL trust policy. */
export function restoreSearch(raw: unknown): SearchState {
  const search = sanitizeSearch(raw);
  return { ...search, filters: quarantineFilters(search.filters) };
}
