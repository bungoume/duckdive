import { describe, expect, it } from 'vitest';
import { fmtDuration, fmtField } from '../src/components/ui';
import { resetSettings, updateSettings } from '../src/settings';

describe('field formatting', () => {
  it('formats sizes and milliseconds by field name, keeping the raw value', () => {
    resetSettings();
    expect(fmtField('http.bytes', 12345)).toEqual({ text: '12.1 KB', raw: '12345' });
    expect(fmtField('http.latency_ms', '83.9')).toEqual({ text: '83.9 ms', raw: '83.9' });
    expect(fmtField('http.latency_ms', 61000)).toEqual({ text: '1 min', raw: '61000' });
    expect(fmtField('http.status', 200)).toEqual({ text: '200' });
    expect(fmtField('http.bytes', 'n/a')).toEqual({ text: 'n/a' });
    expect(fmtDuration(1234)).toBe('1.23 s');
    updateSettings({ formatByName: false });
    expect(fmtField('http.bytes', 12345)).toEqual({ text: '12345' });
    resetSettings();
  });
});
