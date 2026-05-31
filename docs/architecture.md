# WebChat Agent — 架构文档

> **想快速了解项目?** 先看 README,然后从下面的「当前状态速览」表开始读本文。深入热插拔/市场设计另见 [adapter-hot-plug.md](./adapter-hot-plug.md)。

## 0. 当前状态速览(2026-05)

| 模块                               | 状态                                                                                                                                            | 说明                                                                                                                                                                                            |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **DeepSeek connector**             | ✅ 生产可用                                                                                                                                     | `src/connectors/deepseek/`,首发并主测的 chatbot                                                                                                                                                 |
| **ChatGPT / Gemini connector**     | ⛔ 未实装                                                                                                                                       | `ChatbotConnector` 接口已抽象,无 content script                                                                                                                                                 |
| **API mode(OpenAI-compatible)**    | ✅ 生产可用                                                                                                                                     | `src/agent/api-engine.ts`,275 行;支持 DeepSeek/OpenAI/Anthropic 兼容 endpoint;UI 设置面板切换                                                                                                   |
| **Adapter 市场(Phase A pipeline)** | ✅ 生产可用                                                                                                                                     | 装即用,零额外配置                                                                                                                                                                               |
| **Adapter 市场(Phase B func)**     | ✅ 生产可用                                                                                                                                     | 需 Chrome 138+ + 用户在 `chrome://extensions` 开「允许用户脚本」开关                                                                                                                            |
| **Adapter 市场内置 bundle**        | 284 个 adapter(73 pipeline + 211 func),27 个站点。schema-v2: 116KB `marketplace/index.json`(metadata + sha256)+ per-adapter `<site>/<name>.js` | 见 `marketplace/`,`scripts/build-marketplace-index.mjs --popular` 重建,详 hot-plug §11                                                                                                          |
| **通用工具(generic)**              | ✅ 10 个                                                                                                                                        | `open_url` / `screenshot` / `scroll_page` / `get_text_from_tab` / `get_page_text` / `close_tab` / `get_interactives` / `click` / `click_by_text` / `type_into`(`_helpers` 是内部模块,不是 tool) |
| **写操作二次确认**                 | ✅ 实装                                                                                                                                         | SidePanel 弹窗 + 5 分钟超时,见 `service-worker.ts:WRITE_CONFIRM_RESP`                                                                                                                           |
| **会话持久化**                     | ✅ IndexedDB                                                                                                                                    | `session-store.ts`,跨 Chrome 重启幸存,DB v2 与 adapter store 共存                                                                                                                               |
| **session 内热刷工具列表**         | ✅                                                                                                                                              | adapter 装好下一回合就出现在 agent 工具白名单(见 hot-plug §a9c0371)                                                                                                                             |
| **跨 worlds bug 兼容**             | ✅                                                                                                                                              | `page.evaluate` 走 CDP MAIN world(详见 hot-plug §10.7)                                                                                                                                          |
| **测试**                           | 160 个 vitest 用例,全 node 环境可跑                                                                                                             | `npm test`                                                                                                                                                                                      |

