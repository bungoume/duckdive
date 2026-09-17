// Browser globals the modules under test touch at import time: Web Storage and location.

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value));
  }
}

/** Records pushState / replaceState calls and mirrors the hash into `location`, like a browser would. */
export const historyLog: { kind: 'push' | 'replace'; url: string }[] = [];
const history = {
  pushState: (_s: unknown, _t: string, url: string) => {
    historyLog.push({ kind: 'push', url });
    location.hash = url.slice(url.indexOf('#'));
  },
  replaceState: (_s: unknown, _t: string, url: string) => {
    historyLog.push({ kind: 'replace', url });
    location.hash = url.slice(url.indexOf('#'));
  },
};

Object.assign(globalThis, {
  localStorage: new MemoryStorage(),
  sessionStorage: new MemoryStorage(),
  location: { hash: '', origin: 'http://localhost', href: 'http://localhost/' },
  history,
});
