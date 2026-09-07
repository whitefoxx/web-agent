# web-agent — working rules

## Language: English in the repo, Chinese in chat (standing rule)

**Everything written into this git repository is in English** — code, comments,
identifiers, `docs/*.md`, test names, commit messages, PR text, and the strings
shipped to users. New docs and new post-mortem sections are English even when the
surrounding file is still Chinese (legacy text is left alone; translate it only
when a task already touches it, never as a drive-by rewrite).

**Replies to the user are in Chinese** wherever it reads naturally. Keep code,
identifiers, paths, tool names, log lines, and quoted repo content verbatim — do
not translate them into Chinese inside an explanation.

## Always record findings & fixes into `docs/` (standing rule)

During any non-trivial investigation, fix, or audit, **summarize what you found
and what you changed into the relevant `docs/*.md` file as you go** — not only
after a bug, but for audits, design decisions, and "why it's this way" context.
This is the default mode of work here, every time.

- Bug fixes → append a numbered post-mortem subsection to the relevant doc
  (today that's `docs/adapter-hot-plug.md` §10.x) in the
  **Symptom / Root cause / Fix / Lesson** shape (the older sections use the
  Chinese 症状 / 根因 / 修法 / 教训 — same four beats), BEFORE committing the fix.
- Audits / sweeps → record the methodology, the bug-classes found, counts, and
  what was fixed vs. deferred, so the next pass starts from the map instead of
  re-deriving it.
- Link related sections; keep the running narrative so a cold reader can
  reconstruct the reasoning.

Rationale: this codebase's failures are cascading and environment-specific
(sandbox/userscript world, strip-and-inject eval, marketplace bundling). The
docs are the institutional memory that stops the same class of bug recurring.

## Marketplace adapters live in a separate public repo (git submodule)

The site adapters are NOT in this repo's bundle anymore — they live in the public
repo `whitefoxx/web-agent-marketplace`, mounted here as a **git submodule at
`marketplace/`** (for dev/tests/versioning) and served to the runtime over GitHub
raw (`MARKETPLACE_BASE_URL` in `src/core/marketplace.ts`); the build does NOT
bundle them. The extension keeps only the generic tools (`src/tools/generic/`).

`marketplace/<site>/<name>.js` is the authoritative source (hand-maintained, NOT
routinely regenerated). To change an adapter: edit it **inside the submodule**,
rotate that entry's `sha256` in the submodule's `index.json` in the same commit
(the install path enforces the hash), commit + push the submodule, then bump the
submodule pointer here. The runtime fetches remote `main`, so a pushed adapter
ships without an extension release. See `docs/adapter-hot-plug.md`.

## The bridge daemon + agent skills live in `web-tools`

The WS bridge daemon a CLI agent talks to, and the skills that teach it to drive
this extension, live in the public `web-tools` repo — the same submodule that
holds the base: `web-tools/bridge/server.mjs` (run it with
`BRIDGE_PORT=8787 npx -y github:whitefoxx/web-tools`) and
`web-tools/skills/web-agent/SKILL.md` (users install every shell's skills with
`npx skills add whitefoxx/web-tools -g`). One daemon serves all three shells;
the port is the only difference (8787 here, 9376 WebCLI, 9378 a localmd Connect
dev build). To change the daemon or this shell's skill: edit inside
`web-tools/`, commit + push there, then bump the submodule pointer here. The
former `web-agent-skills` repo (its own daemon, with an MCP-stdio mode and
`/guide`) was retired 2026-09-07; bringing MCP-stdio + `/guide` into
`web-tools`' daemon is a follow-up. See `docs/external-agent-control.md` §7.

## One core, three shells — the base lives in the `web-tools` submodule

> **The system-level architecture (four repos, the shared primitive base, how
> the split is drawn) is `docs/architecture.md` §A.** As of 2026-09-07 the
> split is PHYSICAL (§A.9): the shared base — the generic browser tools +
> `eval_js` + the recon primitives + site scripts + the lean shells themselves —
> is the public repo `whitefoxx/web-tools`, mounted here as a **git submodule at
> `web-tools/`**. Adapters are becoming skills; the marketplace is being retired.
> This section is the current build mechanics.

This repo builds **one** extension — the full "Web Agent" (`manifest.json` →
`dist/`, `npm run build`): agent + adapters + SidePanel + marketplace + explore.
Everything it shares with the two agent-free shells comes from the submodule
through the **`@base/*` alias** (`web-tools/src/*` — the vite alias, tsconfig
`paths` and vitest alias are three copies of one mapping; keep them in sync).
**WebCLI** and **localmd Connect** are built, tested and released FROM
`web-tools`, not from here.

What is where:

- **`web-tools/src/`** — `core/` (generic executor, the explore-gate seam, the
  transport factories, the marketplace catalog client), `tools/generic/` (the
  generic tools — `_generic.ts` registers the shared set, `_localmd.ts` the
  Connect additions), `tools/{manifest,command-types}`,
  `runtime/{registry,errors,page,log}`, `site-scripts/`, `selection/`,
  `capture/`, the two lean service workers + `background/{runtime-state,
  agent-window,controlled-tabs}`, `webcli/`, `localmd-connect/`. Also the two
  lean manifests, icons, store copy, the shell docs (`web-tools/docs/webcli.md`,
  `localmd-connect.md`, the `*-releases.md` checklists), 52 base tests, and the
  `webcli-bridge` submodule (WebCLI's daemon + skills, `whitefoxx/web-tools-skills`).
- **`src/` here — full-only**: `agent/`, `sidepanel/`, `explore/`, `adapters/`,
  `userscript/`, `schedules/`, `shortcuts/`, `config/`, `sandbox/`, `offscreen/`,
  `messages.ts`, the full `background/` drivers + `service-worker.ts`,
  `tools/explore/`, `tools/dispatcher.ts` + the tab-pool files, the five
  full-only generic tools (`_all.ts`, `find-adapters`, `get-highlights`,
  `load-adapter`, `read-more`), `runtime/opencli/` + `network-recorder`.
  `src/build-flags.d.ts` is a deliberate duplicate of the base's (ambient d.ts).

The three shells, for orientation (details and identities live in `web-tools`):

- **Full extension** — this repo: `manifest.json` → `dist/`, `npm run build`.
  Agent + adapters + SidePanel + marketplace + explore. Not yet released.
- **WebCLI** — `web-tools`: `manifest.webcli.json` → `dist-webcli/`,
  `pnpm run build:webcli`. Headless, **agent-free**; exposes the primitive base
  to CLI agents over the WS daemon (`web-tools/webcli-bridge/`). Store id
  `jnhfdhpafndcbppkphhfpecflhogngge`; `--mode webcli-dev` swaps in the dev
  identity + port 9377 so a dev build coexists with the store copy. See
  `web-tools/docs/webcli.md`.
- **localmd Connect** — `web-tools`: `manifest.localmd.json` → `dist-localmd/`,
  `pnpm run build:localmd`. The paid companion for localmd.app: the base + site
  scripts (the confirm step is DELEGATED to localmd's UI by contract) + the
  knowledge-base capture tools (clip_page, the capture inbox, the in-page bar
  with user-defined prompts answered by localmd's model over MCP sampling) + the
  browser's own data behind OPTIONAL permissions. **Live since 2026-08-12 as
  `bgennbocoapjiiolmmlcbfingimhmchh`**. The shipping build's only way in is a
  page on `https://localmd.app`; the WS daemon (9378) exists only in
  `--mode localmd-dev`, so a dev build is NOT a valid smoke test of the upload
  artifact. Site adapters were retired from this shell 2026-09-06 — reaching a
  site is a skill the agent builds from the primitives, not a shipped catalog
  (`web-tools/docs/localmd-connect.md` §15; the localmd-side contract is §12 +
  `localmd-connect-handoff.md` there).

Rules for keeping the split clean:

- **Base code is edited INSIDE `web-tools/`**, committed + pushed there, then
  the submodule pointer bumped here — exactly like an adapter (`marketplace/`)
  or a bridge skill (`bridge/`). The old paths (`src/core/…`,
  `src/tools/generic/…`) are gone from this repo; if a change needs both sides,
  land the base half first.
- **Nothing in the base may import the full shell** (agent / sidepanel /
  explore / adapters / userscript / schedules / shortcuts / config). `web-tools`
  cannot see this repo at all, so a base file that needs one of those is in the
  wrong repo. The recon tools reach an explore session only through
  `@base/core/explore-gate` (null in the lean shells → `tab_id` required); the
  full SW wires the real getter at boot, and the keep-alive learns "a session is
  running" through `setActiveSessionProbe` the same way.
- **A shared tool description is read by every shell that registers it** — no
  full-shell promises (auto-reaped tabs, "at the end of this task", an Explore
  tab to fall back on), no naming a tool the lean shells don't register.
  Lifecycle promises go in this shell's system prompt, not in the tool. Pinned
  by `web-tools/tests/webcli-tool-surface.test.ts` +
  `localmd-tool-surface.test.ts` (run them in `web-tools`). Shell-specific
  wording → re-register in a shell-only file (registry `cli()` is
  last-write-wins on (site, name)).
- **Full-only tools register via `src/tools/generic/_all.ts` only**
  (find_adapters / load_adapter / get_highlights / read_more); the explore-bound
  tools (list_network / read_network / list_trace / find_in_network /
  capture_submission) live in `src/tools/explore/`.
- **Releasing WebCLI / localmd Connect happens in `web-tools`** — its
  `docs/webcli-releases.md` / `docs/localmd-connect-releases.md` (bump → sweep
  `store/<shell>/` → build → `pack:<shell>` → upload; mark PUBLISHED **only**
  after the CRX download confirms it). The dev-identity keys
  `extension-key-{webcli,localmd}.pem` are gitignored in both repos.
- **Tests**: `npm test` here is the full shell's suite (plus the three
  adapter-compat tests that read the base's registry/errors shims through the
  submodule). A change to a base file is tested in `web-tools`.
  `tests/local-tools.test.ts` is split across the repos on purpose — each side
  asserts that its own executor honours `local`.
- Keep the three `@base` mappings in sync (`vite.config.ts` alias,
  `tsconfig.json` `paths`, `vitest.config.ts` alias). The opencli `registry` /
  `errors` shims resolve into the submodule; the `utils` / `logger` / `types` /
  `pipeline` shims stay here (adapter machinery, `src/runtime/opencli/`).

## Systematic test docs (`docs/tests/`)

Real-browser / real-login end-to-end testing of every adapter + tool + feature
lives in `docs/tests/` — a LIVING doc set covering what unit tests (`tests/`) can't:

- `README.md` — the plan: purpose, methodology (drive via the bridge `/command`),
  tiers (A public / B auth-read / C write), status legend, and the **write-op
  caution policy** (writes have real side effects — opt-in, dry-run, never batch).
- `adapters.md` — one checkbox row per marketplace adapter (generated from
  `marketplace/index.json`), grouped by site.
- `platform.md` — generic tools + bridge synthetic tools + platform features.
- `tasks.md` — **E2E task tests**, the layer above adapter unit-style checks: given
  a real task (run via the SidePanel), verify the agent's plan, tool selection,
  serial/parallel orchestration, error recovery, result quality, and tab hygiene.
  Same tick-as-you-go + findings flow; the writes tier is opt-in like Tier C.
- `findings.md` — rolling 症状/根因/修法/教训 log + lessons.

How to maintain it (every time you run real-machine tests):

- **Tick as you go**: after testing an adapter/tool, fill its **结果** column in
  adapters.md / platform.md (✅ pass / ❌ fail / 🔒 blocked-needs-login / ⏭️ skip)
  with a one-line conclusion, and update the **Progress** counts atop adapters.md.
- **Log failures**: every ❌ gets an `F-N` entry in findings.md (症状/根因/修法/教训).
  If it's an adapter source bug, fix via the marketplace-submodule flow (edit
  source → rotate `index.json` sha256 → push submodule → bump pointer) and ALSO
  leave the post-mortem in `docs/adapter-hot-plug.md` §10.x (the long-term home for
  adapter bugs); cross-link from findings.md.
- **Regenerate on adapter add/remove**: when the marketplace gains/loses adapters,
  regenerate adapters.md's checklist from `marketplace/index.json` (read it → emit
  one row per adapter, grouped by site), then **merge the old 结果 column back in**
  (diff before overwriting — don't lose recorded results).
- Treat these as the **source of truth** for "what's verified on a real browser" —
  extend them rather than starting an ad-hoc list.

### 本地测试夹具(`docs/tests/fixtures/`)

公共站点不合适时——**找不到含某结构的页**(如内层滚动容器)、**点击有副作用**(导航 / 发帖)、想要
**确定性**——就**自己造页**:在 `docs/tests/fixtures/` 放静态 HTML,起本地静态服务器,经 bridge
`open_url http://localhost:PORT/…` 用真工具(`get_interactives` / `click` / `type_into` / `scroll_page` …)测。

- **起服务**(本地、无外部下载,绕开 npx-下载被拦):
  `python3 -m http.server 8123 --directory docs/tests/fixtures`(后台跑)。`file://` 被
  `isContentScriptAllowed` 挡,所以**必须**起服务器——扩展只能注入 `localhost http`。
- **夹具设计约定**:把交互效果写进**可读** DOM(如 `interactive.html` 的 `#status` → `mousedown:md`),
  让真机测能端到端断言「操作 → 效果 → 读工具读回确认」,而不只是 `found:true`。
- 现有:`interactive.html`(原生控件 + 自定义可点 ① + contenteditable ②b + 遮挡 modal H10-P1)、
  `scroll.html`(高页 ⑤ + 内层 overflow 容器 ⑤b)。新增夹具在 `fixtures/README.md` 登记一行,保持可观测约定。
- ⚠️ `scroll_page` 等要覆盖**后台 tab**(`open_url active:false`)——agent 常态;只测 active 漏坑(见 F-27)。

## Commit / push

Follow the global rule: do not commit or push automatically; ask first, except
when the user says "commit"/"push" for that turn.
