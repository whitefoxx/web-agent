/**
 * Fetch an image and return it as a base64 data URL, so it can be sent to a
 * vision model as image bytes rather than a URL the model's server must fetch.
 *
 * WHY (docs/architecture.md §8.5, agent-harness.md §10.24): passing a raw image
 * URL to a vision endpoint only works if THAT server can fetch it. Many site
 * CDNs (weibo's sinaimg.cn, xiaohongshu's xhscdn, …) are hotlink-protected or
 * simply slow from the provider's network — a foreign server fetch gets a
 * 403/HTML block page or times out. Symptoms seen in the wild:
 *   - GLM: "image input format / parse error" (code 1210)
 *   - Aliyun/qwen: 400 "Download multimodal file timed out"
 * The extension has `host_permissions: <all_urls>`, so the service worker can
 * fetch the bytes directly (with no Referer — direct access is what those CDNs
 * allow) and hand the model a self-contained data URL, which per the providers'
 * docs must be `data:image/<fmt>;base64,<clean-payload>`.
 *
 * Guards: image content only (content-type OR magic-byte sniff — some CDNs
 * serve images as application/octet-stream), a byte cap (vision endpoints + our
 * IDB persistence both dislike giant blobs), a fetch timeout, and never throws —
 * a failed image returns null so the caller can drop or fall back.
 */

/** Skip images larger than this (decoded bytes). ~6 MB keeps base64 (~8 MB) well
 * under typical vision request limits. */
export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

/** Don't let one slow CDN hang the whole vision call. */
export const FETCH_IMAGE_TIMEOUT_MS = 20_000;

/** MIMEs vision endpoints broadly accept (qwen doc: jpeg/png/webp; gif/bmp are
 * tolerated by most OpenAI-compatible gateways). SVG deliberately excluded. */
const IMAGE_MIME_RE = /^image\/(png|jpe?g|webp|gif|bmp)$/i;

function abToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000; // avoid String.fromCharCode stack overflow on big arrays
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** Identify a raster image from its magic bytes; null if not a known image.
 * The formats vision endpoints accept: png / jpeg / webp / gif / bmp. */
export function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return 'image/gif';
  }
  // RIFF....WEBP
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  return null;
}

/** Canonical MIME (jpg → jpeg, lowercase). */
function canonMime(m: string): string {
  const t = m.trim().toLowerCase();
  return t === 'image/jpg' ? 'image/jpeg' : t;
}

/**
 * Normalize a `data:` ref into the strict provider shape
 * `data:image/<fmt>;base64,<payload-without-whitespace>` (Aliyun rejects — by
 * trying to DOWNLOAD as a URL — anything that doesn't parse as a data URL, e.g.
 * payloads with stray newlines; see §10.24). A wrong/generic MIME header
 * (application/octet-stream, image/*) is repaired by sniffing the decoded magic
 * bytes. Returns null for non-base64 payloads, non-image content, or oversize.
 */
export function normalizeImageDataUrl(ref: string, maxBytes = MAX_IMAGE_BYTES): string | null {
  const m = /^data:([^;,]*);base64,([\s\S]*)$/i.exec(ref.trim());
  if (!m) return null; // non-base64 data URLs (utf8 svg etc.) — not vision input
  const payload = m[2].replace(/\s+/g, '');
  if (!payload) return null;
  // Base64 length ≈ bytes * 4/3 — cheap pre-check before decode.
  if (payload.length > (maxBytes * 4) / 3 + 4) return null;
  let head: Uint8Array;
  try {
    const sample = atob(payload.slice(0, 24));
    head = Uint8Array.from(sample, (c) => c.charCodeAt(0));
  } catch {
    return null; // not valid base64
  }
  const sniffed = sniffImageMime(head);
  const declared = canonMime(m[1] || '');
  const mime = IMAGE_MIME_RE.test(declared) ? declared : sniffed;
  if (!mime) return null;
  return `data:${mime};base64,${payload}`;
}

/**
 * Turn an image reference into a base64 data URL suitable for an `image_url`
 * vision block. `data:` refs (screenshots) are normalized (whitespace stripped,
 * MIME repaired by sniffing). http(s) refs are fetched in the SW with no
 * Referer (hotlink bypass) and converted; content is accepted when either the
 * content-type or the magic bytes say "image" (some CDNs serve octet-stream).
 * Returns null on any failure / non-image / oversize — caller drops or falls
 * back.
 *
 * `fetchImpl` is injectable for tests.
 */
export async function toVisionDataUrl(
  ref: string,
  opts: {
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    maxBytes?: number;
    timeoutMs?: number;
  } = {},
): Promise<string | null> {
  const trimmed = ref.trim();
  const maxBytes = opts.maxBytes ?? MAX_IMAGE_BYTES;
  if (trimmed.startsWith('data:')) return normalizeImageDataUrl(trimmed, maxBytes);
  if (!/^https?:\/\//i.test(trimmed)) return null;
  const doFetch = opts.fetchImpl ?? fetch;
  // Own timeout + caller's abort, without AbortSignal.any (not everywhere yet).
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? FETCH_IMAGE_TIMEOUT_MS);
  const onCallerAbort = (): void => ctl.abort();
  if (opts.signal?.aborted) ctl.abort();
  else opts.signal?.addEventListener('abort', onCallerAbort, { once: true });
  try {
    const resp = await doFetch(trimmed, {
      // No Referer: that's exactly how a CDN's hotlink check lets direct access
      // through, where a foreign-site Referer would be blocked.
      referrerPolicy: 'no-referrer',
      credentials: 'omit',
      signal: ctl.signal,
    });
    if (!resp.ok) return null;
    // Bail on an oversized body WITHOUT buffering it all into SW memory first: an
    // honest server declares Content-Length (fast reject); a missing/lying one is
    // caught by readCapped's streaming cap (stops past maxBytes). Prevents an OOM
    // on a huge/malicious response, which the old "arrayBuffer() then check" hit.
    // See docs/health-audit-2026-07.md Tier3-#16.
    const clHeader = resp.headers.get('content-length');
    const declaredLen = clHeader != null ? Number(clHeader) : NaN;
    if (Number.isFinite(declaredLen) && declaredLen > maxBytes) return null;
    const buf = await readCapped(resp, maxBytes);
    if (!buf || buf.byteLength === 0) return null;
    const declared = canonMime((resp.headers.get('content-type') || '').split(';')[0]);
    const sniffed = sniffImageMime(new Uint8Array(buf, 0, Math.min(16, buf.byteLength)));
    // Trust the bytes first (octet-stream images pass, spoofed .jpg block pages
    // don't); a declared image/* type without recognizable magic still passes
    // (unusual-but-valid encodings) — text/html without image magic never does.
    const mime = sniffed ?? (IMAGE_MIME_RE.test(declared) ? declared : null);
    if (!mime) return null;
    return `data:${mime};base64,${abToBase64(buf)}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onCallerAbort);
  }
}

/** Read a response body into an ArrayBuffer but STOP past `maxBytes`, so a
 * missing/lying Content-Length can't OOM the SW by buffering an unbounded body.
 * Falls back to arrayBuffer()+guard when the impl exposes no stream (test mocks
 * / non-streaming fetch polyfills). Returns null when over the cap. */
async function readCapped(resp: Response, maxBytes: number): Promise<ArrayBuffer | null> {
  const reader = resp.body?.getReader?.();
  if (!reader) {
    const b = await resp.arrayBuffer();
    return b.byteLength > maxBytes ? null : b;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null; // oversized — stop reading, don't buffer any more
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out.buffer;
}
