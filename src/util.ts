// Small helpers shared across modules.

/** Zero-padded decimal, `w` digits wide. */
export const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/** Lower-case hex of a byte sequence. */
export function toHex(bytes: Uint8Array | ArrayBuffer): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
