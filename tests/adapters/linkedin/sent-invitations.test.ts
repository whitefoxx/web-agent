/**
 * Port of opencli's clis/linkedin/sent-invitations.test.js.
 *
 * The opencli test's second case runs buildSentInvitationsScript() against a
 * `jsdom` DOM to assert the in-page extraction logic. jsdom is NOT a
 * dependency of webchat-agent and the vitest env is 'node' (no DOM globals),
 * so that case is not portable here without adding a new dependency (which the
 * porting constraints forbid). Recorded in skipped[]. The command-shape
 * assertion is reachable and ported.
 */
import { describe, expect, it } from 'vitest';
import { findAdapter } from '../../../src/runtime/registry.js';
import '../../../marketplace/linkedin/sent-invitations.js';

describe('linkedin sent-invitations command', () => {
  it('registers with structured columns that do not include raw blobs', () => {
    const command = findAdapter('linkedin', 'sent-invitations');
    expect(command).toBeDefined();
    expect(command!.access).toBe('read');
    expect(command!.columns).toEqual(['rank', 'name', 'profile_url', 'invited_date_text']);
  });
});
