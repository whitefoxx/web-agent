# LLM Explore → Synthesize → Replay

Status: **v1 shipped** (P1–P6 merged to main via PR #1; import follow-up on
`feat/llm-explore`). Mode "探索并生成工具" → drive once → record → synthesize →
**安装并试跑** (verify) → **根据报错重修** (bounded repair) → replay with zero LLM.
Trace **export + import** done (opencli `trace.jsonl`/`network.jsonl` or our own
`<traceId>.json` → 导入 trace → synthesize).

**v2 built on this branch** (E1–E4 done, gate green; user testing pending) —
agent-driven rebuild so explore behaves like Claude Code building a toolkit for a
site: plan-first, synthesize-as-a-tool (card streams synthesizing → 试跑 →
passed/failed), multi-adapter per run, two-tier reuse (callable adapters + site
memory findings), trace as a queryable workspace, resumable. Design + phase
notes: **§ Explore v2** at the bottom of this doc.

## Goal

Port opencli's "explore once, replay forever" value proposition into the
extension, with **no bash and no external coding agent** — everything runs
inside the MV3 service worker + side panel.

> Describe a task in plain language. The LLM drives the real browser **once**
> through our generic primitives, the system records a trace (actions, network,
> DOM snapshots), then the LLM synthesizes a **deterministic adapter**. From then
> on the adapter runs with **zero LLM** — the same hot-plug runtime that runs the
> 90+ marketplace adapters today.

The LLM cost is paid **once**, up front (explore + synthesis). Every later
invocation is just `dispatcher.executeAdapter`, no API key burned.

## Why this is cheap for us

We already have **replay**. The hot-plug runtime (`docs/adapter-hot-plug.md`)
registers `cli({...})` adapters at runtime and dispatches them with no rebuild.
The opencli-compatible registry shim (`src/runtime/registry.js`) means a
synthesized adapter is byte-identical to a marketplace one. So this feature is
only three pieces of glue on top of what exists:

1. **Record** what happens during an agent run (the trace).
2. **Synthesize** an adapter from the trace (one LLM call).
3. **Verify** the adapter against the trace, then install it.

## What maps to what

| opencli                                              | web-agent (existing)                                                                                                             | gap                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| `opencli browser *` primitives                       | `src/tools/generic/*` (open-url, click, type-into, scroll, get-interactives, get-page-text, screenshot) — all registered via `cli()` | add `list_network`, `get_html`                      |
| page fetch/XHR shim → `window.__opencli_explore_net` | `PageShim.captureNetwork()` (CDP `Network` domain) — protocol-level, sees real auth headers                                          | currently single-match; need session-long buffering |
| trace artifacts (`trace.jsonl`, `network.jsonl`, …)  | —                                                                                                                                    | new IndexedDB DB `web-agent-traces`             |
| LLM synthesis (`opencli-adapter-author` skill)       | —                                                                                                                                    | new: synthesis prompt + one structured LLM call     |
| `cli({...})` adapter format                          | `src/runtime/registry.js` shim (Strategy byte-aligned)                                                                               | none                                                |
| `browser verify` + fixture                           | —                                                                                                                                    | new: run once, compare to trace                     |
| `opencli <site> <name>` replay (no LLM)              | `dispatcher.executeAdapter` (func / pipeline / `_userScriptSource`)                                                                  | none                                                |

Two environment wins over opencli:

- **Protocol-level capture.** CDP `Network` sees the real wire request
  (cookies, signing headers Chrome added) — better endpoint discovery than a
  page-injected `fetch`/`XHR` shim.
- **Single process.** No `~/.opencli/explore/active.json` cross-process
  coordination — the explore session is one in-memory object backed by IDB.

## Data flow

```
user: "explore xiaohongshu: 抓某篇笔记的评论"
  │
  ▼  [1] explore session (P2): open/attach tab → start session network capture → mark recording
  │
  ▼  [2] agent runs the task once (reuse api-engine), recording:
  ├─ action stream  ← dispatcher hook (tool/args/status/durationMs/digest)
  ├─ network stream ← CDP session capture (all XHR/Fetch + bodies)
  └─ state stream   ← DOM/HTML snapshot + url after navigations
  │     LLM uses list_network / get_html to see how the data arrives
  ▼  [3] synthesize (P3): one LLM call: trace → {site,name,access,args,columns,strategy,source}
  │     strategy decides shape:
  │       · single signed XHR returns the data → INTERCEPT/COOKIE → Phase A pipeline / page.evaluate(fetch(...,{credentials:'include'}))
  │       · data only in the DOM            → DOM scrape → Phase B func (page.goto + page.evaluate)
  ▼  [4] verify (P4): run via dispatcher, compare to trace (non-empty / columns / row count); ≤1 LLM repair
  ▼  [5] install (reuse): sandbox eval (Phase A) or userScript bundle (Phase B) → installed-store → registerCommand → ADAPTERS_CHANGED
  ▼  [6] replay (exists): xiaohongshu__comments runs via dispatcher, no LLM
```

