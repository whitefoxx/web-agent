/**
 * Pipeline engine tests — the safe (no-eval) expression evaluator and the
 * executor, including the per-row fetch behaviour the real opencli adapters
 * need (verified against the actual hackernews/top + jobs pipeline shapes).
 */

import { describe, it, expect } from 'vitest';
import {
  runPipeline,
  evaluateExpr,
  validatePipeline,
  pipelineNeedsPage,
  type FetchImpl,
  type PageLike,
  type Pipeline,
} from '../src/runtime/opencli/pipeline';

/* ───────── expression evaluator (the corpus shapes) ───────── */

const ctx = (over: Record<string, unknown> = {}) => ({ args: {}, vars: {}, ...over });

describe('pipeline expr: literals & interpolation', () => {
  it('returns the raw typed value for a full ${{ }} match', () => {
    expect(evaluateExpr('${{ 1 + 2 }}', ctx())).toBe(3);
    expect(evaluateExpr('${{ index + 1 }}', ctx({ index: 4 }))).toBe(5);
  });
  it('interpolates mixed text to a string', () => {
    expect(evaluateExpr('item/${{ item.id }}.json', ctx({ row: { id: 42 } }))).toBe('item/42.json');
  });
  it('returns a non-expression literal unchanged', () => {
    expect(evaluateExpr('https://x.com/a.json', ctx())).toBe('https://x.com/a.json');
  });
});

describe('pipeline expr: member access, ternary, calls', () => {
  it('nested member with ternary guard', () => {
    expect(evaluateExpr('${{ item.thumbnail ? item.thumbnail.source : "" }}', ctx({ row: { thumbnail: { source: 'u' } } }))).toBe('u');
    expect(evaluateExpr('${{ item.thumbnail ? item.thumbnail.source : "" }}', ctx({ row: {} }))).toBe('');
  });
  it('Math.min with ternary + arithmetic (hackernews/top step 2)', () => {
    expect(evaluateExpr('${{ Math.min((args.limit ? args.limit : 20) + 10, 50) }}', ctx({ args: { limit: 20 } }))).toBe(30);
    expect(evaluateExpr('${{ Math.min((args.limit ? args.limit : 20) + 10, 50) }}', ctx({ args: { limit: 100 } }))).toBe(50);
  });
  it('Number()+toFixed and string concat (coingecko)', () => {
    expect(evaluateExpr('${{ item.price ? "$" + Number(item.price).toFixed(2) : "N/A" }}', ctx({ row: { price: 3.14159 } }))).toBe('$3.14');
    expect(evaluateExpr('${{ item.price ? "$" + Number(item.price).toFixed(2) : "N/A" }}', ctx({ row: {} }))).toBe('N/A');
  });
  it('toUpperCase + length', () => {
    expect(evaluateExpr('${{ item.symbol ? item.symbol.toUpperCase() : "" }}', ctx({ row: { symbol: 'btc' } }))).toBe('BTC');
    expect(evaluateExpr('${{ item.coins ? item.coins.length : 0 }}', ctx({ row: { coins: [1, 2, 3] } }))).toBe(3);
  });
  it('.value on a primitive returns the primitive (jobs.js compat)', () => {
    expect(evaluateExpr('${{ item.value }}', ctx({ row: 1234 }))).toBe(1234);
    expect(evaluateExpr('${{ item }}', ctx({ row: 1234 }))).toBe(1234);
  });
});

describe('pipeline expr: security', () => {
  it('blocks constructor / __proto__ / prototype access (no sandbox escape)', () => {
    expect(() => evaluateExpr('${{ item.constructor }}', ctx({ row: {} }))).toThrow();
    expect(() => evaluateExpr('${{ item.__proto__ }}', ctx({ row: {} }))).toThrow();
    expect(() => evaluateExpr('${{ ({}).constructor.constructor("return 1")() }}', ctx())).toThrow();
  });
  it('rejects unknown identifiers (no access to globals like fetch/window)', () => {
    expect(() => evaluateExpr('${{ fetch }}', ctx())).toThrow();
    expect(() => evaluateExpr('${{ globalThis }}', ctx())).toThrow();
  });
});

/* ───────── full executor with a mocked fetch ───────── */

