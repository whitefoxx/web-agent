/**
 * Port of opencli's clis/zhihu/like.test.js.
 *
 * Write adapter with no identity resolution — the first (and only)
 * page.evaluate is the like POST.
 */
import { describe, expect, it, vi } from 'vitest';
import { findAdapter } from '@base/runtime/registry.js';
import '../../../marketplace/zhihu/like.js';

describe('zhihu like (marketplace)', () => {
  it('registers as a cookie browser command', () => {
    const cmd = findAdapter('zhihu', 'like');
    expect(cmd).toBeDefined();
    expect(cmd!.strategy).toBe('cookie');
  });

  it('likes via API and returns result', async () => {
    const cmd = findAdapter('zhihu', 'like');
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      wait: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValueOnce({ ok: true, success: true }),
    };
    const rows = await cmd!.func!(page, { target: 'answer:1:2', execute: true });
    expect(rows).toEqual([expect.objectContaining({ outcome: 'applied' })]);
  });

  it('throws on API error', async () => {
    const cmd = findAdapter('zhihu', 'like');
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      wait: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValueOnce({ ok: false, message: 'rate limited' }),
    };
    await expect(cmd!.func!(page, { target: 'answer:1:2', execute: true })).rejects.toMatchObject({
      code: 'COMMAND_EXEC',
    });
  });

  it('does not treat success=false API responses as a successful like', async () => {
    const cmd = findAdapter('zhihu', 'like');
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      wait: vi.fn().mockResolvedValue(undefined),
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({ ok: false, message: 'Zhihu like API reported success=false' }),
    };
    await expect(cmd!.func!(page, { target: 'answer:1:2', execute: true })).rejects.toMatchObject({
      code: 'COMMAND_EXEC',
    });
    expect(page.evaluate.mock.calls[0][0]).toContain('data.success === false');
  });
});
