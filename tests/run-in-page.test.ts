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
  browserProcessPolyfill,
  installProcessPolyfill,
  sanitizeFetchInit,
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

// A `browser: false` adapter (arxiv/wikipedia/hackernews-read style): pure HTTP,
// signature is `func(kwargs)` — NOT `func(page, kwargs)`. The runner must hand it
// kwargs as the FIRST arg, else it reads fields off the page object → undefined.
const BROWSERLESS = `import { cli, Strategy } from '@jackwener/opencli/registry';
cli({
  site: 'demo', name: 'http', access: 'read', browser: false, strategy: Strategy.PUBLIC,
  args: [{ name: 'q', required: true, positional: true }],
  func: async (args) => {
    if (!args || !args.q) throw new Error('q cannot be empty');
    return { got: args.q };
  },
});`;

describe('runAdapterInPage — browser:false (single-arg func) — F-4 regression', () => {
  it('passes kwargs as the FIRST arg (not the page) for browser:false adapters', async () => {
    const page = { evaluate: vi.fn() };
    const r = await runAdapterInPage({
      source: BROWSERLESS,
      site: 'demo',
      name: 'http',
      kwargs: { q: 'hello' },
      page,
    });
    expect(r.status).toBe('ok');
    expect(r.result).toEqual({ got: 'hello' });
    expect(page.evaluate).not.toHaveBeenCalled(); // no page needed
  });
});

describe('process polyfill — F-19 regression', () => {
  it('browserProcessPolyfill: no-op stderr/stdout writes + empty env', () => {
    const p = browserProcessPolyfill() as {
      env: Record<string, unknown>;
      stderr: { write: (s: string) => void };
      stdout: { write: (s: string) => void };
    };
    expect(p.env).toEqual({});
    expect(typeof p.stderr.write).toBe('function');
    expect(typeof p.stdout.write).toBe('function');
    // stray debug writes must not throw, and env reads come back undefined
    expect(() => p.stderr.write('debug line\n')).not.toThrow();
    expect(p.env.WEREAD_API_KEY).toBeUndefined();
  });

  it('installProcessPolyfill: sets process when absent, leaves an existing one intact', () => {
    const empty: { process?: unknown } = {};
    installProcessPolyfill(empty);
    expect(empty.process).toBeTruthy();
    const real = { process: { marker: 'real' } };
    installProcessPolyfill(real);
    expect((real.process as { marker: string }).marker).toBe('real');
  });

  it('browserProcessPolyfill: carries injected env', () => {
    const p = browserProcessPolyfill({ WEREAD_API_KEY: 'wrk-222' }) as {
      env: Record<string, string>;
    };
    expect(p.env).toEqual({ WEREAD_API_KEY: 'wrk-222' });
  });

  it('installProcessPolyfill: injects env, and RESETS it on a reused browser polyfill (no leak)', () => {
    const g: { process?: unknown } = {};
    installProcessPolyfill(g, { WEREAD_API_KEY: 'wrk-111' });
    expect((g.process as { env: Record<string, string> }).env).toEqual({ WEREAD_API_KEY: 'wrk-111' });
    // reused world: a prior run's secret must NOT survive into the next run
    installProcessPolyfill(g, { OTHER: 'x' });
    expect((g.process as { env: Record<string, string> }).env).toEqual({ OTHER: 'x' });
    installProcessPolyfill(g, {});
    expect((g.process as { env: Record<string, string> }).env).toEqual({});
  });

  it('installProcessPolyfill: never overwrites a real Node process.env', () => {
    const realEnv = { PATH: '/usr/bin' };
    const real = { process: { platform: 'darwin', env: realEnv } };
    installProcessPolyfill(real, { WEREAD_API_KEY: 'wrk-leak' });
    expect(real.process.env).toBe(realEnv); // untouched (platform !== 'browser')
    expect((real.process.env as Record<string, string>).WEREAD_API_KEY).toBeUndefined();
  });
});

