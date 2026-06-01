/**
 * Fetch an image and return it as a base64 data URL, so it can be sent to a
 * vision model as image bytes rather than a URL the model's server must fetch.
 *
 * WHY (docs/architecture.md §8.5): passing a raw image URL to a vision endpoint
 * only works if THAT server can fetch it. Many site CDNs (weibo's sinaimg.cn,
 * xiaohongshu's xhscdn, …) are hotlink-protected — a foreign server fetch gets
 * a 403/HTML block page, and the model returns "图片输入格式/解析错误" (GLM
 * code 1210). The extension has `host_permissions: <all_urls>`, so the service
 * worker can fetch the bytes directly (with no Referer — direct access is what
 * those CDNs allow) and hand the model a self-contained data URL.
 *
 * Guards: only image content-types, a byte cap (vision endpoints + our IDB
 * persistence both dislike giant blobs), and never throws — a failed image is
 * dropped (returns null) so it just doesn't get shown, rather than breaking the
 * whole turn.
 */

/** Skip images larger than this (decoded bytes). ~6 MB keeps base64 (~8 MB) well
 * under typical vision request limits. */
export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

function abToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000; // avoid String.fromCharCode stack overflow on big arrays
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/**
 * Turn an image reference into a base64 data URL suitable for an `image_url`
 * vision block. `data:` refs (screenshots) pass through unchanged. http(s) refs
 * are fetched in the SW with no Referer (hotlink bypass) and converted. Returns
 * null on any failure / non-image / oversize — caller drops it.
 *
 * `fetchImpl` is injectable for tests.
 */
export async function toVisionDataUrl(
  ref: string,
  opts: { signal?: AbortSignal; fetchImpl?: typeof fetch; maxBytes?: number } = {},
): Promise<string | null> {
  const trimmed = ref.trim();
  if (trimmed.startsWith('data:')) return trimmed; // already inline bytes
  if (!/^https?:\/\//i.test(trimmed)) return null;
  const doFetch = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? MAX_IMAGE_BYTES;
  try {
    const resp = await doFetch(trimmed, {
      // No Referer: that's exactly how a CDN's hotlink check lets direct access
      // through, where a foreign-site Referer would be blocked.
      referrerPolicy: 'no-referrer',
      credentials: 'omit',
      signal: opts.signal,
    });
    if (!resp.ok) return null;
    const ct = (resp.headers.get('content-type') || '').toLowerCase();
    if (!ct.startsWith('image/')) return null; // hotlink block pages return text/html
    const buf = await resp.arrayBuffer();
    if (buf.byteLength === 0 || buf.byteLength > maxBytes) return null;
    return `data:${ct.split(';')[0]};base64,${abToBase64(buf)}`;
  } catch {
    return null;
  }
}
