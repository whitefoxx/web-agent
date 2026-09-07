/**
 * Pure-JS MD5 (RFC 1321) for the node:crypto shim — see src/runtime/node-shim.ts.
 *
 * Why MD5 at all: bilibili WBI signing (and a handful of other legacy site
 * APIs) require MD5 hashing. SubtleCrypto deliberately excludes MD5 (it's
 * cryptographically broken), so we need a pure-JS impl for adapters that
 * insist on it. Don't use for security — only for adapter-protocol compat.
 *
 * No tables / no globals — function-local constants only, fits in one file,
 * tested against the canonical RFC 1321 test vectors.
 */

/** Compute MD5 of a UTF-8 string and return lowercase hex (32 chars). */
export function md5Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  return bytesToHex(md5Bytes(bytes));
}

function md5Bytes(bytes: Uint8Array): Uint8Array {
  const len = bytes.length;
  // Pad to a multiple of 64 bytes: append 0x80, then zeros, then 8-byte
  // little-endian bit-length. Spec says the padded message is congruent to
  // 56 (mod 64), then 8 bytes of length → 64-aligned.
  const padLen = (((len + 8) >>> 6) << 6) + 64;
  const m = new Uint8Array(padLen);
  m.set(bytes);
  m[len] = 0x80;
  // Bit length, little-endian. Hard-cap at 2^32-1 bits (512MB) — adapter
  // inputs are tiny, so the high 32 bits stay zero and we don't write them.
  const bitLen = len * 8;
  m[padLen - 8] = bitLen & 0xff;
  m[padLen - 7] = (bitLen >>> 8) & 0xff;
  m[padLen - 6] = (bitLen >>> 16) & 0xff;
  m[padLen - 5] = (bitLen >>> 24) & 0xff;

  // Per-round 32-bit constants (RFC 1321 §3.4, `T[i] = floor(2^32 * abs(sin(i+1)))`).
  const K = [
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
  ];
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
    14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];

  let a0 = 0x67452301,
    b0 = 0xefcdab89,
    c0 = 0x98badcfe,
    d0 = 0x10325476;

  const M = new Int32Array(16);
  for (let offset = 0; offset < padLen; offset += 64) {
    // Load this 64-byte block into 16 little-endian 32-bit words.
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      M[i] = m[j] | (m[j + 1] << 8) | (m[j + 2] << 16) | (m[j + 3] << 24) | 0;
    }

    let A = a0,
      B = b0,
      C = c0,
      D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) & 15;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) & 15;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) & 15;
      }
      const tmp = D;
      D = C;
      C = B;
      const sum = (A + F + K[i] + M[g]) | 0;
      const s = S[i];
      B = (B + ((sum << s) | (sum >>> (32 - s)))) | 0;
      A = tmp;
    }

    a0 = (a0 + A) | 0;
    b0 = (b0 + B) | 0;
    c0 = (c0 + C) | 0;
    d0 = (d0 + D) | 0;
  }

  // Spec output is little-endian per 32-bit word.
  const out = new Uint8Array(16);
  for (let i = 0; i < 4; i++) {
    const w = [a0, b0, c0, d0][i];
    out[i * 4] = w & 0xff;
    out[i * 4 + 1] = (w >>> 8) & 0xff;
    out[i * 4 + 2] = (w >>> 16) & 0xff;
    out[i * 4 + 3] = (w >>> 24) & 0xff;
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}
