// AWS credentials without a server:
//   OIDC login (chrome.identity.launchWebAuthFlow, implicit id_token) →
//   STS AssumeRoleWithWebIdentity (unsigned call) → temporary S3 credentials.

import { fetchWithTimeout } from './net';
import { isExtension } from './permissions';

export interface OidcConfig {
  /** Authorization endpoint, e.g. https://accounts.google.com/o/oauth2/v2/auth */
  authUrl: string;
  clientId: string;
  scope: string;
  /** extra query parameters, "hd=example.com&prompt=select_account" */
  extraParams: string;
  roleArn: string;
  region: string;
  /** override, e.g. http://localhost:5299/sts for tests or a VPC endpoint */
  stsEndpoint: string;
  durationSeconds: number;
  sessionName: string;
}

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  /** ISO timestamp */
  expiration: string;
  subject?: string;
}

export const DEFAULT_OIDC: OidcConfig = {
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  clientId: '',
  scope: 'openid email',
  extraParams: '',
  roleArn: '',
  region: 'ap-northeast-1',
  stsEndpoint: '',
  durationSeconds: 3600,
  sessionName: 'duckdive',
};

const SESSION_KEY = 'ddv.awsCredentials';

export function redirectUrl(): string {
  return isExtension && chrome.identity ? chrome.identity.getRedirectURL() : `${location.origin}/oauth-callback`;
}

