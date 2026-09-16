// Date display: moment-style patterns rendered in the configured time zone (Settings page).
//
// Supported tokens: YYYY YY MMMM MMM MM M DD D dddd ddd d HH H hh h mm m ss s SSS SS S A a ZZ Z X x,
// plus [literal text] in brackets. Month / weekday names follow the UI language.

import { getSettings } from './settings';

export interface WallTime {
  year: number;
  /** 1–12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  ms: number;
}

export interface ZonedParts extends WallTime {
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
  /** minutes east of UTC */
  offset: number;
}

const browserZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The zone used for display and date math: the setting, or the browser's when unset / invalid. */
export function effectiveTimeZone(): string {
  const tz = getSettings().timeZone;
  return tz && isValidTimeZone(tz) ? tz : browserZone();
}

const partFormatters = new Map<string, Intl.DateTimeFormat>();
function partFormatter(tz: string): Intl.DateTimeFormat {
  let f = partFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short', timeZoneName: 'longOffset' });
    partFormatters.set(tz, f);
  }
  return f;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Wall-clock fields of `d` in zone `tz`. */
export function zonedParts(d: Date, tz: string = effectiveTimeZone()): ZonedParts {
  const p: Record<string, string> = {};
  for (const part of partFormatter(tz).formatToParts(d)) p[part.type] = part.value;
  const m = /([+-])(\d{2}):?(\d{2})?/.exec(p.timeZoneName ?? '');
  const offset = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    second: Number(p.second),
    ms: d.getMilliseconds(),
    weekday: Math.max(0, WEEKDAYS.indexOf(p.weekday)),
    offset,
  };
}

/** Normalise a wall time whose fields may be out of range (day 0, month 13, …) the way Date.UTC does. */
export function normalizeWall(w: WallTime): WallTime {
  const d = new Date(Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second, w.ms));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(), ms: d.getUTCMilliseconds() };
}

/** The instant at which the clocks of zone `tz` show `w` (for a skipped DST hour: the instant after the gap). */
export function zonedToUtc(w: WallTime, tz: string = effectiveTimeZone()): Date {
  const n = normalizeWall(w);
  const guess = Date.UTC(n.year, n.month - 1, n.day, n.hour, n.minute, n.second, n.ms);
  const off1 = zonedParts(new Date(guess), tz).offset;
  let t = guess - off1 * 60000;
  const off2 = zonedParts(new Date(t), tz).offset;
  // inside a DST gap the two guesses disagree: use the pre-transition offset, i.e. shift forward past the gap
  if (off2 !== off1) t = guess - Math.min(off1, off2) * 60000;
  return new Date(t);
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const TOKEN = /\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|d|HH|H|hh|h|mm|m|ss|s|SSS|SS|S|A|a|ZZ|Z|X|x/g;

const nameCache = new Map<string, string[]>();
function names(kind: 'month' | 'weekday', style: 'short' | 'long'): string[] {
  const locale = (typeof document !== 'undefined' && document.documentElement.lang) || 'en';
  const key = `${locale}|${kind}|${style}`;
  let list = nameCache.get(key);
  if (!list) {
    const f = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', [kind]: style });
    list = kind === 'month' ? Array.from({ length: 12 }, (_, i) => f.format(new Date(Date.UTC(2024, i, 1)))) : Array.from({ length: 7 }, (_, i) => f.format(new Date(Date.UTC(2024, 0, 7 + i))));
    nameCache.set(key, list);
  }
  return list;
}

function offsetText(min: number, colon: boolean): string {
  const sign = min < 0 ? '-' : '+';
  const a = Math.abs(min);
  return `${sign}${pad(Math.floor(a / 60))}${colon ? ':' : ''}${pad(a % 60)}`;
}

/** Render `d` with a moment-style pattern in zone `tz`. */
export function formatDate(d: Date, pattern: string = getSettings().dateFormat, tz: string = effectiveTimeZone()): string {
  if (isNaN(d.getTime())) return '–';
  const p = zonedParts(d, tz);
  const h12 = p.hour % 12 || 12;
  return pattern.replace(TOKEN, (tok, literal: string | undefined) => {
    if (literal !== undefined) return literal;
    switch (tok) {
      case 'YYYY': return String(p.year);
      case 'YY': return pad(p.year % 100);
      case 'MMMM': return names('month', 'long')[p.month - 1];
      case 'MMM': return names('month', 'short')[p.month - 1];
      case 'MM': return pad(p.month);
      case 'M': return String(p.month);
      case 'DD': return pad(p.day);
      case 'D': return String(p.day);
      case 'dddd': return names('weekday', 'long')[p.weekday];
      case 'ddd': return names('weekday', 'short')[p.weekday];
      case 'd': return String(p.weekday);
      case 'HH': return pad(p.hour);
      case 'H': return String(p.hour);
      case 'hh': return pad(h12);
      case 'h': return String(h12);
      case 'mm': return pad(p.minute);
      case 'm': return String(p.minute);
      case 'ss': return pad(p.second);
      case 's': return String(p.second);
      case 'SSS': return pad(p.ms, 3);
      case 'SS': return pad(Math.floor(p.ms / 10));
      case 'S': return String(Math.floor(p.ms / 100));
      case 'A': return p.hour < 12 ? 'AM' : 'PM';
      case 'a': return p.hour < 12 ? 'am' : 'pm';
      case 'ZZ': return offsetText(p.offset, false);
      case 'Z': return offsetText(p.offset, true);
      case 'X': return String(Math.floor(d.getTime() / 1000));
      case 'x': return String(d.getTime());
      default: return tok;
    }
  });
}

/** ISO 8601 duration → milliseconds (months = 30 days, years = 365 days); null when malformed. */
export function parseIsoDuration(s: string): number | null {
  if (s === '') return 0;
  const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(s.trim());
  if (!m) return null;
  const [, y, mo, w, d, h, mi, sec] = m;
  return Number(y ?? 0) * 365 * 86400000 + Number(mo ?? 0) * 30 * 86400000 + Number(w ?? 0) * 7 * 86400000 + Number(d ?? 0) * 86400000 + Number(h ?? 0) * 3600000 + Number(mi ?? 0) * 60000 + Number(sec ?? 0) * 1000;
}

/** The pattern configured for date-histogram buckets of `intervalMs` (largest threshold not above it). */
export function scaledDateFormat(intervalMs: number): string {
  let best: { ms: number; fmt: string } | null = null;
  for (const [dur, fmt] of getSettings().scaledDateFormat) {
    const ms = parseIsoDuration(dur);
    if (ms === null || ms > intervalMs) continue;
    if (!best || ms >= best.ms) best = { ms, fmt };
  }
  return best?.fmt ?? getSettings().dateFormat;
}

/** `d` rendered for a bucket of `intervalMs` (falls back to the plain date format). */
export function formatBucket(d: Date, intervalMs: number): string {
  return formatDate(d, scaledDateFormat(intervalMs));
}
