// S3 listing done by the page itself (duckdb-wasm cannot expand globs on S3: its glob()
// only HEADs the literal pattern). Implements SigV4 for ListObjectsV2 with WebCrypto,
// glob expansion by walking "directories" (delimiter '/') and date-token expansion
// ({yyyy} {MM} {dd} {HH}) over the selected time range.

import type { AwsCredentials } from './auth';
import { t as tr } from './i18n';
import { CancelledError, LIST_CONCURRENCY, fetchWithTimeout, mapLimit, throwIfAborted } from './net';
import type { S3Config } from './sources';
import { pad, toHex } from './util';

/** Optional cancellation / progress hooks for a listing. */
export interface ListOptions {
  signal?: AbortSignal | null;
  /** called after each concrete pattern has been listed */
  onProgress?: (done: number, total: number) => void;
}

export interface S3Object {
  key: string;
  size: number;
  lastModified: string;
  etag: string;
}

export interface S3Target {
  bucket: string;
  /** e.g. https://bucket.s3.ap-northeast-1.amazonaws.com  or  http://localhost:9000/bucket */
  baseUrl: string;
  /** canonical URI prefix for signing: '/' (vhost) or '/bucket/' (path style) */
  canonicalBase: string;
  host: string;
}

const enc = new TextEncoder();

async function sha256(s: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}
async function hmac(key: ArrayBuffer | Uint8Array, msg: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(msg));
}
function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * How the endpoint is addressed. An endpoint with a scheme ("http://minio:9000") means path-style
 * (endpoint/bucket/key), as does choosing path style; a bare host ("s3.ap-northeast-1.amazonaws.com")
 * means virtual-hosted style (bucket.host/key). duckdb-wasm reads the same rule off the endpoint
 * string it is handed, and the listing signs what DuckDB then requests, so both derive the style
 * here instead of each making up its own.
 */
