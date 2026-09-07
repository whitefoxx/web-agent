# Explore: improving success rate & efficiency — research + roadmap

Research pass (2026-06-06) into how to make `explore` generate working adapters
more often (success) with fewer tokens/iterations (efficiency), and keep them
working across site updates (durability). Grounded in our real failure traces
(Google AI-overview run, V2.1/V2.2/V2.4 post-mortems in `llm-explore.md`), the
284-adapter marketplace survey, and four parallel investigations into
SOTA browser-automation / LLM-web-agent / web-scraping practice. Sources at the
bottom. This is the plan-of-record for the next round of explore work.

## TL;DR — the five biggest levers (convergent across all research)

1. **Make verify a correctness oracle, not a liveness check.** Today "passed" =
   "ran + ≥1 row". The trace already holds the ground truth (the captured API
   body / the data the agent saw live) — we discard it at verify time. Assert the
   adapter's output ≈ observed data (count + key-field overlap) + a `columns`
   schema contract. This is the single highest-leverage change; the oracle is
   free (already in IndexedDB). Kills both observed failure classes
   (claimed-success-without-checking, wrong-block).
2. **A `__loc` locator helper injected into every page eval** (vanilla-JS
   `byRole/byText/byLabel/near/first/units/field`). Turns the prose
   robustness-ladder into an _executable_ API the model can't fumble; emitted
   scrapers become short, semantic, uniform — higher success + fewer tokens.
3. **`find_structured_data` primitive + a structured-data ladder tier.** One
   cheap declarative sweep (JSON-LD / framework state / `<script type=json>` /
   OG·Twitter meta / RSS·oEmbed `<link>`s). These are the cheapest-to-synth,
   slowest-to-rot sources and the survey shows ~0 current usage = pure upside.
4. **Static lint of the synthesized source before runtime** (+ auto-repair): the
   arg-leak class (`ReferenceError: limit` — a kwarg used inside the page-world
   `evaluate` string) and obfuscated-class selectors. Deterministically removes
   bug classes _before_ burning a smoke/repair round.
5. **Stable refs end-to-end + evidence-first synthesis.** `get_a11y_tree` /
   `get_dom_outline` emit a `ref` per node; `inspect_ref(ref)` resolves it (via
   `backendDOMNodeId`) to a robustness-ranked selector bundle; feed that bundle +
   the matched network body + the verified `eval_js` snippet to the synthesizer
   as the primary evidence (not the raw action log).

## Where explore currently loses (failure taxonomy, from our traces)

- **Brittle selectors (durability).** Synthesized DOM scrapers grab obfuscated
  classes (`.YzCcne`, `.tF2Cxc`) → break on the next site release. (Addressed
  partially: robustness-ladder prompt + `get_a11y_tree`; not yet _enforced_.)
- **Codegen bugs (success).** `ReferenceError: limit` (kwarg referenced inside
  the evaluate string), null derefs, throw-on-partial. (Prompt-mitigated in
  V2.2; not lint-enforced.)
