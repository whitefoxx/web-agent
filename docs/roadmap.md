# web-agent — feature roadmap (2026-06)

Captured from a planning pass with the user (2026-06-06). Six improvement
themes, organized into phases by **dependency + value/effort**, then implemented
one at a time. This is the plan-of-record for non-explore feature work; explore
work continues in `llm-explore.md` / `llm-explore-research.md`.

Status legend: ☐ todo · ◐ in progress · ✅ done. Effort: **S** (~hours) · **M**
(~1–2 days) · **L** (multi-day).

---

## Two shared foundations (build once, reused by several features)

Several themes below stand on the same two primitives. Build these first / as
part of the first feature that needs them, then reuse.

### F1 — Controlled-tab registry ✅ (underpins T1, T4-tabs, T7)

**Done** (`src/background/controlled-tabs.ts`): in-memory registry of agent-opened
tabs (`adoptTab`/`releaseTab`/`isControlled`/`controlledTabIds`), pruned on
`tabs.onRemoved`. Wired into the explore-tab creators + `generic__open_url`.
Today only the explore session tracks a `tabId` (`src/explore/session.ts`); tabs
the agent opens via `generic__open_url` / `chrome.tabs.create`
(`service-worker.ts:789/805`) aren't otherwise distinguished from the user's own
tabs. Introduce a small SW-side registry: which `tabId`s the agent created /
controls, tagged by session. This is the data tab-grouping (T1), "list my tabs"
(T4) and external control (T7) all read from.

### F2 — Adapter invocation core ✅ (underpins T6, T5, T7)

**Done** (`src/sidepanel/adapter-run.tsx`): extracted `initArgVals`/`buildArgs`/
`runTool`/`ArgsForm` from App.tsx + a self-contained `RunPanel` (arg form → run →
result). The explore 试跑 card now imports it (runLabel="试跑"); the Adapters view
uses it for manual run. Arg schemas come from a new `GET_ADAPTER_COMMANDS` message.
We already have: the dispatcher that executes an adapter
(`src/tools/dispatcher.ts`), the tool-description layer (`src/tools/manifest.ts`)
the LLM consumes, and an arg-form + runner built for explore 试跑
(`ArgsForm` / `runTool` / `buildArgs` in `src/sidepanel/App.tsx`). Extract a
single reusable path: **introspect an installed adapter's arg schema → render a
form → invoke → render result**, decoupled from the explore card. Manual
execution (T6), shortcuts (T5) and external control (T7) are all thin layers on
this.

---

## Phase 1 — quick wins on existing infra

### T1 — Tab groups: visually isolate agent-controlled tabs ✅ (S–M)