export function endpointStyle(s3: S3Config): { pathStyle: boolean; endpoint: string } {
  let ep = (s3.endpoint || '').trim().replace(/\/+$/, '');
  const pathStyle = s3.urlStyle === 'path' || /^https?:\/\//.test(ep);
  if (pathStyle) {
    if (!ep) ep = s3.region ? `s3.${s3.region}.amazonaws.com` : 's3.amazonaws.com';
    if (!/^https?:\/\//.test(ep)) ep = 'https://' + ep;
  } else {
    ep = ep.replace(/^https?:\/\//, '') || 's3.amazonaws.com';
  }
  return { pathStyle, endpoint: ep };
}

export function s3Target(bucket: string, s3: S3Config): S3Target {
  const { pathStyle, endpoint } = endpointStyle(s3);
  if (pathStyle) return { bucket, baseUrl: `${endpoint}/${bucket}`, canonicalBase: `/${bucket}/`, host: new URL(endpoint).host };
  return { bucket, baseUrl: `https://${bucket}.${endpoint}`, canonicalBase: '/', host: `${bucket}.${endpoint}` };
}

function amzDate(d = new Date()): { date: string; datetime: string } {
  const iso = d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  return { date: iso.slice(0, 8), datetime: iso };
}

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'; // sha256('')

/**
 * SigV4 signing keys, one per (date, region, access key). Deriving one costs four HMACs; a
 * connect that signs thousands of object GETs (gzip re-packing) reuses it.
 */
const signingKeys = new Map<string, { secret: string; key: ArrayBuffer }>();

async function signingKey(creds: AwsCredentials, date: string, region: string): Promise<ArrayBuffer> {
  const id = `${date}/${region}/${creds.accessKeyId}`;
  const hit = signingKeys.get(id);
  if (hit && hit.secret === creds.secretAccessKey) return hit.key;
  let k: ArrayBuffer = await hmac(enc.encode('AWS4' + creds.secretAccessKey), date);
  k = await hmac(k, region);
  k = await hmac(k, 's3');
  k = await hmac(k, 'aws4_request');
  if (signingKeys.size >= 8) signingKeys.clear();
  signingKeys.set(id, { secret: creds.secretAccessKey, key: k });
  return k;
}

/**
 * SigV4 (service s3) headers for a GET with an empty body. `canonicalUri` is the encoded path
 * and `qs` the canonical query string (sorted, RFC 3986 encoded; '' when none).
 */
async function sigv4Get(target: S3Target, canonicalUri: string, qs: string, region: string, creds: AwsCredentials): Promise<Record<string, string>> {
  const { date, datetime } = amzDate();
  const rg = region || 'us-east-1';
  const headers: Record<string, string> = { host: target.host, 'x-amz-content-sha256': EMPTY_SHA256, 'x-amz-date': datetime };
  if (creds.sessionToken) headers['x-amz-security-token'] = creds.sessionToken;
  const signedHeaders = Object.keys(headers).sort();
  const canonical = ['GET', canonicalUri, qs, signedHeaders.map((h) => `${h}:${headers[h]}\n`).join(''), signedHeaders.join(';'), EMPTY_SHA256].join('\n');
  const scope = `${date}/${rg}/s3/aws4_request`;
  const sts = ['AWS4-HMAC-SHA256', datetime, scope, await sha256(canonical)].join('\n');
  const signature = toHex(await hmac(await signingKey(creds, date, rg), sts));
  const out: Record<string, string> = { ...headers };
  delete out.host; // the browser sets Host
  out.authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`;
  return out;
}

/** Sign a GET of the bucket (ListObjectsV2). Returns the URL to fetch and the headers to send. */
async function signGet(target: S3Target, query: Record<string, string>, region: string, creds: AwsCredentials | null): Promise<{ url: string; headers: Record<string, string> }> {
  const qs = Object.keys(query)
    .sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(query[k])}`)
    .join('&');
  const url = `${target.baseUrl}/?${qs}`;
  if (!creds) return { url, headers: {} };
  return { url, headers: await sigv4Get(target, target.canonicalBase, qs, region, creds) };
}

/** Sign a GET of one object. Returns the URL to fetch and the headers to send. */
export async function signObjectGet(target: S3Target, key: string, region: string, creds: AwsCredentials | null): Promise<{ url: string; headers: Record<string, string> }> {
  const encKey = key.split('/').map(rfc3986).join('/');
  const url = `${target.baseUrl}/${encKey}`;
  if (!creds) return { url, headers: {} };
  return { url, headers: await sigv4Get(target, `${target.canonicalBase}${encKey}`, '', region, creds) };
}

export interface ListResult {
  objects: S3Object[];
  prefixes: string[];
}

export async function listObjects(
  target: S3Target,
  region: string,
  creds: AwsCredentials | null,
  prefix: string,
  delimiter: '/' | '' = '/',
  maxObjects = 200000,
  signal?: AbortSignal | null,
): Promise<ListResult> {
  const objects: S3Object[] = [];
  const prefixes: string[] = [];
  let token: string | null = null;
  for (let page = 0; page < 200; page++) {
    const query: Record<string, string> = { 'list-type': '2', prefix, 'max-keys': '1000' };
    if (delimiter) query.delimiter = delimiter;
    if (token) query['continuation-token'] = token;
    const { url, headers } = await signGet(target, query, region, creds);
    const res = await fetchWithTimeout(url, { headers }, `S3 ListObjectsV2 for ${target.bucket}/${prefix}`, signal);
    const text = await res.text();
    if (!res.ok) {
      const m = /<Code>([^<]+)<\/Code>(?:.*?<Message>([^<]+)<\/Message>)?/s.exec(text);
      throw new Error(`S3 ListObjectsV2 ${res.status} for ${target.bucket}/${prefix}: ${m ? `${m[1]} ${m[2] ?? ''}` : text.slice(0, 200)}`);
    }
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    for (const c of Array.from(doc.getElementsByTagName('Contents'))) {
      const key = c.getElementsByTagName('Key')[0]?.textContent ?? '';
      if (!key || key.endsWith('/')) continue;
      objects.push({
        key,
        size: Number(c.getElementsByTagName('Size')[0]?.textContent ?? 0),
        lastModified: c.getElementsByTagName('LastModified')[0]?.textContent ?? '',
        etag: c.getElementsByTagName('ETag')[0]?.textContent ?? '',
      });
      if (objects.length >= maxObjects) throw new Error(tr('src.tooManyObjects', { max: maxObjects, bucket: target.bucket, prefix }));
    }
    for (const p of Array.from(doc.getElementsByTagName('CommonPrefixes'))) {
      const pf = p.getElementsByTagName('Prefix')[0]?.textContent;
      if (pf) prefixes.push(pf);
    }
    const truncated = doc.getElementsByTagName('IsTruncated')[0]?.textContent === 'true';
    token = truncated ? (doc.getElementsByTagName('NextContinuationToken')[0]?.textContent ?? null) : null;
    if (!token) break;
  }
  return { objects, prefixes };
}

// ---------- glob / date tokens ----------

export const HAS_WILDCARD = /[*?[]/;
export const HAS_DATE_TOKEN = /\{(yyyy|yy|MM|dd|HH)\}/;
const DATE_TOKENS = new Set(['yyyy', 'yy', 'MM', 'dd', 'HH']);
/** {name} tokens that are not date tokens: wildcards whose matched text becomes a virtual column */
const NAMED_TOKEN = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function namedTokens(pattern: string): string[] {
  const out: string[] = [];
  for (const m of pattern.matchAll(NAMED_TOKEN)) if (!DATE_TOKENS.has(m[1]) && !out.includes(m[1])) out.push(m[1]);
  return out;
}

/** Replace named tokens with '*' so the pattern can be listed like an ordinary glob. */
export function namedToGlob(pattern: string): string {
  return pattern.replace(NAMED_TOKEN, (all, name) => (DATE_TOKENS.has(name) ? all : '*'));
}

/**
 * Regex (as a string, RE2 / DuckDB compatible) matching the full URL of a file produced by
 * `pattern`, with one capture group per named token in order of first appearance.
 */
export function captureRegex(pattern: string): { source: string; names: string[] } {
  const names: string[] = [];
  let re = '^';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '{') {
      const j = pattern.indexOf('}', i);
      const tok = j > i ? pattern.slice(i + 1, j) : '';
      if (j > i && /^[A-Za-z_][A-Za-z0-9_]*$/.test(tok)) {
        if (tok === 'yyyy') re += '\\d{4}';
        else if (DATE_TOKENS.has(tok)) re += '\\d{2}';
        else {
          // RE2 (DuckDB) has no backreferences: a repeated token is matched loosely and its
          // value is taken from the first occurrence.
          const idx = names.indexOf(tok);
          if (idx >= 0) re += '[^/]*?';
          else {
            names.push(tok);
            re += '([^/]*?)';
          }
        }
        i = j + 1;
        continue;
      }
    }
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i += 2;
      } else {
        re += '[^/]*';
        i++;
      }
      continue;
    }
    if (c === '?') {
      re += '[^/]';
      i++;
      continue;
    }
    re += c.replace(/[.+^$(){}|\\[\]]/g, '\\$&');
    i++;
  }
  return { source: re + '$', names };
}

