// Data source settings: the configuration of the current source (localStorage, without the
// static S3 secrets) and the history of recently connected sources for quick switching.

import { DEFAULT_OIDC, type OidcConfig } from './auth';
import { FORMAT_IDS, NAMING_IDS, type FormatId, type Naming } from './formats';

export interface S3Config {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  endpoint: string;
  urlStyle: 'vhost' | 'path';
}

export type AuthMode = 'none' | 'static' | 'oidc';

export interface SourceConfig {
  kind: 'demo' | 'url' | 'local';
  name: string;
  /** newline separated URLs / globs (s3://..., https://...) */
  urls: string;
  format: FormatId;
  /** field names: as the log delivers them, or the OpenTelemetry semantic conventions (fixed layouts only) */
  naming: Naming;
  s3: S3Config;
  /** how S3 credentials are obtained: none (public / presigned), static keys, OIDC → STS */
  authMode: AuthMode;
  oidc: OidcConfig;
  /** upper bound for files matched by patterns (0 = default) */
  maxFiles: number;
  /** values chosen for {name} tokens of the pattern (required before connecting) */
  tokenValues: Record<string, string[]>;
  timeField: string | null;
  /** local sources: key of the file handles kept in IndexedDB (see localfiles.ts); `urls` then lists what was picked */
  localId?: string;
}

export const DEFAULT_SOURCE: SourceConfig = {
  kind: 'demo',
  name: 'demo-logs',
  urls: '',
  format: 'auto',
  naming: 'native',
  s3: { region: 'ap-northeast-1', accessKeyId: '', secretAccessKey: '', sessionToken: '', endpoint: '', urlStyle: 'vhost' },
  authMode: 'static',
  oidc: DEFAULT_OIDC,
  maxFiles: 0,
  tokenValues: {},
  timeField: null,
};

const LS_SOURCE = 'ddv.source';
const LS_SOURCES = 'ddv.sources';

/** How many recently connected sources are kept for quick switching. */
export const SOURCE_HISTORY_MAX = 20;

