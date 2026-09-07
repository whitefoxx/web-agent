/**
 * parseAwaitUserAction (③ / ③b): the single arg-parser both api-engine tool
 * loops use, so they can't diverge (the original ③ bug was a two-loop
 * divergence). Covers the auto-resume hint parsing. Pure; node.
 */

import { describe, it, expect } from 'vitest';
import { parseAwaitUserAction } from '../src/agent/engine-tools';

describe('parseAwaitUserAction', () => {
  it('objective only → no tab, no resume', () => {
    expect(parseAwaitUserAction({ objective: '请登录' })).toEqual({ objective: '请登录' });
  });

  it('trims objective; blank → empty string (caller rejects it)', () => {
    expect(parseAwaitUserAction({ objective: '  hi  ' }).objective).toBe('hi');
    expect(parseAwaitUserAction({}).objective).toBe('');
    expect(parseAwaitUserAction({ objective: '   ' }).objective).toBe('');
  });

  it('carries a numeric tab_id', () => {
    expect(parseAwaitUserAction({ objective: 'x', tab_id: 42 })).toEqual({
      objective: 'x',
      tabId: 42,
    });
  });

  it('builds an appear-by-default auto-resume hint when selector + tab given', () => {
    expect(
      parseAwaitUserAction({ objective: 'login', tab_id: 7, wait_for_selector: 'img.avatar' }),
    ).toEqual({
      objective: 'login',
      tabId: 7,
      resume: { selector: 'img.avatar', until: 'appear' },
    });
  });

  it('honors wait_until:disappear', () => {
    expect(
      parseAwaitUserAction({
        objective: 'x',
        tab_id: 7,
        wait_for_selector: '.login-modal',
        wait_until: 'disappear',
      }).resume,
    ).toEqual({ selector: '.login-modal', until: 'disappear' });
  });

  it('defaults an unknown wait_until to appear', () => {
    expect(
      parseAwaitUserAction({
        objective: 'x',
        tab_id: 7,
        wait_for_selector: '.a',
        wait_until: 'bogus',
      }).resume?.until,
    ).toBe('appear');
  });

  it('DROPS the auto-resume hint when there is no tab to poll', () => {
    const out = parseAwaitUserAction({ objective: 'x', wait_for_selector: '.a' });
    expect(out.resume).toBeUndefined();
    expect(out.tabId).toBeUndefined();
  });

  it('ignores a whitespace-only selector', () => {
    expect(
      parseAwaitUserAction({ objective: 'x', tab_id: 7, wait_for_selector: '   ' }).resume,
    ).toBeUndefined();
  });
});
