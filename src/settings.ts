// User preferences that are not tied to a data source (Settings page). Kept in localStorage;
// `useSettings()` re-renders a component when they change, `getSettings()` reads them anywhere.

import { useEffect, useState } from 'preact/hooks';

export interface QuickRange {
  from: string;
  to: string;
  /** label shown in the time picker; empty / missing = generated from `from` / `to` in the UI language */
  display?: string;
}

export interface AppSettings {
  /** moment-style pattern for every displayed date (YYYY MM DD HH mm ss SSS, ddd, Z, …) */
  dateFormat: string;
  /** IANA time zone for display and date math; '' = the browser's zone */
  timeZone: string;
  /** [ISO 8601 duration, pattern]: the pattern for tooltips / table cells of date-histogram buckets of at least that size ('' = anything smaller); axis labels are chosen automatically (ticks.ts) */
  scaledDateFormat: [string, string][];
  /** first day of the week for `now/w` (0 = Sunday … 6 = Saturday) */
  dayOfWeek: number;
  /** "Commonly used" ranges of the time picker */
  quickRanges: QuickRange[];
}

export const DEFAULT_SETTINGS: AppSettings = {
  dateFormat: 'YYYY-MM-DDTHH:mm:ss.SSS',
  timeZone: '',
  scaledDateFormat: [
    ['', 'HH:mm:ss.SSS'],
    ['PT1S', 'HH:mm:ss'],
    ['PT1M', 'HH:mm'],
    ['PT1H', 'MM-DD HH:mm'],
    ['P1D', 'YYYY-MM-DD'],
    ['P1M', 'YYYY-MM'],
    ['P1Y', 'YYYY'],
  ],
  dayOfWeek: 1,
  quickRanges: [
    { from: 'now-15m', to: 'now' },
    { from: 'now-30m/m', to: 'now' },
    { from: 'now-60m/m', to: 'now' },
    { from: 'now-4h/h', to: 'now' },
    { from: 'now-8h/h', to: 'now' },
    { from: 'now-12h/h', to: 'now' },
    { from: 'now-24h/h', to: 'now' },
    { from: 'now-2d/d', to: 'now' },
    { from: 'now-4d/d', to: 'now' },
    { from: 'now-7d/d', to: 'now' },
    { from: 'now-14d/d', to: 'now' },
    { from: 'now-30d/d', to: 'now' },
  ],
};

const LS_SETTINGS = 'ddv.settings';

/** Defaults overlaid with whatever of `o` has the right shape. */
function sanitize(o: unknown): AppSettings {
  const s: AppSettings = { ...DEFAULT_SETTINGS };
  if (!o || typeof o !== 'object') return s;
  const r = o as Record<string, unknown>;
  if (typeof r.dateFormat === 'string' && r.dateFormat.trim()) s.dateFormat = r.dateFormat;
  if (typeof r.timeZone === 'string') s.timeZone = r.timeZone;
  if (Array.isArray(r.scaledDateFormat) && r.scaledDateFormat.every((e) => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && typeof e[1] === 'string'))
    s.scaledDateFormat = r.scaledDateFormat as [string, string][];
  if (typeof r.dayOfWeek === 'number' && r.dayOfWeek >= 0 && r.dayOfWeek <= 6) s.dayOfWeek = Math.floor(r.dayOfWeek);
  if (
    Array.isArray(r.quickRanges) &&
    r.quickRanges.length &&
    r.quickRanges.every((q) => q && typeof q === 'object' && typeof (q as QuickRange).from === 'string' && typeof (q as QuickRange).to === 'string')
  ) {
    s.quickRanges = (r.quickRanges as QuickRange[]).map((q) => ({ from: q.from, to: q.to, ...(typeof q.display === 'string' && q.display ? { display: q.display } : {}) }));
  }
  return s;
}

function load(): AppSettings {
  try {
    const raw = localStorage.getItem(LS_SETTINGS);
    if (raw) return sanitize(JSON.parse(raw));
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_SETTINGS };
}

let current: AppSettings = load();
const listeners = new Set<() => void>();

export function getSettings(): AppSettings {
  return current;
}

export function updateSettings(patch: Partial<AppSettings>) {
  current = sanitize({ ...current, ...patch });
  try {
    localStorage.setItem(LS_SETTINGS, JSON.stringify(current));
  } catch {
    /* ignore */
  }
  for (const f of listeners) f();
}

export function resetSettings() {
  current = { ...DEFAULT_SETTINGS };
  try {
    localStorage.removeItem(LS_SETTINGS);
  } catch {
    /* ignore */
  }
  for (const f of listeners) f();
}

/** Re-renders the calling component whenever the settings change; returns the current values. */
export function useSettings(): AppSettings {
  const [s, setS] = useState(current);
  useEffect(() => {
    const f = () => setS(current);
    listeners.add(f);
    return () => {
      listeners.delete(f);
    };
  }, []);
  return s;
}