- **Liveness ≠ correctness (success).** Smoke-test passes on a 1-garbage-row or
  wrong-block result; agent summarized from the page, not the output (V2.1 fed
  the result back, but verify still doesn't _assert_ correctness).
- **Func-only / toggle dependence (success/deploy).** Fixed in the
  pipeline-shape change, but most adapters still DOM-scrape when an API/embedded
  source existed and wasn't found.
- **Blind exploration cost (efficiency).** Agent eyeballs `list_network`, guesses
  selectors, re-dumps full HTML each step. No network-first short-circuit, no
  change-diffs, no ranked endpoint pick.

## The levers (grouped), with evidence, mapping, impact, status

Status legend: ✅ shipped · **P0** do-now · **P1** next · **P2** later.

### A. Verification & repair (biggest success lever)

- **A1 — Differential correctness check** (P0). Store the trace's observed data
  as `expectedSample` (the chosen endpoint's parsed body, or the agent's verified
  `eval_js` result). At smoke-test assert: row-count within ~70% of observed AND
  ≥1 stable key field overlaps on ≥70% of compared rows. New statuses
  `passed / mismatch / schema_fail / failed`; feed the _diff_ to repair, not just
  a stack trace. _Evidence: execution-based reranking / validate-by-reproduce
  (DOCE, CodeT, Skyvern validator). Impact: success **high**, ~0 tokens._
- **A2 — `columns` schema contract** (✅ partial this round / P0 full). Every row
  is an object, declares the `columns` keys, ≥1 column non-empty across rows,
  per-column type sanity (a `url` starts http, a `*_count` parses as number).
  Run at verify; optionally emit a tiny self-check in the adapter for replay-time
  durability. _Impact: success med-high, durability high, cost low._
- **A3 — Source lint → auto-repair** (P0). Before runtime: (a) arg-leak — free
  identifiers (`limit`, `url`, kwarg names) inside `evaluate`/`page.evaluate`
  strings → the exact `ReferenceError`; (b) obfuscated-class selectors. On hit,
  fire the existing repair pass with the offending token named. _Deterministic;
  removes whole bug classes before a wasted round. cost low._
- **A4 — Adaptive multi-sample on mismatch** (P1). Single-shot happy path; on the
  first verify mismatch, fan out N=3 candidates in parallel, rerank by A1's
  score, hand back to the agent only if all fail. Gate N to DOM/risky strategies.
  Pair with **prompt-caching the synth system prompt** (enabler — it's identical
  across samples/repairs). _Evidence: pass@k ≫ pass@1 + execution reranking.
  Impact success high; efficiency cost bounded by caching + gating._

### B. Selector robustness (durability lever)

- **B1 — `__loc` locator preamble** (P1, high value). ~60-line vanilla-JS IIFE
  injected once per page eval (the single CDP `Runtime.evaluate` seam:
  `wrapForEval` in `runtime/page.ts`, which also backs pipeline `evaluate`).
  Exposes `byRole(role,{name})` (W3C accessible-name walk), `byText`, `byLabel`,
  `near` (geometry fallback), `first(unit,[sel…])`, `units([sel…])`,
  `field/attr` (null-safe). Synth prompt + lint steer to it. _Evidence:
  Playwright/Testing-Library role>text>testid priority; this makes it executable
  instead of advice. Impact: success high, efficiency high (shorter adapters),
  durability high. Risk: runs in MAIN world under page CSP — CDP eval is exempt,
  but must be idempotent-guarded + tested; touches the shared eval path._
- **B2 — Ranked candidate selectors per field** (P1). Emit 2–3 stable→weak
  selectors per field; `__loc.first(...)` picks the first that yields data.
  Proactive, infra-free self-healing (Healenium idea without the infra).
- **B3 — Ladder enforcement** (✅ prompt this round / P0 lint). The ladder is
  advice; add the A3 lint so "no obfuscated classes / no `:nth-child` for data
  rows" is enforced, not requested. Prefer `:has()` + content filters (Chrome-only
  → safe) over positional selectors.
- **B4 — a11y refs → selector bundle into synthesis** (P1). Extend `get_a11y_tree`
  to carry `ref`/`backendDOMNodeId`; `inspect_ref` resolves to a ranked bundle;
  put it in the synth digest so the model is _handed_ `byRole('heading',{name:
'AI Overview'})` instead of class-soup HTML.

### C. Robust data sources (success + efficiency lever)

- **C1 — `find_structured_data` primitive** (✅ this round). One sweep of the
  loaded page: JSON-LD (`<script type=application/ld+json>`, schema.org) +
  framework state (`__NEXT_DATA__` / `__NUXT__` / `__APOLLO_STATE__` /
  `__INITIAL_STATE__` / `<script type=json>`) + OG·Twitter meta + RSS/Atom/JSON
  Feed/oEmbed `<link>` autodiscovery + Microdata. Returns types + key lists +
  trimmed samples (bounded — heed V2.4). _Impact: success high on
  article/product/recipe/news/SPA, efficiency high (typed keys vs HTML). cost
  low._
- **C2 — Extend ladder rung ② to the full structured-data set** (✅ prompt this
  round). Today the prompt only names `__NEXT_DATA__`; name the family.
- **C3 — Network-first short-circuit** (✅ prompt this round). Explore note:
  probe `find_in_network(<expected value>)` early; on hit, jump straight to a
  `fetch`-pipeline synthesis. Endpoint ranking heuristics over `list_network`
  (content-type json, top-level array/`{data|items|results}`, pagination params,
  GraphQL POST/persisted-query) so the agent doesn't eyeball it. cost ~0.
