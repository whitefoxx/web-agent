/**
 * opencli source-level compatibility bench.
 *
 * Proves that an UNMODIFIED opencli adapter — one that imports from
 * '@jackwener/opencli/registry', '/errors', '/utils', '/logger' — registers
 * and maps to an OpenAI tool schema through our local shims (resolved via the
 * Vitest alias in vitest.config.ts that mirrors vite.config.ts).
 *
 * The import specifiers below are opencli's public API verbatim; they only
 * resolve because of the alias wiring. So if this passes, dropping a real
 * opencli adapter into src/tools/<site>/ and letting the alias resolve its
 * imports works the same way.
 */

import { describe, it, expect } from 'vitest';

// ⬇⬇⬇ opencli public-API specifiers verbatim — resolve only via the alias.
import { cli, Strategy, getRegistry, fullName } from '@jackwener/opencli/registry';
import { AuthRequiredError, EmptyResultError, RateLimitedError } from '@jackwener/opencli/errors';
import { htmlToMarkdown, isRecord, throwIfLoginWall } from '@jackwener/opencli/utils';
import { log } from '@jackwener/opencli/logger';

import { openAiToolsFromRegistry, lookupAdapter } from '@base/tools/manifest';
import type { PageShim } from '@base/runtime/page';

describe('opencli compat: registry alias', () => {
  it('Strategy enum is byte-aligned with opencli', () => {
    expect(Strategy.PUBLIC).toBe('public');
    expect(Strategy.LOCAL).toBe('local');
    expect(Strategy.COOKIE).toBe('cookie');
    expect(Strategy.INTERCEPT).toBe('intercept');
    expect(Strategy.UI).toBe('ui');
  });

  it('registers an unmodified opencli-style adapter and maps it to a schema', () => {
    // Written exactly like clis/hackernews/top.js would be.
    cli({
      site: 'compat_hn',
      name: 'top',
      access: 'read',
      description: 'Top stories',
      domain: 'news.ycombinator.com',
      strategy: Strategy.COOKIE,
      navigateBefore: false,
      args: [{ name: 'limit', type: 'int', default: 20, help: 'How many' }],
      columns: ['rank', 'title', 'url'],
      func: async (_page: unknown, kwargs: Record<string, unknown>) => [
        { rank: 1, title: 'x', url: 'y', limit: kwargs.limit },
      ],
    });

    const def = lookupAdapter('compat_hn__top');
    expect(def).toBeTruthy();
    expect(def?.site).toBe('compat_hn');
    // opencli-only fields are stored verbatim (superset), not dropped.
    expect((def as Record<string, unknown>).strategy).toBe('cookie');
    expect((def as Record<string, unknown>).domain).toBe('news.ycombinator.com');
    expect((def as Record<string, unknown>).navigateBefore).toBe(false);

    const tools = openAiToolsFromRegistry();
    const t = tools.find((x) => x.function.name === 'compat_hn__top');
    expect(t).toBeTruthy();
    expect(t?.function.parameters.properties.limit.type).toBe('integer');
  });

  it('fullName helper matches opencli (site/name)', () => {
    expect(fullName({ site: 'a', name: 'b' })).toBe('a/b');
  });

  it('getRegistry is iterable and contains registered adapters', () => {
    cli({ site: 'compat_iter', name: 'x', access: 'read', func: async () => [] });
    const all = getRegistry();
    expect(Array.isArray(all)).toBe(true);
    expect(all.some((d: { site: string; name: string }) => d.site === 'compat_iter')).toBe(true);
  });
});

describe('opencli compat: errors alias', () => {
  it('AuthRequiredError(domain, message) keeps .domain (our adapters call this shape)', () => {
    const e = new AuthRequiredError('www.xiaohongshu.com', 'login wall');
    expect(e.name).toBe('AuthRequiredError');
    expect(e.domain).toBe('www.xiaohongshu.com');
    expect(e.message).toBe('login wall');
  });

  it('EmptyResultError keeps .source (our dispatcher reads it)', () => {
    // Project convention: (source, message). opencli adapters calling
    // (command, hint) still construct — hint just becomes the message.
    const e = new EmptyResultError('xiaohongshu/note', 'note may be deleted');
    expect(e.name).toBe('EmptyResultError');
    expect(e.source).toBe('xiaohongshu/note');
    expect(e.message).toBe('note may be deleted');
    // One-arg opencli style still gets a sensible message.
    expect(new EmptyResultError('hackernews/top').message).toBe('hackernews/top returned no data');
  });

  it('RateLimitedError(domain, redirectedUrl) keeps both fields', () => {
    const e = new RateLimitedError('xiaohongshu.com', 'https://...captcha');
    expect(e.domain).toBe('xiaohongshu.com');
    expect(e.redirectedUrl).toBe('https://...captcha');
  });
});