function randomString(n = 32): string {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function buildAuthUrl(cfg: OidcConfig, interactive: boolean): { url: string; state: string; nonce: string } {
  const state = randomString(16);
  const nonce = randomString(16);
  const u = new URL(cfg.authUrl);
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('response_type', 'id_token');
  u.searchParams.set('response_mode', 'fragment');
  u.searchParams.set('scope', cfg.scope || 'openid');
  u.searchParams.set('redirect_uri', redirectUrl());
  u.searchParams.set('state', state);
  u.searchParams.set('nonce', nonce);
  if (!interactive) u.searchParams.set('prompt', 'none');
  if (cfg.extraParams) {
    for (const [k, v] of new URLSearchParams(cfg.extraParams)) if (!u.searchParams.has(k) || k === 'prompt') u.searchParams.set(k, v);
  }
  return { url: u.toString(), state, nonce };
}

function parseJwt(token: string): Record<string, unknown> {
  const part = token.split('.')[1] ?? '';
  const json = decodeURIComponent(
    atob(part.replace(/-/g, '+').replace(/_/g, '/'))
      .split('')
      .map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
      .join(''),
  );
  return JSON.parse(json);
}

/** Run the OIDC flow and return the id_token. */
export async function loginOidc(cfg: OidcConfig, interactive: boolean): Promise<string> {
  if (!isExtension || !chrome.identity?.launchWebAuthFlow) throw new Error('chrome.identity is only available inside the extension');
  if (!cfg.clientId) throw new Error('OIDC client ID is not configured');
  const { url, state, nonce } = buildAuthUrl(cfg, interactive);
  const resp = await chrome.identity.launchWebAuthFlow({ url, interactive });
  if (!resp) throw new Error('OIDC login was cancelled');
  const frag = new URL(resp).hash.replace(/^#/, '');
  const params = new URLSearchParams(frag || new URL(resp).search);
  const err = params.get('error');
  if (err) throw new Error(`OIDC error: ${err} ${params.get('error_description') ?? ''}`.trim());
  const idToken = params.get('id_token');
  if (!idToken) throw new Error('OIDC response did not contain an id_token');
  if (params.get('state') !== state) throw new Error('OIDC state mismatch');
  const claims = parseJwt(idToken);
  if (claims.nonce !== nonce) throw new Error('OIDC nonce mismatch');
  return idToken;
}

export function stsEndpointFor(cfg: OidcConfig): string {
  if (cfg.stsEndpoint) return cfg.stsEndpoint;
  return cfg.region ? `https://sts.${cfg.region}.amazonaws.com/` : 'https://sts.amazonaws.com/';
}

/** Exchange an OIDC id_token for temporary credentials. No AWS signature is needed for this call. */
export async function assumeRoleWithWebIdentity(cfg: OidcConfig, idToken: string): Promise<AwsCredentials> {
  if (!cfg.roleArn) throw new Error('IAM role ARN is not configured');
  const body = new URLSearchParams({
    Action: 'AssumeRoleWithWebIdentity',
    Version: '2011-06-15',
    RoleArn: cfg.roleArn,
    RoleSessionName: (cfg.sessionName || 'duckdive').replace(/[^\w+=,.@-]/g, '-').slice(0, 64),
    WebIdentityToken: idToken,
    DurationSeconds: String(Math.min(43200, Math.max(900, cfg.durationSeconds || 3600))),
  });
  const res = await fetchWithTimeout(
    stsEndpointFor(cfg),
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8', accept: 'application/xml' },
      body,
    },
    'STS AssumeRoleWithWebIdentity',
  );
  const text = await res.text();
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const get = (tag: string) => doc.getElementsByTagName(tag)[0]?.textContent ?? '';
  if (!res.ok) {
    const code = get('Code');
    const msg = get('Message');
    throw new Error(`STS ${res.status}: ${code} ${msg}`.trim());
  }
  const creds: AwsCredentials = {
    accessKeyId: get('AccessKeyId'),
    secretAccessKey: get('SecretAccessKey'),
    sessionToken: get('SessionToken'),
    expiration: get('Expiration'),
    subject: get('SubjectFromWebIdentityToken') || undefined,
  };
  if (!creds.accessKeyId || !creds.secretAccessKey || !creds.sessionToken) throw new Error('STS response did not contain credentials');
  return creds;
}

export async function signIn(cfg: OidcConfig, interactive: boolean): Promise<AwsCredentials> {
  const token = await loginOidc(cfg, interactive);
  const creds = await assumeRoleWithWebIdentity(cfg, token);
  await storeCredentials(creds);
  return creds;
}

// Temporary credentials live in chrome.storage.session (memory only, cleared when the
// browser closes). Outside the extension they are kept in sessionStorage.
export async function storeCredentials(c: AwsCredentials | null): Promise<void> {
  if (isExtension && chrome.storage?.session) {
    if (c) await chrome.storage.session.set({ [SESSION_KEY]: c });
    else await chrome.storage.session.remove(SESSION_KEY);
    return;
  }
  if (c) sessionStorage.setItem(SESSION_KEY, JSON.stringify(c));
  else sessionStorage.removeItem(SESSION_KEY);
}

export async function loadCredentials(): Promise<AwsCredentials | null> {
  if (isExtension && chrome.storage?.session) {
    const r = await chrome.storage.session.get(SESSION_KEY);
    return (r[SESSION_KEY] as AwsCredentials | undefined) ?? null;
  }
  const raw = sessionStorage.getItem(SESSION_KEY);
  return raw ? (JSON.parse(raw) as AwsCredentials) : null;
}

export function secondsUntilExpiry(c: AwsCredentials | null): number {
  if (!c?.expiration) return Infinity;
  return (new Date(c.expiration).getTime() - Date.now()) / 1000;
}

export function isUsable(c: AwsCredentials | null, minSeconds = 60): boolean {
  return !!c && secondsUntilExpiry(c) > minSeconds;
}

/**
 * Return valid credentials, refreshing silently when they are about to expire.
 * Falls back to an interactive login only when `allowInteractive` is set.
 */
export async function getCredentials(cfg: OidcConfig, allowInteractive: boolean): Promise<AwsCredentials> {
  const cached = await loadCredentials();
  if (isUsable(cached, 300)) return cached!;
  try {
    return await signIn(cfg, false);
  } catch (e) {
    if (!allowInteractive) throw e;
    return signIn(cfg, true);
  }
}

window.__ddv = { ...(window.__ddv ?? {}), assumeRoleWithWebIdentity, buildAuthUrl, loadCredentials, storeCredentials };
