/**
 * Port of opencli's clis/douyin/stats.test.js (registration only).
 */
import { describe, expect, it } from 'vitest';
import { findAdapter } from '../../../src/runtime/registry.js';

import '../../../marketplace/douyin/stats.js';

describe('douyin/stats (marketplace)', () => {
  const command = findAdapter('douyin', 'stats');

  it('registers the stats command', () => {
    expect(command).toBeDefined();
    expect(command?.args.some((a: { name: string }) => a.name === 'aweme_id')).toBe(true);
  });

  it('has expected columns', () => {
    expect(command?.columns).toContain('metric');
    expect(command?.columns).toContain('value');
  });

  it('uses COOKIE strategy', () => {
    expect(command?.strategy).toBe('cookie');
  });
});
