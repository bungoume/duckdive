import { describe, expect, it } from 'vitest';
import { DEFAULT_DISCOVER, DEFAULT_SEARCH, DEFAULT_VIS, type UrlState } from '../src/state';
import { DEFAULT_SOURCE, shareableSource } from '../src/sources';
import { readLinkSource, readUrlState, shareLink, writeUrlState } from '../src/urlState';

const state: UrlState = {
  page: 'discover',
  search: DEFAULT_SEARCH,
  discover: DEFAULT_DISCOVER,
  vis: DEFAULT_VIS,
};

describe('shared URL UTF-8 codec compatibility', () => {
  it.each(['', 'a', 'ab', '日本語 🦆 café', '\uFEFFログ', '\ud800', 'ログ🦆'.repeat(30_000)])(
    'preserves the UTF-8 base64url wire format (case %#)',
    (query) => {
      const value = { ...state, search: { ...DEFAULT_SEARCH, query } };
      const { page, ...rest } = value;
      const encoded = Buffer.from(JSON.stringify({ version: 1, ...rest })).toString('base64url');
      writeUrlState(value);
      expect(location.hash).toBe(`#/${page}?s=${encoded}`);
      expect(readUrlState()).toEqual(value);
    },
  );

  it.each(['', '=='])('reads a legacy unversioned link with padding %j', (padding) => {
    // Existing UTF-8 base64url payload: {"search":{"query":"日本語 🦆"}}.
    location.hash = `#/discover?s=eyJzZWFyY2giOnsicXVlcnkiOiLml6XmnKzoqp4g8J-mhiJ9fQ${padding}`;
    expect(readUrlState().search.query).toBe('日本語 🦆');
  });

  it('shares Unicode source names and paths without changing the payload format', () => {
    const source = { ...DEFAULT_SOURCE, kind: 'url' as const, name: '本番 🦆', urls: 'https://example.com/ログ.json' };
    const link = shareLink(state, source);
    location.hash = link.slice(link.indexOf('#'));
    const encoded = new URLSearchParams(location.hash.split('?')[1]).get('src');
    expect(encoded).toBe(Buffer.from(JSON.stringify(shareableSource(source))).toString('base64url'));
    expect(readLinkSource()).toMatchObject({ name: source.name, urls: source.urls });
  });

  it.each([
    Buffer.concat([Buffer.from('{"search":{"query":"'), Buffer.from([0xff]), Buffer.from('"}}')]),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"search":{"query":"unexpected"}}')]),
  ])('rejects malformed UTF-8 and a BOM before JSON (case %#)', (bytes) => {
    location.hash = `#/discover?s=${bytes.toString('base64url')}`;
    expect(readUrlState().search).toEqual(DEFAULT_SEARCH);
  });
});
