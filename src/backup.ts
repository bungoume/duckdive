// A backup file of everything this browser keeps for Duckdive in localStorage: settings,
// language, saved searches and visualizations, recent sources, the SQL and query histories and
// the trusted-SQL list. Secrets never live in localStorage, and the handles of local files
// (IndexedDB) cannot travel in a file, so neither is part of it.

const PREFIX = 'ddv.';

export interface Backup {
  app: 'duckdive';
  version: 1;
  exportedAt: string;
  items: Record<string, string>;
}

export function makeBackup(now = new Date()): Backup {
  const items: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(PREFIX)) continue;
    const value = localStorage.getItem(key);
    if (value !== null) items[key] = value;
  }
  return { app: 'duckdive', version: 1, exportedAt: now.toISOString(), items };
}

/** The entries of a backup file; throws when the text is not one. */
export function parseBackup(text: string): Record<string, string> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('not JSON');
  }
  const b = raw as Partial<Backup> | null;
  if (!b || typeof b !== 'object' || b.app !== 'duckdive' || !b.items || typeof b.items !== 'object') throw new Error('not a Duckdive backup');
  const items: Record<string, string> = {};
  for (const [k, v] of Object.entries(b.items)) if (k.startsWith(PREFIX) && typeof v === 'string') items[k] = v;
  return items;
}

/** Write the entries (existing ones are replaced); returns how many. */
export function restoreBackup(items: Record<string, string>): number {
  let n = 0;
  for (const [k, v] of Object.entries(items)) {
    localStorage.setItem(k, v);
    n++;
  }
  return n;
}
