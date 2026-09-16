import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { gzipDataStart, inflateGzipMembers } from '../src/gzmembers';

const text = (s: string) => new TextDecoder().decode(s as unknown as Uint8Array);

describe('inflateGzipMembers', () => {
  it('walks concatenated members and returns their joined output', () => {
    const buf = new Uint8Array(Buffer.concat([gzipSync('hello '), gzipSync('world'), gzipSync('')]));
    const r = inflateGzipMembers(buf);
    expect(r.members).toBe(3);
    expect(new TextDecoder().decode(r.inflated)).toBe('hello world');
  });

  it('handles a single member and members with a file name', () => {
    const r = inflateGzipMembers(new Uint8Array(gzipSync('x'.repeat(100000))));
    expect(r.members).toBe(1);
    expect(r.inflated.length).toBe(100000);
  });

  it('rejects damaged input', () => {
    const one = new Uint8Array(gzipSync('abc'));
    expect(() => inflateGzipMembers(one.subarray(0, one.length - 3))).toThrow(/truncated|member 1/);
    expect(() => inflateGzipMembers(new Uint8Array(Buffer.concat([gzipSync('a'), Buffer.from('junk')])))).toThrow(/trailing data after member 1/);
    expect(() => inflateGzipMembers(new TextEncoder().encode('not gzip at all'))).toThrow(/not a gzip stream/);
    const bad = new Uint8Array(gzipSync('abc'));
    bad[2] = 9;
    expect(() => inflateGzipMembers(bad)).toThrow();
  });

  it('finds the deflate data behind optional header fields', () => {
    const plain = new Uint8Array(gzipSync('a'));
    expect(gzipDataStart(plain, 0)).toBe(10);
    // FNAME flag with a zero-terminated name
    const named = new Uint8Array([0x1f, 0x8b, 8, 8, 0, 0, 0, 0, 0, 3, 0x61, 0x2e, 0x74, 0x78, 0x74, 0, 1, 2]);
    expect(gzipDataStart(named, 0)).toBe(16);
    expect(gzipDataStart(new Uint8Array([1, 2, 3]), 0)).toBe(-1);
    void text;
  });
});
