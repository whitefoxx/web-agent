/**
 * Port of opencli's clis/linkedin/profile-read.test.js.
 *
 * The func test drives a self-contained fake page: evaluate returns false
 * (auth probe) then the extraction payload. The bundled adapter calls
 * page.autoScroll, so the fake page provides it.
 */
import { describe, expect, it, vi } from 'vitest';
import { findAdapter } from '@base/runtime/registry.js';
import { CommandExecutionError } from '@base/runtime/errors.js';
import { withSessionScratch } from '../_helpers/session-scratch';
import '../../../marketplace/linkedin/profile-read.js';

const { normalizeProfileReadUrl, normalizeProfile } = (
  await import('../../../marketplace/linkedin/profile-read.js')
).__test__ as any;

describe('linkedin profile-read adapter', () => {
  const command = findAdapter('linkedin', 'profile-read');

  it('registers command shape', () => {
    expect(command).toBeDefined();
    expect(command!.strategy).toBe('cookie');
    expect(command!.browser).toBe(true);
    expect(command!.columns).toEqual([
      'profile_url',
      'name',
      'headline',
      'location',
      'about',
      'about_character_count',
      'about_skills',
      'experience',
      'education',
      'services',
      'featured',
    ]);
  });

  it('normalizes profile url default and explicit /in URL', () => {
    expect(normalizeProfileReadUrl(undefined)).toBe('https://www.linkedin.com/in/me/');
    expect(normalizeProfileReadUrl('https://www.linkedin.com/in/gauravsaxena1997?x=1')).toBe(
      'https://www.linkedin.com/in/gauravsaxena1997?x=1',
    );
  });

  it('rejects non-profile URLs', () => {
    expect(() => normalizeProfileReadUrl('https://www.linkedin.com/jobs/')).toThrow(
      CommandExecutionError,
    );
  });

  it('normalizes duplicated profile text and requires a name', () => {
    expect(() => normalizeProfile({ name: '' })).toThrow(CommandExecutionError);
    expect(
      normalizeProfile({
        name: 'AliceAlice',
        headline: 'EngineerEngineer',
        about: '  Builds AI  ',
        about_character_count: '1,100/2,600',
        about_skills: ['AI', 'TypeScript'],
      }),
    ).toMatchObject({
      name: 'Alice',
      headline: 'Engineer',
      about: 'Builds AI',
      about_character_count: '1,100/2,600',
      about_skills: 'AI; TypeScript',
    });
  });

  it('does not require edit access when reading an explicit profile URL', async () => {
    const page = {
      goto: vi.fn(async () => {}),
      wait: vi.fn(async () => {}),
      autoScroll: vi.fn(async () => {}),
      evaluate: vi
        .fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce({
          profile_url: 'https://www.linkedin.com/in/alice/',
          name: 'Alice',
          headline: 'Engineer',
          about: 'Builds products',
        }),
    };

    await expect(
      command!.func!(page, { 'profile-url': 'https://www.linkedin.com/in/alice/' }),
    ).resolves.toMatchObject([{ name: 'Alice', about: 'Builds products' }]);
    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(page.goto).toHaveBeenCalledWith('https://www.linkedin.com/in/alice/');
    expect(page.goto.mock.calls.some(([url]) => String(url).includes('/edit/forms/'))).toBe(false);
  });

  it('reads the About editor on the own-profile path and merges both pages', async () => {
    const page: any = {
      goto: vi.fn(async () => {}),
      wait: vi.fn(async () => {}),
      autoScroll: vi.fn(async () => {}),
      // Empty current URL → state machine enters stage 1 (profile page).
      getCurrentUrl: vi.fn().mockResolvedValue(''),
    };
    // page.goto does not throw in tests, so the state machine runs linearly:
    // stage 1 scrapes the profile and stashes it; stage 2 scrapes the About
    // editor and recovers the stash. withSessionScratch simulates the three
    // sessionStorage scripts and falls through to the scrape impl below.
    page.evaluate = withSessionScratch((script: string) => {
      if (/authwall/.test(script)) return false; // auth probe
      if (/about_skills/.test(script) || /contenteditable/.test(script)) {
        // About-editor extraction.
        return {
          about: 'Builds AI products end to end',
          about_skills: ['AI', 'TypeScript'],
          about_character_count: '1,100/2,600',
        };
      }
      // Profile-page extraction.
      return {
        profile_url: 'https://www.linkedin.com/in/me/',
        name: 'Alice',
        headline: 'Engineer',
        about: 'short bio from profile page',
        experience: 'Acme',
      };
    });

    await expect(command!.func!(page, {})).resolves.toMatchObject([
      {
        name: 'Alice',
        headline: 'Engineer',
        // editor's about overrides the profile-page about (merge order: row then aboutEdit)
        about: 'Builds AI products end to end',
        about_skills: 'AI; TypeScript',
        about_character_count: '1,100/2,600',
        experience: 'Acme',
      },
    ]);
    // Two navigations: profile page, then the About editor.
    expect(page.goto).toHaveBeenCalledTimes(2);
    expect(page.goto).toHaveBeenNthCalledWith(1, 'https://www.linkedin.com/in/me/');
    expect(page.goto.mock.calls[1][0]).toContain('/in/me/edit/forms/summary/new/');
  });

  it('throws when the profile snapshot is lost across navigation (stash unavailable)', async () => {
    const page: any = {
      goto: vi.fn(async () => {}),
      wait: vi.fn(async () => {}),
      autoScroll: vi.fn(async () => {}),
      // Replay landing directly on the About editor → skip stage 1, no stash present.
      getCurrentUrl: vi.fn().mockResolvedValue(
        'https://www.linkedin.com/in/me/edit/forms/summary/new/',
      ),
      // No withSessionScratch: getItem returns null (the guarded script's catch path).
      evaluate: vi.fn(async (script: string) => {
        if (/authwall/.test(String(script))) return false;
        if (/sessionStorage\.getItem/.test(String(script))) return null;
        if (/sessionStorage\.(setItem|removeItem)/.test(String(script))) return true;
        return { about: 'editor only', about_skills: [], about_character_count: '' };
      }),
    };

    await expect(command!.func!(page, {})).rejects.toThrow(CommandExecutionError);
    // Skipped stage 1: never navigated.
    expect(page.goto).not.toHaveBeenCalled();
  });
});
