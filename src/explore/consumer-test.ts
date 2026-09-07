/**
 * ⑪ Consumer test ("cold reader"). After a read adapter verifies, we hand a FRESH
 * LLM call ONLY the adapter's public spec — name / site / description / args —
 * with NONE of the explore context that produced it, and ask: "could a caller who
 * sees only this use it correctly?" The author (main explore loop) always thinks
 * its own adapter is usable; an independent reader catches a description that
 * assumes background knowledge or an arg with no hint of its legal values.
 *
 * The verdict rides the existing verify-warnings channel (agent-facing), so the
 * agent can sharpen the description/args before relying on the tool. One small,
 * timeout-bounded, fail-open LLM call per verified read adapter. Pure parser split
 * out for unit testing; the model call reuses the synth chatCompletion path.
 */

import { chatCompletion } from '../agent/api-engine';
import { anySignal } from '../agent/resilience';
import { warn } from '@base/runtime/log';
import type { SynthModel } from './synthesize';

/** Bound the cold-reader call — it's a small ask; 60s is a generous ceiling. */
const CONSUMER_TIMEOUT_MS = 60_000;

export interface ConsumerSpec {
  name: string;
  site: string;
  description?: string;
  args?: Array<{ name: string; help?: string; required?: boolean; type?: string }>;
}

export interface ConsumerVerdict {
  /** True = a cold reader could use it correctly from the spec alone. */
  clear: boolean;
  /** A minimal invocation the reader proposed (for the agent to sanity-check). */
  invocation?: string;
  /** Spec gaps a reader would have to guess at (empty when clear). */
  unclear: string[];
}

const SYSTEM = `You are a "cold reader" consumer: you only get a tool's name/site/description/argument table — you can't see how it was built and have no page context. Task: judge "from this spec alone, can a caller use it correctly?".
- Give one minimal usable invocation (concrete argument values), as if you were really about to use it.
- List anything that "would trip you up reading the spec, so you'd have to guess": args missing valid values/ranges, vague descriptions or assumed background knowledge, required-but-unexplained, unclear return content, ambiguous naming. Better to over-list (under-triggering beats missing one).
- Judge only from the spec you're given; don't imagine behavior it "should" have.
Output only one JSON object, no extra text: {"clear": true or false, "invocation": "<site>__<name>({...})", "unclear": ["...", "..."]}. If the spec is self-sufficient, clear:true, unclear:[].`;

/** Run the cold-reader check. Returns null (skip, no warning) on any failure —
 * a spec-quality hint must never block or fail a synthesis. */
export async function consumerTest(
  spec: ConsumerSpec,
  model: SynthModel,
  opts: { signal?: AbortSignal } = {},
): Promise<ConsumerVerdict | null> {
  const timeout = AbortSignal.timeout(CONSUMER_TIMEOUT_MS);
  try {
    const resp = await chatCompletion({
      apiKey: model.apiKey,
      baseUrl: model.baseUrl,
      provider: model.provider,
      signal: anySignal([opts.signal, timeout]),
      body: {
        model: model.model,
        messages: [
          { role: 'system', content: SYSTEM },
          {
            role: 'user',
            content: JSON.stringify({
              name: spec.name,
              site: spec.site,
              description: spec.description ?? '',
              args: (spec.args ?? []).map((a) => ({
                name: a.name,
                type: a.type,
                required: a.required,
                help: a.help,
              })),
            }),
          },
        ],
        max_tokens: 800,
      },
    });
    return parseConsumerVerdict(resp.choices?.[0]?.message?.content ?? '');
  } catch (e) {
    warn('explore', 'consumer test failed (skipped)', e);
    return null;
  }
}

/** Extract the verdict JSON from the model's reply (may be fenced or prose-
 * wrapped). Pure; returns null when there's no parseable object. */
export function parseConsumerVerdict(content: string): ConsumerVerdict | null {
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let o: unknown;
  try {
    o = JSON.parse(m[0]);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;
  const rec = o as Record<string, unknown>;
  const unclear = Array.isArray(rec.unclear)
    ? rec.unclear
        .filter((x): x is string => typeof x === 'string')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 6)
    : [];
  const clear = typeof rec.clear === 'boolean' ? rec.clear : unclear.length === 0;
  const invocation = typeof rec.invocation === 'string' ? rec.invocation.trim() : undefined;
  return { clear, unclear, ...(invocation ? { invocation } : {}) };
}

/** Turn a verdict into a one-line warning for the verify-warnings channel (or
 * null when the spec is clear — no noise). Pure. */
export function consumerWarning(v: ConsumerVerdict | null): string | null {
  if (!v) return null;
  if (v.clear || v.unclear.length === 0) return null;
  return `Consumer cold-read check: the spec may not be self-sufficient (a caller reading only description/args would get stuck on) — ${v.unclear.join('; ')}. Consider clarifying the description/arg help, then re-run synthesize_adapter with the same name.`;
}
