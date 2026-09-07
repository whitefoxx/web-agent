/**
 * sanitizeHistory repairs a replayed message history before re-sending it:
 *   [1] dangling tool_calls (abort mid tool-loop) → pad with placeholder tool msgs
 *   [2] prior-turn image messages → always flatten to text (images live 1 turn,
 *       which also stops replaying image_url to a since-switched text-only model)
 */
import { describe, expect, it } from 'vitest';
import { sanitizeHistory } from '../src/agent/api-engine';
import type { ApiMessage } from '../src/agent/api-types';

// F-34: the interrupt placeholder now names the tool + says it's retryable, so a
// resumed model doesn't misread "no result" as "the tool doesn't exist".
const interrupted = (name: string) =>
  `[The previous call to ${name} was interrupted and did not finish (the extension's background was recycled or the request timed out) — this does NOT mean the tool is unavailable. If this step is still needed, call it again; for write operations, first verify whether the previous call already took effect.]`;

describe('sanitizeHistory — dangling tool_calls', () => {
  it('pads an assistant tool_calls message that has NO answering tool messages', () => {
    const history: ApiMessage[] = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'a', type: 'function', function: { name: 'x', arguments: '{}' } },
          { id: 'b', type: 'function', function: { name: 'y', arguments: '{}' } },
        ],
      },
      // aborted before either tool answered
    ];
    const out = sanitizeHistory(history);
    expect(out).toEqual([
      history[0],
      history[1],
      { role: 'tool', tool_call_id: 'a', content: interrupted('x') },
      { role: 'tool', tool_call_id: 'b', content: interrupted('y') },
    ]);
  });

  it('pads only the UNanswered ids when some tool messages exist', () => {
    const history: ApiMessage[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'a', type: 'function', function: { name: 'x', arguments: '{}' } },
          { id: 'b', type: 'function', function: { name: 'y', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'a', content: 'done a' },
      { role: 'user', content: 'next turn' },
    ];
    const out = sanitizeHistory(history);
    expect(out[0]).toEqual(history[0]);
    expect(out[1]).toEqual(history[1]);
    expect(out[2]).toEqual({ role: 'tool', tool_call_id: 'b', content: interrupted('y') });
    expect(out[3]).toEqual({ role: 'user', content: 'next turn' });
  });

  it('leaves a fully-answered text turn untouched', () => {
    const history: ApiMessage[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'a', type: 'function', function: { name: 'x', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'a', content: 'res' },
      { role: 'user', content: 'go on' },
    ];
    expect(sanitizeHistory(history)).toEqual(history);
  });
});

describe('sanitizeHistory — prior-turn image flattening', () => {
  const visionMsg: ApiMessage = {
    role: 'user',
    content: [
      { type: 'text', text: '看这张图' },
      { type: 'image_url', image_url: { url: 'https://h/a.jpg' } },
      { type: 'image_url', image_url: { url: 'https://h/b.jpg' } },
    ],
  };

  it('flattens a replayed image message to text (images live one turn only)', () => {
    expect(sanitizeHistory([visionMsg])).toEqual([
      { role: 'user', content: '看这张图\n[2 image(s) shown in the previous turn; omitted here to save context]' },
    ]);
  });

  it('leaves plain string user messages alone', () => {
    const history: ApiMessage[] = [{ role: 'user', content: 'plain' }];
    expect(sanitizeHistory(history)).toEqual(history);
  });
});
