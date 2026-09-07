/**
 * Port of opencli's clis/linkedin/services-read.test.js.
 * Pure-helper assertions via __test__ + one func test with inline fake page.
 */
import { describe, expect, it, vi } from 'vitest';
import { findAdapter } from '@base/runtime/registry.js';
import { CommandExecutionError } from '@base/runtime/errors.js';
import { withSessionScratch } from '../_helpers/session-scratch';
import '../../../marketplace/linkedin/services-read.js';

const { normalizeProfileUrl, normalizeServicesUrl, normalizeServices, pairsToMedia } = (
  await import('../../../marketplace/linkedin/services-read.js')
).__test__ as any;

describe('linkedin services-read adapter', () => {
  const command = findAdapter('linkedin', 'services-read');

  it('registers command shape', () => {
    expect(command).toBeDefined();
    expect(command!.strategy).toBe('cookie');
    expect(command!.browser).toBe(true);
    expect(command!.columns).toEqual([
      'service_url',
      'page_title',
      'overview',
      'availability',
      'work_locations',
      'pricing',
      'services_provided',
      'services_count',
      'media',
      'media_count',
      'messages',
      'reviews_visibility',
    ]);
  });

  it('normalizes profile and services URLs', () => {
    expect(normalizeProfileUrl(undefined)).toBe('https://www.linkedin.com/in/me/');
    expect(normalizeProfileUrl('https://www.linkedin.com/in/gauravsaxena1997/')).toBe(
      'https://www.linkedin.com/in/gauravsaxena1997/',
    );
    expect(
      normalizeServicesUrl('https://www.linkedin.com/services/page/854507342066b51989/'),
    ).toBe('https://www.linkedin.com/services/page/854507342066b51989/');
  });

  it('rejects invalid URL shapes', () => {
    expect(() => normalizeProfileUrl('https://www.linkedin.com/jobs/')).toThrow(
      CommandExecutionError,
    );
    expect(() => normalizeServicesUrl('https://www.linkedin.com/in/gauravsaxena1997/')).toThrow(
      CommandExecutionError,
    );
  });

  it('pairs media title and description lines', () => {
    expect(pairsToMedia(['Portfolio', 'Builds AI products', 'GitHub', 'Open source work'])).toEqual([
      'Portfolio — Builds AI products',
      'GitHub — Open source work',
    ]);
  });

  it('normalizes services payload into command columns', () => {
    expect(
      normalizeServices({
        service_url: 'https://www.linkedin.com/services/page/abc/',
        page_title: 'Gaurav Services',
        overview: ' Builds AI ',
        availability: 'Remote',
        work_locations: ['Greater Jaipur Area', 'I am available to work remotely'],
        pricing: 'Pricing, Select one option, Contact for pricing, required',
        services_provided: ['Web Development', 'SaaS Development'],
        media_lines: ['Portfolio', 'AI products'],
        messages: 'on',
        reviews_visibility: 'off',
      }),
    ).toEqual({
      service_url: 'https://www.linkedin.com/services/page/abc/',
      page_title: 'Gaurav Services',
      overview: 'Builds AI',
      availability: 'Remote',
      work_locations: 'Greater Jaipur Area; I am available to work remotely',
      pricing: 'Contact for pricing',
      services_provided: 'Web Development; SaaS Development',
      services_count: '2',
      media: 'Portfolio — AI products',
      media_count: '1',
      messages: 'on',
      reviews_visibility: 'off',
    });
  });

  it('fails closed when a services page payload has no stable content', () => {
    expect(() =>
      normalizeServices({ service_url: 'https://www.linkedin.com/services/page/abc/' }),
    ).toThrow(CommandExecutionError);
    expect(() => normalizeServices({ page_title: 'Alice Services' })).toThrow(CommandExecutionError);
  });

  it('does not require edit access when reading an explicit services URL', async () => {
    const page = {
      // Empty current URL → the func enters its (non-interleaved) services-url
      // branch and navigates once, exactly as the single-goto path did before the
      // trampoline guard was added.
      getCurrentUrl: vi.fn().mockResolvedValue(''),
      goto: vi.fn(async () => {}),
      wait: vi.fn(async () => {}),
      evaluate: vi
        .fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce({
          service_url: 'https://www.linkedin.com/services/page/abc/',
          page_title: 'Alice Services',
          overview: 'Builds AI',
          services_provided: ['AI Consulting'],
        }),
    };

    await expect(
      command!.func!(page, { 'services-url': 'https://www.linkedin.com/services/page/abc/' }),
    ).resolves.toMatchObject([{ page_title: 'Alice Services', services_count: '1' }]);
    expect(page.goto.mock.calls.map(([url]) => String(url))).toEqual([
      'https://www.linkedin.com/services/page/abc/',
    ]);
  });

  it('reads the owner-edit path as an interleaved sessionStorage state machine', async () => {
    // No services-url and no profile-url → shouldReadOwnerEdit. In a unit test
    // page.goto does not throw NAVIGATE_RESTART, so the state machine runs
    // linearly: discover (profile) → services → edit → media. getCurrentUrl
    // stays '' so the func always starts at stage 1; withSessionScratch
    // simulates the sessionStorage stash/recover across the (fake) navigations.
    const servicesScrape = {
      service_url: 'https://www.linkedin.com/services/page/abc/',
      page_title: 'Alice Services',
      overview: 'Builds AI products',
      availability: 'Remote',
      pricing: 'Pricing, Select one option, Contact for pricing, required',
      services_provided: ['Web Development', 'SaaS Development'],
    };
    const editScrape = {
      overview: 'Builds AI products',
      work_locations: ['Greater Jaipur Area'],
      messages: 'on',
      reviews_visibility: 'off',
      pricing: 'Contact for pricing',
    };
    const mediaScrape = { media_lines: ['Portfolio', 'AI products'] };

    const page = {
      getCurrentUrl: vi.fn().mockResolvedValue(''),
      goto: vi.fn(async () => {}),
      wait: vi.fn(async () => {}),
      evaluate: undefined as unknown,
    };
    page.evaluate = withSessionScratch((script: string) => {
      if (/login|checkpoint|authwall|sign in|log in/i.test(script)) return false; // auth probe
      if (script.includes('/services/page/')) return { services_url: 'https://www.linkedin.com/services/page/abc/' }; // discover
      if (script.includes("'Add media'") || script.includes('media_lines')) return mediaScrape;
      if (script.includes('dialog') || script.includes('work_locations')) return editScrape;
      return servicesScrape; // buildServicesPageScript
    });

    const result = await command!.func!(page, {});
    expect(result).toEqual([
      {
        service_url: 'https://www.linkedin.com/services/page/abc/',
        page_title: 'Alice Services',
        overview: 'Builds AI products',
        availability: 'Remote',
        work_locations: 'Greater Jaipur Area',
        pricing: 'Contact for pricing',
        services_provided: 'Web Development; SaaS Development',
        services_count: '2',
        media: 'Portfolio — AI products',
        media_count: '1',
        messages: 'on',
        reviews_visibility: 'off',
      },
    ]);
    // Navigated profile → services → edit → media, each exactly once.
    expect(page.goto.mock.calls.map(([url]) => String(url))).toEqual([
      'https://www.linkedin.com/in/me/',
      'https://www.linkedin.com/services/page/abc/',
      'https://www.linkedin.com/services/page/abc/edit/',
      'https://www.linkedin.com/services/page/abc/media/',
    ]);
  });

  it('fails closed on the media page when the stash is lost', async () => {
    // Owner-edit path with sessionStorage disabled: get/set are no-ops, so the
    // media stage cannot recover the Services/edit snapshots and must throw.
    const page = {
      getCurrentUrl: vi.fn().mockResolvedValue(''),
      goto: vi.fn(async () => {}),
      wait: vi.fn(async () => {}),
      evaluate: vi.fn((script: string) => {
        const s = String(script);
        if (/sessionStorage\.(setItem|removeItem)/.test(s)) return false; // storage blocked
        if (/sessionStorage\.getItem/.test(s)) return null; // nothing ever stored
        if (/login|checkpoint|authwall|sign in|log in/i.test(s)) return false;
        if (s.includes('/services/page/')) return { services_url: 'https://www.linkedin.com/services/page/abc/' };
        if (s.includes("'Add media'") || s.includes('media_lines')) return { media_lines: [] };
        if (s.includes('dialog') || s.includes('work_locations')) return { overview: '' };
        return { service_url: 'https://www.linkedin.com/services/page/abc/', page_title: 'Alice Services', services_provided: ['AI Consulting'] };
      }),
    };

    await expect(command!.func!(page, {})).rejects.toThrow(CommandExecutionError);
  });
});
