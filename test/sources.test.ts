import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SOURCE,
  describeSource,
  loadSource,
  loadSourceHistory,
  rememberSource,
  saveSource,
  shareableSource,
  sourceForKnownLink,
  sourceFromLink,
  type SourceConfig,
} from '../src/sources';
import { readLinkSource, shareLink } from '../src/urlState';
import { type UrlState } from '../src/state';
import { DEFAULT_DISCOVER, DEFAULT_SEARCH, DEFAULT_VIS } from '../src/state';

const url: SourceConfig = {
  ...DEFAULT_SOURCE,
  kind: 'url',
  name: 'alb',
  urls: 's3://b/p/{yyyy}/{MM}/{dd}/*.log.gz\n# a comment\ns3://b/q/*.gz',
  format: 'alb',
  s3: {
    region: 'ap-northeast-1',
    accessKeyId: 'AKIA',
    secretAccessKey: 'shh',
    sessionToken: 'tok',
    endpoint: 'http://minio:9000',
    urlStyle: 'path',
  },
  authMode: 'static',
  tokenValues: { alb: ['a', 'b'] },
  timeField: { mode: 'field', name: 'time' },
};

describe('persisted source validation', () => {
  beforeEach(() => localStorage.clear());

  it('preserves configured endpoints, local handles, token values and legacy time fields', () => {
    const local: SourceConfig = {
      ...url,
      kind: 'local',
      localId: 'picked-files',
      oidc: { ...url.oidc, authUrl: 'http://localhost/auth', stsEndpoint: 'https://private.example/sts' },
    };
    saveSource(local);
    const expected = { ...local, s3: { ...local.s3, secretAccessKey: '', sessionToken: '' } };
    expect(loadSource()).toEqual(expected);
    rememberSource(local);
    expect(loadSourceHistory()[0].config).toEqual(expected);
    saveSource({ ...local, timeField: { mode: 'none' } });
    expect(loadSource().timeField).toEqual({ mode: 'none' });
    saveSource({ ...local, timeField: { mode: 'auto' } });
    expect(loadSource().timeField).toEqual({ mode: 'auto' });
  });

  it.each([null, [], 'bad', 42].map((raw) => ({ raw })))('falls back for a non-object source (case %#)', ({ raw }) => {
    localStorage.setItem('ddv.source', JSON.stringify(raw));
    expect(loadSource()).toEqual(DEFAULT_SOURCE);
  });

  it('defaults malformed fields without losing valid source settings', () => {
    localStorage.setItem(
      'ddv.source',
      JSON.stringify({
        kind: 'url',
        name: 'saved',
        urls: 42,
        format: 'unsupported',
        naming: null,
        authMode: 'invalid',
        s3: { region: 'us-east-1', accessKeyId: 'AKIA', endpoint: false },
        oidc: { clientId: 'client', durationSeconds: 'bad' },
        tokenValues: { tenant: ['a', 1], 'bad name': ['b'] },
        timeField: false,
        localId: 4,
      }),
    );
    expect(loadSource()).toEqual({
      ...DEFAULT_SOURCE,
      kind: 'url',
      name: 'saved',
      s3: { ...DEFAULT_SOURCE.s3, region: 'us-east-1', accessKeyId: 'AKIA' },
      oidc: { ...DEFAULT_SOURCE.oidc, clientId: 'client' },
      tokenValues: { tenant: ['a'] },
    });
  });

  it('keeps valid history entries when a neighboring entry is malformed', () => {
    localStorage.setItem(
      'ddv.sources',
      JSON.stringify([
        { config: { kind: 'url', urls: 42 } },
        { config: { kind: 'invalid' } },
        { config: null },
        { config: { kind: 'url', name: 'valid', urls: 's3://bucket/logs' }, lastUsed: 'yesterday' },
      ]),
    );
    expect(loadSourceHistory().some((e) => e.config.name === 'valid' && e.lastUsed === 'yesterday')).toBe(true);
    expect(loadSourceHistory().every((e) => e.config.kind === 'url')).toBe(true);
  });
});

