// Session-scoped storage for secrets: storage.session inside the extension (memory
// only, cleared when the browser closes), sessionStorage when the app runs as a plain page.

import { isExtension } from './permissions';
import { webext } from './webext';

const hasExtensionSession = () => isExtension && !!webext.storage?.session;

export async function readSession<T>(key: string): Promise<T | null> {
  try {
    if (hasExtensionSession()) {
      const r = await webext.storage.session.get(key);
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
    if (hasExtensionSession()) {
      if (value === null) await webext.storage.session.remove(key);
      else await webext.storage.session.set({ [key]: value });
      return;
    }
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore: the caller re-authenticates when nothing comes back */
  }
}
