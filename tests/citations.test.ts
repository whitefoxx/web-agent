/**
 * Unit tests for the citations helpers (grounded 来源 fallback + tool-URL
 * collection). Pure functions — no DOM / no engine. See src/agent/citations.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  appendSourcesFooter,
  collectSourcesFromTool,
  type SourceRef,
} from '../src/agent/citations';

describe('collectSourcesFromTool', () => {
  it('collects fetch_url final URL + <title>, skips non-http', () => {
    const sink: SourceRef[] = [];
    collectSourcesFromTool(
      'fetch_url',
      { url: 'https://ex.com/a', ok: true, body: '<html><head><title>Hi &amp; Bye</title></head>' },
      sink,
    );
    collectSourcesFromTool('fetch_url', { url: 'about:blank', ok: true }, sink);
    expect(sink).toEqual([{ url: 'https://ex.com/a', title: 'Hi & Bye' }]);
  });

  it('collects open_url and dedupes across tools by normalized URL', () => {
    const sink: SourceRef[] = [];
    collectSourcesFromTool('open_url', { url: 'https://ex.com/a/', active: false }, sink);
    // same page (trailing slash + hash) via fetch_url → merges, upgrades title
    collectSourcesFromTool(
      'fetch_url',
      { url: 'https://ex.com/a#x', ok: true, body: '<title>A</title>' },
      sink,
    );
    expect(sink).toHaveLength(1);
    expect(sink[0].title).toBe('A');
  });

  it('ignores web_search / unknown tools (candidates, not sources)', () => {
    const sink: SourceRef[] = [];
    collectSourcesFromTool('web_search', { results: [{ url: 'https://ex.com/x' }] }, sink);
    collectSourcesFromTool('get_page_text', { url: 'https://ex.com/y', text: '…' }, sink);
    expect(sink).toEqual([]);
  });
});

describe('appendSourcesFooter', () => {
  const src: SourceRef[] = [{ url: 'https://a.com/1', title: 'One' }, { url: 'https://b.com/2' }];

  it('appends a 来源 list when the answer cites nothing', () => {
    const out = appendSourcesFooter('结论。', src);
    expect(out).toContain('\n\nSources:\n');
    expect(out).toContain('1. [One](https://a.com/1)');
    expect(out).toContain('2. [b.com/2](https://b.com/2)'); // pretty label when no title
  });

  it('leaves text untouched when the model already wrote a 来源 heading', () => {
    const text = '结论[1]。\n\n来源:\n1. [x](https://a.com/1)';
    expect(appendSourcesFooter(text, src)).toBe(text);
  });

  it('leaves text untouched when a collected URL is already cited inline', () => {
    const text = '见 https://b.com/2 。';
    expect(appendSourcesFooter(text, src)).toBe(text);
  });

  it('no-ops when nothing was collected', () => {
    expect(appendSourcesFooter('结论。', [])).toBe('结论。');
  });

  it('caps the fallback list so a source-less answer is not a link dump', () => {
    const many: SourceRef[] = Array.from({ length: 20 }, (_, i) => ({
      url: `https://ex.com/${i}`,
    }));
    const out = appendSourcesFooter('x', many);
    expect(out).toContain('12. [ex.com/11]');
    expect(out).not.toContain('13. ');
  });
});
