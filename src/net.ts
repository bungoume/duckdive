// Network helpers shared by the page-side fetches (S3 listing, STS).
//
// Every request gets a per-request deadline so a stalled connection surfaces as an error
// instead of leaving "Connecting…" on screen forever. The deadline is per request, not per
// connect: a legitimate connect over many prefixes may take longer than one request.

/** Deadline for one page-side HTTP request (ListObjectsV2 page, STS call). */
export const REQUEST_TIMEOUT_MS = 10_000;

/** How many listing requests run at once (Chrome allows 6 connections per host anyway). */
export const LIST_CONCURRENCY = 6;

export class TimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} did not answer within ${Math.round(ms / 1000)} s`);
    this.name = 'TimeoutError';
  }
}

export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancelledError';
  }
}

export function throwIfAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) throw new CancelledError();
}

/**
 * fetch() with a deadline and an optional user cancellation signal. A timeout becomes a
 * TimeoutError naming `what`; a cancellation becomes a CancelledError.
 */
export async function fetchWithTimeout(url: string, init: RequestInit, what: string, signal?: AbortSignal | null, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  throwIfAborted(signal);
  const timer = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timer]) : timer;
  try {
    return await fetch(url, { ...init, signal: combined });
  } catch (e) {
    if (signal?.aborted) throw new CancelledError();
    if (timer.aborted) throw new TimeoutError(what, timeoutMs);
    throw e;
  }
}

/** map() with at most `limit` calls in flight; results keep the input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  let failed: unknown = null;
  const worker = async () => {
    while (next < items.length && failed === null) {
      const i = next++;
      try {
        out[i] = await fn(items[i], i);
      } catch (e) {
        failed = e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failed !== null) throw failed;
  return out;
}
