/**
 * anySignal (F-34 support): combine abort signals so the synth LLM call is
 * bounded by BOTH the caller's Stop signal AND a timeout. Pure; node.
 */

import { describe, it, expect } from 'vitest';
import { anySignal } from '../src/agent/resilience';

describe('anySignal', () => {
  it('returns the lone signal unwrapped (identity), ignoring undefined', () => {
    const c = new AbortController();
    expect(anySignal([undefined, c.signal, undefined])).toBe(c.signal);
  });

  it('with no real signals, returns one that never aborts', () => {
    const s = anySignal([undefined, undefined]);
    expect(s.aborted).toBe(false);
  });

  it('aborts as soon as the FIRST input aborts', () => {
    const a = new AbortController();
    const b = new AbortController();
    const s = anySignal([a.signal, b.signal]);
    expect(s.aborted).toBe(false);
    a.abort();
    expect(s.aborted).toBe(true);
  });

  it('aborts if EITHER input aborts (second one)', () => {
    const a = new AbortController();
    const b = new AbortController();
    const s = anySignal([a.signal, b.signal]);
    b.abort();
    expect(s.aborted).toBe(true);
  });

  it('propagates the first input reason', () => {
    const a = new AbortController();
    const b = new AbortController();
    const s = anySignal([a.signal, b.signal]);
    const reason = new DOMException('timeout', 'TimeoutError');
    a.abort(reason);
    expect(s.reason).toBe(reason);
  });

  it('is already aborted when an input was pre-aborted', () => {
    const a = new AbortController();
    a.abort(new DOMException('boom', 'AbortError'));
    const b = new AbortController();
    const s = anySignal([a.signal, b.signal]);
    expect(s.aborted).toBe(true);
    expect((s.reason as DOMException).name).toBe('AbortError');
  });
});
