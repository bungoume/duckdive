// Time-axis ticks for date histograms.
//
// Ticks sit on wall-clock boundaries of the display time zone (whole minutes, hours, local
// midnight, the configured first day of the week, the 1st of the month, …) and are spaced so
// that their labels never overlap. Labels use the shortest ISO-style pattern the visible range
// allows: the date is left out when the range stays within one day, the year when it stays
// within one year, and the time when the ticks are days or longer apart.

import { effectiveTimeZone, formatDate, normalizeWall, zonedParts, zonedToUtc, type WallTime } from './datefmt';
import { getSettings } from './settings';

type Unit = 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';

interface Step {
  unit: Unit;
  /** every k units */
  k: number;
  /** nominal length, for spacing estimates and the "not finer than the bucket" rule */
  ms: number;
}

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const STEPS: Step[] = [
  ...[1, 5, 10, 15, 30].map((k) => ({ unit: 'second' as const, k, ms: k * SEC })),
  ...[1, 5, 10, 15, 30].map((k) => ({ unit: 'minute' as const, k, ms: k * MIN })),
  ...[1, 3, 6, 12].map((k) => ({ unit: 'hour' as const, k, ms: k * HOUR })),
  ...[1, 2].map((k) => ({ unit: 'day' as const, k, ms: k * DAY })),
  { unit: 'week', k: 1, ms: 7 * DAY },
  ...[1, 3, 6].map((k) => ({ unit: 'month' as const, k, ms: k * 30 * DAY })),
  ...[1, 2, 5, 10, 20, 50, 100, 200, 500, 1000].map((k) => ({ unit: 'year' as const, k, ms: k * 365 * DAY })),
];

/** Minimum gap between two neighbouring labels, in px. */
const GAP = 20;
/** Plot's default font for axis text (`style.fontSize` is set to 11px by the charts). */
export const AXIS_FONT = '11px system-ui, sans-serif';

let canvas: CanvasRenderingContext2D | null | undefined;
/** Rendered width of `s` in `font` (a per-character estimate when no canvas is available). */
export function textWidth(s: string, font = AXIS_FONT): number {
  if (canvas === undefined) {
    try {
      canvas = document.createElement('canvas').getContext('2d');
    } catch {
      canvas = null;
    }
  }
  if (canvas) {
    canvas.font = font;
    return canvas.measureText(s).width;
  }
  const px = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 11);
  return s.length * px * 0.62;
}

/** The first tick at or before wall time `w` for `step`. */
function floorWall(w: WallTime & { weekday: number }, step: Step, dayOfWeek: number): WallTime {
  const z: WallTime = { year: w.year, month: w.month, day: w.day, hour: w.hour, minute: w.minute, second: w.second, ms: 0 };
  switch (step.unit) {
    case 'second':
      z.second = Math.floor(z.second / step.k) * step.k;
      break;
    case 'minute':
      z.second = 0;
      z.minute = Math.floor(z.minute / step.k) * step.k;
      break;
    case 'hour':
      z.second = z.minute = 0;
      z.hour = Math.floor(z.hour / step.k) * step.k;
      break;
    case 'day':
      z.second = z.minute = z.hour = 0;
      break;
    case 'week':
      z.second = z.minute = z.hour = 0;
      z.day -= (w.weekday - dayOfWeek + 7) % 7;
      break;
    case 'month':
      z.second = z.minute = z.hour = 0;
      z.day = 1;
      z.month = Math.floor((z.month - 1) / step.k) * step.k + 1;
      break;
    case 'year':
      z.second = z.minute = z.hour = 0;
      z.day = z.month = 1;
      z.year = Math.floor(z.year / step.k) * step.k;
      break;
  }
  return normalizeWall(z);
}

/** The wall time one step after `w` (multi-day steps advance a day at a time and are filtered). */
function nextWall(w: WallTime, step: Step): WallTime {
  const z = { ...w };
  switch (step.unit) {
    case 'second':
      z.second += step.k;
      break;
    case 'minute':
      z.minute += step.k;
      break;
    case 'hour':
      z.hour += step.k;
      break;
    case 'day':
      z.day += 1;
      break;
    case 'week':
      z.day += 7;
      break;
    case 'month':
      z.month += step.k;
      break;
    case 'year':
      z.year += step.k;
      break;
  }
  return normalizeWall(z);
}

