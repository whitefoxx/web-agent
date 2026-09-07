/**
 * 页面↔LLM 桥 (H11 P1) — pure parts + the validation chain of
 * handlePageLlmCall. The chatCompletion round-trip itself is not exercised
 * (network); validation failures return BEFORE any model call, so no chrome /
 * fetch stubs are needed for them (site-script store no-ops without IDB).
 */
import { describe, it, expect } from 'vitest';
import {
  SlidingWindowLimiter,
  urlMatchesPatterns,
  handlePageLlmCall,
  extractJsonPayload,
} from '../src/background/page-llm';
import {
  buildInjectionCode,
  buildSiteScript,
  compileSiteScript,
  llmBridgePreamble,
} from '@base/site-scripts/store';

describe('SlidingWindowLimiter', () => {
  it('admits up to max within the window, then refuses', () => {
    const l = new SlidingWindowLimiter(3, 1000);
    expect(l.allow(0)).toBe(true);
    expect(l.allow(1)).toBe(true);
    expect(l.allow(2)).toBe(true);
    expect(l.allow(3)).toBe(false);
  });
  it('frees capacity once old hits fall out of the window', () => {
    const l = new SlidingWindowLimiter(2, 1000);
    expect(l.allow(0)).toBe(true);
    expect(l.allow(100)).toBe(true);
    expect(l.allow(200)).toBe(false);
    expect(l.allow(1001)).toBe(true); // t=0 expired
    expect(l.allow(1050)).toBe(false); // t=100 still in window
    expect(l.allow(1101)).toBe(true); // t=100 expired
  });
});

describe('urlMatchesPatterns', () => {
  it('matches *.host wildcards incl. the bare domain', () => {
    const pats = ['https://*.zhihu.com/*'];
    expect(urlMatchesPatterns('https://www.zhihu.com/question/1', pats)).toBe(true);
    expect(urlMatchesPatterns('https://zhihu.com/', pats)).toBe(true);
    expect(urlMatchesPatterns('https://zhihu.com.evil.io/', pats)).toBe(false);
    expect(urlMatchesPatterns('https://notzhihu.com/', pats)).toBe(false);
  });
  it('respects scheme: * = http/https only; https ≠ http', () => {
    expect(urlMatchesPatterns('http://a.com/x', ['*://a.com/*'])).toBe(true);
    expect(urlMatchesPatterns('https://a.com/x', ['*://a.com/*'])).toBe(true);
    expect(urlMatchesPatterns('ftp://a.com/x', ['*://a.com/*'])).toBe(false);
    expect(urlMatchesPatterns('http://a.com/x', ['https://a.com/*'])).toBe(false);
  });
  it('matches path wildcards', () => {
    expect(urlMatchesPatterns('https://a.com/p/1', ['https://a.com/p/*'])).toBe(true);
    expect(urlMatchesPatterns('https://a.com/q/1', ['https://a.com/p/*'])).toBe(false);
    expect(urlMatchesPatterns('https://a.com/exact', ['https://a.com/exact'])).toBe(true);
  });
  it('rejects garbage urls', () => {
    expect(urlMatchesPatterns('not a url', ['https://a.com/*'])).toBe(false);
    expect(urlMatchesPatterns('', ['https://a.com/*'])).toBe(false);
  });
});

describe('handlePageLlmCall — validation chain (fails closed, never throws)', () => {
  it('rejects an incomplete request', async () => {
    const r = await handlePageLlmCall({ type: 'PAGE_LLM_CALL' }, {});
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Incomplete request');
  });
  it('rejects an unknown script (store empty in node)', async () => {
    const r = await handlePageLlmCall(
      { type: 'PAGE_LLM_CALL', scriptId: 'sitescript_nope', prompt: 'hi' },
      { tab: { url: 'https://a.com/' } },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain('does not exist, is disabled, or lacks LLM access');
  });
});

describe('llm bridge compile (store side)', () => {
  const input = {
    matches: ['https://*.example.com/*'],
    js: 'console.log(1)',
    llmAccess: true,
  };
  it('buildSiteScript keeps llmAccess only alongside js', () => {
    const withJs = buildSiteScript(input, 's1', 1);
    expect(withJs.llmAccess).toBe(true);
    const noJs = buildSiteScript(
      { matches: input.matches, hideSelectors: ['.ad'], llmAccess: true },
      's2',
      1,
    );
    expect(noJs.llmAccess).toBeUndefined(); // no js → grant dropped
  });
  it('compileSiteScript injects the __webLLM preamble before the user js', () => {
    const s = buildSiteScript(input, 's3', 1);
    const code = compileSiteScript(s).js[0]!.code;
    expect(code).toContain('__webLLM');
    expect(code).toContain('PAGE_LLM_CALL');
    expect(code.indexOf('__webLLM')).toBeLessThan(code.indexOf('console.log(1)'));
    // no grant → no preamble
    const plain = buildSiteScript({ matches: input.matches, js: 'console.log(1)' }, 's4', 1);
    expect(compileSiteScript(plain).js[0]!.code).not.toContain('__webLLM');
  });
  it('preamble embeds the script id and stays inside the IIFE', () => {
    const pre = llmBridgePreamble('sitescript_abc');
    expect(pre).toContain('"sitescript_abc"');
    const code = buildInjectionCode('', 'x()', pre);
    expect(code.startsWith('(function(){')).toBe(true);
    expect(code.endsWith('})();')).toBe(true);
  });
  it('js-bearing scripts default to document_idle; css-only stays document_start (F-37)', () => {
    const withJs = buildSiteScript(input, 's5', 1);
    expect(withJs.runAt).toBe('document_idle');
    const cssOnly = buildSiteScript({ matches: input.matches, hideSelectors: ['.ad'] }, 's6', 1);
    expect(cssOnly.runAt).toBe('document_start');
    const explicit = buildSiteScript({ ...input, runAt: 'document_start' }, 's7', 1);
    expect(explicit.runAt).toBe('document_start');
  });
  it('js failures log to the page console instead of dying silently (F-37)', () => {
    const code = buildInjectionCode('', 'boom()');
    expect(code).toContain("console.error('[web-site-script]'");
  });
  it('preamble forwards the json flag (F-38)', () => {
    expect(llmBridgePreamble('s')).toContain('json:opts.json===true||undefined');
  });
});

describe('extractJsonPayload (F-38 — fence/prose-wrapped model JSON)', () => {
  it('passes clean JSON through', () => {
    expect(extractJsonPayload('["a","b"]')).toBe('["a","b"]');
    expect(extractJsonPayload('  {"x":1} ')).toBe('{"x":1}');
  });
  it('strips a ```json fence (the exact HN failure mode)', () => {
    expect(extractJsonPayload('```json\n["译文一","译文二"]\n```')).toBe('["译文一","译文二"]');
    expect(extractJsonPayload('```\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it('extracts a JSON block out of surrounding prose', () => {
    expect(extractJsonPayload('好的,翻译如下:["一","二"] 希望有帮助')).toBe('["一","二"]');
  });
  it('returns null when nothing parses', () => {
    expect(extractJsonPayload('抱歉,我无法完成这个任务')).toBeNull();
    expect(extractJsonPayload('')).toBeNull();
  });
});
