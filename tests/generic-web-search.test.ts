// @vitest-environment jsdom
/**
 * extractSerp — in-page SERP → structured {rank,title,url,snippet} for the
 * generic web_search tool. Runs in-page via executeScript (self-contained, like
 * extractPageMarkdown), so it's tested here under jsdom by rendering each
 * engine's result markup. Covers: per-engine selectors, redirect-URL decoding
 * (DDG uddg, Google /url?q=), engine-host filtering, count cap, and the
 * bot-check / CAPTCHA heuristic.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach } from 'vitest';
import { extractSerp, parseEngine, buildEngine, ENGINE_ORDER } from '@base/tools/generic/web-search';
import { getRegistry } from '@base/runtime/registry.js';

beforeEach(() => {
  document.title = 'results';
  document.body.innerHTML = '';
});

describe('extractSerp — bing', () => {
  it('parses title/url/snippet from li.b_algo', () => {
    document.body.innerHTML = `
      <ol id="b_results">
        <li class="b_algo"><h2><a href="https://example.com/a">First</a></h2>
          <div class="b_caption"><p>snippet one</p></div></li>
        <li class="b_algo"><h2><a href="https://example.org/b">Second</a></h2>
          <div class="b_caption"><p>snippet two</p></div></li>
      </ol>`;
    const { results, blocked } = extractSerp('bing', 10);
    expect(blocked).toBe(false);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ rank: 1, title: 'First', url: 'https://example.com/a', snippet: 'snippet one' });
    expect(results[1].rank).toBe(2);
  });

  it('skips bing-internal links and honors count cap', () => {
    document.body.innerHTML = `
      <ol id="b_results">
        <li class="b_algo"><h2><a href="https://www.bing.com/search?q=x">internal</a></h2></li>
        <li class="b_algo"><h2><a href="https://a.com">A</a></h2></li>
        <li class="b_algo"><h2><a href="https://b.com">B</a></h2></li>
        <li class="b_algo"><h2><a href="https://c.com">C</a></h2></li>
      </ol>`;
    const { results } = extractSerp('bing', 2);
    // a.href canonicalizes bare hosts with a trailing slash (real browser behavior).
    expect(results.map((r) => r.url)).toEqual(['https://a.com/', 'https://b.com/']);
  });
});

describe('extractSerp — duckduckgo (lite)', () => {
  it('zips result-link with result-snippet and decodes uddg redirects', () => {
    // DDG lite is table-rendered; a title row then a snippet row per result.
    document.body.innerHTML = `
      <table>
        <tr><td><a class="result-link" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&rut=z">Title A</a></td></tr>
        <tr><td class="result-snippet">Snippet A</td></tr>
        <tr><td><a class="result-link" href="https://direct.example/b">Title B</a></td></tr>
        <tr><td class="result-snippet">Snippet B</td></tr>
      </table>`;
    const { results } = extractSerp('duckduckgo', 10);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ url: 'https://example.com/page', title: 'Title A', snippet: 'Snippet A' });
    expect(results[1].url).toBe('https://direct.example/b');
  });

  it('falls back to .result__a / .result__snippet (html variant)', () => {
    document.body.innerHTML = `
      <a class="result__a" href="https://x.com/1">HX</a>
      <div class="result__snippet">SX</div>`;
    const { results } = extractSerp('duckduckgo', 10);
    expect(results[0]).toMatchObject({ url: 'https://x.com/1', title: 'HX', snippet: 'SX' });
  });
});

describe('extractSerp — google', () => {
  it('extracts h3-in-anchor results with snippets, decodes /url?q=', () => {
    document.body.innerHTML = `
      <div id="search">
        <div class="g"><a href="https://www.google.com/url?q=https%3A%2F%2Freal.com%2Fp&sa=U"><h3>Real Title</h3></a>
          <div class="VwiC3b">Real snippet</div></div>
        <div class="g"><a href="https://plain.com/2"><h3>Plain</h3></a>
          <div class="VwiC3b">Plain snippet</div></div>
      </div>`;
    const { results } = extractSerp('google', 10);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ url: 'https://real.com/p', title: 'Real Title', snippet: 'Real snippet' });
    expect(results[1].url).toBe('https://plain.com/2');
  });

  it('drops google-internal links and dedups repeated urls', () => {
    document.body.innerHTML = `
      <div id="search">
        <div class="g"><a href="https://support.google.com/x"><h3>internal</h3></a></div>
        <div class="g"><a href="https://dup.com"><h3>One</h3></a></div>
        <div class="g"><a href="https://dup.com"><h3>One again</h3></a></div>
      </div>`;
    const { results } = extractSerp('google', 10);
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe('https://dup.com/');
  });
});

describe('parseEngine — explicit engine, no silent substitution', () => {
  it('cascade order is google → bing → duckduckgo', () => {
    expect(ENGINE_ORDER).toEqual(['google', 'bing', 'duckduckgo']);
  });
  it('recognizes engines + aliases', () => {
    expect(parseEngine('google')).toBe('google');
    expect(parseEngine('g')).toBe('google');
    expect(parseEngine('bing')).toBe('bing');
    expect(parseEngine('ddg')).toBe('duckduckgo');
    expect(parseEngine('DuckDuckGo')).toBe('duckduckgo');
  });
  it('"auto" is the explicit way to ask for the cascade', () => {
    expect(parseEngine('auto')).toBe('auto');
    expect(parseEngine('  AUTO ')).toBe('auto');
  });
  it('absent / blank / unsupported → null, which the tool REJECTS', () => {
    // Previously these all meant "cascade", so engine:"baidu" quietly searched
    // Google and reported success — the caller never learned its pin was ignored.
    expect(parseEngine(undefined)).toBeNull();
    expect(parseEngine('')).toBeNull();
    expect(parseEngine('yahoo')).toBeNull();
    expect(parseEngine('baidu')).toBeNull();
  });
});

describe('web_search — engine is required and validated', () => {
  const tool = (getRegistry() as { site: string; name: string; args?: { name: string; required?: boolean }[]; func: (p: unknown, k: Record<string, unknown>) => Promise<unknown> }[]).find(
    (d) => d.site === 'generic' && d.name === 'web_search',
  )!;

  it('declares engine as required with no default', () => {
    const arg = (tool.args ?? []).find((a) => a.name === 'engine')!;
    expect(arg.required).toBe(true);
    expect((arg as { default?: unknown }).default).toBeUndefined();
  });

  it('rejects an unsupported engine, naming the legal values', async () => {
    await expect(tool.func(null, { query: 'x', engine: 'baidu' })).rejects.toThrow(/not supported/);
    await expect(tool.func(null, { query: 'x', engine: 'baidu' })).rejects.toThrow(/"auto"/);
  });

  it('rejects a blank engine rather than picking one', async () => {
    await expect(tool.func(null, { query: 'x', engine: '' })).rejects.toThrow(/not supported/);
  });

  it('still rejects an empty query first', async () => {
    await expect(tool.func(null, { query: '  ', engine: 'auto' })).rejects.toThrow(/query/);
  });
});

describe('buildEngine — URLs + content-based ready selectors (F-40 fix)', () => {
  it('encodes the query and points at each engine', () => {
    expect(buildEngine('google', 'a b', 10).url).toContain('www.google.com/search?q=a%20b');
    expect(buildEngine('bing', 'a b', 10).url).toContain('www.bing.com/search?q=a%20b');
    expect(buildEngine('duckduckgo', 'a b', 10).url).toContain('lite.duckduckgo.com/lite/?q=a%20b');
  });
  it('ready selectors target a result LINK, not just the container', () => {
    // The F-40 bug was waiting on the container (li.b_algo) which streams before
    // its anchors — every ready selector must include a link/heading anchor.
    expect(buildEngine('bing', 'x', 10).ready).toBe('li.b_algo h2 a');
    expect(buildEngine('google', 'x', 10).ready).toContain('a h3');
    expect(buildEngine('duckduckgo', 'x', 10).ready).toContain('a.result-link');
  });
});

describe('extractSerp — bing regression on real cn.bing SERP (F: 0 results in China)', () => {
  // The exact #b_results subtree cn.bing.com served for "wigolo github" — the
  // DOM that returned 0 results in session s_mrn7dcjk. Proves the extractor is
  // correct against the REAL markup (the field bug was a wait-too-early timing
  // issue, not a selector bug): 9 organic results, direct external hrefs.
  const fixture = readFileSync('tests/fixtures/cnbing-serp.html', 'utf-8');

  it('extracts all 9 organic results with direct URLs + snippets', () => {
    document.body.innerHTML = fixture;
    const { results, blocked } = extractSerp('bing', 10);
    expect(blocked).toBe(false);
    expect(results).toHaveLength(9);
    expect(results[0]).toMatchObject({ rank: 1, url: 'https://github.com/KnockOutEZ/wigolo' });
    expect(results[0].title.toLowerCase()).toContain('wigolo');
    // snippets should be populated (the front-loaded CSS blob must not swallow them)
    expect(results.filter((r) => r.snippet.length > 0).length).toBeGreaterThanOrEqual(7);
    // every result is a real external link, none pointing back at bing
    expect(results.every((r) => !/bing\.com/.test(r.url))).toBe(true);
  });

  it('honors count cap on the real SERP', () => {
    document.body.innerHTML = fixture;
    expect(extractSerp('bing', 3).results).toHaveLength(3);
  });
});

describe('extractSerp — bot-check heuristic', () => {
  it('flags blocked when zero results and CAPTCHA text present', () => {
    document.title = 'Sorry...';
    document.body.innerHTML = '<p>Our systems have detected unusual traffic from your network.</p>';
    const { results, blocked, blockReason } = extractSerp('google', 10);
    expect(results).toHaveLength(0);
    expect(blocked).toBe(true);
    expect(blockReason).toContain('captcha');
  });

  it('does NOT flag blocked on a normal zero-result page', () => {
    document.body.innerHTML = '<div id="search"><p>No results found for your query.</p></div>';
    const { results, blocked } = extractSerp('google', 10);
    expect(results).toHaveLength(0);
    expect(blocked).toBe(false);
  });
});
