// Fetches one gzip object and, when it is made of several concatenated members, re-compresses it
// as a single member. DuckDB-Wasm's gzip reader (1.4.x / 1.5.0) stops or fails at member
// boundaries when the file is read over HTTP; a single-member copy sidesteps that entirely.
// Driven by src/gznorm.ts; the result is stored in the range cache by the page.
import { gzip } from 'pako';
import { inflateGzipMembers } from '../gzmembers';

/** A stalled download would otherwise hold the connect until the user cancels it. */
const FETCH_TIMEOUT_MS = 10 * 60_000;

interface Job {
  id: number;
  url: string;
  fetchUrl: string;
  headers: Record<string, string>;
}

function analyze(buf: Uint8Array): { gzip: boolean; multi: boolean; members: number; inflated: Uint8Array | null; error: string | null } {
  if (buf.length < 18 || buf[0] !== 0x1f || buf[1] !== 0x8b || buf[2] !== 8) return { gzip: false, multi: false, members: 0, inflated: null, error: null };
  try {
    const { members, inflated } = inflateGzipMembers(buf);
    return { gzip: true, multi: members > 1, members, inflated: members > 1 ? inflated : null, error: null };
  } catch (e) {
    // damaged member or trailing garbage: leave the object as it is (DuckDB will report it)
    return { gzip: true, multi: false, members: 0, inflated: null, error: String(e) };
  }
}

self.onmessage = async (ev: MessageEvent<Job>) => {
  const job = ev.data;
  try {
    const res = await fetch(job.fetchUrl, { headers: job.headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    const a = analyze(buf);
    let out = buf;
    if (a.multi && a.inflated) out = gzip(a.inflated, { level: 6 });
    const etag = res.headers.get('etag') ?? '';
    const bytes = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
    (self as unknown as Worker).postMessage({ id: job.id, url: job.url, bytes, repacked: a.multi, origSize: buf.byteLength, gzip: a.gzip, members: a.members, inflateError: a.error, etag }, [bytes]);
  } catch (e) {
    (self as unknown as Worker).postMessage({ id: job.id, url: job.url, error: String(e) });
  }
};
