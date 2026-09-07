/**
 * Port of opencli's clis/linkedin/salesnav-message.test.js.
 * Pure-helper assertions via __test__, plus a func test with an inline page
 * mock (goto/wait/evaluate/getCookies). evaluate returns the API JSON the
 * adapter expects.
 */
import { describe, expect, it, vi } from 'vitest';
import { findAdapter } from '@base/runtime/registry.js';
import { CommandExecutionError } from '@base/runtime/errors.js';
import '../../../marketplace/linkedin/salesnav-message.js';

const {
  parseSalesProfileUrn,
  parseRecipient,
  salesLeadUrlFromParts,
  profileApiUrl,
  buildCreateMessagePayload,
  extractRemainingCredits,
  profileSummary,
  requireProfileSummary,
  salesPageShowsSentMessage,
} = (await import('../../../marketplace/linkedin/salesnav-message.js')).__test__ as any;

// Real production pages always expose getCurrentUrl; the func reads it once to
// guard the SALES_HOME warm-up. Returning '' (not a lead URL) makes the func take
// the normal warm-up → resolve → fetch flow. The send is confirmed from the
// createMessage API response (no post-send navigation, no sessionStorage), so the
// evaluate mock is just an ordered queue: each fetch/scrape script consumes the
// next queued result.
function createPageMock(
  evaluateResults: any[] = [],
  opts: { currentUrl?: string } = {},
) {
  const queue = [...evaluateResults];
  const evaluate = vi.fn((_script: string) => (queue.length ? queue.shift() : undefined));
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue(undefined),
    evaluate,
    scrape: evaluate,
    getCurrentUrl: vi.fn().mockResolvedValue(opts.currentUrl ?? ''),
    getCookies: vi
      .fn()
      .mockResolvedValue([{ name: 'JSESSIONID', value: '"csrf"', domain: '.linkedin.com' }]),
  };
}

