/**
 * lintSource — durability smells in synthesized adapter source (A3). Pure, node.
 * High-precision is the point: it must flag obfuscated/compiled classes but NOT
 * semantic classes or camelCase method calls.
 */

import { describe, it, expect } from 'vitest';
import { lintSource } from '../src/explore/synthesize';

const classWarn = (w: string[]) => w.filter((x) => x.includes('class'));

describe('lintSource', () => {
  it('flags obfuscated/compiled class selectors inside selector strings', () => {
    expect(classWarn(lintSource(`document.querySelector('div.YzCcne')`))[0]).toMatch(/YzCcne/);
    expect(classWarn(lintSource(`document.querySelectorAll('.tF2Cxc')`))[0]).toMatch(/tF2Cxc/);
  });

  it('does NOT flag semantic / kebab / snake / all-lower / PascalCase classes', () => {
    const w = lintSource(
      `document.querySelectorAll('.search-result .note_item .title .feed'); document.querySelector('.Button')`,
    );
    expect(classWarn(w)).toHaveLength(0);
  });

  it('does NOT flag camelCase method calls (not selectors)', () => {
    // .forEach / .innerHTML / .nodeValue would trip a naive class regex.
    const w = lintSource(
      `els.forEach(e => e.innerHTML); const v = node.nodeValue; rows.map(r => r);`,
    );
    expect(classWarn(w)).toHaveLength(0);
  });

  it('flags :nth-child data-row indexing (only inside selector strings)', () => {
    expect(lintSource(`document.querySelector('li:nth-child(3)')`).join(' ')).toMatch(/nth-child/);
  });

  it('clean API/source → no warnings', () => {
    expect(
      lintSource(`fetch('/api/v3/feed', {credentials:'include'}).then(r => r.json())`),
    ).toEqual([]);
  });
});

describe('lintSource — arg-leak (evaluate-string scope)', () => {
  const leakWarn = (w: string[]) => w.filter((x) => x.includes('ReferenceError'));

  it('flags kwargs referenced inside a page.evaluate string', () => {
    const src = `cli({ args: [{ name: 'limit', type: 'int' }], func: async (page, kwargs) => {
      return page.evaluate('rows.slice(0, kwargs.limit)');
    }});`;
    expect(leakWarn(lintSource(src)).join(' ')).toMatch(/kwargs/);
  });

  it('flags a declared arg used bare inside an evaluate string', () => {
    const src = `cli({ args: [{ name: 'limit' }], func: async (page, kwargs) => {
      const rows = await page.evaluate('Array.from(document.querySelectorAll("a")).slice(0, limit)');
      return rows.slice(0, kwargs.limit);
    }});`;
    expect(leakWarn(lintSource(src)).join(' ')).toMatch(/limit/);
  });

  it('flags the pipeline evaluate step too', () => {
    const src = `cli({ args: [{ name: 'limit' }], pipeline: [{ navigate: 'https://x' }, { evaluate: 'x.slice(0, limit)' }] });`;
    expect(leakWarn(lintSource(src)).join(' ')).toMatch(/limit/);
  });

  it('does NOT flag template-literal ${...} interpolation (func scope, fine)', () => {
    const src =
      'cli({ args: [{ name: "limit" }], func: async (page, kwargs) => page.evaluate(`rows.slice(0, ${kwargs.limit})`) });';
    expect(leakWarn(lintSource(src))).toHaveLength(0);
  });

  it('does NOT flag string concat outside the quotes (recommended pattern)', () => {
    const src = `cli({ args: [{ name: 'limit' }], func: async (page, kwargs) => {
      return page.evaluate('rows.slice(0, ' + JSON.stringify(kwargs.limit) + ')');
    }});`;
    expect(leakWarn(lintSource(src))).toHaveLength(0);
  });

  it('does NOT flag in-body declarations, property access, object/JSON keys, or URL query params', () => {
    const src = `cli({ args: [{ name: 'limit' }, { name: 'url' }], func: async (page, kwargs) => {
      return page.evaluate('const limit = 30; fetch("/api?limit=20&url=x"); items.map(i => ({ url: i.href, "url": i.u, n: i.limit })).slice(0, limit)');
    }});`;
    expect(leakWarn(lintSource(src))).toHaveLength(0);
  });
});