function extractCaptures(url: string, cap: { source: string; names: string[] }): Record<string, string> | null {
  const m = new RegExp(cap.source).exec(url);
  if (!m) return null;
  const out: Record<string, string> = {};
  cap.names.forEach((n, i) => (out[n] = m[i + 1] ?? ''));
  return out;
}

function globSegmentToRegex(seg: string): RegExp {
  let re = '^';
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const j = seg.indexOf(']', i);
      if (j > i) {
        re += '[' + seg.slice(i + 1, j).replace(/\\/g, '\\\\') + ']';
        i = j;
      } else re += '\\[';
    } else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(re + '$');
}

/**
 * How far past the end of the range the prefixes still matter. A log file is named after the end
 * of the interval it covers and AWS delivers it late, so the records of 23:58 sit in a file named
 * 00:00 under the *next* day's prefix. withinRange accepts such a file; without the same slack
 * here its prefix would never be listed and the last minutes of every day would be missing.
 */
const DELIVERY_LAG_MS = 3 * 3600_000;

/** The concrete prefixes a pattern covers for a range: date tokens expanded, delivery lag included. */
export function concretePatterns(pattern: string, range: { from: Date; to: Date } | null): string[] {
  if (!HAS_DATE_TOKEN.test(pattern)) return [pattern];
  if (!range) return [];
  return expandDateTokens(pattern, range.from, new Date(range.to.getTime() + DELIVERY_LAG_MS));
}

