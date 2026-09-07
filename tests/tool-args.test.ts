import { describe, it, expect } from 'vitest';

import { parseToolArgs } from '../src/agent/engine-history';

describe('parseToolArgs', () => {
  it('parses a well-formed JSON object (happy path, == JSON.parse)', () => {
    expect(parseToolArgs('{"a":1,"b":"x"}')).toEqual({ a: 1, b: 'x' });
  });

  it('empty / whitespace / null / undefined → {}', () => {
    expect(parseToolArgs('')).toEqual({});
    expect(parseToolArgs('   ')).toEqual({});
    expect(parseToolArgs(null)).toEqual({});
    expect(parseToolArgs(undefined)).toEqual({});
  });

  it('strips a ```json (or bare ```) code fence', () => {
    expect(parseToolArgs('```json\n{"q":"hi"}\n```')).toEqual({ q: 'hi' });
    expect(parseToolArgs('```\n{"q":"hi"}\n```')).toEqual({ q: 'hi' });
  });

  it('unwraps a double-stringified arguments value', () => {
    expect(parseToolArgs(JSON.stringify('{"n":5}'))).toEqual({ n: 5 });
  });

  it('extracts the first {…} block from surrounding prose', () => {
    expect(parseToolArgs('Sure! {"url":"https://x"} — done')).toEqual({ url: 'https://x' });
  });

  it('non-object JSON (array / number / bare string) → {}', () => {
    expect(parseToolArgs('5')).toEqual({});
    expect(parseToolArgs('[1,2]')).toEqual({});
    expect(parseToolArgs('"hello"')).toEqual({});
  });

  it('unrecoverable garbage → {}', () => {
    expect(parseToolArgs('not json at all')).toEqual({});
  });
});
