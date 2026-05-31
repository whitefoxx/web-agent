# WebChat Agent

Chrome 扩展:把任意 OpenAI 兼容的 LLM 接入浏览器,让它能操作你的小红书 / YouTube / 知乎 / 微博 等已登录站点。**自带 API Key**,你出推理算力,扩展出工具生态 + 操作执行。

```
SidePanel ──► Service Worker ──► OpenAI-compatible API (DeepSeek / OpenAI / GLM / Kimi / ...)
                  │                          │
                  │◄────── tool_calls ───────│
                  │
                  ├─► xiaohongshu / youtube / zhihu / ... (CDP-driven 或 USER_SCRIPT-world)
                  │
SidePanel ◄──── 回答 + tool trace
```

1. 在 SidePanel 输入消息
2. 扩展把消息 + 工具白名单走 `/chat/completions` 发给你配的 API
3. 模型走 OpenAI native function-calling 选工具
4. 后台执行该 adapter(CDP 抓数据 / 或 USER_SCRIPT-world func runner)
5. 把结果作为 tool result 发回模型,继续下一轮
6. 直到模型给出没有 tool_call 的最终回答

任何**写操作**(发帖 / 评论 / 关注 / 取关 / 下载)都会触发 SidePanel 弹窗二次确认,5 分钟不点视为拒绝。

## 安装(开发模式)

```bash
npm install
npm run build      # 输出到 dist/
```

然后 `chrome://extensions` → 打开开发者模式 → `加载已解压的扩展程序` → 选 `dist/` 目录。

**最低 Chrome 版本**:138+(因为 Phase B func adapter 用 `chrome.userScripts` API)。pipeline 型 adapter 不需要。

### 准备工作

- 打开 SidePanel,右上角菜单 → **LLM 后端**,选 provider / 填 Base URL / 粘贴 API Key / 选 model
- 兼容任何 OpenAI chat/completions 协议的 endpoint(DeepSeek 官方 API / OpenAI / 智谱 GLM / Moonshot Kimi / MiniMax / 自部署 vLLM 等)
- API Key 只存在本机 `chrome.storage.local`,清空设置即清空

**用市场里的 func 型 adapter(YouTube / 小红书 / 知乎 / 微博 等动态站点)**

- 需要在 `chrome://extensions` → WebChat Agent → 详情 → **「允许用户脚本」开关打开**(Chrome 138+ 默认关)
- 然后登录你要操作的站点(WebChat Agent 复用你的浏览器登录态,不存任何凭据)

## 使用

1. 点扩展图标打开 SidePanel
2. 顶部状态栏会显示当前 model;未配置 API Key 时显示 "API 未配置",点一下进设置
3. 输入框问问题。例子:
   - "搜 YouTube 上 'Codex Tutorial' 的视频,挑一个总结字幕"
   - "搜小红书上「Roborock 扫地机」的笔记,对比下口碑"
   - "我的小红书最近有什么新评论?"
   - "把 https://example.com 这页转成 markdown 给我"(走 generic tool)

## Adapter 市场

项目最大特性:**adapter 不需要重新 build 插件,运行时安装/卸载**。

- 内置 **284 个 adapter**(73 pipeline + 211 func),覆盖 27 个站点(twitter / linkedin / reddit / instagram / bilibili / youtube / zhihu / weibo / xiaohongshu / arxiv / wikipedia / claude / chatgpt / gemini / notebooklm / hackernews / lobsters / ...)
- 在 SidePanel → 菜单 → Adapters → **市场** tab 浏览、一键安装
- 也可以**贴码安装**:把 `@jackwener/opencli` 兼容的 adapter 源码贴进 SidePanel,一键 eval + 注册
- 安装的 adapter 走 IndexedDB 持久化,**跨 Chrome 重启自动恢复**

