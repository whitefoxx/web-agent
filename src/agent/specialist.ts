/**
 * Specialist sub-calls — one-shot API calls the orchestrator delegates to a
 * model assigned to a capability slot (vision / image-gen). NOT the agent loop:
 * each is a single request whose result is handed back to the primary as a tool
 * result. See docs/architecture.md §8.6.
 *
 * All calls are OpenAI-compatible:
 *   - vision:    POST {baseUrl}/chat/completions  with image_url content
 *   - image gen: POST {baseUrl}/images/generations
 * `fetchImpl` is injectable for tests.
 */

import type { LlmProfile } from '../config/llm-config';

type FetchLike = typeof fetch;

async function postJsonAbsolute(
  url: string,
  apiKey: string,
  body: unknown,
  opts: { signal?: AbortSignal; fetchImpl?: FetchLike } = {},
): Promise<unknown> {
  const doFetch = opts.fetchImpl ?? fetch;
  const resp = await doFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`${resp.status} ${resp.statusText}: ${text.slice(0, 300)}`);
  }
  // Don't assume a 200 body is JSON — gateways/CDNs can return an HTML error /
  // captcha page with status 200. Parse explicitly so it's a clear error.
  const raw = await resp.text();
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${resp.status} non-JSON response: ${raw.slice(0, 300)}`);
  }
}

/** OpenAI-style sub-call: `{baseUrl}{path}`. */
function postJson(
  profile: LlmProfile,
  path: string,
  body: unknown,
  opts: { signal?: AbortSignal; fetchImpl?: FetchLike } = {},
): Promise<unknown> {
  return postJsonAbsolute(`${profile.baseUrl.replace(/\/$/, '')}${path}`, profile.apiKey, body, opts);
}

/** Guess the image MIME from base64 magic bytes (most providers return PNG, but
 * some return JPEG/WebP); falls back to png. */
function base64ImageMime(b64: string): string {
  if (b64.startsWith('/9j/')) return 'image/jpeg';
  if (b64.startsWith('iVBOR')) return 'image/png';
  if (b64.startsWith('UklGR')) return 'image/webp';
  if (b64.startsWith('R0lGOD')) return 'image/gif';
  return 'image/png';
}

/**
 * Ask a vision model to look at images and answer a question — used when the
 * `vision` slot is a SEPARATE model from the primary (primary is text-only).
 * Returns the vision model's text answer (handed to the primary as the
 * view_image tool result). Images are sent as raw URLs (the model fetches them).
 */
export async function visionDescribe(
  profile: LlmProfile,
  images: string[],
  question: string,
  opts: { signal?: AbortSignal; fetchImpl?: FetchLike } = {},
): Promise<string> {
  const json = (await postJson(
    profile,
    '/chat/completions',
    {
      model: profile.model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: question || '请详细描述这些图片的内容。' },
            ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
          ],
        },
      ],
      max_tokens: 1500,
    },
    opts,
  )) as { choices?: Array<{ message?: { content?: string } }> };
  const text = json.choices?.[0]?.message?.content;
  if (!text) throw new Error('vision model returned no content');
  return text;
}

export interface GeneratedImage {
  urls: string[];
  /** base64 data URLs, when the provider returns b64_json instead of url. */
  dataUrls: string[];
}

/** Aliyun/Dashscope image models (qwen-image / wanx / wan*) are NOT OpenAI-
 * compatible — they use the native multimodal-generation endpoint. Detect by
 * model name (most reliable; baseUrl may be a custom proxy). */
function isDashscopeImageModel(model: string): boolean {
  return /qwen-image|wanx|^wan[\d.-]/i.test(model.trim());
}

/** Derive the Dashscope native text-to-image endpoint from the profile baseUrl.
 * The chat baseUrl is usually `.../compatible-mode/v1`; the image API lives at
 * `.../api/v1/services/aigc/multimodal-generation/generation`. */
export function dashscopeImageEndpoint(baseUrl: string): string {
  const b = baseUrl.replace(/\/+$/, '');
  const NATIVE = '/api/v1/services/aigc/multimodal-generation/generation';
  if (b.includes('/compatible-mode/v1')) return b.replace('/compatible-mode/v1', NATIVE);
  if (b.endsWith('/api/v1')) return `${b}/services/aigc/multimodal-generation/generation`;
  return `${b}${NATIVE}`;
}

/**
 * Generate image(s) from a prompt via the `image` slot model. Two API styles:
 *   - OpenAI-compatible /images/generations (OpenAI DALL-E, GLM CogView, …)
 *   - Aliyun Dashscope native multimodal-generation (qwen-image / wanx)
 * Returns urls and/or base64 data URLs.
 */
export async function generateImage(
  profile: LlmProfile,
  prompt: string,
  opts: { size?: string; n?: number; signal?: AbortSignal; fetchImpl?: FetchLike } = {},
): Promise<GeneratedImage> {
  if (isDashscopeImageModel(profile.model)) {
    const url = dashscopeImageEndpoint(profile.baseUrl);
    const parameters: Record<string, unknown> = { n: opts.n ?? 1 };
    // Dashscope sizes use `*` (1024*1024), OpenAI uses `x` (1024x1024).
    if (opts.size) parameters.size = opts.size.replace(/x/i, '*');
    const json = (await postJsonAbsolute(
      url,
      profile.apiKey,
      {
        model: profile.model,
        input: { messages: [{ role: 'user', content: [{ text: prompt }] }] },
        parameters,
      },
      opts,
    )) as { output?: { choices?: Array<{ message?: { content?: Array<{ image?: string }> } }> } };
    const urls: string[] = [];
    for (const c of json.output?.choices ?? [])
      for (const part of c.message?.content ?? []) if (part.image) urls.push(part.image);
    if (urls.length === 0) throw new Error('image model returned no images');
    return { urls, dataUrls: [] };
  }

  // OpenAI-compatible style.
  const body: Record<string, unknown> = { model: profile.model, prompt };
  if (opts.size) body.size = opts.size;
  if (opts.n && opts.n > 1) body.n = opts.n;
  const json = (await postJson(profile, '/images/generations', body, opts)) as {
    data?: Array<{ url?: string; b64_json?: string }>;
  };
  const data = Array.isArray(json.data) ? json.data : [];
  const urls: string[] = [];
  const dataUrls: string[] = [];
  for (const d of data) {
    if (d.url) urls.push(d.url);
    else if (d.b64_json) dataUrls.push(`data:${base64ImageMime(d.b64_json)};base64,${d.b64_json}`);
  }
  if (urls.length === 0 && dataUrls.length === 0) throw new Error('image model returned no images');
  return { urls, dataUrls };
}