/** Expand {yyyy}/{MM}/{dd}/{HH} tokens over [from, to] (UTC, like AWS log prefixes). */
export function expandDateTokens(pattern: string, from: Date, to: Date, maxPatterns = 5000): string[] {
  if (!HAS_DATE_TOKEN.test(pattern)) return [pattern];
  const hourly = /\{HH\}/.test(pattern);
  const daily = /\{dd\}/.test(pattern);
  const stepMs = hourly ? 3600_000 : daily ? 86400_000 : 0;
  const out: string[] = [];
  const seen = new Set<string>();
  const fmt = (d: Date) =>
    pattern
      .replace(/\{yyyy\}/g, String(d.getUTCFullYear()))
      .replace(/\{yy\}/g, String(d.getUTCFullYear()).slice(2))
      .replace(/\{MM\}/g, pad(d.getUTCMonth() + 1))
      .replace(/\{dd\}/g, pad(d.getUTCDate()))
      .replace(/\{HH\}/g, pad(d.getUTCHours()));
  if (stepMs === 0) {
    // month granularity
    const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
    while (d.getTime() <= to.getTime()) {
      const p = fmt(d);
      if (!seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
      d.setUTCMonth(d.getUTCMonth() + 1);
      if (out.length > maxPatterns) throw new Error(tr('src.tooManyPrefixes'));
    }
    return out;
  }
  const start = Math.floor(from.getTime() / stepMs) * stepMs;
  for (let t = start; t <= to.getTime(); t += stepMs) {
    const p = fmt(new Date(t));
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
    if (out.length > maxPatterns) throw new Error(tr('src.tooManyPrefixes'));
  }
  return out;
}

export function parseS3Url(url: string): { bucket: string; key: string } | null {
  const m = /^s3:\/\/([^/]+)\/?(.*)$/.exec(url);
  return m ? { bucket: m[1], key: m[2] } : null;
}

/** Expand one s3:// glob pattern (without date tokens) into object keys. */
export async function expandS3Glob(url: string, s3: S3Config, creds: AwsCredentials | null, signal?: AbortSignal | null): Promise<S3Object[]> {
  const parsed = parseS3Url(url);
  if (!parsed) throw new Error(`Not an s3:// URL: ${url}`);
  const target = s3Target(parsed.bucket, s3);
  const segments = parsed.key.split('/');
  const list = (prefix: string, delimiter: '/' | '') => listObjects(target, s3.region, creds, prefix, delimiter, undefined, signal);
  // Each level lists its matching "directories" in parallel; results keep the listing order.
  const walk = async (prefix: string, idx: number): Promise<S3Object[]> => {
    throwIfAborted(signal);
    // literal run
    let i = idx;
    let p = prefix;
    while (i < segments.length - 1 && !HAS_WILDCARD.test(segments[i])) p += segments[i++] + '/';
    const seg = segments[i];
    const last = i === segments.length - 1;
    if (seg === '**') {
      const { objects } = await list(p, '');
      const rest = segments.slice(i + 1);
      const restRe = rest.length ? new RegExp(rest.map((r) => globSegmentToRegex(r).source.slice(1, -1)).join('/') + '$') : null;
      return objects.filter((o) => !restRe || restRe.test(o.key.slice(p.length)));
    }
    // S3 prefixes are not directory-bound: the literal text before the first wildcard
    // narrows the listing (e.g. "…/2026/09/09/123_elasticloadbalancing_ap-northeast-1_app.my-alb.").
    const literal = seg.slice(0, seg.search(HAS_WILDCARD));
    if (last) {
      if (!HAS_WILDCARD.test(seg)) {
        const { objects } = await list(p + seg, '/');
        return objects.filter((o) => o.key === p + seg);
      }
      const re = globSegmentToRegex(seg);
      const { objects } = await list(p + literal, '/');
      return objects.filter((o) => re.test(o.key.slice(p.length)));
    }
    const re = globSegmentToRegex(seg);
    const { prefixes } = await list(p + literal, '/');
    const matching = prefixes.filter((pf) => re.test(pf.slice(p.length).replace(/\/$/, '')));
    const nested = await mapLimit(matching, LIST_CONCURRENCY, (pf) => walk(pf, i + 1));
    return nested.flat();
  };
  return walk('', 0);
}

export interface ResolvedFiles {
  /** URLs to hand to DuckDB (s3://bucket/key) */
  urls: string[];
  objects: S3Object[];
  /** how many concrete patterns were listed */
  patterns: number;
  /** set when more than maxFiles matched: the connection still works, but queries will be slow */
  warning: string | null;
}

/**
 * Timestamp embedded in an object key and what it means:
 *  - "…_20260909T0105Z_…"  (ALB / NLB / CloudTrail / flow logs): END of a ~5 minute delivery interval
 *  - "E123.2026-09-09-01.xxx.gz" (CloudFront) / "2026-09-09-01-00-00-HASH" (S3 access logs): delivery hour;
 *    the records inside may be up to a few hours older.
 */
export function keyTimestamp(key: string): { ts: Date; kind: 'minute' | 'hour' } | null {
  const name = key.slice(key.lastIndexOf('/') + 1);
  let m = /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?Z/.exec(name);
  if (m) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0));
    return isNaN(d.getTime()) ? null : { ts: d, kind: 'minute' };
  }
  m = /(?:^|\.)(\d{4})-(\d{2})-(\d{2})-(\d{2})(?:-(\d{2})-(\d{2}))?(?:[.-]|$)/.exec(name);
  if (m) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], m[5] ? +m[5] : 0, m[6] ? +m[6] : 0));
    return isNaN(d.getTime()) ? null : { ts: d, kind: 'hour' };
  }
  return null;
}

