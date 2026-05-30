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
    expect(rpc).toHaveBeenCalledWith('goto', expect.objectContaining({ url: 'https://demo.com/s?q=cats' }));
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

  it('getCurrentUrl is local', () => {
    const page = makeLocalPage({ rpc: async () => undefined, env: { location: { href: 'https://x/y' } } });
    expect((page.getCurrentUrl as () => string)()).toBe('https://x/y');
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
});
