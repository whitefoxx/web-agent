# Web Agent — 架构文档

> **想快速了解项目?** 先看 README,然后从下面的「当前状态速览」表开始读本文。深入热插拔/市场设计另见 [adapter-hot-plug.md](./adapter-hot-plug.md)。
>
> **The system-level picture — the four repos, the three shells, the shared
> primitive base, and the migration plan that gets us there — is the English
> section immediately below (`## A. System architecture …`). The Chinese
> sections from `## 0.` onward are the full shell's own architecture and its
> running post-mortem history; read them for full-shell detail.**

## A. System architecture: one base, three shells, four repos (2026-09 →)

> Authoritative overview and plan of record. Supersedes the older framing where
> "Web Agent" was the whole story. New content is English per the repo's
> language rule; the legacy Chinese narrative below is left intact.

### A.1 The family

**localmd** (`~/code/localmd`, localmd.app) is an AI knowledge base whose agent
lives in the user's folder. It is one of the four products but not a browser
extension; it is a **consumer** of one of the shells below.

Three browser extensions are built from **one shared codebase** in this repo,
and they differ in exactly one axis — **which agent drives them**:

| shell | driven by | what it is |
| --- | --- | --- |
| **WebCLI** | third-party CLI agents (Claude Code, Codex, Cursor) over a local WS daemon | headless, agent-free; the pure primitive base |
| **localmd Connect** | ONLY the localmd app, over an MCP relay | the base + knowledge-base features (clip, annotations, inbox, browser data) |
| **Web Agent** (full) | its OWN built-in agent (runs standalone, no external agent) | the base + agent + the full product UI |

Read "Web Agent = WebCLI + an agent" and "localmd Connect = WebCLI + KB
features". The capability pyramid is WebCLI (bottom) → localmd Connect → Web
Agent (top), all sharing the same primitive floor.

### A.2 The shared primitive base — the whole point

Every shell exposes the **same primitive floor** for interacting with the
browser. There is deliberately no vertical/"site X" code in the base; a way to
reach a particular site is *data* (a skill) built on these primitives, never a
shipped tool. The floor is four groups:

1. **Generic browser tools** (28): `open_url` / `get_page_text` / `get_html` /
   `get_dom_outline` / `query_dom` / `find_in_page` / `get_interactives` /
   `click` / `type_into` / `fill_form` / `select_option` / `press_key` /
   `scroll_page` / `hover` / `drag_and_drop` / tab management / `screenshot` /
   `fetch_url` / `web_search` / webmcp — perceive, act, read back.
2. **`eval_js`** — asynchronous JavaScript in the page's MAIN world (its cookies,
   globals and APIs; returns JSON, reduces payloads to rows in-page). The escape
   hatch that lets an agent build *any* extraction/automation as a skill. This is
   the capability that replaces the old site-adapter marketplace.
3. **Recon primitives** — the "find the data" perception layer: `find_in_dom`,
   plus (being promoted from the full shell's explore suite into the base)
   `find_structured_data` (JSON-LD / `__NEXT_DATA__` / framework state in one
   sweep), `get_a11y_tree` (class-independent semantic tree), and network
   observation (which request produced this value, with bodies). `eval_js` can do
   all of these by hand; these are the ergonomic, cheaper, structured versions.
4. **Site scripts** — persistent page fixes (`create_site_script` /
   `preview_site_script` / list / enable / delete). Unlike the others this one is
   *stateful* (the extension stores and re-injects it), so it stays a real tool
   in the base; only its authoring becomes one sentence.

What is NOT a base primitive, and why:

- **Synthesis** (turning exploration into an adapter) is not a tool — the
  *consuming agent is itself the LLM* and synthesizes natively. Only the full
  shell, whose built-in agent needs a tool to do it, has a `synthesize_adapter`.
- **The `cli({})` adapter format + its pipeline runtime** is being **retired**
  (see A.5), replaced by `eval_js`-core skills. It is deliberately not promoted
  to a primitive.

### A.3 Repo topology

> **Updated 2026-09-07 — the open/closed premise is gone.** This section was
> written when only the two lean shells were to be open-sourced and the full
> Web Agent stayed closed; that asymmetry is what forced the inversion (shared
> code cannot live in a closed repo, so the base had to move out and the closed
> product depend on it). **Everything is open now** — `web-agent` included,
> MIT, its pre-split history dropped in favour of a clean start. The
> inversion still stands, but on different grounds: `web-tools` is the
> *release unit* for two extensions and the `npx`-installable daemon, with its
> own cadence, and a shell must not be able to reach into the full product.
> The original reasoning is kept below because it explains why the seams sit
> where they do.

Because two shells (WebCLI, localmd Connect) were to be **open-sourced** while
the full Web Agent stayed **closed**, and all three share the core, the shared
code could not live in the closed repo. The only clean arrangement inverts the
pre-P4 layout: the shared base + the two lean shells live in the base repo, and
the full product **depends on it**.

| repo | licence | contents |
| --- | --- | --- |
| **`web-tools`** | open, MIT | shared core + primitive base (browser tools + `eval_js` + recon + site scripts) + the **WebCLI** and **localmd Connect** shells + their manifests/builds/releases + the **skills and the WS bridge daemon** (folded in 2026-09-07, see below) |
| **`web-agent`** (this repo) | open, MIT | mounts `web-tools` + `marketplace` as submodules and adds `agent/` + `sidepanel/` + explore authoring + the full manifest. "Web Agent = web-tools + agent" at the repo level |
| **`localmd`** | open, MIT | the knowledge-base app; a consumer of localmd Connect |
| **`marketplace`** | open, **frozen** | the legacy `cli({})` adapter catalog; a transitional read path for the full shell only. Retired from localmd Connect 2026-09-06; still mounted here until P5 drains it |

> **`web-tools-skills` is gone.** The standalone-vs-fold decision recorded below
> was resolved on 2026-09-07 in favour of **fold**: the skills and `server.mjs`
> live in `web-tools/{skills,bridge}/`, `npx skills add whitefoxx/web-tools -g`
> is the install line, and the old repo is **archived** with a README pointing
> here. `web-agent-skills` (the full shell's separate, larger daemon) was
> **deleted**; one daemon now serves all three shells and only the port differs.
> The argument for keeping it standalone — its own release cadence — turned out
> to be the smaller cost: a skill that documents a tool surface belongs next to
> the code that defines that surface, or it drifts into telling an agent to call
> a tool the installed extension does not have.

Consolidations from today's layout:

- **`web-tools-skills` is a standalone repo TODAY — folding it into `web-tools`
  at P4 is an OPEN decision.** It exists now because `web-tools` (the base repo)
  does not yet — it is created at the P4 split — and the YouTube skill needed an
  installable home immediately, so the existing `webcli-skills` repo was
  **renamed** to it (history + daemon + the WebCLI driving guide preserved) and
  `skills/adapters/` added. At P4, decide the end state:
  - **fold into `web-tools/skills/`** (our earlier consolidation): one open repo,
    maximum merge; cost — `web-tools`'s `package.json` carries both the extension
    build and the daemon `bin`;
  - **keep standalone**: it is the **user-install / runnable unit** (`npx skills
    add …`, the `web-tools-bridge` daemon) with its own release cadence — a
    pushed skill ships without an extension release, the reason the marketplace
    was remote — and `web-tools`'s `package.json` stays clean.

  Default is to fold (the earlier agreement); pending the final call.
- **One skills source for all three shells.** WebCLI and CLI agents install it
  globally; localmd installs the adapter skills it wants into a KB's
  `.agents/skills/`; the closed `web-agent` mounts it as a submodule.
  **Deferred:** the full shell's own external-control daemon still lives in
  `web-agent-skills` (a different, larger daemon); folding that in is coupled to
  the external-control consolidation (P4/P5), not P2.
- **`marketplace` is frozen**, kept only as a transitional read path for the
  full shell; its worthwhile adapters are re-authored as `eval_js` skills.

### A.4 The seam — what is base vs. full

Dependency reality today (verified): `core/` (1.6k lines) imports nothing
full-shell; WebCLI's service worker touches only `core` + `tools` + `runtime`
(clean); localmd Connect additionally reaches `site-scripts/` + `selection/` +
`userscript/`. The `userscript/` + `adapters/` reach exists **only for the
marketplace executor** and disappears when adapters retire (A.5) — so that step
must precede the repo split.

Goes to `web-tools` (base): `core/`, the browser tools + `eval_js` +
site-scripts tools in `tools/generic/`, the promoted recon tools, `site-scripts/`,
the base half of `runtime/` (`page` shim, `registry`, `errors`, `log`), the base
half of `selection/` (`anchor` / `highlights-store` / `settings` — the
annotation primitives), `sandbox/` + `offscreen/`, the two lean shells and their
service workers, the shared half of `background/`, the two lean manifests.

Stays in `web-agent` (closed): `agent/`, `sidepanel/`, `explore/` authoring +
`tools/explore/` synthesis, `adapters/` + `userscript/` + `runtime/`'s pipeline
engine, `schedules/`, `shortcuts/`, the full-only tools, the full manifest, the
selection **toolbar** UI + its LLM actions.

Three places need a deliberate cut before the split — `runtime/` (page vs
pipeline), `selection/` (primitives vs toolbar), `background/` (shared vs
full-only) — enforced with a dependency-graph check, not by eye, so closed code
never leaks into the open repo.

**The seam trace (2026-09).** An import-closure walk from the two lean shells'
entry points (`background/webcli-service-worker.ts`, `webcli/popup.ts`,
`background/localmd-connect-service-worker.ts`, `localmd-connect/{options,popup,
web-relay,page-tools}.ts`) shows the closure is mostly `core/` + `runtime/` +
`tools/` + `site-scripts/` + `selection/` + the two shells — as intended — but it
leaks into four dirs it should not, through **four hub files**. These are the
concrete P4 untangles (each preserves behavior, gated by the full suite):

- **`messages.ts`** imports agent stores (`agent/{memory-store,notes-store,plan,
  session,session-store,api-types}`) and `schedules/store`. It is the shared
  message-protocol module the lean shells need, so it must not drag in
  agent/schedules state: split the message *types/protocol* from the store
  *imports*, or move the referenced stores behind the seam.
- **`background/runtime-state.ts`** imports `agent/session` — the lean SWs use
  runtime-state's busy hooks, not the agent session; drop that import (or lift
  the shared bit).
- **`background/offscreen-eval.ts`** imports `sidepanel/sandbox-host` — relocate
  the sandbox-host helper out of `sidepanel/` (it is eval plumbing, not UI).
- **`localmd-connect/region-shot.ts`** imports `capture/region-select` — a
  capture util; `capture/region-select` belongs in the base, the rest of
  `capture/` (if full-only) stays.

Split dirs needing a per-file cut (base vs full-only counts from the trace):
`runtime/` 12/2, `tools/` 60/13, `explore/` 4/5, `adapters/` 4/1, `userscript/`
4/1, `sandbox/` 1/1, plus `agent/` `sidepanel/` `background/` which are
full-heavy and become base-clean once the four hubs above are cut. The
entanglement is small and enumerated — P4 is a focused refactor, not open-ended.

**Phase 1 landed (2026-09-06) — the base import-closure is now leak-free (0
leaks, 95-file closure; full suite 2323 green; all three shells build).** Each
cut preserved behavior via a minimal seam, mirroring the established
`explore-gate` / bridge-hook injection pattern:

- **`core/explore-gate.ts` → `explore/session` (4 leaks: session + recorder +
  trace-store + types).** The seam now publishes a minimal `ExploreSessionSeam`
  interface — only the three members the base perception tools touch (`tabId`,
  `setSite`, `recordState`) — instead of `import type { ExploreSession }`. The
  full `ExploreSession` satisfies it structurally, so the full SW wires its
  getter with no cast.
- **`background/runtime-state.ts` → `agent/session` (3 leaks: session +
  session-store + api-types).** `ActiveSession` + the `activeSessions` map moved
  to a new full-only `background/active-sessions.ts` (it holds a `SessionState`).
  The base keep-alive learns "a session is running" through a probe
  (`setActiveSessionProbe`) the full SW wires to `() => activeSessions.size > 0`
  at boot — the lean shells never wire it, so the ping tracks bridge calls alone.
  Seven full-shell importers repoint to `active-sessions.ts`.
- **`messages.ts` → agent/schedules/adapters stores (5 leaks: plan +
  memory-store + notes-store + schedules/store + adapter-health-store).** The
  only base-closure edge into `messages.ts` was `runtime-state`'s
  `sendToSidepanel(m: Message)` (a pure forwarder) plus an inline
  `AdapterCommand` type reference in `tools/manifest.ts`. `sendToSidepanel` is
  now generic over `{ type: string }` (no union import); `AdapterCommand` +
  `ExploreAdapterArg` hoisted to base `tools/command-types.ts` (re-exported from
  `messages.ts` so its importers are untouched). `messages.ts` — and with it the
  full message catalog's stores — left the base closure entirely; the big
  `Message` union stayed intact (no split needed).
- **`localmd-connect/region-shot.ts` → `capture/region-select` (1, classification
  only).** `region-select.ts` is a zero-import leaf imported by BOTH the full
  sidepanel and the lean shell → it is base; `capture/` moves to `web-tools` in
  the physical split. No code change.

The `offscreen-eval → sidepanel/sandbox-host` edge the earlier trace listed is
not in the lean closure (offscreen-eval is full-only), so it needed no cut.

Phase 2 (the physical extraction into `web-tools` + dependency inversion) is the
remaining P4 work — see §A.8; it needs real-machine SW-keepalive verification
(the keep-alive probe above changed) and the open naming/key decisions.

### A.5 Adapters become skills; opencli traces removed

The 294-entry `cli({})` marketplace violates the base's own doctrine ("tool code
provides capability, never a particular tool") and rots (its YouTube adapter is
already broken against tightened `pot` preconditions). Building the first eight
replacement skills and testing them on a real machine exposed the deeper lesson
(user, 2026-09-06): **the project must not maintain per-site skills at all.**
Sites change constantly; an upstream catalog of extractors — in any form,
`cli({})` or `SKILL.md` — is a maintenance nightmare and the wrong place to spend
effort. The end state, uniform across all three shells:

