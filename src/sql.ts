import type { TimeRange } from './datemath';
import { resolveRange } from './datemath';
import { effectiveTimeZone, zonedParts } from './datefmt';
import type { Field } from './fields';
import { findField } from './fields';
import { t, type MsgKey } from './i18n';
import { getSettings } from './settings';
import { pad } from './util';

export const VIEW = 'src';

export function lit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Naive UTC TIMESTAMP literal. */
export function tsLit(d: Date): string {
  return `TIMESTAMP '${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getMilliseconds(), 3)}'`;
}

export interface Interval {
  /** nominal ms per bucket (axis spacing; calendar buckets vary in length) */
  ms: number;
  /** DuckDB INTERVAL text, e.g. "5 minute" */
  sql: string;
  key: string;
  /** buckets that follow the calendar rather than a fixed length (see nextBucketStart) */
  calendar?: 'week' | 'month' | 'year';
}

export const INTERVALS: Interval[] = [
  { key: '1s', ms: 1000, sql: '1 second' },
  { key: '5s', ms: 5000, sql: '5 second' },
  { key: '10s', ms: 10000, sql: '10 second' },
  { key: '30s', ms: 30000, sql: '30 second' },
  { key: '1m', ms: 60000, sql: '1 minute' },
  { key: '5m', ms: 300000, sql: '5 minute' },
  { key: '10m', ms: 600000, sql: '10 minute' },
  { key: '30m', ms: 1800000, sql: '30 minute' },
  { key: '1h', ms: 3600000, sql: '1 hour' },
  { key: '3h', ms: 3 * 3600000, sql: '3 hour' },
  { key: '12h', ms: 12 * 3600000, sql: '12 hour' },
  { key: '1d', ms: 86400000, sql: '1 day' },
  { key: '1w', ms: 7 * 86400000, sql: '7 day', calendar: 'week' },
  { key: '1M', ms: 30 * 86400000, sql: '1 month', calendar: 'month' },
  { key: '1y', ms: 365 * 86400000, sql: '1 year', calendar: 'year' },
];

export function autoInterval(from: Date, to: Date, target = 60): Interval {
  const span = Math.max(1, to.getTime() - from.getTime());
  const ideal = span / target;
  let best = INTERVALS[0];
  for (const iv of INTERVALS) {
    if (iv.ms <= ideal) best = iv;
    else break;
  }
  return best;
}

export function intervalByKey(key: string): Interval | undefined {
  return INTERVALS.find((i) => i.key === key);
}

/** Display name of a histogram interval in the UI language. */
export function intervalLabel(iv: Interval): string {
  return t(`iv.${iv.key}` as MsgKey);
}

/**
 * Offset (minutes east of UTC) of the display time zone at `at`. Bucket boundaries are aligned
 * with this one offset, so a range that spans a DST change is off by an hour on its far side.
 */
export function bucketOffsetMinutes(at: Date = new Date()): number {
  return zonedParts(at, effectiveTimeZone()).offset;
}

/** Origin for weekly buckets: a day in January 2000 that falls on the configured first day of the week. */
function weekOrigin(): string {
  const day = 3 + ((getSettings().dayOfWeek - 1 + 7) % 7); // 2000-01-03 is a Monday
  return `TIMESTAMP '2000-01-${pad(day)} 00:00:00'`;
}

/**
 * Bucket expression aligned to the wall clock of the display time zone (daily buckets start at
 * that zone's midnight, weekly ones on the configured first day of the week, monthly ones on the
 * 1st). Returns epoch milliseconds as DOUBLE.
 */
export function bucketExpr(timeExpr: string, iv: Interval, offsetMinutes: number = bucketOffsetMinutes()): string {
  const shift = offsetMinutes ? ` + to_minutes(${offsetMinutes})` : '';
  const unshift = offsetMinutes ? ` - to_minutes(${offsetMinutes})` : '';
  const origin = iv.calendar === 'week' ? `, ${weekOrigin()}` : '';
  return `epoch_ms(time_bucket(INTERVAL '${iv.sql}', (${timeExpr})${shift}${origin})${unshift})::DOUBLE`;
}

/** Start of the bucket after the one starting at `t` (epoch ms), for buckets made by bucketExpr with the same offset. */
export function nextBucketStart(t: number, iv: Interval, offsetMinutes: number): number {
  if (iv.calendar !== 'month' && iv.calendar !== 'year') return t + iv.ms;
  const shift = offsetMinutes * 60_000;
  const d = new Date(t + shift);
  if (iv.calendar === 'month') d.setUTCMonth(d.getUTCMonth() + 1);
  else d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.getTime() - shift;
}

/** Every bucket start from `first` to `last` inclusive (both bucket starts), at most `limit` of them. */
export function bucketStarts(first: number, last: number, iv: Interval, offsetMinutes: number, limit = 5000): number[] {
  const out: number[] = [];
  for (let t = first; t <= last && out.length < limit; t = nextBucketStart(t, iv, offsetMinutes)) out.push(t);
  return out;
}

