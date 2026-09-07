/**
 * Port of opencli's clis/youtube/channel.test.js.
 *
 * opencli imports `{ __test__ } from './channel.js'` and exercises the pure
 * `extractSelectedRichGridContents` helper directly — no page, no func, no
 * registry. The bundled marketplace adapter re-exports the SAME helper via
 * `__test__`, so the port is a straight import swap (path → bundled file). All
 * three substantive assertions (selected-tab preference, non-empty-tab
 * fallback, self-contained-for-evaluate-injection) are reachable and preserved.
 */
import { describe, expect, it } from 'vitest';
import { __test__ } from '../../../marketplace/youtube/channel.js';

function tab(title: string, contents: unknown, selected = false) {
  return {
    tabRenderer: {
      title,
      selected,
      content: {
        richGridRenderer: {
          contents,
        },
      },
    },
  };
}

function browseData(tabs: unknown[]) {
  return {
    contents: {
      twoColumnBrowseResultsRenderer: {
        tabs,
      },
    },
  };
}

describe('youtube channel helpers (marketplace)', () => {
  it('uses the selected rich-grid tab instead of the first tab', () => {
    const home = [{ richItemRenderer: { content: { videoRenderer: { videoId: 'home' } } } }];
    const videos = [{ richItemRenderer: { content: { videoRenderer: { videoId: 'videos' } } } }];

    expect(
      __test__.extractSelectedRichGridContents(
        browseData([tab('Home', home), tab('Videos', videos, true)]),
      ),
    ).toBe(videos);
  });

  it('falls back to the first non-empty rich-grid tab when no tab is selected', () => {
    const videos = [{ richItemRenderer: { content: { videoRenderer: { videoId: 'only' } } } }];

    expect(
      __test__.extractSelectedRichGridContents(
        browseData([tab('Home', []), tab('Videos', videos)]),
      ),
    ).toBe(videos);
  });

  it('is self-contained for browser evaluate injection', () => {
    // eslint-disable-next-line no-new-func
    const extractSelectedRichGridContents = Function(
      `return ${__test__.extractSelectedRichGridContents.toString()}`,
    )();
    const videos = [
      { richItemRenderer: { content: { videoRenderer: { videoId: 'serialized' } } } },
    ];

    expect(
      extractSelectedRichGridContents(
        browseData([tab('Home', []), tab('Videos', videos, true)]),
      ),
    ).toEqual(videos);
  });
});
