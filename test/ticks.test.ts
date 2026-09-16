import { beforeEach, describe, expect, it } from 'vitest';
import { resetSettings, updateSettings } from '../src/settings';
import { timeAxis } from '../src/ticks';

describe('timeAxis', () => {
  beforeEach(() => {
    resetSettings();
    updateSettings({ dayOfWeek: 1 });
  });

  it('places minute ticks on round wall-clock times inside the range, without overlap', () => {
    const from = new Date('2026-09-16T00:00:00Z');
    const to = new Date('2026-09-16T06:00:00Z');
    const axis = timeAxis(from, to, 800, 60000, 'UTC');
    expect(axis.pattern).toBe('HH:mm');
    expect(axis.ticks.length).toBeGreaterThanOrEqual(5);
    expect(axis.ticks.length).toBeLessThanOrEqual(13);
    expect(axis.ticks[0].toISOString()).toBe(from.toISOString());
    for (let i = 1; i < axis.ticks.length; i++) {
      expect(axis.ticks[i].getTime()).toBeGreaterThan(axis.ticks[i - 1].getTime());
      expect(axis.ticks[i].getTime()).toBeLessThanOrEqual(to.getTime());
      expect(axis.ticks[i].getUTCMinutes() % 5).toBe(0);
    }
    expect(axis.tickFormat(axis.ticks[1])).toMatch(/^\d\d:\d\d$/);
  });

  it('uses day ticks at the zone midnight for multi-day ranges and drops the year within one year', () => {
    const axis = timeAxis(new Date('2026-09-01T00:00:00Z'), new Date('2026-09-20T00:00:00Z'), 700, 3600000, 'Asia/Tokyo');
    expect(axis.pattern).toBe('MM-DD');
    expect(axis.ticks.length).toBeGreaterThan(2);
    for (const t of axis.ticks) expect(t.toISOString()).toMatch(/T15:00:00\.000Z$/); // JST midnight
  });

  it('never ticks finer than the bucket and shows the year across years', () => {
    const axis = timeAxis(new Date('2024-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'), 900, 30 * 86400000, 'UTC');
    expect(['YYYY-MM', 'YYYY']).toContain(axis.pattern);
    for (const t of axis.ticks) expect(t.getUTCDate()).toBe(1);
  });

  it('labels the start when the range holds no boundary', () => {
    const from = new Date('2026-09-16T00:00:10Z');
    const axis = timeAxis(from, new Date('2026-09-16T00:00:12Z'), 50, 0, 'UTC');
    expect(axis.ticks.length).toBeGreaterThanOrEqual(1);
    expect(axis.ticks[0].getTime()).toBe(from.getTime());
  });
});
