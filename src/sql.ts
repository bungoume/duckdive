import type { TimeRange } from './datemath';
import { resolveRange } from './datemath';
import type { Field } from './fields';
import { findField } from './fields';

export const VIEW = 'src';

export function lit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Naive UTC TIMESTAMP literal. */
export function tsLit(d: Date): string {
  return `TIMESTAMP '${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getMilliseconds(), 3)}'`;
}

export interface Interval {
  /** approximate ms per bucket (for gap filling and axis) */
  ms: number;
  /** DuckDB INTERVAL text, e.g. "5 minute" */
  sql: string;
  label: string;
  key: string;
}

export const INTERVALS: Interval[] = [
  { key: '1s', ms: 1000, sql: '1 second', label: 'Second' },
  { key: '5s', ms: 5000, sql: '5 second', label: '5 seconds' },
  { key: '10s', ms: 10000, sql: '10 second', label: '10 seconds' },
  { key: '30s', ms: 30000, sql: '30 second', label: '30 seconds' },
  { key: '1m', ms: 60000, sql: '1 minute', label: 'Minute' },
  { key: '5m', ms: 300000, sql: '5 minute', label: '5 minutes' },
  { key: '10m', ms: 600000, sql: '10 minute', label: '10 minutes' },
  { key: '30m', ms: 1800000, sql: '30 minute', label: '30 minutes' },
  { key: '1h', ms: 3600000, sql: '1 hour', label: 'Hour' },
  { key: '3h', ms: 3 * 3600000, sql: '3 hour', label: '3 hours' },
  { key: '12h', ms: 12 * 3600000, sql: '12 hour', label: '12 hours' },
  { key: '1d', ms: 86400000, sql: '1 day', label: 'Day' },
  { key: '1w', ms: 7 * 86400000, sql: '7 day', label: 'Week' },
  { key: '1M', ms: 30 * 86400000, sql: '1 month', label: 'Month' },
  { key: '1y', ms: 365 * 86400000, sql: '1 year', label: 'Year' },
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

/** Browser timezone offset in minutes east of UTC (e.g. 540 for JST). */
export function tzOffsetMinutes(): number {
  return -new Date().getTimezoneOffset();
}

/**
 * Bucket expression aligned to the browser's local timezone
 * (so that daily buckets start at local midnight).
 * Returns epoch milliseconds as DOUBLE.
 */
export function bucketExpr(timeExpr: string, iv: Interval): string {
  const off = tzOffsetMinutes();
  const shift = off ? ` + INTERVAL ${off} MINUTE` : '';
  const unshift = off ? ` - INTERVAL ${off} MINUTE` : '';
  return `epoch_ms(time_bucket(INTERVAL '${iv.sql}', (${timeExpr})${shift})${unshift})::DOUBLE`;
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
      return `${neg}${fl.field}: is one of ${(fl.values ?? []).join(', ')}`;
    case 'is_not_one_of':
      return `${neg}${fl.field}: is not one of ${(fl.values ?? []).join(', ')}`;
    case 'exists':
      return `${neg}${fl.field}: exists`;
    case 'does_not_exist':
      return `${neg}${fl.field}: does not exist`;
    case 'between':
      return `${neg}${fl.field}: ${fl.from ?? '*'} to ${fl.to ?? '*'}`;
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
