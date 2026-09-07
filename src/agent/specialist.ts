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

import { generateText, generateImage as aiGenerateImage } from 'ai';
import { restBaseUrl, sdkKindFor, type LlmProfile } from '../config/llm-config';
import { toLanguageModel, toImageModel, providerHasImageModel } from '../config/model';
import { toVisionDataUrl } from './fetch-image';
import { anySignal } from './resilience';

type FetchLike = typeof fetch;

/** A specialist sub-call (vision describe / image gen) is one-shot, not the
 * agent loop — bound it by an overall deadline so a stalled endpoint can't hang
 * the session (vision-describe runs at session startup, before the loop even
 * begins). Generous enough for a slow image-gen model. F-34 class (§10.27). */
const SPECIALIST_TIMEOUT_MS = 180_000;

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
    signal: anySignal([opts.signal, AbortSignal.timeout(SPECIALIST_TIMEOUT_MS)]),
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
  // Dedicated providers store an empty base URL (the AI SDK bakes it in for the
  // main chat client); resolve their canonical REST base for these raw sub-calls.
  return postJsonAbsolute(
    `${restBaseUrl(profile).replace(/\/$/, '')}${path}`,
    profile.apiKey,
    body,
    opts,
  );
}

/**
 * Shape an inlined image for a specific provider's `image_url.url` field.
 * Providers disagree on the base64 shape (§10.24 addendum):
 *   - Aliyun/OpenAI-compatible: FULL data URL (`data:image/<fmt>;base64,…`) —
 *     a bare payload is treated as a URL to download → timeout 400.
 *   - GLM (bigmodel.cn): official examples pass the RAW base64 payload with NO
 *     `data:` prefix; the gateway has been seen choking on data: URLs
 *     ("only ASCII characters"). Docs: docs.bigmodel.cn glm-4.6v.
 * http(s) refs pass through untouched either way.
 */
export function imageUrlForProvider(
  profile: Pick<LlmProfile, 'provider' | 'baseUrl'>,
  ref: string,
): string {
  if (!ref.startsWith('data:')) return ref;
  const isGlm = profile.provider === 'glm' || /bigmodel\.cn/i.test(profile.baseUrl);
  if (!isGlm) return ref;
  const i = ref.indexOf(';base64,');
  return i === -1 ? ref : ref.slice(i + ';base64,'.length);
}

/**
 * Can the provider's server download http(s) image URLs itself? Kimi/Moonshot
 * explicitly canNOT — its vision docs state image URLs are "not supported; only
 * base64-encoded image content is currently supported" (platform.moonshot.cn,
 * §10.24 addendum). For such providers
 * a raw-URL fallback is guaranteed to 400 the WHOLE request; callers should
 * drop the unfetchable image instead.
 */
export function providerAcceptsHttpImageUrl(
  profile: Pick<LlmProfile, 'provider' | 'baseUrl'>,
): boolean {
  return !(profile.provider === 'kimi' || /moonshot\.(cn|ai)|kimi\.com/i.test(profile.baseUrl));
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
 * view_image tool result).
 *
 * Every image is inlined as a normalized base64 data URL BEFORE the call
 * (toVisionDataUrl): sending a raw http URL makes the PROVIDER's server fetch
 * it, which fails on hotlink-protected/slow CDNs — GLM 1210, Aliyun/qwen 400
 * "Download multimodal file timed out" (§10.24). Unfetchable images are
 * dropped (noted in the answer); all-dropped throws a clear next-step error.
 */
export async function visionDescribe(
  profile: LlmProfile,
  images: string[],
  question: string,
  opts: { signal?: AbortSignal; fetchImpl?: FetchLike } = {},
): Promise<string> {
  const prepared: string[] = [];
  let dropped = 0;
  for (const ref of images) {
    const dataUrl = await toVisionDataUrl(ref, { signal: opts.signal, fetchImpl: opts.fetchImpl });
    if (dataUrl) prepared.push(dataUrl);
    else dropped++;
  }
  if (prepared.length === 0) {
    throw new Error(
      'None of the images could be read (download failed / timeout / too large / not an image format). Suggestion: first take a screenshot of the page (which yields a data:image result) and then view_image, or use a different accessible image.',
    );
  }
  const q = question || 'Describe the content of these images in detail.';
  const text = await describeImages(profile, prepared, q, opts);
  if (!text) throw new Error('vision model returned no content');
  return dropped > 0 ? `${text}\n\n(${dropped} more image(s) could not be read and were skipped)` : text;
}

/** The vision request itself. Native providers (Anthropic/Google/OpenAI/xAI/…)
 * go through the AI SDK — so any of them can drive the vision slot. Only the
 * OpenAI-compatible endpoints (GLM/Kimi/Qwen/Custom) stay on the raw fetch,
 * where the per-provider image-URL quirks (GLM raw base64, Kimi no-http-URL)
 * still apply — the AI SDK can't express those. */
async function describeImages(
  profile: LlmProfile,
  prepared: string[],
  question: string,
  opts: { signal?: AbortSignal; fetchImpl?: FetchLike },
): Promise<string | undefined> {
  if (sdkKindFor(profile.provider) === 'openai-compatible') {
    const json = (await postJson(
      profile,
      '/chat/completions',
      {
        model: profile.model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: question },
              ...prepared.map((url) => ({
                type: 'image_url',
                image_url: { url: imageUrlForProvider(profile, url) },
              })),
            ],
          },
        ],
        max_tokens: 1500,
      },
      opts,
    )) as { choices?: Array<{ message?: { content?: string } }> };
    return json.choices?.[0]?.message?.content;
  }
  const { text } = await generateText({
    model: toLanguageModel({
      provider: profile.provider,
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      model: profile.model,
    }),
    maxOutputTokens: 1500,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: question },
          ...prepared.map((url) => ({ type: 'image' as const, image: url })),
        ],
      },
    ],
    abortSignal: anySignal([opts.signal, AbortSignal.timeout(SPECIALIST_TIMEOUT_MS)]),
  });
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

  // Native providers with an AI SDK image model (OpenAI DALL-E, Google Imagen,
  // xAI Grok image) — so any of them can drive the image slot.
  if (providerHasImageModel(profile.provider)) {
    const { images } = await aiGenerateImage({
      model: toImageModel({
        provider: profile.provider,
        apiKey: profile.apiKey,
        baseUrl: profile.baseUrl,
        model: profile.model,
      }),
      prompt,
      ...(opts.n && opts.n > 1 ? { n: opts.n } : {}),
      ...(opts.size ? { size: opts.size as `${number}x${number}` } : {}),
      abortSignal: anySignal([opts.signal, AbortSignal.timeout(SPECIALIST_TIMEOUT_MS)]),
    });
    const dataUrls = images.map((img) => `data:${img.mediaType ?? 'image/png'};base64,${img.base64}`);
    if (dataUrls.length === 0) throw new Error('image model returned no images');
    return { urls: [], dataUrls };
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
