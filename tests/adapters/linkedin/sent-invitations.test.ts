/**
 * Port of opencli's clis/linkedin/sent-invitations.test.js.
 *
 * The opencli test's second case runs buildSentInvitationsScript() against a
 * `jsdom` DOM to assert the in-page extraction logic. With `jsdom` now a devDep
 * it is ported below ("extracts clean names and dedupes invitation cards by
 * profile url"), using programmatic `new JSDOM(...)` and the same global-swap +
 * offsetParent polyfill opencli uses. The command-shape assertion is also ported.
 */
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { findAdapter } from '../../../src/runtime/registry.js';
import '../../../marketplace/linkedin/sent-invitations.js';
import { __test__ } from '../../../marketplace/linkedin/sent-invitations.js';

const { buildSentInvitationsScript } = __test__;

describe('linkedin sent-invitations command', () => {
  it('registers with structured columns that do not include raw blobs', () => {
    const command = findAdapter('linkedin', 'sent-invitations');
    expect(command).toBeDefined();
    expect(command!.access).toBe('read');
    expect(command!.columns).toEqual(['rank', 'name', 'profile_url', 'invited_date_text']);
  });

  // jsdom-backed port of opencli's "extracts clean names and dedupes invitation
  // cards by profile url" test. Now that jsdom is a devDep, run the in-page
  // extraction script against a real DOM. The script references `document`,
  // `location`, `getComputedStyle` and `HTMLElement` as bare globals, so swap
  // them in (verbatim from opencli's test) and polyfill offsetParent since jsdom
  // does no layout.
  it('extracts clean names and dedupes invitation cards by profile url', () => {
    const dom = new JSDOM(
      `<!doctype html><body>
      <ul>
        <li>
          <a href="/in/olga-magere/?miniProfileUrn=x"><span>Olga Magere</span></a>
          <span>Pending</span><button>Withdraw</button><span>Sent 2 weeks ago</span>
        </li>
        <li>
          <a href="/in/olga-magere/?trk=dup"><span>Olga Magere</span></a>
          <span>Pending</span><button>Withdraw</button><span>Sent 2 weeks ago</span>
        </li>
        <li>
          <div>Sam Founder\nSent yesterday\nWithdraw</div>
        </li>
      </ul>
    </body>`,
      { url: 'https://www.linkedin.com/mynetwork/invitation-manager/sent/' },
    );
    const g = globalThis as Record<string, unknown>;
    const previousWindow = g.window;
    const previousDocument = g.document;
    const previousLocation = g.location;
    const previousGetComputedStyle = g.getComputedStyle;
    try {
      g.window = dom.window;
      g.document = dom.window.document;
      g.location = dom.window.location;
      g.getComputedStyle = dom.window.getComputedStyle;
      Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetParent', {
        get() {
          return dom.window.document.body;
        },
        configurable: true,
      });
      const run = Function(`return ${buildSentInvitationsScript()}`);
      const result = run() as { rows: Array<Record<string, unknown>> };
      expect(result.rows).toEqual([
        {
          name: 'Olga Magere',
          profile_url: 'https://www.linkedin.com/in/olga-magere/',
          invited_date_text: 'Sent 2 weeks ago',
        },
        {
          name: 'Sam Founder',
          profile_url: '',
          invited_date_text: 'Sent yesterday',
        },
      ]);
      expect(result.rows[0]).not.toHaveProperty('raw');
    } finally {
      g.window = previousWindow;
      g.document = previousDocument;
      g.location = previousLocation;
      g.getComputedStyle = previousGetComputedStyle;
    }
  });
});