describe('shareableSource', () => {
  it.each(['demo', 'url'] as const)('preserves explicit time filtering disablement for %s links', (kind) => {
    const shared = shareableSource({ ...url, kind, timeField: { mode: 'none' } })!;
    expect(sourceFromLink(shared)?.timeField).toEqual({ mode: 'none' });
    expect(sourceFromLink({ ...shared, timeField: null })?.timeField).toEqual({ mode: 'auto' });
  });

  it('drops secrets and the key ID, and never shares local files', () => {
    const s = shareableSource(url)!;
    expect(s.s3).toEqual({ ...url.s3, accessKeyId: '', secretAccessKey: '', sessionToken: '' });
    expect(s.urls).toBe(url.urls);
    expect(shareableSource({ ...DEFAULT_SOURCE, kind: 'local', localId: 'x' })).toBeNull();
    expect(shareableSource({ ...DEFAULT_SOURCE, kind: 'demo' })!.kind).toBe('demo');
  });
});

describe('sourceFromLink', () => {
  it('takes only the fields a source needs, with secrets always empty', () => {
    const s = sourceFromLink({
      ...shareableSource(url),
      s3: { ...url.s3, accessKeyId: 'AKIA', secretAccessKey: 'leak' },
      oidc: { clientId: 'c', roleArn: 'arn' },
      extra: 1,
    })!;
    expect(s.kind).toBe('url');
    expect(s.s3).toEqual({
      region: 'ap-northeast-1',
      accessKeyId: '',
      secretAccessKey: '',
      sessionToken: '',
      endpoint: 'http://minio:9000',
      urlStyle: 'path',
    });
    expect(s.oidc.clientId).toBe('c');
    expect(s.oidc.roleArn).toBe('arn');
    expect(s.oidc.authUrl).toBe(DEFAULT_SOURCE.oidc.authUrl);
    expect(s.format).toBe('alb');
    expect(s.tokenValues).toEqual({ alb: ['a', 'b'] });
    expect(s.timeField).toEqual({ mode: 'field', name: 'time' });
    expect((s as unknown as Record<string, unknown>).extra).toBeUndefined();
  });

  it('falls back on malformed values and refuses what is not a source', () => {
    expect(
      sourceFromLink({
        kind: 'url',
        urls: 's3://b/*',
        format: 'nope',
        authMode: 'root',
        s3: 'x',
        tokenValues: { a: [1, 'b'] },
      }),
    ).toMatchObject({
      format: 'auto',
      authMode: 'static',
      tokenValues: { a: ['b'] },
    });
    expect(sourceFromLink({ kind: 'demo' })!.kind).toBe('demo');
    expect(sourceFromLink({ kind: 'local', localId: 'x' })).toBeNull();
    expect(sourceFromLink({ kind: 'url', urls: '' })).toBeNull();
    expect(sourceFromLink('s3://b/*')).toBeNull();
    expect(sourceFromLink(null)).toBeNull();
  });

  it('takes only names a pattern can carry, so a link cannot replace the prototype of the values object', () => {
    // a link is JSON: "__proto__" arrives as a key of its own, not as the prototype of the object
    const raw = JSON.parse('{"kind":"url","urls":"s3://b/*","tokenValues":{"__proto__":["x"],"a b":["y"],"ok":["z"]}}');
    const s = sourceFromLink(raw)!;
    expect(s.tokenValues).toEqual({ ok: ['z'] });
    expect(Object.getPrototypeOf(s.tokenValues)).toBe(Object.prototype);
  });
});