describe('lintSource — evaluate(fn) instead of evaluate(string) (F-18)', () => {
  const fnWarn = (w: string[]) => w.filter((x) => x.includes('silently dropped'));

  it('flags an arrow function passed to page.evaluate', () => {
    const src = `cli({ func: async (page) => page.evaluate(() => document.title) });`;
    expect(fnWarn(lintSource(src))).toHaveLength(1);
  });

  it('flags async arrow / function expression / single-param arrow', () => {
    expect(
      fnWarn(lintSource(`cli({ func: async (page) => page.evaluate(async () => 1) })`)),
    ).toHaveLength(1);
    expect(
      fnWarn(lintSource(`cli({ func: async (page) => page.evaluate(function () { return 1; }) })`)),
    ).toHaveLength(1);
    expect(fnWarn(lintSource(`cli({ func: async (page) => page.evaluate(x => x) })`))).toHaveLength(
      1,
    );
  });

  it('flags a function in a pipeline evaluate step', () => {
    const src = `cli({ pipeline: [{ navigate: 'https://x' }, { evaluate: () => [] }] });`;
    expect(fnWarn(lintSource(src))).toHaveLength(1);
  });

  it('does NOT flag the correct string / template / variable forms', () => {
    expect(
      fnWarn(lintSource(`cli({ func: async (page) => page.evaluate('document.title') })`)),
    ).toHaveLength(0);
    expect(
      fnWarn(lintSource('cli({ func: async (page) => page.evaluate(`return 1`) })')),
    ).toHaveLength(0);
    // a string variable / a call returning a string are legit sources
    expect(fnWarn(lintSource(`cli({ func: async (page) => page.evaluate(code) })`))).toHaveLength(
      0,
    );
    expect(
      fnWarn(lintSource(`cli({ func: async (page) => page.evaluate(buildCode()) })`)),
    ).toHaveLength(0);
    expect(
      fnWarn(lintSource(`cli({ pipeline: [{ evaluate: 'fetch(u).then(r=>r.json())' }] })`)),
    ).toHaveLength(0);
  });
});

describe('lintSource — arg-wiring (declared args must be read)', () => {
  const wireWarn = (w: string[]) => w.filter((x) => x.includes('never uses'));

  it('flags a declared arg the source never reads, naming the hardcoded sample value', () => {
    const src = `cli({ site: 's', name: 'n', args: [{ name: 'keyword', type: 'string', required: true }],
      pipeline: [{ fetch: { url: 'https://x.com/s?q=weather' } }] });`;
    const w = wireWarn(lintSource(src, { keyword: 'weather' }));
    expect(w.join(' ')).toMatch(/keyword/);
    expect(w.join(' ')).toMatch(/weather/);
  });

  it('kwargs.<name> and ${{ args.<name> }} both count as wired', () => {
    const funcSrc = `cli({ args: [{ name: 'q' }], func: async (page, kwargs) => fetchIt(kwargs.q) });`;
    expect(wireWarn(lintSource(funcSrc))).toHaveLength(0);
    const pipeSrc =
      "cli({ args: [{ name: 'q' }], pipeline: [{ fetch: { url: 'https://x/s?q=${{ args.q }}' } }] });";
    expect(wireWarn(lintSource(pipeSrc))).toHaveLength(0);
  });

  it('kwargs bracket access counts as wired; args without a block → no warnings', () => {
    const src = `cli({ args: [{ name: 'uid' }], func: async (page, kwargs) => go(kwargs['uid']) });`;
    expect(wireWarn(lintSource(src))).toHaveLength(0);
    expect(wireWarn(lintSource(`cli({ func: async () => [] })`))).toHaveLength(0);
  });
});