describe('opencli compat: utils alias', () => {
  it('htmlToMarkdown converts HTML', () => {
    expect(htmlToMarkdown('<h1>Hi</h1>')).toContain('# Hi');
  });

  it('isRecord type guard works', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
  });

  it('throwIfLoginWall passes through normal values and throws on the sentinel', () => {
    expect(throwIfLoginWall({ ok: 1 })).toEqual({ ok: 1 });
    expect(() =>
      throwIfLoginWall({
        __loginWall: true,
        status: 403,
        url: 'u',
        contentType: 'text/html',
        bodyPreview: '<html',
      }),
    ).toThrow();
  });
});

describe('opencli compat: logger alias', () => {
  it('log object has opencli surface and does not throw', () => {
    for (const k of ['info', 'warn', 'error', 'debug', 'success'] as const) {
      expect(typeof log[k]).toBe('function');
    }
    log.info('compat test', { n: 1 });
  });
});

describe('opencli compat: PageShim IPage coverage', () => {
  // High-usage IPage methods opencli adapters call across the whole clis/
  // corpus, by descending measured frequency (grep `page.<m>(` over clis/).
  // The first six cover ~95% of all calls; the rest are the named long tail.
  const REQUIRED_METHODS = [
    'evaluate', // 874
    'wait', // 553
    'goto', // 400
    'getCookies', // 58
    'pressKey', // 22
    'autoScroll', // 20
    'screenshot', // 19
    'setFileInput', // 13 (honest throw — no host FS)
    'getCurrentUrl', // 8
    'installInterceptor', // 6
    'startNetworkCapture', // 5
    'readNetworkCapture', // 5
    'nativeType', // 5
    'insertText', // 4
    'nativeClick', // 4
    'waitForCapture', // 3
    'getInterceptedRequests', // 3
    'nativeKeyPress', // 2
    'cdp', // 1
    'type', // 1 (alias)
    'waitForTimeout', // 1 (alias)
  ] as const;

  it('witness object is exactly the PageShim key set (compile-time bound)', () => {
    // Record<keyof PageShim, true> forces this literal to list EVERY PageShim
    // key and NO extras — so the witness can't silently drift from the real
    // interface. If PageShim gains/loses a method, this object stops compiling.
    const witness: Record<keyof PageShim, true> = {
      tabId: true,
      goto: true,
      evaluate: true,
      wait: true,
      autoScroll: true,
      getCookies: true,
      screenshot: true,
      captureNetwork: true,
      downloadFile: true,
      getAttachments: true,
      insertText: true,
      installInterceptor: true,
      getInterceptedRequests: true,
      pressKey: true,
      type: true,
      getCurrentUrl: true,
      nativeType: true,
      nativeClick: true,
      nativeKeyPress: true,
      setFileInput: true,
      cdp: true,
      waitForTimeout: true,
      startNetworkCapture: true,
      readNetworkCapture: true,
      waitForCapture: true,
      detach: true,
    };
    for (const m of REQUIRED_METHODS) {
      expect(witness[m as keyof PageShim], `PageShim must cover IPage.${m}`).toBe(true);
    }
  });

  it('documents the deliberately-uncovered long-tail IPage methods', () => {
    // NOT implemented by PageShim yet (each single-digit usage). Adapters that
    // call them throw a clear "not a function" rather than silently misbehave.
    // Listed so the gap is explicit and greppable:
    //   snapshot (4), click (2), evaluateWithArgs (2), tabs (3),
    //   selectTab (1), find (1), closeWindow (1)
    // Covering these (ref-based snapshot/click) needs opencli's AX/DOM snapshot
    // machinery — future work. This test is documentation, not a gate.
    expect(true).toBe(true);
  });
});
