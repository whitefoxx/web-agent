/**
 * Port of opencli's clis/douyin/delete.test.js.
 *
 * Seams:
 *   - The big DOM-walking `page.evaluate` (creator-manage delete) whose first
 *     fetch is the RELATIVE work_list URL routes to page.directEvaluate in the
 *     fake page — so we set page.directEvaluate to opencli's `evaluateResult`.
 *   - The fallback path's absolute creator.douyin.com fetches (work_list GET +
 *     delete POST) route to page.browserFetch — so we install opencli's
 *     routing mockImplementation on page.browserFetch (the inlined browserFetch
 *     forwards its resolved value through validation untouched for status_code
 *     0 / well-formed objects).
 *
 * Fake timers as in opencli: the adapter sleeps 2x3s before the DOM evaluate
 * and 500ms per fallback poll; advanceTimersByTimeAsync drives them.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findAdapter } from '@base/runtime/registry.js';
import { ArgumentError, CommandExecutionError } from '@base/runtime/errors.js';
import { makeFakeDouyinPage, type FakeDouyinPage } from '../_helpers/douyin-page.js';

import '../../../marketplace/douyin/delete.js';

const MARKETPLACE_DELETE = new URL(
  '../../../marketplace/douyin/delete.js',
  import.meta.url,
);

function makePage({
  evaluateResult,
  listBefore = [],
  listAfter = [],
}: {
  evaluateResult?: unknown;
  listBefore?: unknown[];
  listAfter?: unknown[];
} = {}): FakeDouyinPage {
  const page = makeFakeDouyinPage();
  let listCalls = 0;
  page.browserFetch.mockImplementation(async (_p, method: string, url: string) => {
    if (method === 'GET' && String(url).includes('/work_list?')) {
      listCalls += 1;
      return { aweme_list: listCalls === 1 ? listBefore : listAfter };
    }
    return { status_code: 0 };
  });
  page.directEvaluate.mockResolvedValue(evaluateResult ?? { ok: false, reason: 'not_found' });
  return page;
}

describe('douyin/delete (marketplace)', () => {
  const command = findAdapter('douyin', 'delete');

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers the delete command', () => {
    expect(command).toBeDefined();
  });

  it('uses work_list id/index matching instead of title matching for fallback deletion', () => {
    const source = readFileSync(MARKETPLACE_DELETE, 'utf8');
    expect(source).toContain('target_not_unique');
    expect(source).toContain("String(entry.aweme_id || '') === targetId");
    expect(source).toContain('cards[target.index]');
    expect(source).not.toContain('text.includes(target.title)');
  });

  it('validates aweme_id before navigation', async () => {
    const page = makePage();
    await expect(command!.func!(page, { aweme_id: '' })).rejects.toBeInstanceOf(ArgumentError);
    await expect(command!.func!(page, { aweme_id: 'abc' })).rejects.toBeInstanceOf(ArgumentError);
    expect(page.goto).not.toHaveBeenCalled();
  });

  it('does not treat a missing work as successful delete', async () => {
    const page = makePage({ listBefore: [], listAfter: [] });
    const promise = command!.func!(page, { aweme_id: '123' });
    const assertion = expect(promise).rejects.toBeInstanceOf(CommandExecutionError);
    await vi.advanceTimersByTimeAsync(7000);
    await assertion;
  });

  it('unwraps Browser Bridge envelopes around creator manage delete results', async () => {
    const page = makePage({
      evaluateResult: { session: 'site:douyin:test', data: { ok: true, aweme_id: '123' } },
    });
    const promise = command!.func!(page, { aweme_id: '123' });
    const assertion = expect(promise).resolves.toEqual([
      { status: '✅ 已通过后台管理删除 123' },
    ]);
    await vi.advanceTimersByTimeAsync(7000);
    await assertion;
    expect(page.browserFetch).not.toHaveBeenCalled();
  });

  it('throws typed on malformed creator manage delete result', async () => {
    const page = makePage({ evaluateResult: 'bad-shape' });
    const promise = command!.func!(page, { aweme_id: '123' });
    const assertion = expect(promise).rejects.toBeInstanceOf(CommandExecutionError);
    await vi.advanceTimersByTimeAsync(7000);
    await assertion;
    expect(page.browserFetch).not.toHaveBeenCalled();
  });

  it('returns success only after fallback delete postcondition removes the target', async () => {
    const page = makePage({
      listBefore: [{ aweme_id: '123' }],
      listAfter: [],
    });
    const promise = command!.func!(page, { aweme_id: '123' });
    const assertion = expect(promise).resolves.toEqual([{ status: '✅ 已删除 123' }]);
    await vi.advanceTimersByTimeAsync(8000);
    await assertion;
  });
});
