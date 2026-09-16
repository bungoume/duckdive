import { beforeEach, describe, expect, it } from 'vitest';
import { formatBucket, formatDate, parseIsoDuration, scaledDateFormat, zonedParts, zonedToUtc } from '../src/datefmt';
import { resetSettings, updateSettings } from '../src/settings';

const d = new Date('2026-09-16T01:02:03.456Z');

describe('formatDate', () => {
  it('renders moment-style tokens in the given zone', () => {
    expect(formatDate(d, 'YYYY-MM-DDTHH:mm:ss.SSS', 'UTC')).toBe('2026-09-16T01:02:03.456');
    expect(formatDate(d, 'YYYY-MM-DD HH:mm Z', 'Asia/Tokyo')).toBe('2026-09-16 10:02 +09:00');
    expect(formatDate(d, 'YY/M/D h:mm A ZZ', 'America/New_York')).toBe('26/9/15 9:02 PM -0400');
    expect(formatDate(d, 'ddd MMM D [at] H[h]', 'UTC')).toBe('Wed Sep 16 at 1h');
    expect(formatDate(d, 'X x', 'UTC')).toBe(`${Math.floor(d.getTime() / 1000)} ${d.getTime()}`);
  });

  it('shows a dash for invalid dates', () => {
    expect(formatDate(new Date(NaN), 'YYYY', 'UTC')).toBe('–');
  });
});

describe('zoned conversions', () => {
  it('splits an instant into wall-clock parts', () => {
    const p = zonedParts(d, 'Asia/Tokyo');
    expect([p.year, p.month, p.day, p.hour, p.minute, p.second, p.ms, p.weekday, p.offset]).toEqual([2026, 9, 16, 10, 2, 3, 456, 3, 540]);
  });

  it('inverts the split, normalising out-of-range fields', () => {
    expect(zonedToUtc({ year: 2026, month: 9, day: 16, hour: 10, minute: 2, second: 3, ms: 456 }, 'Asia/Tokyo').toISOString()).toBe(d.toISOString());
    expect(zonedToUtc({ year: 2026, month: 13, day: 1, hour: 0, minute: 0, second: 0, ms: 0 }, 'UTC').toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('maps a wall time inside a DST gap to the instant after the gap', () => {
    // New York springs forward on 2026-03-08 at 02:00: 02:30 does not exist
    expect(zonedToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0, ms: 0 }, 'America/New_York').toISOString()).toBe('2026-03-08T07:30:00.000Z');
  });
});

describe('durations and scaled formats', () => {
  beforeEach(() => resetSettings());

  it('parses ISO 8601 durations', () => {
    expect(parseIsoDuration('')).toBe(0);
    expect(parseIsoDuration('PT1S')).toBe(1000);
    expect(parseIsoDuration('PT1H30M')).toBe(90 * 60000);
    expect(parseIsoDuration('P1D')).toBe(86400000);
    expect(parseIsoDuration('P1W')).toBe(7 * 86400000);
    expect(parseIsoDuration('P1M')).toBe(30 * 86400000);
    expect(parseIsoDuration('1h')).toBeNull();
  });

  it('picks the pattern of the largest duration not above the bucket', () => {
    expect(scaledDateFormat(500)).toBe('HH:mm:ss.SSS');
    expect(scaledDateFormat(60000)).toBe('HH:mm');
    expect(scaledDateFormat(3 * 3600000)).toBe('MM-DD HH:mm');
    expect(scaledDateFormat(86400000)).toBe('YYYY-MM-DD');
    updateSettings({ timeZone: 'UTC' });
    expect(formatBucket(d, 86400000)).toBe('2026-09-16');
  });
});
