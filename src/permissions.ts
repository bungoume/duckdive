// Runtime host permissions (chrome.permissions). Outside an extension everything is "granted".

export const isExtension = typeof chrome !== 'undefined' && !!chrome.runtime?.id;

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

export async function hasHostPermissions(patterns: string[]): Promise<boolean> {
  if (!isExtension || !chrome.permissions) return true;
  const origins = patterns.filter(Boolean);
  if (!origins.length) return true;
  return chrome.permissions.contains({ origins });
}

/**
 * Ask for host permissions that are not yet granted. Must be called from a user
 * gesture (button click) or Chrome rejects the request silently.
 */
export async function ensureHostPermissions(patterns: string[]): Promise<{ ok: boolean; missing: string[] }> {
  if (!isExtension || !chrome.permissions) return { ok: true, missing: [] };
  const origins = Array.from(new Set(patterns.filter(Boolean)));
  if (!origins.length) return { ok: true, missing: [] };
  const missing: string[] = [];
  for (const o of origins) if (!(await chrome.permissions.contains({ origins: [o] }))) missing.push(o);
  if (!missing.length) return { ok: true, missing: [] };
  const granted = await chrome.permissions.request({ origins: missing });
  return { ok: granted, missing: granted ? [] : missing };
}

export async function listGrantedOrigins(): Promise<string[]> {
  if (!isExtension || !chrome.permissions) return [];
  const all = await chrome.permissions.getAll();
  return all.origins ?? [];
}

export async function removeOrigin(pattern: string): Promise<void> {
  if (!isExtension || !chrome.permissions) return;
  await chrome.permissions.remove({ origins: [pattern] });
}
