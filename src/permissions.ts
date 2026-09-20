// Runtime host permissions. Outside an extension everything is "granted".

import { webext } from './webext';

export const isExtension = !!webext?.runtime?.id;

/** Match pattern for the origin of a URL, e.g. "https://bucket.s3.ap-northeast-1.amazonaws.com/*". */
export function originPattern(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    return `${u.protocol}//${u.host}/*`;
  } catch {
    return null;
  }
}

/**
 * Whether an origin pattern is one of the AWS hosts the manifest requires: browsers refuse to remove
 * those, so they get no Revoke button. The host decides, not the text of the pattern
 * ("https://amazonaws.com.example/*" is somebody else's host and can be revoked).
 */
export function isAwsOrigin(pattern: string): boolean {
  const host = /^https?:\/\/([^/]+)\/\*$/.exec(pattern)?.[1] ?? '';
  return host === 'amazonaws.com' || host.endsWith('.amazonaws.com');
}

/** Whether every pattern is granted; a pattern the browser rejects counts as not granted. */
export async function hasHostPermissions(patterns: string[]): Promise<boolean> {
  if (!isExtension || !webext.permissions) return true;
  const origins = patterns.filter(Boolean);
  if (!origins.length) return true;
  try {
    return await webext.permissions.contains({ origins });
  } catch {
    return false;
  }
}

/**
 * Ask for host permissions that are not yet granted. Must be called from a user
 * gesture (button click) or the browser rejects the request.
 */
export async function ensureHostPermissions(patterns: string[]): Promise<{ ok: boolean; missing: string[] }> {
  if (!isExtension || !webext.permissions) return { ok: true, missing: [] };
  const origins = Array.from(new Set(patterns.filter(Boolean)));
  if (!origins.length) return { ok: true, missing: [] };
  const missing: string[] = [];
  for (const o of origins) if (!(await webext.permissions.contains({ origins: [o] }))) missing.push(o);
  if (!missing.length) return { ok: true, missing: [] };
  const granted = await webext.permissions.request({ origins: missing });
  return { ok: granted, missing: granted ? [] : missing };
}

export async function listGrantedOrigins(): Promise<string[]> {
  if (!isExtension || !webext.permissions) return [];
  try {
    return (await webext.permissions.getAll()).origins ?? [];
  } catch {
    return [];
  }
}

export async function removeOrigin(pattern: string): Promise<void> {
  if (!isExtension || !webext.permissions) return;
  await webext.permissions.remove({ origins: [pattern] });
}
