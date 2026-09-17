// Data source settings: the configuration of the current source (localStorage, without the
// static S3 secrets) and the history of recently connected sources for quick switching.

import { DEFAULT_OIDC, type OidcConfig } from './auth';
import type { FormatId } from './formats';

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
  s3: S3Config;
  /** how S3 credentials are obtained: none (public / presigned), static keys, OIDC → STS */
  authMode: AuthMode;
  oidc: OidcConfig;
  /** upper bound for files matched by patterns (0 = default) */
  maxFiles: number;
  /** values chosen for {name} tokens of the pattern (required before connecting) */
  tokenValues: Record<string, string[]>;
  timeField: string | null;
}

export const DEFAULT_SOURCE: SourceConfig = {
  kind: 'demo',
  name: 'demo-logs',
  urls: '',
  format: 'auto',
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
 * Local sources have no identity (the files cannot be stored): null.
 */
export function sourceKey(cfg: SourceConfig): string | null {
  if (cfg.kind === 'demo') return 'demo';
  if (cfg.kind !== 'url') return null;
  const urls = cfg.urls
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .join('\n');
  return JSON.stringify(['url', urls, cfg.s3.endpoint, cfg.s3.region, cfg.s3.urlStyle, cfg.authMode]);
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
