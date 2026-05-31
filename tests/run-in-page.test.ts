/**
 * Phase B in-page runner core. Tests the parts that don't need a real browser:
 * func capture (closure kept), the run/navigate-trampoline control flow, and
 * the local/RPC split of the page shim. The real DOM behaviour of
 * evaluate/wait against a live page is Chrome-only.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  evalAdapterKeepingFuncs,
  makeLocalPage,
  runAdapterInPage,
  isNavigateRestart,
  findNavigateRestart,
  fmtError,
  NavigateRestartError,
  sameLogicalPage,
  RPC_METHODS,
  NAVIGATE_RESTART,
} from '../src/userscript/run-in-page';

// A no-goto func adapter (the 75% case): scrapes via page.evaluate only.
const NO_GOTO = `import { cli, Strategy } from '@jackwener/opencli/registry';
cli({
  site: 'demo', name: 'list', access: 'read', domain: 'demo.com', strategy: Strategy.COOKIE,
  args: [{ name: 'limit', type: 'int', default: 5 }],
  func: async (page, kwargs) => {
    const rows = await page.evaluate('([1,2,3])');
    return rows.slice(0, kwargs.limit);
  },
});`;

// A goto-at-top func adapter (the 24% case): navigate then scrape.
const GOTO_TOP = `import { cli, Strategy } from '@jackwener/opencli/registry';
cli({
  site: 'demo', name: 'search', access: 'read', domain: 'demo.com', strategy: Strategy.COOKIE,
  args: [{ name: 'q', required: true, positional: true }],
  func: async (page, kwargs) => {
    await page.goto('https://demo.com/s?q=' + kwargs.q);
    await page.waitFor(10);
    return await page.evaluate('"scraped"');
  },
});`;

describe('evalAdapterKeepingFuncs', () => {
  it('captures the def WITH a callable func (unlike eval-core which drops it)', () => {
    const defs = evalAdapterKeepingFuncs(NO_GOTO);
    expect(defs).toHaveLength(1);
    expect(defs[0].site).toBe('demo');
    expect(typeof defs[0].func).toBe('function');
  });

  it('resolves Strategy + error-class references at eval time', () => {
    expect(() => evalAdapterKeepingFuncs(GOTO_TOP)).not.toThrow();
  });
});

describe('runAdapterInPage — no-goto adapter', () => {
  it('runs the func with the page and returns its result', async () => {
    const page = { evaluate: vi.fn(async (_js: string) => [1, 2, 3]) };
    const r = await runAdapterInPage({
      source: NO_GOTO,
      site: 'demo',
      name: 'list',
      kwargs: { limit: 2 },
      page,
    });
    expect(r.status).toBe('ok');
    expect(r.result).toEqual([1, 2]);
    expect(page.evaluate).toHaveBeenCalledOnce();
  });

  it('errors clearly when the command is not in the source', async () => {
    const r = await runAdapterInPage({
      source: NO_GOTO,
      site: 'demo',
      name: 'nope',
      kwargs: {},
      page: {},
    });
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/not found/);
  });
});

describe('runAdapterInPage — goto trampoline', () => {
  it('first run: goto to a new url → status navigating (func suspended)', async () => {
    const rpc = vi.fn(async () => undefined);
    const page = makeLocalPage({ rpc, env: { location: { href: 'https://demo.com/home' } } });
    const r = await runAdapterInPage({
      source: GOTO_TOP,
      site: 'demo',
      name: 'search',
      kwargs: { q: 'cats' },
      page,
    });
    expect(r.status).toBe('navigating');
    expect(r.navigateUrl).toBe('https://demo.com/s?q=cats');
    expect(rpc).toHaveBeenCalledWith(
      'goto',
      expect.objectContaining({ url: 'https://demo.com/s?q=cats' }),
    );
  });

  it('second run (already at target url): goto is a no-op → func scrapes → ok', async () => {
    // evaluate is now RPC'd (MAIN world via SW), so the scrape result comes
    // back through rpc(), not the local evalFn.
    const rpc = vi.fn(async (method: string, args: { args?: unknown[] }) => {
      if (method === 'evaluate') {
        const js = String((args.args ?? [])[0] ?? '');
        return js.includes('scraped') ? 'scraped' : undefined;
      }
      return undefined;
    });
    const page = makeLocalPage({
      rpc,
      env: { location: { href: 'https://demo.com/s?q=cats' } }, // already navigated
    });
    const r = await runAdapterInPage({
      source: GOTO_TOP,
      site: 'demo',
      name: 'search',
      kwargs: { q: 'cats' },
      page,
    });
    expect(r.status).toBe('ok');
    expect(r.result).toBe('scraped');
    expect(rpc).not.toHaveBeenCalledWith('goto', expect.anything());
  });

  // Real-site case (xiaohongshu) — server appends xsec_source/xsec_token on
  // load. With strict-equal the trampoline would re-throw NAVIGATE_RESTART
  // forever; with sameLogicalPage it sees "I'm there (modulo extras)".
  it('second run with server-appended tracking params: still treated as already-there', async () => {
    const rpc = vi.fn(async (method: string, args: { args?: unknown[] }) => {
      if (method === 'evaluate') {
        const js = String((args.args ?? [])[0] ?? '');
        return js.includes('scraped') ? 'scraped' : undefined;
      }
      return undefined;
    });
    const page = makeLocalPage({
      rpc,
      env: {
        // Asked for /s?q=cats; xhs-style added xsec_source + tracking + hash.
        location: {
          href: 'https://demo.com/s?q=cats&xsec_source=foo&xsec_token=bar#init',
        },
      },
    });
    const r = await runAdapterInPage({
      source: GOTO_TOP,
      site: 'demo',
      name: 'search',
      kwargs: { q: 'cats' },
      page,
    });
    expect(r.status).toBe('ok');
    expect(rpc).not.toHaveBeenCalledWith('goto', expect.anything());
  });
});

describe('sameLogicalPage', () => {
  it('strict equality short-circuit', () => {
    expect(sameLogicalPage('https://x.com/a?q=1', 'https://x.com/a?q=1')).toBe(true);
  });
  it('hash ignored', () => {
    expect(sameLogicalPage('https://x.com/a?q=1#section', 'https://x.com/a?q=1')).toBe(true);
  });
  it('extra params in current are tolerated', () => {
    expect(sameLogicalPage('https://x.com/a?q=1&utm=foo', 'https://x.com/a?q=1')).toBe(true);
  });
  it('missing requested param fails', () => {
    expect(sameLogicalPage('https://x.com/a?utm=foo', 'https://x.com/a?q=1')).toBe(false);
  });
  it('different pathname fails', () => {
    expect(sameLogicalPage('https://x.com/b?q=1', 'https://x.com/a?q=1')).toBe(false);
  });
  it('different origin fails', () => {
    expect(sameLogicalPage('https://y.com/a?q=1', 'https://x.com/a?q=1')).toBe(false);
  });
  it('malformed url falls back to string equality', () => {
    expect(sameLogicalPage('not-a-url', 'not-a-url')).toBe(true);
    expect(sameLogicalPage('not-a-url', 'other')).toBe(false);
  });
});

describe('makeLocalPage — local vs RPC split', () => {
  it('evaluate is RPCd to the SW so it runs in MAIN world (sees window.<global>)', async () => {
    // USER_SCRIPT and MAIN have isolated globalThis bindings — a local eval
    // wouldn't see page bootstrap globals like window.ytInitialData. The SW
    // fulfils via PageShim.evaluate → CDP Runtime.evaluate (MAIN world).
    const rpc = vi.fn(async () => 'main-world-value');
    const page = makeLocalPage({ rpc, env: { evalFn: () => 42 } });
    expect(await (page.evaluate as (j: string) => Promise<unknown>)('window.ytInitialData')).toBe(
      'main-world-value',
    );
    expect(rpc).toHaveBeenCalledWith(
      'evaluate',
      expect.objectContaining({ args: ['window.ytInitialData'] }),
    );
  });

  it('getCurrentUrl is local AND async (matches PageShim Promise<string|null> contract)', async () => {
    const page = makeLocalPage({
      rpc: async () => undefined,
      env: { location: { href: 'https://x/y' } },
    });
    const res = (page.getCurrentUrl as () => Promise<string>)();
    // Adapters do `await page.getCurrentUrl().catch(() => '')` — both `.then`
    // and `.catch` must exist (sync string had neither, hence the
    // "page.getCurrentUrl(...).catch is not a function" in zhihu/answer-detail).
    expect(typeof (res as Promise<string>).then).toBe('function');
    expect(typeof (res as Promise<string>).catch).toBe('function');
    expect(await res).toBe('https://x/y');
  });

  it('getCookies / cdp / screenshot delegate to RPC', async () => {
    const rpc = vi.fn(async (m: string) => `did:${m}`);
    const page = makeLocalPage({ rpc });
    expect(await (page.getCookies as () => Promise<unknown>)()).toBe('did:getCookies');
    expect(await (page.cdp as (m: string) => Promise<unknown>)('Page.x')).toBe('did:cdp');
    expect(await (page.screenshot as () => Promise<unknown>)()).toBe('did:screenshot');
  });

  it('RPC_METHODS lists the chrome/CDP/MAIN-world-bound methods incl. goto, evaluate', () => {
    expect(RPC_METHODS.has('goto')).toBe(true);
    expect(RPC_METHODS.has('getCookies')).toBe(true);
    expect(RPC_METHODS.has('cdp')).toBe(true);
    // evaluate is RPC'd so it runs in MAIN world via PageShim/CDP — required
    // for adapters that read window.<global> page bootstrap data.
    expect(RPC_METHODS.has('evaluate')).toBe(true);
    expect(RPC_METHODS.has('wait')).toBe(false);
  });

  it('getAttachments returns the provided files locally', () => {
    const f = { name: 'a.png' } as unknown as File;
    const page = makeLocalPage({ rpc: async () => undefined, attachments: [f] });
    expect((page.getAttachments as () => File[])()).toEqual([f]);
  });
});

describe('isNavigateRestart', () => {
  it('recognizes the tagged signal across the eval boundary', () => {
    expect(isNavigateRestart({ [NAVIGATE_RESTART]: true, url: 'x' })).toBe(true);
    expect(isNavigateRestart(new Error('nope'))).toBe(false);
    expect(isNavigateRestart(null)).toBe(false);
  });

  it('NavigateRestartError is detected as a NavigateRestart marker', () => {
    const err = new NavigateRestartError('https://x.com/a');
    expect(isNavigateRestart(err)).toBe(true);
    expect(err.url).toBe('https://x.com/a');
    // Crucially: String() must NOT be `[object Object]` — the whole point of
    // the Error subclass. An adapter that catches goto and re-throws with
    // `${err.message}` interpolation now carries readable signal.
    expect(String(err)).toMatch(/NavigateRestart/);
    expect(err.message).toContain(NAVIGATE_RESTART);
    expect(err.message).toContain('https://x.com/a');
  });
});

describe('findNavigateRestart — recovers marker even when adapter wraps it', () => {
  it('finds the marker on a directly-thrown NavigateRestartError', () => {
    expect(findNavigateRestart(new NavigateRestartError('https://x.com/a'))?.url).toBe(
      'https://x.com/a',
    );
  });

  it('walks .cause chain (modern `new Error(msg, {cause: nr})`)', () => {
    const inner = new NavigateRestartError('https://x.com/a');
    const outer = new Error('CommandExecutionError: failed', { cause: inner });
    expect(findNavigateRestart(outer)?.url).toBe('https://x.com/a');
  });

  it('extracts URL from wrapping `${err.message}` interpolation (the zhihu pattern)', () => {
    // Mirrors zhihu/answer-detail's actual wrapping shape:
    //   catch (err) { throw new CommandExecutionError(`Failed to open ... ${err.message}`) }
    const inner = new NavigateRestartError('https://www.zhihu.com/answer/123');
    const wrapped = new Error(`Failed to open Zhihu answer 123: ${inner.message}`);
    const nr = findNavigateRestart(wrapped);
    expect(nr?.url).toBe('https://www.zhihu.com/answer/123');
  });

  it('returns null for unrelated errors', () => {
    expect(findNavigateRestart(new Error('boom'))).toBeNull();
    expect(findNavigateRestart('nope')).toBeNull();
    expect(findNavigateRestart(null)).toBeNull();
    expect(findNavigateRestart({ random: 'object' })).toBeNull();
  });

  it('caps recursion on pathological self-referential .cause', () => {
    const e = new Error('a') as Error & { cause?: unknown };
    e.cause = e; // cycle
    expect(findNavigateRestart(e)).toBeNull();
  });
});

describe('runAdapterInPage — server-redirect bypass via lastNavigatedUrl', () => {
  // Zhihu redirects `/answer/<aid>` to `/question/<qid>/answer/<aid>` after the
  // SW's navigate. The new runner lands at the canonical path, sameLogicalPage
  // returns false (different pathname), and pre-fix the trampoline looped
  // until maxReinjects ("adapter exceeded 3 navigate-reinject cycles"). The
  // SW now passes the URL it just navigated to as init.lastNavigatedUrl, and
  // the trampoline treats matching goto(url) as already-done.
  it('post-reinject: goto(url) where url === lastNavigatedUrl → no-op even on path mismatch', async () => {
    const rpc = vi.fn(async (method: string, args: { args?: unknown[] }) => {
      if (method === 'evaluate') {
        const js = String((args.args ?? [])[0] ?? '');
        return js.includes('scraped') ? 'scraped' : undefined;
      }
      return undefined;
    });
    const page = makeLocalPage({
      rpc,
      // Asked for /answer/<aid>; zhihu redirected → /question/<qid>/answer/<aid>.
      env: { location: { href: 'https://www.zhihu.com/question/456/answer/123' } },
      lastNavigatedUrl: 'https://www.zhihu.com/answer/123',
    });
    const goto = page.goto as (u: string) => Promise<void>;
    await goto('https://www.zhihu.com/answer/123'); // must NOT throw, must NOT RPC
    expect(rpc).not.toHaveBeenCalledWith('goto', expect.anything());
  });

  it('consume-once: second goto with the same URL goes through the normal trampoline', async () => {
    const rpc = vi.fn(async () => undefined);
    const page = makeLocalPage({
      rpc,
      env: { location: { href: 'https://www.zhihu.com/question/456/answer/123' } },
      lastNavigatedUrl: 'https://www.zhihu.com/answer/123',
    });
    const goto = page.goto as (u: string) => Promise<void>;
    await goto('https://www.zhihu.com/answer/123'); // consumes
    await expect(goto('https://www.zhihu.com/answer/123')).rejects.toMatchObject({
      [NAVIGATE_RESTART]: true,
      url: 'https://www.zhihu.com/answer/123',
    });
    expect(rpc).toHaveBeenCalledWith('goto', expect.objectContaining({ url: expect.any(String) }));
  });

  it('mismatched goto does NOT consume the bypass', async () => {
    const rpc = vi.fn(async () => undefined);
    const page = makeLocalPage({
      rpc,
      env: { location: { href: 'https://x.com/start' } },
      lastNavigatedUrl: 'https://x.com/expected',
    });
    const goto = page.goto as (u: string) => Promise<void>;
    // First goto goes to a different URL than lastNavigatedUrl → trampoline.
    await expect(goto('https://x.com/different')).rejects.toMatchObject({
      [NAVIGATE_RESTART]: true,
      url: 'https://x.com/different',
    });
    // Subsequent goto matching lastNavigatedUrl should still bypass — we only
    // consume on a positive match, not on any goto attempt.
    await goto('https://x.com/expected'); // must not throw
  });
});

describe('runAdapterInPage — goto trampoline survives adapter try/catch wrapping', () => {
  // Mirrors zhihu/answer-detail.js: it wraps `await page.goto(...)` in a
  // try/catch and re-throws as a CommandExecutionError, interpolating
  // `${err.message}` into the wrap. Pre-fix this defeated the trampoline —
  // runner saw an unrelated error, navigate never fired, user saw
  //   `Failed to open Zhihu answer ...: [object Object]`.
  const ZHIHU_LIKE = `import { cli, Strategy } from '@jackwener/opencli/registry';
cli({
  site: 'demo', name: 'wrap', access: 'read', domain: 'demo.com', strategy: Strategy.COOKIE,
  args: [{ name: 'id', required: true, positional: true }],
  func: async (page, kwargs) => {
    try {
      await page.goto('https://demo.com/answer/' + kwargs.id);
    } catch (err) {
      throw new Error(
        'Failed to open answer ' + kwargs.id + ': ' +
          (err && err.message ? err.message : String(err))
      );
    }
    return 'scraped';
  },
});`;

  it('first run: adapter catches NavigateRestart and rewraps → runner still routes to navigating', async () => {
    const rpc = vi.fn(async () => undefined);
    const page = makeLocalPage({ rpc, env: { location: { href: 'https://demo.com/home' } } });
    const r = await runAdapterInPage({
      source: ZHIHU_LIKE,
      site: 'demo',
      name: 'wrap',
      kwargs: { id: '123' },
      page,
    });
    expect(r.status).toBe('navigating');
    expect(r.navigateUrl).toBe('https://demo.com/answer/123');
  });
});

describe('fmtError', () => {
  it('Error → name: message', () => {
    expect(fmtError(new Error('boom'))).toBe('Error: boom');
    const te = new TypeError('typed');
    expect(fmtError(te)).toBe('TypeError: typed');
  });
  it('string passes through', () => {
    expect(fmtError('plain string')).toBe('plain string');
  });
  it('plain object → JSON (not "[object Object]")', () => {
    expect(fmtError({ code: 42, msg: 'x' })).toBe('{"code":42,"msg":"x"}');
  });
  it('null / undefined stringify safely', () => {
    expect(fmtError(null)).toBe('null');
    expect(fmtError(undefined)).toBe('undefined');
  });
  it('circular object falls back to String() (avoids JSON crash)', () => {
    const o: Record<string, unknown> = { a: 1 };
    o.self = o;
    expect(fmtError(o)).toBe('[object Object]'); // last-resort String() is fine; just don't throw
  });
});
