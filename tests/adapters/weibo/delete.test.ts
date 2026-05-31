/**
 * Port of opencli's clis/weibo/delete.test.js.
 *
 * The bundled adapter does all its work in one `page.evaluate(<async fetch
 * script>)` and reads back a `{ ok, error, ... }` payload. Opencli's tests
 * seed that single evaluate with a canned payload via `makePage(result)` and
 * assert both the returned rows and (for the happy path) the script string.
 * We reuse `makeFixedPage` for that exact seam; only the registry lookup and
 * error imports change per the port cheatsheet.
 */
import { describe, expect, it } from 'vitest';
import { findAdapter } from '../../../src/runtime/registry.js';
import {
  ArgumentError,
  AuthRequiredError,
  CommandExecutionError,
  EmptyResultError,
} from '../../../src/runtime/errors.js';
import { makeFixedPage } from '../_helpers/weibo-page.js';

import '../../../marketplace/weibo/delete.js';

describe('weibo delete command (marketplace)', () => {
  const command = findAdapter('weibo', 'delete');

  it('returns deleted status when the API reports success', async () => {
    const page = makeFixedPage({ ok: true, id: '5197123456789012', mblogid: 'Px2yQfXYZ' });
    const result = await command!.func!(page, { id: 'Px2yQfXYZ' });
    expect(result).toEqual([
      { status: 'deleted', id: '5197123456789012', mblogid: 'Px2yQfXYZ' },
    ]);
    expect(page.goto).toHaveBeenCalledWith('https://weibo.com');
    const script = page.evaluate.mock.calls[0][0] as string;
    expect(script.match(/\/ajax\/statuses\/show/g)).toHaveLength(2);
    expect(script).toContain('/ajax/statuses/destroy');
    expect(script).toContain('still_exists');
  });

  it('normalizes supported Weibo post URLs before evaluating delete flow', async () => {
    const page = makeFixedPage({ ok: true, id: '5197123456789012', mblogid: 'Px2yQfXYZ' });
    const result = await command!.func!(page, {
      id: 'https://weibo.com/1234567890/Px2yQfXYZ?refer_flag=1001030103_',
    });

    expect(result).toEqual([
      { status: 'deleted', id: '5197123456789012', mblogid: 'Px2yQfXYZ' },
    ]);
    expect(page.evaluate.mock.calls[0][0] as string).toContain('const input = "Px2yQfXYZ"');
  });

  it('throws ArgumentError when id is empty or whitespace', async () => {
    const page = makeFixedPage({ ok: true, id: '0' });
    await expect(command!.func!(page, { id: '   ' })).rejects.toBeInstanceOf(ArgumentError);
    await expect(command!.func!(page, { id: '' })).rejects.toBeInstanceOf(ArgumentError);
    await expect(
      command!.func!(page, { id: 'https://example.com/123/Px2yQfXYZ' }),
    ).rejects.toBeInstanceOf(ArgumentError);
    await expect(command!.func!(page, { id: 'javascript:alert(1)' })).rejects.toBeInstanceOf(
      ArgumentError,
    );
    await expect(command!.func!(page, { id: '../not-a-post' })).rejects.toBeInstanceOf(ArgumentError);
    expect(page.goto).not.toHaveBeenCalled();
  });

  it('maps 401 / 403 from the show endpoint to AuthRequiredError', async () => {
    const page = makeFixedPage({ error: 'auth', status: 401 });
    await expect(command!.func!(page, { id: 'Px2yQfXYZ' })).rejects.toBeInstanceOf(
      AuthRequiredError,
    );
  });

  it('throws EmptyResultError when the post cannot be resolved', async () => {
    const page = makeFixedPage({ error: 'not_found', input: 'Px2yQfXYZ' });
    await expect(command!.func!(page, { id: 'Px2yQfXYZ' })).rejects.toBeInstanceOf(
      EmptyResultError,
    );
  });

  it('throws CommandExecutionError on non-2xx show response', async () => {
    const page = makeFixedPage({ error: 'show_http', status: 500 });
    await expect(command!.func!(page, { id: '5197123456789012' })).rejects.toBeInstanceOf(
      CommandExecutionError,
    );
  });

  it('throws CommandExecutionError on non-2xx destroy response', async () => {
    const page = makeFixedPage({ error: 'destroy_http', status: 502 });
    await expect(command!.func!(page, { id: '5197123456789012' })).rejects.toBeInstanceOf(
      CommandExecutionError,
    );
  });

  it('surfaces API-level errors from destroy as CommandExecutionError with msg', async () => {
    const page = makeFixedPage({ error: 'api', msg: '无权限删除', id: '5197123456789012' });
    await expect(command!.func!(page, { id: '5197123456789012' })).rejects.toThrowError(
      /无权限删除/,
    );
  });

  it('throws CommandExecutionError when postcondition verification still sees the target', async () => {
    const page = makeFixedPage({
      error: 'still_exists',
      id: '5197123456789012',
      mblogid: 'Px2yQfXYZ',
    });
    await expect(command!.func!(page, { id: '5197123456789012' })).rejects.toBeInstanceOf(
      CommandExecutionError,
    );
  });

  it('throws CommandExecutionError when postcondition verification is malformed', async () => {
    const page = makeFixedPage({
      error: 'verify_malformed',
      msg: 'verify returned malformed response',
      id: '5197123456789012',
    });
    await expect(command!.func!(page, { id: '5197123456789012' })).rejects.toThrowError(
      /verify returned malformed response/,
    );
  });

  it('unwraps the browser-bridge { session, data } envelope', async () => {
    const page = makeFixedPage({
      session: 'site:weibo:abc',
      data: { ok: true, id: '42', mblogid: 'M420' },
    });
    const result = await command!.func!(page, { id: 'M420' });
    expect(result).toEqual([{ status: 'deleted', id: '42', mblogid: 'M420' }]);
  });
});