- What the project maintains is the **base** (the generic tools + `eval_js` +
  the recon primitives + the `click` write-guard), kept sharp enough that an
  agent works out any site's specifics **live**, plus a **small number of hints**
  for the couple of sites where the obvious route actively fails (YouTube's
  pot-walled captions → the transcript panel; X's GraphQL from a tab). Those
  hints live in the `reach-a-site` skill (a localmd builtin; the same method
  ships to WebCLI's CLI agents via `web-tools-skills`). No per-site `SKILL.md`
  files are shipped.
- "a way to reach site X" is something **the user's own agent builds live** from
  the ladder and **saves into the user's own skills directory** — data they own,
  re-derived by their agent when the site changes. Not shipped, not upstream.
- The project's investment in *keeping* that true is a set of **probes**
  (`docs/tests/site-probes.md`): the eight recipes, folded from the retired
  per-site skills into curated tests, run periodically against common sites to
  answer one question — is the base still good enough to derive them live? A
  probe breaking because a site changed is expected (not our bug); a probe
  breaking because a base primitive can no longer express the route is a base
  gap → a finding.
- the full shell keeps its **on-demand generation** (explore) — its strength —
  and may keep the richer `cli({})` format as *one* possible skill core (a
  runtime-backed superset), but the static marketplace *catalog* is retired.

**opencli** was the original inspiration for the `cli({})` format and many
seed adapters; the capability is now fully internalized, and its traces are to
be removed. The references split into two kinds, and this decides the timing:

- **Attribution / naming** (~114 comments in `src/`, ~111 in `docs/` — the
  `runtime/opencli/` directory name, "borrowed from opencli" and source-path
  notes): pure text, removable independently.
- **A LIVE functional alias**: `@jackwener/opencli/registry` · `/errors` ·
  `/types` are module specifiers the **marketplace `cli({})` adapters actually
  import**, resolved by a Vite alias to our shims (`runtime/registry.js`,
  `runtime/errors.js`, `runtime/opencli/types.ts`). This is load-bearing —
  removing it breaks every marketplace adapter.

So the FULL removal is **coupled to retiring the adapter format** (P3/P5): the
functional alias can only go once nothing imports it. The attribution/naming can
be neutralized earlier (rename the directory to `runtime/pipeline/`, keep the
adapter-facing alias pointing at it, drop the "borrowed" framing), but even that
loses the "why" context of the shims, so doing the whole opencli pass **with**
the adapter retirement is cleanest. Runs with the tests as the guard, its own
commit(s). Keep one historical note per the dependency-minimalism convention.

### A.6 Capability alignment that makes the pyramid true

- **`eval_js` into the base** — done 2026-09-06 for localmd Connect; to be
  registered in the shared base so WebCLI gains it too.
- **Recon primitives into the base** — promote `find_structured_data`,
  `get_a11y_tree`, and network observation from explore-only to tab-addressed
  generic tools (the same rework `eval_js` got). This is the "make the base the
  best" investment: the perception half of building an adapter belongs in the
  base's identity, not behind an explore session.
- **Site scripts into WebCLI** — add the `userScripts` permission to WebCLI's
  manifest and a management/confirm surface to its popup (site scripts are
  persistent injected code; the user must be able to see and revoke them —
  localmd Connect delegates that to localmd's UI, WebCLI needs its own).
- **localmd Connect's CLI-agent surface** — already dev-only (a `hidden`,
  "dev build"-badged section; absent from the shipped build). No product overlap
  with WebCLI to remove; the dev daemon stays purely as the test harness, its
  copy just marked clearly as a testing affordance.

### A.7 Migration plan (phased, each with a gate)

Ordered so the messy couplings are removed before the repo split:

- **P0 — base capability alignment** (in-repo, low risk): register `eval_js` in
  the shared base (WebCLI gains it); promote the recon primitives; update the
  "one core, three shells" docs; mark localmd Connect's CLI-agent copy as dev.
  *Gate:* the three tool-surface pin tests stay green.
- **P1 — site scripts into WebCLI**: `userScripts` permission + popup
  management/confirm UI + the confirm contract. *Gate:* on a real machine,
  author a site script through WebCLI and pause/delete it from the popup.
- ~~**P2 — skills repo**~~ (done 2026-09): renamed `webcli-skills` →
  **`web-tools-skills`**, added `skills/adapters/` with the YouTube transcript
  skill + the robustness-ladder method, reframed the README, repointed the
  `webcli-bridge` submodule + every `npx skills add` / daemon reference. Folding
  in `web-agent-skills`'s larger daemon is deferred to the external-control
  consolidation (P4/P5).
- **P3 — adapters → skills, opencli cleanup**: retire `find_adapters` /
  `run_adapter` from localmd Connect (drops its `adapters/` + `userscript/`
  reach); remove the opencli traces (A.5). *Gate:* localmd Connect's dependency
  graph no longer touches `adapters/` / `userscript/`; tests green.
- **P4 — the seam + the repo split**: cut `runtime/` / `selection/` /
  `background/`; extract the `web-tools` open repo; make `web-agent` depend on it
  as a submodule; move builds/tests/release/keys. *Gate:* both open extensions
  build standalone from `web-tools`; the full extension builds from `web-agent` +
  the submodule; the whole suite is green.
- **P5 — full-shell unification**: land explore's output as the unified skill
  format; re-author the worthwhile marketplace adapters as skills; retire the
  static marketplace catalog.

P0/P1/P3(cleanup) deliver value in-repo and need no push; P2 and P4 are the
outward/structural steps and proceed on an explicit go-ahead.

### A.8 Open decisions

- ~~Final name for the open base repo~~ — **`web-tools`** (decided 2026-09-06).
- The exact WebCLI site-script confirm contract (CLI-agent-side confirm + popup
  standing control).
- Whether `web-tools`'s single `package.json` carrying both the extension build
  and the daemon `bin` is acceptable, or the daemon warrants its own package.

### A.9 P4 progress — Phase 1 landed, Phase 2 proven locally (2026-09-06)

**Phase 1 (seam cuts) — DONE + committed.** The base import closure is leak-free
(0 leaks, 95 files); the four hub entanglements were cut with minimal seams. Full
detail in §A.4 ("Phase 1 landed"). No runtime behavior changed except the
keep-alive's session signal (now a probe wired by the full SW boot) — that is the
one thing to confirm on a real machine.

**Phase 1.5 (build-surface cleanup) — DONE + committed.** Retiring the adapter
tools in P5-B left the adapter-eval build artifacts (sandbox / offscreen / runner)
+ an unused `offscreen` permission in the shipped localmd Connect. Removed; the
full extension keeps them. This also cleared the last *build-level* edge from the
lean localmd shell into `sidepanel/` (offscreen.ts → sidepanel/sandbox-host). See
`docs/localmd-connect.md` §15.8.

**Phase 2 (extraction) — PROVEN locally, materialized as a skeleton, NOT pushed.**
Per the chosen approach ("set up locally, don't create the public repo / don't
migrate keys"):

- Assembled a base-only tree (the 95-file lean closure + build infra, every
  full-only `src` file removed) and **built both lean shells from it standalone**.
  The service workers came out **byte-identical** to `web-agent`'s own builds
  (WebCLI SW 313 KB / hash `DP6OayLi`; localmd Connect SW 447 KB / hash
  `iRDWHCqb`). This is the build-level confirmation of the tracer's 0-leak result:
  no full-only file is reached through an HTML entry, an asset, or a Vite plugin
  either.
- Materialized it at `/Users/cyb/code/web-tools` (a local directory, **no git
  init, no push, no key migration** — the private `.pem`s were explicitly kept
  out). It has a lean `vite.config.ts` (webcli/localmd modes only, no
  sandbox/offscreen plugins), a `package.json` with the agent-only deps
  (`@ai-sdk/*`, `ai`) pruned (verified no base file imports them), and a README
  stating exactly this status. Builds verified again at that location.

**Phase 2 — DONE (2026-09-07): the split is real.** Executed as a MOVE, not a
copy, in two halves:

- **`web-tools` is a real repo** (`~/code/web-tools`, clean public history — two
  commits: the extraction + the toolchain pins; pushed by the user). It holds
  the 101-file base (the lean closure — `core/`, `tools/generic/` minus the five
  full-only tools, `tools/{manifest,command-types}`, `runtime/{registry,errors,
  page,log}`, `site-scripts/`, `selection/`, `capture/`, the two service workers
  + `runtime-state` / `agent-window` / `controlled-tabs`, `webcli/`,
  `localmd-connect/`), the two manifests, icons, store copy, the shell docs +
  release checklists, the pack script, 52 base tests, and the `webcli-bridge`
  submodule (WebCLI's daemon/skills moved with WebCLI). Its own lean
  `vite.config` (webcli / localmd modes only), pnpm, and deps pinned to the
  versions `web-agent` had resolved — plus overrides for rollup / postcss /
  lightningcss and vitest 3.2 (vitest 4 declares vite ^6+ and only ran in
  web-agent because npm nested a vite 8 under it) — so that a **fresh install
  rebuilds both shells byte-identical** to the real-machine-tested reference
  (webcli SW `73103489…`, localmd SW `cc2aa153…`; 606/606 tests).
- **`web-agent` was inverted.** The 101 files, the 52 base tests, both lean
  manifests, `store/{webcli,localmd-connect}`, the five shell docs and the
  `webcli-bridge` submodule were `git rm`'d; `web-tools` is mounted as a
  submodule (portable relative URL `../web-tools` → resolves to
  `whitefoxx/web-tools` for a GitHub clone); 320 import sites in 189 remaining
  files were rewritten from relative paths to **`@base/<path>`** (vite alias +
  tsconfig `paths` + vitest alias → `web-tools/src`; the opencli
  registry/errors shims now resolve into the submodule, the pipeline shims stay
  here as adapter machinery). `vi.mock` paths in tests needed the same rewrite —
  vitest mocks by resolved id, so a mock of a moved path silently fails to
  apply. `vite.config.ts` builds ONE target now (`dist/`); the lean modes,
  their dev keys and the relay/page-tools plugins left with the shells.
  Gate: tsc clean; the full SW came out at exactly the pre-split size
  (2,137,149 bytes); 1718/1721 tests (188/189 files — same skips as before).

The mixed-dir question (§A.4) resolved itself by leaving full-only stragglers
in place: `messages.ts`, `tools/explore/`, `tools/dispatcher.ts` + the tab-pool
files, `runtime/opencli/` + `network-recorder`, the five full-only generic tools
and the full `background/` drivers stay in `web-agent` and import the base via
`@base/*`, so no directory had to be relocated. `src/build-flags.d.ts` is kept
here as a harmless duplicate of the base's (an ambient `.d.ts`; simpler than
`include` gymnastics).

**The daemon + skills folded in too (2026-09-07, same day, on the user's
correction).** §A.8's question is settled the other way: `web-tools-skills` was
absorbed into `web-tools` as plain directories — `bridge/server.mjs` (the
`web-tools-bridge` bin; `ws` joins `dependencies`, and a
`npx -y github:whitefoxx/web-tools` install pulls only `dependencies`, never the
build devDeps) and `skills/{webcli,adapters,web-agent}/`. `web-agent`'s own
`bridge/` submodule (`web-agent-skills`: the same WS protocol plus an MCP-stdio
mode and `/guide`) was removed — one daemon serves all three shells, the port is
the only difference (8787 / 9376 / 9378) — and its `web-agent/SKILL.md` moved to
`web-tools/skills/`, trimmed of adapter talk. The `web-adapter-author` skill was
dropped (adapters are not a thing to author any more). MCP-stdio + `/guide` are
a follow-up for `web-tools`' daemon. Real-machine verification of the lean
shells now runs on `web-tools`' own artifacts (the release gate, §A.7 P4); the
full extension is unchanged byte-for-byte and is not being released yet.
`marketplace/` stays until P5 retires adapters from the full shell.

## 0. 当前状态速览(2026-05)

| 模块                               | 状态                                                                                                                                           | 说明                                                                                                                                                                                            |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **API engine(OpenAI-compatible)**  | ✅ 生产可用                                                                                                                                    | `src/agent/api-engine.ts`;支持任何 chat/completions 协议的 endpoint(DeepSeek/OpenAI/GLM/Kimi/MiniMax/...);SidePanel 菜单 → LLM 后端 配置                                                        |
| **Adapter 市场(Phase A pipeline)** | ✅ 生产可用                                                                                                                                    | 装即用,零额外配置                                                                                                                                                                               |
| **Adapter 市场(Phase B func)**     | ✅ 生产可用                                                                                                                                    | 需 Chrome 138+ + 用户在 `chrome://extensions` 开「允许用户脚本」开关                                                                                                                            |
| **Adapter 市场(submodule)**        | 286 个 adapter,~27 个站点。schema-v2: 116KB `marketplace/index.json`(metadata + sha256)+ per-adapter `<site>/<name>.js` | submodule `marketplace/`,GitHub raw 远程服务、**不再打包内置**;index.json 手维护,详 hot-plug §11                                                                                                          |
| **通用工具(generic)**              | ✅ 30 个                                                                                                                                       | `open_url` / `screenshot` / `scroll_page` / `get_text_from_tab` / `get_page_text` / `close_tab` / `get_interactives` / `click` / `click_by_text` / `type_into`(`_helpers` 是内部模块,不是 tool) |
| **写操作二次确认**                 | ✅ 实装                                                                                                                                        | SidePanel 弹窗 + 5 分钟超时,见 `service-worker.ts:WRITE_CONFIRM_RESP`                                                                                                                           |
| **会话持久化**                     | ✅ IndexedDB                                                                                                                                   | `session-store.ts`,跨 Chrome 重启幸存,DB v2 与 adapter store 共存                                                                                                                               |
| **session 内热刷工具列表**         | ✅                                                                                                                                             | adapter 装好下一回合就出现在 agent 工具白名单(见 hot-plug §a9c0371)                                                                                                                             |
| **跨 worlds bug 兼容**             | ✅                                                                                                                                             | `page.evaluate` 走 CDP MAIN world(详见 hot-plug §10.7)                                                                                                                                          |
| **测试**                           | 1423 个 vitest 用例,全 node 环境可跑                                                                                                            | `npm test`                                                                                                                                                                                      |

详细取舍记录:见各章 + [adapter-hot-plug.md §3 决策](./adapter-hot-plug.md#3-决策)。

## 1. 目标

把任意 OpenAI 兼容的 LLM 接入浏览器,让它能操作小红书 / YouTube / 知乎 / 微博 等已登录站点:

- **自带 API Key**:你出推理算力,扩展出工具生态 + 操作执行。任何 OpenAI chat/completions 兼容的 endpoint 都可。
- **运行时 adapter 热插拔**:adapter 装在 IndexedDB,跨重启幸存,无需重 build 扩展。
- **写操作有护栏**:`access: 'write'` 的工具默认隐藏 + 调用前 SidePanel 弹窗二次确认。

## 2. 三个运行时上下文

```
┌─────────────────────────────┐   ┌──────────────────────────┐
│   SidePanel UI (用户主界面)    │   │   Service Worker          │
│                             │   │  (路由 + Agent 编排)        │
│  - 聊天消息列表                │   │                          │
│  - 工具调用 trace 折叠卡片       │   │  - 消息路由               │
│  - 设置 / 历史 / 日志 子页面     │   │  - 会话持久化 (IndexedDB)   │
│  - 输入框 + 发送 + 终止         │   │  - 启动 api-engine        │
└────────────┬────────────────┘   │  - 调度 adapter 通过 PageShim │
             │                    │  - 聚合日志环形缓冲           │
             │                    └────────────┬─────────────┘
             │── USER_MESSAGE ──────────────────►
             │                                 │
             │                                 │── fetch /chat/completions ──► OpenAI-compatible API
             │                                 │◄────── tool_calls ──────────┤
             │                                 │
             │◄── ASSISTANT_TURN ───────────────┤
             │◄── TOOL_TRACE  ─────(many)───────┤
             │                                 │
             │                                 ├── adapter via PageShim ─────►┐
             │                                 │                              │ xiaohongshu Tab
             │                                 │◄────── result ───────────────┘ (CDP-driven)
             │                                 │
             │                                 │── fetch 下一轮 (tool result) ──►API
             │                                 │       …loop…
             │◄── ASSISTANT_TURN (最终总结) ─────┤
             │◄── SESSION_DONE  ───────────────┤
```

| 上下文             | 主职责                                                                           | 文件                                                                        |
| ------------------ | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **SidePanel UI**   | 用户聊天界面、tool trace 展示、设置/历史/日志面板                                | `src/sidepanel/`                                                            |
| **Service Worker** | 消息路由、agent 编排、adapter 调度、日志聚合                                     | `src/background/service-worker.ts`, `src/agent/`, `src/tools/dispatcher.ts` |
| **目标站点 Tab**   | 被 CDP / USER_SCRIPT 操作 — 无内容脚本,全靠 chrome.debugger / chrome.userScripts | (manifest 只声明 host_permissions)                                          |

## 3. Agent 循环(api-engine)

`src/agent/api-engine.ts:apiEngine.run()` 是核心循环:

```
1. session.status = 'running'
2. 拉 LlmConfig(provider / baseUrl / apiKey / model)
3. messages = [...persisted apiMessages, { role: 'user', content: userText }]
4. for iter in 0..maxIter:
     tools = openAiToolsFromRegistry()           # 每轮重新从注册表拉,新装的 adapter 当轮可见
     resp = fetch POST /chat/completions { messages, tools, tool_choice: 'auto' }
     msg = resp.choices[0].message
     emit assistant_turn (msg.content, msg.reasoning_content)
     messages.push(msg)                          # 含 tool_calls,把 assistant 整段回填
     if !msg.tool_calls: return DONE
     for call in msg.tool_calls:
       result = ctx.executeTool({ tool, args })   # 走 dispatcher → adapter → PageShim
       messages.push({ role: 'tool', tool_call_id, content: stringify(result) })
       emit tool_trace (started / completed / failed)
     persist session.apiMessages = messages
5. return max_iterations
```

`ctx.executeTool` 在 service-worker.ts 里包了**写操作守护**:工具的 adapter 如果声明了 `access: 'write'`,先发 WRITE_CONFIRM_REQ 给 SidePanel 弹窗,等用户点确认再继续(5 分钟超时视为拒绝)。

每个工具调用都发 `tool_trace`(started / completed / failed)给 SidePanel 展示折叠卡片。

## 4. System prompt

`src/agent/api-system-prompt.ts` 渲染:

- 项目身份 + 工具协议简介(用 OpenAI 原生 tool_calls)
- 工具一行摘要(按 site 分组,含 site\_\_name + 一句话描述)
- 写操作强提示("涉及发布/评论/关注等写操作必须先和用户确认")
- 流程建议(不熟悉的工具先 `describe_tool`,等结果再下一步)

每轮都从注册表新拉 tools 列表,所以装新 adapter 下一轮即可见。

## 5. 消息协议

定义在 `src/messages.ts`。所有 IPC 都用 `chrome.runtime.sendMessage`,payload 是结构化可克隆 JSON。

| 类型                                                                               | 方向           | 用途                              |
| ---------------------------------------------------------------------------------- | -------------- | --------------------------------- |
| `USER_MESSAGE`                                                                     | SidePanel → SW | 用户在 SidePanel 输入             |
| `ABORT_SESSION`                                                                    | SidePanel → SW | 终止当前会话                      |
| `REQUEST_LOGS`                                                                     | SidePanel → SW | 拉 SW 的日志缓冲                  |
| `LIST_SESSIONS` / `GET_SESSION` / `DELETE_SESSION`                                 | SidePanel → SW | 历史会话面板用                    |
| `WRITE_CONFIRM_REQ`                                                                | SW → SidePanel | 写操作前的二次确认弹窗            |
| `WRITE_CONFIRM_RESP`                                                               | SidePanel → SW | 用户的批准/拒绝                   |
| `ASSISTANT_TURN`                                                                   | SW → SidePanel | 每一轮 LLM 的清洗后回复           |
| `TOOL_TRACE`                                                                       | SW → SidePanel | 工具调用 trace(started/done/fail) |
| `SESSION_DONE`                                                                     | SW → SidePanel | 会话结束 + 原因                   |
| `ITERATION_PROGRESS`                                                               | SW → SidePanel | iter 进度(用于灰色进度条)         |
| `SESSION_NOTICE`                                                                   | SW → SidePanel | inline 通知                       |
| `LOG_ENTRY`                                                                        | 任意 → SW      | 日志条目转发到 SW 聚合            |
| `LOGS_RESPONSE`                                                                    | SW → SidePanel | 返回 SW 的日志缓冲                |
| `INSTALL_ADAPTER` / `UNINSTALL_ADAPTER` / `SET_ADAPTER_ENABLED` / `LIST_INSTALLED` | SidePanel → SW | adapter 市场流程                  |
| `ADAPTERS_CHANGED`                                                                 | SW → SidePanel | 装/卸触发列表刷新                 |

## 6. Adapter 来源:市场 + 运行时热插拔

**所有 site adapter 都从市场安装,无内置 site 目录。** `src/tools/` 只剩 `generic/`(站点无关的 open_url/click/screenshot/...)和 `manifest.ts`/`dispatcher.ts` 框架代码。

热插拔架构完整设计见 [docs/adapter-hot-plug.md](./adapter-hot-plug.md)。要点:

- **Phase A**(pipeline 型):sandbox iframe 一次性 eval 出纯数据 → 存 IDB → 由 `runtime/opencli/pipeline.ts` 解释器跑(无 eval)。装即用,零额外配置。
- **Phase B**(func 型):`chrome.userScripts` API(Chrome 138+)把 func 注入目标 tab 的 USER_SCRIPT world 跑;`page.evaluate/wait` 本地执行,`page.goto/getCookies/...` 通过 port RPC 回 SW 用 `PageShim` 兑现。需用户在「允许用户脚本」开关开。
- **市场**:`marketplace/` 是独立公共 repo 的 **git submodule**(286 个 adapter),运行时走 GitHub raw 远程拉取、**不打包进扩展**。schema-v2:metadata-only `index.json`(手维护,改 adapter 源即轮换其 sha256)+ per-adapter `<site>/<name>.js`。客户端 install 时 fetch 单个 .js 并 sha256 校验。远程市场 URL 的接口位已留好,只差 `baseUrl` 配置项。详 hot-plug §11。

`PageShim`(`src/runtime/page.ts`)暴露 `page.goto / evaluate / autoScroll / captureNetwork / pressKey / ...` 给 adapter(无论是 SW 直接 invoke pipeline 内置的,还是 Phase B 经 port RPC 兑现的)。内部用 `chrome.debugger` 直接发 CDP 命令。

## 7. 日志

`src/runtime/log.ts` 提供 `log()/warn()/error()/group()`,全部带 `[web:<scope>]` 前缀:

- `chrome.storage.local` 持久化开关 + 命名空间白名单
- 每个上下文维护本地环形缓冲(默认 500 条)
- 非 SW 上下文 fire-and-forget 一条 `LOG_ENTRY` 给 SW 聚合

> 2026-06 UI sweep:**面向用户的「日志」菜单页已移除**(见 §13)。`runtime/log.ts`
> 的内部日志系统照旧(`log/warn/error`、环形缓冲、`LOG_ENTRY` 上报),只是 SidePanel
> 不再渲染日志页,也不再 `subscribeLog()` / `REQUEST_LOGS`。需要回看日志走 devtools
> console。

## 8. 安全 / 边界

- **写操作 adapter 默认隐藏**:任何 `access: 'write'` 的工具(twitter/post、weibo/post、xiaohongshu/publish、reddit/comment、linkedin/connect 等)不出现在首轮工具摘要里。LLM 仍可通过 `describe_tool` 拿到 schema,但 system prompt 强调"涉及写操作必须先和用户确认",runtime 额外强制 WRITE_CONFIRM_REQ 二次确认弹窗。
- **限流自我保护**:`RateLimitedError`(来自 `PageShim` 检测到 captcha 跳转)会被 dispatcher 包装成结构化错误返回,prompt 明确要求不要重试。
- **CDP 权限**:仅在调 adapter 时 lazy attach,结束即 detach。`chrome.debugger` 的黄色提示条会出现在目标站点 tab。
- **不存储任何凭据**:复用浏览器已有的登录态,扩展不读 / 不存 password / cookie / api key 之外的内容。API key 走 chrome.storage.local,可在设置面板清空。

## 8.5 视觉 / 多模态(2026-06,模型驱动)

OpenAI 兼容 API 里,工具(tool）消息**只能是纯文本**,图片必须放进 **user** 消息的 `image_url` content block 才能喂给多模态模型(GLM-4.6V / gpt-4o 等)。整体**按 profile 开关**:`LlmConfig.vision`(设置页「多模态模型」勾选);关闭时纯文本模型完全不受影响(收到图片内容会 400)。

**核心:URL 图全由模型决定要不要看(纯模型驱动),不靠正则猜。**

所有图片 URL——无论是用户在消息里给的,还是工具结果里返回的——都**只作为文本**进入上下文(user 消息原文、tool 结果 JSON)。引擎**不**用正则去抽 + 硬塞图。原因有二:① 正则会漏(用户给的图床地址不一定匹配 pattern);② intent-blind(用户说「把这张图链接发到评论 https://x.jpg」其实不需要看图,硬塞既浪费又可能误导)。

做法:给 vision profile **额外注册一个 `view_image({images, purpose})` 工具** + system prompt 说明(「需要分析图片内容才调;只是传递链接就别调」)。模型读到 URL + 用户意图后,**自己决定**要不要看、看哪几张,调 `view_image` 传 URL。引擎**拦截** `view_image`(不走 dispatcher):只校验是不是 http(s)(**不**做图片 pattern 门控——模型既然要看就信它,避免误拒不常见的图床 URL)→ 回一条 ack tool 消息 → 把 URL 排进 `turnImages`。这一步 = 模型**原生 function-calling** 的参数充当「干净的图片地址 + 意图」,不另起一次抽取 LLM 调用。

**截图(base64)是例外——仍自动呈现**:`generic__screenshot` 返回的 `data:image/...;base64,...` **没法当 tool 参数回传**(太大,模型没法按引用请求它),所以 data URL 仍由引擎自动收(`collectImageRefs(...).filter(isDataUrl)`)并直接呈现。即「URL 图 → view_image(模型决定);截图 → 自动给」。

**组装规则**(共用):本回合所有图(view_image 的 + 截图的)汇成**一条** user 消息,放在**所有 tool 消息之后**——assistant 的每个 tool_call_id 必须被连续 tool 消息应答,中间插 user 消息会 400。图片**只活一轮**:`sanitizeHistory` 在下一轮 seed 时把旧图 user 消息降级成文本占位(省 token,且避免重放给中途切换的文本模型)。

**评审揪出的坑(已修)**:SVG 视觉端点拒收→排除;小红书等无扩展名图床→host 白名单;跨 profile 重放/悬空 tool_calls→`sanitizeHistory` 修。见 `tool-images.test.ts` / `sanitize-history.test.ts` / `fetch-image.test.ts`。

**未决**:`fetch-image.ts toVisionDataUrl`(SW 取图转 base64,绕 hotlink)已备好但**未接线**——实测 sina 图 GLM 能直接抓,故 view_image 目前传原始 URL;将来某图床 hotlink 抓不到再接。

## 8.6 多模型协作 / 能力槽位(2026-06)

不再「选一个 active 模型」,而是把每个**能力**指派给一个模型(profile)。

**数据模型**(`src/config/llm-config.ts`):
- **profile** = 一套凭据(provider/baseUrl/apiKey/model),不变。
- **能力槽位** `slots: { primary, vision?, image? }`(可扩展 audio/video):每个能力 → 至多一个 profileId。
  - `primary` 必填:agent loop 跑在它上面(orchestrator)。`loadLlmConfig()` 返回它。
  - 一个 profile 可填多槽(多模态模型 = primary + vision)。每槽 ≤1 模型 → 无歧义。
- `resolveSlots()` 一次读出 `{primary, vision, image}` 三个 profile(null=未配置/悬空)。`setSlot(cap, id|null)` 指派/清空。
- **迁移**:旧 `{activeId, profiles}` → `slots.primary = activeId`;profile 上旧的 `vision:true` 标志 → `vision` 槽。

**主模型怎么用专门模型**(`api-engine.ts` + `specialist.ts`):
- 每个**已配置**的非主槽位,给主模型暴露一个工具:`view_image`(视觉)、`generate_image`(图像)。system prompt 动态列出已配置/未配置能力——任务需要未配置能力时,主模型据此告知用户去「模型分工」添加。
- 主模型调工具 → 引擎**拦截**(`handleSpecialistCall`,不走 dispatcher)→ 路由到该槽 profile 的 API(`specialist.ts` 里 `visionDescribe` 调 `/chat/completions`、`generateImage` 调 `/images/generations`)→ 结果回灌主模型(tool result)。
- **视觉两条路**(取决于 vision 槽指给谁):
  - `vision 槽 === primary`(多模态主模型):`view_image` 把图 **inline** 注入主模型自己的上下文(§8.5 的机制)。
  - `vision 槽 = 另一个模型`:`view_image` 对视觉模型发**一次性子调用**(「看这些图,回答:<purpose>」),把它的文字答案作为 tool result 返回主模型。
  - 截图(data URL)只在 `visionInline` 时自动呈现——base64 没法走子调用,文本主模型看不了截图。

**配置 UX**(SidePanel 设置):
- 「模型分工」区:每个能力一个下拉(选 profile / 未配置),主模型必填。
- 「API Keys」区:profile 增删改;卡片上用 badge(主/视觉/图像)显示它填了哪些槽。新建第一个 profile 自动当主模型。

**测试**:`llm-config.test.ts`(槽位 + 迁移)、`specialist.test.ts`(子调用)。

**评审揪出的坑(已修)**:① 主模型槽不能被清空(UI 隐藏「未配置」+ `setSlot` 拒绝在有 profile 时清 primary)——否则一下拉就把 agent 整个废了;② `deleteProfile` 删主模型时优先顶上一个**有 key+baseUrl 的可跑** profile;③ 图像生成返回 base64(无 URL)时,若主模型多模态则 inline 给它看,不丢图;④ specialist 子调用前校验 apiKey/baseUrl,缺了给清晰报错;⑤ `postJson` 对 200-但非-JSON(网关/HTML 拦截页)给清晰错误而非裸 SyntaxError;⑥ base64 图按 magic bytes 猜 MIME(不再一律 png)。

## 8.7 统一到 Vercel AI SDK(2026-07)

主 chat 客户端从「手写 `/chat/completions` fetch + SSE 解析」换成 **Vercel AI SDK**,目的与 localmd.app 同款:接入尽量多的模型、把接口适配与协议漂移交给第三方 SDK 维护,**用各家自己的 key 直连各家端点(无聚合器/网关)**。

- **provider 层**(`src/config/model.ts` 新增):`profile → AI SDK LanguageModel`。Anthropic/OpenAI/DeepSeek/Google/xAI/Groq 各有专用 `@ai-sdk/*` 包(**Base URL 与适配内置,用户只填 key + model**);GLM/Kimi/MiniMax/Qwen/Custom 走 `@ai-sdk/openai-compatible`(Base URL 来自预设或手填)。`llm-config.ts` 的 `ProviderPreset` 加 `sdk` 判别字段 + `needsBaseUrl`/`sdkKindFor`/`isMultimodalProvider`/`canonicalBaseUrl`/`restBaseUrl` 辅助。
- **client 层**(`chat-completion.ts` 重写):**保持 `ChatCompletionResponse`(OpenAI 形状)契约不变,150KB 的 `api-engine.ts` 引擎循环零改动**。内部:OpenAI 形状 messages/tools → AI SDK `streamText`(单回合,tools **不带 execute** → 工具调用回传给引擎自己 dispatch),再转回 OpenAI 形状。system 走 `instructions`(不能进 `messages`)。保留原 idle-guard(180s 停顿看门狗,按 fullStream part 重置)+ 有界重试(`maxRetries:0`,本循环自己重试以沿用原 policy)。删除 `model-patch.ts`(SDK 按 provider 处理 max tokens)与 `stream.ts`(不再手解 SSE)及其测试。
- **provider 线穿**:`chatCompletion` 新增可选 `provider`(缺省 = openai-compatible,沿用旧行为),引擎 4 处 `complete()` + page-llm / selection-actions / explore(synthesize/consumer-test,`SynthModel` 加 `provider`)全部传 `cfg.provider` / `primary.provider`。
- **专用槽位(vision/image)按 provider 分流**(`specialist.ts`):
  - **native provider(Anthropic/OpenAI/DeepSeek/Google/xAI/Groq)→ 走 AI SDK**:`visionDescribe` 用 `generateText` + image parts,`generateImage` 用 `generateImage`(openai/google/xai 的 `.image()`,见 `model.ts` 的 `toImageModel`/`providerHasImageModel`)。**所以任意 provider 都能作独立视觉/图像槽**,不再限于多模态主模型内联。
  - **openai-compatible(GLM/Kimi/Qwen/MiniMax/Custom)→ 仍走原生 fetch**:那里的 per-provider 图片 URL 怪癖(GLM 裸 base64、Kimi 不收 http URL,见 `imageUrlForProvider`)AI SDK 表达不了,必须保留;image-gen 的 Dashscope 原生端点(qwen-image/wanx)同理。空 Base URL 由 `restBaseUrl(profile)` 兜底成 canonical REST base。
- **约束不变**:扩展有 `<all_urls>` host 权限,无浏览器 CORS 限制;AI SDK provider 无浏览器 guard,MV3 service worker 里正常 bundle(build 已验证,`ai` + 7 个 provider 包进 `service-worker`,WebCLI 壳不含 agent 故不受影响)。
- **未做/后续**:引擎循环本身没换成 `streamText` 多步循环(planning/compaction/specialist 太精细,风险不划算);实调用需用户 key 验证。

## 9. 已知限制 / 后续工作

| 限制                                | 影响                                                                        | 后续                                                       |
| ----------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Service Worker 可能被 Chrome 杀掉   | 长任务(>30s 无活动)可能中断;SidePanel 打开时有 Port keepalive 缓解          | 用 chrome.alarms 自 ping;或迁移长任务到 offscreen document |
| 工具调用串行                        | 当前每轮顺序处理 tool_calls;同轮多个 tool_calls 一个一个跑                  | 改成 Promise.all 并发(写操作弹窗会串行化,但读操作可并行)   |
| 跨 worlds 性能开销                  | `page.evaluate` 每次走 RPC → CDP(详 hot-plug §10.7)                         | 用 `page.evaluateMain()` 显式分流;或脚本编排端整段 batch   |
| 装好的 marketplace adapter 升级路径 | 改 source 序列化方式后用户必须手动 uninstall + reinstall(详 hot-plug §10.8) | 加 "source schema version" 字段 + 启动时自动迁移           |
| 无 streaming 渲染                   | 整段 assistant 文本一次性显示;tool trace 是即时的                           | 改成 SSE 走流 + 增量推 ASSISTANT_TURN_PATCH                |
| sandbox.html 控制台报 cross-origin  | 良性噪音,不影响 install/capture/vision;删 WAR 没修掉(详 hot-plug §10.17)   | 疑似 MV3 sandboxed-iframe 平台噪音,待查 |
| 视觉:图片仅当回合可见 + 8 张/回合上限 | 续聊时旧图降级为文本占位(省 token);超 8 张丢弃                              | 需要时调大上限 / 历史里存缩略引用 |

## 10. 文件结构速查

```
web-agent/
├── manifest.json                       # MV3, side_panel only(无 content_scripts)
├── src/
│   ├── background/
│   │   └── service-worker.ts           # 消息路由 + api-engine 入口 + WRITE_CONFIRM 弹窗状态机
│   ├── agent/
│   │   ├── api-engine.ts               # apiEngine.run()(OpenAI-compatible chat/completions + tool_calls 循环)
│   │   ├── api-system-prompt.ts        # system prompt
│   │   ├── api-types.ts                # ApiMessage / ToolCall 共享类型
│   │   ├── engine.ts                   # AgentEngine 抽象 + 共享类型(OrchEvent / SessionDoneReason / ...)
│   │   ├── session.ts                  # SessionState 类型 + 状态 transitions
│   │   └── session-store.ts            # IndexedDB 会话持久化(跨 Chrome 重启幸存)
│   ├── config/
│   │   └── llm-config.ts               # LLM 后端多 profile 配置(每条 = provider/model/baseUrl/apiKey/label/id;active 一条),存 chrome.storage.local
│   ├── messages.ts                     # 跨上下文 message 协议(SidePanel ↔ SW)
│   ├── runtime/
│   │   ├── page.ts                     # PageShim(CDP Runtime.evaluate → MAIN world + chrome.cookies/tabs/debugger)
│   │   ├── registry.js                 # cli({...}) 注册表 + _installed 标 + _version 热刷计数
│   │   ├── errors.js                   # RateLimitedError / AuthRequiredError / EmptyResultError 等
│   │   ├── log.ts                      # 带配置开关的日志(scope 白名单 + 环形缓冲)
│   │   └── opencli/
│   │       ├── pipeline.ts             # Phase A pipeline 解释器(运行期零 eval)
│   │       ├── utils.ts, logger.ts, types.ts  # opencli 浏览器版 shim
│   ├── tools/
│   │   ├── manifest.ts                 # adapter 类型 + openAiToolsFromRegistry + lookupAdapter
│   │   ├── dispatcher.ts               # 三路调度: generic / pipeline / installed-func
│   │   └── generic/                    # 30 个站点无关原语(open_url/get_page_text/screenshot/scroll_page/
│   │                                   #   get_text_from_tab/close_tab/get_interactives/click/click_by_text/
│   │                                   #   type_into,_helpers 是内部模块非 tool)
│   ├── sandbox/
│   │   ├── eval-core.ts                # 纯函数 stripModuleSyntax + evalAdapterSource(node 单测)
│   │   ├── eval-host.ts                # sandbox iframe 内消息宿主(EVAL_ADAPTER ↔ EVAL_RESULT)
│   │   └── sandbox.html                # 模板(实际产物由 vite.config.ts 的 sandboxPagePlugin 内联生成)
│   ├── userscript/                     # Phase B func adapter
│   │   ├── runner.ts                   # USER_SCRIPT-world IIFE 入口(esbuild → dist/userscript-runner.js)
│   │   ├── run-in-page.ts              # in-page runner 可测核心(makeLocalPage/runAdapterInPage)
│   │   ├── rpc-server.ts               # SW 侧用 PageShim 兑现 chrome.*/CDP/MAIN-world 类 page.*
│   │   ├── sw-runner.ts                # configureWebWorld + 编排循环(navigate-then-reinject trampoline)
│   │   ├── protocol.ts                 # PORT_NAME / WORLD_ID / 消息类型
│   │   └── chrome-userscripts.d.ts     # 类型补丁(@types/chrome 落后于 Chrome 138 API)
│   ├── adapters/
│   │   ├── install-manager.ts          # installFromCaptured / loadOnBoot / setEnabled / uninstall
│   │   └── installed-store.ts          # IndexedDB(DB v2,与 session-store 共存)
│   └── sidepanel/
│       ├── App.tsx                     # 主 UI(聊天 + 工具 trace + 菜单 → 8 个子页面)
│       ├── Adapters.tsx                # 「已安装」「探索生成」「市场」三 tab + 贴码安装 + 启用/卸载
│       ├── Icons.tsx                   # 内联 SVG 图标集(Lucide 风)
│       ├── Markdown.tsx                # marked + dompurify 渲染助手
│       ├── adapters-client.ts          # 跟 SW 的 install/list/uninstall RPC
│       ├── marketplace.ts              # fetchMarketIndex + fetchAdapterSource(sha256-verified)+ FEATURED_IDS
│       ├── sandbox-host.ts             # 持有隐藏 sandbox iframe 转发 eval(install path)
│       ├── types.ts, main.tsx, index.html, style.css
├── marketplace/                        # schema-v2(详 hot-plug §11):116KB metadata-only index.json + per-adapter <site>/<name>.js
│   ├── index.json                      # {version:2, adapters:[{site,name,...,source,sha256,tier,author,version}]}
│   └── <site>/<name>.js                # submodule adapter source(286 个文件)
├── tests/                              # vitest, 1423 用例(全 node 环境)
├── scripts/
│   ├── import-adapter.mjs              # build-time 单 adapter 同步(开发者用,非用户路径)
│   └── build-marketplace-index.mjs     # 生成 marketplace/ 树(esbuild bundle 相对 import,详 hot-plug §10.8)
└── docs/
    ├── architecture.md                 # 本文件 — 整体架构 / 当前状态 / 安全 / 限制
    └── adapter-hot-plug.md             # Phase A + Phase B ADR + 踩坑总结 + 市场 v2 schema(§11)
```

## 11. 历史教训速查

写在每个章节里的"取舍"已经够多了,但有几个跨章节的坑值得单独标出来(完整 post-mortem 见 [adapter-hot-plug.md §10](./adapter-hot-plug.md#10-phase-b-真实部署的坑)):

| 坑                                                                                    | 教训                                                                           | 详                         |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------- |
| diag marker 在 USER_SCRIPT 写、SW MAIN world 读 → 永 null                             | **跨 world 通信只能走 DOM 或 postMessage**,`globalThis` 隔离                   | hot-plug §10.2             |
| USER_SCRIPT port → SW 永远收不到                                                      | Chrome 把 USER_SCRIPT 连接路由到独立事件 `onUserScriptConnect`(非 `onConnect`) | hot-plug §10.3             |
| goto trampoline 因 tracking 参数无限循环                                              | 网页 URL 不稳定,匹配用 origin+pathname+params subset 而非 strict-equal         | hot-plug §10.4             |
| `page.evaluate` 从 CDP MAIN 换到 USER_SCRIPT 本地后,所有 `window.<global>` 静默返回空 | **换执行环境时必须逐条对照旧语义**                                             | hot-plug §10.7(2026-05 修) |
| marketplace 存 source 原文 → 相对 import 运行时 ReferenceError                        | **marketplace 化 = 自包含化**,隐式依赖必须显式 inline                          | hot-plug §10.8(2026-05 修) |
| 改 source 序列化方式后老用户必须手动重装                                              | 加 "source schema version" 字段 + 启动时自动迁移                               | hot-plug §10.8(后续)       |
| 注入 scope 两份手抄、runtime 那份全是 stub → htmlToMarkdown/mapConcurrent 静默错、错误类 instanceof 失效 | **「能跑/能看到什么」写一处**;stub 别泄漏到 runtime                  | hot-plug §10.18(2026-05 修) |
| SW 才一会就被回收 + 「继续」丢上下文                                                   | **保活靠主动 chrome.\* 活动而非空闲 port**;恢复路径 UI 文案要跟 sessionId 走向对账 | hot-plug §10.19(2026-06 修) |

## 12. 关于 chat-tab 模式(已移除)

早期版本支持第二种 LLM backend:hijack 一个已登录的 chat.deepseek.com 网页做推理(零 API Key)。涉及:

- `src/connectors/deepseek/` 内容脚本(textarea inject + MutationObserver 等响应)
- `src/agent/orchestrator.ts` 文本协议循环 + Driver 抽象
- `src/agent/system-prompt.ts` 分层 prompt + `command-parser.ts` 抽 `<agent-command>` 代码块
- service-worker 里大量 tab tracking(`chrome.tabs.onRemoved` / `onUpdated` → 暂停会话)、`ENSURE_CHATBOT_TAB` / `INJECT_PROMPT` / `CHATBOT_RESPONSE` / `CHATBOT_BUSY` / `CHATBOT_STREAMING` 等
- SidePanel 里 paused/resume banner、status pill 双分支、`SESSION_PAUSED` 事件
- session.ts 里 `chatbotTabId` / `conversationId` / `conversationUrl` / `pendingPrompt` / `pauseReason` 字段
- llm-config 双分支存储

去除原因:DeepSeek 的 "Server is busy" 自动重试虽然有,但用户体验仍受 chatbot 端的不可控影响;一套代码扛两种 backend 让 SW + UI 都更复杂;真正"零 API key"的卖点变得脆弱(chatbot 改 selector 就立坏)。删除后服务端代码净减 ~700 行,SidePanel ~200 行,manifest 不再需要 chat.deepseek.com 的 content_scripts。`loadLlmConfig` 仍能识别老的存储 shape(legacy api-only / 双分支转型期形态)透明迁移,所以升级不会丢已配置的 key。

## 13. 2026-06 SidePanel UI sweep

一轮面向"页面太乱/文案过时"的界面整理,分多个 commit。逐项:

1. **输入框提示行去掉**:`Enter 发送 · AI 可能出错… · {model}` 那条 `.hint` 删除。
2. **欢迎语**:`WelcomeCard` 原文写死 DeepSeek + 小红书,改成模型无关 / 站点无关 + 反映现功能
   (总结当前页、跨站调研、`/explore` 探索新站)。
3. **Adapters 卡片瘦身**(`Adapters.tsx`):
   - `SourceControls` 三按钮(查看/下载/复制)收敛成只有「查看源码」;复制按钮挪到展开代码块
     右上角(absolute);下载整条移除(连带 `filename` prop、`onDownload`)。
   - 运行展开区:`ArgsForm`/`RunPanel`/`CommandRunner` 增加可选 `onCancel`,运行按钮旁出现
     「取消」(InstalledRow 传 `onToggleRun` 收起)。
   - 市场「⭐ 推荐」featured 区块移除(连带 `FEATURED_IDS` 引用、`featured` memo/prop、
     `MarketRow.accent`)。
4. **菜单 / 图标**(`MenuDropdown` + `Icons.tsx`):
   - 顺序:**历史会话置顶**;**日志页整项移除**(见 §7,内部日志系统保留)。
   - 记忆的 🧠 emoji → 新增统一描边 `IconBrain`;Adapters 的拼图 `IconPuzzle` → 更贴切的
     `IconPlug`(插头=适配器);修掉「外部控制」与「日志」共用 `IconTerminal` 的重复
     (日志删了顺带解决)。
   - **日志彻底下线**:View 联合去掉 `'logs'`、`PAGE_LABELS.logs`、`LogsSection`、`logs/logCfg`
     state、`requestLogs`、`subscribeLog` 订阅、`LOG_ENTRY` case、`append<T>` helper、相关
     message 类型与 `runtime/log` 的 UI 侧 import,以及 `.logs-page/.log-viewer` CSS。
5. **记忆页**(`MemorySection`):原本只读 + 删除,现支持**新增**(`ADD_MEMORY`)+ **行内编辑**
   (`UPDATE_MEMORY`,store 新增 `updateMemory` 保留 id/createdAt);UI 重做(`.memory-*` 样式,
   复用删掉的 logs CSS 空间)。
6. **历史页**(`HistoryPage`):列表页**加搜索框**(按 preview 子串过滤,`.history-search*` 样式);
   去掉右上角「刷新 + X」——`PageOverlay` 本就有左上返回箭头,二者冗余。

教训:`logs` 这类"看似一个菜单项"的功能其实横跨 message 协议 / SW handler / state / 事件流 /
helper / CSS 六处,删要顺藤摸瓜删干净,否则 lint 的 unused 会把漏网之处抓出来——这次正是靠
`tsc --noEmit` + `eslint` 逐个收尾。

## 14. 图片 / 文本文件上传(2026-06)

composer 新增 📎 上传按钮(`IconPaperclip`),`<input type=file multiple>` 接图片 + 纯文本。

- **图片**:走既有的 `attachedImages` → `UserMessageReq.images` → engine 的 `image_url`
  通路(见 §8.5)。**上传前 gate**:`hasVision` state 由 `resolveSlots().vision != null`
  推导(随 `llmConfig` 变化 re-check);没视觉模型则不进附件,弹一条 `attachNote` 提示去
  「模型分工」配置。读法:`FileReader.readAsDataURL`。
- **文本文件**:**没有 remote endpoint 存储**,所以 attach 时 `readAsText` **即时内联读取**,
  存成 `{name, content}` 进 `attachedFiles` state。发送时折进消息文本(```fenced``` 的
  `[附件文件: name]` 块),聊天气泡只显示 `📎×N` 标记(`startRun` 新增 `opts.displayText`
  把"展示文本"和"发给模型的文本"解耦)。大小上限 200 KB(`MAX_TEXT_FILE_BYTES`),
  超限/非文本/读失败都走 `attachNote`。
- **打开**:浏览器扩展拿不到真实本地路径、也不能 `file://` 导航,所以"新 tab 打开本地路径"
  做不到;退而求其次用**应用内查看器**——点文件 chip 弹 `.file-viewer` 浮层(类似 lightbox)
  显示内容。`accept` 白名单 + 文件名扩展名双判定决定 image/text/拒绝。

## 15. 自探索 adapter 的独立命名空间(2026-06)

**问题**:市场 adapter 和自己 explore 生成的 adapter 可能指向同一个网站(都叫
`xiaohongshu`),于是 explored `xiaohongshu/search` 会和市场 `xiaohongshu/search` **撞键**——
registry 按 `site/name` 去重(last-write-wins)、installed-store 也按 `site/name` 存,二者会
**静默互相覆盖**。

**选择(产品决策)**:自探索 adapter 进**独立命名空间**——`site` 带保留前缀 `my-`,工具 id 变成
`my-xiaohongshu__search`,与市场池天然不撞。代价:同一站点可能并存两套工具(市场 + 本地),这是
用户接受的取舍。

**实现**(`src/adapters/namespace.ts` 为单一事实源,导出 `EXPLORED_SITE_PREFIX` /
`toExploredSite` / `baseSite`):

- **写入侧**:`installFromCaptured` 里,仅当 `origin.type === 'explore'` 时把每个 def 的
  `site` 过 `toExploredSite`(幂等),之后 id / 注册 / 持久化全用前缀后的 site。市场/manual 原样。
- **路由侧**:tab 路由是唯一和 `site` 耦合的地方(`dispatcher.ts` 的 `SITE_LANDING_URL`/
  `SITE_QUERY_URL` 硬编码表 + `domain` 兜底)。在 `humanPaceForSite` 和 `ensureSiteTab` 入口
  用 `baseSite` **剥掉前缀**,所以带前缀的 explored adapter 路由行为和不带前缀**完全一致**
  (反爬节流也共用真实站点的桶)。
- 前缀**不能含 `__`**(那是 `site__name` 工具 id 分隔符,`lookupAdapter` 按第一个 `__` 切),
  单个 `-` 既满足 OpenAI 工具名 `^[a-zA-Z0-9_-]{1,64}$` 又不破坏切分。
- explore **会话内**的 `registerSessionDefs` 不加前缀(临时、随 SW 重启消失),让试跑用真实站点
  保真;走 `installFromCaptured` 持久化时才落到独立命名空间——持久层不再撞键即达成目标。
  (2026-07-11 起触发点从用户点「安装」改为**试跑通过自动入库**,映射不变,见 adapter-hot-plug §10.46。)
- UI:Adapters 卡片对 `origin.type === 'explore'` 显示「本地探索」badge,与「来自市场」对称。

教训:`site` 不只是标识符,还是 dispatcher 的 tab 路由键(硬编码表 + domain 兜底)。要给 adapter
换命名空间,必须在"唯一消费 site 做路由"的两个函数里把前缀剥回真实站点,否则 explored adapter 会
开错/开不出 tab。把前缀逻辑收敛到一个模块 + 两个剥离点,是这次能安全落地的关键。

## 16. 下拉菜单页面统一 item 卡片 + 移动端化(2026-06)

**问题**:右上角下拉菜单的几个页面里,"列表项"各写各的——三套互不相干的视觉 + 交互:
- Adapters:`.adapter-card`,点 head 展开源码;
- 快捷方式:`.shortcut-item`,点 head 展开 + **动作按钮 hover 才出现**;
- 工作流:复用 `.shortcut-item` + 内联 style + 原生 `<details>`(第三种展开机制)。

加上 sidepanel 很窄(类手机),`hover` 出动作在触屏/窄屏上既发现不了也点不到,整体"丑、不直观"。

**设计方向("Transmission" 操作员清单)**:把三类项收敛成**一套** item 卡片(`.item-*`),按移动端来:
一行平静可扫(类型 glyph 琥珀小方块 + 标题 + 次要信息 + 右侧 chevron),**点整行手风琴展开**成
"档案"(chips + 描述 + 代码/预览 + 动作条)。所有动作**常驻可见、不靠 hover**;主动作用 tonal 琥珀
(`.btn.tonal`),破坏性动作(删除/卸载)安静靠右(`.spacer` = `margin-left:auto`,平时灰、交互才红)。

**实现**(`style.css` 新增统一区块 + `App.tsx` / `Adapters.tsx` 迁移):
- 新原语:`.item-list / .item-card(.open) / .item-head(46px 触摸区,<button>) / .item-glyph(.ok/.neutral)
  / .item-main / .item-title(.mono) / .item-sub / .item-meta / .item-chevron(open 旋 180°) /
  .item-body / .item-desc / .item-text / .item-chips / .item-code(-wrap/-copy) / .item-actions(.spacer)`。
  另加跨页共用件:`.empty-state`(glyph+标题+提示+CTA)、`.add-btn`(虚线"+ 新建"统一创建入口)、
  `.page-intro`(琥珀左竖线的说明条)、`.btn.tonal`、`.ad-chip.accent/.ok/.danger`(替换原内联 style chip)。
- 三页迁移:`InstalledRow` / `ShortcutsSection` / `WorkflowsSection` 全部改用 `.item-card`;工作流弃用
  原生 `<details>`,改受控 `expandedId` 手风琴(与另两页一致)。Market 行(`MarketRow`)对齐视觉
  (加 glyph + 统一源码查看器),但保留一键安装、不强加手风琴(它是目录,不是"我的项")。
- 交互细节:`InstalledRow` 改成点卡片首开时拉一次 `getAdapterCommands`(顺带拿描述);`ShortcutsSection`
  的新建表单改为 `.add-btn` 折叠,**编辑器懒挂载**——表单未展开时 `promptApi.current` 为 null,
  故 startEdit 不能同步塞 token,改用 `pendingText` ref + `useEffect([formOpen, editingId])` 在挂载后回填。
- 菜单(`MenuDropdown`):分三组(历史 / 三件套 kit / 系统),`.menu-divider` 分隔,图标 hover 染琥珀。
- 顺手删干净 dead CSS:`.adapter-card* / .adapters-list / .adapters-paste-bar / .shortcut-item* /
  .shortcut-list / .wf-view(+summary)`(用 `grep -c` 确认 0 引用后再删);保留仍被引用的
  `.adapter-card-source / .adapter-card-run / .shortcut-new/.shortcut-name-input/.shortcut-form-actions`。

教训:① 把 hover-only 动作搬上窄/触屏 = 不可发现 + 点不到;窄面板要么常驻动作,要么点开再给。
② 懒挂载的富文本编辑器不能在"决定挂载它的那次 setState"里同步操作其 ref——ref 此刻还是 null,
必须等挂载后的 effect 回填(`pendingText` ref 传值)。③ 删 dead CSS 前用 `grep -c <class> *.tsx`
逐个验 0 引用,`.adapter-card-source` 这种"看着像一类、其实还在 MarketRow 用"的会咬人。
④ 本仓 HEAD 的 `App.tsx/style.css` 本就过不了 `prettier --check`,所以**不要**对整文件 `--write`
(会把大量历史代码重排、淹没本次 diff),新增代码手动贴合周围 2 空格/单引号风格即可。

## 17. 历史会话页打磨 + create_shortcut 工具 + 杂项修复(2026-06)

§16 之后用户逐项反馈的一轮跟进:

1. **历史卡片间距**:`.session-card + .session-card { margin-top: 8px }` 其实**从不生效**——每张卡片包在
   `<li>` 里,相邻的是 `<li>` 而非 `.session-card`,相邻兄弟选择器匹配不到。改成在 `.history-list` 上用
   `display:flex; flex-direction:column; gap:11px`,删掉那条死规则。
2. **会话预览左右间距对齐主聊天**:预览复用 `.messages`,但它嵌在 `.page-body`(14px padding)里,叠加
   `.messages` 自身 8px = 22px,比「继续」后的主聊天(`.messages` 直接 8px)更窄。修法:
   `.session-detail .messages { margin: 12px -14px -18px }` 用负边距抵消 page-body 的内边距 → 净 8px、
   点阵背景齐边,和主视图一致;顺手加 `border-top` 把 meta-row 和气泡分开。
3. **搜索高亮 + 计数**:`highlightMatches(text, q)` 把命中子串包进 `<mark class="search-hl">`(琥珀
   `color-mix`),空状态/无匹配换成统一 `.empty-state`(IconClock / IconSearch glyph),有查询时显示
   「N 个匹配会话」。
4. **新增 `create_shortcut` agent 工具**(`api-engine.ts`):与 `create_workflow` 完全对称——工具定义
   (`CREATE_SHORTCUT_TOOL`,参数 label/text)、加入非 explore 的 tools 列表、循环里 inline 拦截 handler、
   按 label upsert(`saveShortcut`/`makeShortcutId`/`listShortcuts` 来自 `src/shortcuts/store.ts`,SW 侧
   可直接 import)。写 `chrome.storage.local` 后 UI 的 `storage.onChanged` 监听(App.tsx)**自动刷新**,
   无需额外通知。配套**移除** composer「...」里的「存为快捷方式」(及 `saveInputAsShortcut`)——创建路径
   收敛为「快捷方式页手动 + 让 agent 创建」两条(工作流早已是 agent 创建)。
5. **composer「...」弹出菜单方向**:`.mode-menu.actions-menu` 原本 `right:0`(右对齐),但「...」触发器在
   composer-bar 的**左侧图标群**里(send 组 `margin-left:auto` 推到右边),右对齐导致菜单往左溢出屏幕被挡。
   改 `left:0; right:auto`(从「...」向右展开)即落回可视区。
6. **「↩ 继续上次的会话」显示成字面 `↩`**:JSX **文本节点不解析 `\uXXXX` 转义**(那只是 JS 字符串字面量
   里的语义),写进 JSX 文本就是 6 个字符。改成真实字符 ↩(或 `{'↩'}` / 图标组件)。
7. **市场 tab 底部大空隙**:`.market-list-scroll { max-height:440px; overflow:auto }` 给市场列表套了个定高内层
   滚动框,内容少时下方留白、与另两个 tab(`.item-list` 自然流动、page-body 滚动)不一致。直接让市场列表也用
   `.item-list`,删掉 `.market-list`/`.market-list-scroll`,三个 tab 统一。
8. **表单按钮顺序**:新建/编辑快捷方式、贴码安装的表单里 `取消` 一度被放到主按钮左边;按惯例(也与改版前一致)
   主按钮在左(`flex:1` 占满)、`取消` 在右。

教训:① 相邻兄弟选择器(`a + a`)遇到列表项被 `<li>`/wrapper 包裹就静默失效,列表间距应放在容器的 `gap`。
② 复用同一个 `.messages` 类但处在不同 padding 容器里,左右内边距会**叠加**;要对齐就用负边距抵消外层。
③ JSX 文本 ≠ JS 字符串,`\u`/`\n` 这类转义在文本节点里不生效。④ 弹层对齐方向要看**触发器实际在工具条的哪一侧**,
不能默认右对齐。⑤ 给 agent 加 meta-tool 的最小闭环 = 工具定义 + tools 列表注册 + 循环内 inline 拦截 handler +
store import,四处齐活;UI 若已监听 storage 变更则自动同步。

## 18. 逐页打磨续:命名 / 记忆 / 外部接入 / LLM / 快捷栏 / 截图(2026-06)

接 §16/§17 的逐页反馈,又一轮:

1. **重命名**(`PAGE_LABELS` + `MenuDropdown` 同步):`LLM 后端` → **`LLM 配置`**;`外部控制` → **`外部接入`**
   (从"控制"转向"接入",更贴合"让外部 agent 连进来"的语义);`记忆` → **`我的记忆`**。
2. **我的记忆页**(`MemorySection`):套用统一卡片语言——`.page-intro` 说明条、虚线 `.add-btn` 折叠新增表单、
   复用 `.history-search` 搜索框 + `highlightMatches` 高亮命中、空/无匹配走 `.empty-state`、行内动作改成
   图标按钮 `.memory-act`(铅笔 / 垃圾桶,hover 变红)。
3. **/create-workflow + /create-shortcut**(`commands.ts` 的 `BUILTIN_COMMANDS`):仿 `/find-adapters` 的
   `insertText` 型命令,`/` 面板可选,展开成调用 `create_workflow` / `create_shortcut` 的提示词。两者本就是
   agent 工具(§17 加了 create_shortcut),命令只是把它们搬进 `/` 面板。(**后 §23 改为 chip**:不再插入时
   展开,而是落 `⟦cmd:..⟧` chip、发送时才还原成提示词。)
4. **外部接入页**(`BridgeSection`):大量内联 style 重写为统一组件——`.page-intro`、顶部 `.status-card`
   (dot: 连接绿 / 启用未连红 / 未启用琥珀)+ 内联启停按钮、`.bridge-row/.bridge-port/.bridge-toggle`。
5. **LLM 配置页**(`LlmBackendSection`):模型分工 `<select>` 去掉内联 style 走已有 `.field select`;空状态
   (无 key)换 `.empty-state`(IconCog + tonal CTA);「新建配置」加 IconPlus。
6. **「...」菜单图标**:`导入 trace` / `导出对话` 原本都用 IconSave,改成 IconDownload(入)/ IconUpload(出),
   语义可区分。
7. **输入框上方快捷栏**:① 给快捷方式 chip 也加前导图标(prompt=IconType / tool=IconTerminal),工作流 chip
   的 `⛓` emoji 换成 IconBranch —— 三者图标统一;② 把"打开哪个页面靠猜"的单个「管理」换成 `···`(IconMore)
   触发的**向上弹窗**(`.bar-manage-menu`,`.menu-dropdown` 基础上改 `bottom:100%`),里面「管理快捷方式」/
   「管理工作流」两条都能到;单个控件,不随条目数膨胀;海量条目仍靠 `/` 面板搜索。
8. **截图**:① select 阶段给页面**即时淡蒙版**(catcher `background:rgba(0,0,0,.12)`;原本要拖动才靠选框
   box-shadow 变暗);② 输入框上的 `.capturing-overlay` 加「取消」按钮——overlay 是 `pointer-events:none`,
   故按钮单独 `pointer-events:auto`,点它 `cancelCapture()` 向当前 tab 注入一次 Esc keydown,让页内选择器
   resolve(null) 走正常取消路径;③ 标注栏的 unicode 字形(▭ ◯ ↗ ✎ ↶ ✕ ✓)粗细/高度不一,全换成统一
   `ICON()`(17px / 1.9 描边 / 24 viewBox)inline SVG,矩形高度调到与圆圈一致,撤销换成线性箭头。

教训:① 注入页面的函数是 `toString` 序列化的、不能引用外部(含 `Icons.tsx`),要图标只能在函数内内联 SVG 字符串
——但同样可以定义一个本地 `ICON()` 工厂保证一致性。② 跨上下文取消(SidePanel 想中止页内正在 await 的选择器)最稳的
办法是注入一次合成事件(Esc),复用页内既有的取消路径,而不是新设信号通道。③ unicode 字形当图标天然不统一(字体相关),
要统一必须改 SVG。④ `pointer-events:none` 的提示蒙版里要放可点按钮,得给按钮单独开 `pointer-events:auto`。

## 19. 逐页打磨续二:记忆折叠 / 截图标注扩展 / 消息复制 / 截图门控(2026-06)

1. **我的记忆**(`MemoryRow` 抽成独立组件):长记忆默认**折叠**到 3 行(`-webkit-line-clamp`),溢出才显示
   「展开/收起」(用 ref 量 `scrollHeight>clientHeight` 判定可展开);编辑/删除改为 **hover 才浮现**的图标
   (绝对定位右上 + 渐隐到 surface 的背景,不再占窄屏宽度);新增 / 编辑 textarea 12 行。
2. **快捷栏「管理」弹窗被裁**:`.shortcut-bar` 的 `overflow-x:auto` 会把 y 轴一并裁掉,向上弹的菜单不可见。
   改结构 `.shortcut-bar-row` = 可横滚 chip 区(`.shortcut-bar`)+ 不滚动的 `.bar-manage-anchor`,把管理按钮
   移出滚动容器,弹窗就不再被裁(footer 是 `overflow:visible`)。chip 也统一加前导图标。
3. **截图标注扩展**(`region-capture.ts`):新增**文字**工具(点击落 input,Enter/失焦提交、Esc 取消;
   `typingText` 标志让全局 Esc 监听让位)与**马赛克**工具(标注期画灰框占位,真正像素化在 `compositeRegion`
   对裁好的截图做「降采样 → 无插值放大」;马赛克区域单独随结果返回、不进标注 PNG)。颜色选中改**下划线**而非外框。
4. **截图蒙版重入变暗(bug)**:`onCaptureRegion` 加 `if(capturing)return` + 按钮 `disabled`,注入函数按 id
   先清旧 overlay——之前每点一次就叠一层 `rgba(0,0,0,.12)`。
5. **消息复制**(`MsgCopyButton` + `.msg-block/.msg-actions/.msg-copy`):仿 ChatGPT——复制 icon 移到气泡
   **外面下方**、默认隐藏 hover 才显;用户消息也有(右对齐)。删掉气泡内的「复制结果」文字按钮。
6. **截图门控(产品决策,用户确认)**:agent 自行 `generic__screenshot`,但没配视觉模型就白截。`specialistSystemNote`
   按 `caps.vision` 分叉:无视觉模型时明确叫 agent **别**截图来"看"页面,改用 `get_text_from_tab` 等文本工具,
   确需看图则停下提示用户去「模型分工」配置。
7. 杂项:外部接入页端口加「保存」按钮(改动才出现,`set({})` 重应用);LLM 配置 `.active-badge` 加
   `white-space:nowrap`(「图像」被挤成两行);Adapters 页加 `.page-intro` 说明(是什么 / 装 / 用 / 自探索)。

教训:① `overflow-x:auto` 不是只裁 x——另一轴为 `visible` 时被规范提升为 `auto` 一起裁;子代弹层别待在这种容器里。
② 真·马赛克需源像素,而本流程是"先标注后截图",故把马赛克区单独传出、合成阶段对真实截图像素化。
③ hover-only 动作并非一概禁忌——窄屏列表里"省宽度"比"始终可见"更重要时,hover 浮现 + 绝对定位是合理取舍
(与 §16"动作常驻"不冲突,取舍看具体面)。④ 注入页面里放 `<input>` 要打字时,得用标志位让宿主的全局 Esc 监听让位。

## 20. 会话在新标签页打开(full-page 视图,2026-06)

侧边栏太窄 → header 加「在新标签页打开」(⤢)按钮:`chrome.tabs.create` 打开**同一个扩展页**
`src/sidepanel/index.html?fullpage=1&session=<id>`(`side_panel.default_path` 同路径;manifest 已有 `tabs` 权限)。

- **同一份应用 + 同一个 SW**:新 tab 跑的是同一个 React app,后端仍是那个 service worker(事件本就广播给所有
  扩展上下文),所以两边会话保持同步、都能继续对话。
- **入口参数**(挂载时一次性):`?fullpage` → `documentElement` 加 `.fullpage`;`?session=<id>` → 走既有
  `GET_SESSION` 把该会话载入(`setSessionId/setTurns/setPlan`)。
- **`.fullpage` CSS**:把 `.messages / footer / .page-body` 的内容收进**居中 760px 列**(侧栏窄屏 CSS 不动);
  header / page-header 用对称 padding(`max(10px, (100%-760px)/2)`)让顶栏内容与列对齐;footer 改 flex 列居中。
- **page-context 动作在 full-page 下隐藏**:`总结当前页` / `截图(框选)` 作用于"当前活动标签页",而在扩展自己的
  tab 里活动标签就是这个扩展页本身——故 full-page 隐藏这两个按钮(它们是贴着被浏览页面用的侧栏功能)。其余
  (聊天 / `/` 命令 / 工作流 / adapters / 我的记忆)照常。

教训:扩展自己的页面可被 `tabs.create` 直接在 tab 打开(无需 `web_accessible_resources`,那是给外部 origin/内容
脚本用的);但"当前活动标签页"语义在扩展自己的 tab 里会指向自己,凡依赖"用户正在看的网页"的功能在 full-page 下都要回避。

## 21. 截图标注:文字工具修复 + 字号/下载 + 工作流栏改插入(2026-06)

1. **文字工具之前打不了字**:点击落 `<input>` 后**同步** `focus()` 会被该次点击的默认聚焦行为立刻 blur,blur
   处理器又以空内容提交并移除 input——所以永远输入不了。修法:`e.preventDefault()` + 把 `focus()` 和 blur 监听
   都放到 `requestAnimationFrame`(等点击的聚焦处理结束后再聚焦)。
2. **文字字号 + 颜色**:标注栏改成**两行**——行 1 工具 + 操作(撤销/下载/取消/完成),行 2 字号下拉(仅文字工具显示)
   + 颜色色板(下划线选中态)。字号存到 shape 上,`fillText` 用各自字号渲染。
3. **下载截图**:标注栏新增「下载」按钮。`finishCapture(download)` 统一收尾;`CaptureResult.download` 透传到
   `captureRegion`,合成后若 download 则触发浏览器 `<a download>` 保存 PNG、不附到输入框(否则照常附加)。
4. **输入框上方点工作流 chip = 插入而非执行**:之前 `runWorkflowFromBar` 直接跑(且**无进行中提示、做完才提示**)。
   改成 `composerApi.insertCommand('wf', name)` 插入 ⟦wf⟧ chip,用户补文字后发送→交给 agent(带正常"执行中"指示);
   删掉 `runWorkflowFromBar`。确定性运行仍在「工作流」页(运行按钮,带"(进行中…)"+逐步流式)。

教训:在页面里动态建 `<input>` 并想立即聚焦,必须避开"本次点击的默认聚焦"——`preventDefault` + rAF 延迟聚焦;
同步 `focus()` 会被秒 blur。

## 22. 标注编辑器完善 + 杂项(2026-06)

1. **标注:选中 / 移动 / 缩放**(`region-capture.ts`):点中标注→选中(蓝色虚线框)并拖拽移动;rect/ellipse/mosaic
   显示**四角圆圈手柄**、arrow 显示两端手柄,拖手柄缩放(角点以对角为锚点重算;箭头端点直接拖)。鼠标反馈:
   悬空白=crosshair、悬标注=move、悬手柄=对应 resize 光标。Delete/Backspace 删除选中;选中后改颜色/字号会作用到
   选中标注。文字 Enter=换行、失焦提交、双击重编辑。**所有注入样式改用字面色**(`#f5a623`/`#3b82f6`),不再用
   `var(--accent)`(会继承宿主页变量→选中态有时不可见)。马赛克改**纯黑不透明**(进标注层,不再走合成期像素化)。
2. **已安装/探索 adapter 默认显示描述**:`InstalledAdapterSummary` 加 `description`(SW 取首个命令的 description),
   卡片折叠态副标题直接显示描述(回退「kind · 来源」),不必展开。
3. **输入框工具条精简**:去掉「...」弹出菜单——「导入 trace」整条移除(连带 `onImportTrace`/`traceFileInput`/
   `ImportTraceReq`/`actionsMenuOpen`),「导出对话」改为工具条上的直出按钮(IconUpload)。
4. **图标**:右上「在新标签页打开」换 `IconMaximize`(四角展开,更统一);快捷栏「···」换 `IconChevronUp`
   (表示向上弹出菜单)。
5. **消息复制图标**:用户 + agent 消息一律**右对齐**、位置略微下移(`.msg-actions` 加 `justify-content:flex-end` +
   增大上内边距)。

教训:① 画布标注做成"可选可改"= 命中测试(描边类按线距、填充/框类按 bbox)+ 选中态 + 手柄(角点锚对角重算)+
光标反馈,几件套缺一不可。② 注入到任意页面的 UI 一律用字面值,任何 `var(--x)` 都可能被宿主页污染。

## 23. 内置 `/` 命令改 chip(find-adapters / create-workflow / create-shortcut,2026-06)

§18.3 把 `/create-workflow`、`/create-shortcut`(连同更早的 `/find-adapters`)做成 `insertText` 型内置命令——
选中即把一长串中文提示词**原文展开**进输入框。问题是:展开后那段指令和用户自己要写的任务混在一起、占满输入框、
还能被误删一半。改成**和工作流 / adapter 一样的 chip**(用户反馈:"只有快捷方式是展开的")。

- **新增第三种 chip 类型 `cmd`**(`commands.ts`):`ChipKind = 'wf' | 'tool' | 'cmd'`,token `⟦cmd:NAME⟧`,
  图标 `⚡`(沿用 `/` 面板「命令」组的图标;wf=⛓ / tool=🔧 / cmd=⚡,延续"靠图标而非颜色区分"的既定做法,
  共用 `.cmd-chip` 样式)。`BUILTIN_COMMANDS` 里 `mode` 型(`/plan` `/explore`)仍是**切模式不落 chip**,
  `insertText` 型则改为**落一个 `cmd` chip**——二者互斥。
- **chip 是纯 UI 糖,发送时才还原**:`expandCommandTokens(text)` 把 `⟦cmd:NAME⟧` 替换回该命令的 `insertText`
  原文,**agent 收到的指令和改版前逐字一致**(满足"只要保证 agent 能理解");wf/tool token 不动(它们要留作
  marker + 另行 INJECT_CONTEXT 注入定义)。主发送、插话(steer)两条路径都过一遍 `expandCommandTokens`。
- **显示收敛**:新增 `tokensToDisplay(text)` 把所有 token 折成 `/NAME`,用于聊天气泡(`onSend` 的 `marks`、
  steer 的 `↪`)和快捷方式预览;顺手把原来两处手写的 `.replace(/⟦(?:wf|tool):..⟧/, '/$1')` 收敛到这个函数
  (同时覆盖了 cmd),气泡里不再露出 `⟦..⟧` 原文(此前 wf/tool 发送后气泡是露原文的,一并修掉)。
- **改动落点**:`command-editor.tsx` 的 `pick()` 两条分支(slash / swap)对 `insertText` 型 builtin 从
  `insertTextWithTokens(...)` 改为 `insertNodeAtCaret(makeChipEl('cmd', ...))`;`serialize` / `makeChipEl` /
  `insertTextWithTokens` 的正则各加一路 `cmd`。

教训:① "命令展开成提示词"和"命令是个 chip"只差一层——把展开**从插入时推迟到发送时**(token→原文),UI 就能
是原子 chip 而 agent 侧零感知。② 序列化 token 的**显示形态**要和**发送形态**分开:发送走 `expandCommandTokens`
(cmd→原文、wf/tool 保留),显示走 `tokensToDisplay`(全部→`/NAME`),别让气泡直接渲染内部 token。

## 24. 输入框上方快捷栏:按宽度自适应单行 + ⌃ 弹出全部(2026-06)

§18.7 / §19.2 的快捷栏是**横向滚动**的 chip 条(`overflow-x:auto`)+ 一个只放「管理快捷方式 / 管理工作流」两条
链接的向上小菜单。用户要的是:① 条**按宽度自适应**——一行能放几个 chip 就放几个(不滚动);② 右侧 `⌃` 点开后在
上方显示**全部**快捷方式 + 工作流(多了可滚动),并在列表**下方**带管理按钮。抽成独立组件 `ShortcutBar`。

- **「一行放几个」靠隐藏镜像测量**(`ShortcutBar`,`App.tsx`):可见条 `.shortcut-bar` 改 `overflow:hidden`
  (不再滚动)。旁边放一个 `.shortcut-bar-mirror`——**始终渲染全部 chip** 的不可见副本(`position:absolute;
  width:0;height:0;overflow:hidden;visibility:hidden`)。因为 chip 是 `flex:none`(不收缩),即使塞进 0×0
  裁剪盒里也会按自然宽度排成**一行**,于是逐个读 `offsetLeft+offsetWidth ≤ 可见条 clientWidth` 就能算出能放几个
  (`visible`),可见条只渲染 `items.slice(0, visible)`。镜像 0×0 裁剪 ⇒ 对面板**横向滚动零贡献**(踩坑见下)。
- **无闪烁 / 无反馈环**:测量放 `useLayoutEffect`(绘制前同步 trim,不会"先全展开再收起"闪一下);初值
  `visible=Infinity`(`slice(0,Infinity)`=全部,天然兼容)。`ResizeObserver` 只观察可见条;`visible` 变化**不改**
  可见条宽度(它是 `flex:1`),故不会触发再测量 → 无环。effect 依赖 `sig`(所有 label 拼接)→ 标签/条目变动才重测。
- **⌃ 弹出 `.bar-popup`**:复用 `.menu-dropdown`(向上 `bottom:100%`),上半 `.bar-popup-chips`(flex-wrap +
  `max-height:220px;overflow-y:auto`)列**全部** chip、下半 `.bar-popup-actions` 放「管理快捷方式 / 管理工作流」
  两个按钮(footer 风,各 `flex:1` 居中)。点 chip = 插入并关弹窗;点管理 = 进对应页。
- **验证**:无头 Chrome `--dump-dom` 跑了份静态 harness(复刻真 CSS + 同一段测量),窄容器下确认**取到的是
  恰好放得下的最长前缀**(下一个 chip 放不下、可见条不溢出),宽容器下确认**全放下**,两种情况**镜像都不产生
  横向滚动**(`docHScrollPx=0`)。

教训:① 要"按宽度放 N 个"又要能在 resize 后**重算**,最稳的是留一份**始终全量的不可见镜像**做量尺——别在可见条上
边删边量(删了就没法再量)。② 不可见量尺若用 `width:max-content`/`overflow:visible`,它那一长排 chip 会**撑出面板的
横向滚动条**;改成 `width:0;overflow:hidden` 即可——`offsetLeft/offsetWidth` 是布局期算的,裁剪(paint 期)不影响
读数,前提是 chip `flex:none` 不被压缩。③ 测量+`setState` 放 `useLayoutEffect`(非 `useEffect`)才能绘制前完成、
不闪烁;并确保"显示数量变化"不会反过来改被观察元素的尺寸,否则 `ResizeObserver` 成环。

### 24.1 ⌃ 弹窗"看得见点不动"——透明 backdrop 盖在弹窗上(post-mortem)

**症状**:`⌃` 弹窗能正常显示,但里面的快捷方式 / 工作流 chip、底部两个管理按钮**全都点不动**(点哪都像没反应,
实则一点就把弹窗关了)。

**根因**:`.bar-popup` 继承 `.menu-dropdown` 的 `z-index:30`,但配套的 `.mode-backdrop` 是 `z-index:60`。backdrop
是**透明且 `position:fixed;inset:0` 铺满视口**的——它盖在 z30 的弹窗**上面**:弹窗透过它看得见,但所有点击都先命中
backdrop(`onClick=关闭`),于是"显示了却点不动"。同 `.mode-backdrop` 的旧 `.bar-manage-menu` 也是 z30,本就有这个
潜伏 bug,只是那会儿弹窗里只有两条链接、很少被点到才没暴露。

**修法**:给 `.bar-popup` 设 `z-index:61`——压过 backdrop(60),正好复用本仓库既有的配对约定 `.mode-backdrop:60` /
`.mode-menu:61`。backdrop 仍盖住其它一切(点弹窗外=关闭),但弹窗本身在其之上,内部元素可点。

**验证**:无头 Chrome 跑 `document.elementFromPoint(chip/按钮中心)`:z30 下 4 个元素命中的都是 `mode-backdrop`(被吃),
z61 下 4 个全部命中各自元素(`OK`)。

**教训**:复用 `.menu-dropdown`(z30)做**带 `.mode-backdrop`(z60)的**浮层时,必须显式把浮层抬到 backdrop 之上
(本仓库约定 61)。"看得见但点不动"几乎总是**透明高 z 层盖在上面**——用 `elementFromPoint` 命中测试一查便知,别只盯
`pointer-events` 或事件绑定。

## 25. 工作流加 description(2026-06)

工作流原来只有 `name` + `steps`,列表 / `/` 选择器只能展示"几步 · 工具链",AI 探索 / 对话里生成的工作流缺一句
人话说明。给 `Workflow` 加可选 `description`:

- **模型**:`workflows/store.ts` 的 `Workflow.description?`(可选——兼容旧存档)。
- **生成**:`create_workflow` 工具加 `description` 入参并列入 `required`(描述里写明"必填、展示给用户"),handler
  存入;**同名覆盖更新时,若本次未给 description 则保留旧的**(`description || existing?.description`)。
- **展示**:工作流页副标题、`/` 选择器副行、快捷栏 chip 的 tooltip 都优先显示 `description`(回退到工具链);
  `⟦wf:..⟧` 引用注入给 agent 的定义 JSON 里也带上 description,让它知道这工作流是干嘛的。

## 26. 输入框 placeholder 用 `.is-empty` 类而非 `:empty`(post-mortem,2026-06)

**症状**:输入框的 placeholder 只有**第一次**(从未编辑过)显示;一旦输入过再清空,即使框是空的、也没 focus,
placeholder 也不再出现。

**根因**:placeholder 走 `.composer-input:empty::before`。但 contenteditable 在**打字后再全删**时,Chrome 会在
里面留一个 `<br>`(光标占位)——元素**有子节点**了,`:empty` 不成立,placeholder 就被永久藏住。无头复现:全删后
`innerHTML==="<br>"`、`:empty===false`,blur 后仍是 `<br>`。(`onInput` 里本有 `innerHTML=''` 兜底,但 focus/blur
等非 input 路径不触发它。)

**修法**:不靠 `:empty`,改用一个由**真实内容**算出的 `.is-empty` 类:`empty = !textContent && !.cmd-chip`,在每次
`sync()`(覆盖所有编辑/插入路径)、`clear()`、`blur` 时重算;class 由组件 state 驱动(不能只 `classList.toggle`——
Preact 重渲染会按 vnode 的 `class` 把它覆盖掉)。CSS 改 `.composer-input.is-empty::before`。`<br>` 没有 textContent,
故"空但有 `<br>`"也判定为空 → placeholder 正常显示。

**验证**:无头 Chrome 跑 初始/打字/全删/blur 四步,确认全删与 blur 时 `:empty===false`(旧法会失败)而
`.is-empty===true`、`::before` 实际渲染出 placeholder(`PASS`)。

**教训**:contenteditable 的 placeholder **别用 `:empty`**——打字残留的 `<br>` 会让它失效;用"按 textContent/子元素
算出的类"才稳。且这种**布尔类要走框架 state**,否则命令式 `classList` 会被重渲染抹掉。

## 27. 外部接入:skill + 接入指南上页(2026-06)

T7 的 bridge(`bridge/`,MCP 守护进程 + `src/background/bridge-client.ts` 反向拨号)早已能让外部 AI 编辑器
(Claude Code / Codex / Cursor)经 MCP 操控浏览器、驱动 explore 造适配器。这轮把它**打包成 skill + 在
「外部接入」页给出接入指南**,让用户(或他的 AI)一键上手。详见 `docs/external-agent-control.md` §7。

- **skill 放哪**:随 bridge 走(`bridge/skills/`)——bridge 本就是要分发、要被编辑器启动的 Node 包,等于
  marketplace 之于适配器的角色。用户跑 bridge 时 skill 已在盘上,"安装"=拷进编辑器的 skills 目录
  (Claude Code `~/.claude/skills/`)或让 Cursor/Codex 的 rules 指向 `SKILL.md`。`bridge/skills/README.md`
  写了托管思路 + 三家编辑器的安装方式(含"让 AI 自己装")。
- **两个 skill**:`web-agent`(总纲:前置检查、MCP 工具面=`generic__*` 浏览器原语 + 已装站点适配器 +
  `explore_start/stop`、常见任务,并强调 `tools/list` 为准)+ 既有 `web-adapter-author`(recon→strategy→
  `eval_js`→写源→verify→`generic__install_adapter` 的造适配器闭环)。
- **页面指南**(`BridgeSection`):状态卡 / 端口 / 写开关下面加 `.bridge-guide`——5 步(跑 bridge → 启用 →
  把 bridge 配成编辑器 MCP server,JSON 用既有 `CopyableBlock` 可复制 → 装 skill(让 AI 装 / 手动 cp)→ 用法),
  末尾一行写操作 + 仅本机提示。**简洁为主,细节让用户去问 AI**(skill 里都写了)。
- **能力边界(当下)**:bridge 暴露的是浏览器原语 + 已装适配器 + explore,所以**造适配器**全程 MCP 可达;
  但 `create_workflow`/`create_shortcut`/记忆/LLM 配置是 extension 的 agent-loop 工具/设置,**尚未**走 bridge——
  要么在 extension UI 里设,要么让侧栏自带 agent 做。把它们也做成 explore_* 那样的 synthetic bridge 工具是下一步。

### 27.1 抽成公共 repo + submodule、一键装、免 MCP、指南瘦成 3 步(2026-06)

§27 把 skill 随 bridge 走、装=手动 cp、指南 5 步(含跑 bridge / 配 MCP)。用户反馈太繁,改成:

- **公共 repo + submodule**:bridge + skills 抽到公共仓库
  [`whitefoxx/web-agent-skills`](https://github.com/whitefoxx/web-agent-skills),本仓库以 **submodule
  挂在 `bridge/`**(对齐 `marketplace` 模式;`.gitmodules` 新增一条)。改 bridge/skill = 在该 submodule 里改、
  push 公共仓库、再 bump 本仓库的 submodule 指针。
- **一键装**:`npx skills add whitefoxx/web-agent-skills -g`——用 [`vercel-labs/skills`](https://github.com/vercel-labs/skills)
  CLI(真实存在,"open agent skills ecosystem"),自动识别 Claude Code / Cursor / Codex…,读 repo `skills/*/SKILL.md`。
  或把 repo 地址丢给 AI 让它装。
- **skill 自包含 + 免 MCP**:`web-agent` skill 现在自己教 AI 怎么起 bridge
  (`npx -y github:whitefoxx/web-agent-skills`)、怎么用 **curl**(`/tools`、`/command`)——bridge 的 HTTP 接口
  本就路由到扩展(server.mjs 的 `/command` → `callExtension` → WS),所以 curl 即可全功能,**不必配 MCP server**
  (MCP 降级为可选:要原生工具调用才 `claude mcp add`)。double-check 过:explore_start/stop 也能经 `/command` 走。
- **指南 3 步**(`BridgeSection`):装 skill → 启用端口 → 直接用/问 AI;删掉"跑 bridge / 配 MCP"两步(沉到
  skill/AI)和页面里的 MCP JSON(`CopyableBlock`)。

教训:把"怎么连、怎么用"沉进 skill,UI 指南能从 5 步降到 3 步——**安装即引导**。能用 HTTP 就别强制 MCP:curl
对任何带 shell 的 agent 都通,省掉每家编辑器一次性的 MCP 配置。

### 27.2 把"扩展内操作"也开成 bridge 工具(workflows/shortcuts/memory/LLM,2026-06)

§7 的能力边界:bridge 只暴露浏览器原语 + 适配器 + explore,工作流/快捷方式/记忆/LLM 还得在 UI 里弄。这轮补上——
让外部 agent 也能做"用户在扩展里能做的事"(原 §27 列的下一步):

- **新增 synthetic 工具**(`server.mjs` 的 `SYNTHETIC` + HTTP `/tools` 现在也带上 synthetic;执行在
  `bridge-client.ts`,**不是** registry adapter):`create_workflow`/`list_workflows`、`create_shortcut`/
  `list_shortcuts`、`save_memory`/`list_memories`/`delete_memory`、`get_llm_config`/`set_llm`。写操作走
  `允许外部写操作` 开关(复用 `CONTROL_TOOLS` map 的 `write` 标志,顺手把 explore_start/stop 也并进这张表)。
- **复用既有 store**:handler 直接调 `workflows/store`、`shortcuts/store`、`agent/memory-store`、
  `config/llm-config`(都能在 SW 里跑;记忆走 IndexedDB)。create_workflow 的 step 归一化(`for_each`→`forEach`、
  非字符串 arg `JSON.stringify`)和 upsert 语义照抄 api-engine 的同名 handler,保持一致。
- **LLM 安全**:apiKey 在 `config/llm-config.ts` 是明文存的。`get_llm_config` **绝不返回 key**(只给 `hasKey`),
  `set_llm` **不收 key**(只切 profile/换 model)——免得密钥流进外部 agent 的上下文(会被它自己的 LLM provider 看到)。
  要做"带 key 配新后端"得另开显式开关。
- **npx 首跑慢的坑**:`npx github:` 首次要 clone+install(~10–30s)才监听,`sleep 3` 后直接 curl 会 **exit 7**
  (连不上)。不是 bug;skill 里改成 **轮询 `/status` 直到起来** 再用,并说明 exit 7 = 还没起来。

教训:"让外部 agent 拥有扩展全部能力"不必把 agent-loop 搬过去——把每个操作做成**调既有 store 的 synthetic 工具**即可,
和 UI/agent 共用一份 store 逻辑。涉密配置(API key)即使在"本机可信"边界下也别经 bridge 外泄,读要脱敏、写要免 key。

### 27.3 临时(免安装)适配器 + offscreen 求值场所(2026-06)

痛点:安装一个 adapter 会**持久化**且把它放进每次请求都发给 LLM 的工具目录——装多了**每轮都烧 token**。不常用的
应该能"用一次就走",不必安装。

- **`load_adapter {site,name}`**(`src/background/ephemeral-adapter.ts`):`fetchAdapterSource`(sha256 校验)→
  offscreen 求值 → `registerSessionDefs`(进**运行时** registry,不进 installed-store)→ `<site>__<name>` 立即
  可调、带**真实参数 schema**(解决"参数靠猜");SW 重启即失效。和已安装的区别只有**持久化 + sha 固定 + 安装确认**,
  加载后能力/schema 完全一致。做成 **bridge synthetic + agent-loop 工具**(不是 generic `cli()`——面板也 import
  generic bundle,而这需要 SW-only 模块 offscreen/registerSessionDefs)。
- **同意模型**(按用户要求):加载**不弹**确认(沙箱求值 + sha 校验);**读**适配器跑起来不弹;**写**适配器在
  **执行时**走既有 write-confirm(`isEphemeralTool` 给确认框打"临时/未安装"标);bridge 侧写操作还受 允许外部写操作。
- **offscreen 求值场所**:SW 不能 eval(CSP)也没 DOM,适配器源码必须在某个文档的 sandbox iframe 里 eval。原来那个
  文档是侧边栏(=要开面板)。现在加 `offscreen` 权限 + `src/offscreen/offscreen.ts`(托管同一个 sandbox iframe,复用
  `evalAdapterInSandbox`),由 `src/background/offscreen-eval.ts` 按需创建、SW 经 `chrome.runtime` 消息转发求值。
  `requestSandboxEval`(explore 合成)也改走这里 → **所有 SW 侧 eval 都不再需要面板**;原 SW↔面板 `EXPLORE_EVAL_REQ/RESP`
  通道整条删除。**bridge 侧安装也免面板**:bridge-client 拦截 `generic__install_adapter`,改调
  `installMarketplaceAdapter`(`src/background/install-marketplace.ts`:fetch → offscreen eval → `installFromCaptured`),
  不再绕面板。(面板里用户点安装仍走面板自己的 iframe——面板本来就开着。)
- **构建**:`vite.config.ts` 的 sandbox 插件里多 esbuild 一个 `offscreen.js`(外链,非内联——extension_pages CSP=
  `script-src 'self'`)+ 写 `offscreen.html`。
- **Adapters 页**加 token 提示(`.adapters-tip`):装常用的就好,其余用时让 agent 临时加载。

教训:① offscreen document 是 MV3 里"SW 需要 DOM/eval"的标准解法——把唯一的 eval 场所从面板挪到 offscreen,install/
explore/临时加载就都不挑面板了。② "临时 vs 安装"的差别要落在**持久化 + 信任固定**上,而不是"能不能用/有没有 schema"——
两者跑起来一样,只是一个进工具表常驻烧 token、一个用完即弃。③ 删旧的跨上下文消息通道(EXPLORE_EVAL_*)时顺藤摸瓜清到
messages.ts 的 union + 两端 import,别留悬空类型。

## 28. Adapters 三页统一 + 引用到对话(2026-06)

把 Adapters 三个 tab(已安装 / 探索生成 / 市场)的卡片体验拉齐,并让任意 adapter 都能"引用"进输入框。

- **统一卡片**:市场 tab 的 `MarketRow` 从扁平 `market-row` 改成和 `InstalledRow` 一样的 `item-card`
  (点头展开 → chips / 运行 / 源码 / 引用 / 安装)。**源码黑框宽度问题**就此修掉——旧版 SourceControls 塞在
  `market-row-body` 这个 flex 子项里被挤窄,现在源码块在全宽的 `item-body` 里。删掉了不再用的 `SourceControls`。
- **市场「运行」= 临时加载即跑**(不装):`onToggleRun` → `loadAdapter`(新增 `LOAD_ADAPTER` 消息 → SW
  `loadEphemeralAdapter`,返回该源注册出的 commands)→ 用既有 `CommandRunner` 跑。读工具直接跑、写工具仍走对话二次确认。
- **销毁动作**:探索生成 tab 的销毁按钮叫**删除**(= 卸载 + 移出列表),已安装叫**卸载**;两者同一个动作
  (`onUninstall`),只是文案不同。**不做单独的启用/停用**——要么留着、要么卸载/删除(用户取舍,免得多一个状态)。
- **引用到对话**:每张卡加「引用」(`IconCornerUpLeft`,与工作流页一致)。点它把该 adapter 的命令作为 `⟦tool:..⟧`
  chip 插进 composer 并关页——等价于 `/command` 插入,但**不限于已安装**(市场/探索里没装的也能引用,让 agent 去
  运行/讲解/改造;没装的 agent 可 `load_adapter`/`install_adapter`)。`AdaptersSection` 加 `onReference` 透传到
  各卡;App 里接成 `composerApi.insertCommand('tool', ...)`。多命令 adapter 一条命令一个 chip。
- **运行结果加复制**:`RunPanel` 的结果块换成既有 `CopyableBlock`(右上角复制按钮)。同时**移除**了运行面板里的
  「存为快捷方式」。
- **市场搜索高亮**:`highlightMatches` 抽到 `src/sidepanel/highlight.tsx`(原在 App.tsx,避免 Adapters↔App 循环
  import),市场行的 id / 描述命中词高亮。

教训:① 三页"统一"的本质是**同一张 `item-card` + 同一套 action 槽**,差异只体现在 state(装没装/启没启用)与个别标签
(卸载 vs 删除)。② 跨组件复用的纯函数(highlightMatches)别从某个大页面 import——抽到独立小模块,免循环依赖。

## 29. 面板内"自动执行"模式 + 完成通知(2026-06)

面板里的对话 agent 每个写操作都要弹确认——关了面板就卡住(确认框在面板里)。加一个**自动执行**(per-conversation),
等于面板内对话 agent 版的"允许外部写操作":开了之后写操作不再逐次确认,于是可以关掉面板、任务跑完发通知、回来看结果。

- **自动开关**(`App.tsx`):composer 条加 `.auto-toggle` pill(常驻,默认关,点亮=开;**新会话 `onNewChat` 重置**)。
  发送时 `UserMessageReq.autoApprove = autoMode` → SW `driveApiSession` 写进 `session.autoApprove` → ctx 的
  `makeExecuteTool(session.id, !!session.autoApprove)`。
- **写确认旁路**:`makeExecuteTool` 是唯一的写关卡——`adapter.access==='write' && !autoApprove` 才弹
  `requestWriteConfirmation`;auto 开就直接跑(写操作**仍记进 trace**,可追溯)。只跳过写确认,不跳过 plan 审批。
- **完成通知**:`driveApiSession` 的 `finally`(成功/失败都走)里,若**没有面板连着**(`keepaliveConnections.size===0`)
  就发 `chrome.notifications`(新增 `notifications` 权限)。有 leftover steer(要续跑)时不发,等真正结束那次发。
  点通知 → `chrome.sidePanel.open`。
- **通知图标**:扩展没有图标文件,所以 SW 里用 **OffscreenCanvas 现画**一个 128px PNG(琥珀底 + ✓)转 data URL、
  缓存复用(`notifIcon()`);拿不到 canvas 时回退 1×1 透明 PNG。

教训:① 写确认旁路只改 `makeExecuteTool` 这一个写关卡,别散到各调用点。② "面板开没开"用 keepalive port 数
(`keepaliveConnections.size`)判断最直接。③ MV3 扩展没打包图标又要发通知,`OffscreenCanvas`(SW 里可用)现画 PNG
data URL 是最省事的自洽办法,免得为一个图标加二进制资源。

## 30. 笔记(我的笔记)—— 与记忆并列、但不注入上下文(2026-06)

新增「笔记」功能,刻意与「记忆」做成两套不同语义的东西:

- **记忆(memory-store)**:短事实/偏好,`renderMemoryBlock` 每次会话**注入 system prompt**;agent
  用 `remember` 主动记。
- **笔记(notes-store,新)**:用户自己的 Markdown 笔记,**永不注入上下文**;agent **只有用户明确
  要求**时才经 `notes` 工具读写(工具描述里写死"仅当用户要求"),不会主动写。两者各自独立 IndexedDB
  库(`web-notes` / `web-memory`),互不干扰。

**数据形状**:`Note{ id, title, content(markdown), source: 'user'|'agent'|'reply', createdAt, updatedAt }`。
纯文字 + Markdown 渲染;**不支持图片上传**,但支持图片**链接**(`![](url)`,Markdown.tsx 已 sanitize)。
标题留空时由正文首行 `deriveNoteTitle` 反推(去 markdown 装饰、截断)。

**agent 接口**:单工具 `notes`,`action ∈ create/list/search/get/update/delete`。`api-engine` 拦截
(仿 `remember`,在 `load_adapter` 块前);`bridge-client` 同名 synthetic 工具 + `bridge/server.mjs`
schema,bridge 与面板共用。**写闸按 action 动态**:create/update/delete 受「允许外部写操作」管,
list/search/get 始终可读(整工具静态 `write:true` 会误杀读)——`NOTES_WRITE_ACTIONS` 是这个契约,有单测钉。
list/search 只回 `{id,title,excerpt}` 压 token,`get` 才给全文。

**UI**(`App.tsx`,复用 memory 卡片体系 `.memory-*` + mobile-first:tap-to-expand、无 hover-only):
菜单加「我的笔记」;列表卡折叠显示标题+元信息+纯文本摘要(搜索命中 `<mark>` 高亮,复用 `highlightMatches`),
展开渲染 `Markdown`;增/删/改/搜索全有;**导出是多选**(点「导出」进选择模式 → 勾选/全选 → 导出勾中的为 `.md`,
`renderNotesExport` + `downloadText` 触发 Blob 下载;记忆页同样多选导出 `renderMemoryExport`)。
复制 / 存为笔记 / 导出都弹**全局 toast**(`ToastContext` 在 App 根注入、深层按钮 `useContext` 触发)。**回复卡**(assistant `msg-actions`)在复制按钮
旁加「存为笔记」(`MsgSaveNoteButton`,标题取首行、source='reply')。

**纯函数**(可测,无 IDB):`deriveNoteTitle / noteExcerpt / matchNotes / renderNotesExport /
renderMemoryExport` + `execNotesAction` 的入参校验(IDB 之前先 fail)+ `NOTES_WRITE_ACTIONS` 契约 —
见 `tests/notes-store.test.ts`(11)。IDB CRUD 不单测(node 无 IndexedDB,同 memory-store)。

## 31. 外部接入:连接退避,少刷控制台(2026-06)

**症状**:启用「外部接入」但 bridge daemon 没跑时,扩展每 3s 重连一次,每次失败的
WebSocket 握手都被 **Chrome 自己**打一条 `WebSocket connection to ws://127.0.0.1:<port>/
failed: ERR_CONNECTION_REFUSED` 到控制台 → ~20 条/分钟刷屏。

**关键**:这条是**浏览器网络栈**打的,**JS 抓不住、压不掉**(`onerror`/`try` 都拦不到,
fetch 探测同样会打 `ERR_CONNECTION_REFUSED`)。所以唯一能做的是**别频繁去撞**。

**修法**(`bridge-client.ts`):重连改**指数退避** `3s→6s→12s→24s→封顶 30s`(`reconnectAttempts`
计数,`scheduleReconnect` 用 `min(3s*2^n, 30s)`);连上(`onopen`)或用户手动开关
(`setBridgeEnabled`)时归零,既快速首连、断线快重连,又把空跑时的刷屏从 ~20/min 压到 ~2/min。
要彻底零刷:关掉「外部接入」开关(不 enable 就根本不连)。

## 32. 页面菜单 + 页面引用卡 + 与页面对话(2026-07)

🌐 按钮从「一键发写死 prompt」升级为**上拉菜单**(复用 `.mode-backdrop` + `.mode-menu`
z-60/61 配对,§24.1),头部显示当前页(favicon + 标题 + URL),菜单项「总结此页面」/
「与页面对话」。两个关键设计:

- **tabId 在打开菜单时锁定**(`getUserActiveTab`,panel 侧对齐 `get_active_tab` 工具的
  「跳过扩展自己页面」语义 + 取 `favIconUrl`)。prompt 内嵌 `tab_id`/url,并明确写
  「不要再调 get_active_tab」——修掉旧版「点完按钮切 tab,agent 总结错页」的竞态。tab 已
  关时回退 `get_page_text(url=…)` 重开抓取。
- **显示与 prompt 分离**:`UserMessageReq / UserTurn / UiUserTurn` 新增
  `displayText`(气泡只显示「总结此页面」这类短语,完整 prompt 只给模型)+
  `pageRefs: PageRef[]`(favicon/title/url/tabId),经 `EngineContext.userDisplay` 持久化
  到 IDB history,历史会话与历史列表 preview 同样还原。气泡下方渲染 quote 卡
  (`PageRefCard`,favicon 加载失败回退首字母 glyph;点击聚焦原 tab,已关则重开 URL)。

**与页面对话**(chat-with-page):选中后当前页钉为 composer 上方的 **context chip**
(可 ✕ 移除);chip 区「+ 标签页」弹**多选 checkbox 列表**(枚举所有可读 http/https
tab)。窄侧栏 + mobile-first(§16)约束下刻意不做参考产品的模态弹窗——chips 交互等价且
不遮输入框。发送逻辑:**同一组页面只在首次发送时**在消息尾部附 `[与页面对话]` 读取指令块
(tab 清单 + `get_text_from_tab(format:"markdown")` + 已关回退 `get_page_text`),并带
pageRefs 渲染引用卡;后续追问不重复注入(内容已在历史;compaction 把 tool result 截到
1500 字符后模型可按指令重新抓)。`sentPagesKey` 随 新对话/切换会话 重置。

配套工具增强:`get_text_from_tab` 新增 `format:"markdown"`(复用 `extractPageMarkdown`
注入**已开** tab——此前 markdown 只有 `get_page_text` 有、且只收 url 自开新 tab);
`extractPageMarkdown` 增加可选 `selector`(未命中返回空,与 text 路径一致)。

多会话并行(后台运行 + 会话条切换 + 交互卡按会话路由)见 **docs/multi-session.md**。

## 33. 划词助手(text-selection toolbar,2026-07)

选中网页文字浮出工具条:高亮(TextQuote 锚定持久化)/ 翻译·解释·总结(自定义 LLM 单次
调用)/ 问一下(回侧边栏)。本项目**首个 manifest content script**(全 http(s) 常驻但
惰性:enabled && 非黑名单才挂监听;黑名单模式 = 开启即全站生效、黑名单排除;
storage.onChanged 免刷新生效)。为什么不是 adapter、锚定算法、`sidePanel.open` 的
用户手势约束、session-storage 桥接等设计全文见 **docs/selection-toolbar.md**。
设置页:菜单 → 划词助手(开关 / auto·Alt 触发 / 黑名单 / 动作增改删排序)。
