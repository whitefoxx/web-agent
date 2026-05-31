/**
 * Port of opencli's clis/twitter/list-remove.test.js.
 */
import { describe, expect, it, vi } from 'vitest';
import { findAdapter } from '../../../src/runtime/registry.js';
import { CommandExecutionError } from '../../../src/runtime/errors.js';

import '../../../marketplace/twitter/list-remove.js';

function buildListsPayload(listId = '123', memberCount = 10) {
  return {
    data: {
      viewer: {
        list_management_timeline: {
          timeline: {
            instructions: [
              {
                entries: [
                  {
                    entryId: 'owned-subscribed-list-module-0',
                    content: {
                      items: [
                        {
                          item: {
                            itemContent: {
                              list: {
                                id_str: listId,
                                name: 'My List',
                                member_count: memberCount,
                                subscriber_count: 0,
                                mode: 'Public',
                              },
                            },
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        },
      },
    },
  };
}

function buildRemovePage(afterPayload: unknown) {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue(undefined),
    getCookies: vi.fn().mockResolvedValue([{ name: 'ct0', value: 'token' }]),
    nativeClick: vi.fn().mockResolvedValue(undefined),
    evaluate: vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('user-1')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(buildListsPayload('123', 10))
      .mockResolvedValueOnce({
        ok: true,
        needsNativeInteraction: true,
        rowClickX: 1,
        rowClickY: 2,
        saveClickX: 3,
        saveClickY: 4,
      })
      .mockResolvedValueOnce(afterPayload),
  };
}

describe('twitter list-remove registration (marketplace)', () => {
  const cmd = () => findAdapter('twitter', 'list-remove');

  it('registers the list-remove command with the expected shape', () => {
    expect(cmd()?.func).toBeTypeOf('function');
    expect(cmd()?.columns).toEqual(['listId', 'username', 'userId', 'status', 'message']);
    const listIdArg = cmd()?.args?.find((a: { name: string }) => a.name === 'listId');
    expect(listIdArg).toBeTruthy();
    expect(listIdArg?.required).toBe(true);
  });

  it('keeps the x.com root navigation before pre-target GraphQL calls', async () => {
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      wait: vi.fn().mockResolvedValue(undefined),
      getCookies: vi.fn().mockResolvedValue([{ name: 'ct0', value: 'token' }]),
      evaluate: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce('user-1')
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({}),
    };

    await expect(cmd()!.func!(page, { listId: '123', username: 'alice' })).rejects.toThrow(
      /List 123 not found/,
    );
    expect(page.goto).toHaveBeenCalledWith('https://x.com');
    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(page.wait).toHaveBeenCalledWith(3);
    expect(page.getCookies).toHaveBeenCalledWith({ url: 'https://x.com' });
  });

  it('does not treat post-delete fetch failure as successful member_count decrease', async () => {
    const page = buildRemovePage({ __error: 'HTTP 500' });
    await expect(cmd()!.func!(page, { listId: '123', username: 'alice' })).rejects.toBeInstanceOf(
      CommandExecutionError,
    );
  });

  it('does not treat malformed post-delete payload as successful member_count decrease', async () => {
    const page = buildRemovePage({ data: {} });
    await expect(cmd()!.func!(page, { listId: '123', username: 'alice' })).rejects.toBeInstanceOf(
      CommandExecutionError,
    );
  });

  it('does not treat a missing target list in post-delete payload as success', async () => {
    const page = buildRemovePage(buildListsPayload('456', 1));
    await expect(cmd()!.func!(page, { listId: '123', username: 'alice' })).rejects.toBeInstanceOf(
      CommandExecutionError,
    );
  });
});