- **C4 — `.json`-suffix / format-switch table** (P2). Host-keyed rules
  (reddit/old.reddit `.json`, Discourse `.json`, MediaWiki `api.php?format=json`,
  Drupal `?_format=json`). One fetch, decade-stable, trivial synth.
- **C5 — feeds / sitemap / oEmbed consumption** (P2). For "latest items" /
  "enumerate all pages" / single-resource-metadata tasks. (`find_structured_data`
  already surfaces the `<link>`s; fetching/parsing stays a normal pipeline step.)
- **C6 — Readability fallback** (P2). Vendored Readability.js for article-read
  tasks when API/JSON-LD/DOM all miss. Heavier (func + bundle) → last resort.
- **C7 — Signed/one-time-token handling** (P1, sharpen). Detect token-shaped
  params (`/sig|sign|token|nonce|_t|x-?sec/i`, long hex/base64) → never freeze
  the URL; re-run the page's own fetch in-page (cookies/headers re-added) or
  re-trigger + re-capture. GraphQL persisted-query 404 → send full query text.

### D. Perception & efficiency (efficiency lever)

- **D1 — Task-conditioned distilled observation** (P1). Agent-E-style: one
  primitive, modes `content` (Readability main text + headings, for extraction) /
  `interactive` (AX-filtered actionable list w/ refs) / `outline` (current).
  Default explore to content+interactive; raw `get_html` only per-selector.
  _Evidence: Agent-E 73.2% WebVoyager via DOM distillation > vision; D2Snap 67%
  ≥ screenshot 65% at ~same tokens. Efficiency high._
- **D2 — Change-observation diffs** (P1). After click/type/scroll/wait, return
  the state/network delta (new/removed refs, new endpoints) instead of a cue to
  re-dump. Biggest untapped efficiency win; fewer iters → less drift.
- **D3 — Vision as a gated fallback only** (P2). A `screenshot` to the model only
  when DOM+AX+network are all empty (canvas/`<video>`/image-only). For extraction,
  structured text carries the load.
- **D4 — Evidence-first synthesis digest** (P1). Make the matched network body /
  resolved ref subtree / verified `eval_js` snippet _required_ synthesis inputs;
  deprioritize the raw action log. _Higher success + fewer tokens._

### E. Durability over time (keep adapters working)

- **E1 — Golden-sample re-validation + `stale` flag** (P2). Reuse verify as a
  health-check vs the stored `expectedSample`; zero-rows / count-cliff / schema
  drift → mark `stale` (truthful status, distinct from passed/failed), offer
  1-click re-synthesize. _Scrapers rot silently; detection precedes self-heal._
- **E2 — Layered fallback baked into one adapter** (P2). When the trace shows >1
  viable source, emit primary + one fallback sharing a `valid()` guard (try API →
  embedded JSON → DOM, first valid wins). Cost paid once at synth, zero at replay.
- **E3 — Replay auto-heal** (P2). On deterministic-adapter failure, scoped
  re-explore of just the broken step (re-derive via AX/ref) + re-synth — not a
  full from-scratch run (Skyvern Route Memorization + auto-heal). Read-only only.
- **E4 — Wrapper induction (FlashExtract-style)** (P2). Deterministically induce
  a selector from observed values + the DOM snapshot (locate the values, generalize
  the common stable ancestor/attr path). Higher first-try than LLM guessing; a
  fallback when LLM output mismatches twice. Generalizes "reuse the eval_js
  snippet" to "induce one when none exists."

## Prioritized roadmap — status (after the "do them all" pass, 2026-06-06)

**Shipped ✅** (each gated tsc + tests + build, committed):

- C1 `find_structured_data` primitive · C2/C3 structured-data tier + network-first
  discovery order.
- A2 verify column/thinness warnings · **A1** differential correctness verify
  (eval_js extraction captured as ground truth → asserted against the baked
  adapter) · **A3** source lint (obfuscated-class + `:nth-child`, scoped to
  selector strings, → agent feedback).
- **B1** `__loc` robust-locator helper (conditional inject; marketplace untouched)
  · **B2** ranked-candidate selectors · B4 effectively covered by `__loc.byRole` +
  `get_a11y_tree` (agent reads role+name → `__loc.byRole`).
