/**
 * Port of opencli's clis/youtube/transcript.test.js.
 *
 * Two describe blocks, both preserved:
 *
 *   1. "source contract" — reads the adapter SOURCE and asserts substrings that
 *      pin the in-page strategy (watch-player captions module → watch HTML
 *      fallback, never Android InnerTube; srv3 normalization; HTTP-status check;
 *      fetch/XHR hook restoration; per-videoId timedtext scoping). opencli reads
 *      its own ./transcript.js; here we read the BUNDLED
 *      marketplace/youtube/transcript.js — which is esbuild-bundled (utils
 *      inlined) but still carries every asserted substring verbatim (verified).
 *
 *   2. "caption fetch" — drives the adapter's func through its evaluate-only and
 *      network-capture paths. The bundled adapter has NO `./utils.js` module
 *      boundary, so opencli's seam (sequenced `page.evaluate` mocks +
 *      startNetworkCapture/readNetworkCapture vi.fn()s) maps onto our fake page
 *      directly. All substantive assertions (returned rows, in-page script
 *      contents for srv3/format-preservation/fallback, typed errors on HTTP/
 *      malformed payloads/no-captions) are ported unchanged.
 *
 * Divergences from opencli (mandatory, not bugs):
 *   - getRegistry().get('youtube/transcript') → findAdapter('youtube','transcript')
 *   - errors imported from src/runtime/errors.js
 *   - source read from the bundled marketplace file, not ./transcript.js
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findAdapter } from '../../../src/runtime/registry.js';
import { CommandExecutionError, EmptyResultError } from '../../../src/runtime/errors.js';
import {
  makeTranscriptPage,
  makeTranscriptCapturePage,
  type FakeTranscriptPage,
} from '../_helpers/youtube-page.js';

import '../../../marketplace/youtube/transcript.js';

const MARKETPLACE_TRANSCRIPT = new URL(
  '../../../marketplace/youtube/transcript.js',
  import.meta.url,
);
const transcriptSource = readFileSync(MARKETPLACE_TRANSCRIPT, 'utf8');

/**
 * Mirrors opencli's `createPageMock`: evaluate #1 (player extraction) → null,
 * evaluate #2 (caption info) → caption metadata, evaluate #3+ (XML extraction
 * and beyond) → canned segments. No capture methods, so canCapture is false.
 */
