// Custom SQL filters travel inside shareable URLs, and a WHERE clause can read DuckDB settings
// (the S3 credentials) and reach the network through httpfs. SQL that was typed in this browser
// is remembered here; SQL arriving from anywhere else (a link someone sent) is restored disabled
// and marked untrusted until the user has looked at it (src/state.ts, FilterBar).

const LS_TRUSTED = 'ddv.trustedSql';
const MAX = 200;

function load(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(LS_TRUSTED) ?? '[]');
    return Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

function store(list: string[]) {
  try {
    localStorage.setItem(LS_TRUSTED, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

export function isTrustedSql(sql: string): boolean {
  return load().includes(sql);
}

/** Remember `sql` as written or reviewed in this browser (most recent first, bounded). */
export function trustSql(sql: string): void {
  store([sql, ...load().filter((s) => s !== sql)].slice(0, MAX));
}
