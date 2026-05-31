/**
 * Port of opencli's clis/twitter/delete.test.js.
 *
 * Opencli builds the page inline with `vi.fn()`s (a single evaluate result),
 * so we reuse `createPageMock` for the standard skeleton and override
 * `evaluate` per-test.
 */
import { describe, expect, it, vi } from 'vitest';
import { findAdapter } from '../../../src/runtime/registry.js';
import { ArgumentError, CommandExecutionError } from '../../../src/runtime/errors.js';

import '../../../marketplace/twitter/delete.js';

describe('twitter delete command (marketplace)', () => {
  const cmd = findAdapter('twitter', 'delete');

  it('targets the matched tweet article instead of the first More button on the page', async () => {
    expect(cmd?.func).toBeTypeOf('function');
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      wait: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue({ ok: true, message: 'Tweet successfully deleted.' }),
    };
    const result = await cmd!.func!(page, {
      url: 'https://x.com/alice/status/2040254679301718161?s=20',
    });
    expect(page.goto).toHaveBeenCalledWith('https://x.com/alice/status/2040254679301718161?s=20');
    expect(page.wait).toHaveBeenNthCalledWith(1, { selector: '[data-testid="primaryColumn"]' });
    expect(page.wait).toHaveBeenNthCalledWith(2, 2);
    const script = page.evaluate.mock.calls[0][0] as string;
    expect(script).toContain('__twHasLinkToTarget');
    expect(script).toContain('__twGetStatusIdFromHref');
    expect(script).toContain("document.querySelectorAll('article')");
    expect(script).toContain("targetArticle.querySelectorAll('button,[role=\"button\"]')");
    expect(script).not.toContain("'/status/' + tweetId");
    expect(result).toEqual([{ status: 'success', message: 'Tweet successfully deleted.' }]);
  });

  it('passes through matched-tweet lookup failures', async () => {
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      wait: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue({
        ok: false,
        message: 'Could not find the tweet card matching the requested URL.',
      }),
    };
    const result = await cmd!.func!(page, {
      url: 'https://x.com/alice/status/2040254679301718161',
    });
    expect(result).toEqual([
      { status: 'failed', message: 'Could not find the tweet card matching the requested URL.' },
    ]);
    expect(page.wait).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed or off-domain URLs with ArgumentError before navigation', async () => {
    const page = { goto: vi.fn(), wait: vi.fn(), evaluate: vi.fn() };
    await expect(cmd!.func!(page, { url: 'https://x.com/alice/home' })).rejects.toThrow(ArgumentError);
    expect(page.goto).not.toHaveBeenCalled();
    expect(page.wait).not.toHaveBeenCalled();
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it('throws CommandExecutionError when no page is provided', async () => {
    await expect(
      cmd!.func!(undefined, { url: 'https://x.com/alice/status/2040254679301718161' }),
    ).rejects.toThrow(CommandExecutionError);
  });
});