export function loadSource(): SourceConfig {
  try {
    const raw = localStorage.getItem(LS_SOURCE);
    if (raw) {
      const o = JSON.parse(raw);
      return { ...DEFAULT_SOURCE, ...o, s3: { ...DEFAULT_SOURCE.s3, ...(o.s3 ?? {}) }, oidc: { ...DEFAULT_OIDC, ...(o.oidc ?? {}) } };
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_SOURCE;
}

/** `cfg` without the static S3 secrets (they are kept for the session only, see src/secrets.ts). */
export function stripSecrets(cfg: SourceConfig): SourceConfig {
  if (!cfg.s3.secretAccessKey && !cfg.s3.sessionToken) return cfg;
  return { ...cfg, s3: { ...cfg.s3, secretAccessKey: '', sessionToken: '' } };
}

export function saveSource(s: SourceConfig) {
  try {
    localStorage.setItem(LS_SOURCE, JSON.stringify(stripSecrets(s)));
  } catch {
    /* ignore */
  }
}

export interface SourceHistoryEntry {
  /** connection identity (see sourceKey) */
  key: string;
  /** ISO time of the last successful connect */
  lastUsed: string;
  config: SourceConfig;
}

/**
 * Identity of a source for the history: same destination = same entry. Name, format, time
 * field and the chosen pattern-variable values are details of the entry, not part of the key.
 * A local source is identified by its stored handles; one picked without handles has no identity: null.
 */
/** The URLs of a source: one per line, trimmed, comment lines and blank ones dropped. */
export function sourceUrls(cfg: SourceConfig): string[] {
  return cfg.urls
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'));
}

export function sourceKey(cfg: SourceConfig): string | null {
  if (cfg.kind === 'demo') return 'demo';
  if (cfg.kind === 'local') return cfg.localId ? JSON.stringify(['local', cfg.localId]) : null;
  if (cfg.kind !== 'url') return null;
  return JSON.stringify(['url', sourceUrls(cfg).join('\n'), cfg.s3.endpoint, cfg.s3.region, cfg.s3.urlStyle, cfg.authMode]);
}

function normalizeEntry(o: unknown): SourceHistoryEntry | null {
  if (!o || typeof o !== 'object') return null;
  const e = o as Partial<SourceHistoryEntry>;
  if (!e.config || typeof e.config !== 'object') return null;
  const c = e.config as Partial<SourceConfig>;
  const config: SourceConfig = { ...DEFAULT_SOURCE, ...c, s3: { ...DEFAULT_SOURCE.s3, ...(c.s3 ?? {}) }, oidc: { ...DEFAULT_OIDC, ...(c.oidc ?? {}) } };
  const key = sourceKey(config);
  if (!key) return null;
  return { key, lastUsed: typeof e.lastUsed === 'string' ? e.lastUsed : '', config };
}

export function loadSourceHistory(): SourceHistoryEntry[] {
  try {
    const raw = localStorage.getItem(LS_SOURCES);
    if (raw) {
      const list = JSON.parse(raw);
      if (Array.isArray(list))
        return list
          .map(normalizeEntry)
          .filter((e): e is SourceHistoryEntry => e !== null)
          .slice(0, SOURCE_HISTORY_MAX);
    }
  } catch {
    /* ignore */
  }
  return [];
}

function storeSourceHistory(list: SourceHistoryEntry[]) {
  try {
    localStorage.setItem(LS_SOURCES, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

/** Put `cfg` at the front of the history (replacing an entry with the same key); returns the new list. */
export function rememberSource(cfg: SourceConfig, now = new Date()): SourceHistoryEntry[] {
  const key = sourceKey(cfg);
  const cur = loadSourceHistory();
  if (!key) return cur;
  const list = [{ key, lastUsed: now.toISOString(), config: stripSecrets(cfg) }, ...cur.filter((e) => e.key !== key)].slice(0, SOURCE_HISTORY_MAX);
  storeSourceHistory(list);
  return list;
}

export function forgetSource(key: string): SourceHistoryEntry[] {
  const list = loadSourceHistory().filter((e) => e.key !== key);
  storeSourceHistory(list);
  return list;
}

// ---------- sources carried by shared links ----------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback);

/** The source as a link carries it: no secrets, no key ID, and never a local one (its files are on this machine). */
export function shareableSource(cfg: SourceConfig): SourceConfig | null {
  if (cfg.kind === 'local') return null;
  if (cfg.kind === 'demo') return { ...DEFAULT_SOURCE, kind: 'demo', name: cfg.name || 'demo-logs' };
  return { ...cfg, s3: { ...cfg.s3, accessKeyId: '', secretAccessKey: '', sessionToken: '' } };
}

/** An AWS region name, or '' when the text is not one. */
function awsRegion(v: unknown): string {
  const s = str(v);
  return /^[a-z0-9-]{1,32}$/.test(s) ? s : '';
}

const hostOf = (url: string): string | null => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? u.host : null;
  } catch {
    return null;
  }
};

/**
 * An STS endpoint a link is allowed to ask for. The sign-in exchanges the identity provider's
 * id_token there, and that token is enough to assume the role, so a link that could name any host
 * would be a way to collect it. AWS only; anything else falls back to the region's endpoint.
 */
function linkStsEndpoint(v: unknown): string {
  const s = str(v);
  const host = s ? hostOf(s) : null;
  return host && (host === 'amazonaws.com' || host.endsWith('.amazonaws.com')) ? s : '';
}

/**
 * A name a pattern can carry as `{name}` (see captureRegex in s3list.ts). `__proto__` is not one:
 * assigning it below would replace the prototype of the object instead of adding a key to it.
 */
const isTokenName = (k: string) => k !== '__proto__' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k);

/** A source from a link someone sent: every field checked, secrets and key IDs never taken; null when unusable. */
export function sourceFromLink(raw: unknown): SourceConfig | null {
  if (!isObj(raw)) return null;
  if (raw.kind === 'demo') return { ...DEFAULT_SOURCE, kind: 'demo', name: 'demo-logs' };
  if (raw.kind !== 'url' || typeof raw.urls !== 'string' || !raw.urls.trim()) return null;
  const s3 = isObj(raw.s3) ? raw.s3 : {};
  const o = isObj(raw.oidc) ? raw.oidc : {};
  const tokenValues: Record<string, string[]> = {};
  if (isObj(raw.tokenValues)) for (const [k, v] of Object.entries(raw.tokenValues)) if (isTokenName(k) && Array.isArray(v)) tokenValues[k] = v.filter((x): x is string => typeof x === 'string');
  return {
    kind: 'url',
    name: str(raw.name),
    urls: raw.urls,
    format: FORMAT_IDS.includes(raw.format as FormatId) ? (raw.format as FormatId) : 'auto',
    naming: NAMING_IDS.includes(raw.naming as Naming) ? (raw.naming as Naming) : 'native',
    s3: { region: awsRegion(s3.region), accessKeyId: '', secretAccessKey: '', sessionToken: '', endpoint: str(s3.endpoint), urlStyle: s3.urlStyle === 'path' ? 'path' : 'vhost' },
    authMode: raw.authMode === 'none' || raw.authMode === 'oidc' ? raw.authMode : 'static',
    oidc: {
      // the region is part of the STS host name, so it is checked as strictly as the endpoint
      authUrl: hostOf(str(o.authUrl)) ? str(o.authUrl) : DEFAULT_OIDC.authUrl,
      clientId: str(o.clientId),
      scope: str(o.scope, DEFAULT_OIDC.scope),
      extraParams: str(o.extraParams),
      roleArn: str(o.roleArn),
      region: awsRegion(o.region) || DEFAULT_OIDC.region,
      stsEndpoint: linkStsEndpoint(o.stsEndpoint),
      durationSeconds: typeof o.durationSeconds === 'number' ? o.durationSeconds : DEFAULT_OIDC.durationSeconds,
      sessionName: str(o.sessionName, DEFAULT_OIDC.sessionName),
    },
    maxFiles: typeof raw.maxFiles === 'number' && raw.maxFiles >= 0 ? Math.floor(raw.maxFiles) : 0,
    tokenValues,
    timeField: typeof raw.timeField === 'string' ? raw.timeField : null,
  };
}

/**
 * Where a source reads from, in one line for the link banner: "s3://b/p/*.gz · endpoint · oidc".
 * A sign-in source also names the identity provider, the STS endpoint and the role, because
 * pressing Connect sends this browser's identity to them.
 */
export function describeSource(cfg: SourceConfig): string {
  if (cfg.kind !== 'url') return cfg.kind;
  const lines = sourceUrls(cfg);
  const parts = [lines.slice(0, 2).join(', ') + (lines.length > 2 ? ' …' : '')];
  if (cfg.s3.endpoint) parts.push(cfg.s3.endpoint);
  parts.push(cfg.authMode);
  if (cfg.authMode === 'oidc') {
    const idp = hostOf(cfg.oidc.authUrl);
    if (idp) parts.push(idp);
    const sts = cfg.oidc.stsEndpoint ? hostOf(cfg.oidc.stsEndpoint) : cfg.oidc.region ? `sts.${cfg.oidc.region}.amazonaws.com` : 'sts.amazonaws.com';
    if (sts) parts.push(sts);
    if (cfg.oidc.roleArn) parts.push(cfg.oidc.roleArn);
  }
  return parts.join(' · ');
}
