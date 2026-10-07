import { describe, expect, it } from 'vitest';
import { parseDraft } from '../src/components/Settings';
import { DEFAULT_SETTINGS } from '../src/settings';

const draft = {
  dateFormat: DEFAULT_SETTINGS.dateFormat,
  timeZone: 'Asia/Tokyo',
  scaled: JSON.stringify(DEFAULT_SETTINGS.scaledDateFormat),
  quick: JSON.stringify(DEFAULT_SETTINGS.quickRanges),
};

describe('settings draft validation', () => {
  it('preserves valid date formats and quick ranges', () => {
    expect(parseDraft(draft)).toEqual({
      ok: true,
      value: {
        dateFormat: draft.dateFormat,
        timeZone: draft.timeZone,
        scaledDateFormat: DEFAULT_SETTINGS.scaledDateFormat,
        quickRanges: DEFAULT_SETTINGS.quickRanges,
      },
    });
  });

  it.each(
    [null, 12, [], [null], [{ from: 1, to: 'now' }], [{ from: 'now-1h', to: 'now', display: {} }]].map((raw) => ({
      raw,
    })),
  )('rejects malformed quick ranges (case %#)', ({ raw }) => {
    expect(parseDraft({ ...draft, quick: JSON.stringify(raw) })).toMatchObject({
      ok: false,
      errors: { quick: expect.any(String) },
    });
  });

  it.each([null, [], [[12, 'HH:mm']], [['PT1H', {}]], [['PT1H', ' ']]].map((raw) => ({ raw })))(
    'rejects malformed scaled formats (case %#)',
    ({ raw }) => {
      expect(parseDraft({ ...draft, scaled: JSON.stringify(raw) })).toMatchObject({
        ok: false,
        errors: { scaled: expect.any(String) },
      });
    },
  );
});
