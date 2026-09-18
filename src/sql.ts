import type { TimeRange } from './datemath';
import { parseAbsolute, parseDateMath, resolveRange } from './datemath';
import { effectiveTimeZone, zonedParts } from './datefmt';
import type { Field } from './fields';
import { findField } from './fields';
import { t } from './i18n';
import { getSettings } from './settings';
import { pad } from './util';

export const VIEW = 'src';

export function lit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * SQL literal for a number written by the user, or null when the text is not one. Integers are
 * passed through digit by digit: Number() would round a 64-bit id (9007199254740993 becomes
 * ...92) and would read '' as 0 and '0x1F4' as 500. Everything else goes through Number() so
 * that 1e3 and 1.5 still work.
 */
export function numberLiteral(v: string): string | null {
  const s = v.trim();
  // up to the 39 digits of a DuckDB HUGEINT; a longer one is compared as a double
  if (/^[+-]?\d+$/.test(s) && s.replace(/\D/g, '').length <= 38) return s.replace(/^\+/, '');
  if (!/^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? String(n) : null;
}

/**
 * Negation that keeps the rows the inner condition says nothing about. In SQL's three-valued
 * logic `NOT ("status" = 200)` is NULL — not TRUE — for a row without a status, so a plain NOT
 * would hide every row that lacks the field (common in JSON columns). coalesce makes NULL false
 * before the negation, which is what "not 200" means to someone reading logs.
 */
export function notSql(inner: string): string {
  return `NOT coalesce(${inner}, FALSE)`;
}

/** Naive UTC TIMESTAMP literal. */
export function tsLit(d: Date): string {
  return `TIMESTAMP '${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}'`;
}

export type IntervalKey = '1s' | '5s' | '10s' | '30s' | '1m' | '5m' | '10m' | '30m' | '1h' | '3h' | '12h' | '1d' | '1w' | '1M' | '1y';

export interface Interval {
  /** nominal ms per bucket (axis spacing; calendar buckets vary in length) */
  ms: number;
  /** DuckDB INTERVAL text, e.g. "5 minute" */
  sql: string;
  key: IntervalKey;
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
  return t(`iv.${iv.key}`);
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

/** A round bucket width (1, 2 or 5 times a power of ten) close to `raw`. */
export function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * p;
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

/** Identifier for a filter, a saved search or a local source: crypto, because some of them end up in stored keys. */
export function newId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** SQL literal for a filter value; null when the value cannot be compared with the field (a word against a number). */
function valueLiteral(f: Field, v: string): string | null {
  if (f.kind === 'number') return numberLiteral(v);
  if (f.kind === 'boolean') return v.toLowerCase() === 'true' ? 'TRUE' : 'FALSE';
  if (f.kind === 'date') {
    const d = v.startsWith('now') ? parseDateMath(v) : parseAbsolute(v);
    return d ? tsLit(d) : null;
  }
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
    // values that cannot be compared with the field match nothing (and "is not" then matches everything)
    const one = (v: string | undefined) => (v === undefined ? null : valueLiteral(f, v));
    const many = (vs: string[] | undefined) => (vs ?? []).map((v) => valueLiteral(f, v)).filter((x): x is string => x !== null);
    switch (fl.op) {
      case 'is': {
        const v = one(fl.value);
        sql = fl.value === undefined ? `${e} IS NULL` : v === null ? 'FALSE' : `${e} = ${v}`;
        break;
      }
      case 'is_not': {
        const v = one(fl.value);
        sql = fl.value === undefined ? `${e} IS NOT NULL` : v === null ? 'TRUE' : notSql(`${e} = ${v}`);
        break;
      }
      case 'is_one_of': {
        const vs = many(fl.values);
        sql = vs.length ? `${e} IN (${vs.join(', ')})` : 'FALSE';
        break;
      }
      case 'is_not_one_of': {
        const vs = many(fl.values);
        sql = vs.length ? notSql(`${e} IN (${vs.join(', ')})`) : 'TRUE';
        break;
      }
      case 'exists':
        sql = `${f.expr} IS NOT NULL`;
        break;
      case 'does_not_exist':
        sql = `${f.expr} IS NULL`;
        break;
      case 'between': {
        const parts: string[] = [];
        const lo = one(fl.from || undefined);
        const hi = one(fl.to || undefined);
        if (lo !== null) parts.push(`${e} >= ${lo}`);
        if (hi !== null) parts.push(`${e} < ${hi}`);
        sql = parts.length ? parts.join(' AND ') : 'TRUE';
        break;
      }
      default:
        sql = 'TRUE';
    }
  }
  return fl.negate ? notSql(`(${sql})`) : `(${sql})`;
}

/** What a custom SQL filter's pill says: the statement itself, shortened. Never free text. */
export function sqlLabel(sql: string): string {
  return sql.length > 60 ? sql.slice(0, 57) + '…' : sql;
}

export function describeFilter(fl: Filter): string {
  const neg = fl.negate ? t('flt.not') : '';
  switch (fl.op) {
    case 'is':
      return `${neg}${fl.field}: ${fl.value}`;
    case 'is_not':
      return `${fl.negate ? '' : t('flt.not')}${fl.field}: ${fl.value}`;
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
