// Minimal date-math implementation.
// Supports: now, now-15m, now+1h, now/d, now-7d/d, absolute ISO-8601 strings.
// Rounding (`/d`, `/w`, …) and calendar arithmetic happen in the configured time zone; the week
// starts on the day chosen in Settings.

import { t, type MsgKey } from './i18n';
import { effectiveTimeZone, formatDate, normalizeWall, zonedParts, zonedToUtc, type WallTime } from './datefmt';
import { getSettings, type QuickRange } from './settings';
import { pad } from './util';

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

/** Start of the unit that contains `d` (wall clock of `tz`), and the start of the next one. */
function bounds(d: Date, unit: string, tz: string): [Date, Date] | null {
  const p = zonedParts(d, tz);
  const w: WallTime = { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, second: p.second, ms: 0 };
  switch (unit) {
    case 's': {
      const start = zonedToUtc(w, tz);
      return [start, new Date(start.getTime() + 1000)];
    }
    case 'm': {
      const start = zonedToUtc({ ...w, second: 0 }, tz);
      return [start, new Date(start.getTime() + 60_000)];
    }
    case 'h':
    case 'H': {
      const start = zonedToUtc({ ...w, minute: 0, second: 0 }, tz);
      return [start, new Date(start.getTime() + 3_600_000)];
    }
    case 'd': {
      const s = { ...w, hour: 0, minute: 0, second: 0 };
      return [zonedToUtc(s, tz), zonedToUtc({ ...s, day: s.day + 1 }, tz)];
    }
    case 'w': {
      const back = (p.weekday - getSettings().dayOfWeek + 7) % 7;
      const s = normalizeWall({ ...w, day: w.day - back, hour: 0, minute: 0, second: 0 });
      return [zonedToUtc(s, tz), zonedToUtc({ ...s, day: s.day + 7 }, tz)];
    }
    case 'M': {
      const s = { ...w, day: 1, hour: 0, minute: 0, second: 0 };
      return [zonedToUtc(s, tz), zonedToUtc({ ...s, month: s.month + 1 }, tz)];
    }
    case 'y': {
      const s = { ...w, month: 1, day: 1, hour: 0, minute: 0, second: 0 };
      return [zonedToUtc(s, tz), zonedToUtc({ ...s, year: s.year + 1 }, tz)];
    }
    default:
      return null;
  }
}

function roundDate(d: Date, unit: string, roundUp: boolean, tz: string): Date {
  const b = bounds(d, unit, tz);
  if (!b) return d;
  return roundUp ? new Date(b[1].getTime() - 1) : b[0];
}

/** Add calendar months / years on the wall clock (so 31 Jan + 1 month → 3 Mar, like Date.setMonth). */
function addCalendar(d: Date, unit: 'M' | 'y', n: number, tz: string): Date {
  const p = zonedParts(d, tz);
  const w: WallTime = { year: p.year + (unit === 'y' ? n : 0), month: p.month + (unit === 'M' ? n : 0), day: p.day, hour: p.hour, minute: p.minute, second: p.second, ms: p.ms };
  return zonedToUtc(w, tz);
}

export function parseDateMath(expr: string, roundUp = false, now: Date = new Date()): Date | null {
  const s = expr.trim();
  if (!s) return null;
  if (!s.startsWith('now')) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }
  const tz = effectiveTimeZone();
  let d = new Date(now);
  let rest = s.slice(3);
  const re = /^([+-]\d+[smhHdwMy]|\/[smhHdwMy])/;
  while (rest.length) {
    const m = re.exec(rest);
    if (!m) return null;
    const tok = m[1];
    if (tok.startsWith('/')) {
      d = roundDate(d, tok[1], roundUp, tz);
    } else {
      const sign = tok[0] === '-' ? -1 : 1;
      const n = parseInt(tok.slice(1, -1), 10);
      const unit = tok[tok.length - 1];
      if (unit === 'M' || unit === 'y') d = addCalendar(d, unit, sign * n, tz);
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

/** The "Commonly used" ranges of the time picker (Settings page). */
export function quickRanges(): QuickRange[] {
  return getSettings().quickRanges;
}

/** Label of a quick range: its `display`, else one generated from the expression ("Last 15 minutes", "Today"). */
export function quickRangeLabel(q: QuickRange): string {
  if (q.display) return q.display;
  return autoLabel(q) ?? `${q.from} → ${q.to}`;
}

const UNIT_KEY: Record<string, MsgKey> = { s: 'tp.unit.s', m: 'tp.unit.m', h: 'tp.unit.h', d: 'tp.unit.d', w: 'tp.unit.w', M: 'tp.unit.M', y: 'tp.unit.y' };

function autoLabel(r: TimeRange): string | null {
  if (r.from === 'now/d' && r.to === 'now/d') return t('range.today');
  if (r.from === 'now/w' && r.to === 'now/w') return t('range.thisWeek');
  const m = /^now-(\d+)([smhdwMy])(?:\/[smhdwMy])?$/.exec(r.from);
  if (m && r.to === 'now') return t('range.lastN', { n: m[1], unit: t(UNIT_KEY[m[2]]) });
  return null;
}

export function describeRange(r: TimeRange): string {
  const q = quickRanges().find((x) => x.from === r.from && x.to === r.to);
  if (q) return quickRangeLabel(q);
  const auto = autoLabel(r);
  if (auto) return auto;
  const fmt = (s: string) => {
    if (s.startsWith('now')) return s;
    const d = new Date(s);
    return isNaN(d.getTime()) ? s : formatLocal(d);
  };
  return `${fmt(r.from)} → ${fmt(r.to)}`;
}

/** `d` in the configured date format and time zone. */
export function formatLocal(d: Date): string {
  return formatDate(d);
}

/** Value for an <input type="datetime-local">: the wall clock of the configured zone. */
export function toDatetimeLocal(d: Date): string {
  const p = zonedParts(d);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

/** Inverse of toDatetimeLocal: the instant at which the configured zone shows this wall clock. */
export function fromDatetimeLocal(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (!m) return null;
  return zonedToUtc({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: Number(m[4]), minute: Number(m[5]), second: Number(m[6] ?? 0), ms: 0 });
}
