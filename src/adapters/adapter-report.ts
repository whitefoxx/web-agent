/**
 * Zero-backend community contribution (H1): when a user finds a marketplace
 * adapter broken — or heals it locally — let them report it / submit the fix via
 * a PRE-FILLED GitHub issue on the marketplace's own public repo. No server: the
 * marketplace IS a GitHub repo, so its issue tracker is the collaboration layer,
 * and the maintainer audits + merges (+ rotates sha) from there.
 *
 * Privacy: the report carries ONLY the error and (for a heal) the adapter SOURCE
 * — never the user's scraped data — and the user reviews it on GitHub before
 * submitting (we just open the pre-filled new-issue page).
 *
 * GitHub caps a new-issue URL (~8KB). If the body (with the healed source) would
 * exceed it, `buildAdapterReport` returns the source as `clipboard` and leaves a
 * paste-placeholder in the body; the caller copies it before opening. Pure +
 * unit-tested (tests/adapter-report.test.ts).
 */

const MARKET_REPO = 'whitefoxx/web-agent-marketplace';
const ISSUE_URL = `https://github.com/${MARKET_REPO}/issues/new`;
/** Conservative cap on the encoded body (GitHub's URL ceiling is ~8KB; leave
 * headroom for the base + title + labels). */
const BODY_ENC_CAP = 6000;

export interface AdapterReportInput {
  /** Installed id `${site}/${name}`. */
  id: string;
  /** Tool id `${site}__${name}` (for the human-readable title). */
  tool: string;
  error?: string;
  /** Present → this is a HEAL contribution (carries the re-derived source). */
  source?: string;
  /** Extension version, for triage context. */
  version?: string;
}

export interface AdapterReport {
  url: string;
  /** When set, the caller must copy this to the clipboard before opening `url`
   * (the source was too long to inline — the body says "paste it here"). */
  clipboard?: string;
}

const PRIVACY_NOTE =
  '> This report contains only the error message and adapter source — it does **not** include any data you scraped. Please review it before submitting.';

function fence(lang: string, body: string): string {
  return '```' + lang + '\n' + body + '\n```';
}

export function buildAdapterReport(input: AdapterReportInput): AdapterReport {
  const isHeal = !!input.source?.trim();
  const title = isHeal
    ? `[heal] Fix broken adapter ${input.tool}`
    : `[broken] Adapter ${input.tool} is broken`;
  const labels = isHeal ? 'adapter-heal' : 'adapter-broken';

  const head = [
    `**Adapter**: \`${input.tool}\` (id \`${input.id}\`)`,
    input.version ? `**Extension version**: ${input.version}` : '',
    input.error ? `**Error**:\n${fence('', input.error)}` : '',
  ].filter(Boolean);

  const body = (sourceBlock: string): string =>
    [...head, sourceBlock, PRIVACY_NOTE].filter(Boolean).join('\n\n') + '\n';

  const url = (b: string): string =>
    `${ISSUE_URL}?title=${encodeURIComponent(title)}&labels=${labels}&body=${encodeURIComponent(b)}`;

  if (!isHeal) return { url: url(body('')) };

  const source = input.source!.trim();
  const inline = body(
    '**Locally patched source** (a maintainer can merge it and rotate the sha after audit):\n' +
      fence('js', source),
  );
  if (encodeURIComponent(inline).length <= BODY_ENC_CAP) return { url: url(inline) };

  // Too long to inline → carry the source via the clipboard, leave a placeholder.
  const placeholder = body(
    '**Locally patched source** (it is long, so it has been copied to your clipboard — paste it into the code block below):\n' +
      fence('js', '<paste here>'),
  );
  return { url: url(placeholder), clipboard: source };
}