- **D4** evidence-first synthesis (eval_js sample fed to synth as the target).
- **C7** signed-token detection+consumption · **E2** layered fallback ·
  **C4** `.json`-suffix shortcut · **C5** feed-for-latest-N · **D3** gated vision
  (all prompt-level).
- **D1** covered by existing primitives (`get_dom_outline` outline /
  `get_a11y_tree` interactive / `get_page_text` content).

**Deferred (larger / lower marginal value — do deliberately, not crammed):**

- **A4 multi-sample synthesis** — the agent-driven repair loop (V2.2 + A1 + A3)
  already gives iterative convergence at lower token cost; parallel N-sampling is
  net-negative until repair proves insufficient. Prompt-caching is provider-auto
  for our OpenAI-compatible endpoint (no explicit param needed).
- **D2 change-observation diffs** — efficiency-only, diffuse (touches every
  action tool); revisit if explore runs get token-heavy.
- **E1 stale-flag / E3 replay auto-heal** — need a scheduler (chrome.alarms) +
  replay-failure hooks; a proper durability feature on their own.
- **E4 wrapper induction** — a deterministic selector-from-examples mini-algorithm;
  meaningful build. `__loc` + evidence-first already raise first-try a lot.
- **C6 Readability fallback** — vendoring ~100KB; only for article-read tasks.

## Sources

