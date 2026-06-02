# WebChat Agent — 架构文档

> **想快速了解项目?** 先看 README,然后从下面的「当前状态速览」表开始读本文。深入热插拔/市场设计另见 [adapter-hot-plug.md](./adapter-hot-plug.md)。

## 0. 当前状态速览(2026-05)

| 模块                               | 状态                                                                                                                                           | 说明                                                                                                                                                                                            |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **API engine(OpenAI-compatible)**  | ✅ 生产可用                                                                                                                                    | `src/agent/api-engine.ts`;支持任何 chat/completions 协议的 endpoint(DeepSeek/OpenAI/GLM/Kimi/MiniMax/...);SidePanel 菜单 → LLM 后端 配置                                                        |
| **Adapter 市场(Phase A pipeline)** | ✅ 生产可用                                                                                                                                    | 装即用,零额外配置                                                                                                                                                                               |
| **Adapter 市场(Phase B func)**     | ✅ 生产可用                                                                                                                                    | 需 Chrome 138+ + 用户在 `chrome://extensions` 开「允许用户脚本」开关                                                                                                                            |
| **Adapter 市场内置 bundle**        | 284 个 adapter(73 pipeline + 211 func),27 个站点。schema-v2: 116KB `marketplace/index.json`(metadata + sha256)+ per-adapter `<site>/<name>.js` | 见 `marketplace/`,`scripts/build-marketplace-index.mjs --popular` 重建,详 hot-plug §11                                                                                                          |
| **通用工具(generic)**              | ✅ 10 个                                                                                                                                       | `open_url` / `screenshot` / `scroll_page` / `get_text_from_tab` / `get_page_text` / `close_tab` / `get_interactives` / `click` / `click_by_text` / `type_into`(`_helpers` 是内部模块,不是 tool) |
| **写操作二次确认**                 | ✅ 实装                                                                                                                                        | SidePanel 弹窗 + 5 分钟超时,见 `service-worker.ts:WRITE_CONFIRM_RESP`                                                                                                                           |
| **会话持久化**                     | ✅ IndexedDB                                                                                                                                   | `session-store.ts`,跨 Chrome 重启幸存,DB v2 与 adapter store 共存                                                                                                                               |
| **session 内热刷工具列表**         | ✅                                                                                                                                             | adapter 装好下一回合就出现在 agent 工具白名单(见 hot-plug §a9c0371)                                                                                                                             |
| **跨 worlds bug 兼容**             | ✅                                                                                                                                             | `page.evaluate` 走 CDP MAIN world(详见 hot-plug §10.7)                                                                                                                                          |
| **测试**                           | 179 个 vitest 用例,全 node 环境可跑                                                                                                            | `npm test`                                                                                                                                                                                      |

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
- **市场**:`marketplace/` 默认内置 284 个 adapter(73 pipeline + 211 func)。schema-v2:116KB metadata-only `index.json` + per-adapter `<site>/<name>.js`。`scripts/build-marketplace-index.mjs` 用 `--popular` 从 opencli `clis/` 生成。客户端 install 时 fetch 单个 .js 并 sha256 校验。远程市场 URL 的接口位已留好,只差 `baseUrl` 配置项。详 hot-plug §11。

`PageShim`(`src/runtime/page.ts`)暴露 `page.goto / evaluate / autoScroll / captureNetwork / pressKey / ...` 给 adapter(无论是 SW 直接 invoke pipeline 内置的,还是 Phase B 经 port RPC 兑现的)。内部用 `chrome.debugger` 直接发 CDP 命令。

## 7. 日志

`src/runtime/log.ts` 提供 `log()/warn()/error()/group()`,全部带 `[webchat:<scope>]` 前缀:

- `chrome.storage.local` 持久化开关 + 命名空间白名单
- 每个上下文维护本地环形缓冲(默认 500 条)
- 非 SW 上下文 fire-and-forget 一条 `LOG_ENTRY` 给 SW 聚合
- SidePanel `subscribeLog()` 实时尾巴 + 启动时拉 SW 缓冲

UI 菜单 → 日志页可以一键关闭 / 开启 + 清空。

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
webchat-agent/
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
│   │   └── generic/                    # 10 个站点无关原语(open_url/get_page_text/screenshot/scroll_page/
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
│   │   ├── sw-runner.ts                # configureWebchatWorld + 编排循环(navigate-then-reinject trampoline)
│   │   ├── protocol.ts                 # PORT_NAME / WORLD_ID / 消息类型
│   │   └── chrome-userscripts.d.ts     # 类型补丁(@types/chrome 落后于 Chrome 138 API)
│   ├── adapters/
│   │   ├── install-manager.ts          # installFromCaptured / loadOnBoot / setEnabled / uninstall
│   │   └── installed-store.ts          # IndexedDB(DB v2,与 session-store 共存)
│   └── sidepanel/
│       ├── App.tsx                     # 主 UI(聊天 + 工具 trace + 菜单 → 4 个子页面)
│       ├── Adapters.tsx                # 「已安装」「市场」双 tab + 贴码安装 + 启用/卸载
│       ├── Icons.tsx                   # 内联 SVG 图标集(Lucide 风)
│       ├── Markdown.tsx                # marked + dompurify 渲染助手
│       ├── adapters-client.ts          # 跟 SW 的 install/list/uninstall RPC
│       ├── marketplace.ts              # fetchMarketIndex + fetchAdapterSource(sha256-verified)+ FEATURED_IDS
│       ├── sandbox-host.ts             # 持有隐藏 sandbox iframe 转发 eval(install path)
│       ├── types.ts, main.tsx, index.html, style.css
├── marketplace/                        # schema-v2(详 hot-plug §11):116KB metadata-only index.json + per-adapter <site>/<name>.js
│   ├── index.json                      # {version:2, adapters:[{site,name,...,source,sha256,tier,author,version}]}
│   └── <site>/<name>.js                # bundled adapter source(284 个文件)
├── tests/                              # vitest, 179 用例(全 node 环境)
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
