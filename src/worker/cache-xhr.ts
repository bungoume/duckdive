import { hexHead, isDataUrl, isExtensionUrl, type HeaderMap, type NativeResult } from './cache-util';
import { RequestFailed, HEAD_TIMEOUT_MS, CHUNK_TIMEOUT_MS, WHOLE_FILE_TIMEOUT_MS } from './cache-network';
import type { CacheLogEntry as LogEntry } from '../cacheProtocol';

interface CacheBackend {
  available(): boolean;
  handle(method: string, url: string, headers: HeaderMap): NativeResult;
  log(entry: Omit<LogEntry, 't'>): LogEntry;
  onFallback(): void;
}

export function createCachingXHR(NativeXHR: typeof XMLHttpRequest, origin: string, cache: CacheBackend) {
  return class CachingXHR {
    private method = 'GET';
    private url = '';
    private isAsync = true;
    private reqHeaders: HeaderMap = {};
    private native: XMLHttpRequest | null = null;
    private result: NativeResult | null = null;
    responseType: XMLHttpRequestResponseType = '';
    timeout = 0;
    withCredentials = false;
    onload: ((ev?: unknown) => void) | null = null;
    onerror: ((ev?: unknown) => void) | null = null;
    onreadystatechange: ((ev?: unknown) => void) | null = null;
    onprogress: ((ev?: unknown) => void) | null = null;
    onabort: ((ev?: unknown) => void) | null = null;
    ontimeout: ((ev?: unknown) => void) | null = null;
    onloadend: ((ev?: unknown) => void) | null = null;
    readyState = 0;

    open(method: string, url: string, async = true) {
      this.method = method.toUpperCase();
      this.url = url;
      this.isAsync = async;
      this.readyState = 1;
    }
    setRequestHeader(k: string, v: string) {
      this.reqHeaders[k.toLowerCase()] = v;
    }
    overrideMimeType(_m: string) {
      /* ignored */
    }
    abort() {
      this.native?.abort();
    }
    addEventListener(type: string, fn: (ev?: unknown) => void) {
      (this as unknown as Record<string, unknown>)['on' + type] = fn;
    }
    removeEventListener() {
      /* not needed */
    }

    private cacheable(): boolean {
      if (!cache.available() || this.isAsync) return false;
      if (!isDataUrl(this.url, origin)) return false;
      if (this.method === 'HEAD') return true;
      if (this.method === 'GET' && (this.reqHeaders['range'] || isExtensionUrl(this.url))) return true;
      return false;
    }

    /** Fill in what the caller ends up seeing (status / size / first bytes) once an answer is known. */
    private describe(entry: LogEntry) {
      entry.status = this.status;
      const r = this.native ? this.native.response : this.result?.body;
      if (r instanceof ArrayBuffer) {
        entry.bytes = r.byteLength;
        const range = this.reqHeaders['range'];
        if (this.method === 'GET' && (!range || /^bytes=0-/.test(range))) entry.head = hexHead(r);
      }
      if (this.native) {
        const enc = this.native.getResponseHeader('content-encoding');
        if (enc) entry.enc = enc;
      }
    }

    send(body: unknown) {
      if (!this.cacheable()) {
        const entry = cache.log({
          method: this.method,
          url: this.url,
          range: this.reqHeaders['range'] ?? null,
          outcome: this.isAsync ? 'async-passthrough' : 'passthrough',
        });
        this.passthrough(body, entry);
        return;
      }
      const range = this.reqHeaders['range'] ?? null;
      const entry = cache.log({ method: this.method, url: this.url, range, outcome: 'handled' });
      try {
        this.result = cache.handle(this.method, this.url, this.reqHeaders);
        this.describe(entry);
      } catch (e) {
        // A request that already waited out its deadline is not worth repeating: the second one
        // costs the same wait again with the worker, and every query behind it, blocked throughout.
        // Report it the way a plain XHR would. Any other error is a fault of the handling above,
        // and there the fallback is the point: the cache stays out of DuckDB's way.
        if (e instanceof RequestFailed) throw e.reason;
        console.warn('[ddv-cache] falling back to network', e);
        entry.outcome = `handler-error:${String(e).slice(0, 80)}`;
        cache.onFallback();
        this.passthrough(body, entry);
        return;
      }
      this.readyState = 4;
      this.onreadystatechange?.();
      this.onload?.();
      this.onloadend?.();
    }

    private passthrough(body: unknown, entry?: LogEntry) {
      const x = new NativeXHR();
      this.native = x;
      x.open(this.method, this.url, this.isAsync);
      if (this.responseType) x.responseType = this.responseType;
      // DuckDB never sets a timeout; give synchronous requests a deadline (see nativeSync)
      x.timeout =
        this.timeout ||
        (this.isAsync
          ? 0
          : this.method === 'HEAD'
            ? HEAD_TIMEOUT_MS
            : this.reqHeaders['range']
              ? CHUNK_TIMEOUT_MS
              : WHOLE_FILE_TIMEOUT_MS);
      x.withCredentials = this.withCredentials;
      for (const [k, v] of Object.entries(this.reqHeaders)) {
        try {
          x.setRequestHeader(k, v);
        } catch {
          /* ignore */
        }
      }
      if (this.isAsync) {
        x.onreadystatechange = () => {
          this.readyState = x.readyState;
          this.onreadystatechange?.();
        };
        x.onload = (ev) => this.onload?.(ev);
        x.onerror = (ev) => this.onerror?.(ev);
        x.onprogress = (ev) => this.onprogress?.(ev);
        x.onabort = (ev) => this.onabort?.(ev);
        x.ontimeout = (ev) => this.ontimeout?.(ev);
        x.onloadend = (ev) => {
          if (entry) this.describe(entry);
          this.onloadend?.(ev);
        };
      }
      x.send(body as XMLHttpRequestBodyInit | null);
      if (!this.isAsync) {
        this.readyState = 4;
        if (entry) this.describe(entry);
      }
    }

    get status(): number {
      return this.native ? this.native.status : (this.result?.status ?? 0);
    }
    get statusText(): string {
      return this.native ? this.native.statusText : (this.result?.statusText ?? '');
    }
    get response(): unknown {
      if (this.native) return this.native.response;
      if (!this.result) return null;
      if (this.responseType === 'arraybuffer') return this.result.body;
      if (this.responseType === '' || this.responseType === 'text')
        return this.result.body ? new TextDecoder().decode(this.result.body) : '';
      if (this.responseType === 'json') {
        try {
          return this.result.body ? JSON.parse(new TextDecoder().decode(this.result.body)) : null;
        } catch {
          return null;
        }
      }
      return this.result.body;
    }
    get responseText(): string {
      if (this.native) return this.native.responseText;
      return this.result?.body ? new TextDecoder().decode(this.result.body) : '';
    }
    get responseURL(): string {
      return this.native ? this.native.responseURL : this.url;
    }
    getResponseHeader(name: string): string | null {
      if (this.native) return this.native.getResponseHeader(name);
      return this.result?.headers[name.toLowerCase()] ?? null;
    }
    getAllResponseHeaders(): string {
      if (this.native) return this.native.getAllResponseHeaders();
      return this.result?.rawHeaders ?? '';
    }
  };
}
