/**
 * Port of opencli's clis/wikipedia/trending.test.js.
 *
 * opencli mocks the `wikiFetch` export from `./utils.js`. Our bundled adapter
 * has `wikiFetch` inlined (no module boundary), and it calls `globalThis.fetch`
 * then `resp.json()`. So the mock seam moves down to `globalThis.fetch`, fed a
 * Response-like `{ ok, status, json() }` via `jsonResponse(...)`.
 *
 * The adapter's `func` is `async (args) => {...}` and never touches a page, so
 * — exactly like opencli — it's invoked as `command.func({ limit, lang })`.
 *
 * Substantive assertions (empty-string description, PARSE_ERROR on missing
 * title, --limit gating which rows are validated) are preserved verbatim.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findAdapter } from '../../../src/runtime/registry.js';
import { installWikiFetch, jsonResponse, type WikiFetchHarness } from '../_helpers/wikipedia-page.js';

import '../../../marketplace/wikipedia/trending.js';

describe('wikipedia trending (marketplace)', () => {
  const command = findAdapter('wikipedia', 'trending');
  let harness: WikiFetchHarness;

  beforeEach(() => {
    harness = installWikiFetch();
  });

  afterEach(() => {
    harness.restore();
  });

  it('emits empty-string for missing description instead of a sentinel', async () => {
    expect(command?.func).toBeDefined();
    harness.fetchMock.mockResolvedValueOnce(
      jsonResponse({
        mostread: {
          articles: [
            { title: 'Has_Both', description: 'A real description', views: 100 },
            { title: 'Has_Title_Only', views: 25 },
          ],
        },
      }),
    );
    const rows = (await command!.func!({ limit: 5, lang: 'en' })) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ title: 'Has_Both', description: 'A real description', views: 100 });
    expect(rows[1].title).toBe('Has_Title_Only');
    expect(rows[1].description).toBe('');
  });

  it('fails typed when a trending article is missing title identity', async () => {
    harness.fetchMock.mockResolvedValueOnce(
      jsonResponse({ mostread: { articles: [{ views: 50 }] } }),
    );
    await expect(command!.func!({ limit: 5, lang: 'en' })).rejects.toMatchObject({
      code: 'PARSE_ERROR',
    });
  });

  it('validates only rows selected by --limit', async () => {
    harness.fetchMock.mockResolvedValueOnce(
      jsonResponse({
        mostread: {
          articles: [
            { title: 'Selected', views: 100 },
            { views: 50 },
          ],
        },
      }),
    );
    await expect(command!.func!({ limit: 1, lang: 'en' })).resolves.toEqual([
      { rank: 1, title: 'Selected', description: '', views: 100 },
    ]);
  });
});
