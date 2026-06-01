/**
 * toVisionDataUrl fetches an image and inlines it as base64 so a vision model
 * gets the bytes directly — fixing hotlink-protected CDNs (weibo/xhs) the
 * model's own server can't fetch (GLM 1210). fetchImpl is injected here.
 */
import { describe, expect, it, vi } from 'vitest';
import { toVisionDataUrl } from '../src/agent/fetch-image';

function fakeResp(opts: {
  ok?: boolean;
  contentType?: string;
  body?: Uint8Array;
}): Response {
  const body = opts.body ?? new Uint8Array([1, 2, 3, 4]);
  return {
    ok: opts.ok ?? true,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? opts.contentType ?? 'image/jpeg' : null) },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  } as unknown as Response;
}

describe('toVisionDataUrl', () => {
  it('passes through an existing data: URL without fetching', async () => {
    const fetchImpl = vi.fn();
    const out = await toVisionDataUrl('data:image/png;base64,AAAA', { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out).toBe('data:image/png;base64,AAAA');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fetches an http image with no Referer and inlines it as base64', async () => {
    const fetchImpl = vi.fn(async () => fakeResp({ contentType: 'image/jpeg', body: new Uint8Array([0xff, 0xd8, 0xff]) }));
    const out = await toVisionDataUrl('https://wx4.sinaimg.cn/large/x.jpg', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out).toBe(`data:image/jpeg;base64,${btoa(String.fromCharCode(0xff, 0xd8, 0xff))}`);
    // hotlink bypass: no Referer
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://wx4.sinaimg.cn/large/x.jpg',
      expect.objectContaining({ referrerPolicy: 'no-referrer', credentials: 'omit' }),
    );
  });

  it('drops a non-image response (hotlink block page → text/html)', async () => {
    const fetchImpl = vi.fn(async () => fakeResp({ contentType: 'text/html', body: new Uint8Array([60, 33]) }));
    expect(await toVisionDataUrl('https://h/x.jpg', { fetchImpl: fetchImpl as unknown as typeof fetch })).toBeNull();
  });

  it('drops a non-ok response', async () => {
    const fetchImpl = vi.fn(async () => fakeResp({ ok: false }));
    expect(await toVisionDataUrl('https://h/x.jpg', { fetchImpl: fetchImpl as unknown as typeof fetch })).toBeNull();
  });

  it('drops an oversize image', async () => {
    const big = new Uint8Array(100);
    const fetchImpl = vi.fn(async () => fakeResp({ contentType: 'image/png', body: big }));
    expect(
      await toVisionDataUrl('https://h/x.png', { fetchImpl: fetchImpl as unknown as typeof fetch, maxBytes: 10 }),
    ).toBeNull();
  });

  it('returns null (never throws) on fetch error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network');
    });
    expect(await toVisionDataUrl('https://h/x.jpg', { fetchImpl: fetchImpl as unknown as typeof fetch })).toBeNull();
  });

  it('ignores non-http refs', async () => {
    expect(await toVisionDataUrl('ftp://h/x.jpg')).toBeNull();
  });
});
