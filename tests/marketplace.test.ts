/**
 * Marketplace v2 client — schema-shape, hash verification, base-URL resolution.
 *
 * The high-level claim under test: an adapter shipped via the index can be
 * fetched + verified against its sha256 promise, and a corrupted (or
 * tampered, or stale-cache) body is refused rather than silently installed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sha256Hex, fetchAdapterSource, type MarketAdapter } from '../src/sidepanel/marketplace';

const SAMPLE_SOURCE = `
import { cli } from '@jackwener/opencli/registry';
cli({ site: 'demo', name: 'list', access: 'read', args: [], func: async () => [1, 2, 3] });
`;

// Stable sha256 for the literal above — computed via crypto.subtle in the
// first test; subsequent tests just reuse the value. Don't hard-code in case
// someone edits SAMPLE_SOURCE — the first test recomputes the expected hash.
let SAMPLE_SHA: string;

beforeEach(async () => {
  SAMPLE_SHA = await sha256Hex(SAMPLE_SOURCE);
});

describe('sha256Hex', () => {
  it('produces a 64-char hex digest for arbitrary UTF-8 input', async () => {
    const h = await sha256Hex('hello');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    // Stable value from `printf 'hello' | sha256sum`.
    expect(h).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('handles multibyte UTF-8 (Chinese) — must encode as UTF-8 not UTF-16', async () => {
    const a = await sha256Hex('你好');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    // Different from 'hello' — sanity check we aren't returning a constant.
    expect(a).not.toBe(await sha256Hex('hello'));
  });
});

describe('fetchAdapterSource', () => {
  let origFetch: typeof fetch;
  beforeEach(() => {
    origFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  function mkAdapter(overrides: Partial<MarketAdapter> = {}): MarketAdapter {
    return {
      site: 'demo',
      name: 'list',
      description: '',
      type: 'func',
      tier: 'official',
      author: 'opencli',
      version: '1.0.0',
      source: 'demo/list.js',
      sha256: SAMPLE_SHA,
      ...overrides,
    };
  }

  it('resolves source path against the provided base URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => SAMPLE_SOURCE,
    } as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const text = await fetchAdapterSource(mkAdapter(), 'https://market.example/v1/');
    expect(text).toBe(SAMPLE_SOURCE);
    expect(fetchMock).toHaveBeenCalledWith('https://market.example/v1/demo/list.js', {
      cache: 'no-store',
    });
  });

  it('returns source verbatim when sha256 matches', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => SAMPLE_SOURCE,
    } as Response) as unknown as typeof fetch;

    await expect(fetchAdapterSource(mkAdapter(), 'https://m/')).resolves.toBe(SAMPLE_SOURCE);
  });

  it('refuses install when body sha256 does not match the index', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => SAMPLE_SOURCE + '// tampered\n',
    } as Response) as unknown as typeof fetch;

    await expect(fetchAdapterSource(mkAdapter(), 'https://m/')).rejects.toThrow(/sha256 mismatch/i);
  });

  it('surfaces HTTP failure rather than swallowing into a hash mismatch', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    } as Response) as unknown as typeof fetch;

    await expect(fetchAdapterSource(mkAdapter(), 'https://m/')).rejects.toThrow(/404 Not Found/);
  });

  it('mismatch error includes the entry id and both hash prefixes for debugging', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => 'totally different bytes',
    } as Response) as unknown as typeof fetch;

    let err: Error | undefined;
    try {
      await fetchAdapterSource(mkAdapter({ site: 'zhihu', name: 'answer-detail' }), 'https://m/');
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain('zhihu/answer-detail');
    // Both the expected (index-promised) and got (computed) prefixes should
    // show up so a maintainer can tell at a glance which side is "off".
    expect(err!.message).toMatch(/index says [0-9a-f]+/);
    expect(err!.message).toMatch(/got [0-9a-f]+/);
  });
});
