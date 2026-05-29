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
    const rpc = vi.fn(async () => undefined);
    const page = makeLocalPage({
      rpc,
      env: {
        location: { href: 'https://demo.com/s?q=cats' }, // already navigated
        evalFn: (code: string) => (code.includes('scraped') ? 'scraped' : undefined),
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
    expect(r.result).toBe('scraped');
    expect(rpc).not.toHaveBeenCalledWith('goto', expect.anything());
  });
});

describe('makeLocalPage — local vs RPC split', () => {
  it('evaluate runs locally via the injected evalFn (no RPC)', async () => {
    const rpc = vi.fn(async () => 'rpc');
    const page = makeLocalPage({ rpc, env: { evalFn: () => 42 } });
    expect(await (page.evaluate as (j: string) => Promise<unknown>)('whatever')).toBe(42);
    expect(rpc).not.toHaveBeenCalled();
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

  it('RPC_METHODS lists the chrome/CDP-bound methods incl. goto', () => {
    expect(RPC_METHODS.has('goto')).toBe(true);
    expect(RPC_METHODS.has('getCookies')).toBe(true);
    expect(RPC_METHODS.has('cdp')).toBe(true);
    expect(RPC_METHODS.has('evaluate')).toBe(false);
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
