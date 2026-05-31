/**
 * node:* shim — verifies stripModuleSyntax's rewriter produces something the
 * nodeShim map can answer, end-to-end.
 *
 * The high-level claim under test: bilibili/utils.js-shaped sources
 *   import https from 'node:https';
 *   import { foo } from '@jackwener/opencli/errors';
 *   const { createHash } = await import('node:crypto');
 *   const sig = createHash('md5').update('hi').digest('hex');
 * evaluate cleanly in our injected scope; calling unsupported node APIs
 * (fs/https/non-md5 crypto) throws a recognisable error rather than a
 * mysterious ReferenceError.
 */

import { describe, it, expect } from 'vitest';
import { stripModuleSyntax } from '../src/sandbox/eval-core';
import { nodeShim } from '../src/runtime/node-shim';
import { md5Hex } from '../src/runtime/md5';

describe('stripModuleSyntax — node:* rewriting', () => {
  it('rewrites default import to __nodeShim lookup (preserves binding name + indent)', () => {
    const out = stripModuleSyntax(`  import https from 'node:https';\nconsole.log(https);`);
    expect(out).toContain(`  const https = __nodeShim['node:https'];`);
    expect(out).toContain('console.log(https);');
    expect(out).not.toContain(`import https from 'node:https'`);
  });

  it('rewrites named import to __nodeShim destructure (single name)', () => {
    const out = stripModuleSyntax(`import { createHash } from 'node:crypto';`);
    expect(out.trim()).toBe(`const { createHash } = __nodeShim['node:crypto'];`);
  });

  it('rewrites named import to __nodeShim destructure (multiple names)', () => {
    const out = stripModuleSyntax(`import { readFile, stat, writeFile } from 'node:fs/promises';`);
    expect(out.trim()).toBe(
      `const { readFile, stat, writeFile } = __nodeShim['node:fs/promises'];`,
    );
  });

  it('rewrites dynamic import() to __nodeShim lookup (await still works)', () => {
    const out = stripModuleSyntax(`const { createHash } = await import('node:crypto');`);
    expect(out.trim()).toBe(`const { createHash } = await __nodeShim['node:crypto'];`);
  });

  it('accepts both single and double quotes', () => {
    const a = stripModuleSyntax(`import x from "node:crypto";`);
    const b = stripModuleSyntax(`import x from 'node:crypto';`);
    expect(a.trim()).toBe(`const x = __nodeShim['node:crypto'];`);
    expect(b.trim()).toBe(`const x = __nodeShim['node:crypto'];`);
  });

  it('leaves non-node imports to the existing strip-everything pass', () => {
    // Regular package imports still get DROPPED (symbols come from the
    // injected scope, not the actual package). Only node:* gets rewritten.
    const out = stripModuleSyntax(`import { cli } from '@jackwener/opencli/registry';\nfoo();`);
    expect(out).not.toContain('cli');
    expect(out).toContain('foo();');
  });
});

describe('nodeShim — shape matches stripModuleSyntax rewrites', () => {
  // The rewriter produces `__nodeShim['node:crypto']` etc. — these MUST exist
  // as truthy objects, otherwise `const { createHash } = __nodeShim['node:crypto']`
  // throws "Cannot destructure property 'createHash' of 'undefined'" even when
  // the adapter never CALLS createHash. (Static destructuring is a load-time
  // op; module-top-level imports evaluate immediately.)
  const SHIMMED_MODULES = [
    'node:crypto',
    'node:fs',
    'node:fs/promises',
    'node:https',
    'node:http',
    'node:path',
    'node:os',
    'node:url',
  ];

  for (const mod of SHIMMED_MODULES) {
    it(`provides a truthy object for ${mod}`, () => {
      const v = nodeShim[mod];
      expect(v).toBeDefined();
      expect(typeof v).toBe('object');
    });
  }
});

describe('nodeShim — node:crypto.createHash(md5)', () => {
  it('produces correct md5 hex matching the standalone md5Hex impl', () => {
    const crypto = nodeShim['node:crypto'] as {
      createHash: (algo: string) => { update(s: string): unknown; digest(enc: string): string };
    };
    const h = crypto.createHash('md5');
    const got = h.update('abc').digest('hex');
    expect(got).toBe(md5Hex('abc'));
    expect(got).toBe('900150983cd24fb0d6963f7d28e17f72');
  });

  it('supports the bilibili WBI pattern: update once then digest', () => {
    const crypto = nodeShim['node:crypto'] as {
      createHash: (algo: string) => { update(s: string): unknown; digest(enc: string): string };
    };
    const query = 'aid=1&bvid=BV1&wts=170';
    const mixin = '0123456789abcdef0123456789abcdef';
    const got = crypto
      .createHash('md5')
      .update(query + mixin)
      .digest('hex');
    expect(got).toBe(md5Hex(query + mixin));
  });

  it('throws a clear error for unsupported algorithms (sha256)', () => {
    const crypto = nodeShim['node:crypto'] as { createHash: (algo: string) => unknown };
    expect(() => crypto.createHash('sha256')).toThrow(/sha256.*not.*shimmed|SubtleCrypto/i);
  });

  it('throws a clear error for unsupported digest encoding', () => {
    const crypto = nodeShim['node:crypto'] as {
      createHash: (algo: string) => { update(s: string): unknown; digest(enc: string): string };
    };
    const h = crypto.createHash('md5');
    h.update('x');
    expect(() => h.digest('base64')).toThrow(/base64.*not.*shimmed|hex/i);
  });
});

describe('nodeShim — fs / https stub-throws', () => {
  it('node:fs/promises.readFile throws not-in-browser', () => {
    const fs = nodeShim['node:fs/promises'] as { readFile: () => void };
    expect(() => fs.readFile()).toThrow(/not available in the browser/);
  });

  it('node:https.get throws and points to fetch alternative', () => {
    const https = nodeShim['node:https'] as { get: () => void };
    expect(() => https.get()).toThrow(/fetch/);
  });
});

describe('end-to-end: stripModuleSyntax + nodeShim → adapter top-level works', () => {
  it('a bilibili-utils.js-shaped source evaluates and md5 produces correct output', async () => {
    const src = `
import https from 'node:https';
const { createHash } = await import('node:crypto');
export function sign(s) {
  return createHash('md5').update(s).digest('hex');
}
__captured.sign = sign;
__captured.hasHttps = typeof https;
`;
    const body = stripModuleSyntax(src);
    // body should contain:
    //   const https = __nodeShim['node:https'];
    //   const { createHash } = await __nodeShim['node:crypto'];
    //   function sign(s) { ... }  (export stripped)
    expect(body).toContain("const https = __nodeShim['node:https'];");
    expect(body).toContain("const { createHash } = await __nodeShim['node:crypto'];");
    expect(body).toContain('function sign(s)'); // export stripped

    // Run it through new Function with __nodeShim + a captured-result slot.
    // Need an async wrapper because of `await import(...)`.
    const slot: { sign?: (s: string) => string; hasHttps?: string } = {};
    const fn = new Function('__nodeShim', '__captured', `return (async () => { ${body} })();`);
    await fn(nodeShim, slot);
    expect(slot.hasHttps).toBe('object'); // shim returned an object
    expect(slot.sign?.('hello')).toBe(md5Hex('hello'));
  });
});
