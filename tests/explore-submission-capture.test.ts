/**
 * Submission-capture classifiers (F-29 constructive fix / browseract ①). The CDP
 * interception itself needs a real browser, but the decision logic — is a paused
 * request a WRITE to neutralize or a READ to let through, GraphQL mutation vs
 * query, header redaction, body parsing — is pure and unit-tested here. Node.
 */

import { describe, it, expect } from 'vitest';
import {
  classifySubmission,
  detectGraphql,
  redactHeaders,
  parseBodyForRecord,
} from '../src/runtime/submission-capture';

describe('classifySubmission — write vs read', () => {
  it('GET/HEAD/OPTIONS/TRACE are reads', () => {
    for (const m of ['GET', 'HEAD', 'OPTIONS', 'TRACE', 'get']) {
      expect(classifySubmission(m, undefined).isWrite).toBe(false);
    }
  });

  it('PUT/PATCH/DELETE are writes', () => {
    for (const m of ['PUT', 'PATCH', 'DELETE', 'delete']) {
      expect(classifySubmission(m, undefined).isWrite).toBe(true);
    }
  });

  it('non-GraphQL POST defaults to write (safe bias)', () => {
    expect(classifySubmission('POST', JSON.stringify({ comment: 'hi' })).isWrite).toBe(true);
    expect(classifySubmission('POST', 'title=hi&body=x').isWrite).toBe(true);
    expect(classifySubmission('POST', undefined).isWrite).toBe(true);
  });

  it('GraphQL query (POST) is a READ — must not be broken', () => {
    const body = JSON.stringify({ query: 'query GetList { list { id } }' });
    const c = classifySubmission('POST', body);
    expect(c.isWrite).toBe(false);
    expect(c.graphql?.operation).toBe('query');
  });

  it('GraphQL mutation (POST) is a WRITE', () => {
    const body = JSON.stringify({
      operationName: 'AddStar',
      query: 'mutation AddStar($id: ID!) { addStar(id: $id) { ok } }',
      variables: { id: 'x' },
    });
    const c = classifySubmission('POST', body);
    expect(c.isWrite).toBe(true);
    expect(c.graphql).toEqual({ operation: 'mutation', operationName: 'AddStar' });
  });

  it('batched GraphQL with any mutation is a WRITE', () => {
    const body = JSON.stringify([
      { query: 'query A { a }' },
      { query: 'mutation B { setB(v: 1) }' },
    ]);
    expect(classifySubmission('POST', body).isWrite).toBe(true);
  });
});

describe('detectGraphql', () => {
  it('reads the operation keyword and name from the query text', () => {
    expect(detectGraphql(JSON.stringify({ query: 'mutation Foo { x }' }))).toEqual({
      operation: 'mutation',
      operationName: 'Foo',
    });
    expect(detectGraphql(JSON.stringify({ query: 'subscription S { onX }' }))?.operation).toBe(
      'subscription',
    );
  });

  it('prefers the explicit operationName field', () => {
    const g = detectGraphql(
      JSON.stringify({ operationName: 'Real', query: 'mutation Ignored { x }' }),
    );
    expect(g).toEqual({ operation: 'mutation', operationName: 'Real' });
  });

  it('anonymous shorthand document is a query', () => {
    expect(detectGraphql(JSON.stringify({ query: '{ me { id } }' }))).toEqual({
      operation: 'query',
    });
  });

  it('skips leading # comments', () => {
    expect(detectGraphql(JSON.stringify({ query: '# note\nmutation M { y }' }))?.operation).toBe(
      'mutation',
    );
  });

  it('non-JSON / non-GraphQL bodies are null', () => {
    expect(detectGraphql('title=hi&body=x')).toBeNull();
    expect(detectGraphql(JSON.stringify({ comment: 'hi' }))).toBeNull();
    expect(detectGraphql(undefined)).toBeNull();
    expect(detectGraphql('not json')).toBeNull();
  });
});

describe('redactHeaders — keep names, hide secret values', () => {
  it('redacts cookie / authorization / csrf / api-key values', () => {
    const out = redactHeaders({
      cookie: 'session=abc',
      Authorization: 'Bearer xyz',
      'x-csrf-token': 't',
      'x-api-key': 'k',
      'content-type': 'application/json',
      accept: '*/*',
    });
    expect(out.cookie).toBe('<redacted>');
    expect(out.Authorization).toBe('<redacted>');
    expect(out['x-csrf-token']).toBe('<redacted>');
    expect(out['x-api-key']).toBe('<redacted>');
    // non-secret headers pass through unchanged (synthesis needs content-type)
    expect(out['content-type']).toBe('application/json');
    expect(out.accept).toBe('*/*');
  });
});

describe('parseBodyForRecord', () => {
  it('parses JSON into an object', () => {
    expect(parseBodyForRecord('{"a":1,"b":"x"}', 'application/json')).toEqual({ a: 1, b: 'x' });
  });
  it('parses form-urlencoded into an object', () => {
    expect(parseBodyForRecord('title=hi&body=x', 'application/x-www-form-urlencoded')).toEqual({
      title: 'hi',
      body: 'x',
    });
  });
  it('falls back to a clipped raw string', () => {
    const raw = 'x'.repeat(5000);
    const out = parseBodyForRecord(raw, 'text/plain');
    expect(typeof out).toBe('string');
    expect((out as string).endsWith('…[truncated]')).toBe(true);
  });
  it('undefined body → undefined', () => {
    expect(parseBodyForRecord(undefined, 'application/json')).toBeUndefined();
  });
});