describe('sourceFromLink, sign-in settings', () => {
  const link = (oidc: Record<string, unknown>) =>
    sourceFromLink({ kind: 'url', urls: 's3://b/*', authMode: 'oidc', oidc })!.oidc;

  it('refuses an STS endpoint outside AWS, so a link cannot collect the id_token', () => {
    expect(link({ stsEndpoint: 'https://attacker.example/' }).stsEndpoint).toBe('');
    expect(link({ stsEndpoint: 'http://sts.amazonaws.com/' }).stsEndpoint).toBe('');
    expect(link({ stsEndpoint: 'https://evil.example/sts.amazonaws.com' }).stsEndpoint).toBe('');
    expect(link({ stsEndpoint: 'https://sts.ap-northeast-1.amazonaws.com/' }).stsEndpoint).toBe(
      'https://sts.ap-northeast-1.amazonaws.com/',
    );
    expect(link({ stsEndpoint: 'https://sts.amazonaws.com/' }).stsEndpoint).toBe('https://sts.amazonaws.com/');
    expect(link({ stsEndpoint: 'https://sts-fips.us-east-1.amazonaws.com/' }).stsEndpoint).toBe(
      'https://sts-fips.us-east-1.amazonaws.com/',
    );
  });

  // "somewhere on amazonaws.com" is not the same as "AWS answers there": the manifest grants
  // https://*.amazonaws.com/* so that any bucket can be read without a prompt, and these two
  // services hand a host under it to whoever asks for one.
  it('refuses an AWS-hosted endpoint that belongs to whoever created it', () => {
    expect(link({ stsEndpoint: 'https://a1b2c3.execute-api.us-east-1.amazonaws.com/p/collect' }).stsEndpoint).toBe('');
    expect(link({ stsEndpoint: 'https://evil-1234567.us-east-1.elb.amazonaws.com/' }).stsEndpoint).toBe('');
    expect(link({ stsEndpoint: 'https://evil.s3.amazonaws.com/' }).stsEndpoint).toBe('');
    expect(link({ stsEndpoint: 'https://sts.amazonaws.com.evil.amazonaws.com/' }).stsEndpoint).toBe('');
  });

  it('refuses a region that would move the STS host, and a non-https identity provider', () => {
    expect(link({ region: 'evil.example/x?' }).region).toBe('ap-northeast-1');
    expect(link({ region: 'us-east-1' }).region).toBe('us-east-1');
    expect(sourceFromLink({ kind: 'url', urls: 's3://b/*', s3: { region: 'evil.example/x?' } })!.s3.region).toBe('');
    expect(link({ authUrl: 'http://idp.example/auth' }).authUrl).toBe(DEFAULT_SOURCE.oidc.authUrl);
    expect(link({ authUrl: 'https://idp.example/auth' }).authUrl).toBe('https://idp.example/auth');
  });
});

describe('describeSource', () => {
  it('names the destination, endpoint and authentication mode', () => {
    expect(describeSource(url)).toBe('s3://b/p/{yyyy}/{MM}/{dd}/*.log.gz, s3://b/q/*.gz · http://minio:9000 · static');
    expect(describeSource({ ...DEFAULT_SOURCE, kind: 'demo' })).toBe('demo');
  });

  it('names the identity provider, the STS endpoint and the role of a sign-in source', () => {
    const oidc: SourceConfig = {
      ...url,
      authMode: 'oidc',
      oidc: {
        ...DEFAULT_SOURCE.oidc,
        authUrl: 'https://idp.example/auth',
        region: 'us-east-1',
        roleArn: 'arn:aws:iam::1:role/r',
      },
    };
    expect(describeSource(oidc)).toBe(
      's3://b/p/{yyyy}/{MM}/{dd}/*.log.gz, s3://b/q/*.gz · http://minio:9000 · oidc · idp.example · sts.us-east-1.amazonaws.com · arn:aws:iam::1:role/r',
    );
  });
});

describe('shareLink', () => {
  const state: UrlState = {
    page: 'visualize',
    search: { ...DEFAULT_SEARCH, query: 'level:error' },
    discover: DEFAULT_DISCOVER,
    vis: DEFAULT_VIS,
  };

  it('carries the view and the source without secrets, and reads back', () => {
    const link = shareLink(state, url);
    expect(link.startsWith('http://localhost/#/visualize?s=')).toBe(true);
    expect(link).toMatch(/&src=/);
    expect(link).not.toContain('shh');
    location.hash = link.slice(link.indexOf('#'));
    const back = readLinkSource()!;
    expect(back.urls).toBe(url.urls);
    expect(back.s3.secretAccessKey).toBe('');
    expect(back.s3.accessKeyId).toBe('');
  });

  it('leaves local files out and reads null without a source', () => {
    const link = shareLink(state, { ...DEFAULT_SOURCE, kind: 'local', localId: 'x' });
    expect(link).not.toMatch(/src=/);
    location.hash = link.slice(link.indexOf('#'));
    expect(readLinkSource()).toBeNull();
  });
});

describe('known shared sources', () => {
  it('uses the shared selection and schema options while keeping locally trusted credentials', () => {
    const known = { ...url, oidc: { ...url.oidc, stsEndpoint: 'https://private.example/sts' } };
    const link = sourceFromLink({
      ...url,
      name: 'shared',
      tokenValues: { alb: ['other'] },
      format: 'csv',
      naming: 'otel',
      timeField: 'ts',
      maxFiles: 25,
      oidc: { authUrl: 'https://different.example/auth' },
    })!;
    expect(sourceForKnownLink(link, known)).toEqual({ ...link, s3: known.s3, oidc: known.oidc });
    expect(sourceForKnownLink({ ...link, urls: 's3://other/file' }, known).s3.accessKeyId).toBe('');
  });
});
