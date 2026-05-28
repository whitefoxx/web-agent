# WebChat Agent — 架构文档

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

## 7. xiaohongshu adapter 复用

`src/runtime/`、`src/tools/manifest.ts`、`src/tools/xiaohongshu/*.js` 与 xhs-op upstream 字节一致；ESLint 和 Prettier 都忽略 `src/tools/**/*.js` 保证 re-sync 时只需 `cp`。

`scripts/import-adapter.mjs` 可以从 `@jackwener/opencli` 拉新 adapter 进来并自动维护 `_all.ts`。

`PageShim`（`src/runtime/page.ts`）对 adapter 暴露 `page.goto / evaluate / autoScroll / captureNetwork / insertText` 等高级接口，内部用 `chrome.debugger` 直接发 CDP 命令。

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

## 9. 安全 / 边界

- **写操作 adapter 默认隐藏**：`xiaohongshu__publish / comment-create / download` 不出现在首轮工具摘要里。chatbot 仍可通过 `describe_tool` 拿到 schema，但 system prompt 强调"涉及写操作必须先和用户确认"。
- **限流自我保护**：`RateLimitedError`（来自 `PageShim` 检测到 captcha 跳转）会被 dispatcher 包装成结构化错误返回，prompt 明确要求 chatbot 不要重试。
- **CDP 权限**：仅在调 adapter 时 lazy attach，结束即 detach。`chrome.debugger` 的黄色提示条会出现在小红书 tab；DeepSeek tab 不需要 CDP，纯 DOM 操作，无提示条。
- **同源 / 跨站**：DeepSeek 内容脚本只读 chat.deepseek.com 的 DOM，写入也只是发送一条 DeepSeek 自己已经允许的消息；不跨站抓 cookie。

## 10. 已知限制 / 后续工作

| 限制                              | 影响                                             | 后续                                                            |
| --------------------------------- | ------------------------------------------------ | --------------------------------------------------------------- |
| Service Worker 可能被 Chrome 杀掉 | 长任务（>30s 无活动）可能中断                    | 用 chrome.alarms 自 ping 或长连 Port                            |
| 纯 DOM 注入                       | DeepSeek UI 改版即失效                           | 备选：MAIN-world 拦截 `fetch` 改 request body / SSE 响应        |
| 工具调用串行                      | 不能并行调多个 tool                              | 后续支持单轮多 tool 的并发执行                                  |
| 未支持 ChatGPT / Gemini           | 仅 DeepSeek 一站                                 | `ChatbotConnector` 接口已抽象，加新 content script + 选择器即可 |
| 暂无通用工具                      | open_url / get_page_markdown / screenshot 未实装 | 阶段 2 接入（需要 offscreen document 或注入式 turndown）        |
| 写操作没二次确认 UI               | 当前只靠 prompt 自律                             | 后续在 SidePanel 加 confirm 弹窗                                |
| 无 streaming 渲染                 | 一轮内只在 chatbot 结束后整段呈现                | 后续走流式 textContent 增量 push                                |

## 11. 文件结构速查

````
webchat-agent/
├── manifest.json            # MV3, side_panel + content_scripts
├── src/
│   ├── background/
│   │   └── service-worker.ts   # 主消息路由 + agent 编排入口
│   ├── agent/
│   │   ├── orchestrator.ts     # runSession() 多轮循环
│   │   ├── session.ts          # 会话状态 + chrome.storage.session
│   │   ├── command-parser.ts   # 抽取 ```agent-command JSON
│   │   └── system-prompt.ts    # 分层 prompt 模板
│   ├── runtime/                # ★ 字节复用自 xiaohongshu-operator
│   │   ├── page.ts             # PageShim（CDP 抽象）
│   │   ├── registry.js         # cli({...}) 注册表
│   │   ├── errors.js           # RateLimitedError 等
│   │   └── log.ts              # 带配置开关的日志（本项目扩展过）
│   ├── connectors/
│   │   ├── base.ts             # ChatbotConnector 接口
│   │   ├── messages.ts         # 跨上下文 message 协议
│   │   └── deepseek/
│   │       ├── content.ts      # isolated-world 内容脚本
│   │       └── selectors.ts    # DOM 选择器集中 + extractMarkdownFromDom
│   ├── tools/
│   │   ├── manifest.ts         # ★ 字节复用
│   │   ├── dispatcher.ts       # adapter 调度（ensureSiteTab + PageShim）
│   │   └── xiaohongshu/        # ★ 14 个 adapter + _all.ts 字节复用
│   └── sidepanel/
│       ├── App.tsx, Markdown.tsx, types.ts
│       ├── style.css, index.html, main.tsx
├── tests/
│   ├── command-parser.test.ts  # agent-command 抽取（重点）
│   ├── orchestrator.test.ts    # 端到端 mock driver
│   ├── registration.test.ts    # 字节复用断言
│   ├── manifest.test.ts        # schema 生成断言
│   ├── registry.test.ts        # cli() 行为
│   ├── errors.test.ts          # error 类层级
│   └── imported-adapters.test.ts # adapter 文件一致性
├── scripts/import-adapter.mjs  # ★ 字节复用：从 opencli 同步新 adapter
└── docs/architecture.md        # 本文件
````

（标 ★ 的部分跟 xiaohongshu-operator 完全一致；改动这些会破坏 re-sync 流程。）
