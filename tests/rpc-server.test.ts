/**
 * page.* RPC server: maps run-in-page's RPC calls onto a real PageShim. Tested
 * with a fake shim so the method/arg mapping is verified without a browser.
 */

import { describe, it, expect, vi } from 'vitest';
import { fulfillRpc, SERVER_METHODS, type PageLike } from '../src/userscript/rpc-server';
import { RPC_METHODS } from '../src/userscript/run-in-page';

describe('fulfillRpc — method/arg mapping', () => {
  it('goto takes {url} and calls page.goto(url)', async () => {
    const page: PageLike = { goto: vi.fn(async () => undefined) };
    const r = await fulfillRpc(page, { method: 'goto', url: 'https://x/y', tabId: 7 });
    expect(r.ok).toBe(true);
    expect(page.goto).toHaveBeenCalledWith('https://x/y');
  });

  it('getCookies takes no args and returns the value', async () => {
    const page: PageLike = { getCookies: vi.fn(async () => [{ name: 'a' }]) };
    const r = await fulfillRpc(page, { method: 'getCookies', args: [], tabId: 1 });
    expect(r.ok).toBe(true);
    expect(r.value).toEqual([{ name: 'a' }]);
  });

  it('evaluate spreads (jsString) → page.evaluate(js) and returns the value', async () => {
    // Routed through CDP MAIN world; adapter sees window.<global>.
    const page: PageLike = { evaluate: vi.fn(async () => ({ ytInitialData: true })) };
    const r = await fulfillRpc(page, { method: 'evaluate', args: ['window.ytInitialData'], tabId: 3 });
    expect(r.ok).toBe(true);
    expect(page.evaluate).toHaveBeenCalledWith('window.ytInitialData');
    expect(r.value).toEqual({ ytInitialData: true });
  });

  it('cdp spreads the args array → page.cdp(method, params)', async () => {
    const page: PageLike = { cdp: vi.fn(async () => ({ ok: 1 })) };
    const r = await fulfillRpc(page, { method: 'cdp', args: ['Page.navigate', { url: 'u' }] });
    expect(r.ok).toBe(true);
    expect(page.cdp).toHaveBeenCalledWith('Page.navigate', { url: 'u' });
  });

  it('nativeClick spreads (x, y)', async () => {
    const page: PageLike = { nativeClick: vi.fn(async () => undefined) };
    await fulfillRpc(page, { method: 'nativeClick', args: [10, 20] });
    expect(page.nativeClick).toHaveBeenCalledWith(10, 20);
  });
});

describe('fulfillRpc — error handling', () => {
  it('rejects an unsupported method', async () => {
    const r = await fulfillRpc({}, { method: 'wait', args: [] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unsupported/);
  });

  it('reports when the shim lacks the method in this context', async () => {
    const r = await fulfillRpc({}, { method: 'screenshot', args: [] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/does not implement/);
  });

  it('catches a throwing shim method and returns ok:false', async () => {
    const page: PageLike = {
      goto: vi.fn(async () => {
        throw new Error('nav failed');
      }),
    };
    const r = await fulfillRpc(page, { method: 'goto', url: 'u' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/nav failed/);
  });
});

describe('caller/server method sets agree', () => {
  it('every server method is an RPC method on the caller side', () => {
    for (const m of SERVER_METHODS) {
      expect(RPC_METHODS.has(m), `caller RPC_METHODS missing ${m}`).toBe(true);
    }
  });
  it('every caller RPC method is fulfillable by the server', () => {
    for (const m of RPC_METHODS) {
      expect(SERVER_METHODS.has(m), `server SERVER_METHODS missing ${m}`).toBe(true);
    }
  });
});
