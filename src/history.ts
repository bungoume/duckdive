/** Recent query text, newest first, shared by the search and SQL editors. */
export function loadHistory(key: string): string[] {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(list) ? list.filter((text): text is string => typeof text === 'string') : [];
  } catch {
    return [];
  }
}

export function rememberHistory(key: string, text: string, current = loadHistory(key)): string[] {
  const value = text.trim();
  if (!value) return current;
  const next = [value, ...current.filter((item) => item !== value)].slice(0, 20);
  try {
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    /* The editor can still display this session's history when storage is unavailable. */
  }
  return next;
}
