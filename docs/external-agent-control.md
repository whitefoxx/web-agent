# T7 — External AI-agent control (Claude Code / Codex / Cursor)

Design doc for roadmap **T7** (`docs/roadmap.md`). Lets an external coding agent
drive the browser through this extension: the extension becomes a **browser-
control + adapter provider**, and the external agent replaces our in-browser LLM
loop. Two use cases on one transport:

- **T7a — agent _uses_ our tools/adapters.** Run installed adapters + generic
  primitives from the editor.
- **T7b — agent _drives exploration to author adapters_ (the headline lever).**
  Point Claude Code / Codex at our explore toolset (which they're far better at
  driving than the in-browser LLM, with file access + iterative code/verify) to
  synthesize higher-quality adapters, registered back into the extension.

Status: **implemented** (transport **A**, §3). `bridge/` ships the daemon (MCP over
stdio + HTTP for testing); the extension dials out (`src/background/bridge-client.ts`);
the **外部接入** page toggles it. Skills + an on-page onboarding guide shipped — §7.

A third inbound path — a **web app** (localmd.app) calling web-agent as an MCP tool
source over `externally_connectable`, delegating whole browse-tasks via one
`web_task` tool — is **§11**.

A fourth packaging — the SAME transports (WS + Port MCP) in a standalone,
**agent-free** extension exposing only the generic browser tools — is **WebCLI**:
[webcli.md](./webcli.md) ("one core, two shells"). The transport code was extracted
into `src/core/` (bridge-core / ws-bridge / external-mcp-core) so both this full
extension and WebCLI share one copy.

---

## 1. Constraint that shapes everything

An MV3 service worker **cannot** be a stdio server or accept inbound sockets. It
_can_ open an **outbound** WebSocket. So the extension cannot itself be the thing
an editor connects to — we need a **local bridge process** the extension dials
out to, and which the editor talks to. This is exactly opencli's shape.

## 2. Architecture (mirrors opencli's `src/daemon.ts`)

```
  ┌─────────────┐   MCP (stdio or HTTP/SSE)   ┌────────────┐   WebSocket    ┌──────────────────┐
  │ Claude Code │ ──────────────────────────▶ │   bridge   │ ◀───(out)───── │ extension SW     │
  │ Codex/Cursor│ ◀────────────────────────── │  (daemon)  │ ──────────────▶│ (WS client)      │
  └─────────────┘   tools/list, tools/call     └────────────┘   cmd / result  └──────────────────┘
        editor = MCP client            local Node process            our extension
```

- **editor ⇄ bridge:** MCP. `tools/list` returns our adapter catalog; `tools/call`
  runs one. (One MCP server works across Claude Code / Codex / Cursor.)
- **bridge ⇄ extension:** a small JSON-over-WS protocol (§4). The extension dials
  `ws://127.0.0.1:<port>` outbound (allowed in MV3), registers, then serves
  commands. Mirrors opencli: `editor → MCP → bridge → WS → extension → result`.

opencli reference (`~/code/browser-agent/opencli/src/daemon.ts`): HTTP `/ping`
`/status` `/command` + a WS the extension connects out to; on connect the
extension sends `{contextId}` to register; `/command` bodies are routed to the
extension's socket and the result returned. We copy this shape; the difference is
our front door is **MCP** (so any editor works) and our "adapters" live in the
extension, exposed as **tools with descriptions** (not local files).

## 3. Transport decision (OPEN — pick before coding)

- **(A) Self-built local daemon (MCP + WS) — recommended.** A small Node package
  in this repo (e.g. `bridge/`, shipped as an `npx` bin). MCP (stdio) to editors,
  WS server to the extension. Full control; mirrors opencli; cross-editor. We
  maintain it.
- **(B) Reuse/extend opencli's daemon.** Its daemon routes to opencli's _own_
  extension; we'd have to fork/adapt routing to reach ours, and couple to their
  release cadence. Not directly reusable.
- **(C) Native-messaging host.** Closer to stdio-MCP, but the host's lifecycle is
  tied to the browser and the editor→host path is awkward (native messaging is
  browser-initiated). Worse fit for "editor drives browser".

Recommendation: **(A)**. Everything below assumes (A).

## 4. Protocol (bridge ⇄ extension, JSON over WS)

Extension → bridge on connect:

```jsonc
{ "type": "register", "client": "web-agent", "version": "0.0.1" }
{ "type": "catalog",  "tools": [ /* openAiToolsFromRegistry() output */ ] }   // + re-sent on ADAPTERS_CHANGED
```

Bridge → extension (a tool call from the editor):

```jsonc
{ "type": "call", "id": "c1", "tool": "deepseek__chat_export", "args": { "url": "…" } }
```

Extension → bridge (result):

```jsonc
{ "type": "result", "id": "c1", "ok": true, "result": [ /* rows */ ] }
{ "type": "result", "id": "c1", "ok": false, "error": "…" }
```

Heartbeat: `{ "type": "ping" }` / `{ "type": "pong" }` (keep the SW alive while a
session is active — see `docs/adapter-hot-plug.md` keepalive notes).

**Reuse:** the catalog is `openAiToolsFromRegistry()` (`src/tools/manifest.ts`) —
OpenAI tool schemas map ~1:1 to MCP `inputSchema` (JSON Schema). Execution is the
existing `executeAdapter({tool,args})` via the dispatcher — the same path the
in-browser agent and the manual 运行 panel use. So the extension side is mostly a
**WS client that forwards `call` → executeAdapter → result**.

## 5. Tool surface

- **T7a:** all `read` tools + installed adapters. **Write** tools are gated (§6).
- **T7b:** the explore toolset — `open_url`, `get_a11y_tree`, `find_structured_data`,
  `eval_js`, `query_dom`, `list_network`/`read_network`, `get_dom_outline`,
  `wait_for_selector`, `synthesize_adapter`, the differential `verify`, plus
  explore session start/stop. The synthesized adapter is verified and registered
  back into the extension (reuses the explore install path). The bridge exposes
  these as MCP tools; a **skill** (§7) teaches the agent the workflow.

## 6. Security & permission model (must-haves)

- **Bind localhost only** (`127.0.0.1`), never `0.0.0.0`. **This is the boundary**
  ("runs on your machine").
- **Pairing token: dropped (P4 decision).** A token was implemented in P3 but
  removed at the user's call — for a local-only tool the extra friction wasn't
  worth it. (If we later expose beyond localhost or want defense against a
  malicious local page POSTing to `/command`, reinstate a token.)
- **Writes from an external agent.** An external brain with browser-write power is
  a real risk. Default: **route external write tool-calls through the same
  write-confirm the in-conversation agent uses** (a panel prompt the user
  approves), or a per-session "allow external writes" toggle (off by default).
  T7a-read and T7b-explore (read-only perception + synth) need no confirm.
- Surface an explicit **"external control: connected"** indicator + a kill switch
  in the SidePanel.

## 7. Distribution: public repo + skills + on-page guide (shipped)