**Done**: added the `tabGroups` permission; `adoptTab` collects controlled tabs
into one named/colored "Web Agent" group (reuse-or-recreate, best-effort so
it degrades without the permission).
**Goal:** the tabs web-agent drives are visibly separated from the user's own
tabs.
**Approach:** add the `tabGroups` permission; when the agent creates/adopts a tab
(via F1), `chrome.tabs.group(...)` it into a named, colored group ("Web
Agent"). Ungroup / clean up when the session ends. Explore's dedicated tab is the
first member.
**Deps:** F1. **Risk:** low (additive, isolated). **Why P0:** small, high daily
clarity, and it forces F1 (which later features need).

### T2 — Current-page / all-pages content + "summarize this page" ✅ (S)

**Done**: new `get_active_tab` (the user's current tab — fills a real gap: the
agent had no way to reference "the page I'm looking at") + `list_tabs` (all open
tabs, with a `controlled` flag from F1; also seeds T4 tab-search). SidePanel
"总结当前页" quick-action runs an agent turn (get_active_tab → get_text_from_tab →
summarize). "Summarize across my tabs" works via chat (list_tabs + get_text_from_tab).
**Goal:** one-click "summarize the current tab" (and read content from any/all
open tabs), without the agent having to explore.
**Approach:** the capability mostly exists — `generic__get_page_text` /
`get_text_from_tab` / `get_html`. Wire a SidePanel affordance: "summarize current
page" sends page text to the active LLM with a summarize prompt; "read all tabs"
iterates F1's tab list. Mostly UI + a canned prompt; minimal new backend.
**Deps:** F1 (for "all tabs"). **Risk:** low. **Why P0:** near-free, very visible
utility; demonstrates the extension's value with zero exploration.

### T6 — Manual adapter execution (+ later: workflows) ☐ (T6a M · T6b L)

**Goal:** run an installed adapter yourself (pick tool → fill args → run), not
only via the agent; later, chain adapters into reusable workflows.

- **T6a — manual single-adapter run ✅.** Each installed (enabled) adapter in the
  Adapters view now has a 运行 toggle → lists its commands → per command an arg
  form + Run + result (read commands; writes show a "run via chat" note). Reuses
  F2 + the existing view/download-source controls.
- **T6b — workflows (P2, see Phase 3).** Chain adapters (output → next input),
  saved + replayable, hand-built or agent-assembled.
  **Deps:** F2. **Risk:** low for T6a (reuses proven UI). **Why P1:** high value,
  mostly assembly of existing pieces.

---

## Phase 2 — new capabilities & ecosystem

### T4 — Browser-native general capabilities ✅→部分回退 (M)

**Done**: tab search = `list_tabs(query)` (T2, no new perm). Screenshot
annotate = a SidePanel overlay (`annotate.tsx`): 截图标注 captures the visible tab
→ pen/rect/color/undo → 下载/复制.
**Removed 2026-07-06**: bookmarks/history/reading-list 五个工具
(`search_bookmarks`/`create_bookmark`/`search_history`/`list_reading_list`/
`add_to_reading_list`)及其 `bookmarks`/`history`/`readingList` 权限整体移除——
安装提示里「读取并更改浏览记录/书签/阅读清单」太吓人,价值不成比例(正是下面
Risk 预判的情况)。若将来要恢复,走 `optional_permissions` + 运行时按需申请。
**Goal:** round out the "control your browser" surface beyond page content.
**Sub-items** (each a new `generic__*` tool + the perm it needs):

- **Bookmarks** — open / create (perm: `bookmarks`).
- **History search** (perm: `history`).
- **Search open tabs** (uses F1 + `chrome.tabs.query`; no new perm).
- **Reading list** — list/add (perm: `readingList`).
- **Manual screenshot + annotate** — capture (have `screenshot` tool) → a small
  annotate canvas in the SidePanel → save/download (perm: `downloads`, have it).
  **Approach:** each is a self-contained tool; they also enrich the agent's toolbox
  and the external-control surface (T7). Add only the permissions actually used
  (several are new — weigh against the install-time permission prompt).
  **Deps:** F1 (tabs search). **Risk:** medium (new perms = scarier install
  prompt; introduce incrementally / consider `optional_permissions`). **Why P1:**
  broadens utility; modular, ship piecemeal.

### T5 — Shortcuts for frequent tasks ✅ (M)

> **Renamed 工作流 2026-07-09.** After the rigid workflow entity was retired (T6b
> banner), the shortcut store became the single "reusable recipe" concept and was
> **renamed 快捷方式 → 工作流** in the UI (internal `Shortcut` type / `shortcuts`
> storage key unchanged; the agent tool is now `create_workflow`). `⟦wf:..⟧` tokens
> were dropped — only `⟦tool:..⟧` / `⟦cmd:..⟧` remain. See H3-P4.

**Current (2026-06, supersedes the T5a/T5b text below):** a shortcut (工作流) is a
**prompt recipe** — no run mode, no keyboard slot. It expands into the composer
**unsent** (the user edits/sends); it never auto-runs. The prompt may embed
`⟦tool:..⟧` command tokens (authored via the shared `CommandEditor` `/` palette),
so a recipe can carry the tools/adapters it needs. Run mode is decoupled from shortcuts entirely — `/plan` and `/explore`
are **composer** built-in commands (`BUILTIN_COMMANDS`), not a per-shortcut
setting; the `快捷方式` page dropped the 直接执行/先计划再执行/探索生成工具
selector. Shortcuts are now fully **editable** in that page (the create form
doubles as an edit form: 编辑 loads a shortcut back in, 保存修改/取消; storage
.onChanged keeps the list live). The `Shortcut.mode` field was removed from the
store; `ShortcutMode` survives only as the composer-mode union used by the
built-in commands. Legacy `tool`-kind shortcuts remain insert-only (no editor).

**T5a** (`src/shortcuts/store.ts` + `快捷方式` page + composer quick-run bar):
a shortcut is a saved **prompt** (canned agent message + mode) or **tool**
(adapter command + preset args, run via RUN_TOOL, no LLM). Create prompts in the
快捷方式 page or 存为快捷方式 from the composer; create tool shortcuts from the
Adapters 运行 panel. Buttons above the composer one-tap run; storage.onChanged
keeps everything in sync.
**T5b — keyboard**: 5 `chrome.commands` slots (`run-shortcut-1..5`, no default
keys — user binds them in `chrome://extensions/shortcuts`). Assign a shortcut to a
slot in the 快捷方式 page; SW `onCommand` → opens the panel + delivers (live
message + a pending-claim on mount for the panel-was-closed case) → the panel
runs it. Slot is exclusive (stealing it clears the prior holder).
**Goal:** one-tap recurring tasks ("summarize current page", "export this chat",
"run adapter X with args Y").
**Approach:** a shortcut = a saved {tool or prompt + preset args}. Built on F2
(saved adapter invocations) and/or canned agent prompts. Surface as buttons in
the SidePanel; optionally bind to `chrome.commands` (keyboard) — needs the
`commands` manifest key. Natural precursor to / subset of workflows (T6b).
**Deps:** F2, T6a. **Risk:** low. **Why P1:** compounds T6a; high stickiness.

### T3 — Remote marketplace (host adapters online) ✅ (M–L)

**Done**: the 284 adapters moved to the public repo `whitefoxx/web-agent-marketplace`,
mounted here as a **git submodule at `marketplace/`** (dev/tests/versioning) and
served to the runtime via **GitHub raw** (`MARKETPLACE_BASE_URL`). The build no
longer bundles them (`dist` dropped ~3.5 MB → ~830 KB); the loader fetches
`index.json` + per-adapter source remotely with the existing **sha256 verify**,
caches the last-good index in `chrome.storage.local` for offline browsing, and the
SW stale-check (`findStaleMarketplaceAdapters`) compares against the remote index.
Extension keeps only the generic tools. The public repo self-verifies (sha256 +
source-lint test). Manifest WAR globs for `marketplace/*` removed. Below is the
original plan.

> **⛔ Marketplace INSTALL removed 2026-07-09 — adapters are load-only now.** Since
> the agent auto-runs `find_adapters` → `load_adapter` (ephemeral, §10.38–39), a
> persistent install added nothing but per-turn token cost. The `install_adapter`
> tool, the market/paste install UI, the AGENT_INSTALL_ADAPTER path, and the bridge
> install tool are gone; the Adapters page is now 市场 (browse + 运行 / 引用;
> 加载到本会话 removed 2026-07-11) + 探索生成 (synthesized adapters, auto-persisted on a
> passing verify since 2026-07-11 — the 安装 button is gone). The persistent store +
> `installFromCaptured` stay — they now serve ONLY explore-synthesized adapters. See
> adapter-hot-plug §10.40 / §10.46.

**Goal:** move the 284 adapters (2.7 MB) out of the bundle to a public GitHub
repo; use on demand over HTTPS; version control + future community
contributions.
**Approach:** the loader is _already designed for this_ — `src/sidepanel/
marketplace.ts` resolves `adapter.source` against a base URL and **already
verifies sha256** before install (so a remote swap can't tamper). Work needed:

1. New public repo `web-agent-marketplace` holding `index.json` + per-site
   `*.js` (current `marketplace/` tree), served via raw.githubusercontent or
   GitHub Pages; CI runs the existing `scripts/build-marketplace-index.mjs` to
   regenerate the index + hashes on PR merge.
2. Point the base URL at the remote; drop the adapters + `web_accessible_
resources` glob from the extension bundle (keep a tiny built-in fallback set?).
3. **Offline / failure handling:** cache last-good index + installed sources in
   IDB; degrade gracefully when offline. Installed adapters already live
   locally, so only _browsing/installing new_ ones needs the network.
4. (Later) community tier: PR template + review → the `tier:'community'` /
   `author` fields already exist in the schema.
   **Deps:** none hard. **Risk:** medium — network dependency for browse/install,
   release-coupling between extension and repo; mitigated by local cache + sha
   pinning. **Why P1:** real bundle-size win + unlocks the contribution story; the
   groundwork is already laid.

---

## Phase 3 — platform-level

### Reference: how opencli does external control (`~/code/browser-agent/opencli/`)

opencli is the direct prior art and we should mirror its proven shape:

- **Transport = a local micro-daemon, HTTP + WebSocket** (`src/daemon.ts`):
  `CLI → HTTP POST /command → daemon → WebSocket → Extension`, and the result
  flows back the same path. The browser-bridge extension connects _out_ to the
  daemon's WS (auto-started). This is the MV3-compatible bridge — exactly the
  option to copy.
- **Agents drive it via skills** (markdown), not bespoke integration:
  `opencli-browser` (ad-hoc browser primitives) and **`opencli-adapter-author`**
  (author an adapter end-to-end: recon → field decode → code → `opencli browser
verify`). The authoring skill enforces a **strategy note**
  (`PUBLIC_API | COOKIE_API | PAGE_FETCH | INTERCEPT | DOM_STATE | UI_SELECTOR` ×
  `Contract: stable | visible-ui | internal-unstable`) before any code — this is
  our robustness ladder, formalized.
- **Explore spans CLI calls** (`src/explore.ts`): `opencli explore start` writes
  a session pointer; subsequent `opencli browser …` calls append to
  `actions.jsonl`; `opencli explore stop` exports a trace bundle. Maps 1:1 onto
  our recorder / trace-store / cursor.
  **Key difference (ours):** opencli's adapters are local files the agent edits;
  **ours live inside the extension** and are surfaced to the agent as _tools with
  descriptions_ (`src/tools/manifest.ts`). So the external agent calls our tools
  through the bridge rather than editing adapter files — except when authoring (T7b),
  where the synthesized adapter is registered into the extension, not written to
  disk.

### T7 — External AI-agent control (Claude Code / Codex / Cursor) ✅ (L) — design ✅ · P1–P5 ✅

**Full design: `docs/external-agent-control.md`** (architecture, WS/MCP protocol,
security, the authoring skill, and a 5-phase build plan). Transport: **(A)**
self-built local daemon.
**P1** (skeleton, off by default): `bridge/` Node package (HTTP `/ping` `/status`
`/command` + WS server) and `src/background/bridge-client.ts` (SW dials out,
registers, heartbeat, reconnect). `__echo` proves the round-trip; 外部控制 settings
page toggles it + shows status. **(verified in-browser)**
**P2**: the extension pushes its catalog (`openAiToolsFromRegistry()`, re-pushed on
ADAPTERS_CHANGED); the bridge stores it (`GET /tools`); `call` routes through
`executeAdapter` so real READ tools/adapters run end-to-end. Writes gated until P4.
**P3**: the bridge speaks **MCP over stdio** (editors connect — `tools/list` from
the catalog, `tools/call` → command) via `@modelcontextprotocol/sdk`.
**P4** (T7b headline): **localhost-only, no token** (per user — it's a local tool;
the pairing token from P3 was removed). **Writes execute** — confirmation happens
on the AI-editor side (each MCP call is user-approved there), gated by a default-on
`允许外部写操作` toggle. **Explore surface**: `explore_start` / `explore_stop`
synthetic tools let the external agent record + use the explore tools
(get_a11y_tree / find_structured_data / eval_js / …) to **author adapters**; ship
the **`bridge/skills/web-adapter-author`** skill (mirrors opencli-adapter-author

- our robustness ladder). Authored source installs via the panel's 粘贴安装.
  **P5** (polish): `bridge/` ships an `npx` bin (`web-agent-bridge`); the app
  header shows a clickable **外部控制** indicator whenever the bridge is connected
  (visibility + one-click to the kill switch / 停用). **T7 complete.**
  Note: bridge-side `synthesize_adapter`/auto-register deferred (needs the panel
  sandbox to eval source → defs); the external agent writes the adapter itself.

The extension becomes a **browser-control + adapter provider**; an external coding
agent replaces our in-browser LLM loop. Two use cases, **shared transport**:

- **T7a — agent _uses_ our tools/adapters.** Run installed adapters + generic
  primitives via the bridge. Reuses `manifest.ts` (descriptions) + `dispatcher.ts`
  (execute) + F2's invoke core. The agent learns the catalog from the tool
  descriptions we already produce.
- **T7b — agent _drives exploration to author adapters_ (the headline win).**
  Expose the explore toolset we already built (`open_url`, `get_a11y_tree`,
  `find_structured_data`, `eval_js`, `query_dom`, `synthesize_adapter`, the
  differential `verify`, recorder/trace) through the bridge, and ship a
  **skill** (mirroring `opencli-adapter-author`, encoding our ladder/strategy
  note from `synthesize.ts`). **Rationale (user):** Claude Code / Codex are far
  more capable than the in-browser LLM and bring file access + iterative
  code+verify loops — pointing that stronger brain at our explore tools should
  **materially raise adapter success rate + efficiency**. The authored adapter is
  verified and registered back into the extension (session → install), reusing
  the explore install path.

**Transport (recommended):** copy opencli's **local daemon (HTTP for the
agent/CLI side + WS to the extension)**; our SW connects out over
`ws://localhost:<port>` (outbound WS allowed in MV3). One bridge serves Claude
Code / Codex / Cursor — via MCP and/or a thin CLI. Alternative: a native-messaging
host (closer to stdio-MCP, but needs host-manifest install).
**Build order:** after F2 (clean invoke core) + the bridge transport, which is
the gating L-effort piece — well-trodden by opencli, so de-risked. T7a first
(simpler), then T7b on top (adds the explore tool surface + skill).
**Open questions:** auth/pairing between bridge and extension; mapping our
tool/arg schemas → MCP tool schemas; permission model (external agent now has
browser-write power — reuse our write-confirmation gate); whether to vendor a
small daemon or depend on opencli's.
**Why high-value:** T7b is the biggest strategic lever in this list (better
adapters, faster) and directly compounds all the explore work already shipped.
Largest + most architectural, so sequenced last — but worth pulling the **bridge
transport** earlier if we want T7b sooner.

### T6b — Workflows (chain adapters) ✅ then ⛔ RETIRED 2026-07-09 (L)

> **⛔ Retired 2026-07-09 — the rigid workflow entity was removed; 工作流 is now a
> prompt recipe.** The deterministic adapter-pipeline (`{{N.field}}` step templates,
> `for_each`, `runWorkflowInSW`) proved too rigid: fixed I/O, no room for the
> per-run reasoning/post-processing most real tasks need, and awkward to edit. Per
> the product's LLM-first grain (see `webchat-general-not-vertical`), it was merged
> into **shortcuts**, which were **renamed 工作流** in the UI. A 工作流 is now a saved
> **prompt recipe** (natural language: what to do, which tools/adapters via
> `⟦tool:..⟧`, how to post-process) that the agent runs flexibly. Deleted:
> `src/workflows/`, `src/sidepanel/workflow-run.ts`, `WorkflowsSection`, the
> `run_workflow` + rigid `create_workflow` agent tools, the `⟦wf:..⟧` token +
> INJECT_CONTEXT injection, composer ⛓ workflow chips, bridge `create_workflow` /
> `list_workflows`. No data migration (product pre-launch): boot drops the
> `workflows` storage key + prunes workflow-only schedules (`cleanupLegacyWorkflows`
> in schedule-runner). New surface: `create_workflow` = save a prompt recipe
> (intercept reuses the shortcut store); the `/` palette 工作流 group = prompt
> recipes; **generic tools are now insertable** as `⟦tool:generic__..⟧` (already in
> `allAdapterCommands()`). See H3-P4 below. The history below is kept for context.

**Done**: `src/workflows/store.ts` (CRUD + `resolveTemplate` + `templateValue`) +
a 工作流 page (`WorkflowsSection`). A workflow is a named, ordered list of steps
(tool + args); later steps reference earlier results via `{{N.path}}` / `{{prev}}`
templates (N = 1-based step index). The step editor picks any tool (new
`GET_ALL_TOOLS` → `allAdapterCommands()`) and renders its arg fields; run executes
sequentially via RUN_TOOL (read tools; writes refused, same as manual run) and
shows per-step results.
**Fan-out** ✅: a step's `每项循环` (forEach) takes a context array path (`1` /
`prev` / `1.rows`); the step runs once per element with `{{item.field}}` in scope
(capped at 50). Result becomes an array for downstream steps.
**Agent-assembled** ✅ _(retired — see banner)_: a `create_workflow` agent tool
let the agent build + save a rigid workflow (name + steps with args/for_each).
**Composer quick-run** ✅: saved workflows appear as ⛓ chips in the composer bar
(next to shortcut chips); clicking runs the workflow (shared `runWorkflowSteps`)
and posts a compact per-step summary into the chat. **T6b complete.**
**T6d — workflows as agent tools + inject-to-chat** ✅: (1) a `run_workflow` agent
tool (offered when workflows exist, non-explore) runs a saved workflow via a
SW-side runner (`src/workflows/run-sw.ts`, `executeAdapter` directly; write steps
refused) and returns the results — so the agent calls workflows like any tool.
(2) Running a workflow (composer bar, or the 工作流 page's 💬「在对话里用结果」)
injects the full per-step results into the session context via a new
`INJECT_CONTEXT` message (append, no run), so the agent can answer follow-ups
about it.

**Goal:** compose adapters into saved, replayable pipelines (output → next
input); hand-built or agent-assembled.
**Approach:** a workflow = an ordered list of adapter invocations with arg
bindings (literal or `← previous step's field`). Reuses F2 for each step + a
small DAG/sequence runner; agent-assisted creation reuses the explore synth
muscle. Shortcuts (T5) are the 1-step special case.
**Deps:** F2, T6a, ideally T5. **Why P2:** powerful but broad; let manual exec +
shortcuts validate the invoke model first.

---

## Recommended sequence

1. **F1 + T1** (tab groups) — small, sets up the tab registry.
2. **T2** (summarize current page) — near-free, high-visibility.
3. **F2 + T6a** (manual adapter execution) — unlocks T5/T7; reuses explore UI.
4. **T5** (shortcuts) — compounds T6a.
5. **T4** (browser capabilities) — modular, ship piecemeal.
6. **T3** (remote marketplace) — bundle-size win; groundwork already laid.
7. **T7** (external agent control) — biggest; build on the clean invoke core.
   **T7b (agent-driven exploration)** is the highest strategic lever — if we want
   it sooner, pull the **bridge transport** forward (it's the gating piece, and
   opencli has de-risked the design), then layer T7a → T7b.
8. **T6b** (workflows) — after the invoke model is proven.

Items 1–3 are the fastest path to visible value; 6–8 are the platform bets — of
which **T7b** is the standout (a stronger external brain driving our explore
tools → better adapters, higher success/efficiency). Order is a recommendation —
reprioritize per appetite.

---

## Post-roadmap audit + fixes (2026-06-07)

Two parallel read-only audits (prompts + feature logic) after the roadmap shipped.
Write-gating verified correct on every path (agent confirm, workflow refuse, panel
RUN_TOOL refuse, bridge allowWrites). Fixed:

**Prompts (`synthesize.ts`, `api-engine.ts`):**

- pipeline prose said "click 展开" but the pipeline engine has **no `click` step** →
  reworded to "evaluate 里 `.click()` + `{ wait }`"; the supported-steps list was
  missing `wait` (+ filter/sort/transform) → completed it.
- `__loc.units` needs ≥2 elements to pick a group → noted the threshold.
- virtual-list bullet now leads with `page.autoScroll`.
- `synthesize_adapter` desc + exploreNote now name `find_structured_data` /
  `find_in_network` and clarify "fetch via eval_js" (no standalone fetch tool).

**Logic:**

- `findStaleMarketplaceAdapters` used the hardcoded base URL, ignoring the
  `remoteMarketUrl` override → now uses `resolveBaseUrl()` (exported).
- bridge daemon: in-flight calls now fail fast on extension disconnect (were
  hanging the full 60s timeout); a re-`register` closes the prior socket.
- `handleInjectContext` re-checks `activeSessions` after its async load (race).
- `explore_start` over the bridge is now gated by `allowWrites` (it opens a tab +
  enables in-page eval — a write-ish capability).
- `get_active_tab` no longer falls back to an agent-controlled tab.
- `create_workflow` flags unknown tool ids at creation.

Deferred (minor, noted): panel workflow runner chains via the 200KB-capped preview
(diverges from the SW runner for huge results); controlled-tabs group-id reuse has a
low-frequency race; forEach over a non-array silently runs once.

---

## Next horizon (2026-06-11) — beyond the shipped T-series

The T-series (F1–T7) shipped the foundation: controlled tabs + agent window,
the invoke core, browser-native capabilities, shortcuts/workflows, the remote
marketplace, external-agent control, and (since) notes. The position is now
clear and worth naming, because the next bets defend and compound it:

> **A local-first browser agent operating the user's real logged-in sessions,
> with a robustness ladder (deterministic adapter ≻ LLM browse) and a
> hot-pluggable, hash-verified adapter market that external agents can extend.**

That ladder is the moat — it's the answer to pure computer-use's slow/flaky/
expensive failure mode. The horizon below hardens it, then turns the tool into a
proactive, trustworthy assistant. All items ☐. Effort **S/M/L** as before.

### Tier A — defend the moat (adapter reliability + the MCP wedge)

**H1 — Adapter self-healing ◐ (L) — the #1 lever.** (P1 shipped 2026-06-11)
The headline failure mode of any adapter-based agent is **site drift**: the site
changes, the adapter silently breaks. We already have explore→synthesize→replay
and a differential verify; the missing link is **failure → auto-repair**.

- **Approach:** each adapter run records success/failure + a cheap page-structure
  fingerprint (selector hit-rate, result schema shape). On _N_ consecutive
  failures or a fingerprint break → auto-trigger explore → re-synthesize →
  smoke-test → hot-swap (user-confirmed), rotating the submodule `index.json`
  sha256. Surface a **freshness/confidence score** per adapter in the market.
  Reuses the recorder substrate (`llm-explore` P1), `synthesize.ts`, the verify
  pass, and the hot-plug install flow.
- **Deps:** explore/synthesize ✅, marketplace submodule ✅. **Risk:** medium
  (auto-eval safety; false-heal). **Why:** site drift is what kills adapter
  agents; self-healing is what makes a _community_ market sustainable without
  hand-maintenance.
- **Decomposition + status:** **P1 — health monitor ✅** (`src/adapters/
adapter-health-store.ts`): every `executeAdapter` outcome folds into a per-tool
  rolling summary in its own IDB; `errorKind` splits **drift** (`empty`/`generic`)
  from a site-side **block** (`auth`/`rate`) and **infra** (`tab`); pure
  `computeHealthStatus` → healthy/degraded/broken/blocked, surfaced as a badge on
  the Adapters rows (shown only when NOT healthy, so the list surfaces problems).
  `consecutiveDriftFails ≥ 3` = broken = the P2 heal trigger. · **P2 — auto-heal
  loop ✅**: **P2a seeded heal launch ✅** — a 修复 button on drifted (broken/
  degraded) Adapters rows starts an explore run **pre-seeded** with the broken
  source + last error + target (same site/name) via the normal agent-run launch
  (`App.startRun`, explore mode); the agent re-explores and `synthesize_adapter`
  re-generates + verifies the operation. A re-install clears stale health
  (`installFromCaptured` → `clearHealth`). **P2b — in-place overwrite ✅**: healing a marketplace/manual adapter now installs the re-derived version under its ORIGINAL id as a **local override** (origin `manual` → no `my-` prefix, exempt from sha-drift), overwriting the broken one and clearing its health; explore-origin heals keep their clean `my-` overwrite. Threaded via a `healTarget` on the run → the explore-card install picks its origin from the original (`App` → `installOrigin` → `ExploreAdaptersCard`/`AdapterRow`). User still confirms at 修复 + 安装. **P2c — proactive prompt ✅**: when an installed adapter drifts into broken
  (the store fires once on the exact transition → SW broadcasts `ADAPTER_BROKEN`),
  the SidePanel shows a dismissible banner above the chat — `修复` runs the same
  seeded heal, `忽略` dismisses (deduped by id). So a failing adapter surfaces a
  one-click heal without opening the Adapters page. · **Heal visibility/reversibility ✅** (#1/#2): a healed marketplace adapter is marked `origin.healedFrom='marketplace'` → the Adapters row shows a 「本地修复版」 tag + tooltip (it's decoupled from market sha-drift auto-update, see Q&A below), and a 「恢复市场版本」 button re-installs the upstream version (re-couples + discards the heal). Note: a local heal CANNOT be pushed to the marketplace from the extension (maintainer-only, via the bridge); user-contribution back to the repo is the **community-report loop** (below).
- **Community report loop ✅** (zero-backend, GitHub-native, `adapter-report.ts`): the marketplace IS a public GitHub repo, so a broken/healed adapter surfaces a **pre-filled GitHub issue** — **报告失效** (on the P2c banner + broken market rows; error + context, `adapter-broken` label) and **贡献修复** (on healed rows; carries the re-derived source, `adapter-heal` label) — the maintainer audits + merges + rotates sha. Privacy: only the error + adapter source, never scraped data; the user reviews on GitHub before submitting. Long source → clipboard fallback (URL cap). This is the sustainable-community-market piece H1 named. · \*\*P3 — market freshness/confidence score
  - sha rotation on heal ☐.\*\*

**H2 — External control / MCP as a first-class product ✅ (M).** (shipped 2026-06-12)
Lean into the bridge: position web-agent as **"the logged-in-browser
execution layer for any agent"** (Claude Code / Cursor / custom), not only an
in-panel assistant.

- **Approach:** harden + publish the bridge's MCP surface (`tools/list` from the
  catalog, the explore + adapter-author tools); make the
  `web-adapter-author` skill the front door for external agents to author
  adapters; document the differentiator (deterministic adapters + real sessions
  - local-first) vs raw computer-use. Close small parity gaps (e.g. add
    `update_memory` to match the `notes` CRUD surface).
- **Deps:** T7 ✅. **Risk:** low–medium. **Why:** rides the MCP wave; the bridge
  - skill are a head start; turns a feature into a platform others build on.
- **Decomposition + status:** **P1 — MCP depth + embedded positioning ✅** (`bridge/server.mjs`): the MCP server now declares **prompts + resources** capabilities (not just tools). Ships guided **prompts** — `author-adapter`, `find-or-load-adapter`, `summarize-tabs` — and **resources**: `web://server-info` embeds the value prop + cheapest-path workflow **into the protocol** (a connecting agent reads what this is + how to drive it), and `web://adapters` exposes the catalog — so an MCP client sees guided workflows + browsable context, not a flat tool list. · **P2 — trust ◐: P2a external-action audit log ✅** — every external (bridge) tool-call is recorded (tool, ok/fail, write flag, error, time) and shown LIVE, newest-first, in the 外部接入 page (in-memory ring, last 100; reply() is the single record hook). **P2b per-site write denylist ✅** — sites where external WRITES are always blocked (even with the global switch on), managed in the 外部接入 page; enforced in bridge-client by extracting the site from the tool name. Persistent audit → H7. · **P3 — onboarding + positioning docs ✅**. · **P4 — contribution tie-in ✅** (agent-authored/healed adapters → one-step marketplace PR, reuse H1's `adapter-report`). Reliability folded into **H7**.

### Tier B — from tool to assistant (proactive + trustworthy)

**H3 — Standing / scheduled agents ◐ (M–L).** (P1 shipped 2026-06-12)
From "ask once, run once" to recurring/proactive: _"every morning, summarize my
X feed + new GitHub issues into a note."_

- **Approach:** schedule workflows via `chrome.alarms`; output sinks = **notes**
  ✅ + memory; optional event triggers (tab visit, …). A 计划任务 page to
  list/manage; runs headless in the SW. **Depends on H7** for SW-lifetime
  durability.
- **Deps:** workflows ✅, notes ✅, `alarms` perm. **Risk:** medium (MV3 SW
  lifetime for scheduled runs). **Why:** shifts reactive → proactive; notes
  already built the output sink. · **P1 — scheduled workflows → notes ✅**: a 计划任务 page schedules a saved WORKFLOW on a cadence (每天 HH:MM / 每隔 N 小时); chrome.alarms fires it headless in the SW (runWorkflowInSW — deterministic, read-only), the result auto-saves as a note, with last-run status + 立即运行. Alarms persist across SW restarts; new alarms permission. · **P1.5 — runs land in 会话历史 ✅ (2026-07-06, supersedes the note sink)**: each run is recorded as a SESSION (user turn ⏰ + one tool_trace per step + assistant markdown summary; `session.schedule = {id,label}` → history list shows a ⏰ 计划任务 badge; apiMessages seeded user+summary so 继续 lets the user interrogate the results). Completion pings: desktop notification when the panel is closed (`notifyScheduleDone`, reuses the `done_` click-to-open handler), and a persistent in-panel top banner (ScheduleNotice in storage.local, live via storage.onChanged) — click opens the run's session and acknowledges it (never shows again); ✕ dismisses without opening. · **P2 — prompt schedules + UX round ✅ (2026-07-06, same day)**: (a) **prompt tasks** — a schedule can now carry a PROMPT instead of a workflow; it runs a full headless agent session via `driveApiSession` (autoApprove **off**: panel open → the write-confirm card appears as a background-session 待输入; closed → writes time out declined). (b) **instant feedback** — `runScheduleNow` returns as soon as the run's session exists (status 'running', already in 历史会话); execution continues async (`finishScheduleRun`); the row flips to 运行中(optimistic + `lastStatus:'running'`),立即 disabled, storage.onChanged keeps rows live; double-start guarded (running < 10min refuses — the original bug: no feedback → double click → two sessions). (c) **digest, not data dump** — workflow runs end with ONE bounded LLM call (`digestResults`, resolveSlots primary; falls back to the raw listing) so the assistant turn is a readable 总结; raw step data stays in the expandable tool_trace rows. (d) **iPhone-reminder cadences** — 一次 / 每天 / 每周几(chips)/ 每月 N 日 / 每隔 N 分钟|小时|天; weekly/monthly/once fire as ONE-SHOT alarms re-armed on fire (`handleScheduleAlarm`) — absolute wall-clock `when`, so §10.28 boot create-if-missing stays safe; 'once' auto-disables after firing. (e) 备注 field + 新建工作流 entry (link row under the select, jumps to the 工作流 page) + 编辑 existing schedules (pencil → same form pre-filled; keeps id/createdAt/enabled/last-run, SAVE_SCHEDULE re-syncs the alarm). · **P3 — agent-created schedules + composition ✅ (2026-07-09; its rigid-workflow framing superseded same day by P4)**: a `create_schedule` agent tool (`engine-tools.ts` → api-engine intercept, non-explore) lets the agent SET UP a scheduled task itself — before this it could assemble workflows / shortcuts / site-scripts but not schedules, so a task like _"每天早上 9 点抓 HN 首页并总结 top5"_ dead-ended. The tool takes `label` + a structured `cadence` (validated by the new pure `parseCadence()` in `schedules/store.ts` — LLM args → `Cadence`, `once.at` accepts ISO or epoch; unit-tested) + EITHER `workflow_name` (resolved to workflowId/Name, deterministic path) OR `prompt` (headless agent session); upsert-by-label; registers the `chrome.alarm` **inline** (not via schedule-runner's `syncAlarm` — that import would cycle api-engine → schedule-runner → engine-driver → api-engine). **Composition** is now a first-class capability, taught in the system prompt (`api-system-prompt.ts` "把能力固化 & 串联" section): (1) **workflow + schedule** — `create_workflow` then `create_schedule{workflow_name}`; the workflow is zero-LLM but the scheduled run auto-`digestResults` into a report, so "定时抓取+汇报" needs no per-step LLM. (2) **workflow + shortcut post-processing** — `create_shortcut` stores `⟦wf:名⟧` + natural-language processing instructions; on trigger the agent runs the (rigid I/O) workflow then reshapes its output per the prompt (the user's rigid-workflow-needs-flexible-output case). (3) **explore→adapter→workflow→schedule** — synthesize a missing adapter first, then chain. · **P4 — 工作流 became prompt recipes; schedules retargeted ✅ (2026-07-09, supersedes P3's rigid-workflow framing)**: the rigid workflow entity was removed (see T6b banner) and 快捷方式 renamed **工作流** (a natural-language prompt recipe that may embed `⟦tool:..⟧`). A schedule now targets EITHER `shortcutId` (a saved 工作流, resolved to its current text at run time — so editing the 工作流 updates every task pointing at it) OR an inline `prompt`; **both run as a full agent session** (`driveApiSession`), so the deterministic path + its LLM digest (`runWorkflowInSW`, `digestResults`) are gone — the agent writes its own summary. `create_schedule` swapped `workflow_name`→`shortcut_name`; `create_workflow` now = save a prompt recipe (intercept reuses the shortcut store, upsert-by-label). SchedulesSection form: the workflow `<select>` became a 工作流(recipe) picker (`scId`, options from prompt shortcuts); the row shows `工作流:label` or `提示词:…`. `cleanupLegacyWorkflows` (boot, in schedule-runner) drops the `workflows` storage key + prunes workflow-only schedules (no migration — product pre-launch). System prompt "把能力固化 & 串联" rewritten around 工作流 / 计划任务 / 站点脚本 (no more `⟦wf:⟧`; recipe-with-post-processing replaces the workflow+shortcut hack). Chosen tradeoff: lose zero-LLM deterministic replay, gain flexibility — fits the LLM-first product. Remaining: event triggers.

**H4 — Verification, provenance & write safety ☐ (M).**
Trust is the bottleneck for an agent acting on logged-in accounts.

- **Approach:** (a) **provenance** — each extracted value carries its source
  (URL + DOM node / network endpoint); surface it in results. (b) **self-verify
  pass** — a parallel verify (count sanity, sample re-fetch) on the
  parallel-execution substrate. (c) **writes** — upgrade the write-confirm to a
  **dry-run preview + diff** (site writes, and `notes delete`).
- **Deps:** parallel execution ✅, write-confirm ✅. **Risk:** low–medium.
  **Why:** makes extracted data citable and destructive ops safe.

### Tier C — scale personalization + polish

**H5 — Memory retrieval (not injection); notes as a knowledge base ☐ (M).**
Memory is a flat list dumped into every prompt — it grows, dirties, and burns
tokens.

- **Approach:** scope/structure memory (per-site/per-task); **retrieve top-K
  relevant** instead of injecting all. Make **notes** a retrievable KB the agent
  searches / cites / cross-links (`[[ ]]`) — already the not-injected design, so
  the next step is retrieval + linking, not a rewrite.
- **Deps:** memory-store ✅, notes-store ✅. **Risk:** low. **Why:** bounds token
  cost as memory/notes grow; sharper personalization.

**H6 — Safety / privacy / auditability ☐ (M).**
The power to act on your sessions needs guardrails to be trusted.

- **Approach:** an **exportable audit log** (what the agent read/wrote, per
  site/session); **per-site permission policy** (allow read X, never write Y);
  lean on deterministic adapters to avoid sending raw pages to the LLM (a
  privacy advantage worth surfacing).
- **Deps:** controlled-tabs / dispatcher ✅. **Risk:** low. **Why:** a real
  differentiator for a local browser agent; shrinks blast radius.

### Cross-cutting infra

**H7 — Durable agent state across MV3 SW restarts ✅ (S–M).** (closed 2026-06-12 — P1 + the acute cases already fixed; rest solved/low-value)
Kill a whole _class_ of "SW died → in-memory state lost" bugs (the agent-window
leak fixed on 2026-06-11 was one instance; the keepalive saga another).

- **Approach:** a small **durable-state layer** — anything that must outlive a
  task (agent window id [done], controlled set [done via recovery], explore
  session, in-flight writes, schedules) goes through `chrome.storage.session/
local` + a startup reconciliation, instead of ad-hoc per feature.
- **Deps:** none. **Risk:** low. **Why:** MV3 SWs die unpredictably;
  systematizing durability prevents recurring bugs and unblocks H3.
- **Decomposition + status:** **P1 — durable bridge audit log ✅**: the external-call log now mirrors to `chrome.storage.session` (cleared on browser close = the audit's lifetime) + restores on SW startup, so an MV3 SW death mid-session no longer wipes the user's view of what the external agent did. (The agent-window leak fix, 2026-06-11, was the same pattern.) Remaining candidates: explore-session resume (mostly handled — the trace lives in IDB), bridge keepalive during long external sessions.

**H8 — Result rendering & onboarding polish ☐ (M).**

- **Approach:** rich/tabular rendering for adapter results (sortable, one-tap
  **export to a note**); a more guided explore→adapter onboarding (the flow is
  powerful but expert-only today).
- **Deps:** notes ✅. **Risk:** low. **Why:** usability; closes extraction →
  notes/workspace loop.

**H9 — Human-in-the-loop takeover (stuck-handoff) ◐ (S).** (P1 shipped 2026-06-13)

- **Approach:** when a tool hits a wall only a human can pass — login wall /
  `auth_required` / captcha / 2FA — don't just fail. PAUSE the run, focus the
  offending tab, and ask the user (who's right here at the browser) to take over;
  RESUME (retry) on their OK. Borrowed from browser-act's `remote-assist`, but we
  need no remote URL — we already drive the user's own logged-in Chrome.
- **Deps:** the agent window + the write-confirm pause/resume substrate. **Risk:**
  low — contained in the tool executor (`makeExecuteTool`); the agent loop
  (`api-engine`) is untouched. **Why:** the most common dead-end (login walls, F-22)
  turns from a failed task into a 2-click recovery — "agent got stuck" becomes
  "agent asked for help". Deliberately NOT borrowing browser-act's stealth/anti-bot
  posture (we ride the real user's session — captchas go through this human path).
- **Decomposition + status:** **P1 — reactive takeover on `auth_required` ✅**:
  the dispatcher surfaces `tabId` + `authDomain` on an `auth_required` result;
  `makeExecuteTool` offers a takeover in MANUAL mode only (auto mode runs unattended
  → surfaces the error). The SW focuses the tab and shows a panel card
  (`HumanTakeoverCard`: 我已完成继续 / 回到标签页 / 放弃, 5-min timeout) reusing the
  write-confirm substrate (`pendingTakeovers` map + `HUMAN_TAKEOVER_REQ/RESP`); on
  继续 it retries the tool once — the fresh login cookies now satisfy it. · **P2
  (future):** a proactive `request_takeover` control/engine tool (a capable model
  invokes it for captcha/2FA before failing); broaden the trigger beyond
  `auth_required` (login-wall heuristics that surface as `empty`/`generic`); open a
  fresh tab to `authDomain` if the pooled tab was reaped mid-takeover; offer
  takeover to bridge/MCP external agents when a panel is open.

**H10 — Perception upgrades: Set-of-Mark for the UI-fallback rung ◐ (S–M).** (P1+P2 shipped 2026-06-13)

- **Approach:** make `get_interactives` (the perception entry point for adapter-
  less UI driving + explore authoring) as accurate + legible as browser-use /
  Nanobrowser's Set-of-Mark: (1) **occlusion** — skip elements a modal/overlay
  covers; (2) an optional **visual numbered-box overlay** for explore/debug +
  vision models; (3) **shadow-DOM / same-origin-iframe traversal** for web-component
  sites. Lifts the BOTTOM rung of the robustness ladder (UI_SELECTOR) — deterministic
  adapters stay the goal, but when we must drive raw UI, do it on better perception.
- **Deps:** none for P1/P2; P3 needs coordinated ref resolution. **Risk:** low
  (P1 fail-open; no `get_interactives` unit tests to break). **Why:** fewer wrong
  clicks (occluded/hidden elements), better explore authoring, vision-model support.
  Borrowed from browser-act/Nanobrowser, but kept as an *authoring/fallback* aid —
  not a per-step LLM loop (our bet stays record-once → deterministic replay).
- **Decomposition + status:** **P1 — occlusion (topmost) test ✅**: `get_interactives`
  now drops elements covered by a *different* element — a multi-point hit-test
  (`elementFromPoint` at center + 4 inset corners, respecting pointer-events),
  **fail-open** (keeps the element if no sample point is testable: off-screen /
  jsdom / unsupported), so off-viewport elements + test envs are unaffected. Helps
  replay too (adapter clicks land on the real top element). · **P2 — optional SoM
  highlight overlay ✅**: a `highlight` arg paints a numbered colored box (the label
  IS the element's ref) over every tagged element via a `pointer-events:none` fixed
  overlay — a debug / authoring aid, and (with a follow-up `screenshot`) an annotated
  image for vision models; auto-cleared on the next call or after 60s. · **P3 — shadow-DOM +
  same-origin iframe traversal ☐ (deferred 2026-06-13).** **Resumable plan:**
  (a) in `collectInteractives` (get-interactives.ts) recurse enumeration into open
  `shadowRoot`s + same-origin `iframe.contentDocument` (closed shadow + cross-origin
  frames are inaccessible — skip). (b) THE BLOCKER: a ref is a `data-web-ref`
  attribute resolved by `click` / `type_into` / `click_by_text` via a **top-document**
  `querySelector`, which doesn't pierce those boundaries — so add a shared recursive
  `findByRef(ref)` (top doc → open shadow roots → same-origin iframe docs) and use it
  in all three resolvers (keep the top-doc fast path; recurse only on miss). (c) the
  SoM overlay must add each iframe's offset to in-iframe boxes. **Files:**
  get-interactives.ts, click.ts, type-into.ts, click-by-text.ts. **Risk:** med —
  touches the core click resolver; real-browser test on a web-component site + an
  iframe site. **Why deferred:** lower-frequency (most sites aren't shadow/iframe-
  gated) and the only piece needing a coordinated multi-file change.

**H11 — 页面↔LLM 桥 (in-page continuous intelligence) ◐ (M).** (decided worth
doing 2026-07-06, out of the "经典扩展对照" capability-envelope review — the
full catalog + ranked capability-add list lives in docs/extension-patterns.md.
**P1 built 2026-07-06 on branch `feat/page-llm-bridge`** — `__webLLM.call`
in site-script js via USER_SCRIPT-world messaging + the dedicated
onUserScriptMessage channel; llmAccess grant rides the create confirm;
per-script sliding-window limits; zero new permissions. Design + real-machine
checklist: docs/page-llm-bridge.md.)

- **Motivation:** mapping classic extensions onto our primitives found five
  patterns: ① read/analyze current page (Wappalyzer-core, one-shot reader
  mode) → agent tasks, DONE; ② static per-site page modding (Dark Reader-ish,
  简悦排版/去广告) → site scripts, DONE; ③ browser orchestration (OneTab) →
  generic-tool composition, DONE; ④ **in-page CONTINUOUS intelligence**
  (沉浸式翻译-style bilingual inline translation, in-page AI overlays) →
  **blocked**: site scripts are static CSS/JS with no path to the extension's
  LLM; ⑤ extension-platform surface (newtab, global hotkeys, toolbar popup) →
  per-case new features, mostly out of scope. H11 unblocks ④.
- **Approach (sketch):** a narrow RPC from injected page scripts to the SW
  (`window.postMessage` → content/user script relay → SW `llm_call(prompt,
  {cap, timeout})`), rate-limited + site-scoped + user-consented per script
  (write-confirm-style grant, recorded in the site-script record). On top:
  a generic "translate/annotate DOM blocks" injector the agent can synthesize
  per site (or generically) — unlocks bilingual translate, in-page
  summarize-on-hover, smart form-fill hints.
- **Risks:** prompt-injection from page content into the LLM (needs the same
  sanitize/limits as tool results), token cost visibility (per-site budgets),
  and the JS-in-page trust boundary (reuse the site-script high-risk confirm).

1. **H7** (durable state) — small, prevents recurring MV3 bugs, unblocks H3.
2. **H1** (adapter self-healing) — the moat; biggest reliability win.
3. **H2** (MCP product) — strategic wedge; mostly hardening + docs on shipped T7.
4. **H4** (verification / provenance) — trust.
5. **H3** (scheduled agents) — proactive; needs H7.
6. **H5 / H6 / H8** — personalization, safety, polish; modular, ship piecemeal.

**H1 + H2 are the standouts:** self-healing keeps the adapter market alive
without hand-maintenance, and the MCP wedge turns the project into infrastructure
other agents build on. Order is a recommendation — reprioritize per appetite.