/** Drop files whose embedded timestamp cannot cover the range. */
export function withinRange(key: string, range: { from: Date; to: Date } | null): boolean {
  if (!range) return true;
  const k = keyTimestamp(key);
  if (!k) return true;
  const t = k.ts.getTime();
  if (k.kind === 'minute') return t >= range.from.getTime() - 65 * 60_000 && t <= range.to.getTime() + 5 * 60_000;
  // hourly delivery files: records may be delivered up to ~3 hours after they happened
  return t >= range.from.getTime() - 65 * 60_000 && t <= range.to.getTime() + 3 * 3600_000;
}

/**
 * Files matched before a confirmation is asked. Text / gzip logs are fetched whole and one
 * after another (~100 ms each against S3), so 1000 files is roughly 1–2 minutes of reading
 * per query.
 */
export const DEFAULT_MAX_FILES = 1000;

/**
 * Replace named tokens that have selected values with the literal values (cartesian product),
 * so the listing prefix includes them. Tokens without a selection stay wildcards; when the
 * product would exceed `limit`, nothing is substituted (values are then filtered after listing).
 */
export function substituteTokens(pattern: string, selections: Record<string, string[]>, limit = 64): string[] {
  const names = namedTokens(pattern).filter((n) => selections[n]?.length);
  if (!names.length) return [pattern];
  let product = 1;
  for (const n of names) product *= selections[n].length;
  if (product > limit) return [pattern];
  let out = [pattern];
  for (const n of names) {
    const next: string[] = [];
    for (const p of out) for (const v of selections[n]) next.push(p.split(`{${n}}`).join(v));
    out = next;
  }
  return out;
}

export interface TokenValue {
  value: string;
  files: number;
}

/**
 * Find the values the named tokens take, by listing the most recent partition(s) of each
 * pattern (at most `partitions` concrete date patterns per pattern, newest first).
 */
export async function discoverTokenValues(
  patterns: string[],
  s3: S3Config,
  creds: AwsCredentials | null,
  range: { from: Date; to: Date } | null,
  opts: ListOptions = {},
  partitions = 2,
): Promise<{ values: Record<string, TokenValue[]>; listedFiles: number }> {
  const counts: Record<string, Map<string, number>> = {};
  const jobs: { cap: ReturnType<typeof captureRegex>; concrete: string }[] = [];
  for (const original of patterns) {
    const names = namedTokens(original);
    if (!names.length) continue;
    for (const n of names) counts[n] ??= new Map();
    const cap = captureRegex(original);
    const pat = namedToGlob(original);
    const concrete = HAS_DATE_TOKEN.test(pat) ? (range ? expandDateTokens(pat, range.from, range.to) : []) : [pat];
    for (const c of concrete.slice(-partitions)) jobs.push({ cap, concrete: c });
  }
  let done = 0;
  let listedFiles = 0;
  opts.onProgress?.(0, jobs.length);
  const listed = await mapLimit(jobs, LIST_CONCURRENCY, async ({ concrete }) => {
    const found = HAS_WILDCARD.test(concrete) && parseS3Url(concrete) ? await expandS3Glob(concrete, s3, creds, opts.signal) : [];
    opts.onProgress?.(++done, jobs.length);
    return found;
  });
  jobs.forEach(({ cap, concrete }, j) => {
    const bucket = parseS3Url(concrete)?.bucket;
    for (const o of listed[j]) {
      listedFiles++;
      const values = extractCaptures(`s3://${bucket}/${o.key}`, cap);
      if (!values) continue;
      for (const n of cap.names) {
        const m = counts[n];
        m.set(values[n], (m.get(values[n]) ?? 0) + 1);
      }
    }
  });
  const values: Record<string, TokenValue[]> = {};
  for (const [n, m] of Object.entries(counts)) values[n] = [...m.entries()].map(([value, files]) => ({ value, files })).sort((a, b) => a.value.localeCompare(b.value));
  return { values, listedFiles };
}

