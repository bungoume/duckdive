import { beforeEach, describe, expect, it } from 'vitest';
import { describeRange, fromDatetimeLocal, parseDateMath, resolveRange, toDatetimeLocal } from '../src/datemath';
import { resetSettings, updateSettings } from '../src/settings';

const now = new Date('2026-09-16T10:30:00.000Z'); // a Wednesday

describe('parseDateMath', () => {
  beforeEach(() => {
    resetSettings();
    updateSettings({ timeZone: 'UTC', dayOfWeek: 1 });
  });

  it('adds and subtracts fixed units', () => {
    expect(parseDateMath('now', false, now)?.toISOString()).toBe('2026-09-16T10:30:00.000Z');
    expect(parseDateMath('now-15m', false, now)?.toISOString()).toBe('2026-09-16T10:15:00.000Z');
    expect(parseDateMath('now+2h', false, now)?.toISOString()).toBe('2026-09-16T12:30:00.000Z');
    expect(parseDateMath('now-7d', false, now)?.toISOString()).toBe('2026-09-09T10:30:00.000Z');
  });

  it('rounds down and, when asked, up to the last instant of the unit', () => {
    expect(parseDateMath('now/d', false, now)?.toISOString()).toBe('2026-09-16T00:00:00.000Z');
    expect(parseDateMath('now/d', true, now)?.toISOString()).toBe('2026-09-16T23:59:59.999Z');
    expect(parseDateMath('now-1d/d', false, now)?.toISOString()).toBe('2026-09-15T00:00:00.000Z');
    expect(parseDateMath('now/h', false, now)?.toISOString()).toBe('2026-09-16T10:00:00.000Z');
    expect(parseDateMath('now/M', false, now)?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(parseDateMath('now/y', true, now)?.toISOString()).toBe('2026-12-31T23:59:59.999Z');
  });

  it('starts the week on the configured day', () => {
    expect(parseDateMath('now/w', false, now)?.toISOString()).toBe('2026-09-14T00:00:00.000Z'); // Monday
    updateSettings({ dayOfWeek: 0 });
    expect(parseDateMath('now/w', false, now)?.toISOString()).toBe('2026-09-13T00:00:00.000Z'); // Sunday
  });

  it('adds months and years on the calendar', () => {
    expect(parseDateMath('now-1M', false, now)?.toISOString()).toBe('2026-08-16T10:30:00.000Z');
    expect(parseDateMath('now+1y', false, now)?.toISOString()).toBe('2027-09-16T10:30:00.000Z');
    expect(parseDateMath('now+1M', false, new Date('2026-01-31T00:00:00Z'))?.toISOString()).toBe('2026-03-03T00:00:00.000Z');
  });

  it('rounds in the configured time zone', () => {
    updateSettings({ timeZone: 'Asia/Tokyo' });
    expect(parseDateMath('now/d', false, now)?.toISOString()).toBe('2026-09-15T15:00:00.000Z'); // JST midnight of the 16th
    expect(parseDateMath('now/d', true, now)?.toISOString()).toBe('2026-09-16T14:59:59.999Z');
  });

  it('accepts absolute timestamps and rejects garbage', () => {
    expect(parseDateMath('2026-09-01T00:00:00Z')?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(parseDateMath('now-3x')).toBeNull();
    expect(parseDateMath('yesterday')).toBeNull();
    expect(parseDateMath('')).toBeNull();
  });
});

describe('ranges', () => {
  beforeEach(() => {
    resetSettings();
    updateSettings({ timeZone: 'UTC' });
  });

  it('resolves both ends (the end rounded up)', () => {
    const r = resolveRange({ from: 'now-1d/d', to: 'now-1d/d' }, now);
    expect(r?.from.toISOString()).toBe('2026-09-15T00:00:00.000Z');
    expect(r?.to.toISOString()).toBe('2026-09-15T23:59:59.999Z');
    expect(resolveRange({ from: 'bad', to: 'now' }, now)).toBeNull();
  });

  it('labels quick ranges and absolute ranges', () => {
    expect(describeRange({ from: 'now-15m', to: 'now' })).toBe('Last 15 minutes');
    expect(describeRange({ from: 'now/d', to: 'now/d' })).toBe('Today');
    expect(describeRange({ from: '2026-09-01T00:00:00.000Z', to: 'now' })).toMatch(/^2026-09-01T00:00:00\.000 → now$/);
  });

  it('round-trips datetime-local values through the configured zone', () => {
    updateSettings({ timeZone: 'Asia/Tokyo' });
    const d = new Date('2026-09-16T01:02:03.000Z');
    expect(toDatetimeLocal(d)).toBe('2026-09-16T10:02:03');
    expect(fromDatetimeLocal('2026-09-16T10:02:03')?.toISOString()).toBe('2026-09-16T01:02:03.000Z');
    expect(fromDatetimeLocal('nope')).toBeNull();
  });
});
