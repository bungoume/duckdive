// Member-by-member gzip inflation with pako's *raw* inflater. pako's one-shot `ungzip` chains
// concatenated members itself but keeps the sliding window across the reset, which fails with
// "invalid distance too far back" on real multi-member files; walking the members ourselves
// (header, raw deflate stream, 8-byte trailer) is robust and tells how many members there are.
import { Inflate } from 'pako';

const FHCRC = 2;
const FEXTRA = 4;
const FNAME = 8;
const FCOMMENT = 16;

export interface GzipInfo {
  /** number of gzip members found */
  members: number;
  /** everything inflated, all members concatenated */
  inflated: Uint8Array;
}

/** Offset of the deflate data inside the member starting at `pos`, or -1 when the header is not gzip. */
export function gzipDataStart(buf: Uint8Array, pos: number): number {
  if (pos + 10 > buf.length || buf[pos] !== 0x1f || buf[pos + 1] !== 0x8b || buf[pos + 2] !== 8) return -1;
  const flg = buf[pos + 3];
  let p = pos + 10;
  if (flg & FEXTRA) {
    if (p + 2 > buf.length) return -1;
    p += 2 + (buf[p] | (buf[p + 1] << 8));
  }
  if (flg & FNAME) {
    while (p < buf.length && buf[p] !== 0) p++;
    p++;
  }
  if (flg & FCOMMENT) {
    while (p < buf.length && buf[p] !== 0) p++;
    p++;
  }
  if (flg & FHCRC) p += 2;
  return p <= buf.length ? p : -1;
}

/**
 * Inflate every member of `buf`. Throws when a member is damaged or when non-gzip bytes follow
 * a member (trailing garbage), so the caller leaves such a file alone.
 */
export function inflateGzipMembers(buf: Uint8Array): GzipInfo {
  const parts: Uint8Array[] = [];
  let total = 0;
  let members = 0;
  let pos = 0;
  while (pos < buf.length) {
    const start = gzipDataStart(buf, pos);
    if (start < 0) throw new Error(members ? `trailing data after member ${members} at offset ${pos}` : 'not a gzip stream');
    const inf = new Inflate({ windowBits: -15 });
    inf.push(buf.subarray(start), true);
    if (inf.err) throw new Error(`member ${members + 1}: ${inf.msg || `inflate error ${inf.err}`}`);
    const out = inf.result as Uint8Array;
    // input consumed by the raw stream: the trailer (CRC32 + ISIZE) follows it
    const consumed = (inf as unknown as { strm: { next_in: number } }).strm.next_in;
    const trailer = start + consumed;
    if (trailer + 8 > buf.length) throw new Error(`member ${members + 1}: truncated trailer`);
    const isize = (buf[trailer + 4] | (buf[trailer + 5] << 8) | (buf[trailer + 6] << 16) | (buf[trailer + 7] << 24)) >>> 0;
    if (out.length % 2 ** 32 !== isize) throw new Error(`member ${members + 1}: size mismatch (${out.length} vs ISIZE ${isize})`);
    parts.push(out);
    total += out.length;
    members++;
    pos = trailer + 8;
  }
  const inflated = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    inflated.set(p, off);
    off += p.length;
  }
  return { members, inflated };
}
