/**
 * Pull image references out of a tool result so a vision-capable model can be
 * shown them (api-engine feeds these as `image_url` content blocks).
 *
 * Two kinds are recognised:
 *   - `data:image/...;base64,...` data URLs (e.g. generic__screenshot's dataUrl)
 *   - http(s) URLs that look like images (path ends in a known image extension,
 *     query/hash tolerated) — e.g. weibo__post's `pics`
 *
 * Recursively scans the result (object/array), dedupes, and caps the count so a
 * result packed with images can't blow up the request (vision tokens are dear).
 * Order is preserved (first-seen wins) so the model sees images in result order.
 *
 * Heuristic by design: a stray non-image URL ending in `.png` would be picked
 * up, and avatar/thumbnail URLs in a richer payload could sneak in. The cap
 * bounds the blast radius; callers gate the whole thing on a per-profile
 * `vision` flag so text-only setups are unaffected.
 */

/** Path ends in a RASTER image extension, optionally followed by ?query / #hash.
 * SVG is deliberately excluded — it's vector XML and most vision endpoints
 * (gpt-4o, GLM-V) reject `image/svg+xml`, which would 400 the request the
 * vision gate exists to protect. */
const IMG_EXT_RE = /\.(jpe?g|png|gif|webp|bmp|avif)(?:[?#].*)?$/i;
const HTTP_RE = /^https?:\/\//i;
const DATA_IMG_RE = /^data:image\//i;
const DATA_SVG_RE = /^data:image\/svg/i;

/** Known image-CDN hosts that serve EXTENSION-LESS image URLs (the format is
 * negotiated via query/headers, not a `.jpg` suffix). Without this, xiaohongshu
 * (`ci.xiaohongshu.com/<id>`, `*.xhscdn.com/<id>`) and similar would be missed
 * entirely. Matched on a dot-boundary so only these hosts + their subdomains
 * qualify. Kept tight to image CDNs to avoid pulling in non-image API URLs. */
const IMG_HOST_SUFFIXES = [
  'xhscdn.com', // xiaohongshu / rednote image CDN
  'ci.xiaohongshu.com',
  'sinaimg.cn', // weibo (also extension-bearing, but cheap to include)
  'hdslb.com', // bilibili image/static CDN
  'zhimg.com', // zhihu image CDN
  'pximg.net', // pixiv
];

export const DEFAULT_IMAGE_CAP = 6;

function isImageHost(u: string): boolean {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return IMG_HOST_SUFFIXES.some((s) => h === s || h.endsWith('.' + s));
  } catch {
    return false;
  }
}

function looksLikeImage(s: string): boolean {
  const t = s.trim();
  if (DATA_IMG_RE.test(t)) return !DATA_SVG_RE.test(t); // raster data URLs only
  if (!HTTP_RE.test(t)) return false;
  // Path ends in a raster extension, OR it's a known image-CDN host (xhs etc.
  // serve extension-less image URLs).
  return IMG_EXT_RE.test(t) || isImageHost(t);
}

/**
 * Collect up to `cap` image references (data URLs + http image URLs) from an
 * arbitrary tool result value. Deterministic, side-effect free.
 */
export function collectImageRefs(value: unknown, cap = DEFAULT_IMAGE_CAP): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const visit = (v: unknown, depth: number): void => {
    // root is depth 0, so `depth > 8` allows up to 9 nesting levels — generous
    // for the bounded, already-truncated tool-result shapes we see.
    if (out.length >= cap || depth > 8) return;
    if (typeof v === 'string') {
      const s = v.trim();
      if (looksLikeImage(s) && !seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) {
        if (out.length >= cap) break;
        visit(x, depth + 1);
      }
      return;
    }
    if (v && typeof v === 'object') {
      for (const x of Object.values(v as Record<string, unknown>)) {
        if (out.length >= cap) break;
        visit(x, depth + 1);
      }
    }
  };

  visit(value, 0);
  return out;
}

/** True if `ref` is a base64 data URL (vs. an http image URL). */
export function isDataUrl(ref: string): boolean {
  return DATA_IMG_RE.test(ref.trim());
}

/** Replace every `data:image/...;base64,...` blob in a text blob with a short
 * placeholder, so a screenshot's hundreds-of-KB base64 doesn't bloat the tool
 * result text (the image is sent as a vision block instead, or dropped). */
const DATA_URL_BLOB_RE = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g;
export function stripDataUrls(text: string): string {
  return text.replace(DATA_URL_BLOB_RE, '[图片已省略]');
}