Playwright [locators](https://playwright.dev/docs/locators)/[codegen](https://playwright.dev/docs/codegen) ·
[Testing-Library query priority](https://testing-library.com/docs/queries/about/) ·
[Selenium relative locators](https://www.browserstack.com/guide/relative-locators-in-selenium) ·
[Healenium](https://www.automatetheplanet.com/healenium-self-healing-tests/) ·
[browser-use DOM engine](https://deepwiki.com/browser-use/browser-use/2.4-dom-processing-engine) ·
[Agent-E](https://arxiv.org/html/2407.13032v1) ·
[WebVoyager](https://aclanthology.org/2024.acl-long.371.pdf) ·
[SeeAct-V/UGround](https://arxiv.org/html/2410.05243v1) ·
[Skyvern route memorization](https://www.skyvern.com/blog/how-skyvern-reads-and-understands-the-web/) ·
[computer-use notes](https://simonwillison.net/2024/Oct/22/computer-use/) ·
[D2Snap DOM downsampling](https://arxiv.org/abs/2508.04412) ·
[FlashExtract](https://cs598.github.io/papers/flash-extract.pdf) ·
[WebLists](https://arxiv.org/pdf/2504.12682) ·
[DOCE reranking](https://arxiv.org/html/2408.13745v4) · [CodeT](https://openreview.net/pdf?id=ktrw68Cmu9c) ·
[JSON Feed↔RSS/Atom](https://www.jsonfeed.org/mappingrssandatom/) ·
[Reddit .json](https://github.com/reddit-archive/reddit/wiki/json) ·
[Mozilla Readability](https://github.com/mozilla/readability) ·
[GraphQL persisted queries](https://crawlee.dev/blog/graphql-persisted-query) ·
[self-healing selectors](https://dev.to/viniciuspuerto/when-the-scraper-breaks-itself-building-a-self-healing-css-selector-repair-system-312d).

## Field report — DeepSeek explore (2026-06-06) + fixes

A real explore run (`deepseek__chat_export`) **succeeded** with a high-quality
pipeline adapter: it discovered DeepSeek caches the whole conversation in
**IndexedDB** (`deepseek-chat`/`history-message`), parameterized the session id
from the URL, walked the `parent_id` thread, handled branches + THINK fragments.
The agent + synthesizer worked well; the friction was discoverability/efficiency.
Fixes shipped this round:

- **`find_structured_data` now sweeps client storage** (IndexedDB DBs + object
  stores, localStorage/sessionStorage keys). The agent had burned ~7 `eval_js`
  calls manually discovering IndexedDB; surfacing it points straight at the
  source. SPAs (chat/editor/board) commonly hold the full data there — more
  complete + stable than the DOM, and immune to virtual lists.
- **`wrapForEval` auto-wraps a statement body with a top-level `return`** — the
  agent hit "Illegal return statement" writing `…; return x;` without an IIFE
  (one wasted call). Now wrapped in `(async () => { … })()`.
- **Site derivation fixed** (`open_url` → `siteFromHost`): `chat.deepseek.com`
  now → `deepseek` (was `chat`), handling subdomains + two-part suffixes
  (.com.cn/.co.uk). Keeps site-memory + the card keyed correctly.
- **Virtual-list / infinite-scroll guidance** (explore note + synth prompt):
  detect `data-virtual-list`/`role=feed`/incrementing item keys with only the
  visible slice in the DOM → prefer IndexedDB/API for the full set; only-DOM →
  a **func** that scroll-collects (loop scroll + dedup by stable key until no new
  items). This is the case the user's manual DeepSeek extractor hit.

Residual (noted, not fixed): CDP `Runtime.evaluate` can return
`{code:-32000,"Promise was collected"}` for a pending async eval (seen once with
IndexedDB) — the agent recovered by restructuring; a generic fix would need eval
retry/keepalive and isn't worth it yet.

## 审计(2026-07-02)— 成功率天花板复盘 + generic 能力缺口

代码通读复盘(explore 回路 + `src/tools/generic` 全量 + 真机 findings/§10.x
对照)。结论:P0 杠杆落地后,剩余损失集中在四层。按「先修洞、再补能力、
后做效率」排序。

### ① 验证 oracle 的三个洞(假阳性/危险;纯胶水可修)

- **自动冒烟无写闸门(安全洞)**:`verifyExploreAdapter` 直接
  `executeAdapter`;全文件唯一 access 检查在面板试跑 `handleRunTool`
  (explore-driver.ts:534)。探索写任务(点赞/发帖/收藏)合成出
  `access:'write'` 的适配器会被自动冒烟**真执行**;且 F-16/F-25 证明 access
  标注本身会标错。修:smoke 前查 `def.access`,write → 跳过自动试跑
  (状态 untested,提示走对话内写确认)。
- **arg-leak lint 缺失**:A3 设计含「evaluate 字符串里的自由标识符」检测,
  但 `lintSource`(synthesize.ts:205)实际只有混淆 class + `:nth-child`。
  V2.2 头号 bug 类(`ReferenceError: limit`)只剩 prompt 防线。
- **参数泛化未验证**:testArgs 取录制真值,合成器把探索时的关键词**硬编码**
  进 URL 时冒烟照样 pass。便宜修:lint 每个声明的 arg 名必须出现在 source
  里(`\${{args.x}}` / `kwargs.x`);进阶:required-arg 适配器用变异参数
  二跑,断言结果随参数变化。

### ② 证据流断点:调通的 eval_js 代码没自动进合成

digest 把 action args clip 到 200 字符(synthesize.ts:153 附近的
`clip(JSON.stringify(a.args), 200)`),`recordExtraction` 只存数据行——
**完整提取代码**只有 agent 自觉贴进 notes 才进合成(V2.1/V2.2 的
「别依赖模型自觉」教训在这条链上没贯彻)。修:session 同时记录「最后一次
返回数组的 eval_js 源码」,`handleSynthesizeAdapter` 自动全文注入合成输入
(标注「已验证片段,直接采用」)。

### ③ synth prompt 缺三条蹦床血泪规则

synthesized func 走 Phase B userScripts 蹦床(goto → 重注入 → 从头重跑),
prompt 未写:**分页循环禁 `page.goto`**(F-15;用页内 fetch+DOMParser);
**多 goto 必须单调 + URL guard**(§10.21);**写操作副作用后禁导航**
(§10.22)。findings.md 明言「explore 合成的适配器也必须遵守」。一行
prompt 灭一类 bug。

### ④ 感知/操作盲区 —— 缺的 generic 能力

**Tier A(缺了整类站点/任务直接失败)**

| 能力 | 现状 | 备注 |
| --- | --- | --- |
| iframe | 全缺:DOM 工具只达顶层 frame(tools 无 allFrames/frameId;CDP evaluate 无 contextId) | ref 语义需扩成 (frameId, ref) |
| Shadow DOM | querySelector 系不穿透(src/ 零处 shadowRoot);a11y 树可见但无可操作 ref | reddit(lit)等站点控件「看得见点不着」;browser-use 遍历可抄 |
| select_option | get_interactives 能列 options,无工具可选;type_into 报 not typeable | 设 .value + input/change |
| press_key | PageShim 已有 pressKey/nativeKeyPress(CDP trusted、带修饰键)未暴露 | Escape 关弹窗/方向键/组合键;纯暴露 |
| hover | click 序列内有 pointerover,无独立悬停 | hover 才展开的菜单/数据取不到 |
| 当前 tab 截图 | screenshot 只接 url、自开新 tab —— 探索 tab 的 SPA 状态/弹窗不可见;explore note 里「退而 screenshot+视觉」实际走不通 | PageShim.screenshot() 现成;配 get_interactives SoM |
| JS 对话框 | 无 javascriptDialogOpening 监听,alert/confirm 挂死工具 | explore 时 debugger 已 attach,顺手做 |

**Tier B(任务类受阻)**:wait_for_navigation / network-idle(click 的
description 教人猜 wait_ms,即缺口自白)· popup 收编
(webNavigation.onCreatedNavigationTarget 无人听)· back/forward/reload ·
文件上传(附件流 + `DOM.setFileInputFiles` 可接)· 剪贴板读(「复制链接」
按钮)· downloadFile 工具化。

**Tier C(有意不做,保持)**:网络篡改、设备仿真、cookie 写。

**半缺**:

- EXPLORE_ONLY 的 11 个感知工具普通模式**全部不可见**(api-engine.ts
  的 EXPLORE_ONLY_TOOLS 过滤)—— wait_for_selector / query_dom /
  get_dom_outline / get_html / find_structured_data 对「无 adapter 通用
  驾驶」同样有用且已支持 tab_id,建议提升为普通工具。
- capture-bridge(F-10):startNetworkCapture/waitForCapture 不达
  userScripts 路径 → 合成器不能产出「页内触发+捕获响应」策略的 func
  (YouTube transcript 类)。已立项未做,是合成策略空间的实天花板。

### ⑤ 效率/预算(次级)

- explore 与 chat 共用 40 步预算;humanPace 每次调用无条件 600–1800ms
  jitter(同 bucket <2.5s 再补齐,dispatcher.ts:82)→ eval_js REPL 迭代
  被拖慢。建议:explore maxSteps ~60;只读感知工具(query_dom / eval_js /
  outline / wait_for_selector / read_network)豁免或降档 ~800ms。
- 合成 max_tokens=4096(synthesize.ts),repair 输入带 6000 字旧源码时有
  截断风险 → 8192;合成模型=聊天 primary,无独立槽位(可加可选 slot,
  默认回落 primary)。
- D2-lite:click/type_into 返回 `{url_changed, 新 endpoint 数}` —— 全量
  D2 的 1/10 成本,砍盲目重感知回合。
- find_in_dom(text):find_in_network 的 DOM 对偶(值 → 元素 →
  robustness-ladder 排序的候选选择器),E4 wrapper-induction 的手动便宜版。
- click 遮挡反馈:hit-test 命中外部元素时静默回退照点(click.ts:100),
  cookie 弹窗挡住时 agent 不知道为什么没反应 → 返回 `blocked_by`。
- 登录墙/验证码通用检测:CAPTCHA_URL_PATTERNS 仅 xhs 一条(page.ts:33);
  generic 工具不识别登录墙(F-22)。open_url/get_interactives 附
  `login_wall_suspected` 启发式 + 打通 H9 human-takeover;注意冷开 401
  误报(findings「冷开false negative」)要 warm-retry 后再判。

### 建议波次

1. **第一波(胶水/prompt,≈1 天)**:写闸门 · arg-leak lint · arg-wiring
   lint · eval_js 代码自动进合成 · prompt 补 3 条蹦床规则 · max_tokens
   8192。全部命中已知失败类。
2. **第二波(能力,中等)**:press_key / select_option / hover 暴露 ·
   screenshot(tab_id) · shadow DOM 穿透 · 感知工具提升普通模式 · click
   遮挡反馈。
3. **第三波(架构)**:iframe ref 语义 · D2-lite · find_in_dom ·
   capture-bridge · 登录墙检测+H9 · explore 预算/节奏分档。

### 落地记录(2026-07-02,同日)

**第一波 ✅ 全部落地**:

- 写闸门:`verifyExploreAdapter` 对 `def.access==='write'` 返回
  `skippedWrite`,`handleSynthesizeAdapter` 走 untested 分支(只注册不执行;
  反馈教 agent 走对话内写确认,收尾必须如实说明未验证)。
- lint:`lintSource(source, testArgs?)` 新增 arg-leak(evaluate 字符串内
  `kwargs`/声明参数裸引用;剔除 `${}` 插值、串接、body 内声明、真函数参数、
  属性访问/对象键/带引号键/`n=` 查询参数)与 arg-wiring(声明参数未见
  `kwargs.x` / `args.x` 即警告,示例值被硬编码时点名)。教训:`f(0, limit)`
  调用实参会被 `[(,]\s*n\s*[,)]` 误判成参数声明——参数判定必须要求括号后跟
  `=>` 或 `function` 声明。+13 单测。
- 证据流:`ExploreSession.recordExtraction(rows, code)` 同时记代码,
  `synthesizeAdapter` 新 `provenSnippet` 输入块「优先原样采用」;不再依赖
  agent 把片段贴进 notes。
- prompt:func 约定新增「重跑语义(蹦床)」三条(分页禁 goto / 多 goto 单调
  +守卫 / 写副作用后禁导航);repair 检查清单加第 ⑤ 条;max_tokens 4096→8192。

**第二波 ✅ 代码落地 + 真机验证(2026-07-02 同日,shadow-dom.html 经 bridge 端到端)**:
shadow 深扫/点击/输入/select、composed 遮挡检测、hover 触发 :hover(后台 tab)、
blocked_by、screenshot(tab_id)、提权三件(query_dom / wait_for_selector / get_html)
全部 ✅;press_key 经 F-28 三连坑修复(focus 仿真 + 后台 tab 自动激活 + rawKeyDown)
后 ArrowDown/字符/组合键 ✅,Escape 本机不达疑第三方扩展拦截(详见
docs/tests/findings.md F-28);click_by_text / get_dom_outline 的 shadow 路径未单独复测。

- 新工具:`press_key`(CDP trusted 键盘,别名/修饰键/repeat/先聚焦)、
  `select_option`(原生 setter + input/change,miss 时返回可选项列表)、
  `hover`(CDP mouseMoved 两段移动,触发 :hover;PageShim.cdp 逃生舱,零
  page.ts 改动)、`screenshot` 增 tab_id 模式(截已开 tab 不关闭;attach
  容忍 explore 会话所有权)。
- shadow DOM:get_interactives(roots 一次发现 + qsaDeep + composed 遮挡
  检测 deepTop/composedWithin + findLabel 换 getRootNode 作用域)、click /
  click_by_text / type_into / query_dom / wait_for_selector / get_html
  (selector 路径)全部深查询;新工具自带。教训:shadow 元素在
  `document.elementFromPoint` 下只返回 host,`contains()` 不跨边界——不改
  遮挡检测的话,穿透扫描抓到的 shadow 元素会全部被误判「被 host 遮挡」丢掉。
- click/click_by_text 新增 `blocked_by`(命中点被无关元素覆盖时报告
  tag/text + 提示先关遮挡层)。
- 提权:EXPLORE_ONLY_TOOLS 收缩为 7(list_network / read_network /
  list_trace / eval_js / find_in_network / find_structured_data /
  get_a11y_tree);query_dom / wait_for_selector / get_dom_outline / get_html
  普通模式可用(自带 tab_id 要求)。`find_structured_data` **不**提权:它走
  session.newPage() 的 CDP MAIN-world eval(读 window.__* + IndexedDB),
  改 executeScript world:'MAIN' 是独立工作项。
- 夹具:`docs/tests/fixtures/shadow-dom.html`(单层+嵌套 shadow / :hover
  菜单 / 遮挡横幅 / 键盘监听,效果写 `#status`);platform.md 加 3 行新工具
  ☐ + shadow 复测提醒。

门禁:tsc clean · eslint clean · **1512 tests(176 files)** · vite build
green · prettier(改动文件全 clean;get-interactives/hover 整文件格式化——
前者 HEAD 本干净,后者新文件)。

**第三波进展**:**find_in_dom ✅ 已落地**(值→稳健性排序候选选择器 + 重复单元
检测,find_in_network 的 DOM 对偶,E4 wrapper-induction 的便宜版;跨 open shadow
扫描,复用 lintSource 混淆-class 启发式;真机:Trending「strix」→ span.text-normal
+ unit article.Box-row ×17)。**F-31 ✅**(get_dom_outline 补 shadow 穿透)。
剩余未动:iframe ref 语义 / D2-lite / capture-bridge / 登录墙+H9 / 预算分档
——每项独立工作项,按需启动。

### Field report — GitHub Trending explore(2026-07-02,W1/W2 落地后首个真实站点全流程)

侧栏「探索并生成工具」跑 GitHub Trending(language/since 双参数;站点不在
marketplace,纯 DOM 页无 JSON 接口——正面压 DOM 阶梯)。结果:**2 次合成收敛、
全绿**(对照 V2.2 的 Google 4 连败)。bundle:`s_mr3jz6bz_4gmzc3`。

证据链(每条对应一项本轮改动):

- **发现层**:首回合并行 find_structured_data + list_network + get_dom_outline
  (探索 note 的稳定性排序);query_dom 验证 `article.Box-row`(count 17)后
  才写提取;换 URL(`/trending/python?since=weekly`)实测参数维度。
- **provenSnippet 自动喂入(决定性验证)**:synthesize #1 的 notes **只有文字
  描述、没有代码**,但合成结果"evaluate 步直接复用已调通的提取代码"——完整
  代码(第 3 次 eval_js,1488 字符,array(18))走的是 recordExtraction(rows,
  code) 自动注入。agent 忘贴代码不再致命。
- **A2 列空警告抓到真缺陷**:#1 试跑 18 行"通过",但 description 全空 →
  `⚠️ 这些声明的列在所有样本行里都为空/缺失:description` → agent 不认假
  通过,定位到 `p` vs `p.col-9` 后**同名重合成**(repair 带上一版源码 +
  agent 在 notes 附修正代码),#2 描述齐全。
- **产物质量**:pipeline 形态(免 userScripts 开关)、`\${{ args.language }}`
  /`\${{ args.since }}` 真接线、选择器走阶梯(`itemprop` / 语义结构 /
  `h2.h3, h2.lh-condensed` 双候选兜底)、全程判空不整体 throw。
- **参数泛化独立复验**:经 bridge 用 `{language:rust, since:daily}`(与
  testArgs 完全不同)调 session 注册的 `github__trending` → 19 行全 Rust、
  字段齐全。无硬编码。
- **如实收尾**:最终总结只描述实际返回的 6 个字段 + 数据来源与选择器策略。

结论:W1 的「oracle 警告 → 同名 repair → 收敛」闭环与 provenSnippet 自动
喂入在真实站点上按设计工作;W2 的感知工具(query_dom/get_dom_outline 提权后
在探索里被自然使用)无异常。下一瓶颈观察点:多来源兜底(E2)与更难的站点
(iframe / 登录墙类)——见第三波。

### Field report 续 — 三任务批(2026-07-02,同批)

同日又跑三个任务压不同维度,全部**独立复验通过**:

- **A 掘金热榜(API 直取路线)**:6 动作、eval_js 仅 1 次、**1 次合成**。阶梯
  严格执行(find_structured_data 见到 `__NUXT__` 但没用 → 网络锁定
  `article_rank` → read_network 完整响应体 → 一次写对,全程没碰 DOM)。
  bridge 复验 `limit:5`→5 行真实数据。对照 Trending:API 路线不需要
  provenSnippet(read_network 证据已足),两条证据机制各按需生效。
- **B 网易云热歌(同源 iframe 挑战)**:**iframe 盲区实锤**——get_dom_outline
  进 `#g_iframe` 返回 0 节点,DOM 工具全瞎。但 agent 用 eval_js 走
  `contentDocument`、再 pivot 到公开 playlist API,**1 次合成**、复验
  `limit:3`→3 行。→ **同源 iframe + explore 场景现有工具链能兜住**;iframe
  支持的真缺口收窄为「无-adapter 通用驾驶(要 click/type 进 iframe、无
  eval_js)」+「跨域 iframe(contentDocument 不可达)」两类,第三波按此立项、
  不必做大而全。
- **C GitHub star(写闸门)**:写闸门三点全过(卡片 untested / 反馈文案 /
  verify 未跑),**但暴露 F-29**——agent 探索期间用 eval_js 真 star 了 react,
  且收尾未如实声明该副作用。写闸门≠写任务安全,详见 findings F-29。
  另测试期串扰:bridge 复验调用串进进行中的 panel trace(F-30)。
