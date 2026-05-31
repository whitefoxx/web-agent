# webchat-agent — working rules

## Always record findings & fixes into `docs/` (standing rule)

During any non-trivial investigation, fix, or audit, **summarize what you found
and what you changed into the relevant `docs/*.md` file as you go** — not only
after a bug, but for audits, design decisions, and "why it's this way" context.
This is the default mode of work here, every time.

- Bug fixes → append a numbered post-mortem subsection to the relevant doc
  (today that's `docs/adapter-hot-plug.md` §10.x) in the
  **症状 / 根因 / 修法 / 教训** shape, BEFORE committing the fix.
- Audits / sweeps → record the methodology, the bug-classes found, counts, and
  what was fixed vs. deferred, so the next pass starts from the map instead of
  re-deriving it.
- Link related sections; keep the running narrative so a cold reader can
  reconstruct the reasoning.

Rationale: this codebase's failures are cascading and environment-specific
(sandbox/userscript world, strip-and-inject eval, marketplace bundling). The
docs are the institutional memory that stops the same class of bug recurring.

## Marketplace adapters are hand-maintained

`marketplace/<site>/<name>.js` is the authoritative source (NOT regenerated
from opencli routinely). Never run `scripts/build-marketplace-index.mjs` for
normal work — it's gated behind `--i-know-this-wipes-local-edits`. Any edit to
an adapter source MUST rotate that entry's `sha256` in `marketplace/index.json`
in the same commit (install path enforces the hash —
`src/sidepanel/marketplace.ts`). See `docs/adapter-hot-plug.md`.

## Commit / push

Follow the global rule: do not commit or push automatically; ask first, except
when the user says "commit"/"push" for that turn.