## Components & file map

New (`src/explore/`):

- `types.ts` — trace + event types (mirror opencli `ObservationStream` so traces export to opencli trivially).
- `trace-store.ts` — IndexedDB `web-agent-traces` (own DB; traces are large/independent and must not bloat or lock the sessions+adapters DB). Node-safe no-op like `installed-store.ts`.
- `recorder.ts` — `Recorder`: buffers the streams, truncates bodies, flushes incrementally to the store, `finalize(status)`. Store access is injected (`sinks`) so it unit-tests with no IDB.
- `synthesize.ts` (P3) — synthesis system prompt (internalizes opencli `opencli-adapter-author`: strategy selection, typed errors, column conventions) + one `chatCompletion`; emits source + example `testArgs`; supports a repair pass.
- `session.ts` (P2) — explore session lifecycle (start/stop/active), tab ownership.
- `import.ts` (P6) — `parseTraceImport`: normalize opencli `trace.jsonl`/`network.jsonl` or our exported JSON into a `Trace`. Pure; unit-tested.
- P4 verify ("试跑") + repair live in the SW (`RUN_TOOL` / `EXPLORE_REPAIR` / `markVerified`) + the side-panel card — no separate `verify.ts`.

New (`src/runtime/`):

- `network-recorder.ts` — CDP session-level capture: `createNetworkRecorder(tabId, onEvent)` — attach (tolerant), `Network.enable`, buffer `requestWillBeSent`+`responseReceived`+`loadingFinished`→`getResponseBody`, emit normalized events. `stop()`.

New (`src/tools/generic/`, P2):

- `list-network.ts`, `get-html.ts` — explore-time perception primitives.

Changed:

- `src/tools/dispatcher.ts` (P2) — append an action event to the active recorder per tool call.
- `src/agent/api-engine.ts` (P2) — explore mode: start recording, expose explore primitives, trigger synthesis at end.
- `src/messages.ts` + `src/sidepanel/*` (P2) — `EXPLORE_START/STOP`, `TRACE_UPDATE`, synth/verify/install UI.

Reused unchanged: install path (sandbox eval / userScript bundle), registry, `marketplace.ts` patterns, write-confirm gate.

## Strategy mapping (synthesizer output)

The dispatcher routes by **func / pipeline / `_userScriptSource`** — `strategy`
is a documentary label. The synthesizer picks the runtime shape from the trace:

- **PUBLIC** → Phase A pipeline, tab-less `fetch` (best).
- **COOKIE / INTERCEPT** (signed XHR + cookies) → Phase A page-driven pipeline
  or func doing `page.evaluate("fetch(url,{credentials:'include'})")` — runs in
  the user's logged-in session, zero LLM.
- **DOM_STATE / UI_SELECTOR** → Phase B func (`page.goto` + `page.evaluate` DOM
  scrape) — same as the merged `xiaohongshu/comments.js`.

Prefer **Phase A pipeline** whenever the data comes from one fetch — it needs no
runtime eval and no "Allow user scripts" toggle.

## Open design questions / risks

1. **Signed / one-time tokens** (XHS `xsec_token`, request signatures). A
   captured XHR URL may carry a per-request token. The synthesizer must prefer
   either (a) re-running the page's own fetch in-page so the page's signing code
   re-runs, or (b) DOM scraping — not replaying a frozen signed URL. This is the
   hard part; the synthesis prompt must call it out.
2. **MV3 SW lifecycle.** Explore is a long run. The trace is flushed to IDB
   incrementally so an SW kill mid-explore is recoverable (cf.
   `web-agent-mv3-sw-keepalive`). Recording rides the existing agent run
   keepalive.
3. **Debugger ownership.** PageShim attaches/detaches the debugger **per tool**.
   Session-long network capture needs a debugger attachment alive for the whole
   session — so during explore the explore tab's attachment is owned by the
   recorder and per-tool PageShims on that tab must not detach it. (P2 wiring.)
4. **userScripts permission** (Phase B). Prefer Phase A pipeline to avoid the
   toggle; fall back to func only when fetch alone can't get the data.
5. **Verify determinism.** Compare against the trace's observed data, not a
   frozen fixture, to avoid brittle snapshots.

## Phases

- **P1 — recorder substrate** ✅: `types.ts`, `trace-store.ts`, `recorder.ts`,
  `network-recorder.ts` + unit tests.
- **P2a — explore engine** ✅: `session.ts` (ExploreSession orchestrator +
  active-session registry), dispatcher action hook, `list_network` + `get_html`
  primitives, and the `page.ts` debugger-ownership fix (tolerant attach +
  owner-only detach) + unit tests.
