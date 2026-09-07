/**
 * A cockpit-mask registry (page-agent-comparison §4.3.6) — the pure alive
 * logic behind MASK_PING. The injections/ping loop need a real page (bridge).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  noteMaskArmed,
  isMaskAlive,
  resetMaskRegistryForTests,
  MASK_IDLE_MS,
} from '../src/background/mask-keeper';

describe('mask-keeper isMaskAlive', () => {
  beforeEach(() => resetMaskRegistryForTests());

  it('unregistered tab is never alive, even mid-session', () => {
    expect(isMaskAlive(1, true)).toBe(false);
  });

  it('registered tab stays alive through arbitrarily long thinking gaps while a session runs', () => {
    const t0 = 1_000_000;
    noteMaskArmed(7, t0);
    expect(isMaskAlive(7, true, t0 + 10 * 60_000)).toBe(true);
  });

  it('session-less (bridge) driver falls back to the idle window', () => {
    const t0 = 1_000_000;
    noteMaskArmed(7, t0);
    expect(isMaskAlive(7, false, t0 + MASK_IDLE_MS - 1)).toBe(true);
    expect(isMaskAlive(7, false, t0 + MASK_IDLE_MS + 1)).toBe(false);
  });

  it('reset (≈ SW restart wiping in-memory state) kills all masks', () => {
    noteMaskArmed(7);
    resetMaskRegistryForTests();
    expect(isMaskAlive(7, true)).toBe(false);
  });
});