/**
 * Resolve s3:// patterns with wildcards / date tokens / named tokens into concrete object URLs.
 * `valueFilters` restricts named tokens to given values (files are pruned before reading).
 */
export async function resolveS3Patterns(
  patterns: string[],
  s3: S3Config,
  creds: AwsCredentials | null,
  range: { from: Date; to: Date } | null,
  maxFiles = DEFAULT_MAX_FILES,
  valueFilters: Record<string, string[]> = {},
  opts: ListOptions = {},
  selections: Record<string, string[]> = {},
): Promise<ResolvedFiles & { skippedByTime: number; skippedByFilter: number; timePruned: boolean }> {
  const urls: string[] = [];
  const objects: S3Object[] = [];
  let skippedByTime = 0;
  let skippedByFilter = 0;
  let timePruned = false;
  const seen = new Set<string>();
  // Expand every pattern first (date tokens → one concrete pattern per prefix) …
  const jobs: { cap: ReturnType<typeof captureRegex>; concrete: string; wild: boolean }[] = [];
  // Selected token values become literals in the listing prefix (fewer, narrower listings);
  // anything not substituted is still enforced by the value filter below.
  const filters: Record<string, string[]> = { ...selections };
  for (const [n, vals] of Object.entries(valueFilters)) filters[n] = filters[n] ? filters[n].filter((v) => vals.includes(v)) : vals;
  for (const original of patterns) {
    const cap = captureRegex(original);
    for (const sub of substituteTokens(original, selections)) {
      const pat = namedToGlob(sub);
      for (const c of concretePatterns(pat, range)) jobs.push({ cap, concrete: c, wild: HAS_WILDCARD.test(c) });
    }
  }
  // … then list the prefixes in parallel; the merge below keeps the pattern order. A literal key
  // is listed too (one request) so that its size / ETag seed the cache and gzip re-packing; when
  // that listing is denied the key is still used as it is, since reading it needs no ListBucket.
  let done = 0;
  opts.onProgress?.(0, jobs.length);
  const listed = await mapLimit(jobs, LIST_CONCURRENCY, async ({ concrete, wild }) => {
    let found: S3Object[] | null = null;
    if (parseS3Url(concrete)) {
      try {
        found = await expandS3Glob(concrete, s3, creds, opts.signal);
      } catch (e) {
        if (wild || e instanceof CancelledError) throw e;
        console.warn(`listing ${concrete} failed; using the key without metadata`, e);
      }
    }
    opts.onProgress?.(++done, jobs.length);
    return found;
  });
  jobs.forEach(({ cap, concrete, wild }, j) => {
    const found = listed[j];
    if (!found) {
      if (!wild && !seen.has(concrete)) {
        seen.add(concrete);
        urls.push(concrete);
      }
      return;
    }
    const bucket = parseS3Url(concrete)!.bucket;
    for (const o of found) {
      const u = `s3://${bucket}/${o.key}`;
      if (seen.has(u)) continue;
      seen.add(u);
      // a key the user typed out is never dropped by the name-timestamp heuristic
      if (wild && keyTimestamp(o.key)) {
        // the range decides which of these files there are, so it has to be re-listed when it moves
        timePruned = true;
        if (!withinRange(o.key, range)) {
          skippedByTime++;
          continue;
        }
      }
      if (cap.names.length) {
        const values = extractCaptures(u, cap);
        const rejected = cap.names.some((n) => filters[n]?.length && (!values || !filters[n].includes(values[n])));
        if (rejected) {
          skippedByFilter++;
          continue;
        }
      }
      urls.push(u);
      objects.push(o);
    }
  });
  let warning: string | null = null;
  if (urls.length > maxFiles) {
    const bytes = objects.reduce((a, o) => a + o.size, 0);
    warning = tr('src.warning.many', { files: urls.length.toLocaleString(), mb: (bytes / 1048576).toFixed(0), max: maxFiles.toLocaleString() });
  }
  return { urls, objects, patterns: jobs.length, skippedByTime, skippedByFilter, timePruned, warning };
}