- **P2b — UI / agent wiring** ✅: `mode:'explore'` end-to-end. SW opens a
  dedicated explore tab + starts the session before the run and finalizes +
  synthesizes after (`startExploreSession`/`finishExploreSession` in
  service-worker.ts); api-engine surfaces the explore-only primitives + an
  explore system note in explore mode; `open_url` reuses the explore tab; the
  side panel has an "探索并生成工具" mode + an `ExploreResultCard` with one-click
  install (reusing `installAdapterFromSource`).
- **P3 — synthesis** ✅: `synthesize.ts` builds a token-bounded trace digest
  (deduped endpoints + body samples + actions + DOM snapshot) and does one
  `chatCompletion` (exported from api-engine) with a prompt that internalizes the
  opencli adapter-author strategy selection; emits an opencli `cli({...})` source.
- **P4 — verify + bounded repair** ✅: synthesis also emits example `testArgs`
  (a ```json fence). The card's **安装并试跑** installs via the sandbox-eval path
then runs the tool once (SW `RUN_TOOL`, read-only) and shows rows/preview or
the error. On failure, **根据报错重修** sends `EXPLORE_REPAIR` → the SW
re-synthesizes with the failing source + error fed back (`synthesizeAdapter`repair pass) and a fresh result card replaces the old one. Bounded by the user
clicking (no auto-loop).`RUN_TOOL` refuses write adapters.
- **P5 — func/DOM-scrape synthesis** ✅ (covered): the synthesis prompt chooses
  pipeline/func/DOM by the evidence; func adapters install via the existing
  Phase B userScripts path (needs the "Allow user scripts" toggle, same as
  marketplace func adapters).
- **P6 — opencli interop** ✅: trace **export** (card → 下载 trace → `GET_TRACE`
  → `<traceId>.json`) **and import** (`src/explore/import.ts` `parseTraceImport`
  normalizes opencli `trace.jsonl` / `network.jsonl` OR our exported JSON → store
  → synth). UI: composer **导入 trace** button → `IMPORT_TRACE` → SW
  `handleImportTrace` → the same result card. The synthesized adapter is itself
  opencli `cli({...})` format (installable in opencli too). Caveat: opencli
  screenshot / state events stored as on-disk file paths can't be resolved
  in-extension and are dropped — inline network bodies (the synthesis signal)
  survive.

## P1 notes

The recorder is deliberately decoupled from persistence (injected `sinks`) and
from CDP (network capture is a separate module). This keeps the buffering /
truncation / sequencing logic unit-testable in node, and lets the wiring use the
real IDB store + CDP capture without touching tested logic.

## P2a notes

- **Debugger ownership.** The session's network recorder performs the
  `chrome.debugger.attach` first, so it OWNS the attachment. `page.ts` now
  tolerates a failed attach ("already attached") and only detaches if it was the
  owner — so per-tool PageShims created on the explore tab during a run reuse the
  session attachment and their `detach()` is a no-op, never killing the capture.
- **Action hook** is a thin wrap around `executeAdapter` (→ `executeAdapterInner`)
  so every tool path is captured with one insertion point; no-op when no session.
- `list_network` reads the live deduped endpoint summary (method+path, query
  stripped); `get_html` reads outerHTML via `chrome.scripting` (ISOLATED world,
  independent of the CDP attachment) and snapshots a `state` event into the trace.
- Still headless: nothing STARTS a session yet — that's P2b (SW message +
  api-engine explore mode).

---

# Explore v2 — agent-driven toolkit builder

v1 records passively then synthesizes **once, after the whole loop ends**. That
makes the result card feel slow (a second full LLM round-trip with no UI), caps
a run at one adapter, and gives the agent no mid-run grip on its own goal. v2
reframes explore to work like Claude Code implementing a feature: **plan-first,
the agent drives toward a concrete deliverable, "synthesize an adapter" is a
tool the agent calls, and what it learns/builds is reusable.**

User intent (three sessions, 2026-06-05): the 探索完成 card is the _goal_ — the
agent orbits it, politely declines off-target asks, and when it can't finish it
says exactly what it needs (help / clarification) instead of flailing. A run can
build **several related adapters** for one site, sharing context; already-working
**operations** (not just whole adapters — also atomic steps: opened url, located
/expanded an element, an endpoint that returned data) are **reused** next time,
not re-derived. The trace is a queryable workspace (already its own IDB DB), not
chat history. Plan and results are **persistent toggle-able cards** both the
agent and the user can review anytime. Interrupt/error/steer → **resume**.

## Architecture

**Synthesis is a tool, not a post-loop batch.** New intercepted tool
`synthesize_adapter({name, notes})` (like `update_plan` — never dispatched). The
engine:

1. emits an `explore_adapter` event with status `synthesizing` → the card shows
   that adapter row **immediately** with a spinner (fixes "card is slow / looks
   broken");
2. synthesizes from the trace slice **since the last synthesis** (a per-session
   `cursor`), so adapter N only sees the operation the agent just did;
3. runs an **automated smoke-test** with the synthesizer's example `testArgs` —
   this is the _agent's_ self-check, feeding pass/fail+preview back as the tool
   result so it can repair-and-retry **in the same loop** (true agent-driven
   repair) or move to the next operation;
4. records the adapter on the session's `adapters[]` and streams status to the
   card: `synthesizing → untested → passed/failed` (+ repair `versions[]`).

The **user's** verify is separate and authoritative: the card renders an
**editable args form** (built from the adapter's `args` schema, pre-filled with
example values, `help` as hints) so the user runs it **like real post-install
usage** with their own input — not a silent canned run. User 试跑 (RUN_TOOL)
overrides the smoke status.

**Two-tier reuse.**

- _Tier 1 — whole adapter._ When an adapter's smoke (or user 试跑) passes, it is
  `registerCommand`-ed into the live registry so subsequent iterations' tool
  list includes it (the loop already re-pulls tools each iteration) → the agent
  **calls** it instead of re-exploring. This is **session/runtime-callable
  only**; it becomes permanent solely when the user clicks **安装** (writes to
  installed-store). Confirmed choice (2026-06-05).
- _Tier 2 — atomic findings._ Successful steps + discoveries (endpoint→data,
  working selector, required wait/scroll, login state) persist as **site
  memory** keyed by site, **even if that adapter never passed**. New
  `note_finding` tool + auto-derivation from successful actions. Injected into
  the explore system note on later runs so the agent builds on it.

**Trace as workspace.** New explore-only tools `read_network({endpoint})` (full
captured request/response body from the trace) and `list_trace` (overview), so
the agent inspects real bodies mid-run to decide the data path — better
exploration _and_ better synthesis (v1's agent never saw bodies until synth).

**Plan-first + persistent cards.** Explore always produces a plan (auto-seeded,
editable, **no blocking approval modal** — explore is read-mostly; the real
write gate stays the write-confirm). Both the **plan** and the **探索成果**
(multi-adapter) cards become persistent + toggle-able (pin pattern from
§10.22), survive across turns, reviewable by user and agent anytime.

**Goal orientation.** A firmer explore system prompt: the only deliverable is
verified adapter(s); decline unrelated work; when blocked (login/captcha/
ambiguous), STOP and ask — the card shows a distinct 等待协助/澄清 state vs
探索中 / 合成中 / 完成.

**Resume.** Persist the explore-session state (tabId, traceId, site, plan,
adapters, findings cursor) keyed by chat session in IDB, so an abort / error /
SW-death survives; 继续 rebinds to the existing trace (append), restores the
cards, and continues the loop.

## Data model

- `ExploreAdapter` (one card row): `{id, site, name, status:
'synthesizing'|'untested'|'verifying'|'passed'|'failed', source?, summary?,
args?: {name,type,required,help}[], testArgs?, verify?: {ok,rows?,preview?,
error?}, installed?, versions: {source,summary,ts,error?}[], error?, traceId,
ts}`.
- `Finding` (atomic reuse): `{id, kind:
'endpoint'|'selector'|'step'|'fact'|'login', text, detail?, fromTraceId?,
ts}`; `SiteMemory {site, findings[], updatedAt}` — new `site_memory` store in
  the `web-agent-traces` DB (bumped to v2).
- Resume binding (E4): persisted on the chat `SessionState.explore = {traceId,
site?, cursor, adapterCount}` (NOT a separate store — it travels with the
  session, which already persists). A follow-up in explore mode rebinds to that
  trace (append). The adapters card lives in panel state (restore-on-panel-reload
  is deferred — see below).

## Events / messages

- `ExploreAdapterEvt {sessionId, traceId, adapter}` — upsert one adapter row;
  status updates stream in (replaces the one-shot terminal `ExploreResultEvt`
  for the live path; import/backstop also emit this).
- `OrchEvent` gains `explore_adapter` (engine → SW → panel) so the engine can
  surface synth progress through the existing emit seam.
- Panel state: `exploreAdapters` keyed by id (persistent for the explore
  session, not cleared per turn); plan card from existing `plan` state, made
  persistent + toggle-able.

## Phases (v2) — one-shot delivery, user tests at the end

- **E1 ✅ synthesize-as-a-tool + progress + persistent multi-adapter card +
  persistent plan card + editable-args 试跑.** `synthesize_adapter` is an
  intercepted tool (api-engine) → SW `handleSynthesizeAdapter`: flush + slice
  trace from `cursor` → `synthesizeAdapter` → emit `explore_adapter`
  (synthesizing → verifying → passed/failed) → SW↔panel sandbox-eval round-trip
  (`EXPLORE_EVAL_REQ/RESP`, mirrors plan-decision) → `registerSessionDefs`
  (in-memory, no persist) → smoke-test via the dispatcher (recorded into the
  trace) → `advanceCursor`. Panel: `ExploreAdaptersCard` (toggle, one
  `AdapterRow` per id) + `ArgsForm` (editable args, seeded from the trace) →
  RUN_TOOL. `PlanChecklist` made toggle-able. Post-loop backstop synth only
  fires when the agent produced 0 adapters (`explore.adapterCount`).
- **E2 ✅ trace-as-workspace + two-tier reuse.** New explore-only primitives
  `read_network` (full body of one endpoint from the trace) + `list_trace`
  (overview). Tier-1 reuse = E1's `registerSessionDefs` (passing adapters become
  callable next iteration; permanent only on 安装). Tier-2 = site memory: new
  `site_memory` store (traces DB → v2), `Finding`/`SiteMemory`, `note_finding`
  tool + auto-record on adapter pass; `ExploreSession` loads findings on
  `setSite` (resolved from `open_url` host) and injects `findingsNote()` into the
  prompt per-iteration.
- **E3 ✅ plan-first + goal-orientation.** Explore seeds a default editable plan
  before the loop (`seedPlan`, no approval modal) so a reviewable plan always
  exists; the agent refines via `update_plan`. Goal-orientation (only deliverable
  = verified adapters; decline off-target; stop-and-ask when blocked) is in the
  rewritten explore system note. **Deferred:** a dedicated session-level
  等待协助/澄清 card state — for now the agent's stop-and-ask shows as its final
  chat message.
- **E4 ✅ resume.** `SessionState.explore` persists `{traceId, site, cursor,
adapterCount}` (snapshotted after each synth + at run end). A follow-up in
  explore mode → `resumeExploreSession` → `ExploreSession.resume` /
  `Recorder.resume` (append, seq continues; fresh tab; cursor/adapterCount/site
  - findings restored). The card persists across turns (only 新会话/清空 reset
    it). **Deferred:** restoring the adapters card after a full panel reload (the
    trace + binding survive, but the in-panel card list doesn't); and after SW
    death, session-only registered adapters are gone — site-memory findings guide
    re-synthesis instead.

Gate after the build: **tsc clean · 1337 tests (157 files) · eslint clean ·
prettier clean · `npm run build` green.** New tests: `Recorder.resume` (×2) +
`ExploreSession` v2 cursor/ids/findings/resume (×5).

## Known deferrals / follow-ups (v2)

- Card restore after a panel reload (persist + replay the adapter rows).
- Session-level 等待协助/澄清 state on the card (distinct from per-adapter).
- Re-register session-only adapters after SW death (only installed ones survive;
  findings currently bridge the gap).
- `func` synthesized adapters need the "Allow user scripts" toggle to
  smoke-test/reuse — `verifyExploreAdapter` reports this clearly instead of a
  confusing "tool not found".

## Post-mortems (v2)

### V2.1 — agent claimed success the smoke-test didn't actually show (Google AI overview)

**症状.** A Google `search` explore summarized "提取了 AI overview 正文 + 9 个参考
链接", but the actual 试跑 result on the card contained only the regular search
results — no AI overview, no reference links. The agent reported success it
hadn't verified.

**根因.** Two compounding gaps:

1. `handleSynthesizeAdapter` returned only `已合成并自动试跑通过(返回 N 行)` to the
   agent — it **never handed the agent the actual returned data**. So the agent
   couldn't compare output against the task even if it wanted to.
2. The agent therefore wrote its summary from what it had **seen on the page**
   during exploration (the AI overview was visibly there), not from what the
   adapter **returns**. And "试跑通过" was framed as success when it only means
   "ran + non-empty", not "captured everything asked for". This is the
   truthful-status-reporting failure mode (see the user memory of the same name)
   applied to explore.

**修法.**

- `handleSynthesizeAdapter` now embeds a **3000-char preview of the real result**
  in the tool message back to the agent, with an explicit instruction: "试跑跑通 ≠
  正确; 对照任务逐项核对 the returned content; 缺了就用同一 name 重新
  synthesize_adapter; 最终总结只描述适配器实际返回的内容."
- The explore system note gets a hard **核对结果** step + an **如实收尾** rule
  (never report page-seen-but-not-returned content as done).
- The synthesizer prompt gains a **coverage** rule: cover ALL task-required parts
  (AI overview / answer box / related links), not just the main list, as extra
  fields/rows reflected in `columns`.

**教训.** "Ran without error + non-empty" is not "correct". An agent can only
self-verify against reality if the system **shows it the actual output**; a
status string ("passed, N rows") invites a confabulated summary. Always feed the
real artifact back into the loop, and make the prompt force a result-vs-task
reconciliation before any success claim. Synthesis _quality_ (whether the
re-synth actually captures the AI overview) is a separate lever — the synth
prompt — still to be iterated on real traces.

### V2.2 — blind re-synthesis + page.evaluate scope bugs (Google search, exported bundle)

**症状.** With V2.1 in place, a Google `search` explore showed the agent now
**correctly noticing** the output was incomplete (it didn't fake success) — but
all 4 `synthesize_adapter` attempts failed. The exported bundle's `apiMessages`
revealed the synthesized `page.evaluate` code failing with: `ReferenceError:
limit is not defined`, `TypeError: Cannot read properties of null (reading
'length')`, and `未找到搜索结果或 AI Overview` (threw on partial). The bundle also
had `adapters: []` (panel card state was gone by export) — so the **sources
weren't in the bundle**, only the errors.

**根因.**

1. **Blind retries.** `handleSynthesizeAdapter` called `synthesizeAdapter`
   **without** the `repair` param, so a same-name retry never saw its own broken
   source + the runtime error — it regenerated the same class of bug. The agent's
   `notes` were the only signal carried over.
2. **Missing synth rules.** The prompt never stated the #1 page-scrape gotcha:
   `page.evaluate(str)` runs in the **page world** and can't see `func`-scope
   vars (`kwargs`/`limit`) → `ReferenceError`. No null-guard rule; "数据为空就
   throw" actively encouraged throwing on partial.
3. **Sources not persisted.** Synthesized source lived only in the panel card
   (lost on reload) — nothing durable, so the debug bundle couldn't carry it.

**修法.**

- **Repair loop wired.** `ExploreSession` tracks the last attempt per name
  (`recordAttempt`/`lastAttemptFor`); a same-name `synthesize_adapter` feeds
  `{prevSource, error}` into `synthesizeAdapter`'s repair param — retry = real
  bug-fix, not a re-roll. (Even a "passed but incomplete" retry carries the prev
  source + a "请改进" note.)
- **Synth prompt hardened.** Added: ⚠️ page.evaluate **scope** (interpolate args
  into the string or filter after it returns; never reference `kwargs`/`limit`
  inside) · ⚠️ **defensive取值** (null-guard querySelector) · **有什么抓什么**
  (don't throw on a missing part; throw only when fully empty). The repair text
  names the four recurring bug classes to check.
- **Sources persisted.** `SessionState.exploreAdapters` (trimmed — no bulky
  `verify.preview`) is written per synth via `persistExploreAdapter`, so the
  export bundle (and a future panel reload) always carry the SOURCE + verify
  outcome. `setSite` now also stamps the site onto the trace meta.

**教训.** An agent retry without the previous artifact + the real error is just
re-rolling dice — the repair signal (prev source + runtime error) **must** flow
to the regenerator. Page-world scraping has a sharp, recurring gotcha
(evaluate-string scope) that belongs in the prompt, not re-learned per attempt.
And debug infra must persist the actual **artifact** (source), not just status —
or the bundle can't answer "what did it generate?".

## Explore primitives — v2.3 (develop + test the extraction live)

The v1/v2 toolset could navigate + read but couldn't **test extraction logic
before baking it into an adapter** — the agent guessed selectors via raw
`get_html` and only learned it was wrong after synthesize→smoke→fail. v2.3 adds
the "REPL + structure" tools so explore works like coding with a live console.
Originally all explore-only (in `EXPLORE_ONLY_TOOLS`, registered in `_all.ts`);
since 2026-07-02, `query_dom` / `wait_for_selector` / `get_dom_outline` /
`get_html` are promoted to normal mode too (plain chrome.scripting probes that
take a `tab_id`; adapter-less driving needs them as well — see
docs/llm-explore-research.md 落地记录). The rest stay explore-only:

- **`eval_js(code)`** — run a JS snippet through the **same path the adapter
  will use** (explore session PageShim → CDP `Runtime.evaluate`, MAIN world, CSP
  bypassed, login state intact). The agent develops + tests the exact extraction
  snippet live, then passes it into `synthesize_adapter`'s `notes`; the synth
  prompt says to adopt a verified snippet verbatim. Errors are returned (not
  thrown) so iterating doesn't trip the thrash breaker.
- **`query_dom(selector)`** — safe structured selector probe: `{count,
samples:[{tag,cls,text,href,html}]}`. ISOLATED world (like get_html).
- **`find_in_network(text)`** — reverse lookup: which captured response body
  contains this page value → the real data endpoint (API sites).
- **`get_dom_outline()`** — pruned structure map (tag#id.class + own-text, runs
  of identical siblings collapsed to `×N`) instead of 100k+ raw HTML.
- **`wait_for_selector(selector)`** — deterministic poll-until-present (optional
  visible) for lazy/async content, vs. guessing a fixed sleep.

The explore note now teaches the loop: probe (outline/query_dom/find_in_network)
→ **develop+test via eval_js** → synthesize with the proven snippet → smoke →
verify against task. This targets the v2.2 failure (blind selector guessing +
page.evaluate scope bugs) at its source.

### V2.4 — query_dom froze the tab (unbounded outerHTML/textContent)

**症状.** Running `query_dom` froze the whole explore tab (images stopped
rendering) until a manual refresh, which then returned `{"error": "failed to
query (tab not scriptable on this URL?)"}`.

**根因.** The injected probe built, per match, the **full** `el.outerHTML` (whole
subtree serialized, then sliced) **and** `el.textContent` (whole subtree text,
then sliced) — up to `limit` (≤30) times. For a broad selector or a large
element that's megabytes of synchronous string-building on the **page's main
thread** → rendering/image-loading blocked. The user refreshed to escape the
freeze, which destroyed the in-flight `executeScript` frame → result came back
`undefined` → the "not scriptable" branch fired. So the freeze was the cause; the
error was a side effect of the refresh. (`get_html` does this **once**, so it was
tolerable; `query_dom` did it N×, unbounded.)

**修法.** Made every per-match operation bounded: shallow open-tag via
`cloneNode(false).outerHTML` (O(attrs), not O(subtree)); a `TreeWalker` that
collects text only until a ~400-char budget (never walks a whole large subtree);
`NodeList` indexing instead of `Array.from` of the full match set. Dropped the
full-`outerHTML` sample entirely (use `get_html(selector)` for one element's full
HTML). Clearer error when the result is `undefined` (page loading / refreshed /
non-scriptable).

**教训.** Anything injected into the page runs on its main thread — per-match
work over matched elements must be **O(1)-ish and bounded**, never "serialize the
subtree then slice" (the slice doesn't save the build cost). Watch-item:
`get_html` with no selector still serializes the whole `documentElement` once;
fine today but the same trap if a page is huge.

## Selector robustness (synthesis) — learn from the marketplace

Observed: explore-synthesized DOM scrapers used obfuscated/compiled classes
(e.g. `div.YzCcne`, `.tF2Cxc`) that work once but break on the next site
release. Surveyed the 284 opencli-derived `marketplace/*` adapters for how they
actually get data (robust by construction):

- **in-page JSON API — 148/284** (`page.evaluate(fetch(api,{credentials:'include'}))`).
  Zero selectors → can't rot. Canonical: `zhihu/hot.js` →
  `/api/v3/feed/topstory/hot-lists/total`. Most zhihu/twitter/douban commands.
- **stable semantic attrs** — `aria-label`/`[role]` 57, `data-testid` 46,
  `href` patterns 64.
- **embedded JSON** — `JSON.parse` 50, `__NEXT_DATA__`/`window.__*` 11.
- **obfuscated classes / itemprop / ld+json** — essentially nobody.

So the robustness ladder (now in the synth prompt + explore note): **① in-page
API → ② embedded JSON (`__NEXT_DATA__` / `<script type=json>`) → ③ signed-token
re-fetch in page → ④ DOM scrape, last resort, and only via stable anchors**
(`data-testid`/`data-*`/`itemprop`/`jsname` → `role`/`aria`/`alt` → semantic
tags → `href` shape → structure + visible-text anchoring) — **never** short
random-looking classes. The explore agent is told to prefer an API / embedded
JSON over scraping, and to validate any selector with `query_dom` and avoid
obfuscated classes. (Google AI-overview is a forced-DOM case: no clean API, so
robustness comes from `jsname`/`data-*`/`role` + text anchoring, not `.YzCcne`.)

## Synthesis emitted only func, never pipeline — fixed

Observed: every explored adapter was `func`-type, none `pipeline`. Root cause:
the synth prompt's source spec showed **only** the `func: async (page, kwargs)`
shape — it never showed `pipeline: [...]`, so the model could only emit func.

Why it matters: **func adapters need the per-extension "Allow user scripts"
toggle to run** (they install as `_userScriptSource` → userScripts world);
**pipeline adapters do not** (the SW pipeline engine runs them, with page steps
via CDP `page.evaluate`). That's the "prefer Phase A pipeline" intent — and most
explored ops fit pipeline: `zhihu/hot.js` is `navigate → evaluate → map → limit`,
and the `evaluate` step can itself fetch an API / read embedded JSON /
querySelectorAll (even click-to-expand + wait) as long as it returns an array.

Fix (prompt-only): the spec now teaches **both shapes, pipeline-first** —
supported steps `fetch`(tab-less) / `navigate` / `evaluate` / `map` / `limit` /
`select` / `paginate`, with `${{ args.* }}` / `${{ item.* }}` expressions; func
is reserved for genuinely multi-step/imperative cases (multiple navigations,
`page.autoScroll`, cross-step logic). The same scope/defensive/robust-selector
rules apply to the pipeline `evaluate` step. No code change — install/verify/
smoke already handle pipeline defs (`isRunnableNow` → `validatePipeline`).
(Note for authoring this in a TS template literal: `${` must be escaped as
`\${` or it interpolates at module load.)

## get_a11y_tree — the accessibility tree as a robust perception primitive

The explore tab is driven via `chrome.debugger` (CDP), and CDP has an
**Accessibility domain** — so over the session's existing attachment we call
`Accessibility.enable` + `Accessibility.getFullAXTree` and get the same semantic
tree DevTools' Accessibility pane shows (role + name + states), reconstructed
from the flat node list and printed indented (ignored wrappers collapsed,
bounded by max_nodes).

Why it helps explore success/efficiency: the a11y tree is **class-independent**
and semantic — `heading "AI Overview"`, `link "Stanford HAI"`, `list`,
`article`, `combobox "Search"` — so the agent locates the data and picks **stable
anchors** (role / aria / semantic tag / text) instead of obfuscated classes like
`.YzCcne`. It's the strongest input to the robust-selector ladder. New explore
primitive `get_a11y_tree` (explore-only); the explore note now lists it first for
DOM-type pages. (Future: resolve an AX node's `backendDOMNodeId` → a concrete
selector to hand straight to synthesis.)

## Research roadmap → see docs/llm-explore-research.md

A dedicated research pass (2026-06-06, 4 parallel investigations + SOTA review)
produced a prioritized roadmap for raising explore success/efficiency/durability:
**docs/llm-explore-research.md**. Down-payment shipped this round (P0):

- `find_structured_data` primitive — one sweep for JSON-LD / framework state
  (`__NEXT_DATA__`/`__NUXT__`/`__APOLLO_STATE__`/`<script type=json>`) / OG·Twitter
  meta / RSS·oEmbed `<link>`s / Microdata. Explore-only.
- Discovery order in the explore note: **find_structured_data → network (find_in_network/read_network) → DOM (a11y/outline/query_dom)** — find the stablest source first.
- Synth ladder rung ② expanded to the full structured-data family (was Next-only).
- Verify now emits **correctness warnings** (0 rows / non-array / declared columns
  empty in all rows) back to the agent — "ran + non-empty" ≠ correct (A2).

Top still-open levers (see the research doc): **A1** differential correctness
verify (assert output ≈ observed trace data) · **A3** source lint (arg-leak +
obfuscated-class → auto-repair) · **B1** `__loc` locator helper preamble · **B4**
a11y refs → ranked selector bundle into synthesis · **D2** change-observation
diffs · **E1–E4** stale-flag / layered fallback / replay auto-heal / induction.

## enter_explore_mode — chat→explore 的会话内升级(2026-07-06)

**动机**:用户没开 /explore,但话语明确要"修改/重造某个适配器"或"探索某站点"时,旧行为是 agent 道歉
("synthesize_adapter 仅在探索模式可用,请输入 /explore")——把模式切换的负担推回给用户,还得重发一遍任务。

**机制**(确认框方案,auto 模式自动通过):

- **工具**:`ENTER_EXPLORE_TOOL`(engine-tools.ts),**只在非 explore 模式**下加入工具表(且仅当 driver 提供了
  `ctx.enterExploreMode`——测试/无 driver 环境自动没有)。描述里明确:遇到改 adapter/探站点的诉求,
  **别说做不到、别让用户输 /explore**,直接调本工具。系统提示的「记住」两条也相应改写(api-system-prompt.ts)。
- **引擎**(api-engine.ts):拦截该调用 → `ctx.enterExploreMode(reason)` → 把返回文案作为 tool result 回给模型。
  工具表本来就每轮按 `ctx.mode` 重算;`exploreNote` 从 const 改为**每轮求值的函数**,所以切换后下一轮模型就拿到
  完整探索工具集 + playbook。`EngineContext.mode` 文档化为 MUTABLE。
- **driver**(engine-driver.ts):原 run 前的 explore 启动块提炼成 `beginExplore()`(start 或按 session.explore
  resume,复用 E4 语义),run 前和 mid-run 共用。`enterExploreMode`:已在探索→短路;确认走**现有 write-confirm 通道**
  (`requestWriteConfirmation`,tool='enter_explore_mode',reason 作 description;autoApprove 会话跳过询问,
  与写确认同语义);同意→`beginExplore()` + `ctx.mode='explore'` + 广播 `MODE_CHANGED`。拒绝/启动失败→返回
  相应文案,模型继续普通模式。`explore` 局部变量改为 `exploreRef.current` 持有——赋值全发生在闭包里,
  裸 `let` 会被 TS 流分析收窄成 never。
- **面板**(App.tsx):`MODE_CHANGED` → `setMode('explore')`(composer 出现探索 badge,follow-up 自然带
  mode:'explore',经 session.explore 续 trace);WriteConfirmCard 对 `tool==='enter_explore_mode'` 走专用文案
  (「🔍 进入探索模式?」+ reason + 一句说明,无写操作恐吓、无 args JSON)。

**边界**:plan 模式的规划阶段不提供该工具(规划期不该切模式);同会话后续轮次因面板 badge 已切,直接原生 explore。
