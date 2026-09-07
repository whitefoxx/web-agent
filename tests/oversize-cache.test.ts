/**
 * Oversize tool-result stash + read_more paging (docs/agent-harness.md
 * §truncation) — the divide-and-conquer path to complete data.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  stashOversize,
  readChunk,
  resetOversizeCacheForTests,
} from '../src/runtime/oversize-cache';
import { truncateStash, MAX_TOOL_RESULT_CHARS } from '../src/agent/engine-history';

describe('oversize cache paging', () => {
  beforeEach(() => resetOversizeCacheForTests());

  it('pages through a stashed text with next_offset until done', () => {
    const id = stashOversize('a'.repeat(25));
    const c1 = readChunk(id, 0, 10);
    expect(c1.ok).toBe(true);
    expect(c1.chunk).toBe('a'.repeat(10));
    expect(c1.next_offset).toBe(10);
    expect(c1.done).toBe(false);
    const c3 = readChunk(id, 20, 10);
    expect(c3.chunk).toBe('a'.repeat(5));
    expect(c3.done).toBe(true);
    expect('next_offset' in c3).toBe(false);
    expect(c3.remaining).toBe(0);
  });

  it('expired / unknown ids fail with a re-run hint', () => {
    const now = 1_000_000;
    const id = stashOversize('xyz', now);
    expect(readChunk(id, 0, 10, now + 16 * 60_000).ok).toBe(false);
    expect(readChunk('ov_nope', 0, 10).error).toContain('expired or does not exist');
  });

  it('evicts the oldest entries beyond the cap', () => {
    const ids = Array.from({ length: 30 }, (_, i) => stashOversize(`t${i}`, 1_000_000 + i));
    expect(readChunk(ids[0], 0, 10, 1_000_100).ok).toBe(false); // evicted
    expect(readChunk(ids[29], 0, 10, 1_000_100).ok).toBe(true);
  });
});

describe('truncateStash marker', () => {
  beforeEach(() => resetOversizeCacheForTests());

  it('under the cap: unchanged, zero truncated', () => {
    const r = truncateStash('short');
    expect(r).toEqual({ text: 'short', truncated: 0 });
  });

  it('over the cap: marker carries a readable id+offset, and the stash serves the tail', () => {
    const body = 'x'.repeat(MAX_TOOL_RESULT_CHARS) + 'TAIL';
    const r = truncateStash(body);
    expect(r.truncated).toBe(4);
    const m = /read_more \{"id":"(ov_[a-z0-9]+)","offset":(\d+)\}/.exec(r.text);
    expect(m).toBeTruthy();
    const chunk = readChunk(m![1], Number(m![2]), 100);
    expect(chunk.chunk).toBe('TAIL');
    expect(chunk.done).toBe(true);
  });
});
