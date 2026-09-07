/**
 * MD5 — canonical RFC 1321 test vectors + a few extras the bilibili
 * WBI-signing path actually relies on.
 */

import { describe, it, expect } from 'vitest';
import { md5Hex } from '../src/runtime/md5';

describe('md5Hex — RFC 1321 §A.5 test vectors', () => {
  const vectors: ReadonlyArray<[string, string]> = [
    ['', 'd41d8cd98f00b204e9800998ecf8427e'],
    ['a', '0cc175b9c0f1b6a831c399e269772661'],
    ['abc', '900150983cd24fb0d6963f7d28e17f72'],
    ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
    ['abcdefghijklmnopqrstuvwxyz', 'c3fcd3d76192e4007dfb496cca67e13b'],
    [
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
      'd174ab98d277d9f5a5611c2c9f419d9f',
    ],
    [
      '12345678901234567890123456789012345678901234567890123456789012345678901234567890',
      '57edf4a22be3c955ac49da2e2107b67a',
    ],
  ];
  for (const [input, expected] of vectors) {
    it(`md5(${JSON.stringify(input.length < 30 ? input : `${input.slice(0, 20)}…(${input.length})`)}) = ${expected}`, () => {
      expect(md5Hex(input)).toBe(expected);
    });
  }
});

describe('md5Hex — UTF-8 + bilibili-WBI shape', () => {
  it('handles multibyte UTF-8 (Chinese) — must encode as UTF-8 not UTF-16', () => {
    // `printf '你好' | md5` → 7eca689f0d3389d9dea66ae112e5cfd7
    expect(md5Hex('你好')).toBe('7eca689f0d3389d9dea66ae112e5cfd7');
  });

  it('produces 32-char lowercase hex for the WBI query+mixinKey shape', () => {
    // Mimic a real-ish bilibili WBI input — sorted-querystring + 32-byte
    // mixinKey concat. Just shape-checking (length + lowercase), not the
    // value since we're not signing real Bilibili params here.
    const fakeQuery = 'aid=1&bvid=BV1xx&wts=1700000000';
    const fakeMixinKey = '0123456789abcdef0123456789abcdef';
    const h = md5Hex(fakeQuery + fakeMixinKey);
    expect(h).toMatch(/^[0-9a-f]{32}$/);
  });

  it('crosses the 56-byte padding boundary correctly (input is 55, 56, 57, 64, 65 bytes)', () => {
    // Padding bug-magnet sizes — RFC 1321 appends 0x80 + zeros so the
    // padded message length ≡ 56 (mod 64), then 8 bytes for the bit-length
    // → 64-aligned. 55/56/57/64/65 each hit a different edge of that.
    // Vectors computed via `printf '%55s' '' | tr ' ' x | md5sum`.
    expect(md5Hex('x'.repeat(55))).toBe('04364420e25c512fd958a70738aa8f72');
    expect(md5Hex('x'.repeat(56))).toBe('668a72d5ba17f08e62dabcafad6db14b');
    expect(md5Hex('x'.repeat(57))).toBe('693037871c4a9d3d8685018905cb530a');
    expect(md5Hex('x'.repeat(64))).toBe('c1bb4f81d892b2d57947682aeb252456');
    expect(md5Hex('x'.repeat(65))).toBe('1bc932052302d074bdec39795fe00cf6');
  });
});
