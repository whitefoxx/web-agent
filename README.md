# WebChat Agent

把任意聊天网页（首发支持 DeepSeek `chat.deepseek.com`）变成一个能操作其他网站的浏览器 Agent。**零 API Key、零配置**：推理算力来自用户已登录的聊天网页本身，扩展只负责把 Agent 协议注入聊天网页 + 在后台执行小红书等站点的操作。

## 工作方式

```
SidePanel ──► Service Worker ──► chat.deepseek.com (隐式 LLM)
                  │                      │
                  │◄─────响应+指令───────│
                  │
                  ├─► xiaohongshu.com (CDP-driven)
                  │
SidePanel ◄──── 解析后的回答 + tool trace
```

1. 你在 SidePanel 输入消息（不是直接在 DeepSeek 网页输入）
2. 我们把它 + 系统提示 + 工具白名单注入到 DeepSeek tab 的输入框
3. DeepSeek 思考后，可能在回复里嵌入 `agent-command` 代码块（如：调用 `xiaohongshu__feed` 看首页推荐）
4. 我们抽出指令并隐藏代码块、清洗后的文字显示给你
5. 后台用 CDP 在小红书 tab 上执行该 adapter，得到结果
6. 把结果作为下一条"用户消息"注入回 DeepSeek，让它继续推理
7. 直到 DeepSeek 给出没有 `agent-command` 的最终自然语言回答

整个过程对 DeepSeek 来说就是普通对话；对你来说在 SidePanel 看不到任何 JSON 指令污染。

## 安装（开发模式）

```bash
npm install
npm run build       # 输出到 dist/
```

然后在 Chrome `chrome://extensions` 打开开发者模式 → `加载已解压的扩展程序` → 选 `dist/` 目录。

需要前提：

- 已登录 `https://chat.deepseek.com`
- 已登录 `https://www.xiaohongshu.com`（如果要用小红书相关工具）

## 使用

1. 点扩展图标打开 SidePanel
2. 顶部状态栏会显示 DeepSeek tab 是否就绪；未就绪时点击红色徽章自动打开 DeepSeek 网页
3. 在输入框问问题，例如：
   - "看下小红书首页最近热门内容并总结"
   - "搜小红书上「Roborock 扫地机」的笔记，对比下口碑"
   - "我的小红书最近有什么新评论？"

## 命令

- `npm run dev` — Vite 开发模式（HMR 有限，扩展开发建议 build + reload）
- `npm run build` — 打包到 `dist/`
- `npm run typecheck` — TypeScript 类型检查
- `npm run lint` / `npm run lint:fix` — ESLint
- `npm run format` / `npm run format:check` — Prettier
- `npm run test` / `npm run test:watch` — Vitest
- `npm run check` — typecheck + lint + format:check + test（CI 推荐入口）
- `npm run import-adapter <path/to/upstream.js>` — 从 `@jackwener/opencli` 字节同步新 adapter（脚本会自动重写 imports 并维护 `_all.ts`）

## 架构

完整设计见 [docs/architecture.md](./docs/architecture.md)。简表：

- `src/background/service-worker.ts` — 消息路由 + agent 编排
- `src/agent/` — orchestrator / session / system-prompt / command-parser
- `src/connectors/deepseek/` — DeepSeek 内容脚本 + DOM 选择器
- `src/tools/` — adapter manifest + dispatcher（字节复用自 [xiaohongshu-operator](https://github.com/.../xiaohongshu-operator)）
- `src/sidepanel/` — Preact UI

## 工具白名单 / 安全

- 写操作 adapter（发帖、评论、下载）默认**不**进入首轮工具摘要 — chatbot 必须显式 `describe_tool` 才知道它们的存在，且系统提示强调"涉及写操作必须先和用户确认"
- 小红书检测到限流（captcha 跳转）会立刻 `RateLimitedError`，dispatcher 把它包装成结构化错误返回 — 系统提示要求 chatbot 不要重试，等 15–30 分钟
- CDP debugger 只在调 adapter 时 lazy attach，结束即 detach；小红书 tab 会出现黄色"is being debugged"提示条
- DeepSeek tab 无 CDP，纯内容脚本 DOM 操作，无提示条

## 限制

参见 architecture.md §10。简表：

- Service Worker 可能被 Chrome 杀（>30s 无活动）→ 长任务可能中断
- 纯 DOM 注入对 DeepSeek UI 改版敏感 → 改版需要更新 `src/connectors/deepseek/selectors.ts`
- 只支持 DeepSeek 一家 chatbot（ChatGPT / Gemini 接口已抽象，未实装）
- 通用工具（open_url、get_page_markdown、screenshot）暂未实装

## License

MIT