完整设计 / 决策记录 / 踩坑见 [docs/adapter-hot-plug.md](./docs/adapter-hot-plug.md)。要写自己的 adapter:看 opencli 的 [README](https://github.com/jackwener/opencli/),`cli({...})` 格式照搬即可。

## 通用工具(无需安装,10 个)

不需要从市场装,扩展自带的站点无关原语 — 让模型操作**任意**网站,不必为每个站点写专用 adapter:

| 工具                | 作用                                |
| ------------------- | ----------------------------------- |
| `open_url`          | 在新/已有 tab 打开 URL              |
| `get_page_text`     | 整页文本(配 readability-style 抽取) |
| `get_text_from_tab` | 同上但指定 tabId                    |
| `screenshot`        | 当前 tab 截屏                       |
| `scroll_page`       | 滚动指定 tab                        |
| `close_tab`         | 关闭 tab                            |
| `get_interactives`  | 列出页面所有可点 / 可填元素         |
| `click`             | 点指定坐标 / selector               |
| `click_by_text`     | 按按钮文本点击                      |
| `type_into`         | 往输入框填文本                      |

典型组合:`open_url` → `get_interactives` → `click` 或 `type_into` → `screenshot` 验证。

## 命令

```bash
npm run dev                 # Vite 开发模式(扩展开发建议 build + reload)
npm run build               # 打包到 dist/
npm test                    # vitest run
npm run typecheck           # tsc --noEmit
npm run lint / lint:fix     # ESLint
npm run format / format:check  # Prettier
npm run check               # typecheck + lint + format:check + test(CI 入口)
npm run import-adapter <path>  # build-time 同步 adapter(开发者用,非用户路径)

# 重建市场 index(从本地 opencli/clis/ 抓取)
node scripts/build-marketplace-index.mjs --popular  # 默认 popular allowlist
node scripts/build-marketplace-index.mjs --all      # 全部 ~700 个
```

## 架构

详细见 [docs/architecture.md](./docs/architecture.md)。简表:

- `src/background/service-worker.ts` — 消息路由 + agent 编排入口 + WRITE_CONFIRM 弹窗
- `src/agent/` — api-engine(OpenAI /chat/completions 驱动)+ session 持久化 + system prompt
- `src/tools/` — manifest + dispatcher + 10 个 generic tools
- `src/runtime/` — PageShim(CDP)+ registry + opencli pipeline 解释器
- `src/sandbox/` — Phase A:MV3-CSP-clean adapter 源码 eval(sandboxed iframe)
- `src/userscript/` — Phase B:USER_SCRIPT-world runner + RPC 桥
- `src/adapters/` — install-manager + IndexedDB persistence
- `src/sidepanel/` — Preact UI(聊天 + 工具 trace + 菜单 + Adapters / 历史 / 日志 页)

## 安全 / 边界

- **写操作 adapter 默认隐藏**:`access: 'write'` 工具不出现在首轮工具摘要里,模型必须显式 `describe_tool` 才知道存在;调用时**强制** SidePanel 弹窗二次确认(5 分钟超时)
- **限流自我保护**:`RateLimitedError`(检测到 captcha 跳转)会被 dispatcher 包装成结构化错误,prompt 明确要求不要重试
- **CDP 权限**:仅在调 adapter 时 lazy attach,结束即 detach;chrome.debugger 的"is being debugged"黄条只在目标站点 tab 出现
- **不存储任何凭据**:复用你浏览器已有的登录态,扩展不读 / 不存 password / cookie / api key 之外的内容(API key 走 chrome.storage.local,可在设置面板清空)

## 故障排查

| 症状                                                               | 检查                                                                                                                                                                      |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SidePanel 顶上 "API 未配置"                                        | 菜单 → LLM 后端,填 provider + Base URL + API Key + Model                                                                                                                  |
| Phase B func adapter 装不上 / 装上跑不动                           | Chrome 138+?`chrome://extensions` 详情页「允许用户脚本」开了没?                                                                                                           |
| YouTube/小红书 等装好的 adapter 突然不工作                         | 站点 DOM/API 改了?或是上游 opencli 修了 — `node scripts/build-marketplace-index.mjs --popular` 拉新 + uninstall + reinstall 该 adapter(老 source 留在 IndexedDB,要手动换) |
| `ReferenceError: parseVideoId is not defined`(或类似 utility 函数) | adapter source 没 bundle 进相对 import,详 [adapter-hot-plug.md §10.8](./docs/adapter-hot-plug.md) — 重建市场 index 后必须 uninstall + reinstall                           |
| youtube/search 返回 `[]` 但页面明明有结果                          | 跨 world 隔离,详 [adapter-hot-plug.md §10.7](./docs/adapter-hot-plug.md);如果是 2026-05 之后的 build 该问题已修                                                           |
| Service Worker 被 Chrome 杀(长任务跑一半中断)                      | 已知限制 — 任务尽量切小,或开 SidePanel 保活(SidePanel 打开就 keepalive)                                                                                                   |
| `chrome.debugger` 黄条让人不舒服                                   | adapter 跑完会自动 detach;如果一直在那说明有 adapter 在跑                                                                                                                 |

## 限制

- Service Worker 可能被 Chrome 杀(>30s 无活动)→ 长任务可能中断;SidePanel 打开时有 keepalive 缓解
- 工具调用串行(单轮一个 tool_call 一个 tool)
- 装好的 marketplace adapter 升级要手动 uninstall + reinstall(等加 source schema 版本号自动迁移)

## 历史

早期版本支持 "chat-tab 模式":hijack 一个已登录 DeepSeek 网页做推理,零 API Key。后来去掉了 — 一套代码扛两种 backend(SW 里的 tab 跟踪、UI 里的 paused/resume banners、连续性恢复)比开销大,而 API 模式 + 自己出 key 既稳又通用。早期那条路径相关代码全部移除。

- **opencli**([@jackwener/opencli](https://github.com/jackwener/opencli)):adapter 源生态,我们的市场内置 bundle 是从它的 `clis/` 抓的
- **xiaohongshu-operator**:历史前身,纯 CDP-only 单站点版,代码已不在本项目里

## License

MIT