describe('linkedin salesnav-message command', () => {
  it('parses Sales Navigator profile urns and lead URLs', () => {
    const urn = 'urn:li:fs_salesProfile:(ACwAAAJS8TABxyz,NAME_SEARCH,Enlo)';
    expect(parseSalesProfileUrn(urn)).toMatchObject({
      profileId: 'ACwAAAJS8TABxyz',
      authType: 'NAME_SEARCH',
      authToken: 'Enlo',
      entityUrn: urn,
    });
    expect(
      parseSalesProfileUrn('urn:li:fs_salesProfile:(ACwAAAJS8TABxyz,undefined,undefined)'),
    ).toBeNull();

    const parsed = parseRecipient(
      'https://www.linkedin.com/sales/lead/ACwAAAJS8TABxyz,NAME_SEARCH,Enlo',
    );
    expect(parsed).toMatchObject({
      profileId: 'ACwAAAJS8TABxyz',
      authType: 'NAME_SEARCH',
      authToken: 'Enlo',
    });
    expect(parsed.entityUrn).toBe(urn);
    expect(salesLeadUrlFromParts(parsed)).toBe(
      'https://www.linkedin.com/sales/lead/ACwAAAJS8TABxyz,NAME_SEARCH,Enlo',
    );
  });

  it('accepts LinkedIn /in tokens as unresolved recipients', () => {
    expect(parseRecipient('https://www.linkedin.com/in/ACwAAAJS8TABxyz/')).toMatchObject({
      profileId: 'ACwAAAJS8TABxyz',
      authType: '',
      authToken: '',
      entityUrn: '',
    });
  });

  it('builds profile API URLs with the Sales Navigator auth key', () => {
    const url = profileApiUrl({ profileId: 'P1', authType: 'NAME_SEARCH', authToken: 'T1' });
    expect(url).toContain(
      '/sales-api/salesApiProfiles/(profileId:P1,authType:NAME_SEARCH,authToken:T1)',
    );
    expect(url).toContain('decoration=');
  });

  it('constructs the createMessage action payload used by Sales Navigator', () => {
    const payload = buildCreateMessagePayload({
      recipientUrn: 'urn:li:fs_salesProfile:(P1,NAME_SEARCH,T1)',
      subject: 'Quick QA doc question',
      body: 'Hi Jane, can I ask a quick question?',
      trackingId: '0123456789abcdef',
      copyToCrm: false,
    });
    expect(payload).toEqual({
      createMessageRequest: {
        recipients: ['urn:li:fs_salesProfile:(P1,NAME_SEARCH,T1)'],
        subject: 'Quick QA doc question',
        body: 'Hi Jane, can I ask a quick question?',
        copyToCrm: false,
        trackingId: '0123456789abcdef',
      },
    });
  });

  it('validates payload fields before any send attempt', () => {
    expect(() => buildCreateMessagePayload({ recipientUrn: '', subject: 's', body: 'b' })).toThrow();
    expect(() =>
      buildCreateMessagePayload({
        recipientUrn: 'urn:li:fs_salesProfile:(P,A,T)',
        subject: '',
        body: 'b',
      }),
    ).toThrow();
    expect(() =>
      buildCreateMessagePayload({
        recipientUrn: 'urn:li:fs_salesProfile:(P,A,T)',
        subject: 's',
        body: '',
      }),
    ).toThrow();
    expect(() =>
      buildCreateMessagePayload({
        recipientUrn: 'urn:li:fs_salesProfile:(P,A,T)',
        subject: 'x'.repeat(201),
        body: 'b',
      }),
    ).toThrow();
    expect(() =>
      buildCreateMessagePayload({
        recipientUrn: 'urn:li:fs_salesProfile:(P,undefined,undefined)',
        subject: 's',
        body: 'b',
      }),
    ).toThrow();
  });

  it('detects the Sales Navigator sent activity on a verified lead page', () => {
    expect(
      salesPageShowsSentMessage(
        '5/18/2026 You sent a Sales Navigator message to Jane',
        'Jane Q',
      ),
    ).toBe(true);
    expect(salesPageShowsSentMessage('No recent activity', 'Jane Q')).toBe(false);
  });

  it('extracts a plausible remaining InMail credit count', () => {
    expect(
      extractRemainingCredits({
        elements: [{ type: 'LSS_INMAIL', value: 149, id: 1 }],
        paging: { count: 10 },
      }),
    ).toBe(149);
    expect(extractRemainingCredits({ data: { remaining: 149, used: 1 } })).toBe(149);
    expect(extractRemainingCredits({ elements: [{ availableCount: 12 }] })).toBe(12);
    expect(extractRemainingCredits({})).toBe(null);
  });

  it('summarizes decorated Sales Navigator profile data', () => {
    expect(
      profileSummary({
        data: {
          fullName: 'Rayki Goh',
          headline: 'Food Safety',
          degree: 3,
          defaultPosition: { title: 'FSQA Manager', companyName: 'Acme Foods' },
          memberBadges: { openLink: false },
        },
      }),
    ).toMatchObject({
      recipient: 'Rayki Goh',
      title: 'FSQA Manager',
      company: 'Acme Foods',
      degree: '3',
      open_link: false,
    });
  });

  it('fails typed when decorated profile data has no recipient identity', () => {
    expect(() => requireProfileSummary({ data: { defaultPosition: { title: 'FSQA' } } })).toThrow(
      CommandExecutionError,
    );
  });

  it('keeps manifest columns aligned with dry-run rows and fails typed on malformed profile API', async () => {
    const cmd = findAdapter('linkedin', 'salesnav-message');
    expect(cmd?.columns).toEqual([
      'status',
      'recipient',
      'title',
      'company',
      'credits_remaining',
      'credits_before',
      'credits_after',
      'sent_in_salesnav',
      'message_chars',
      'subject_chars',
      'recipient_urn',
      'degree',
      'inmail_restriction',
      'open_link',
    ]);

    const goodPage = createPageMock([
      {
        status: 200,
        json: {
          data: {
            fullName: 'Jane Doe',
            defaultPosition: { title: 'QA', companyName: 'Acme' },
            degree: 2,
            inmailRestriction: 'NO_RESTRICTION',
            memberBadges: { openLink: true },
          },
        },
      },
      { status: 200, json: { elements: [{ type: 'LSS_INMAIL', value: 12 }] } },
    ]);
    const rows = (await cmd!.func!(goodPage, {
      recipient: 'urn:li:fs_salesProfile:(P1,NAME_SEARCH,T1)',
      subject: 'Hello',
      body: 'Quick question',
    })) as any[];
    expect(Object.keys(rows[0]).sort()).toEqual([...cmd!.columns!].sort());
    expect(rows[0]).toMatchObject({
      status: 'validated_dry_run',
      recipient: 'Jane Doe',
      credits_remaining: 12,
      credits_before: 12,
      credits_after: '',
      sent_in_salesnav: false,
      degree: '2',
      inmail_restriction: 'NO_RESTRICTION',
      open_link: true,
    });

    const malformedPage = createPageMock([
      { status: 200, json: { data: { defaultPosition: { title: 'QA' } } } },
    ]);
    await expect(
      cmd!.func!(malformedPage, {
        recipient: 'urn:li:fs_salesProfile:(P1,NAME_SEARCH,T1)',
        subject: 'Hello',
        body: 'Quick question',
      }),
    ).rejects.toThrow(CommandExecutionError);
  });

  it('send=true: confirms from the createMessage API response with NO post-send navigation (single-shot)', async () => {
    const cmd = findAdapter('linkedin', 'salesnav-message');
    // Queue: profile API, credits-before, send POST (200), credits-after.
    const page = createPageMock([
      {
        status: 200,
        json: {
          data: {
            fullName: 'Jane Doe',
            defaultPosition: { title: 'QA', companyName: 'Acme' },
            degree: 2,
            inmailRestriction: 'NO_RESTRICTION',
            memberBadges: { openLink: false },
          },
        },
      },
      { status: 200, json: { elements: [{ type: 'LSS_INMAIL', value: 12 }] } },
      { status: 200, json: { value: 'urn:li:messagingMessage:created' } }, // send POST ok
      { status: 200, json: { elements: [{ type: 'LSS_INMAIL', value: 11 }] } }, // a credit consumed
    ]);
    const rows = (await cmd!.func!(page, {
      recipient: 'urn:li:fs_salesProfile:(P1,NAME_SEARCH,T1)',
      subject: 'Hello',
      body: 'Quick question',
      send: true,
    })) as any[];

    expect(rows[0]).toMatchObject({
      status: 'sent',
      recipient: 'Jane Doe',
      sent_in_salesnav: true,
      credits_before: 12,
      credits_after: 11,
    });
    expect(Object.keys(rows[0]).sort()).toEqual([...cmd!.columns!].sort());

    // Single-shot: the credit-costing createMessage POST is evaluated EXACTLY once.
    const sendCalls = page.evaluate.mock.calls.filter((c: any[]) =>
      String(c[0]).includes('salesApiMessageActions'),
    );
    expect(sendCalls).toHaveLength(1);

    // No post-send navigation: the ONLY goto is the SALES_HOME warm-up (before the
    // send). Nothing navigates after the send, so the func can never reinject and
    // re-issue the InMail — this is the trampoline single-shot guarantee.
    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(page.goto).toHaveBeenCalledWith('https://www.linkedin.com/sales/');
  });

  it('send=true: a non-2xx createMessage response fails typed (no silent "sent")', async () => {
    const cmd = findAdapter('linkedin', 'salesnav-message');
    const page = createPageMock([
      {
        status: 200,
        json: {
          data: {
            fullName: 'Jane Doe',
            defaultPosition: { title: 'QA', companyName: 'Acme' },
            inmailRestriction: 'NO_RESTRICTION',
          },
        },
      },
      { status: 200, json: { elements: [{ type: 'LSS_INMAIL', value: 12 }] } },
      // send POST returns the fetch-helper error tuple (HTTP 500) → requireFetchResult throws.
      ['error', 500, null, '', 'HTTP 500'],
    ]);
    await expect(
      cmd!.func!(page, {
        recipient: 'urn:li:fs_salesProfile:(P1,NAME_SEARCH,T1)',
        subject: 'Hello',
        body: 'Quick question',
        send: true,
      }),
    ).rejects.toThrow(CommandExecutionError);
  });
});