// Mock HN-style API: topstories → [ids]; item/N → story object.
function mockHnFetch(): FetchImpl {
  return async (url: string) => {
    let body: unknown;
    if (url.includes('topstories.json') || url.includes('jobstories.json')) {
      body = [101, 102, 103, 104, 105];
    } else {
      const m = url.match(/item\/(\d+)\.json/);
      const id = m ? Number(m[1]) : 0;
      body = {
        id,
        title: id === 102 ? '' : `Story ${id}`, // 102 has no title (filtered out)
        by: `user${id}`,
        score: id,
        descendants: id - 100,
        url: `https://news/${id}`,
        deleted: id === 103, // 103 deleted (filtered out)
      };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
}

describe('pipeline executor: hackernews/top shape (per-row fetch)', () => {
  const pipeline: Pipeline = [
    { fetch: { url: 'https://hacker-news.firebaseio.com/v0/topstories.json' } },
    { limit: '${{ Math.min((args.limit ? args.limit : 20) + 10, 50) }}' },
    { map: { id: '${{ item }}' } },
    { fetch: { url: 'https://hacker-news.firebaseio.com/v0/item/${{ item.id }}.json' } },
    { filter: 'item.title && !item.deleted && !item.dead' },
    {
      map: {
        rank: '${{ index + 1 }}',
        id: '${{ item.id }}',
        title: '${{ item.title }}',
        score: '${{ item.score }}',
        author: '${{ item.by }}',
      },
    },
    { limit: '${{ args.limit }}' },
  ];

  it('fetches the list, then each item, filters and maps', async () => {
    const { rows } = await runPipeline(pipeline, { args: { limit: 2 } }, { fetchImpl: mockHnFetch() });
    // 101 ok, 102 no-title (filtered), 103 deleted (filtered), 104 ok, 105 ok
    // → [101, 104, 105], then limit 2 → [101, 104]
    expect(rows).toEqual([
      { rank: 1, id: 101, title: 'Story 101', score: 101, author: 'user101' },
      { rank: 2, id: 104, title: 'Story 104', score: 104, author: 'user104' },
    ]);
  });
});

describe('pipeline executor: hackernews/jobs shape (${{ item.value }})', () => {
  const pipeline: Pipeline = [
    { fetch: { url: 'https://hacker-news.firebaseio.com/v0/jobstories.json' } },
    { limit: '${{ args.limit }}' },
    { map: { id: '${{ item.value }}' } }, // item is the raw primitive id
    { fetch: { url: 'https://hacker-news.firebaseio.com/v0/item/${{ item.id }}.json' } },
    { filter: '${{ item.title }}' },
    { map: { id: '${{ item.id }}', company: '${{ item.by }}' } },
  ];

  it('resolves item.value to the primitive id and per-row fetches', async () => {
    const { rows } = await runPipeline(pipeline, { args: { limit: 3 } }, { fetchImpl: mockHnFetch() });
    // ids 101,102,103 → 102 no title filtered, 103 deleted still has title 'Story 103' so kept
    expect(rows).toEqual([
      { id: 101, company: 'user101' },
      { id: 103, company: 'user103' },
    ]);
  });
});

describe('pipeline: single fetch returning an array of objects', () => {
  it('uses array elements as rows directly', async () => {
    const impl: FetchImpl = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([{ n: 1 }, { n: 2 }, { n: 3 }]),
    });
    const { rows } = await runPipeline(
      [{ fetch: { url: 'https://x/list' } }, { filter: '${{ item.n > 1 }}' }, { map: { v: '${{ item.n }}' } }],
      {},
      { fetchImpl: impl },
    );
    expect(rows).toEqual([{ v: 2 }, { v: 3 }]);
  });
});

describe('validatePipeline', () => {
  it('accepts a valid pipeline and rejects unknown steps', () => {
    expect(validatePipeline([{ fetch: { url: 'x' } }, { map: {} }])).toEqual([]);
    expect(validatePipeline([{ frobnicate: {} }])[0]).toMatch(/unknown operation/);
    expect(validatePipeline('nope')[0]).toMatch(/must be an array/);
  });
  it('accepts navigate / evaluate / select (page-step extension)', () => {
    expect(
      validatePipeline([
        { navigate: 'https://x.com' },
        { evaluate: 'document.title' },
        { select: 'data.items' },
      ]),
    ).toEqual([]);
  });
});

/* ───────── select step (binance/asks shape: fetch → select → map → limit) ───────── */

