// Minimal date-math implementation.
// Supports: now, now-15m, now+1h, now/d, now-7d/d, absolute ISO-8601 strings.

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  H: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
  M: 30 * 86_400_000,
  y: 365 * 86_400_000,
};

function roundDate(d: Date, unit: string, roundUp: boolean): Date {
  const r = new Date(d);
  switch (unit) {
    case 's':
      r.setMilliseconds(0);
      if (roundUp) r.setSeconds(r.getSeconds() + 1, -1);
      return r;
    case 'm':
      r.setSeconds(0, 0);
      if (roundUp) r.setMinutes(r.getMinutes() + 1, 0, -1);
      return r;
    case 'h':
    case 'H':
      r.setMinutes(0, 0, 0);
      if (roundUp) r.setHours(r.getHours() + 1, 0, 0, -1);
      return r;
    case 'd':
      r.setHours(0, 0, 0, 0);
      if (roundUp) r.setDate(r.getDate() + 1), r.setMilliseconds(-1);
      return r;
    case 'w': {
      r.setHours(0, 0, 0, 0);
      const day = (r.getDay() + 6) % 7; // Monday = 0
      r.setDate(r.getDate() - day);
      if (roundUp) r.setDate(r.getDate() + 7), r.setMilliseconds(-1);
      return r;
    }
    case 'M':
      r.setDate(1);
      r.setHours(0, 0, 0, 0);
      if (roundUp) r.setMonth(r.getMonth() + 1), r.setMilliseconds(-1);
      return r;
    case 'y':
      r.setMonth(0, 1);
      r.setHours(0, 0, 0, 0);
      if (roundUp) r.setFullYear(r.getFullYear() + 1), r.setMilliseconds(-1);
      return r;
    default:
      return r;
  }
}

export function parseDateMath(expr: string, roundUp = false, now: Date = new Date()): Date | null {
  const s = expr.trim();
  if (!s) return null;
  if (!s.startsWith('now')) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }
  let d = new Date(now);
  let rest = s.slice(3);
  const re = /^([+-]\d+[smhHdwMy]|\/[smhHdwMy])/;
  while (rest.length) {
    const m = re.exec(rest);
    if (!m) return null;
    const tok = m[1];
    if (tok.startsWith('/')) {
      d = roundDate(d, tok[1], roundUp);
    } else {
      const sign = tok[0] === '-' ? -1 : 1;
      const n = parseInt(tok.slice(1, -1), 10);
      const unit = tok[tok.length - 1];
      if (unit === 'M') d.setMonth(d.getMonth() + sign * n);
      else if (unit === 'y') d.setFullYear(d.getFullYear() + sign * n);
      else d = new Date(d.getTime() + sign * n * UNIT_MS[unit]);
    }
    rest = rest.slice(tok.length);
  }
  return d;
}

export interface TimeRange {
  from: string;
  to: string;
}

export function resolveRange(r: TimeRange, now = new Date()): { from: Date; to: Date } | null {
  const from = parseDateMath(r.from, false, now);
  const to = parseDateMath(r.to, true, now);
  if (!from || !to) return null;
  return { from, to };
}

export const QUICK_RANGES: { label: string; from: string; to: string }[] = [
  { label: 'Today', from: 'now/d', to: 'now/d' },
  { label: 'This week', from: 'now/w', to: 'now/w' },
  { label: 'Last 15 minutes', from: 'now-15m', to: 'now' },
  { label: 'Last 30 minutes', from: 'now-30m', to: 'now' },
  { label: 'Last 1 hour', from: 'now-1h', to: 'now' },
  { label: 'Last 6 hours', from: 'now-6h', to: 'now' },
  { label: 'Last 24 hours', from: 'now-24h', to: 'now' },
  { label: 'Last 7 days', from: 'now-7d', to: 'now' },
  { label: 'Last 30 days', from: 'now-30d', to: 'now' },
  { label: 'Last 90 days', from: 'now-90d', to: 'now' },
  { label: 'Last 1 year', from: 'now-1y', to: 'now' },
];

export function describeRange(r: TimeRange): string {
  const q = QUICK_RANGES.find((x) => x.from === r.from && x.to === r.to);
  if (q) return q.label;
  const m = /^now-(\d+)([smhdwMy])$/.exec(r.from);
  if (m && r.to === 'now') {
    const names: Record<string, string> = { s: 'seconds', m: 'minutes', h: 'hours', d: 'days', w: 'weeks', M: 'months', y: 'years' };
    return `Last ${m[1]} ${names[m[2]]}`;
  }
  const fmt = (s: string) => {
    if (s.startsWith('now')) return s;
    const d = new Date(s);
    return isNaN(d.getTime()) ? s : formatLocal(d);
  };
  return `${fmt(r.from)} → ${fmt(r.to)}`;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function formatLocal(d: Date, withMs = false): string {
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return withMs ? `${base}.${pad(d.getMilliseconds(), 3)}` : base;
}

export function toDatetimeLocal(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