describe('sanitizeFetchInit — strips non-cloneable fetch init (§10.35)', () => {
  // NOTE: Chrome's port.postMessage can't carry an AbortSignal across the
  // runner→SW hop (Node's structuredClone CAN, so we don't assert on it here);
  // the guarantee that matters is that the sanitized output no longer has one.
  it('drops the AbortSignal, keeps method/headers/body, and is cloneable', () => {
    const ac = new AbortController();
    const out = sanitizeFetchInit({
      method: 'POST',
      headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' },
      body: '{"a":1}',
      signal: ac.signal,
    })!;
    expect(out.signal).toBeUndefined();
    expect(out.method).toBe('POST');
    expect(out.headers).toEqual({ Authorization: 'Bearer x', 'Content-Type': 'application/json' });
    expect(out.body).toBe('{"a":1}');
    expect(() => structuredClone(out)).not.toThrow();
  });
  it('normalizes a Headers instance to a plain object', () => {
    const out = sanitizeFetchInit({ headers: new Headers({ 'x-test': '1' }) })!;
    expect(out.headers).toEqual({ 'x-test': '1' });
  });
  it('returns undefined for nullish / non-object init', () => {
    expect(sanitizeFetchInit(undefined)).toBeUndefined();
    expect(sanitizeFetchInit(null)).toBeUndefined();
    expect(sanitizeFetchInit('nope')).toBeUndefined();
  });
});

describe('runAdapterInPage — browser:false fetch proxied to SW — F-5 regression', () => {
  const FETCH_SRC = `import { cli, Strategy } from '@jackwener/opencli/registry';
cli({
  site: 'demo', name: 'api', access: 'read', browser: false, strategy: Strategy.PUBLIC,
  args: [{ name: 'q', required: true, positional: true }],
  func: async (args) => {
    const r = await fetch('https://api.example.com/s?q=' + args.q);
    if (!r.ok) throw new Error('http ' + r.status);
    return await r.json();
  },
});`;

  it("routes the func's global fetch through page.fetch (SW) and wraps a Response-like", async () => {
    const page = {
      fetch: vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        url,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ echoed: url }),
      })),
    };
    const r = await runAdapterInPage({
      source: FETCH_SRC,
      site: 'demo',
      name: 'api',
      kwargs: { q: 'cats' },
      page,
    });
    expect(r.status).toBe('ok');
    expect(page.fetch).toHaveBeenCalledWith('https://api.example.com/s?q=cats', undefined);
    expect(r.result).toEqual({ echoed: 'https://api.example.com/s?q=cats' });
  });
});

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