function createPageMock(captionUrl: string): FakeTranscriptPage {
  const page = makeTranscriptPage();
  page.evaluate
    .mockResolvedValueOnce(null) // #1 InnerTube get_transcript → no segments
    .mockResolvedValueOnce(null) // #2 player extraction → no segments
    .mockResolvedValueOnce({
      // #3 watch-HTML caption info
      captionUrl,
      language: 'en',
      kind: 'manual',
      available: ['en'],
      requestedLang: null,
      langMatched: false,
      langPrefixMatched: false,
    })
    .mockResolvedValue([{ start: 1, end: 3, text: 'hello & world' }]); // #4+ XML extraction
  return page;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('youtube transcript source contract (marketplace)', () => {
  it('uses the watch player captions module before falling back to watch HTML, not Android InnerTube', () => {
    expect(transcriptSource).toContain("player.loadModule?.('captions')");
    expect(transcriptSource).toContain("player.setOption('captions', 'track', track)");
    expect(transcriptSource).toContain("url.includes('pot=')");
    expect(transcriptSource).toContain("fetch('/watch?v='");
    expect(transcriptSource).toContain(
      "extractJsonAssignmentFromHtml(html, 'ytInitialPlayerResponse')",
    );
    expect(transcriptSource).toContain('playerCaptionsTracklistRenderer');
    expect(transcriptSource).not.toContain('/youtubei/v1/player');
    expect(transcriptSource).not.toContain("clientName: 'ANDROID'");
  });

  it('normalizes caption URL to request srv3 XML format', () => {
    expect(transcriptSource).toContain('fmt=srv3');
  });

  it('checks HTTP status before reading caption response body', () => {
    expect(transcriptSource).toContain('resp.ok');
  });

  it('restores page fetch and XHR hooks even when caption probing exits early', () => {
    expect(transcriptSource).toContain('} finally {');
    expect(transcriptSource).toContain('globalThis.fetch = originalFetch');
    expect(transcriptSource).toContain('globalThis.XMLHttpRequest = OriginalXHR');
  });

  it('scopes timedtext URL matching to the current videoId in both in-page paths', () => {
    expect(transcriptSource).toContain('const targetVideoId = ');
    expect(transcriptSource).toContain("parsed.searchParams.get('v') === targetVideoId");
    expect(transcriptSource).toContain('timedtextUrlMatchesVideo(url)');
  });
});

describe('youtube transcript caption fetch (marketplace)', () => {
  const command = findAdapter('youtube', 'transcript');

  it('requests srv3 when the caption track URL has no explicit format', async () => {
    const page = createPageMock('https://www.youtube.com/api/timedtext?v=abc&lang=en');

    const rows = await command!.func!(page, { url: 'abc', mode: 'raw' });

    expect(page.evaluate.mock.calls[3][0]).toContain(
      'const primaryUrl = "https://www.youtube.com/api/timedtext?v=abc&lang=en&fmt=srv3"',
    );
    expect(page.evaluate.mock.calls[3][0]).toContain(
      'const originalUrl = "https://www.youtube.com/api/timedtext?v=abc&lang=en"',
    );
    expect(rows).toEqual([{ index: 1, start: '1.00s', end: '3.00s', text: 'hello & world' }]);
  });

  it('uses Browser Bridge envelope-wrapped get_transcript segments without fallback', async () => {
    // get_transcript runs first now; an enveloped { session, data:[...] } result
    // is unwrapped and used directly — no player/watch fallback, a single evaluate.
    const page = makeTranscriptPage();
    page.evaluate.mockResolvedValueOnce({
      session: 'browser:default',
      data: [{ start: 2, end: 4.5, text: 'from transcript api' }],
    });

    const rows = await command!.func!(page, { url: 'abc', mode: 'raw' });

    expect(page.evaluate).toHaveBeenCalledTimes(1);
    expect(rows).toEqual([{ index: 1, start: '2.00s', end: '4.50s', text: 'from transcript api' }]);
  });

  it('uses captured timedtext json3 when player selection returns no segments', async () => {
    const page = makeTranscriptCapturePage({
      readNetworkCapture: {
        session: 'browser:default',
        data: [
          {
            url: 'https://www.youtube.com/api/timedtext?v=abc&lang=en&fmt=json3&pot=token',
            responsePreview: JSON.stringify({
              events: [
                {
                  tStartMs: 1000,
                  dDurationMs: 1500,
                  segs: [{ utf8: 'hello ' }, { utf8: 'capture' }],
                },
              ],
            }),
          },
        ],
      },
    });
    // get_transcript (#1) and player (#2) both miss → captured json3 is used.
    page.evaluate.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

    const rows = await command!.func!(page, { url: 'abc', mode: 'raw', lang: 'en' });

    expect(page.startNetworkCapture).toHaveBeenCalledWith('/api/timedtext');
    expect(page.evaluate).toHaveBeenCalledTimes(2);
    expect(rows).toEqual([{ index: 1, start: '1.00s', end: '2.50s', text: 'hello capture' }]);
  });

  it('ignores captured timedtext entries from a prior video and uses only the current videoId', async () => {
    const page = makeTranscriptCapturePage({
      readNetworkCapture: {
        session: 'browser:default',
        data: [
          {
            // Stale entry from a prior watch on the shared tab — must be ignored.
            url: 'https://www.youtube.com/api/timedtext?v=prev&lang=en&fmt=json3&pot=token',
            responsePreview: JSON.stringify({
              events: [
                { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'WRONG video captions' }] },
              ],
            }),
          },
          {
            // Prefix collision: substring matching for "v=abc" would accept this.
            url: 'https://www.youtube.com/api/timedtext?v=abcd&lang=en&fmt=json3&pot=token',
            responsePreview: JSON.stringify({
              events: [
                { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: 'WRONG prefix captions' }] },
              ],
            }),
          },
          {
            // Current video's captions.
            url: 'https://www.youtube.com/api/timedtext?v=abc&lang=en&fmt=json3&pot=token',
            responsePreview: JSON.stringify({
              events: [{ tStartMs: 2000, dDurationMs: 1000, segs: [{ utf8: 'right captions' }] }],
            }),
          },
        ],
      },
    });
    // get_transcript (#1) and player (#2) both miss → captured json3 is used.
    page.evaluate.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

    const rows = await command!.func!(page, { url: 'abc', mode: 'raw', lang: 'en' });

    expect(rows).toEqual([{ index: 1, start: '2.00s', end: '3.00s', text: 'right captions' }]);
  });

  it('does not override an existing caption format', async () => {
    const page = createPageMock('https://www.youtube.com/api/timedtext?v=abc&lang=en&fmt=vtt');

    await command!.func!(page, { url: 'abc', mode: 'raw' });

    expect(page.evaluate.mock.calls[3][0]).toContain(
      'const primaryUrl = "https://www.youtube.com/api/timedtext?v=abc&lang=en&fmt=vtt"',
    );
    expect(page.evaluate.mock.calls[3][0]).toContain(
      'const originalUrl = "https://www.youtube.com/api/timedtext?v=abc&lang=en&fmt=vtt"',
    );
  });

  it('falls back to the original URL only after an empty successful srv3 response', async () => {
    const page = createPageMock('https://www.youtube.com/api/timedtext?v=abc&lang=en');

    await command!.func!(page, { url: 'abc', mode: 'raw' });

    const script = page.evaluate.mock.calls[3][0] as string;
    expect(script).toContain('if (!result.xml.length && originalUrl !== primaryUrl)');
    expect(script).toContain('result = await fetchCaptionXml(originalUrl)');
    expect(script).toContain('if (result.error) {');
  });

  it('fails typed on caption HTTP errors instead of falling back silently', async () => {
    const page = createPageMock('https://www.youtube.com/api/timedtext?v=abc&lang=en');
    page.evaluate.mockReset();
    page.evaluate
      .mockResolvedValueOnce(null) // InnerTube get_transcript → no segments
      .mockResolvedValueOnce(null) // player extraction → no segments
      .mockResolvedValueOnce({
        captionUrl: 'https://www.youtube.com/api/timedtext?v=abc&lang=en',
        language: 'en',
        kind: 'manual',
        available: ['en'],
        requestedLang: null,
        langMatched: false,
        langPrefixMatched: false,
      })
      .mockResolvedValueOnce({ error: 'Caption URL returned HTTP 503' });

    await expect(command!.func!(page, { url: 'abc', mode: 'raw' })).rejects.toMatchObject({
      code: 'COMMAND_EXEC',
      message: expect.stringContaining('HTTP 503'),
    });
  });

  it('fails typed on malformed browser extraction payloads', async () => {
    const page = createPageMock('https://www.youtube.com/api/timedtext?v=abc&lang=en');
    page.evaluate.mockReset();
    page.evaluate
      .mockResolvedValueOnce(null) // InnerTube get_transcript → no segments
      .mockResolvedValueOnce(null) // player extraction → no segments
      .mockResolvedValueOnce({
        captionUrl: 'https://www.youtube.com/api/timedtext?v=abc&lang=en',
        language: 'en',
        kind: 'manual',
        available: ['en'],
        requestedLang: null,
        langMatched: false,
        langPrefixMatched: false,
      })
      .mockResolvedValueOnce({ session: 'browser:default', data: { rows: [] } });

    await expect(command!.func!(page, { url: 'abc', mode: 'raw' })).rejects.toMatchObject({
      code: 'COMMAND_EXEC',
      message: expect.stringContaining('Malformed caption XML extraction payload'),
    });
  });

  it('fails typed on malformed caption info payloads before URL construction', async () => {
    const page = createPageMock('https://www.youtube.com/api/timedtext?v=abc&lang=en');
    page.evaluate.mockReset();
    page.evaluate
      .mockResolvedValueOnce(null) // InnerTube get_transcript → no segments
      .mockResolvedValueOnce(null) // player extraction → no segments
      .mockResolvedValueOnce({ session: 'browser:default', data: { rows: [] } });

    await expect(command!.func!(page, { url: 'abc', mode: 'raw' })).rejects.toMatchObject({
      code: 'COMMAND_EXEC',
      message: expect.stringContaining('Malformed caption info payload'),
    });
  });

  it('maps explicit no-captions watch metadata to EmptyResultError', async () => {
    const page = createPageMock('https://www.youtube.com/api/timedtext?v=abc&lang=en');
    page.evaluate.mockReset();
    page.evaluate
      .mockResolvedValueOnce(null) // InnerTube get_transcript → no segments
      .mockResolvedValueOnce(null) // player extraction → no segments
      .mockResolvedValueOnce({ error: 'No captions available for this video' });

    await expect(command!.func!(page, { url: 'abc', mode: 'raw' })).rejects.toBeInstanceOf(
      EmptyResultError,
    );
  });

  it('keeps malformed watch metadata as CommandExecutionError', async () => {
    const page = createPageMock('https://www.youtube.com/api/timedtext?v=abc&lang=en');
    page.evaluate.mockReset();
    page.evaluate
      .mockResolvedValueOnce(null) // InnerTube get_transcript → no segments
      .mockResolvedValueOnce(null) // player extraction → no segments
      .mockResolvedValueOnce({ error: 'ytInitialPlayerResponse not found in watch HTML' });

    await expect(command!.func!(page, { url: 'abc', mode: 'raw' })).rejects.toBeInstanceOf(
      CommandExecutionError,
    );
  });

  it('fails typed on malformed captured timedtext json3', async () => {
    const page = makeTranscriptCapturePage({
      readNetworkCapture: [
        {
          url: 'https://www.youtube.com/api/timedtext?v=abc&lang=en&fmt=json3&pot=token',
          responsePreview: '{"events":',
        },
      ],
    });
    page.evaluate.mockResolvedValueOnce(null);

    await expect(
      command!.func!(page, { url: 'abc', mode: 'raw', lang: 'en' }),
    ).rejects.toMatchObject({
      code: 'COMMAND_EXEC',
      message: expect.stringContaining('Malformed json3 timedtext response'),
    });
  });
});
