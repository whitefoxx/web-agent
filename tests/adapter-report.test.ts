/**
 * adapter-report — the pure pre-filled-GitHub-issue URL builder (H1 community
 * contribution). Verifies broken vs heal shape, label/title, privacy note, and
 * the long-source clipboard fallback.
 */
import { describe, it, expect } from 'vitest';
import { buildAdapterReport } from '../src/adapters/adapter-report';

const REPO = 'github.com/whitefoxx/web-agent-marketplace/issues/new';

function decodeBody(url: string): string {
  const m = url.match(/[?&]body=([^&]*)/);
  return m ? decodeURIComponent(m[1]) : '';
}

describe('buildAdapterReport', () => {
  it('broken report: adapter-broken label, no source, carries the error', () => {
    const r = buildAdapterReport({
      id: 'zhihu/search',
      tool: 'zhihu__search',
      error: 'EmptyResultError: no rows',
      version: '0.0.1',
    });
    expect(r.clipboard).toBeUndefined();
    expect(r.url).toContain(REPO);
    expect(r.url).toContain('labels=adapter-broken');
    expect(decodeURIComponent(r.url)).toContain('[broken] Adapter zhihu__search is broken');
    const body = decodeBody(r.url);
    expect(body).toContain('zhihu/search');
    expect(body).toContain('EmptyResultError: no rows');
    expect(body).toContain('0.0.1');
    expect(body).toContain('any data you scraped'); // privacy note present
    expect(body).not.toContain('Locally patched source');
  });

  it('heal report: adapter-heal label + inlines a short source', () => {
    const r = buildAdapterReport({
      id: 'zhihu/search',
      tool: 'zhihu__search',
      source: "cli({ site: 'zhihu', name: 'search' })",
    });
    expect(r.clipboard).toBeUndefined();
    expect(r.url).toContain('labels=adapter-heal');
    const body = decodeBody(r.url);
    expect(body).toContain('Locally patched source');
    expect(body).toContain("cli({ site: 'zhihu', name: 'search' })");
  });

  it('long source → clipboard fallback + paste placeholder (stays under the URL cap)', () => {
    const big = 'cli({\n' + '// padding line that is reasonably long\n'.repeat(400) + '})';
    const r = buildAdapterReport({ id: 'x/y', tool: 'x__y', source: big });
    expect(r.clipboard).toBe(big.trim());
    const body = decodeBody(r.url);
    expect(body).toContain('copied to your clipboard');
    expect(body).toContain('<paste here>');
    expect(body).not.toContain('padding line'); // the big source is NOT in the url
    expect(r.url.length).toBeLessThan(8000); // under GitHub's URL ceiling
  });

  it('omits the error block when no error given', () => {
    const r = buildAdapterReport({ id: 'a/b', tool: 'a__b' });
    expect(decodeBody(r.url)).not.toContain('**Error**');
  });
});
