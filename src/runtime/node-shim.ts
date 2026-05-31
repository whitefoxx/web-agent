/**
 * Browser-side polyfills for `node:*` built-ins that opencli adapters reach
 * for. See adapter-hot-plug.md §10.13.
 *
 * How it plugs in: `stripModuleSyntax` (src/sandbox/eval-core.ts) rewrites
 *
 *   import https from 'node:https';                    →
 *   const https = __nodeShim['node:https'];
 *
 *   import { createHash } from 'node:crypto';          →
 *   const { createHash } = __nodeShim['node:crypto'];
 *
 *   await import('node:crypto')                        →
 *   __nodeShim['node:crypto']     (await on a non-Promise just returns it)
 *
 * Both eval venues (sandbox capture + USER_SCRIPT-world live func) inject
 * `__nodeShim` into the scope. Adapters that NAME a node module but never
 * call into it work transparently (the destructured / aliased binding is
 * just unused). Adapters that DO call into one get a real impl (md5) or a
 * clear "not available in browser" error (fs, https) — never a silent wrong
 * answer.
 *
 * What's NOT here: anything we haven't seen a real adapter need. Add modules
 * as the corpus grows; refuse the temptation to pre-build a full polyfill.
 */

import { md5Hex } from './md5';

function notInBrowser(name: string): never {
  throw new Error(
    `${name} is not available in the browser. Adapter needs to be ported (e.g. use page.evaluate + fetch instead).`,
  );
}

/** Minimal Hash-like surface that opencli adapters use:
 *   createHash('md5').update(text).digest('hex')
 * Other algos / encodings throw with a clear hint. */
interface HashLike {
  update(data: string): HashLike;
  digest(encoding: 'hex'): string;
}

function createHash(algorithm: string): HashLike {
  if (algorithm !== 'md5') {
    notInBrowser(
      `node:crypto.createHash('${algorithm}') — only 'md5' is shimmed; use SubtleCrypto for SHA-*`,
    );
  }
  let buf = '';
  const h: HashLike = {
    update(data: string) {
      buf += data;
      return h;
    },
    digest(encoding: 'hex') {
      if (encoding !== 'hex') {
        notInBrowser(`md5.digest('${encoding}') — only 'hex' is shimmed`);
      }
      return md5Hex(buf);
    },
  };
  return h;
}

/** Map of node module specifier → shim object. Keys MUST match what
 * stripModuleSyntax's rewriter produces (i.e. include the `node:` prefix). */
export const nodeShim: Readonly<Record<string, unknown>> = Object.freeze({
  'node:crypto': { createHash },

  // No browser equivalent — file I/O isn't a thing in extension context.
  // Adapters that use these are inherently incompatible (they read local
  // files for attachment upload, etc.). The throw is the contract.
  'node:fs': {
    readFile: () => notInBrowser('node:fs.readFile'),
    readFileSync: () => notInBrowser('node:fs.readFileSync'),
    stat: () => notInBrowser('node:fs.stat'),
    writeFile: () => notInBrowser('node:fs.writeFile'),
  },
  'node:fs/promises': {
    readFile: () => notInBrowser('node:fs/promises.readFile'),
    stat: () => notInBrowser('node:fs/promises.stat'),
    writeFile: () => notInBrowser('node:fs/promises.writeFile'),
    mkdir: () => notInBrowser('node:fs/promises.mkdir'),
    rm: () => notInBrowser('node:fs/promises.rm'),
    mkdtemp: () => notInBrowser('node:fs/promises.mkdtemp'),
  },

  // bilibili/utils.js uses `https.get(url, cb)` only inside resolveBvid for
  // b23.tv short-URL redirect resolution. Adapters that don't call resolveBvid
  // (the common case — they pass a full bilibili URL or BV id) never hit
  // this. Adapters that do get a clear error pointing them to fetch.
  'node:https': {
    get: () =>
      notInBrowser(
        'node:https.get — use fetch via page.evaluate (browser handles redirects via response.url)',
      ),
    request: () => notInBrowser('node:https.request'),
  },
  'node:http': {
    get: () => notInBrowser('node:http.get'),
    request: () => notInBrowser('node:http.request'),
  },

  // Path manipulation is pure string work — provide minimal POSIX-style
  // impls so adapters that string-join paths for display work without
  // pulling in the full Node API.
  'node:path': {
    join: (...parts: string[]) => parts.filter(Boolean).join('/').replace(/\/+/g, '/'),
    basename: (p: string) => p.split('/').pop() ?? '',
    dirname: (p: string) => (p.includes('/') ? p.replace(/\/[^/]*$/, '') || '/' : '.'),
    extname: (p: string) => {
      const i = p.lastIndexOf('.');
      return i > p.lastIndexOf('/') ? p.slice(i) : '';
    },
    sep: '/',
  },

  'node:os': {
    tmpdir: () => '/tmp', // adapters that reach for this can't actually use it in-browser
    platform: () => 'browser',
  },

  // node:url exports collide with browser globals — pass them through so
  // adapters that destructure `URL`/`URLSearchParams` from it work.
  'node:url': {
    URL: globalThis.URL,
    URLSearchParams: globalThis.URLSearchParams,
  },
});
