/**
 * Builds a Vercel AI SDK LanguageModel from a stored LLM config. Each dedicated
 * `@ai-sdk/<provider>` package bakes in the base URL and the provider's wire
 * quirks, so a profile only carries { provider, apiKey, model } — no base URL
 * and no adapter code, and Vercel maintains provider drift. The universal
 * `openai-compatible` package covers the rest (GLM/Kimi/MiniMax/Qwen/Custom),
 * taking the base URL from the config (preset table or user-typed).
 *
 * Runs in the extension's background service worker: the AI SDK providers are
 * plain fetch builders (no DOM), and the extension's <all_urls> host permission
 * means no CORS constraint — Anthropic needs no browser header here.
 */
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createXai } from '@ai-sdk/xai';
import { createGroq } from '@ai-sdk/groq';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel, ImageModel } from 'ai';
import { sdkKindFor } from './llm-config';

export interface ModelSpec {
  /** Provider preset id (e.g. 'anthropic', 'deepseek', 'glm', 'custom'). */
  provider: string;
  apiKey: string;
  /** Only used by the openai-compatible packages; ignored by dedicated ones. */
  baseUrl: string;
  model: string;
}

export function toLanguageModel(spec: ModelSpec): LanguageModel {
  const { apiKey, model } = spec;
  switch (sdkKindFor(spec.provider)) {
    case 'anthropic':
      return createAnthropic({ apiKey })(model);
    case 'openai':
      // Chat Completions endpoint — broadest compatibility, streams tool calls.
      return createOpenAI({ apiKey })(model);
    case 'deepseek':
      return createDeepSeek({ apiKey })(model);
    case 'google':
      return createGoogleGenerativeAI({ apiKey })(model);
    case 'xai':
      return createXai({ apiKey })(model);
    case 'groq':
      return createGroq({ apiKey })(model);
    default:
      // GLM/Kimi/MiniMax/Qwen/Custom — base URL from the config.
      return createOpenAICompatible({
        name: spec.provider || 'custom',
        baseURL: spec.baseUrl,
        apiKey,
      })(model);
  }
}

/** Whether this provider exposes an AI SDK image-generation model (so a native
 *  provider can drive the `image` specialist slot). The rest (openai-compatible,
 *  Anthropic, DeepSeek, Groq) go through the raw `/images/generations` path or
 *  have no image generation at all. */
export function providerHasImageModel(providerId: string): boolean {
  const kind = sdkKindFor(providerId);
  return kind === 'openai' || kind === 'google' || kind === 'xai';
}

/** Build an AI SDK image model for the providers that support one. Throws for
 *  the rest — callers gate on providerHasImageModel() first. */
export function toImageModel(spec: ModelSpec): ImageModel {
  switch (sdkKindFor(spec.provider)) {
    case 'openai':
      return createOpenAI({ apiKey: spec.apiKey }).image(spec.model);
    case 'google':
      return createGoogleGenerativeAI({ apiKey: spec.apiKey }).image(spec.model);
    case 'xai':
      return createXai({ apiKey: spec.apiKey }).image(spec.model);
    default:
      throw new Error(`provider ${spec.provider} has no AI SDK image model`);
  }
}
