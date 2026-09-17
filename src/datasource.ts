import type { AwsCredentials } from './auth';
import { t } from './i18n';
import { cacheSeed, fmtBytes, type SeedFile } from './cache';
import { normalizationAvailable, normalizeGzipFiles, type NormalizeFile } from './gznorm';
import { DataProtocol, exec, execAll, getDB, query } from './duck';
import { describeError } from './errors';
import { CancelledError, throwIfAborted } from './net';
import { originPattern } from './permissions';
import { detectFormat, resolveFormat, type FormatDef } from './formats';
import {
  DEFAULT_MAX_FILES,
  HAS_DATE_TOKEN,
  HAS_WILDCARD,
  captureRegex,
  discoverTokenValues,
  concretePatterns,
  namedToGlob,
  namedTokens,
  parseS3Url,
  resolveS3Patterns,
  s3Target,
  signObjectGet,
  type TokenValue,
} from './s3list';

export { detectFormat };
import type { Field } from './fields';
import { findField, introspectFields, isTimeCandidate, quoteIdent } from './fields';
import { VIEW, lit } from './sql';
import type { SourceConfig } from './sources';

export interface AttachedSource {
  fields: Field[];
  timeField: Field | null;
  rowCount: number | null;
  description: string;
  /** concrete files behind the view (after glob / date expansion) */
  files: string[];
  /** size of each entry of `files` from the listing; null for plain URLs (not listed) */
  fileSizes: (number | null)[];
  /** the source depends on the time range (date tokens) and must be re-resolved when it changes */
  rangeDependent: boolean;
  /** total size of the matched objects when known from the listing */
  totalBytes: number | null;
  /** non-fatal warning from file resolution (too many files, …) */
  warning: string | null;
  /** virtual columns captured from file names via {name} tokens */
  captures: string[];
}

/** Values allowed for named tokens (from "is" / "is one of" filters); used to prune files. */
export type ValueFilters = Record<string, string[]>;

/**
 * Hooks for a running connect. `phase` tells the UI whether the step talks to storage from
 * the page ('list': cancellable) or runs inside DuckDB ('db': queued behind running queries,
 * cannot be interrupted).
 */
export interface LargeSourceInfo {
  files: number;
  bytes: number | null;
  threshold: number;
}

export interface AttachOptions {
  signal?: AbortSignal | null;
  onProgress?: (message: string, phase: 'list' | 'db') => void;
  /**
   * Called after listing, before DuckDB is touched, when more files than the threshold (or more
   * than LARGE_BYTES) matched. Resolve false to abandon the connect.
   */
  confirmLarge?: (info: LargeSourceInfo) => Promise<boolean>;
}

/** Matched sizes above this ask for confirmation even when the file count is small. */
const LARGE_BYTES = 512 * 1024 * 1024;

export function capturedColumns(cfg: SourceConfig): string[] {
  const out: string[] = [];
  for (const u of sourceUrls(cfg)) for (const n of namedTokens(u)) if (!out.includes(n)) out.push(n);
  return out;
}

/**
 * duckdb-wasm understands s3_region / s3_access_key_id / s3_secret_access_key /
 * s3_session_token / s3_endpoint only (they are built into the runtime, not the httpfs
 * extension, so e.g. `s3_url_style` does not exist here). The URL style is derived from
 * the endpoint: an endpoint with a scheme ("http://minio:9000") means path-style
 * (endpoint/bucket/key); a bare host ("s3.ap-northeast-1.amazonaws.com") means
 * virtual-hosted style (bucket.host/key). No endpoint → bucket.s3.amazonaws.com.
 */
