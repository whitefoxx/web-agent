/**
 * SSE streaming pure helpers (src/agent/stream.ts). docs §10.8.
 */
import { describe, expect, it } from 'vitest';
import { createStreamAccumulator, parseSSEChunk } from '../src/agent/stream';

describe('parseSSEChunk', () => {
  it('parses complete data lines and keeps the incomplete tail', () => {
    const { events, rest } = parseSSEChunk('data: {"a":1}\ndata: {"b":2}\ndata: {"c":');
    expect(events).toEqual([{ a: 1 }, { b: 2 }]);
    expect(rest).toBe('data: {"c":');
  });
  it('skips [DONE], blanks, and CRLF', () => {
    const { events } = parseSSEChunk('data: [DONE]\r\n\r\ndata: {"x":1}\r\n');
    expect(events).toEqual([{ x: 1 }]);
  });
  it('tolerates a garbage line', () => {
    const { events } = parseSSEChunk('data: not json\ndata: {"ok":true}\n');
    expect(events).toEqual([{ ok: true }]);
  });
});

describe('createStreamAccumulator', () => {
  it('accumulates content + reasoning across deltas', () => {
    const acc = createStreamAccumulator();
    acc.push({ choices: [{ delta: { role: 'assistant', content: 'He' } }] });
    acc.push({ choices: [{ delta: { reasoning_content: '想…' } }] });
    acc.push({ choices: [{ delta: { content: 'llo' }, finish_reason: 'stop' }] });
    const r = acc.result();
    expect(r.content).toBe('Hello');
    expect(r.reasoning_content).toBe('想…');
    expect(r.finish_reason).toBe('stop');
    expect(r.tool_calls).toEqual([]);
  });
  it('assembles tool_calls by index across deltas', () => {
    const acc = createStreamAccumulator();
    acc.push({
      choices: [
        {
          delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'foo', arguments: '' } }] },
        },
      ],
    });
    acc.push({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":' } }] } }],
    });
    acc.push({
      choices: [
        {
          delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] },
          finish_reason: 'tool_calls',
        },
      ],
    });
    const r = acc.result();
    expect(r.tool_calls).toEqual([
      { id: 'c1', type: 'function', function: { name: 'foo', arguments: '{"a":1}' } },
    ]);
    expect(r.finish_reason).toBe('tool_calls');
  });
  it('captures a trailing usage chunk', () => {
    const acc = createStreamAccumulator();
    acc.push({ choices: [{ delta: { content: 'x' } }] });
    acc.push({ choices: [], usage: { prompt_tokens: 42, total_tokens: 50 } });
    expect(acc.result().usage).toEqual({ prompt_tokens: 42, total_tokens: 50 });
  });
});
