/**
 * ⑪ Consumer ("cold reader") test — the pure parts: extract the verdict JSON from
 * a model reply (fenced / prose-wrapped / dirty) and turn it into a verify-channel
 * warning (only when the spec is genuinely unclear). The model call itself is
 * integration-tested on a real browser. Pure; node.
 */

import { describe, it, expect } from 'vitest';
import { parseConsumerVerdict, consumerWarning } from '../src/explore/consumer-test';

describe('parseConsumerVerdict', () => {
  it('parses a clean verdict', () => {
    expect(
      parseConsumerVerdict('{"clear": true, "invocation": "x__y({})", "unclear": []}'),
    ).toEqual({ clear: true, unclear: [], invocation: 'x__y({})' });
  });

  it('extracts JSON from a fenced block', () => {
    const v = parseConsumerVerdict('```json\n{"clear": false, "unclear": ["sort 取值不明"]}\n```');
    expect(v).toEqual({ clear: false, unclear: ['sort 取值不明'] });
  });

  it('extracts JSON wrapped in prose', () => {
    const v = parseConsumerVerdict('我的判断如下:{"clear": false, "unclear": ["缺分页说明"]} 完毕');
    expect(v?.clear).toBe(false);
    expect(v?.unclear).toEqual(['缺分页说明']);
  });

  it('infers clear from unclear length when clear is missing', () => {
    expect(parseConsumerVerdict('{"unclear": []}')?.clear).toBe(true);
    expect(parseConsumerVerdict('{"unclear": ["x"]}')?.clear).toBe(false);
  });

  it('filters non-strings, trims, drops blanks, caps at 6', () => {
    const v = parseConsumerVerdict(
      JSON.stringify({ clear: false, unclear: ['  a  ', 1, '', 'b', 'c', 'd', 'e', 'f', 'g'] }),
    );
    expect(v?.unclear).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('returns null when there is no JSON object', () => {
    expect(parseConsumerVerdict('no json here')).toBeNull();
    expect(parseConsumerVerdict('')).toBeNull();
  });

  it('returns null on malformed JSON', () => {
    expect(parseConsumerVerdict('{clear: true, unclear: [}')).toBeNull();
  });

  it('omits invocation when absent', () => {
    expect(parseConsumerVerdict('{"clear": true, "unclear": []}')).toEqual({
      clear: true,
      unclear: [],
    });
  });
});

describe('consumerWarning', () => {
  it('null verdict → no warning', () => {
    expect(consumerWarning(null)).toBeNull();
  });

  it('clear spec → no warning (no noise)', () => {
    expect(consumerWarning({ clear: true, unclear: [] })).toBeNull();
  });

  it('clear:false but empty unclear → no warning', () => {
    expect(consumerWarning({ clear: false, unclear: [] })).toBeNull();
  });

  it('unclear spec → a warning naming the gaps', () => {
    const w = consumerWarning({ clear: false, unclear: ['sort 取值不明', '缺分页说明'] });
    expect(w).toContain('Consumer cold-read check');
    expect(w).toContain('sort 取值不明');
    expect(w).toContain('缺分页说明');
    expect(w).toContain('synthesize_adapter');
  });
});
