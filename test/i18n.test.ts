import { describe, expect, it } from 'vitest';
import { t, tx } from '../src/i18n';
import { de } from '../src/i18n/de';
import { en } from '../src/i18n/en';
import { es } from '../src/i18n/es';
import { fr } from '../src/i18n/fr';
import { ja } from '../src/i18n/ja';
import { ko } from '../src/i18n/ko';
import { zh_CN } from '../src/i18n/zh_CN';

const placeholders = (s: string) => new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));

describe('the dictionaries', () => {
  it('fill the same placeholders in every language', () => {
    for (const [lang, dict] of Object.entries({ ja, zh_CN, ko, de, fr, es })) {
      for (const key of Object.keys(en) as (keyof typeof en)[]) {
        const want = placeholders(en[key]);
        const got = placeholders(dict[key]);
        // a placeholder the translation forgets shows as a literal {n}; an extra one never fills
        expect([...got].sort(), `${lang} ${key}`).toEqual([...want].sort());
      }
    }
  });
});

describe('t', () => {
  it('fills the placeholders it is given and leaves the others alone', () => {
    expect(t('app.large.files', { n: '3' })).toContain('3');
    expect(t('app.large.files', {})).toContain('{n}');
    expect(t('app.large.files')).toContain('{n}');
  });
});

describe('tx', () => {
  it('splits the message around the placeholders and puts the nodes in their places', () => {
    // a message that begins with one placeholder and has two of them next to each other
    expect(tx('app.large.text', { files: ['F'], bytes: ['B'], threshold: 'T' })).toEqual(expect.arrayContaining([['F'], ['B']]));
    const parts = tx('app.gate.files', { n: ['N'] });
    expect(parts).toContain(parts.find((p) => Array.isArray(p)));
    // an unknown placeholder stays as written rather than disappearing
    expect(tx('app.large.files', {}).join('')).toContain('{n}');
  });
});