describe('lintSource — ⑦ pagination must terminate', () => {
  const pagWarn = (w: string[]) =>
    w.filter((x) => x.includes('无限翻页') || x.includes('paginate'));

  it('warns when a paginate step has no maxPages/until', () => {
    const src = `cli({ pipeline: [{ fetch: { url: 'https://x/api' } }, { paginate: { param: 'page', merge: 'items' } }] });`;
    expect(pagWarn(lintSource(src)).length).toBeGreaterThan(0);
  });

  it('does NOT warn when paginate has maxPages', () => {
    const src = `cli({ pipeline: [{ paginate: { param: 'page', maxPages: 5, merge: 'items' } }] });`;
    expect(pagWarn(lintSource(src))).toHaveLength(0);
  });

  it('does NOT warn when paginate has until', () => {
    const src = `cli({ pipeline: [{ paginate: { param: 'cursor', until: '(rows) => rows.length === 0' } }] });`;
    expect(pagWarn(lintSource(src))).toHaveLength(0);
  });

  it('no paginate step → no pagination warning', () => {
    const src = `cli({ pipeline: [{ fetch: { url: 'https://x/api' } }, { limit: 10 }] });`;
    expect(pagWarn(lintSource(src))).toHaveLength(0);
  });
});

describe('lintSource — F-32: ${{ }} inside a backtick template literal', () => {
  const templWarn = (w: string[]) => w.filter((x) => x.includes('backtick template literal'));

  it('flags ${{ args.x }} inside a backtick evaluate template (the douban bug)', () => {
    // written single-quoted so ${{ }} + backticks stay literal in this test source
    const src =
      'cli({ pipeline: [{ evaluate: `(async () => { const n = ${{ args.limit }}; return n; })()` }] });';
    expect(templWarn(lintSource(src))).toHaveLength(1);
  });

  it('does NOT flag ${{ }} inside quoted pipeline strings (the correct usage)', () => {
    const src =
      "cli({ pipeline: [{ fetch: { url: 'https://x?p=${{ args.page }}' } }, { limit: '${{ args.limit }}' }] });";
    expect(templWarn(lintSource(src))).toHaveLength(0);
  });

  it('does NOT flag a template with only normal ${x} interpolation', () => {
    const src =
      'cli({ func: async (page, kwargs) => page.evaluate(`rows.slice(0, ${kwargs.limit})`) });';
    expect(templWarn(lintSource(src))).toHaveLength(0);
  });

  it('clean template body + ${{ }} only in a later quoted step → no warn (adapter[1] shape)', () => {
    const src =
      "cli({ pipeline: [{ evaluate: `(async () => { for (let p=0;p<10;p++){} return []; })()` }, { limit: '${{ args.limit }}' }] });";
    expect(templWarn(lintSource(src))).toHaveLength(0);
  });
});

describe('lintSource — F-33: CSS-modules / styled-components hashed classes', () => {
  const q = (sel: string) => `document.querySelectorAll('${sel}')`;

  it('flags webpack CSS-modules [name]-module__[local]__[hash] (the GitHub-search case)', () => {
    expect(classWarn(lintSource(q('.Content-module__Content__mHmep')))).toHaveLength(1);
    expect(classWarn(lintSource(q('.Footer-module__footer__kjBR4')))).toHaveLength(1);
    // all-caps hash suffix (KRMAf) — the case the old mixed-case check missed
    expect(classWarn(lintSource(q('.Repositories-module__stargazersLink__KRMAf')))).toHaveLength(1);
  });

  it('flags styled-components / emotion / jss hashes', () => {
    expect(classWarn(lintSource(q('.sc-bdVaJa')))).toHaveLength(1);
    expect(classWarn(lintSource(q('.css-1a2b3c')))).toHaveLength(1);
  });

  it('does NOT flag plain BEM / kebab / snake / semantic classes', () => {
    expect(classWarn(lintSource(q('.search-result__title')))).toHaveLength(0);
    expect(classWarn(lintSource(q('.block__element')))).toHaveLength(0);
    expect(classWarn(lintSource(q('.note_item .feed-card .user-name')))).toHaveLength(0);
    expect(classWarn(lintSource(q('.header__nav-button')))).toHaveLength(0);
  });

  it('still flags the original separator-free obfuscated classes', () => {
    expect(classWarn(lintSource(q('.YzCcne')))).toHaveLength(1);
    expect(classWarn(lintSource(q('.tF2Cxc')))).toHaveLength(1);
  });
});
