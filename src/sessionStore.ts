// Session-scoped storage for secrets: chrome.storage.session inside the extension (memory
// only, cleared when the browser closes), sessionStorage when the app runs as a plain page.

import { isExtension } from './permissions';

const useChrome = () => isExtension && !!chrome.storage?.session;

export async function readSession<T>(key: string): Promise<T | null> {
  try {
    if (useChrome()) {
      const r = await chrome.storage.session.get(key);
      return (r[key] as T | undefined) ?? null;
    }
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/** `null` removes the entry. */
export async function writeSession(key: string, value: unknown): Promise<void> {
  try {
    if (useChrome()) {
      if (value === null) await chrome.storage.session.remove(key);
      else await chrome.storage.session.set({ [key]: value });
      return;
    }
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore: the caller re-authenticates when nothing comes back */
  }
}
