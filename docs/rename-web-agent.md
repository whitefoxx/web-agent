# Rename: `webchat-agent` → `web-agent` (2026-07-08)

One-time project rename. Recorded here as institutional memory: what the name
touched, how the replacement was done safely, what was intentionally left, and
the outward-facing steps (repo renames + folder move) that finish it.

## Scope decided with the user

- **Depth**: rename *everything*, including persisted `chrome.storage` keys — the
  existing dev install loses its saved LLM config / secrets / redaction patterns /
  log config on next load (no migration; accepted).
- **External**: also rename the local folder and the three GitHub repos.

## Token mapping

The literal brand token appeared in exactly three case variants; a naive
`web`-substring replace was **not** used (too broad). Case-sensitive, whole-token:

| from | to |
|------|----|
| `WebChat` | `Web` |
| `Webchat` | `Web` |
| `webchat` | `web` |

This single mapping covers every derived form: `webchat-agent`→`web-agent`,
`WebChat Agent`→`Web Agent`, `data-webchat-ref`→`data-web-ref`, `webchatLLM`→`webLLM`,
`WebchatWorld`→`WebWorld`, storage keys (`webchat:secrets`→`web:secrets`,
`webchat_llm_config`→`web_llm_config`), the port name `webchat-keepalive`→`web-keepalive`,
the overlay id `__webchat-som-overlay`→`__web-som-overlay`, the bridge MCP resource
scheme `webchat://`→`web://`, and both GitHub submodule repo names.

Applied over `git ls-files` (so `node_modules`/`dist` and the submodule *contents*
are naturally excluded — submodules are gitlinks, not listed) with
`perl -i -pe 's/WebChat/Web/g; s/Webchat/Web/g; s/webchat/web/g;'`.

## Internal initials also converted: `wca` / `wcagent`

~130 internal runtime markers used the old "WebChat Agent" initials
(`__wca_overlay`, `data-wca-mask`, `__wcaHideTimer`, `__wcagentSelToolbar`,
`wcagent-hl`, etc. — opaque DOM ids / attributes / `window` globals, self-consistent
and invisible to users). These were **converted** too, mirroring the brand rename:

| from | to | rationale |
|------|----|-----------|
| `wcagent` | `webagent` | `wc` (WebChat) → `web`, keep the `agent` word |
| `wca` | `wa` | WebChat Agent initials → Web Agent initials |

`wcagent` is replaced **before** `wca` (it starts with `wca`, so the other order
would corrupt it to `wagent`). The replace is **case-sensitive lowercase** on purpose:
two false positives — `rawCard` (`ra·wCa·rd`) and a base64 PNG blob in
`notifications.ts` (`…HA·wCA…`) — contain `wCa`/`wCA` with a capital C and are
therefore skipped. Touched 7 `src/` files + this doc's sibling
`docs/page-agent-comparison.md` (which names the tokens); no tests referenced them.
Verified after: `tsc` clean, tests pass, build OK.

## What changed, per repo

- **main repo** (84 files): `package.json` name, `manifest.json` name + tab title,
  `vite.config.ts`, all `docs/`, all `src/` (storage keys, DOM attrs, port name,
  tab-group title `WebChat Agent`→`Web Agent`, notification titles), `.gitmodules`
  submodule URLs, and `MARKETPLACE_BASE_URL`
  (`…/whitefoxx/web-agent-marketplace/main/`). Verified: `tsc --noEmit` clean,
  1801/1801 tests pass, `vite build` OK.
- **marketplace submodule** (public repo): `package.json`, `README.md`, and 5
  adapters whose only ref was a self-contained `__webchat_<site>__` scratch key
  (`twitter/reply-dm`, `linkedin/{jobs-preferences,profile-read,search,services-read}`).
  Because the install path enforces the hash, the 5 entries' `sha256` in
  `index.json` were **rotated** (recompute file hash → patch the matching `source`
  entry; exactly 5 sha lines changed, no reformat).
- **bridge submodule** (public repo): `server.mjs` (MCP server name → `web-agent`,
  resource scheme → `web://`, skill/repo references), `README.md`, `package.json`
  (`web-agent-bridge` + bin), and the two skill dirs renamed
  (`webchat-agent`→`web-agent`, `webchat-adapter-author`→`web-adapter-author`),
  their `name:` frontmatter updated to match. `node --check server.mjs` OK.

## Remaining outward-facing steps (finish the rename)

Order matters — push submodules to their *renamed* remotes before bumping the main
repo's pointers, or the pointers reference commits not yet on the remote.

1. **Rename the 3 GitHub repos** (redirects are kept, but we update remotes anyway):
   - `whitefoxx/webchat-agent` → `whitefoxx/web-agent`
   - `whitefoxx/webchat-agent-marketplace` → `whitefoxx/web-agent-marketplace`
   - `whitefoxx/webchat-agent-skills` → `whitefoxx/web-agent-skills`
2. **Point remotes at the new names**: update each submodule's `origin`, then
   `git submodule sync` in the main repo (propagates the new `.gitmodules` URLs
   into `.git/config`); update the main repo's `origin`.
3. **Commit + push, submodules first**: marketplace → bridge → then the main repo
   (which also records the bumped submodule pointers).
4. **Reinstall the skill** globally under its new name:
   `npx skills add whitefoxx/web-agent-skills -g` (the old
   `webchat-agent` / `webchat-adapter-author` skills stay installed until removed).
5. **Move the folder**: `mv …/webchat-agent …/web-agent`, reopen the session there.
   ⚠️ The unpacked dev extension's ID is derived from its path — moving it changes
   the ID, so re-add it in `chrome://extensions` (Load unpacked → `dist`). The
   `.claude` project/memory dir (`-Users-cyb-code-webchat-agent`) also keys off the
   old path.
6. **chrome.storage**: because the keys were renamed, the current install starts
   fresh — reconfigure the LLM endpoint/key + any secrets.