describe('pipeline executor: select step', () => {
  it('picks a dot-path from the fetch payload as the new rows', async () => {
    const fakeFetch: FetchImpl = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ asks: [['1.00', '10'], ['1.01', '5']], bids: [] }),
    });
    const pipeline: Pipeline = [
      { fetch: { url: 'https://api.x/depth' } },
      { select: 'asks' },
      // Just project rank+price — `item` is each ask 2-tuple [price, qty]
      { map: { rank: '${{ index + 1 }}', price: '${{ item }}' } },
    ];
    const { rows } = await runPipeline(pipeline, { args: {} }, { fetchImpl: fakeFetch });
    expect(rows.length).toBe(2);
    expect(rows[0].rank).toBe(1);
  });

  it('returns empty rows when the path resolves to null', async () => {
    const fakeFetch: FetchImpl = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ asks: null }),
    });
    const { rows } = await runPipeline(
      [{ fetch: { url: 'x' } }, { select: 'asks' }],
      { args: {} },
      { fetchImpl: fakeFetch },
    );
    expect(rows).toEqual([]);
  });
});

/* ───────── navigate + evaluate step (zhihu/hot shape) ───────── */

describe('pipeline executor: navigate + evaluate step', () => {
  function mockPage(payload: unknown, gotoCalls: string[] = []): PageLike {
    return {
      async goto(url: string) {
        gotoCalls.push(url);
      },
      async evaluate<T = unknown>(_script: string): Promise<T> {
        return payload as T;
      },
    };
  }

  it('throws if no page is provided', async () => {
    await expect(
      runPipeline([{ navigate: 'https://x.com' }], { args: {} }),
    ).rejects.toThrow(/requires a page/);
    await expect(
      runPipeline([{ evaluate: 'document.title' }], { args: {} }),
    ).rejects.toThrow(/requires a page/);
  });

  it('runs navigate → evaluate → map → limit (zhihu/hot shape)', async () => {
    const gotoCalls: string[] = [];
    const payload = [
      { title: 'A', heat: '100', answer_count: 5, url: 'https://x/q/1' },
      { title: 'B', heat: '99', answer_count: 3, url: 'https://x/q/2' },
      { title: 'C', heat: '98', answer_count: 1, url: 'https://x/q/3' },
    ];
    const page = mockPage(payload, gotoCalls);
    const pipeline: Pipeline = [
      { navigate: 'https://www.zhihu.com' },
      { evaluate: '(async () => fetch(...))()' },
      {
        map: {
          rank: '${{ index + 1 }}',
          title: '${{ item.title }}',
          heat: '${{ item.heat }}',
          answers: '${{ item.answer_count }}',
        },
      },
      { limit: '${{ args.limit }}' },
    ];
    const { rows } = await runPipeline(pipeline, { args: { limit: 2 } }, { page });
    expect(gotoCalls).toEqual(['https://www.zhihu.com']);
    expect(rows.length).toBe(2);
    expect(rows[0]).toMatchObject({ rank: 1, title: 'A', heat: '100', answers: 5 });
  });

  it('auto-parses a JSON-looking string returned by evaluate', async () => {
    const page = mockPage('[{"x":1},{"x":2}]');
    const { rows } = await runPipeline(
      [{ evaluate: 'return jsonStr' }, { map: { v: '${{ item.x }}' } }],
      { args: {} },
      { page },
    );
    expect(rows).toEqual([{ v: 1 }, { v: 2 }]);
  });

  it('navigate object form supports waitUntil + settleMs', async () => {
    let gotOpts: unknown;
    const page: PageLike = {
      async goto(url: string, opts) {
        gotOpts = { url, ...opts };
      },
      async evaluate() {
        return [];
      },
    };
    await runPipeline(
      [{ navigate: { url: 'https://x.com', waitUntil: 'none', settleMs: 1500 } }],
      { args: {} },
      { page },
    );
    expect(gotOpts).toEqual({ url: 'https://x.com', waitUntil: 'none', settleMs: 1500 });
  });
});

/* ───────── pipelineNeedsPage predicate (dispatcher routing) ───────── */

describe('pipelineNeedsPage', () => {
  it('returns true when navigate or evaluate is present', () => {
    expect(pipelineNeedsPage([{ navigate: 'https://x' }, { map: {} }])).toBe(true);
    expect(pipelineNeedsPage([{ fetch: { url: 'x' } }, { evaluate: 'y' }])).toBe(true);
  });
  it('returns false for pure HTTP+transform pipelines', () => {
    expect(pipelineNeedsPage([{ fetch: { url: 'x' } }, { map: {} }, { limit: 5 }])).toBe(false);
    expect(pipelineNeedsPage([{ fetch: { url: 'x' } }, { select: 'data' }, { map: {} }])).toBe(false);
  });
  it('returns false for non-array input (dispatcher prefers concrete errors from validatePipeline)', () => {
    expect(pipelineNeedsPage('nope')).toBe(false);
    expect(pipelineNeedsPage(null)).toBe(false);
  });
});
