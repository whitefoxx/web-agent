/**
 * Route the intercepted specialist pseudo-tools (view_image / generate_image) to
 * the configured capability-slot models. view_image is either inline (the primary
 * is multimodal → return an ack + the URLs to inject) or a sub-call to a separate
 * vision model (→ return its description as text). generate_image always sub-calls
 * the image-gen model. Never throws. Split out of api-engine.ts.
 */

import { log } from '@base/runtime/log';
import { visionDescribe, generateImage } from './specialist';
import { normalizeImageDataUrl } from './fetch-image';
import { needsBaseUrl, type LlmProfile } from '../config/llm-config';
import { MAX_VISION_IMAGES_PER_TURN } from './engine-tools';

/** A URL `view_image` can hand to a vision model: an http(s) URL, OR a base64
 * `data:image/…` URL — notably one of our OWN `screenshot` results. data: refs
 * must actually PARSE as an image data URL (normalizeImageDataUrl) — a bare
 * prefix check let the model's echoed redaction placeholder
 * ("data:image/png;base64,[image omitted]") sail through as "valid" (§10.25). */
export function isViewableImageUrl(u: string): boolean {
  const s = u.trim();
  if (/^https?:\/\//i.test(s)) return true;
  if (/^data:/i.test(s)) return normalizeImageDataUrl(s) !== null;
  return false;
}

export interface SpecialistResult {
  ok: boolean;
  /** The tool message content handed back to the primary (the specialist's
   * answer for a sub-call, or an ack for inline / an error message). */
  toolContent: string;
  /** URLs to inject into the PRIMARY's own context (only the inline-vision
   * case — primary is multimodal); undefined for sub-calls. */
  inlineImages?: string[];
  traceResult?: unknown;
}

/** Route a specialist tool call (view_image / generate_image) to the capability
 * slot's model. view_image is either inline (primary is multimodal → inject) or
 * a sub-call to a separate vision model (→ return its description as text).
 * generate_image always sub-calls the image-gen model. Never throws. */
export async function handleSpecialistCall(
  name: string,
  args: Record<string, unknown>,
  ctx: {
    visionProfile: LlmProfile | null;
    visionInline: boolean;
    imageProfile: LlmProfile | null;
    signal?: AbortSignal;
    /** Resolve an `img_N` registry token (from redacted tool-result text) back
     * to its real ref — how a text-only primary references a screenshot whose
     * bytes it never saw (§10.25). */
    resolveImageRef?: (token: string) => string | null;
    availableImageIds?: () => string[];
  },
): Promise<SpecialistResult> {
  if (name === 'view_image') {
    const reqUrls = Array.isArray((args as { images?: unknown }).images)
      ? (args as { images: unknown[] }).images.filter((u): u is string => typeof u === 'string')
      : [];
    // [img_N] registry tokens resolve to their registered ref first; everything
    // else passes through. Trust the model's intent: accept any http(s) URL OR
    // a data:image/… base64 URL — no image-pattern gating.
    const resolved = reqUrls.map((u) => ctx.resolveImageRef?.(u) ?? u);
    const valid = resolved.filter(isViewableImageUrl).slice(0, MAX_VISION_IMAGES_PER_TURN);
    if (valid.length === 0) {
      // The classic dead-end: the model echoed the redaction placeholder (or an
      // expired/unknown img_N). Point it at what it CAN use, precisely.
      const ids = ctx.availableImageIds?.() ?? [];
      const echoedPlaceholder = reqUrls.some((u) => u.includes('image omitted') || /img_\d+/.test(u));
      const hint = ids.length
        ? `Available image references: ${ids.join(', ')} — pass that id (e.g. "${ids[ids.length - 1]}") directly as an element of the images array.`
        : 'No images are registered in this session yet. To view page content, first call generic__screenshot; its result will appear as an [img_N] reference, then view_image("img_N").';
      return {
        ok: false,
        toolContent:
          (echoedPlaceholder
            ? 'What was passed is not a real image address (that is a redaction placeholder / unknown reference).'
            : 'No usable image address (must be an http/https URL, data:image/... base64, or an [img_N] image reference).') +
          ' ' +
          hint,
      };
    }
    const question = typeof args.purpose === 'string' ? args.purpose : '';
    if (ctx.visionInline) {
      const dropped = resolved.length - valid.length;
      return {
        ok: true,
        toolContent: `Received ${valid.length} image(s); they will be presented to you as images${dropped > 0 ? ` (${dropped} invalid address(es) ignored)` : ''}.`,
        inlineImages: valid,
        traceResult: { mode: 'inline', accepted: valid },
      };
    }
    if (!ctx.visionProfile) return { ok: false, toolContent: 'No vision model configured.' };
    if (
      !ctx.visionProfile.apiKey ||
      (needsBaseUrl(ctx.visionProfile.provider) && !ctx.visionProfile.baseUrl)
    ) {
      return {
        ok: false,
        toolContent: 'Vision model is missing its API Key or Base URL; check it under "Model roles".',
      };
    }
    log('api', `vision subcall → ${ctx.visionProfile.model} (${valid.length} image(s))`, {
      baseUrl: ctx.visionProfile.baseUrl,
    });
    try {
      const desc = await visionDescribe(ctx.visionProfile, valid, question, { signal: ctx.signal });
      log('api', `vision subcall ← ${ctx.visionProfile.model} (${desc.length} chars)`);
      return {
        ok: true,
        toolContent: desc,
        traceResult: { mode: 'subcall', model: ctx.visionProfile.model, images: valid },
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // A base64 data: URL (e.g. a screenshot) that 4xx's usually means this
      // provider's gateway only accepts http(s) image URLs (some choke with a
      // Python "only ASCII characters" error on a data URL). Surface that as a
      // next step instead of a cryptic upstream 400.
      const sentDataUrl = valid.some((u) => /^data:/i.test(u.trim()));
      const hint =
        sentDataUrl && /\b4\d\d\b|ascii|bad ?request|invalid/i.test(msg)
          ? '\nTip: this call submitted a data:/base64 screenshot. This vision provider may only support http(s) image addresses — switch to a vision model that supports data: URLs (change the vision slot under "Model roles"), or provide an http link to an image.'
          : '';
      return {
        ok: false,
        toolContent: `Vision model (${ctx.visionProfile.model}) call failed: ${msg}${hint}`,
      };
    }
  }

  if (name === 'generate_image') {
    if (!ctx.imageProfile) return { ok: false, toolContent: 'No image-generation model configured.' };
    if (
      !ctx.imageProfile.apiKey ||
      (needsBaseUrl(ctx.imageProfile.provider) && !ctx.imageProfile.baseUrl)
    ) {
      return {
        ok: false,
        toolContent:
          'Image-generation model is missing its API Key or Base URL; check it under "Model roles".',
      };
    }
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    if (!prompt) return { ok: false, toolContent: 'prompt must not be empty.' };
    const size = typeof args.size === 'string' ? args.size : undefined;
    log('api', `image subcall → ${ctx.imageProfile.model}`, { baseUrl: ctx.imageProfile.baseUrl });
    try {
      const out = await generateImage(ctx.imageProfile, prompt, { size, signal: ctx.signal });
      log(
        'api',
        `image subcall ← ${ctx.imageProfile.model} (${out.urls.length} url, ${out.dataUrls.length} b64)`,
      );
      // base64 results have no URL to relay; if the primary is multimodal, inline
      // them so the generated image isn't lost (it can describe/use it).
      const inlineImages =
        out.urls.length === 0 && ctx.visionInline && out.dataUrls.length ? out.dataUrls : undefined;
      const content = out.urls.length
        ? `Generated ${out.urls.length} image(s). Show them to the user inline via markdown (do not view_image them again):\n${out.urls
            .map((u) => `![generated image](${u})`)
            .join('\n')}`
        : `Generated ${out.dataUrls.length} image(s) (the model returned base64 data${inlineImages ? ', now presented to you as images' : ''}).`;
      return {
        ok: true,
        toolContent: content,
        inlineImages,
        traceResult: { urls: out.urls, dataUrls: out.dataUrls.length },
      };
    } catch (e) {
      return {
        ok: false,
        toolContent: `Image generation (${ctx.imageProfile.model}) failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  return { ok: false, toolContent: `Unknown specialist tool: ${name}` };
}
