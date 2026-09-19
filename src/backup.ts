// A backup file of everything this browser keeps for Duckdive in localStorage: settings,
// language, saved searches and visualizations, recent sources, the SQL and query histories and
// the trusted-SQL list. Secrets never live in localStorage, and the handles of local files
// (IndexedDB) cannot travel in a file, so neither is part of it.

import { checkedSourceHistory, checkedSourceItem } from './sources';

const PREFIX = 'ddv.';

/**
 * The list of custom SQL this browser has reviewed never travels in a backup. A backup file
 * arrives the same way a link does, and a WHERE clause runs verbatim inside DuckDB where it can
 * read the S3 credentials, so a file must not be able to decide on its reader's behalf that some
 * SQL is safe here. Custom SQL filters in restored searches and visualizations come back
 * disabled and marked, the way they do from a link.
 */
const NEVER_IN_A_BACKUP = new Set(['ddv.trustedSql']);

/**
 * Entries a backup file does not get to write verbatim. A data source carries the endpoints the
 * sign-in sends this browser's id_token to, and loadSource / loadSourceHistory only fill in
 * defaults, so those two go through the check a shared link's source goes through (src/sources.ts).
 */
const CHECKED_ON_RESTORE: Record<string, (raw: unknown) => unknown> = {
  'ddv.source': checkedSourceItem,
  'ddv.sources': checkedSourceHistory,
};

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
    if (!key || !key.startsWith(PREFIX) || NEVER_IN_A_BACKUP.has(key)) continue;
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
  for (const [k, v] of Object.entries(b.items)) {
    if (!k.startsWith(PREFIX) || NEVER_IN_A_BACKUP.has(k) || typeof v !== 'string') continue;
    const check = CHECKED_ON_RESTORE[k];
    if (!check) {
      items[k] = v;
      continue;
    }
    try {
      items[k] = JSON.stringify(check(JSON.parse(v)));
    } catch {
      /* not JSON: its reader would fall back to the defaults anyway, so leave it out */
    }
  }
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
