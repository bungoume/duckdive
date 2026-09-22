import { parseHeaders, type HeaderMap, type NativeResult } from './cache-util';

// Deadlines for the synchronous requests DuckDB's file system makes from this worker. Without
// them a stalled connection blocks the worker (and every queued query) forever. Synchronous
// XHR may set `timeout` inside a worker (only a Window forbids it); on expiry send() throws,
// which DuckDB reports as an IO error for that file.
export const HEAD_TIMEOUT_MS = 10_000;
export const CHUNK_TIMEOUT_MS = 60_000; // one 1 MB range chunk
export const WHOLE_FILE_TIMEOUT_MS = 600_000; // passthrough GET of a whole (non-range) file

/**
 * A request that did not come back: the connection failed or the deadline passed. It is kept
 * apart from the other errors of the handling because there is nothing to gain by asking again,
 * while OPFS raises DOMExceptions too and those are worth falling back to the network for.
 */
export class RequestFailed extends Error {
  constructor(readonly reason: unknown) {
    super(String(reason));
    this.name = 'RequestFailed';
  }
}

export function createNativeRequest(NativeXHR: typeof XMLHttpRequest) {
  return function nativeSync(
    method: string,
    url: string,
    headers: HeaderMap,
    wantBody: boolean,
    timeoutMs = method === 'HEAD' ? HEAD_TIMEOUT_MS : CHUNK_TIMEOUT_MS,
  ): NativeResult {
    const x = new NativeXHR();
    x.open(method, url, false);
    x.timeout = timeoutMs;
    if (wantBody) x.responseType = 'arraybuffer';
    for (const [k, v] of Object.entries(headers)) {
      try {
        x.setRequestHeader(k, v);
      } catch {
        /* forbidden header */
      }
    }
    try {
      x.send(null);
    } catch (e) {
      throw new RequestFailed(e);
    }
    const raw = x.getAllResponseHeaders();
    return {
      status: x.status,
      statusText: x.statusText,
      headers: parseHeaders(raw),
      rawHeaders: raw,
      body: wantBody ? (x.response as ArrayBuffer) : null,
    };
  };
}