export type FilterOp = 'is' | 'is_not' | 'is_one_of' | 'is_not_one_of' | 'exists' | 'does_not_exist' | 'between' | 'query';

export interface Filter {
  id: string;
  field: string;
  op: FilterOp;
  value?: string;
  values?: string[];
  from?: string;
  to?: string;
  negate?: boolean;
  disabled?: boolean;
  /** Raw SQL for 'query' (custom) filters */
  sql?: string;
  /** Label for custom filters */
  label?: string;
  /** Custom SQL that came from a URL and was not written in this browser: kept disabled until reviewed */
  untrusted?: boolean;
}

export function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function valueLiteral(f: Field, v: string): string {
  if (f.kind === 'number') {
    const n = Number(v);
    if (Number.isFinite(n)) return String(n);
    return lit(v);
  }
  if (f.kind === 'boolean') return v.toLowerCase() === 'true' ? 'TRUE' : 'FALSE';
  if (f.kind === 'date') return `TRY_CAST(${lit(v)} AS TIMESTAMP)`;
  return lit(v);
}

export function fieldCompareExpr(f: Field): string {
  if (f.kind === 'string' || f.kind === 'number' || f.kind === 'boolean' || f.kind === 'date') return f.expr;
  return `(${f.expr})::VARCHAR`;
}

export function filterToSQL(fl: Filter, fields: Field[]): string | null {
  if (fl.disabled) return null;
  let sql: string;
  if (fl.op === 'query') {
    sql = fl.sql ?? 'TRUE';
  } else {
    const f = findField(fields, fl.field);
    if (!f) return null;
    const e = fieldCompareExpr(f);
    switch (fl.op) {
      case 'is':
        sql = fl.value === null || fl.value === undefined || fl.value === '__null__' ? `${e} IS NULL` : `${e} = ${valueLiteral(f, fl.value)}`;
        break;
      case 'is_not':
        sql = `NOT (${e} = ${valueLiteral(f, fl.value ?? '')})`;
        break;
      case 'is_one_of':
        sql = `${e} IN (${(fl.values ?? []).map((v) => valueLiteral(f, v)).join(', ')})`;
        break;
      case 'is_not_one_of':
        sql = `${e} NOT IN (${(fl.values ?? []).map((v) => valueLiteral(f, v)).join(', ')})`;
        break;
      case 'exists':
        sql = `${f.expr} IS NOT NULL`;
        break;
      case 'does_not_exist':
        sql = `${f.expr} IS NULL`;
        break;
      case 'between': {
        const parts: string[] = [];
        if (fl.from) parts.push(`${e} >= ${valueLiteral(f, fl.from)}`);
        if (fl.to) parts.push(`${e} < ${valueLiteral(f, fl.to)}`);
        sql = parts.length ? parts.join(' AND ') : 'TRUE';
        break;
      }
      default:
        sql = 'TRUE';
    }
  }
  return fl.negate ? `NOT (${sql})` : `(${sql})`;
}

export function describeFilter(fl: Filter): string {
  const neg = fl.negate ? 'NOT ' : '';
  switch (fl.op) {
    case 'is':
      return `${neg}${fl.field}: ${fl.value}`;
    case 'is_not':
      return `${fl.negate ? '' : 'NOT '}${fl.field}: ${fl.value}`;
    case 'is_one_of':
      return `${neg}${fl.field}: ${t('flt.op.is_one_of')} ${(fl.values ?? []).join(', ')}`;
    case 'is_not_one_of':
      return `${neg}${fl.field}: ${t('flt.op.is_not_one_of')} ${(fl.values ?? []).join(', ')}`;
    case 'exists':
      return `${neg}${fl.field}: ${t('flt.op.exists')}`;
    case 'does_not_exist':
      return `${neg}${fl.field}: ${t('flt.op.does_not_exist')}`;
    case 'between':
      return `${neg}${fl.field}: ${t('flt.desc.between', { from: fl.from ?? '*', to: fl.to ?? '*' })}`;
    case 'query':
      return `${neg}${fl.label ?? fl.sql ?? ''}`;
  }
}

export interface WhereParts {
  timeExpr: string | null;
  range: TimeRange;
  querySql: string | null;
  filters: Filter[];
  fields: Field[];
}

export function buildWhere(p: WhereParts): { sql: string; from: Date | null; to: Date | null } {
  const conds: string[] = [];
  let from: Date | null = null;
  let to: Date | null = null;
  if (p.timeExpr) {
    const r = resolveRange(p.range);
    if (r) {
      from = r.from;
      to = r.to;
      conds.push(`${p.timeExpr} >= ${tsLit(r.from)}`);
      conds.push(`${p.timeExpr} <= ${tsLit(r.to)}`);
    }
  }
  if (p.querySql && p.querySql !== 'TRUE') conds.push(`(${p.querySql})`);
  for (const f of p.filters) {
    const s = filterToSQL(f, p.fields);
    if (s) conds.push(s);
  }
  return { sql: conds.length ? conds.join(' AND ') : 'TRUE', from, to };
}