The bridge **and** its skills live in a **public repo** —
[`whitefoxx/web-tools`](https://github.com/whitefoxx/web-tools) (the daemon + every shell's skills — it absorbed the former `web-agent-skills` repo on 2026-09-07) —
mirroring the `marketplace` pattern: mounted here as a **git submodule at `bridge/`**
(dev/source), distributed publicly for one-command install. Two drop-in skills in
`web-tools/skills/`:

- **`web-agent`** (umbrella) — **self-contained**: how to start the bridge
  (`BRIDGE_PORT=8787 npx -y github:whitefoxx/web-tools` or a clone), connect, and drive it
  over **plain HTTP/`curl`** (no MCP setup) — plus MCP as an opt-in, the tool surface,
  and common tasks. `tools/list` (or `/tools`) is the source of truth.
- **`web-adapter-author`** — the authoring loop (mirrors `opencli-adapter-author`),
  encoding the discipline in `src/explore/synthesize.ts`: the **strategy note**
  (`PUBLIC_API | COOKIE_API | PAGE_FETCH | INTERCEPT | DOM_STATE | UI_SELECTOR` ×
  `Contract: stable | visible-ui | internal-unstable`), discovery order
  (find_structured_data → network → DOM), the `__loc` helper, evidence-first
  synthesis + differential verify, "done = passes `verify` and is installed".

**Install (one command):** `npx skills add whitefoxx/web-tools -g` (the
[`vercel-labs/skills`](https://github.com/vercel-labs/skills) CLI; auto-detects
Claude Code / Cursor / Codex / …, reads `SKILL.md` under `skills/`). Or hand the repo
URL to the agent. The skill itself teaches the agent to start the bridge and `curl`
it — **no MCP server config required** (MCP is opt-in for native tool calls). The
**外部接入** page (`BridgeSection`) shows a **3-step** quick start (install skill →
启用 a port → ask your AI), deferring detail to "ask your AI".

**Tool surface (now):** beyond browser primitives + installed adapters +
`explore_start`/`explore_stop` (adapter authoring is fully agent-driven, incl.
`generic__install_adapter`), the bridge also exposes the **in-extension operations**
the user does in the UI, as synthetic tools handled in `bridge-client.ts` (not
registry adapters):

- **Workflows** — `create_workflow`, `list_workflows` (mirrors the agent's
  create_workflow: same step normalization, upsert-by-name).
- **Shortcuts** — `create_shortcut`, `list_shortcuts` (upsert-by-label).
- **Memory** — `save_memory`, `list_memories`, `delete_memory` (the `memory-store`).
- **Notes** — `notes` (one tool; `action: create|list|search|get|update|delete`).
  The markdown notebook (`notes-store.ts`); **NOT injected into context** (unlike
  memory) — read/written only on the user's explicit ask. create/update/delete
  respect the write gate (§6); list/search/get always allowed (`NOTES_WRITE_ACTIONS`).
- **LLM** — `get_llm_config` (profiles + slots, **apiKey redacted to `hasKey`**),
  `set_llm` (switch the primary profile / change a profile's `model`).
- **Ephemeral adapters** — `load_adapter {site, name}` (`ephemeral-adapter.ts`):
  fetch (sha-verified) + eval (offscreen) + `registerSessionDefs` → `<site>__<name>`
  is callable for the session, **not installed/persisted**. Returns the arg schema.
  Read-class (no write gate to load); the loaded adapter's own WRITE calls are gated
  when they run. See §10 for the find→load→use rationale (tokens) + the offscreen
  eval venue.

`server.mjs` lists them in `tools/list` + HTTP `/tools`; writes respect 允许外部写操作.

**Security — LLM keys stay out of the agent.** API keys are persisted in plaintext
(`config/llm-config.ts`). `get_llm_config` **never returns them** (only `hasKey`), and
`set_llm` **does not accept an apiKey** — adding a backend with a key is a UI action.
This keeps secrets out of the external agent's context (which its own LLM provider
would otherwise see). If we ever want full key provisioning over the bridge, gate it
behind a separate, explicit opt-in.

## 8. Phasing (each a shippable commit)

1. **P1 — skeleton.** `bridge/` Node package: WS server + `/ping`. Extension WS
   client: connect (configurable port), `register`, heartbeat, reconnect. An echo
   command end-to-end. Behind a settings toggle (off by default).
2. **P2 — catalog + run (T7a).** Extension pushes `catalog` (+ on ADAPTERS_CHANGED);
   bridge routes `call` → `executeAdapter` → `result`. Read tools only.
3. **P3 — MCP front.** Bridge speaks MCP (`tools/list` from catalog, `tools/call`
   → command). Editors connect. Pairing token + localhost bind (§6).
4. **P4 — writes + explore (T7b).** Write-confirm policy; expose the explore tool
   surface + ship the authoring skill; register synthesized adapters back.
5. **P5 — packaging.** `npx` bin, setup docs, connection indicator + kill switch.

## 9. Open questions

- MCP transport to editors: stdio (editor launches the bin) vs HTTP/SSE (long-
  lived). stdio is simplest for Claude Code; confirm Codex/Cursor expectations.
- One bridge ⇄ many extensions/profiles? (opencli keys connections by
  `contextId`.) Start single-connection; add profile keying if needed.
- Do we depend on opencli at all, or stay fully standalone? (Recommendation:
  standalone bin, opencli-compatible trace format so authored adapters interop —
  see `docs/llm-explore.md` route-C goal.)
- Keepalive: an active external session must pin the SW (MV3 30s kill) — reuse
  the port-keepalive mechanism.

## 10. Ephemeral adapters + the offscreen eval venue (shipped)

**Why.** Installing an adapter persists it AND puts it in the tool catalog sent to
the LLM on **every** request — so a big installed set costs tokens every call. For
infrequent adapters the agent should be able to "try one once" without installing.

**`load_adapter {site, name}`** (`src/background/ephemeral-adapter.ts`):
`fetchAdapterSource` (sha256-verified) → eval (offscreen) → `registerSessionDefs`
(live registry, **not** the installed-store) → `<site>__<name>` is callable, with
its real arg schema in the catalog. Gone on SW restart. Exposed as a bridge synthetic
tool + an agent-loop tool (`load_adapter`) — not a generic `cli()` tool, because the
panel also imports the generic bundle and this needs SW-only modules (offscreen,
registerSessionDefs). Difference from install = persistence + sha-pin + the install
consent click; capability/schema are identical while loaded.

**Consent.** Loading needs no confirm (sandboxed eval + sha-verified source). A
**read** adapter runs with no confirm; a **write** adapter hits the existing
write-confirm when it _runs_ (labelled "临时/未安装" via `isEphemeralTool`). On the
bridge, writes also respect 允许外部写操作.

**Offscreen eval venue.** The SW can't `eval` (CSP) and can't host a DOM, so adapter
source must eval in a sandboxed iframe inside *some* document. That used to be the
SidePanel (eval only worked with the panel open). Now an **offscreen document**
(`offscreen` permission; `src/offscreen/offscreen.ts` hosts the same sandbox iframe,
reusing `evalAdapterInSandbox`) is created on demand by `src/background/offscreen-eval.ts`
and the SW relays eval to it via `chrome.runtime` messaging. `requestSandboxEval`
(explore synth) now routes here too, so **all SW-side eval is panel-free**. The
removed SW↔panel `EXPLORE_EVAL_REQ/RESP` pathway is gone. **Bridge install is also
panel-free**: bridge-client intercepts `generic__install_adapter` and runs
`installMarketplaceAdapter` (`src/background/install-marketplace.ts`: fetch → offscreen
eval → `installFromCaptured`) instead of round-tripping through the panel. (Install
from the panel UI still evals in the panel's own iframe — the panel's already open.)

UI: the **Adapters** page carries a token-aware tip — install lean, load the rest on
demand.

## 11. Web-app MCP tool source — `externally_connectable` + `web_task`(shipped 2026-07-11)

**目标**:让另一个网页应用(localmd.app,`http://localhost:5173`,一个纯浏览器 AI
知识库)把整个「浏览网页」类任务**委托**给 web-agent 自己的 agent 引擎,只取回最终
文字。与 §2 的 bridge(本机 AI 编辑器 → WS daemon → 扩展,粒度是**单个工具**)互补:
这里是**网页 → 扩展直连**,粒度是**整个任务**(对端只看到一个 `web_task` 工具)。

**传输**:Chrome `externally_connectable`(manifest 里 matches 仅
`http://localhost:5173/*`,**绝不通配**)→ 页面 `chrome.runtime.connect(EXT_ID)` 长连接
Port → SW `chrome.runtime.onConnectExternal`。Port 上跑 JSON-RPC 2.0,消息形状与 MCP
对齐:`initialize` / `tools/list` / `tools/call` / `ping`,进度用无 id 的
`notifications/progress {message}` 通知。

**固定扩展 ID**:manifest 增加了 `"key"`(RSA 公钥,SPKI DER base64),使 dev/打包 ID
恒为 **`gcbgpkldpnmenoejbnbkdcagjhgbemeb`**(localmd.app 侧连接用它)。对应私钥在仓库根
`extension-key.pem`(已 gitignore,勿提交;只在需要重导 ID 或自签 .crx 时用)。

**实现**(`src/background/external-mcp.ts`,SW 入口注册一行):

- **origin 双保险**:Chrome 本身只让 matches 里的源连上;handler 再用
  `allowedExternalOrigins()`(从 `getManifest().externally_connectable.matches` 推导,
  **拒绝解析任何带通配的 pattern**)校验 `port.sender.origin`,不合法立即
  `port.disconnect()`——manifest 将来被放宽也不会自动放大这里的许可。
- **`web_task` → `driveApiSession`**:每次 tools/call 新建一个 session,与 SidePanel
  发消息**完全同路**——同一 LLM profile、同一 write-confirm 卡(autoApprove=false,
  面板没开则写操作超时拒绝 → 外部任务事实上只读)、同预算/防护,**零绕过**。最终答案
  = history 里最后一条 assistant turn 的 cleanedText(与桌面通知同一取法);会话落在
  历史会话里(displayText 前缀「🌐 外部任务」),可审计、可续聊。
- **进度**:orch-events 新增 `observeOrchEvents(sessionId, fn)` 旁路观察者(SidePanel
  广播不受影响),external-mcp 把 `tool_trace started` / `notice` 转成一行 progress。
- **约束**:未知方法 → `-32601`;未知工具名 / 缺 task → `-32602`;同一 Port 上
  tools/call **串行**(promise 链排队);Port 断开 → abort 进行中的 session 且不再回包;
  单条消息 1MB 上限(入向超限报 `-32600`,出向结果按字节实测收缩到装得下并注明截断);
  LLM 未配置 → `isError:true` +「请先在 web-agent 设置里配置模型」(不是协议错误,
  好让对端 agent 把话转给用户)。
- **MV3 现实**:任务运行中 driveApiSession 的 keepalive 钉住 SW;**空闲的外部 Port 钉不住**
  (§10.19 同款),SW 回收时页面会收到 onDisconnect——对端重连即可(connect 会唤醒 SW)。
  localmd.app 侧应把「断线重连 + initialize 重握手」当常态写。

**localmd.app 侧接入**(页面 console 即可验收):

```js
const port = chrome.runtime.connect('gcbgpkldpnmenoejbnbkdcagjhgbemeb');
port.onMessage.addListener((m) => console.log(m));
port.postMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
port.postMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
port.postMessage({
  jsonrpc: '2.0', id: 3, method: 'tools/call',
  params: { name: 'web_task', arguments: { task: '打开 example.com,告诉我页面标题' } },
});
```

**将来部署到正式域名**:在 manifest `externally_connectable.matches` **追加**该源
(继续枚举精确源,不上通配),allowlist 自动跟随;无需改代码。

### 11.1 目录扩展:Port 桥暴露全部注册工具(2026-07-12)

`web_task` 之外,Port 桥现在把 **WS 桥同一份工具目录**也暴露出去:

- **tools/list** = `web_task` + `openAiToolsFromRegistry()` 全量(OpenAI function 形状
  → MCP `{name, description, inputSchema}`;`parameters` 本来就是 JSON Schema,直接搬)。
  验收:数量 = 1 + 目录数。
- **tools/call 非 web_task** → **`runExternalTool`**(从 bridge-client `onMessage` 抽出的
  共享执行器,WS 桥同函数):CONTROL_TOOLS(save_memory / create_shortcut / load_adapter…
  **不在 list 里但按名可调**,与 WS 桥外挂目录一致)→ registry 适配器,**写开关判定只有
  这一份**——「允许外部写操作」关 → 控制类写工具和 `access:'write'` 适配器都拒;
  denySites 站点写拒;busy keepalive + pool-tab reap 也在执行器内,两个传输同生命周期。
  `origin:'webmcp'`(F-30:不会录进任何 explore trace,包括 bridge 拥有的)。
- **image 内容块**:结果对象顶层的 `data:image/...;base64` 字段(screenshot 的
  `dataUrl`)转成 MCP `{type:'image', data, mimeType}`,其余字段保留为一个 JSON text 块。
  整条消息超 1MB 时**图片块整块降级**为「已省略」说明(截断的 base64 是废数据),剩余
  文本再按字节收缩。整页截图容易超限——调用方想要图就别 `full_page`。
- **并发语义**:web_task 仍按 Port 串行(一次一个 agent 任务);**直接工具调用不排队**
  (即到即跑,与 WS 桥一致),所以慢 web_task 不会堵住 `generic__list_tabs` 这类轻调用。
  每个直接调用同 240s 兜底超时 + 记入 `recordCall` 审计日志(外部接入页与 WS 调用同表)。
- 消息形状(initialize / tools/list / tools/call、id 配对)与 §11 首发完全不变,
  localmd.app 侧无需改协议代码。

单测:`tests/external-mcp.test.ts`(origin 拒绝/通配拒绝、握手形状、-32601/-32600/-32602、
web_task 成功/引擎错/抛错/未配模型、串行、1MB 截断、断开中止、目录合并/形状转换、直接调用
分发+审计、image 块转换、超限图片降级、不被 web_task 排队,26 例);
`tests/bridge-external-tool.test.ts`(**真模块**验证共享执行器:写开关拦控制类写 + 适配器写、
denySites、写开关开时放行、读不受写开关影响、tool-not-found、isExternalTool,7 例)。