详细取舍记录:见各章 + [adapter-hot-plug.md §3 决策](./adapter-hot-plug.md#3-决策)。

## 1. 目标

把任意聊天网页（首发支持 chat.deepseek.com，预留 ChatGPT / Gemini 接口）变成一个能够操作其他网站的浏览器 Agent，并且：

- **零 API Key**：不调任何 LLM API。推理算力完全来自用户已登录的聊天网页本身。
- **零配置**：装好扩展、登录目标聊天网页和待操作站点（如小红书）即可用。
- **多轮工具调用**：通过 chatbot 回复中的 `agent-command` 代码块表达工具调用意图，扩展执行后把结果再喂回 chatbot，形成自治循环。

## 2. 三个运行时上下文

```
┌─────────────────────────────┐   ┌──────────────────────────┐   ┌──────────────────────────┐
│   SidePanel UI (用户主界面)    │   │   Service Worker          │   │  chat.deepseek.com Tab    │
│                             │   │  (路由 + Agent 编排)        │   │  (隐式 LLM worker)         │
│  - 聊天消息列表                │   │                          │   │                          │
│  - 工具调用 trace 折叠卡片       │   │  - 消息路由               │   │  Content Script (隔离世界):│
│  - 设置 / 日志面板             │   │  - 会话状态 (storage.session) │   │  - 接收 INJECT_PROMPT     │
│  - 输入框 + 发送 + 终止         │   │  - 启动 orchestrator      │   │  - 注入到 textarea + send  │
└────────────┬────────────────┘   │  - 调度 adapter 通过 PageShim │   │  - MutationObserver 等响应  │
             │                    │  - 聚合日志环形缓冲           │   │  - 抽 agent-command + send │
             │                    └────────────┬─────────────┘   └────────────┬─────────────┘
             │                                 │                              │
             │── USER_MESSAGE ──────────────────►                              │
             │                                 │── INJECT_PROMPT ─────────────►│
             │                                                                 │
             │                                 │◄── CHATBOT_RESPONSE ──────────┤
             │◄── ASSISTANT_TURN ───────────────┤                              │
             │◄── TOOL_TRACE  ─────(many)───────┤                              │
             │                                 │                              │
             │                                 ├── adapter via PageShim ─────►┐
             │                                 │                              │ xiaohongshu Tab
             │                                 │◄────── result ───────────────┘ (CDP-driven)
             │                                 │
             │                                 │── INJECT_PROMPT (工具结果) ──►│
             │                                 │       …loop…                 │
             │◄── ASSISTANT_TURN (最终总结) ─────┤                              │
             │◄── SESSION_DONE  ───────────────┤                              │
```

| 上下文                | 主职责                                                   | 文件                                                                        |
| --------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------- |
| **SidePanel UI**      | 用户聊天界面、tool trace 展示、设置/日志面板             | `src/sidepanel/`                                                            |
| **Service Worker**    | 消息路由、agent 编排、adapter 调度、日志聚合             | `src/background/service-worker.ts`, `src/agent/`, `src/tools/dispatcher.ts` |
| **DeepSeek 内容脚本** | 注入文本到 textarea、监听响应、抽指令                    | `src/connectors/deepseek/content.ts`                                        |
| **xiaohongshu Tab**   | 被 CDP 操作的目标网站 — 无内容脚本，全靠 chrome.debugger | （只在 manifest 里声明 host_permissions）                                   |

## 3. Agent 循环（runSession）

`src/agent/orchestrator.ts:runSession()` 是核心循环。

```
1. session.status = 'running'
2. driver.startFreshChat?.()              # 可选：点 deepseek 的 "New chat"
3. nextPrompt = buildFirstTurnPrompt(...)  # 含 system prompt + 工具一行摘要 + 用户原始请求
4. for iter in 0..maxIter:
     driver.inject(nextPrompt)             # SW → content script → 注入 textarea + send
     response = driver.waitForResponse()   # 阻塞直到 CHATBOT_RESPONSE 抵达
     emit assistant_turn (cleanedText)
     if response.commands.empty: return DONE
     resultChunks = []
     for cmd in response.commands:
       resultChunks.push( dispatchCommand(cmd) )
     nextPrompt = resultChunks.join("\n\n---\n\n")
5. return max_iterations
```

`dispatchCommand` 根据 `cmd.action` 走四个分支：

- `list_tools(category)` → 直接由 system-prompt.ts 渲染分类下工具一行摘要，不出 chatbot tab，无 CDP。
- `describe_tool(name)` → 同上，渲染完整 args schema + 调用示例。
- `execute_tool(tool, args)` → `tools/dispatcher.ts:executeAdapter()` 找 adapter → ensureSiteTab → createPageShim → adapter.func → 返回结果 → 转字符串。
- `done` → 显式终止。
- 其余/`parse_error` → 返回错误说明（chatbot 据此修正下一轮）。

每个命令都会发 `tool_trace`（started / completed / failed）给 SidePanel 显示折叠卡片。

## 4. 分层 system prompt（应对工具增长）

首轮注入：

- 协议头：`agent-command` 代码块格式约定
- 工具一行摘要（按 site 分组）— 含 site\_\_name + 一句话描述
- 4 个 action 用法
- 流程建议（不熟悉的工具先 describe_tool，等结果再下一步等）
- 用户原始请求

后续轮注入：

- 工具结果 / list_tools 结果 / describe_tool 结果 — 都用 markdown 包装成「工具结果 — xxx」格式

这套设计让首轮提示长度可控（200 行左右），工具到数百个时也只需要 list_tools 按需取，而不会让首条爆炸。

## 5. 消息协议

定义在 `src/connectors/messages.ts`。所有 IPC 都用 `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage`，payload 是结构化可克隆 JSON。

| 类型                 | 方向           | 用途                                |
| -------------------- | -------------- | ----------------------------------- |
| `USER_MESSAGE`       | SidePanel → SW | 用户在 SidePanel 输入               |
| `ABORT_SESSION`      | SidePanel → SW | 终止当前会话                        |
| `ENSURE_CHATBOT_TAB` | SidePanel → SW | 查询/确保 deepseek tab 在           |
| `REQUEST_LOGS`       | SidePanel → SW | 拉 SW 的日志缓冲                    |
| `INJECT_PROMPT`      | SW → Connector | 把文本注入 chatbot                  |
| `INJECT_ACK`         | Connector → SW | 注入完成回执                        |
| `CHATBOT_RESPONSE`   | Connector → SW | chatbot 回复+解析后的命令           |
| `CONNECTOR_READY`    | Connector → SW | content script 启动并探测页面       |
| `ASSISTANT_TURN`     | SW → SidePanel | 每一轮 chatbot 的清洗后回复         |
| `TOOL_TRACE`         | SW → SidePanel | 工具调用 trace（started/done/fail） |
| `SESSION_DONE`       | SW → SidePanel | 会话结束 + 原因                     |
| `CHATBOT_TAB_STATUS` | SW → SidePanel | deepseek tab 是否就绪               |
| `LOG_ENTRY`          | 任意 → SW      | 日志条目转发到 SW 聚合              |
| `LOGS_RESPONSE`      | SW → SidePanel | 返回 SW 的日志缓冲                  |

## 6. DeepSeek connector 关键细节

DOM 选择器（见 `src/connectors/deepseek/selectors.ts`）：

| 元素          | 选择器 / 策略                                                                   |
| ------------- | ------------------------------------------------------------------------------- |
| 输入框        | `textarea[name="search"]`（备 `textarea[placeholder*="Message DeepSeek" i]`）   |
| 发送按钮      | 通过 SVG path d 前缀 `M8.3125 0.981587`（上箭头）→ `closest('[role="button"]')` |
| New chat 按钮 | `<span>` textContent === `New chat` → closest role=button                       |
| 消息列表      | `.ds-virtual-list-visible-items`                                                |
| 消息项        | `[data-virtual-list-item-key="N"]`                                              |
| 助手回复体    | `.ds-assistant-message-main-content`                                            |
| 思考内容      | `.ds-think-content`                                                             |

注入流程：

1. native input setter 设值（绕过 React 受控组件限制）+ dispatch `input`/`change` 事件
2. 轮询直到 send 按钮 `aria-disabled="false"`
3. `.click()` 触发提交

响应检测：

- `MutationObserver` 监听 message list 子树变化
- 每次变化检查最后一条 `data-virtual-list-item-key > baseline` 且含 `.ds-assistant-message-main-content` 的项
- 1500ms 内 textContent 无变化 → 视为稳定 / 完成
- 提取流程：DOM → `extractMarkdownFromDom`（保留 ``\`\`\`lang`` 代码围栏） → `parseAgentCommands(md)`
- 同时提取 `.ds-think-content`（思考过程）单独发给 SidePanel 展示

## 7. Adapter 来源:市场 + 运行时热插拔

**所有 site adapter 现在都从市场安装,不再有内置 site 目录。** `src/tools/` 只剩 `generic/`(站点无关的 open_url/click/screenshot/...)和 `manifest.ts`/`dispatcher.ts` 框架代码。

热插拔架构完整设计见 [docs/adapter-hot-plug.md](./adapter-hot-plug.md)。要点:

- **Phase A**(pipeline 型):sandbox iframe 一次性 eval 出纯数据 → 存 IDB → 由 `runtime/opencli/pipeline.ts` 解释器跑(无 eval)。装即用,零额外配置。
- **Phase B**(func 型):`chrome.userScripts` API(Chrome 138+)把 func 注入目标 tab 的 USER_SCRIPT world 跑;`page.evaluate/wait` 本地执行,`page.goto/getCookies/...` 通过 port RPC 回 SW 用 `PageShim` 兑现。需用户在「允许用户脚本」开关开。
- **市场**:`marketplace/` 默认内置 284 个 adapter(73 pipeline + 211 func)。schema-v2:116KB metadata-only `index.json` + per-adapter `<site>/<name>.js`。`scripts/build-marketplace-index.mjs` 用 `--popular` 从 opencli `clis/` 生成。客户端 install 时 fetch 单个 .js 并 sha256 校验。远程市场 URL 的接口位已留好,只差 `baseUrl` 配置项。详 hot-plug §11。

`PageShim`(`src/runtime/page.ts`)暴露 `page.goto / evaluate / autoScroll / captureNetwork / pressKey / ...` 给 adapter(无论是 SW 直接 invoke 内置的,还是 Phase B 经 port RPC 兑现的)。内部用 `chrome.debugger` 直接发 CDP 命令。

## 8. 日志

`src/runtime/log.ts` 提供 `log()/warn()/error()/group()`，全部带 `[webchat:<scope>]` 前缀：

- `chrome.storage.local` 持久化开关 + 命名空间白名单
- 每个上下文维护本地环形缓冲（默认 500 条）
- 非 SW 上下文 `fire-and-forget` 一条 `LOG_ENTRY` 给 SW 聚合
- SidePanel `subscribeLog()` 实时尾巴 + 启动时拉 SW 缓冲

UI 设置面板可以一键关闭 / 开启 + 清空。

## 8.5. "Server is busy" 自动重试

DeepSeek 偶尔会在你提交后立刻在 user 消息下方贴一条 "Server is busy. Try again later, or use Instant mode."（外加它自己的一个 retry 图标按钮），此时不会产生新的 assistant 消息 item，普通的 stability 监测会一直等到超时。Connector 加了专门的检测路径：

1. `findBusyIndicator()` 扫描 `MESSAGE_LIST` 内的小文本节点，匹配 `/server is busy/i`
2. 命中后 watch 切到 `busy_waiting` phase，停掉 stability 计时器
3. 按 `BUSY_RETRY_BACKOFFS_MS = [5_000, 15_000, 30_000]` 计划延时，到点用 `findRetryButtonNear()` 找到 DeepSeek 同消息项里的 retry 按钮（SVG path 前缀 `M1.272 6.21348`），`.click()` 触发 DeepSeek 自己的重试逻辑
4. 重置 `lastSnapshot`，回到 `observing` phase 继续等响应
5. 三次都失败：发 `CHATBOT_ERROR { reason: 'busy_exhausted' }` 给 SW，SW reject 待返回 promise，orchestrator 把它转成 `SESSION_DONE` 错误

整轮重试发的 `CHATBOT_BUSY` 事件被 SW 透传到 SidePanel，UI 以一条灰色系统消息形式展示"第 N/3 次重试将在 5/15/30 秒后发起…"，整段过程对用户而言是有可见反馈的"无缝 resume"。

## 8.6 双 LLM backend:chat-tab 模式 vs API 模式

项目同时支持两条推理路径,UI 设置面板里切换:

|          | **chat-tab 模式(默认)**                                                                | **API 模式**                                                                                    |
| -------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 推理来源 | 用户已登录的 chat.deepseek.com tab                                                     | 用户填的 OpenAI-compatible endpoint                                                             |
| 配置     | 零(开扩展前已登录即可)                                                                 | 必须填 provider / model / baseUrl / apiKey,见 SidePanel 设置                                    |
| 编排入口 | `orchestrator.ts:runSession()`(注 inject prompt → 等 DOM 响应 → 抽 agent-command 循环) | `agent/api-engine.ts:runApiSession()`(标准 chat/completions POST + tool_calls 循环)             |
| 工具协议 | 文本 `agent-command` JSON 代码块(因为 DeepSeek 没暴露 tool API)                        | 原生 OpenAI tool_calls(API 给的)                                                                |
| 消息历史 | DOM 重建 + `chrome.storage.session` 缓存                                               | `ApiMessage[]` 数组持久化到 `session-store.ts`(thinking models 需要把 `reasoning_content` 回喂) |
| 写操作   | 同样走 WRITE_CONFIRM 弹窗                                                              | 同样走 WRITE_CONFIRM 弹窗                                                                       |
| 适用人群 | 不想花 API 钱的普通用户(命名所言的"zero API key")                                      | 已有 API key 的开发者 / 要稳定性 / 要长上下文                                                   |

两条路径共享:tool 注册表(`src/runtime/registry.js`)、dispatcher(`src/tools/dispatcher.ts`)、PageShim(`src/runtime/page.ts`)、写操作确认弹窗、会话存储。**只有"如何拿到下一段 assistant 文本"不同**;拿到之后命令解析(`command-parser.ts` for chat-tab,native tool_calls for api)+ 工具调度完全一致。

> 取舍:chat-tab 是命名所言的"零 API key"卖点,但有几个固有限制:DeepSeek 的 "Server is busy"(已有自动重试,§8.5)、上下文长度受 chatbot 端限制、不支持 streaming。API 模式去掉了所有这些,但要 key,要钱。设计意图是让重度用户在不放弃这个项目的工具生态(284 个市场 adapter + 11 个 generic + 写操作确认 + 会话存储)的前提下,接入自己的 API。

## 9. 安全 / 边界

- **写操作 adapter 默认隐藏**：任何 `access: 'write'` 的工具（twitter/post、weibo/post、xiaohongshu/publish、reddit/comment、linkedin/connect 等）不出现在首轮工具摘要里。chatbot 仍可通过 `describe_tool` 拿到 schema，但 system prompt 强调"涉及写操作必须先和用户确认"，runtime 额外强制 WRITE_CONFIRM_REQ 二次确认弹窗。
- **限流自我保护**：`RateLimitedError`（来自 `PageShim` 检测到 captcha 跳转）会被 dispatcher 包装成结构化错误返回，prompt 明确要求 chatbot 不要重试。
- **CDP 权限**：仅在调 adapter 时 lazy attach，结束即 detach。`chrome.debugger` 的黄色提示条会出现在小红书 tab；DeepSeek tab 不需要 CDP，纯 DOM 操作，无提示条。
- **同源 / 跨站**：DeepSeek 内容脚本只读 chat.deepseek.com 的 DOM，写入也只是发送一条 DeepSeek 自己已经允许的消息；不跨站抓 cookie。

## 10. 已知限制 / 后续工作

| 限制                                | 影响                                                                                    | 后续                                                           |
| ----------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Service Worker 可能被 Chrome 杀掉   | 长任务（>30s 无活动）可能中断;orchestrator 循环里有 `Port` 防 idle,但 chrome 仍可能强杀 | 用 chrome.alarms 自 ping;或迁移长任务到 offscreen document     |
| 纯 DOM 注入                         | DeepSeek UI 改版即失效                                                                  | 备选：MAIN-world 拦截 `fetch` 改 request body / SSE 响应       |
| 工具调用串行                        | 单轮内一个 agent-command 一个 tool;DeepSeek 自己也不发并发 tool_calls                   | 后续支持单轮多 tool 的并发执行(API 模式更容易,native 协议支持) |
| 未支持 ChatGPT / Gemini connector   | 想用 chat-tab 模式只能选 DeepSeek;想用其它需走 API 模式                                 | `ChatbotConnector` 接口已抽象,加新 content script + 选择器即可 |
| chat-tab 模式无 streaming 渲染      | 一轮内只在 chatbot 结束后整段呈现;tool trace 是即时的                                   | DeepSeek connector 走 textContent diff,改增量 push 工作量大    |
| 跨 worlds 性能开销                  | `page.evaluate` 每次走 RPC → CDP(详 hot-plug §10.7)                                     | 用 `page.evaluateMain()` 显式分流;或脚本编排端整段 batch       |
| 装好的 marketplace adapter 升级路径 | 改 source 序列化方式后用户必须手动 uninstall + reinstall(详 hot-plug §10.8)             | 加 "source schema version" 字段 + 启动时自动迁移               |

## 11. 文件结构速查

````
webchat-agent/
├── manifest.json                       # MV3, side_panel + content_scripts (1 个 MAIN-world: deepseek clipboard-tap)
├── src/
│   ├── background/
│   │   └── service-worker.ts           # 主消息路由(1368 行)+ agent 编排入口 + WRITE_CONFIRM 弹窗状态机
│   ├── agent/
│   │   ├── orchestrator.ts             # chat-tab 模式 runSession() 多轮循环(463 行)
│   │   ├── engine.ts                   # chat-tab vs api 模式 dispatcher
│   │   ├── api-engine.ts               # API 模式 runApiSession()(275 行,OpenAI-compatible chat/completions + tool_calls)
│   │   ├── api-system-prompt.ts        # API 模式 system prompt
│   │   ├── api-types.ts                # ApiMessage / ToolCall 共享类型
│   │   ├── session.ts                  # SessionState 类型 + 状态 transitions
│   │   ├── session-store.ts            # IndexedDB 会话持久化(跨 Chrome 重启幸存)
│   │   ├── command-parser.ts           # 抽取 ```agent-command JSON(仅 chat-tab 模式用)
│   │   └── system-prompt.ts            # chat-tab 模式分层 prompt 模板(329 行)
│   ├── config/
│   │   └── llm-config.ts               # 双 LLM backend 配置(provider/model/baseUrl/apiKey),存 chrome.storage.local
│   ├── runtime/
│   │   ├── page.ts                     # PageShim(777 行,CDP Runtime.evaluate→MAIN world + chrome.cookies/tabs/debugger)
│   │   ├── registry.js                 # cli({...}) 注册表 + _installed 标 + _version 热刷计数
│   │   ├── errors.js                   # RateLimitedError / AuthRequiredError / EmptyResultError 等
│   │   ├── log.ts                      # 带配置开关的日志(scope 白名单 + 环形缓冲)
│   │   └── opencli/
│   │       ├── pipeline.ts             # Phase A pipeline 解释器(运行期零 eval)
│   │       ├── utils.ts, logger.ts, types.ts  # opencli 浏览器版 shim
│   ├── connectors/
│   │   ├── base.ts                     # ChatbotConnector 接口
│   │   ├── registry.ts                 # connector 注册表
│   │   ├── messages.ts                 # 跨上下文 message 协议
│   │   └── deepseek/
│   │       ├── content.ts              # 内容脚本(isolated world)
│   │       ├── clipboard-tap.ts        # MAIN-world clipboard 拦截
│   │       └── selectors.ts            # DOM 选择器 + extractMarkdownFromDom
│   ├── tools/
│   │   ├── manifest.ts                 # adapter 类型 + openAiToolsFromRegistry + lookupAdapter
│   │   ├── dispatcher.ts               # 四路调度: generic / pipeline / installed-func / 错误
│   │   └── generic/                    # 10 个站点无关原语(open_url/get_page_text/screenshot/scroll_page/
│   │                                   #   get_text_from_tab/close_tab/get_interactives/click/click_by_text/
│   │                                   #   type_into,_helpers 是内部模块非 tool)
│   ├── sandbox/
│   │   ├── eval-core.ts                # 纯函数 stripModuleSyntax + evalAdapterSource(node 单测)
│   │   ├── eval-host.ts                # sandbox iframe 内消息宿主(EVAL_ADAPTER ↔ EVAL_RESULT)
│   │   └── sandbox.html                # 模板(实际产物由 vite.config.ts 的 sandboxPagePlugin 内联生成)
│   ├── userscript/                     # Phase B func adapter
│   │   ├── runner.ts                   # USER_SCRIPT-world IIFE 入口(esbuild→dist/userscript-runner.js)
│   │   ├── run-in-page.ts              # in-page runner 可测核心(makeLocalPage/runAdapterInPage)
│   │   ├── rpc-server.ts               # SW 侧用 PageShim 兑现 chrome.*/CDP/MAIN-world 类 page.*
│   │   ├── sw-runner.ts                # configureWebchatWorld + 编排循环(navigate-then-reinject trampoline)
│   │   ├── protocol.ts                 # PORT_NAME / WORLD_ID / 消息类型
│   │   └── chrome-userscripts.d.ts     # 类型补丁(@types/chrome 落后于 Chrome 138 API)
│   ├── adapters/
│   │   ├── install-manager.ts          # installFromCaptured / loadOnBoot / setEnabled / uninstall
│   │   └── installed-store.ts          # IndexedDB(DB v2,与 session-store 共存)
│   └── sidepanel/
│       ├── App.tsx                     # 主 UI(1393 行,含设置面板里的 API mode 切换)
│       ├── Adapters.tsx                # 「已安装」「市场」双 tab + 贴码安装 + 启用/卸载(535 行)
│       ├── Markdown.tsx                # marked + dompurify 渲染助手
│       ├── adapters-client.ts          # 跟 SW 的 install/list/uninstall RPC
│       ├── marketplace.ts              # fetchMarketIndex + fetchAdapterSource(sha256-verified)+ FEATURED_IDS
│       ├── sandbox-host.ts             # 持有隐藏 sandbox iframe 转发 eval(install path)
│       ├── types.ts, main.tsx, index.html, style.css
├── marketplace/                        # schema-v2(详 hot-plug §11):116KB metadata-only index.json + per-adapter <site>/<name>.js
│   ├── index.json                      # {version:2, adapters:[{site,name,...,source,sha256,tier,author,version}]}
│   └── <site>/<name>.js                # bundled adapter source(284 个文件)
├── tests/                              # vitest, 182 用例(全 node 环境)
├── scripts/
│   ├── import-adapter.mjs              # build-time 单 adapter 同步(开发者用,非用户路径)
│   └── build-marketplace-index.mjs     # 生成 marketplace/ 树(esbuild bundle 相对 import,详 hot-plug §10.8)
└── docs/
    ├── architecture.md                 # 本文件 — 整体架构 / 当前状态 / 安全 / 限制
    └── adapter-hot-plug.md             # Phase A + Phase B ADR + 踩坑总结 + 市场 v2 schema(§11)
````

「site adapter」现已**全部走市场**(运行时安装,IndexedDB 持久化,跨 Chrome 重启自动恢复),`src/tools/` 只剩 generic + 框架代码。

## 12. 历史教训速查

写在每个章节里的"取舍"已经够多了,但有几个跨章节的坑值得单独标出来(完整 post-mortem 见 [adapter-hot-plug.md §10](./adapter-hot-plug.md#10-phase-b-真实部署的坑)):

| 坑                                                                                    | 教训                                                                           | 详                         |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------- |
| diag marker 在 USER_SCRIPT 写、SW MAIN world 读 → 永 null                             | **跨 world 通信只能走 DOM 或 postMessage**,`globalThis` 隔离                   | hot-plug §10.2             |
| USER_SCRIPT port → SW 永远收不到                                                      | Chrome 把 USER_SCRIPT 连接路由到独立事件 `onUserScriptConnect`(非 `onConnect`) | hot-plug §10.3             |
| goto trampoline 因 tracking 参数无限循环                                              | 网页 URL 不稳定,匹配用 origin+pathname+params subset 而非 strict-equal         | hot-plug §10.4             |
| `page.evaluate` 从 CDP MAIN 换到 USER_SCRIPT 本地后,所有 `window.<global>` 静默返回空 | **换执行环境时必须逐条对照旧语义**                                             | hot-plug §10.7(2026-05 修) |
| marketplace 存 source 原文 → 相对 import 运行时 ReferenceError                        | **marketplace 化 = 自包含化**,隐式依赖必须显式 inline                          | hot-plug §10.8(2026-05 修) |
| 改 source 序列化方式后老用户必须手动重装                                              | 加 "source schema version" 字段 + 启动时自动迁移                               | hot-plug §10.8(后续)       |