describe('trampoline — multi-goto ping-pong (regression for adapter-hot-plug §10.21)', () => {
  // Drives the full SW reinject loop against the in-page runner: run the func;
  // on status 'navigating', model the SW navigate by moving location.href to the
  // target (no redirect) + threading lastNavigatedUrl, then re-execute from the
  // top — exactly what runInstalledFuncAdapter does. Returns the terminal
  // outcome plus the navigation trail so a ping-pong is visible as an oscillating
  // navs[] that never settles.
  async function driveTrampoline(opts: {
    source: string;
    site: string;
    name: string;
    kwargs: Record<string, unknown>;
    startUrl: string;
    evalFor: (loc: string, js: string) => unknown;
    cap?: number;
  }): Promise<{ status: 'ok' | 'error' | 'exceeded'; result?: unknown; navs: string[] }> {
    const cap = opts.cap ?? 5;
    let href = opts.startUrl;
    let lastNavigatedUrl: string | undefined;
    const navs: string[] = [];
    const immediate = ((fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    for (let i = 0; i <= cap; i++) {
      const rpc = async (method: string, a: { args?: unknown[] }) => {
        if (method === 'evaluate') return opts.evalFor(href, String((a.args ?? [])[0] ?? ''));
        return undefined; // goto ack
      };
      const page = makeLocalPage({
        rpc,
        env: { location: { href }, setTimeout: immediate },
        lastNavigatedUrl,
      });
      const r = await runAdapterInPage({
        source: opts.source,
        site: opts.site,
        name: opts.name,
        kwargs: opts.kwargs,
        page,
      });
      if (r.status === 'navigating') {
        navs.push(r.navigateUrl as string);
        href = r.navigateUrl as string; // SW navigated the tab here
        lastNavigatedUrl = r.navigateUrl as string;
        continue;
      }
      return { status: r.status, result: r.result, navs };
    }
    return { status: 'exceeded', navs };
  }

  // Mirrors weibo/favorites' STRUCTURE: navigate home (to read a uid), then
  // navigate to a DIFFERENT-origin per-user page to scrape. Two distinct
  // sequential gotos = the ping-pong trigger.
  const UNGUARDED = `import { cli, Strategy } from '@jackwener/opencli/registry';
cli({ site:'demo', name:'fav', access:'read', domain:'demo.com', strategy: Strategy.COOKIE,
  func: async (page) => {
    await page.goto('https://home.demo.com');
    const uid = await page.evaluate('uid');
    await page.goto('https://www.demo.com/fav/' + uid);
    return await page.evaluate('rows');
  },
});`;

  // The fix: gate the pre-scrape navigation on "am I already on the final page?"
  // so the replay that lands on the fav page skips straight to the scrape.
  const GUARDED = `import { cli, Strategy } from '@jackwener/opencli/registry';
cli({ site:'demo', name:'fav', access:'read', domain:'demo.com', strategy: Strategy.COOKIE,
  func: async (page) => {
    let favUrl = await page.getCurrentUrl().catch(() => '');
    if (!/\\/fav\\/\\d+/.test(favUrl)) {
      await page.goto('https://home.demo.com');
      const uid = await page.evaluate('uid');
      favUrl = 'https://www.demo.com/fav/' + uid;
      await page.goto(favUrl);
    }
    return await page.evaluate('rows');
  },
});`;

  const evalFor = (loc: string, js: string): unknown => {
    if (js === 'uid') return '123';
    if (js === 'rows') return /\/fav\/\d+/.test(loc) ? ['r1', 'r2'] : [];
    return undefined;
  };

  it('UNGUARDED two-distinct-goto func ping-pongs until the reinject cap (the bug)', async () => {
    const out = await driveTrampoline({
      source: UNGUARDED,
      site: 'demo',
      name: 'fav',
      kwargs: {},
      startUrl: 'https://home.demo.com',
      evalFor,
      cap: 5,
    });
    expect(out.status).toBe('exceeded');
    // The trail oscillates between the two pages — never settles.
    expect(out.navs.length).toBeGreaterThan(2);
    expect(out.navs).toContain('https://www.demo.com/fav/123');
    expect(out.navs).toContain('https://home.demo.com');
  });

  it('GUARDED func converges in a single navigation and scrapes (the fix)', async () => {
    const out = await driveTrampoline({
      source: GUARDED,
      site: 'demo',
      name: 'fav',
      kwargs: {},
      startUrl: 'https://home.demo.com',
      evalFor,
      cap: 5,
    });
    expect(out.status).toBe('ok');
    expect(out.result).toEqual(['r1', 'r2']);
    // Exactly one navigation: home → fav. No bounce back.
    expect(out.navs).toEqual(['https://www.demo.com/fav/123']);
  });

  it('GUARDED func entered DIRECTLY on the final page does not navigate at all', async () => {
    const out = await driveTrampoline({
      source: GUARDED,
      site: 'demo',
      name: 'fav',
      kwargs: {},
      startUrl: 'https://www.demo.com/fav/123',
      evalFor,
      cap: 5,
    });
    expect(out.status).toBe('ok');
    expect(out.result).toEqual(['r1', 'r2']);
    expect(out.navs).toEqual([]);
  });

  // ── sessionStorage state machine (the §10.22 fix for INTERLEAVED funcs) ──
  // A func that reads page A INTO its result, then navigates to page B and reads
  // B too, cannot just skip A's read on the final replay (it would lose A's data
  // or read B's DOM for A). The fix: stash A's snapshot in the tab's
  // sessionStorage (same-origin, survives the navigation+reinject) and recover it
  // on B. This driver models that: sessionStorage persists across reinjects (same
  // origin), and page.evaluate handles setItem/getItem/removeItem.
  async function driveWithSessionStorage(opts: {
    source: string;
    startUrl: string;
    pageData: (loc: string) => Record<string, unknown>;
    cap?: number;
  }): Promise<{ status: 'ok' | 'error' | 'exceeded'; result?: unknown; navs: string[] }> {
    const cap = opts.cap ?? 6;
    let href = opts.startUrl;
    let lastNavigatedUrl: string | undefined;
    const navs: string[] = [];
    const store = new Map<string, string>(); // survives reinjects (same-origin tab)
    const immediate = ((fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    const evalFor = (loc: string, js: string): unknown => {
      let m: RegExpMatchArray | null;
      if ((m = js.match(/sessionStorage\.setItem\((["'])(.+?)\1,\s*(".*")\)/s))) {
        store.set(m[2], JSON.parse(m[3]));
        return true;
      }
      if ((m = js.match(/sessionStorage\.getItem\((["'])(.+?)\1\)/))) {
        return store.has(m[2]) ? store.get(m[2]) : null;
      }
      if ((m = js.match(/sessionStorage\.removeItem\((["'])(.+?)\1\)/))) {
        store.delete(m[2]);
        return true;
      }
      // a "scrape this page" script → return that page's data
      return opts.pageData(loc);
    };
    for (let i = 0; i <= cap; i++) {
      const rpc = async (method: string, a: { args?: unknown[] }) => {
        if (method === 'evaluate') return evalFor(href, String((a.args ?? [])[0] ?? ''));
        return undefined;
      };
      const page = makeLocalPage({
        rpc,
        env: { location: { href }, setTimeout: immediate },
        lastNavigatedUrl,
      });
      const r = await runAdapterInPage({ source: opts.source, site: 'demo', name: 'two', kwargs: {}, page });
      if (r.status === 'navigating') {
        navs.push(r.navigateUrl as string);
        href = r.navigateUrl as string;
        lastNavigatedUrl = r.navigateUrl as string;
        continue;
      }
      return { status: r.status, result: r.result, navs };
    }
    return { status: 'exceeded', navs };
  }

  // Mirrors jobs-preferences: read /a (stash), navigate to /b, read /b, merge.
  const STATE_MACHINE = `import { cli, Strategy } from '@jackwener/opencli/registry';
cli({ site:'demo', name:'two', access:'read', domain:'demo.com', strategy: Strategy.COOKIE,
  func: async (page) => {
    const KEY = '__wc_demo_two__';
    const here = await page.getCurrentUrl().catch(() => '');
    if (!/\\/b(?:\\/|\\?|#|$)/.test(here)) {
      await page.goto('https://demo.com/a');
      const a = await page.evaluate('readA');
      await page.evaluate('sessionStorage.setItem("' + KEY + '", ' + JSON.stringify(JSON.stringify(a)) + ')');
      await page.goto('https://demo.com/b');
    }
    const b = await page.evaluate('readB');
    const stashedRaw = await page.evaluate('sessionStorage.getItem("' + KEY + '")');
    await page.evaluate('sessionStorage.removeItem("' + KEY + '")');
    const a = stashedRaw ? JSON.parse(stashedRaw) : null;
    return { a, b };
  },
});`;

  it('state machine carries page-A data across the navigation via sessionStorage and merges on B', async () => {
    const out = await driveWithSessionStorage({
      source: STATE_MACHINE,
      startUrl: 'https://demo.com/a',
      pageData: (loc) => (/\/b(?:\/|\?|#|$)/.test(loc) ? { from: 'B', n: 2 } : { from: 'A', n: 1 }),
      cap: 6,
    });
    expect(out.status).toBe('ok');
    // A's snapshot survived the /a → /b navigation; both pages contributed.
    expect(out.result).toEqual({ a: { from: 'A', n: 1 }, b: { from: 'B', n: 2 } });
    expect(out.navs).toEqual(['https://demo.com/b']); // one nav, no ping-pong
  });

  it('state machine entered mid-flight on B still reconstructs (stash already present)', async () => {
    // Simulate a reinject that lands on /b with A already stashed: seed by running
    // from /a (which stashes), then the driver naturally continues on /b.
    const out = await driveWithSessionStorage({
      source: STATE_MACHINE,
      startUrl: 'https://demo.com/a',
      pageData: (loc) => (/\/b/.test(loc) ? { from: 'B', n: 2 } : { from: 'A', n: 1 }),
      cap: 6,
    });
    expect(out.status).toBe('ok');
    expect((out.result as { a: unknown }).a).toEqual({ from: 'A', n: 1 });
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
