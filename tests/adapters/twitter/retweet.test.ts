/**
 * Port of opencli's clis/twitter/retweet.test.js.
 */
import { describe, expect, it } from 'vitest';
import { findAdapter } from '../../../src/runtime/registry.js';
import { ArgumentError, CommandExecutionError } from '../../../src/runtime/errors.js';
import { createPageMock } from '../_helpers/twitter-page.js';

import '../../../marketplace/twitter/retweet.js';

describe('twitter retweet command (marketplace)', () => {
  const cmd = findAdapter('twitter', 'retweet');

  it('clicks the retweet button then the confirm menu item and reports success', async () => {
    expect(cmd?.func).toBeTypeOf('function');
    const page = createPageMock([{ ok: true, message: 'Tweet successfully retweeted.' }]);
    const result = await cmd!.func!(page, {
      url: 'https://x.com/alice/status/2040254679301718161',
    });
    expect(page.goto).toHaveBeenCalledWith('https://x.com/alice/status/2040254679301718161');
    expect(page.wait).toHaveBeenNthCalledWith(1, { selector: '[data-testid="primaryColumn"]' });
    expect(page.wait).toHaveBeenNthCalledWith(2, 2);
    const script = page.evaluate.mock.calls[0][0] as string;
    expect(script).toContain('retweetBtn.click()');
    expect(script).toContain("document.querySelector('[data-testid=\"retweetConfirm\"]')");
    expect(script).toContain('confirmBtn.click()');
    expect(script).toContain('__twHasLinkToTarget');
    expect(script).toContain('__twGetStatusIdFromHref');
    expect(script).toContain("document.querySelectorAll('article')");
    expect(script).toContain("targetArticle?.querySelector('[data-testid=\"retweet\"]')");
    expect(script).toContain("targetArticle?.querySelector('[data-testid=\"unretweet\"]')");
    expect(result).toEqual([{ status: 'success', message: 'Tweet successfully retweeted.' }]);
  });

  it('returns a failed row when the confirm menu item never appears', async () => {
    const page = createPageMock([
      { ok: false, message: 'Retweet menu opened but the confirm option did not appear.' },
    ]);
    const result = await cmd!.func!(page, {
      url: 'https://x.com/alice/status/2040254679301718161',
    });
    expect(result).toEqual([
      { status: 'failed', message: 'Retweet menu opened but the confirm option did not appear.' },
    ]);
    expect(page.wait).toHaveBeenCalledTimes(1);
  });

  it('throws CommandExecutionError when no page is provided', async () => {
    await expect(
      cmd!.func!(undefined, { url: 'https://x.com/alice/status/2040254679301718161' }),
    ).rejects.toThrow(CommandExecutionError);
  });

  it('rejects invalid tweet URLs before navigation', async () => {
    const page = createPageMock([]);
    await expect(
      cmd!.func!(page, { url: 'https://evil.com/?next=https://x.com/alice/status/2040254679301718161' }),
    ).rejects.toThrow(ArgumentError);
    expect(page.goto).not.toHaveBeenCalled();
    expect(page.evaluate).not.toHaveBeenCalled();
  });
});