export function s3EndpointFor(s3: SourceConfig['s3']): string {
  let ep = (s3.endpoint || '').trim().replace(/\/+$/, '');
  if (s3.urlStyle === 'path') {
    if (!ep) ep = s3.region ? `s3.${s3.region}.amazonaws.com` : 's3.amazonaws.com';
    if (!/^https?:\/\//.test(ep)) ep = 'https://' + ep;
  } else if (/^https?:\/\//.test(ep)) {
    ep = ep.replace(/^https?:\/\//, '');
  }
  return ep;
}

/** URLs (one per line, comments stripped) from the config. */
export function sourceUrls(cfg: SourceConfig): string[] {
  return cfg.urls
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'));
}

/** Resolve an s3:// URL to the https URL duckdb-wasm will request (for host permissions). */
export function s3HttpsUrl(url: string, s3: SourceConfig['s3']): string | null {
  const m = /^s3:\/\/([^/]+)(\/.*)?$/.exec(url);
  if (!m) return null;
  const bucket = m[1];
  const ep = s3EndpointFor(s3);
  if (/^https?:\/\//.test(ep)) return `${ep}/${bucket}${m[2] ?? ''}`;
  return `https://${bucket}.${ep || 's3.amazonaws.com'}${m[2] ?? ''}`;
}

/** Host permission patterns needed to read the configured URLs. */
export function requiredOrigins(cfg: SourceConfig): string[] {
  const out = new Set<string>();
  for (const raw of sourceUrls(cfg)) {
    const u = namedToGlob(raw)
      .replace(/\{(yyyy|yy|MM|dd|HH)\}/g, '0')
      .replace(/[*?[\]]/g, 'x');
    const https = u.startsWith('s3://') ? s3HttpsUrl(u, cfg.s3) : u;
    const p = https ? originPattern(https) : null;
    if (p) out.add(p);
  }
  return [...out];
}

/** Apply S3 settings to DuckDB. `creds` overrides the static keys (OIDC / STS mode). */
export async function applyS3(cfg: SourceConfig, creds: AwsCredentials | null = null) {
  const s = cfg.s3;
  const stmts: [string, string][] = [];
  if (s.region) stmts.push(['s3_region', s.region]);
  const useStatic = cfg.authMode === 'static';
  stmts.push(['s3_access_key_id', creds?.accessKeyId ?? (useStatic ? (s.accessKeyId ?? '') : '')]);
  stmts.push(['s3_secret_access_key', creds?.secretAccessKey ?? (useStatic ? (s.secretAccessKey ?? '') : '')]);
  stmts.push(['s3_session_token', creds?.sessionToken ?? (useStatic ? (s.sessionToken ?? '') : '')]);
  stmts.push(['s3_endpoint', s3EndpointFor(s)]);
  // one step: a query between the key id and the secret would sign with a mismatched pair
  await execAll(
    stmts.map(([k, v]) => `SET ${k}=${lit(v)}`),
    (i, e) => new Error(t('src.applyFailed', { key: stmts[i][0], error: describeError(e) }), { cause: e }),
  );
}

export interface TimeWindow {
  from: Date;
  to: Date;
}

/** Named tokens of the patterns that have no selected value yet. */
export function unselectedTokens(cfg: SourceConfig): string[] {
  return capturedColumns(cfg).filter((n) => !cfg.tokenValues?.[n]?.length);
}

/** List the values the {name} tokens take (newest partitions only). */
export async function discoverVariables(
  cfg: SourceConfig,
  creds: AwsCredentials | null,
  range: TimeWindow | null,
  opts: AttachOptions = {},
): Promise<{ values: Record<string, TokenValue[]>; listedFiles: number }> {
  const lines = sourceUrls(cfg).filter((u) => u.startsWith('s3://') && namedTokens(u).length);
  if (!lines.length) return { values: {}, listedFiles: 0 };
  const placeholder = lines.find((u) => /<[a-z-]+>/i.test(u));
  if (placeholder) throw new Error(t('src.placeholder', { placeholder: /<[a-z-]+>/i.exec(placeholder)![0] }));
  if (lines.some((u) => HAS_DATE_TOKEN.test(u)) && !range) throw new Error(t('src.dateNeedsRange'));
  return discoverTokenValues(lines, cfg.s3, cfg.authMode === 'none' ? null : (creds ?? staticCreds(cfg)), range, {
    signal: opts.signal,
    onProgress: (done, total) => opts.onProgress?.(t('src.listingValues', { done, total }), 'list'),
  });
}

export function isRangeDependent(cfg: SourceConfig): boolean {
  return cfg.kind === 'url' && sourceUrls(cfg).some((u) => HAS_DATE_TOKEN.test(u));
}

/**
 * Turn the configured URL lines into concrete file URLs: date tokens are expanded over
 * the time window, s3:// globs are listed with ListObjectsV2 (duckdb-wasm cannot glob S3).
 */
export async function resolveFiles(
  cfg: SourceConfig,
  creds: AwsCredentials | null,
  range: TimeWindow | null,
  valueFilters: ValueFilters = {},
  opts: AttachOptions = {},
): Promise<{
  urls: string[];
  sizes: (number | null)[];
  seeds: SeedFile[];
  patterns: number;
  skippedByTime: number;
  skippedByFilter: number;
  timePruned: boolean;
  totalBytes: number | null;
  warning: string | null;
}> {
  const lines = sourceUrls(cfg);
  const placeholder = lines.find((u) => /<[a-z-]+>/i.test(u));
  if (placeholder) {
    const m = /<[a-z-]+>/i.exec(placeholder)![0];
    throw new Error(t('src.placeholderLong', { placeholder: m }));
  }
  const s3Patterns = lines.filter((u) => u.startsWith('s3://'));
  const others = lines.filter((u) => !u.startsWith('s3://'));
  const out: string[] = [];
  const sizes: (number | null)[] = [];
  const seeds: SeedFile[] = [];
  let patterns = 0;
  let skippedByTime = 0;
  let skippedByFilter = 0;
  let timePruned = false;
  let totalBytes: number | null = null;
  let warning: string | null = null;
  for (const u0 of others) {
    const u = namedToGlob(u0);
    const concrete = concretePatterns(u, range);
    patterns += concrete.length;
    if (concrete.some((c) => HAS_WILDCARD.test(c))) throw new Error(t('src.wildcardS3Only', { url: u }));
    out.push(...concrete);
    sizes.push(...concrete.map(() => null));
  }
  if (s3Patterns.length) {
    const r = await resolveS3Patterns(
      s3Patterns,
      cfg.s3,
      cfg.authMode === 'none' ? null : (creds ?? staticCreds(cfg)),
      range,
      cfg.maxFiles || undefined,
      valueFilters,
      {
        signal: opts.signal,
        onProgress: (done, total) => opts.onProgress?.(total > 1 ? t('src.listingPrefixes', { done, total }) : t('src.listingFiles'), 'list'),
      },
      cfg.tokenValues ?? {},
    );
    patterns += r.patterns;
    skippedByTime = r.skippedByTime;
    timePruned = r.timePruned;
    skippedByFilter = r.skippedByFilter;
    out.push(...r.urls);
    const listed = r.objects.length === r.urls.length;
    sizes.push(...r.urls.map((_, i) => (listed ? r.objects[i].size : null)));
    if (listed) {
      totalBytes = r.objects.reduce((a, o) => a + o.size, 0);
      r.urls.forEach((u, i) => {
        const https = s3HttpsUrl(u, cfg.s3);
        if (https) seeds.push({ url: https, size: r.objects[i].size, etag: r.objects[i].etag, lastModified: r.objects[i].lastModified, s3: parseS3Url(u) ?? undefined });
      });
    }
    warning = r.warning;
  }
  return { urls: out, sizes, seeds, patterns, skippedByTime, skippedByFilter, timePruned, totalBytes, warning };
}

/**
 * SELECT statement of the source view for a format: reader → derived columns → optional wrap.
 * `captures` (extra SELECT expressions over `filename`) requires filename = true.
 */
export function viewSelect(fmt: FormatDef, files: string[], captures: string | null, withFilename = true): string {
  const list = '[' + files.map(lit).join(', ') + ']';
  let sql = `SELECT *${withFilename ? ' EXCLUDE (filename)' : ''}${fmt.select ?? ''}${captures ?? ''}${withFilename ? ', filename AS _file' : ''} FROM ${fmt.reader(list, withFilename)}`;
  if (fmt.wrap) sql = fmt.wrap(sql);
  return sql;
}

/** SELECT list that turns {name} tokens of the patterns into columns extracted from the file name. */
function captureSelect(cfg: SourceConfig): string {
  const cols: string[] = [];
  const done = new Set<string>();
  for (const u of sourceUrls(cfg)) {
    const cap = captureRegex(u);
    cap.names.forEach((n, i) => {
      if (done.has(n)) return;
      done.add(n);
      cols.push(`regexp_extract(filename, ${lit(cap.source)}, ${i + 1}) AS ${quoteIdent(n)}`);
    });
  }
  return cols.length ? ', ' + cols.join(', ') : '';
}

function staticCreds(cfg: SourceConfig): AwsCredentials | null {
  if (cfg.authMode !== 'static' || !cfg.s3.accessKeyId) return null;
  return { accessKeyId: cfg.s3.accessKeyId, secretAccessKey: cfg.s3.secretAccessKey, sessionToken: cfg.s3.sessionToken, expiration: '' };
}

type Progress = (message: string, phase: 'list' | 'db') => void;

/** What the three source kinds have in common once their view exists. */
interface ViewInfo {
  description: string;
  files: string[];
  fileSizes: (number | null)[];
  totalBytes: number | null;
  warning: string | null;
  /** the file list depends on the time range, so a new range has to re-resolve it */
  rangeDependent: boolean;
}

async function attachDemo(progress: Progress): Promise<ViewInfo> {
  progress(t('src.demo.progress'), 'db');
  await createDemoTable();
  await exec(`CREATE OR REPLACE VIEW ${VIEW} AS SELECT * FROM demo_logs`);
  return { description: t('src.demo.description'), files: [], fileSizes: [], totalBytes: null, warning: null, rangeDependent: false };
}

async function attachLocal(cfg: SourceConfig, localFiles: File[], progress: Progress): Promise<ViewInfo> {
  if (!localFiles.length) throw new Error(t('src.local.none'));
  const db = getDB();
  const names: string[] = [];
  progress(t('src.local.progress'), 'db');
  for (const f of localFiles) {
    await db.registerFileHandle(f.name, f, DataProtocol.BROWSER_FILEREADER, true);
    names.push(f.name);
  }
  await exec(`CREATE OR REPLACE VIEW ${VIEW} AS ${viewSelect(resolveFormat(cfg.format, names), names, null)}`);
  const description = t('src.local.description', { n: names.length, names: names.slice(0, 3).join(', '), more: names.length > 3 ? '…' : '' });
  return { description, files: names, fileSizes: [], totalBytes: null, warning: null, rangeDependent: false };
}

/**
 * Concatenated gzip objects (multi-member, as AWS log delivery writes them) break DuckDB-Wasm's
 * gzip reader over HTTP: fetch every listed .gz here, re-pack when needed, keep it in the cache.
 * Returns notes for the description.
 */
async function prepareGzip(cfg: SourceConfig, creds: AwsCredentials | null, seeds: SeedFile[], opts: AttachOptions, progress: Progress): Promise<string[]> {
  const gzSeeds = seeds.filter((s) => s.s3 && /\.gz$/i.test(s.url));
  if (!gzSeeds.length) return [];
  const avail = await normalizationAvailable();
  if (!avail.ok) return [t('src.gzDirect', { reason: avail.reason })];
  const effCreds = cfg.authMode === 'none' ? null : (creds ?? staticCreds(cfg));
  const region = cfg.s3.region || '';
  const targets = new Map<string, ReturnType<typeof s3Target>>();
  const list: NormalizeFile[] = [];
  for (const s of gzSeeds) {
    const { bucket, key } = s.s3!;
    let target = targets.get(bucket);
    if (!target) targets.set(bucket, (target = s3Target(bucket, cfg.s3)));
    const signed = await signObjectGet(target, key, region, effCreds);
    list.push({ url: s.url, fetchUrl: signed.url, headers: signed.headers, etag: s.etag, size: s.size, lastModified: s.lastModified });
  }
  progress(t('src.fetchingGz', { n: list.length }), 'list');
  const notes: string[] = [];
  try {
    const r = await normalizeGzipFiles(list, {
      signal: opts.signal,
      onProgress: (done, total, bytes) => opts.onProgress?.(t('src.fetchingGzProgress', { done, total, bytes: fmtBytes(bytes) }), 'list'),
    });
    throwIfAborted(opts.signal);
    if (r.repacked) notes.push(t('src.repacked', { n: r.repacked }));
    if (r.failed.length) notes.push(t('src.gzFailed', { n: r.failed.length, error: r.failed[0].error }));
  } catch (e) {
    throwIfAborted(opts.signal);
    if (e instanceof DOMException && e.name === 'AbortError') throw new CancelledError();
    throw e;
  }
  return notes;
}

/** Resolve the URL lines to files (cancellable), confirm large sets, prime the cache, create the view. */
async function attachRemote(cfg: SourceConfig, creds: AwsCredentials | null, range: TimeWindow | null, valueFilters: ValueFilters, opts: AttachOptions, progress: Progress): Promise<ViewInfo> {
  const lines = sourceUrls(cfg);
  if (!lines.length) throw new Error(t('src.noUrls'));
  // List first: it runs on the page and can be cancelled; DuckDB is only touched afterwards.
  progress(t('src.listingFiles'), 'list');
  const resolved = await resolveFiles(cfg, creds, range, valueFilters, opts);
  throwIfAborted(opts.signal);
  if (!resolved.urls.length) {
    throw new Error(
      isRangeDependent(cfg) && !range
        ? t('src.dateNeedsRange')
        : t('src.noMatch', { patterns: lines.join(', '), range: range ? t('src.noMatch.range', { from: range.from.toISOString(), to: range.to.toISOString() }) : '' }),
    );
  }
  const files = resolved.urls;
  const totalBytes = resolved.totalBytes;
  let warning = resolved.warning;
  const captures = capturedColumns(cfg);
  // Ask before touching DuckDB when the source is large: from here on, steps cannot be cancelled.
  const threshold = cfg.maxFiles || DEFAULT_MAX_FILES;
  if (opts.confirmLarge && (files.length > threshold || (totalBytes !== null && totalBytes > LARGE_BYTES))) {
    progress(t('src.waiting', { n: files.length }), 'list');
    const ok = await opts.confirmLarge({ files: files.length, bytes: totalBytes, threshold });
    if (!ok) throw new CancelledError();
    throwIfAborted(opts.signal);
    warning = null; // the user has seen the numbers; no need to repeat them as a warning
  }
  // Seed the range cache with size / ETag from the listing so DuckDB's per-file HEADs
  // (one per file, per bind) are answered locally instead of hitting S3.
  if (resolved.seeds.length) {
    progress(t('src.seeding', { n: resolved.seeds.length }), 'list');
    try {
      await cacheSeed(resolved.seeds);
    } catch (e) {
      console.warn('cache seed failed', e);
    }
  }
  const notes = await prepareGzip(cfg, creds, resolved.seeds, opts, progress);
  progress(t('src.creatingView', { n: files.length }), 'db');
  if (lines.some((u) => u.startsWith('s3://'))) await applyS3(cfg, creds);
  await exec(`CREATE OR REPLACE VIEW ${VIEW} AS ${viewSelect(resolveFormat(cfg.format, files), files, captures.length ? captureSelect(cfg) : null)}`);
  const expanded = resolved.patterns > 1 || files.length !== lines.length || resolved.skippedByTime > 0 || resolved.skippedByFilter > 0;
  if (resolved.skippedByTime) notes.push(t('src.skippedByTime', { n: resolved.skippedByTime }));
  if (resolved.skippedByFilter) notes.push(t('src.skippedByFilter', { n: resolved.skippedByFilter, names: captures.join(', ') }));
  const skipped = notes.length ? ` (${notes.join('; ')})` : '';
  const size = totalBytes !== null ? `, ${(totalBytes / 1048576).toFixed(totalBytes < 10 * 1048576 ? 1 : 0)} MB` : '';
  const more = files.length > 1 ? ' …' : '';
  const description = expanded
    ? t('src.description.matched', { n: files.length, size, patterns: lines.length, notes: skipped, first: files[0], more })
    : t('src.description.urls', { n: files.length, first: files[0], more });
  // Date tokens are not the only way the range decides which files there are: a key whose name
  // carries a timestamp is dropped when it falls outside the range, so such a source has to
  // re-list when the range moves, or it keeps showing the files the first range asked for.
  return { description, files, fileSizes: resolved.sizes, totalBytes, warning, rangeDependent: isRangeDependent(cfg) || resolved.timePruned };
}

/** The remembered choice if it still looks like a time column, else the format's preference, else the best-named date column. */
function pickTimeField(cfg: SourceConfig, fields: Field[], files: string[]): Field | null {
  if (cfg.timeField) {
    const f = findField(fields, cfg.timeField);
    if (f && (f.kind === 'date' || isTimeCandidate(f))) return f;
  }
  if (cfg.kind !== 'demo') {
    const pref = resolveFormat(cfg.format, files).timeField;
    const f = (pref && findField(fields, pref)) || (cfg.format === 'ltsv' ? (findField(fields, 'log.time') ?? findField(fields, 'log.timestamp')) : null);
    if (f) return f;
  }
  const cands = fields.filter((f) => f.kind === 'date');
  return cands.find((f) => f.name === '@timestamp') ?? cands.find((f) => /timestamp|time|ts|date/i.test(f.name)) ?? cands[0] ?? fields.find(isTimeCandidate) ?? null;
}

export async function attachSource(
  cfg: SourceConfig,
  localFiles: File[] = [],
  creds: AwsCredentials | null = null,
  range: TimeWindow | null = null,
  valueFilters: ValueFilters = {},
  opts: AttachOptions = {},
): Promise<AttachedSource> {
  const progress: Progress = (m, phase) => {
    throwIfAborted(opts.signal);
    opts.onProgress?.(m, phase);
  };
  const view =
    cfg.kind === 'demo' ? await attachDemo(progress) : cfg.kind === 'local' ? await attachLocal(cfg, localFiles, progress) : await attachRemote(cfg, creds, range, valueFilters, opts, progress);
  progress(t('src.readingSchema'), 'db');
  const fields = await introspectFields(VIEW);
  const timeField = pickTimeField(cfg, fields, view.files);
  // Row count at connect time only for local / demo data. Over HTTP it would touch every file
  // (all Parquet footers, or a full scan of text formats); Discover counts per time range.
  let rowCount: number | null = null;
  if (cfg.kind !== 'url') {
    progress(t('src.counting'), 'db');
    try {
      const r = await query(`SELECT count(*)::DOUBLE AS n FROM ${VIEW}`);
      rowCount = Number(r.rows[0]?.n ?? 0);
    } catch {
      rowCount = null;
    }
  }
  return { fields, timeField, rowCount, ...view, captures: cfg.kind === 'url' ? capturedColumns(cfg) : [] };
}

export async function createDemoTable() {
  const exists = await query(`SELECT count(*)::DOUBLE AS n FROM information_schema.tables WHERE table_name = 'demo_logs'`);
  if (Number(exists.rows[0]?.n) > 0) return;
  await exec(`
CREATE TABLE demo_logs AS
WITH r AS (
  SELECT i,
    random() AS r1, random() AS r2, random() AS r3, random() AS r4, random() AS r5, random() AS r6
  FROM range(120000) t(i)
),
base AS (
  SELECT *,
    -- 7 days of data with a daily rhythm and one incident burst ~26h ago
    CASE
      WHEN r6 < 0.06 THEN now()::TIMESTAMP - to_seconds(93600 + floor(r1 * 2400)::BIGINT)
      ELSE now()::TIMESTAMP - to_seconds(floor(r1 * 604800)::BIGINT)
    END AS ts0,
    ['GET','GET','GET','GET','POST','POST','PUT','DELETE'][1 + floor(r2 * 8)::INT] AS method,
    ['/api/articles','/api/articles','/api/search','/api/users/me','/login','/api/comments','/static/app.js','/healthz','/api/orders','/api/checkout'][1 + floor(r3 * 10)::INT] AS path,
    ['web-1','web-2','web-3','web-4','api-1','api-2'][1 + floor(r4 * 6)::INT] AS hostname,
    ['JP','JP','JP','JP','US','US','SG','DE','GB','KR'][1 + floor(r5 * 10)::INT] AS country
  FROM r
),
enriched AS (
  SELECT *,
    CASE
      WHEN r6 < 0.06 AND r2 < 0.7 THEN 503
      WHEN r5 < 0.02 THEN 500
      WHEN r5 < 0.07 THEN 404
      WHEN r5 < 0.10 THEN 401
      WHEN method = 'POST' AND r3 < 0.3 THEN 201
      WHEN r5 < 0.13 THEN 302
      ELSE 200 END AS status,
    CASE WHEN path = '/api/search' THEN 120 + r1 * 900 WHEN path = '/api/checkout' THEN 200 + r2 * 1500 ELSE 5 + r3 * 180 END
      * (CASE WHEN r6 < 0.06 THEN 6 ELSE 1 END) AS latency_ms
  FROM base
)
SELECT
  ts0 AS "@timestamp",
  struct_pack(name := hostname, ip := '10.0.' || (1 + floor(r4 * 6)::INT)::VARCHAR || '.' || (10 + floor(r2 * 200)::INT)::VARCHAR) AS host,
  struct_pack(method := method, status := status, path := path,
              bytes := (200 + floor(r1 * 50000))::BIGINT, latency_ms := round(latency_ms, 1)::DOUBLE) AS http,
  struct_pack(country := country,
              city := CASE country WHEN 'JP' THEN ['Tokyo','Osaka','Nagoya'][1 + floor(r3 * 3)::INT] WHEN 'US' THEN ['New York','San Jose'][1 + floor(r3 * 2)::INT] WHEN 'SG' THEN 'Singapore' WHEN 'DE' THEN 'Frankfurt' WHEN 'GB' THEN 'London' ELSE 'Seoul' END) AS geo,
  '203.0.' || floor(r2 * 255)::INT::VARCHAR || '.' || floor(r5 * 255)::INT::VARCHAR AS client_ip,
  ['Mozilla/5.0 (Macintosh) Chrome/126','Mozilla/5.0 (Windows NT 10.0) Edge/125','Mozilla/5.0 (iPhone) Safari/17','curl/8.4.0','Googlebot/2.1'][1 + floor(r4 * 5)::INT] AS user_agent,
  CASE WHEN status >= 500 THEN 'error' WHEN status >= 400 THEN 'warn' ELSE 'info' END AS level,
  CASE
    WHEN status = 503 THEN 'upstream connect error or disconnect/reset before headers. reset reason: connection failure'
    WHEN status = 500 THEN 'unhandled exception: NullPointerException in ArticleService.render'
    WHEN status = 404 THEN 'route not found: ' || path
    WHEN status = 401 THEN 'authentication required'
    WHEN latency_ms > 800 THEN 'slow request: ' || method || ' ' || path || ' took ' || round(latency_ms)::VARCHAR || 'ms'
    ELSE method || ' ' || path || ' -> ' || status::VARCHAR
  END AS message,
  CASE WHEN status >= 500 THEN ['prod','alert'] WHEN path LIKE '/api/%' THEN ['prod','api'] ELSE ['prod'] END AS tags,
  ('{"user_id": ' || floor(r1 * 5000)::INT::VARCHAR || ', "session": "' || substr(md5(i::VARCHAR), 1, 12) || '", "premium": ' || (r2 < 0.2)::VARCHAR || ', "ab_test": "' || ['control','variant-a','variant-b'][1 + floor(r3 * 3)::INT] || '"}')::JSON AS extra
FROM enriched
`);
}
