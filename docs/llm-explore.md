# LLM Explore → Synthesize → Replay

Status: **in progress** (branch `feat/llm-explore`). P1 + P2a (explore engine)
landed; P2b (UI/agent wiring) + P3+ pending.

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

| opencli                                              | webchat-agent (existing)                                                                                                             | gap                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| `opencli browser *` primitives                       | `src/tools/generic/*` (open-url, click, type-into, scroll, get-interactives, get-page-text, screenshot) — all registered via `cli()` | add `list_network`, `get_html`                      |
| page fetch/XHR shim → `window.__opencli_explore_net` | `PageShim.captureNetwork()` (CDP `Network` domain) — protocol-level, sees real auth headers                                          | currently single-match; need session-long buffering |
| trace artifacts (`trace.jsonl`, `network.jsonl`, …)  | —                                                                                                                                    | new IndexedDB DB `webchat-agent-traces`             |
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
- `trace-store.ts` — IndexedDB `webchat-agent-traces` (own DB; traces are large/independent and must not bloat or lock the sessions+adapters DB). Node-safe no-op like `installed-store.ts`.
- `recorder.ts` — `Recorder`: buffers the streams, truncates bodies, flushes incrementally to the store, `finalize(status)`. Store access is injected (`sinks`) so it unit-tests with no IDB.
- `synthesize.ts` (P3) — synthesis system prompt (internalizes opencli `opencli-adapter-author`: strategy selection, typed errors, column conventions) + one `chatCompletion`.
- `verify.ts` (P4) — run synthesized adapter, diff against trace.
- `session.ts` (P2) — explore session lifecycle (start/stop/active), tab ownership.

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
   `webchat-agent-mv3-sw-keepalive`). Recording rides the existing agent run
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
- **P2b — UI / agent wiring** (next): SW `EXPLORE_START/STOP` + `TRACE_UPDATE`
  messages, api-engine explore mode (start recording, expose explore primitives,
  navigation→state snapshots, trigger synthesis at end), side-panel Explore mode
  toggle + trace viewer + trace export.
- **P3 — synthesis (fetch class)**: PUBLIC/COOKIE/INTERCEPT → pipeline.
- **P4 — verify + bounded repair + install**: end-to-end.
- **P5 — func/DOM-scrape synthesis** (Phase B).
- **P6 — refresh/re-explore + opencli trace/adapter interop** (aligns with goal 2).

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