/** Ticks of `step` inside [t0, t1], aligned to the wall clock of `tz`. */
function ticksFor(t0: number, t1: number, step: Step, tz: string, dayOfWeek: number, limit = 4000): Date[] {
  const out: Date[] = [];
  let w = floorWall(zonedParts(new Date(t0), tz), step, dayOfWeek);
  let last = -Infinity;
  for (let i = 0; i < limit; i++, w = nextWall(w, step)) {
    // d3-style multi-day ticks: the 1st, 3rd, 5th … of each month
    if (step.unit === 'day' && (w.day - 1) % step.k !== 0) continue;
    const t = zonedToUtc(w, tz).getTime();
    if (t > t1) break;
    // a DST gap can map two wall times onto one instant
    if (t < t0 || t <= last) continue;
    out.push(new Date(t));
    last = t;
  }
  // the day-of-month run restarts on the 1st: drop a month's last tick when it would crowd it
  if (step.unit === 'day' && step.k > 1) return out.filter((d, i) => i === out.length - 1 || out[i + 1].getTime() - d.getTime() >= (step.k - 0.5) * DAY);
  return out;
}

/** The label pattern for ticks of `step` on a range [t0, t1]. */
function labelPattern(step: Step, t0: number, t1: number, tz: string): string {
  const a = zonedParts(new Date(t0), tz);
  const b = zonedParts(new Date(Math.max(t0, t1 - 1)), tz);
  const sameYear = a.year === b.year;
  const sameDay = sameYear && a.month === b.month && a.day === b.day;
  const date = sameYear ? 'MM-DD' : 'YYYY-MM-DD';
  switch (step.unit) {
    case 'second':
      return sameDay ? 'HH:mm:ss' : `${date} HH:mm:ss`;
    case 'minute':
    case 'hour':
      return sameDay ? 'HH:mm' : `${date} HH:mm`;
    case 'day':
    case 'week':
      return date;
    case 'month':
      return 'YYYY-MM';
    case 'year':
      return 'YYYY';
  }
}

export interface TimeAxis {
  ticks: Date[];
  tickFormat: (d: Date) => string;
  /** the pattern behind `tickFormat` */
  pattern: string;
}

/**
 * Ticks and labels for a time axis showing [from, to] across `width` px of plot area.
 * `intervalMs` (the bucket size) keeps the ticks from being finer than the data.
 */
export function timeAxis(from: Date, to: Date, width: number, intervalMs = 0, tz: string = effectiveTimeZone(), font = AXIS_FONT): TimeAxis {
  const t0 = Math.min(from.getTime(), to.getTime());
  const t1 = Math.max(from.getTime(), to.getTime());
  const span = Math.max(1, t1 - t0);
  const dayOfWeek = getSettings().dayOfWeek;
  const pxPerMs = Math.max(1, width) / span;
  let chosen: TimeAxis | null = null;
  for (const step of STEPS) {
    if (step.ms < intervalMs) continue;
    const pattern = labelPattern(step, t0, t1, tz);
    const tickFormat = (d: Date) => formatDate(d, pattern, tz);
    // cheap estimate first, so that only plausible steps have their ticks generated
    if (step.ms * pxPerMs < textWidth(tickFormat(new Date(t0)), font) + GAP) continue;
    const ticks = ticksFor(t0, t1, step, tz, dayOfWeek);
    chosen = { ticks, tickFormat, pattern };
    if (ticks.length < 2) break;
    let minGap = Infinity;
    for (let i = 1; i < ticks.length; i++) minGap = Math.min(minGap, (ticks[i].getTime() - ticks[i - 1].getTime()) * pxPerMs);
    const widest = Math.max(...ticks.map((d) => textWidth(tickFormat(d), font)));
    if (minGap >= widest + GAP) break;
  }
  if (!chosen) {
    const pattern = labelPattern(STEPS[0], t0, t1, tz);
    chosen = { ticks: [], tickFormat: (d: Date) => formatDate(d, pattern, tz), pattern };
  }
  // a range shorter than the step may hold no boundary at all: label its start instead
  if (!chosen.ticks.length) chosen = { ...chosen, ticks: [new Date(t0)] };
  return chosen;
}
