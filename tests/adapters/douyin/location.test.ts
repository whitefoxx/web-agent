/**
 * Port of opencli's clis/douyin/location.test.js (registration only).
 */
import { describe, expect, it } from 'vitest';
import { findAdapter } from '../../../src/runtime/registry.js';

import '../../../marketplace/douyin/location.js';

describe('douyin/location (marketplace)', () => {
  const command = findAdapter('douyin', 'location');

  it('registers the location command', () => {
    expect(command).toBeDefined();
    expect(command?.args.some((a: { name: string }) => a.name === 'query')).toBe(true);
  });

  it('has all expected args', () => {
    const argNames = command?.args.map((a: { name: string }) => a.name) ?? [];
    expect(argNames).toContain('query');
    expect(argNames).toContain('limit');
  });

  it('uses COOKIE strategy', () => {
    expect(command?.strategy).toBe('cookie');
  });
});
