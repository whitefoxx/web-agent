/**
 * exploreShouldRecord — F-30 fix: the dispatcher records a tool call into the
 * active explore trace only when the call's origin matches the session's owner,
 * so a bridge /command can't contaminate a SidePanel explore trace (and vice
 * versa, and sidepanel-session-B can't contaminate sidepanel-session-A). Pure.
 */

import { describe, it, expect } from 'vitest';
import { exploreShouldRecord } from '../src/explore/session';

describe('exploreShouldRecord (F-30 explore isolation)', () => {
  it('untagged callers (verify smoke-tests / workflows) always record', () => {
    expect(exploreShouldRecord('sess_A', undefined)).toBe(true);
    expect(exploreShouldRecord('bridge', undefined)).toBe(true);
    expect(exploreShouldRecord(undefined, undefined)).toBe(true);
  });

  it('a tagged caller records only into its OWN session', () => {
    expect(exploreShouldRecord('sess_A', 'sess_A')).toBe(true); // agent into its own explore
    expect(exploreShouldRecord('bridge', 'bridge')).toBe(true); // bridge into bridge explore
  });

  it('bridge call does NOT record into a SidePanel explore (the F-30 bug)', () => {
    expect(exploreShouldRecord('sess_A', 'bridge')).toBe(false);
  });

  it('a SidePanel agent call does NOT record into a bridge explore (reverse)', () => {
    expect(exploreShouldRecord('bridge', 'sess_A')).toBe(false);
  });

  it('sidepanel session B does NOT contaminate session A explore', () => {
    expect(exploreShouldRecord('sess_A', 'sess_B')).toBe(false);
  });

  it('an owner-less session (defensive) rejects any tagged caller', () => {
    expect(exploreShouldRecord(undefined, 'bridge')).toBe(false);
  });
});
