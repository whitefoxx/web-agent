/**
 * toVisionDataUrl fetches an image and inlines it as base64 so a vision model
 * gets the bytes directly — fixing hotlink-protected CDNs (weibo/xhs) the
 * model's own server can't fetch (GLM 1210) and Aliyun/qwen's
 * "Download multimodal file timed out" (§10.24). data: refs are NORMALIZED to
 * the strict provider shape (whitespace-free payload, real image MIME).
 * fetchImpl is injected here.
 */
import { describe, expect, it, vi } from 'vitest';
import { toVisionDataUrl, normalizeImageDataUrl, sniffImageMime } from '../src/agent/fetch-image';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const PNG_B64 = btoa(String.fromCharCode(...PNG_BYTES));

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

  it('accepts an octet-stream response whose MAGIC BYTES are an image (CDNs lie)', async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResp({ contentType: 'application/octet-stream', body: PNG_BYTES }),
    );
    expect(
      await toVisionDataUrl('https://h/noext', { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).toBe(`data:image/png;base64,${PNG_B64}`);
  });
});

describe('normalizeImageDataUrl (§10.24 — strict provider data-URL shape)', () => {
  it('strips whitespace/newlines from the payload (Aliyun treats a malformed data URL as a URL to download)', () => {
    expect(normalizeImageDataUrl(`data:image/png;base64,${PNG_B64.slice(0, 4)}\n ${PNG_B64.slice(4)}`)).toBe(
      `data:image/png;base64,${PNG_B64}`,
    );
  });

  it('canonicalizes image/jpg → image/jpeg', () => {
    expect(normalizeImageDataUrl('data:image/jpg;base64,AAAA')).toBe('data:image/jpeg;base64,AAAA');
  });

  it('repairs a generic/wrong MIME by sniffing the magic bytes', () => {
    expect(normalizeImageDataUrl(`data:application/octet-stream;base64,${PNG_B64}`)).toBe(
      `data:image/png;base64,${PNG_B64}`,
    );
    expect(normalizeImageDataUrl(`data:;base64,${PNG_B64}`)).toBe(`data:image/png;base64,${PNG_B64}`);
  });

  it('rejects non-base64 data URLs, invalid base64, and non-image payloads', () => {
    expect(normalizeImageDataUrl('data:image/svg+xml;utf8,<svg/>')).toBeNull();
    expect(normalizeImageDataUrl('data:image/svg+xml;base64,PHN2Zy8+')).toBeNull(); // svg mime + non-raster magic
    expect(normalizeImageDataUrl('data:application/pdf;base64,JVBERi0xLjQKJcOkw7w=')).toBeNull();
    expect(normalizeImageDataUrl('data:image/png;base64,@@@@')).toBeNull();
  });

  it('rejects an oversize payload cheaply (base64-length pre-check)', () => {
    expect(normalizeImageDataUrl(`data:image/png;base64,${PNG_B64}`, 4)).toBeNull();
  });
});

describe('sniffImageMime', () => {
  it('recognizes png/jpeg/gif/webp/bmp magic; null otherwise', () => {
    expect(sniffImageMime(PNG_BYTES)).toBe('image/png');
    expect(
      sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])),
    ).toBe('image/jpeg');
    expect(
      sniffImageMime(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0])),
    ).toBe('image/gif');
    expect(
      sniffImageMime(
        new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
      ),
    ).toBe('image/webp');
    expect(sniffImageMime(new Uint8Array([0x42, 0x4d, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(
      'image/bmp',
    );
    expect(sniffImageMime(new Uint8Array([60, 33, 68, 79, 67, 84, 89, 80, 69, 32, 104, 116]))).toBeNull(); // "<!DOCTYPE ht"
    expect(sniffImageMime(new Uint8Array([1, 2, 3]))).toBeNull(); // too short
  });
});

describe('toVisionDataUrl — oversized-body guard (Tier3-#16)', () => {
  it('bails on an oversized Content-Length WITHOUT reading the body', async () => {
    let readBody = false;
    const resp = {
      ok: true,
      headers: {
        get: (k: string) =>
          k.toLowerCase() === 'content-length'
            ? '999999'
            : k.toLowerCase() === 'content-type'
              ? 'image/jpeg'
              : null,
      },
      arrayBuffer: async () => {
        readBody = true;
        return new Uint8Array(999999).buffer;
      },
    } as unknown as Response;
    const fetchImpl = vi.fn(async () => resp);
    const out = await toVisionDataUrl('https://h/big.jpg', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxBytes: 1000,
    });
    expect(out).toBeNull();
    expect(readBody).toBe(false); // rejected before touching the body
  });

  it('streaming cap stops an oversized body with no Content-Length', async () => {
    const chunk = new Uint8Array(600);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(chunk);
        c.enqueue(chunk); // 1200 > cap 1000
        c.close();
      },
    });
    const resp = {
      ok: true,
      headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'image/jpeg' : null) },
      body: stream,
    } as unknown as Response;
    const fetchImpl = vi.fn(async () => resp);
    expect(
      await toVisionDataUrl('https://h/x.jpg', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        maxBytes: 1000,
      }),
    ).toBeNull();
  });

  it('streaming reads a body under the cap into a data URL', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0x00]); // jpeg magic
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(jpeg);
        c.close();
      },
    });
    const resp = {
      ok: true,
      headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'image/jpeg' : null) },
      body: stream,
    } as unknown as Response;
    const fetchImpl = vi.fn(async () => resp);
    const out = await toVisionDataUrl('https://h/x.jpg', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxBytes: 1000,
    });
    expect(out).toMatch(/^data:image\/jpeg;base64,/);
  });
});
