# Adapter 运行时热插拔 + 市场 — 架构与决策记录

> 决策记录(ADR)。记录"不重 build 即可安装/卸载 adapter,并做成市场"这一功能的架构与关键取舍。
>
> **状态(2026-05 更新)**:**Phase A 和 Phase B 都全部落地,真实 Chrome 端到端验证通过**。
>
> - Phase A:用户从市场一键装 `zhihu/hot`(pipeline)→ agent 自动调用 → 抓到热榜数据 ✓
> - Phase B:用户从市场一键装 `xiaohongshu/search`(func)→ agent 自动调用 → 在已登录 tab 里 navigate + evaluate + scroll + extract → 抓到笔记列表 ✓
>
> **当前状况**:
>
> - 市场内置 284 个 adapter(73 pipeline + 211 func,覆盖 27 个热门站点)— 见 `marketplace/index.json`
> - pipeline 型装完即用,**零额外配置**
> - func 型需 **Chrome 138+** 且用户在 `chrome://extensions` 详情页打开「允许用户脚本」开关
> - `src/tools/` 已清理:不再有内置 site adapter,只剩 `generic/`(站点无关的 open_url/screenshot/click/...),其他 site 全走市场
>
> **分支**:`feat/adapter-hot-plug-marketplace`。最后更新:2026-05。
>
> **关键 commits 链**(按时间):
>
> - `c7c8014` A1 sandbox eval 宿主
> - `3658b08` A2 后端(install-manager + IDB)
> - `37a4904` A2 前端(SidePanel sandbox host + Adapters UI)
> - `4318659` A3 市场客户端 + index 生成 + bundled 122 pipeline
> - `f8e54e0` B1 in-page runner 可测核心
> - `e7e8bff` B2a rpc-server(SW 侧 PageShim 兑现 page.\*)
> - `0afecac` B2b chrome.userScripts 接线
> - `677ac09` A3 finish:市场 UI 真正 wired
> - `613ae04` pipeline 加 `wait` 步骤
> - `a9c0371` Task 3:session 内热刷 tool catalog
> - `01b53cf` 市场扩展到 345 个含 func
> - `159c439` dispatcher routing 顺序修复
> - `5fe4f6e` 跨 world DOM marker
> - `781956b` USER_SCRIPT 端口走 onUserScriptConnect
> - `9ea8280` goto trampoline lenient URL 匹配
> - `cf1cc6b` 删内置 xiaohongshu/hackernews(让市场唯一供应)
> - `4ed3527` docs: Phase B done + 4 pitfalls + clean up stale tree references
> - `e20daa0` page.evaluate→MAIN world(§10.7)+ marketplace bundle relative imports(§10.8)
> - `1648e84` Phase B 三连修(zhihu/answer-detail 端到端): NavigateRestart 改 Error 子类 + deep-scan(§10.10) + `lastNavigatedUrl` 旁路解决 server-redirect 死循环(§10.11) + `getCurrentUrl` 改 async 对齐 PageShim(§10.12)
> - `<next>` 市场布局 v2:从单 2MB JSON 切到 `marketplace/<site>/<name>.js` per-file + sha256 + 远程友好 schema(§11)
> - `<next+1>` `node:*` shim:rewriter + 纯 JS MD5,bilibili/zhihu 等需要 node 内建的 adapter 可用(§10.13)
> - `<next+2>` 从内置市场剔除 binance/coingecko/dictionary/facebook/hupu/nowcoder/pixiv/pubmed/steam/xiaoe:345 → 284 个 adapter,27 个站点

## 0. 动机(用户原话)

> "我最主要的诉求是不需要每次重新 build 插件才能应用新的 adapters,甚至做成有一个 adapters 市场,用户可以选择性安装对他有用的 adapters,或者自己写 adapters 但不需要重新 build 插件,**因为用户并没有这个插件的完整代码**。"

最后一句是硬约束:用户**无法 build** → 运行时安装不是优化项,是唯一可行路径。build-time 捆绑(`import-adapter.mjs` + `_all.ts`)只适合开发者预置内置 adapter,无法满足终端用户。

## 1. 核心难点:MV3 的 eval 禁令

安装一个 adapter = 把它的源码"激活"成 registry 里一条可执行的定义。源码里有 `cli({...})`,要拿到这个定义就得**执行这段源码**。但:

- Service Worker 的 CSP **禁止 `eval` / `new Function`**。
- 普通 content script 同样受扩展 CSP 限制。

所以"在哪 eval 一段不可信源码"是整个功能的技术核心。三条候选 venue(均已查证官方文档):

| Venue                                       | eval 能力                                   | 额外权限           | 用户开关                                          | 隔离                              |
| ------------------------------------------- | ------------------------------------------- | ------------------ | ------------------------------------------------- | --------------------------------- |
| **sandboxed iframe**(`sandbox.pages`)       | 默认 CSP 含 `unsafe-eval`                   | 无                 | **无**                                            | 最强(opaque origin,无 `chrome.*`) |
| **userScripts world**(`chrome.userScripts`) | `configureWorld({csp:'…unsafe-eval'})`      | `"userScripts"`    | **要**(Chrome138+「允许用户脚本」,代码无法自动开) | 中(world 隔离,可配 messaging)     |
| **CDP 注入**(`chrome.debugger`)             | `Runtime.evaluate`(网页 world,不受扩展 CSP) | `"debugger"`(已有) | 无(黄条)                                          | 弱(直接在真实页面)                |

## 2. 决定性分野:pipeline 型 vs func 型

这是比"选哪个 venue"更重要的事实。opencli adapter 有两类:

|          | pipeline 型(opencli 大多数,且在增多)                         | func 型(命令式 `page.*`,如小红书)                                          |
| -------- | ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| 定义本质 | 纯数据 `{site,name,args,pipeline,...}`                       | 含 `func` 闭包,**不可序列化**                                              |
| 装载     | eval 一次 → 提取纯数据                                       | eval → 但 func 存不下,只能存**源码字符串**                                 |
| 运行     | 现有 `pipeline.ts` 解释器跑,**运行期再不碰 eval/任何 venue** | func 必须**常驻**某个能 eval 的 venue;每次调用 RPC;func 里 `page.*` 再 RPC |
| 难度     | 低                                                           | 高                                                                         |

**关键洞察**:pipeline 型一旦装载提取成纯数据,运行期就和 venue 完全脱钩——venue 只在"安装那一刻"用一次。func 型则相反,func 要在 venue 里**常驻并反复调用**。

## 3. 决策

### 3.1 pipeline 型:sandbox 提取一次 + SW 解释器运行(已定,A1 已实现)

- 安装时用 **sandboxed iframe** eval 源码,捕获定义(纯数据),存 IndexedDB。
- 运行时用现有 `runtime/opencli/pipeline.ts` 解释器跑,**不碰 sandbox**。
- 为什么不是 userScripts:pipeline 提取是"eval 一段纯数据声明",userScripts 那套"在网页注入脚本 + 用户开关"对它是**杀鸡用牛刀**(用户已认同)。sandbox 零权限零开关零卖点损耗,且 capture 逻辑(`eval-core.ts`)venue 无关、可 node 单测。

### 3.2 func 型:userScripts 主路径(Phase B,**已完成**)

用户偏好:**"如果两者都能实现,我会优先 userScripts。"** sandbox 不完全排斥,作为 fallback。

为什么 func 型上 userScripts 确实有技术优势(重新核实 `page.*` 调用频率后得出):

```
 874 page.evaluate   ← DOM 操作,userScript world 有 DOM → 本地直接跑,无需 RPC
 553 page.wait       ← setTimeout,本地
 400 page.goto       ← 导航,需 RPC 回 SW(chrome.tabs)或会话内处理
  58 page.getCookies ← 需 chrome.cookies → RPC
  19 page.screenshot / snapshot / captureNetwork / native* → 需 CDP → RPC
```

- **userScripts world 跑 func**:占调用 ~90% 的 `evaluate`+`wait` 在网页 world **本地**执行,只有 goto/getCookies/CDP 类才 RPC 回 SW。RPC 流量小。
- **sandbox+offscreen 跑 func**:sandbox 里**没有目标页面**,因此**每个** `page.*` 都得 RPC 回 SW 走 CDP。双向桥更重。

→ 这是 func 型上 userScripts 优于 sandbox 的**实在理由**,与用户偏好一致。

**但必须诚实记录 func 型 via userScripts 的未决问题(Phase B 开工前要先验证):**

1. **驱动模型不匹配**:opencli func 的范式是"从后台**驱动**一个 tab(开页→导航→抓取)"。userScripts 是**响应式**的(页面加载时注入),不是编排式。`page.goto` 会导航离开、销毁注入的脚本上下文 → func 跨导航的状态怎么续?需用 `userScripts.execute()`(Chrome135+)按需注入到指定 tab 验证。
2. **用户开关**:Chrome138+「允许用户脚本」开关用户必须手动开。用户已同意零配置降级,接受。
3. **后台执行**:SidePanel 关闭、用户不在目标 tab 时,func 怎么跑?可能仍需配合一个常驻 venue。
4. **`page.*` 桥接复杂度**:即便 evaluate 本地化,goto/cookies/CDP 仍要一套 world↔SW RPC + write-confirm 门控。

→ 因此 func 型列为 **Phase B**,在 pipeline 型(Phase A)落地验收后再做,且开工前先做一个 userScripts.execute spike 验证"驱动模型"是否成立。若不成立,回落 sandbox+offscreen。

## 4. 数据流(Phase A,pipeline 型)

```
安装:
  市场/贴码 ──源码str──► SW ──postMessage{EVAL_ADAPTER,src}──► sandboxed iframe
                                                              │ stripModuleSyntax + 注入 cli/Strategy/errors/utils
                                                              │ new Function 执行 → 捕获 cli() 定义(纯数据)
                              ◄──postMessage{EVAL_RESULT,defs}─┘
  SW: 校验(pipeline 型?)→ 存 IndexedDB → registerCommand 进 registry → 广播刷新

运行(已有路径,几乎不改):
  dispatcher.executeAdapter → lookupAdapter(内置+已装合一)→ pipeline 分支 → runPipeline
```

## 5. 关键构建发现(A1 spike)

**@crxjs 不支持 sandbox 页**:它给每个页面脚本套一个 `chrome.runtime.getURL` 的 loader(sandbox 里没有 `chrome.*`),还会在 sandbox HTML 里留下未解析的文件名占位符。

→ 解法:一个小 Vite 插件(`vite.config.ts` 的 `sandboxPagePlugin`)**自己产出 sandbox 产物**:esbuild 把 eval 宿主打成一个 IIFE,**内联**进自包含的 `dist/sandbox.html`(无 module loader、无 `chrome.*`),并在 `closeBundle`(@crxjs 写完 manifest 之后)往 built manifest 里补 `sandbox.pages` + `web_accessible_resources`。`manifest.json` 源文件不声明 sandbox,避免被 @crxjs 处理。

## 6. 文件清单

**已建(A1)**

- `src/sandbox/eval-core.ts` — 纯函数:`stripModuleSyntax` + `evalAdapterSource`(注入作用域、捕获、分类 pipeline/func、序列化)。node 可单测。
- `src/sandbox/eval-host.ts` — sandbox 内消息宿主(`EVAL_ADAPTER`→`EVAL_RESULT`,`SANDBOX_READY`)。
- `src/sandbox/sandbox.html` — 源(实际产物由 Vite 插件内联生成)。
- `tests/eval-core.test.ts` — 喂真实 opencli 源码(binance/depth、func adapter)断言捕获/分类/clone 安全。
- `vite.config.ts` `sandboxPagePlugin` — 自产 sandbox.html + 补 manifest。

**A2 安装管线**(✅)

- `src/adapters/installed-store.ts` — IndexedDB(同 DB v2 与 `agent/session-store.ts` 共存)
- `src/adapters/install-manager.ts` — installFromCaptured / loadOnBoot / setEnabled / uninstall + classifyKind/isRunnableNow
- `src/runtime/registry.js` — `unregister(site,name)` + `_installed` 标 + **`_version` 版本号**(Task 3 用)
- `src/background/service-worker.ts` — 消息路由(INSTALL/LIST/UNINSTALL/SET_ENABLED/ADAPTERS_CHANGED) + boot 恢复 + Phase B onConnect 路由
- `src/sidepanel/sandbox-host.ts` — SidePanel 持有隐藏 sandbox iframe 转发 eval

**A3 市场**(✅)

- `src/core/marketplace.ts` (moved from `src/sidepanel/` when localmd Connect landed) — fetchMarketIndex + entryId + FEATURED_IDS
- `scripts/build-marketplace-index.mjs` — 从 opencli `clis/` 生成 index.json(支持 `--popular` site allowlist)
- `src/sidepanel/Adapters.tsx` — 「已安装」「市场」双 tab + 贴码安装 + 启用/卸载 + 类型筛选 + Phase B 警告 + 安装结果分类 toast
- `marketplace/index.json` — 默认 bundle,**284 个 adapter**(73 pipeline + 211 func,27 个热门站点)

**Phase B func 型**(✅)

- `src/userscript/run-in-page.ts` — in-page runner 可测核心(makeLocalPage、evalAdapterKeepingFuncs、sameLogicalPage、runAdapterInPage)
- `src/userscript/rpc-server.ts` — SW 侧用 PageShim 兑现 chrome._/CDP 类 page._ 方法
- `src/userscript/protocol.ts` — 共享 port 消息类型(PORT_NAME、WORLD_ID、INIT/RPC/DONE/NAVIGATE_RESTART)
- `src/userscript/runner.ts` — Vite 打包成自包含 IIFE `dist/userscript-runner.js`
- `src/userscript/sw-runner.ts` — `configureWebWorld` + `handleRunnerPortConnect` + `runInstalledFuncAdapter` 编排循环
- `src/userscript/chrome-userscripts.d.ts` — 类型补丁(`@types/chrome` 比 Chrome 138 落后)
- `manifest.json` — `"userScripts"` 权限 + WAR + minimum_chrome_version 138
- `vite.config.ts` — esbuild 把 runner.ts 打成 self-contained IIFE
- `src/tools/dispatcher.ts` — `_userScriptSource` 分支前置(在 pipeline-fail return 之前)

### Phase B 可行性结论(实测,回答"opencli func adapter 能否转换后用 userScripts 跑")

**能,且几乎零改造。** 扫描整个 opencli func 语料(~700 个):

- **~526(75%)func 体内不调 `page.goto`** —— 靠 host 导航(`domain`/`navigateBefore`),只在已加载页面上 `evaluate`/`scroll` 抓取。**原样**就能在页内 world 跑。
- **~170(24%)只调一次 `page.goto`**(goto-at-top → 抓取,如 youtube/zhihu/github search)。用 **navigate-then-reinject 蹦床**通用处理,无需逐个改:`goto(url)` 若不在目标 url 则 RPC SW 导航 + 抛 `NAVIGATE_RESTART`;SW 导航后**重新注入**;func 从头再跑,goto 此时 no-op,继续抓取。
- **~4 个调两次 goto**(交错有状态)+ CDP 重度的 → 回落现有 CDP `PageShim`。

`userScripts.execute()` 是否返回值不影响:注入脚本用 `chrome.runtime` 消息(`onUserScriptMessage`,已证支持)把结果传回 SW。代价:Chrome 138+ 需用户手动开每扩展「允许用户脚本」开关(用户已接受,零配置已降级)。

## 7. 安全(贯穿)

- 安装 = 执行第三方代码。sandbox 已隔离(无 `chrome.*`、opaque origin、eval 出不去)。
- pipeline 型运行期仅跑解释器 + 受限 fetch,较安全。
- func 型(Phase B)能驱动用户**已登录**标签页 → 强安装警告 + 复用 write-confirm 门控 + 来源标识。
- 市场 index 与源码分离托管;UI 常驻"仅安装可信来源"提示。

## 8. 实施顺序

1. **A1**(✅ `c7c8014`):sandbox eval 宿主 + capture + 构建产物
2. **A2**(✅ `3658b08` + `37a4904`):安装管线 + IndexedDB + registry 卸载 + SW 路由 + boot 恢复
3. **A3**(✅ `4318659` + `677ac09`):市场客户端 + index 生成 + Adapters UI(双 tab + 类型筛选 + 类型 chip + Phase B 警告)
4. Phase A 真实 Chrome 验证(✅ zhihu/hot 装即用、navigate + evaluate + scroll + map 链路通)
5. **B1**(✅ `f8e54e0`):可行性实测 + in-page func runner 可测核心
6. **B2a**(✅ `e7e8bff`):SW 侧 page.\* RPC 服务端(fulfillRpc + PageShim)
7. **B2b**(✅ `0afecac` + 4 个 fix):chrome.userScripts 接线 + dispatcher 路由 + 权限/开关
8. Phase B 真实 Chrome 验证(✅ xiaohongshu/search 装即用、navigate + evaluate + scroll + extract 链路通)
9. **后续清理**(✅ `cf1cc6b`):删内置 xiaohongshu/ + hackernews/,让市场成为 site adapter 的唯一供应,`HIDDEN_BY_DEFAULT` 泛化为 `access === 'write'`

## 9. Phase B 完整数据流(实测验证)

```
用户在 SidePanel 点「安装 xiaohongshu/search」
       │
       ▼
SidePanel sandbox iframe ─ new Function(source) → 捕获 cli() 元数据
       │  (注:func 闭包没法 postMessage,只设 hasFunc:true)
       ▼
INSTALL_ADAPTER 消息 → SW
       │
       ▼
installFromCaptured → IDB 存 (id=xiaohongshu/search, source=完整 14KB)
       │            → registerDef 把 entry 注册进 live registry,
       │              {site, name, _userScriptSource: source, _installed: true}
       ▼
广播 ADAPTERS_CHANGED → SidePanel UI 刷新,Task 3 hot-refresh 让 agent
                       下一回合就看到新工具

──────  调用时(agent 选了 xiaohongshu__search)  ──────

agent → executeAdapter('xiaohongshu__search')
       │
       ▼
lookupAdapter 拆 site__name → 找到 def 带 _userScriptSource
       │
       ▼
dispatcher 路由到 runInstalledFuncAdapter:
   1) humanPaceForSite(0.6–1.8s 抖动)
   2) ensureSiteTab → 复用或开 https://www.xiaohongshu.com/
   3) createPageShim(tabId) → 懒附加 debugger
   4) chrome.userScripts.execute({worldId:'web-runner',
                                  js:[{file:'userscript-runner.js'}]})
       │
       ▼
runner.ts (USER_SCRIPT world,自带 DOM + chrome.runtime.connect):
   - mark('loaded') DOM 属性
   - chrome.runtime.connect({name:'web-userscript-runner'})
   - mark('connected'), 发 READY
       │
       ▼ (跨 world 走 chrome.runtime.onUserScriptConnect,不是 onConnect!)
SW handleRunnerPortConnect → 找到 sessionsByTab[tabId] → 回发 INIT{
   source, site, name, kwargs, tabId
}
       │
       ▼
runner 收到 INIT → evalAdapterKeepingFuncs(source)  ← 在页内 new Function 拿回 func 闭包
       │
       ▼
runner 调 func(makeLocalPage(rpc), kwargs):
   - page.evaluate(WAIT_FOR_CONTENT_JS)         ─ 本地 globalThis.eval,不 RPC
   - page.goto(search_result_url)               ─ 触发 trampoline
       │  rpc('goto', {url}) → SW 只 ack 不真 navigate
       │  throw NAVIGATE_RESTART
       ▼
runner → DONE{status:'navigating', navigateUrl} → SW
       │
       ▼
SW outer loop: pageShim.goto(url) → CDP Page.navigate 真导航
       │                      → 等待 load
       │                      → 重新 chrome.userScripts.execute
       ▼
runner 二次注入 → 重新连 port → INIT 重发 → eval source → func 调 page.goto(url)
       │
       ▼
sameLogicalPage(loc.href, url) → true(origin+pathname 同,xsec_* 是额外)
       │  → goto no-op,继续往下跑
       ▼
page.evaluate(buildSearchExtractJs(...))  ─ 本地,DOM 抓取
page.evaluate(buildScrollUntilJs(limit))  ─ 本地,滚动
page.evaluate(buildSearchExtractJs(...))  ─ 本地,再抓
return data.slice(0, limit).map(...)
       │
       ▼
runner → DONE{status:'ok', value: [{rank, title, author, ...}, ...]} → SW
       │
       ▼
dispatcher 返回 tool result → agent 看见数据 → 总结回答用户
```

90% 操作在页内本地跑(evaluate/wait/scroll),只有 goto 触发 SW 走 CDP 导航。对 opencli 几乎零改造。

## 10. Pitfalls / 实测踩过的坑

Phase B 上 Chrome 真机调通时连续踩了 4 个坑。每个独立、连环触发(前一个不修后一个不会暴露),按发现顺序列出:

### 10.1 dispatcher 分支顺序 — installed func 撞「no func and no pipeline」

**症状**:`xiaohongshu__search cannot run: no func and no pipeline.`

**根因**:installed func 的 def 既无 `adapter.func`(被 sandbox capture 时序列化丢了)也无 `pipeline`(本来就是 func 型)。dispatcher 的 pipeline 失败分支位置太靠前:

```ts
if (typeof adapter.func !== 'function') {
  if (!Array.isArray(pipeline) || pipeline.length === 0) {
    return failed(...);  // ← 这里就 return 了
  }
  ...
}
// ↓ 我加的 _userScriptSource 分支在这下面,根本到不了
```

**修法**(`159c439`):`_userScriptSource` 分支提到 `lookupAdapter + validateArgs` 之后、`adapter.func` 检查**之前**。

**教训**:加新的执行路径,**别加在 fallback 失败 return 之后**。失败 return 是控制流的悬崖,过了就回不来。

### 10.2 跨 world 全局变量隔离 — diag marker 永远是 null

**症状**:runner 超时,diag `{marker: null}`,无法判断 runner 实际跑没跑。

**根因**:runner 在 USER_SCRIPT world 设 `window.__webRunner` 当 marker。SW 用 `PageShim.evaluate` 读它 —— 但 PageShim.evaluate 走 CDP `Runtime.evaluate`,**默认 MAIN world**。两个 world 的 `window` 是**同一对象但全局变量绑定隔离**。所以 marker 写在 USER_SCRIPT、读在 MAIN,永远读不到。

**修法**(`5fe4f6e`):marker 改用 **DOM 属性**(`document.documentElement.setAttribute('data-web-runner', ...)`)。USER_SCRIPT 和 MAIN 共享 DOM,属性两边都能读。

**教训**:**跨 world 通信只能走 DOM 或 postMessage**,不能走 globalThis。即使 `globalThis` 指向同一个 window object,各 world 看到的 binding 不同(包括自己写的 var、setter)。

### 10.3 USER_SCRIPT port 走独立事件 — onConnect 收不到

**症状**:runner DOM marker 显示 `status='connected'`(`chrome.runtime.connect` 成功 + `postMessage({type:'READY'})` 已调),但 SW 的 `chrome.runtime.onConnect` 监听器永远不响应,60s 超时。

**根因**:Chrome 故意把 USER_SCRIPT world 的连接路由到**独立事件** `chrome.runtime.onUserScriptConnect`(同理 `onUserScriptMessage` vs `onMessage`),跟普通 content script 隔离开,防止扩展意外把 user script 和 content script 串扰。文档里有但 quickstart 里没强调,坑很深。

**修法**(`781956b`):SW 注册 `chrome.runtime.onUserScriptConnect.addListener(handleRunnerPortConnect)`。原有 `onConnect` 仍处理 keepalive port,加了 catch-all log 暴露未来路由错。

**教训**:**新 API 引入新事件 ≠ 沿用旧事件**。`chrome.userScripts` API 整套消息/连接通道是平行的:`onMessage` vs `onUserScriptMessage`,`onConnect` vs `onUserScriptConnect`。下次接入新 Chrome API 先查事件矩阵。

### 10.4 goto trampoline strict-equal — 真实 URL 永远 != 请求 URL

**症状**:runner 成功 connect,触发 navigate,SW 导航成功,re-inject runner,**又**触发 navigate,无限循环 4 次到达 reinject cap 退出。

**根因**:trampoline 用 `loc.href === url` 判断「已经到了」。但 xiaohongshu(以及大多数真实站点)在导航后**自动给 URL 加 tracking 参数**:

```
adapter 请求: https://www.xiaohongshu.com/search_result?keyword=韬定律
实际 landed: https://www.xiaohongshu.com/search_result?keyword=韬定律&xsec_source=...&xsec_token=...
```

严格相等永真,goto 永远 throw,SW 永远 reinject。

**修法**(`9ea8280`):新建 `sameLogicalPage(current, requested)` 判定 —— 同 origin、同 pathname、请求方 searchParams 是当前方 searchParams 的**子集**。hash 忽略,额外 tracking 参数容忍。fallback 字符串相等保底。

**教训**:**网页 URL 是不稳定标识**。`location.href` 跟你刚 `pushState` 的 URL 不等比相等几率高。任何「已经到了吗」判断必须用语义比较(origin+pathname 是 ground truth,searchParams 是协商,hash 是 client-side state)。

### 10.5 race:fire-and-forget diag 跟 finally detach 抢资源

**症状**:第二次调用时 diag 报 `eval failed: Another debugger is already attached to the tab`。

**根因**:超时 handler 里 `void diagnose(...)` 是 fire-and-forget,然后立刻 `settle({...})`,runInstalledFuncAdapter 返回,dispatcher 的 `finally { page.detach() }` 跑了。diagnose 的 `page.evaluate` 还在异步路上,会触发 PageShim 的 ensureAttached 重新 `chrome.debugger.attach`。这次重附跟**下一次**调用的 attach 撞上 → "Another debugger is already attached"。

**修法**(`781956b` 同一 commit):await diag 再 settle,代价 ~50ms 超时延迟,无 follow-on attach race。

**教训**:**资源生命周期跨 async 边界时,fire-and-forget 是 race 工厂**。后台任务要么阻塞到 finally,要么持有独立的资源句柄(不共享被 finally 释放的那个)。

### 10.6 总结:为什么花了几小时

| 阶段                   | 看到的                      | 推断的           | 实际的                           |
| ---------------------- | --------------------------- | ---------------- | -------------------------------- |
| 第一次测               | 60s 超时,零日志             | 不知道哪一步死了 | execute 静默+ onConnect 不响应   |
| 加日志                 | execute resolve frames=1 ok | 注入成功了       | ✓                                |
| 加 globalThis marker   | marker 永 null              | runner 没跑?     | marker 跨 world 不可见(10.2)     |
| 改 DOM marker          | marker='connected'          | **真相**         | runner 跑完,SW 收不到 port(10.3) |
| 加 onUserScriptConnect | port 通了,goto loop         | trampoline 不对  | URL 不稳定(10.4)                 |

**关键启示**:**「无可见现象」的 bug 最贵**。每加一层诊断要确认它本身没 bug(我的 globalThis marker 就有 bug,误导了 1 轮)。**先验证诊断手段**,再用诊断结果推断真问题。

### 10.7 page.evaluate 跨 world 隔离 — adapter 拿不到 window.ytInitialData

**症状**:`youtube/search` 装好,trampoline + reinject 链路通,navigate 也对。但调用回来永远 `[]`,即使页面明明渲染出了视频列表。`channel`、`comments`、`video`、`transcript` 全军覆没。

**根因**:Phase B 把 PageShim(CDP `Runtime.evaluate`,**默认 MAIN world**)换成 USER_SCRIPT world 的本地 `globalThis.eval` 后,语义悄悄变了。opencli 的 youtube adapter 普遍长这样:

```js
const data = await page.evaluate(`window.ytInitialData`);
if (!data) return [];
```

`ytInitialData` 是 YouTube 自己的 JS 在 MAIN world 设的全局变量。USER_SCRIPT world 跟 MAIN world **共享 DOM,但 `globalThis` 绑定隔离** —— 这条规则在 10.2 已经踩过一次(diag marker),Phase B 文件头也写了。但 10.2 当时只把 marker 改成 DOM 属性,**没意识到本地化 evaluate 把这条隔离规则也送给了每一个 adapter**。

凡是读站点 bootstrap 全局(`ytInitialData` / `ytcfg` / `__NUXT__` / `__INITIAL_STATE__` / `window.__NEXT_DATA__` …)的 adapter 全部静默返回空数据。

**修法**(本次 commit):`'evaluate'` 加进 `RPC_METHODS` + `SERVER_METHODS`,`makeLocalPage` 不再自己 eval,RPC 回 SW 走 `PageShim.evaluate` → CDP `Runtime.evaluate` → MAIN world。`wait` / `scroll` / `autoScroll` 仍本地(DOM-only,无需跨 world)。

代价:每次 evaluate 多一跳 RPC(USER_SCRIPT → SW → CDP → 回程)。874 个 evaluate 调用都吃这个代价。但是没别的办法 —— 跨 world `globalThis` 隔离是 Chrome 平台行为,只能走 CDP(或者每个 adapter 手写 MAIN-world script-injection 桥,~100 个 adapter 的工作量)。

**教训**:**把执行环境换走时,要把语义对齐也算进迁移成本**。10.2 用 DOM 通信解决了 marker,但只是补丁,没把"USER_SCRIPT 看不到 MAIN globals"这条规则一般化到 adapter 评估面。换执行环境的时候,要逐条对照 page.\* API 的旧语义,而不是只看"调用还能不能编译过"。

**还有一条**:**「相同 API,默认世界变了」是最隐蔽的 breaking change**。`page.evaluate(js)` 函数签名一字未改,但 `js` 跑的世界从 MAIN 切到 USER_SCRIPT。零编译错、零类型错、零 runtime 异常 —— 只有"返回空"。下次替换底层执行器之前先列一张表:哪些方法语义跟"在哪个世界跑"耦合,迁移后逐条断言。

### 10.8 marketplace 把 source 原样存进 JSON — 相对 import 运行时蒸发

**症状**:`youtube/search` 修好之后,`youtube/transcript` 立刻报 `ReferenceError: parseVideoId is not defined`。`video`、`like`、`comments`、`subscribe` 一连串都中招。

**根因**:opencli 的 adapter 文件普遍长这样:

```js
import { extractJsonAssignmentFromHtml, parseVideoId, prepareYoutubeApiPage } from './utils.js';
// ...
const videoId = parseVideoId(kwargs.url);
```

`scripts/build-marketplace-index.mjs` 把每个 adapter 文件**原文**塞进 `marketplace/index.json` 的 `source` 字段。运行时 `stripModuleSyntax` 把整条 `import ...;` 删掉,留下的符号靠 eval scope 注入 —— 但 scope 里只有 `@jackwener/opencli/*`(`cli`、`Strategy`、errors)。`./utils.js` 的 `parseVideoId` 没人给,直接 ReferenceError。

`youtube/search` 没踩到是因为它纯自包含,没有 sibling 依赖。一去看其它就发现 marketplace 里 **123 个**adapter 有 `from './*'` 相对 import,跨各种站点(reddit、linkedin、weibo、zhihu、xiaohongshu…),全在等同样的雷。

**修法**(本次 commit):builder 引入 esbuild,对每个有相对 import 的 adapter 做 in-memory bundle:

```js
await esbuild({
  entryPoints: [entryPath],
  bundle: true,
  format: 'esm',
  external: ['@jackwener/opencli/*'],  // 留 top-level import,运行时由 strip + scope 处理
  ...
});
```

sibling 工具函数全部 inline 到 `source` 字段;`@jackwener/opencli/*` 仍是 top-level import(原有 strip + scope 路径不变)。bundle 失败时 fallback 到原 raw source 并 warn(twitter/zhihu 的某些 adapter 有 transitive `node:fs` 依赖,跑不了 —— 行为不变)。

**索引体积代价**:1.5 MB → 2.0 MB(+38%),因为大文件多了 inline 的 sibling 代码。`youtube/transcript` 27 KB → 33 KB。这不是问题,索引整体仍在 1 个 HTTP 请求量级。

**用户操作雷**:老的坏 source 已经持久化在 IndexedDB(`installed-store.ts` 的 `source: string` 字段)。**单纯 reload 扩展不会自动迁移** —— 用户必须 uninstall + reinstall 受影响 adapter,install path 才会从新 marketplace 读到 bundle 后的 source。下次如果还要改 source 序列化,要么在 install-manager 加 "source schema version"+迁移逻辑,要么至少在 UI 显示一个 "marketplace 已更新,请重装" 的提示。

**教训**:**marketplace 化 = 自包含化**。源文件靠文件系统隐式解析 `./xxx.js`,marketplace 靠一个字符串 —— 文件系统给的方便**必须显式 inline 进字符串**,否则全是"看起来在,运行时不在"的幽灵依赖。

**还有一条**:**单测覆盖"装得上"不等于"跑得动"**。我们 Phase A/B 验证都是手动跑端到端,通过一两个自包含的 adapter(xiaohongshu/search、hackernews)就过了 —— 它们恰好没相对 import。如果当时挑一个带 `./utils.js` 的 adapter 验,这条雷在 Phase A 就该爆。**端到端验证的选样要刻意覆盖代码形态多样性**,不要只挑最简单的跑通就盖章。

### 10.9 这两条共同的根

10.7 和 10.8 看起来一个是 runtime/world 问题、一个是 build/marketplace 问题,但根上是同一件事:**当一个 adapter 从"开发态本地文件 + 完整 Node/CDP 环境"搬到"marketplace 字符串 + USER_SCRIPT world + RPC 桥",所有隐式假设都需要逐条对齐**。10.7 是执行环境的隐式假设(默认 world = MAIN);10.8 是模块解析的隐式假设(`./utils.js` 找得到)。

下次再做"把 X 搬到 Y"的迁移时,先列一张**隐式假设清单**(执行 world、模块解析、`chrome.*` 可用性、CSP、`globalThis` 绑定、storage 路径、网络鉴权 cookie 容器…),逐条对照新环境给不给,不给的怎么补。比"做完再测"省的不是一两小时。

### 10.10 goto trampoline 抛**裸对象** — 被 adapter try/catch 一吞就死

**症状**:`zhihu__answer-detail` 报

```
CommandExecutionError: Failed to open Zhihu answer 2040071767796995118: [object Object]
```

**根因**:Phase B 的 `page.goto` 用 **navigate-then-reinject trampoline**:发 RPC 让 SW 准备好导航,然后抛一个标记物给 runner,runner 把它 map 成 `status:'navigating'` 让 SW 真正导航 + 重注入。原实现抛的是**裸对象** `{ [NAVIGATE_RESTART]: true, url }`(不是 Error 子类),作者写过注释说 "Tagged property so detection works across the eval boundary where `instanceof` is unreliable"。

但**多数 opencli 适配器假设 `page.goto` 是 fail-safe 的**(在原生 puppeteer 控制器视角下,goto 失败 = 网络挂了/URL 错了,值得报错),所以**包了 try/catch + 重新 throw**。`zhihu/answer-detail.js` 的真实写法:

```js
try {
  await page.goto(`https://www.zhihu.com/answer/${answerId}`);
} catch (err) {
  throw new CommandExecutionError(
    `Failed to open Zhihu answer ${answerId}: ${err instanceof Error ? err.message : String(err)}`,
    ...
  );
}
```

两层伤害一次性触发:

1. `err` 是裸对象,`err instanceof Error` 为 false,走 `String(err)` → **`[object Object]`**(用户看到的没用错误信息)
2. adapter 把它**重新包成 `CommandExecutionError`** 扔出去,runner 的 catch 用 `isNavigateRestart` 检查时只看顶层那一个 CommandExecutionError → false → `status:'error'`,**SW 永远不会真正导航**。

也就是说,**adapter 一行 try/catch + 一行 rewrap 就能完全瘫痪 trampoline 协议**。zhihu 是第一个撞上,但这个失败模式对任何包了 goto 的 func 适配器都成立。

**修法**(commit `<next>`):两层互补,光做第一层不解决导航没触发,光做第二层 stringify 还是难看。

1. **`NavigateRestart` 改 Error 子类**(`src/userscript/run-in-page.ts`)
   - 新 `class NavigateRestartError extends Error implements NavigateRestart`,保留 `[NAVIGATE_RESTART]: true` 标记 + `url` 属性。
   - 关键:**把 marker 字符串嵌进 `.message`**:`super(\`${NAVIGATE_RESTART}|${url}\`)`。`String(err)`不再是`[object Object]`,而是 `NavigateRestart: **web_navigate_restart**|<url>`— 即使被 adapter`${err.message}` 插值进新错误也保留可恢复信号。

2. **`findNavigateRestart(e)` 深扫描器**
   - 顶层 tag 检测(原 `isNavigateRestart`)。
   - 走 `.cause` 链(应付 `new Error(msg, {cause: err})` 这种现代写法)。
   - **正则扫 `.message`** 抠出 URL —— 这一条才是真正救 zhihu 的:adapter 把 `${err.message}` 插进新错误的 message 里,深扫描 regex `${NAVIGATE_RESTART}\|([^\\s"'\`]+)` 还能从 CommandExecutionError 的 message 里把 URL 抠回来。
   - 6 层递归上限防 self-referencing cause 死循环。

3. **`runAdapterInPage` catch 改用 `findNavigateRestart`**(不再是浅层 `isNavigateRestart`):即使 adapter 包了 goto,runner 也能拿回 URL 并报 `status:'navigating'`,SW 继续做导航 + 重注入。

4. **`fmtError(e)` 兜底**:plain 对象走 `JSON.stringify` 而不是 `String()`,避免任何剩下的 `[object Object]` 漏出来。已替换 `userscript/{run-in-page,runner,rpc-server,sw-runner}.ts` 里所有 `e instanceof Error ? ... : String(e)` 调用。

**测试**(`tests/run-in-page.test.ts`):3 个新 it 单测覆盖 (a) 直接 throw、(b) `cause` 包装、(c) `${err.message}` 插值包装(模仿 zhihu 真实 catch+rewrap),外加 `runAdapterInPage` 端到端跑一个 zhihu-shaped wrapper adapter 确认能恢复 `status:'navigating'`。一共 +12 单测,共 172 全过。

**教训**:trampoline 用 **throw** 触发 SW 协作的设计**天生脆**——只要 adapter 包 try/catch 就可能吞掉信号。备选 robust 方案是让 SW 收到 goto RPC **立即**触发导航(让 tab 上下文炸掉、runner 自然死亡),`await page.goto` 永远不 resolve、永远不 throw、adapter 永远走不到 catch 那一行;但这要求 SW 把 "port disconnected 是不是预期" 分清楚,改动较大。当前选**marker-survive-wrapping**(让信号在被包过之后依然能被深扫到)是更小更稳的局部修。下次设计**跨边界的协议**(throw、reject、postMessage)时,要预判**对手代码会不会无意中拦掉它**(try/catch、message 改写、promise 链断点),并设计**冗余信号通道**(tag prop + message regex + cause 三路都行)。

### 10.11 goto trampoline 在 server-redirect 下死循环 — sameLogicalPage 救不了

**症状**(10.10 修完之后才暴露,因为 10.10 之前直接被 `[object Object]` 报错挡住了):

```
zhihu__answer-detail: adapter exceeded 3 navigate-reinject cycles
```

SW log 4 次同样的反复:

```
runner requested navigate to https://www.zhihu.com/answer/2043942734407496358
navigating tab=... → .../answer/2043942734407496358 (iter 1/4)
[page navigates, runner reinjects]
runner requested navigate to https://www.zhihu.com/answer/2043942734407496358   ← 又来
navigating tab=... → .../answer/2043942734407496358 (iter 2/4)
[...iter 3/4, iter 4/4 一模一样...]
```

**根因**:zhihu 把 `/answer/<aid>` **301/302 重定向**到 canonical 路径 `/question/<qid>/answer/<aid>`(`zhihu/answer-detail.js` 代码注释里就提了这件事,说"works even when the caller did not supply the parent question id")。Phase B trampoline 重注入后:

1. 新 runner 在 `/question/456/answer/123` 起来
2. adapter 头一句 `await page.goto('https://www.zhihu.com/answer/123')`
3. `sameLogicalPage(loc.href, requested)` 检查:
   - 同 origin ✓
   - **同 pathname ✗** —— `/question/456/answer/123` !== `/answer/123`
   - **返回 false**
4. 触发 RPC + throw NavigateRestart → SW 再次导航 → zhihu 再次重定向 → 反复 → 4 圈打满 → `adapter exceeded N navigate-reinject cycles`

`sameLogicalPage` 写的时候只考虑了 **server 加 query 参数**(xsec*source、xsec_token、utm*\*)和 hash 漂移 —— 那是 lenient 比较的初衷。但它**没考虑 pathname 重定向**,因为 query-only 差异是绝大多数 SPA 的实际行为,pathname 重定向比较少见。zhihu 是个反例:它真的把 `/answer/<aid>` 跳到不同 pathname。

> 想"在 `sameLogicalPage` 里直接放宽路径匹配"的诱惑很大,但这样很危险:`/answer/123` 可能被错误地匹配到任何带 `/answer/123` 子串的页面。需要的不是"更宽的相等定义",而是"明确告诉 runner 这次导航是我帮你做的"。

**修法**(commit `<next+1>`):**在协议里加一条 SW→runner 的旁路通道,直接告知"我刚帮你导到 X 了"**,而不是让 runner 再去推断。

1. **`InitMsg.lastNavigatedUrl?: string`**(`src/userscript/protocol.ts`):
   - 第一次注入:`undefined`
   - 每次 SW 完成一次 navigate-reinject 循环后,下一次 INIT 把刚刚导航过的 URL 塞进来

2. **`LocalPageOptions.lastNavigatedUrl?: string` + trampoline 优先级**(`src/userscript/run-in-page.ts`):

   ```js
   async goto(url) {
     if (sameLogicalPage(loc.href, url)) return;       // 真正同一页
     if (lastNavigatedUrl && lastNavigatedUrl === url) {  // 我们刚帮你导过
       lastNavigatedUrl = undefined;                      // consume-once
       return;
     }
     await rpc('goto', { url, tabId });
     throw new NavigateRestartError(url);
   }
   ```

   `consume-once` 关键:adapter 在同一次 run 里再 goto 同 URL,就该走正常 trampoline(否则会漏掉真正需要的 re-navigate)。

3. **orchestrator 跨 iteration 记忆**(`src/userscript/sw-runner.ts`):

   ```js
   let lastNavigatedUrl;
   for (let i = 0; i <= maxReinjects; i++) {
     const outcome = await runOnceWithPort({ ..., init: { ..., lastNavigatedUrl } });
     ...
     if (outcome.kind === 'navigate') {
       await args.page.goto(url);
       lastNavigatedUrl = url;   // ← 给下一轮 INIT
     }
   }
   ```

4. **runner 透传**(`src/userscript/runner.ts`):`makeLocalPage({ ..., lastNavigatedUrl: init.lastNavigatedUrl })`。

**测试**(`tests/run-in-page.test.ts`):3 个新 it:

- post-reinject + pathname 不一致 + `lastNavigatedUrl` 匹配 → no-op,不 RPC,不 throw
- consume-once:第二次 goto 同 URL 会走正常 trampoline 抛 NavigateRestart
- mismatched goto 不消耗旁路:asking for `/different` 时旁路保留给 `/expected`

175 单测全过。

**为什么不直接放宽 `sameLogicalPage`**:URL 等价是个语义判断,要做对必须**了解服务端**。我们没那个上下文,任何"更宽"的规则(suffix 匹配、忽略 path 段、忽略 trailing id…)都会在某些站误判。**SW 知道它刚导航到哪**——把这件确定的事告诉 runner,比让 runner 猜安全得多。

**与 10.4 的关系**:10.4 是 query-param 漂移(同 path,加 token);10.11 是 pathname 漂移(redirect)。两个都是"客户端请求的 URL ≠ 浏览器实际落地的 URL",但**判定方法不一样**:10.4 可以靠 URL 比较解决(subset 检查);10.11 不行,必须靠 SW 显式注入"我刚导过这个" hint。

**教训**:**当一个判定问题在客户端没有足够信息做对,就别在客户端做,把已知信息从 server/orchestrator 显式注入下来**。`sameLogicalPage` 想猜"我是不是已经在那"的答案 —— 但唯一知道答案的是 SW(它刚做了 navigate)。让 SW 直接告诉 runner,比让 runner 凭 `location.href` 加各种 heuristic 推断更准确、更未来友好。

### 10.12 `getCurrentUrl` 同步返回 — adapter 链 `.catch` 直接炸

**症状**(10.10 + 10.11 修完之后,zhihu 又再多走一步暴露出来):

```
zhihu__answer-detail: page.getCurrentUrl(...).catch is not a function
```

**根因**:`zhihu/answer-detail.js` 第 125-127 行:

```js
const currentQuestionId = page.getCurrentUrl
  ? extractQuestionIdFromAnswerUrl(await page.getCurrentUrl().catch(() => ''))
  : '';
```

它假设 `page.getCurrentUrl()` 返回 Promise(因为它在上面链了 `.catch`)。我们的 CDP-based `PageShim.getCurrentUrl` 确实是 `async (): Promise<string | null>`(实现里要 `await chrome.tabs.get(tabId)` 拿 URL),但 Phase B 的 `makeLocalPage.getCurrentUrl` 写成**同步**返回 `loc.href: string`(因为 USER_SCRIPT world 里读 `location.href` 不需要异步)。

`'https://x/y'.catch` === `undefined` → `TypeError`。adapter 直接挂在这一行,**根本走不到下面的 `page.evaluate(API)` 抓数据**。

**修法**(commit `<next+2>`):`makeLocalPage.getCurrentUrl` 改 `async`,跟 PageShim contract 保持一致。DOM 读还是同步,只是包一层 promise:

```ts
async getCurrentUrl(): Promise<string> {
  return loc.href;
},
```

**测试**:把原 `getCurrentUrl is local` sync 单测改成 async,并断言返回值的 `.then` 和 `.catch` 都是 function(防 regression — sync string 一眼看不出哪不对)。

**为什么这一类 bug 容易漏过去**:Phase B 的 PageShim 是**两套**——SW 端走 CDP(`src/runtime/page.ts`, 700+ LOC),USER_SCRIPT 端走 DOM(`makeLocalPage`, 200 LOC)。两端方法名一致但**返回类型可以悄悄不一致**:`page.evaluate` 一致(都 async),`getCookies/screenshot/cdp` 一致(都 RPC 出去所以都 async),`wait/scroll` 都一致 async,但 `getCurrentUrl` 一边 async 一边 sync —— TypeScript 不抓,因为 `LocalPageOptions` 的 `page` 是 `Record<string, unknown>`,类型边界处放开了。

**教训**:**两套 shim 实现同一个 interface 时,要让 interface 真的是 ts interface 而不是 `Record<string, unknown>`**——否则签名漂移到 adapter 报 `.catch is not a function` 之前都没人会发现。下一步小修:给 `makeLocalPage` 的返回类型用 PageShim 的子接口,让 tsc 顶住签名漂移。当下先把 getCurrentUrl 这一个修了 + 加单测当 guard。也是同一个家族的教训:**跨实现的"约等于" interface 必须用真 TS 顶住,不能靠 `Record<string, unknown>` 兜底**(同 10.7/10.8 的"隐式假设清单"思想)。

### 10.13 `node:*` 内建无人转译 — bilibili/zhihu 一批 adapter 都死在 module load

**症状**(`bilibili__favorite` 调用):

```
ReferenceError: getSelfUid is not defined
```

跟 10.8 同样症状但**完全不是同一回事**。10.8 的根是 marketplace builder 没 bundle 相对 import。这次相对 import 是 bundle 了,但**整个 bundle 阶段悄悄失败**:

```
⚠ bilibili/favorite.js bundle failed, shipping raw (will error at runtime):
  Build failed with 2 errors:
  bilibili/utils.js:4:18: ERROR: Could not resolve "node:https"
  bilibili/utils.js:84:40: ERROR: Could not resolve "node:crypto"
```

构建脚本里有兜底:bundle 失败就 ship raw + 打 warning。raw source 里 `import { apiGet, payloadData, getSelfUid } from './utils.js'` 又被 stripModuleSyntax 删掉,运行时 → `getSelfUid` undefined。

**根因**(分两层):

1. **bundle 阶段**:`bilibili/utils.js` 顶层 `import https from 'node:https'` + 函数内 `await import('node:crypto')`(为了 md5)。esbuild 在 `platform: 'browser'` + 没把 `node:*` 标 external 的情况下找不到这两个模块,bundle 整体失败。
2. **runtime 阶段**:即便 bundle 成功保留了 `import https from 'node:https'`,stripModuleSyntax 把它当普通 import 删了,`https` 变成 ReferenceError。等到 bilibili WBI 签名 → `createHash('md5')` 又因为 SubtleCrypto **故意不支持 MD5** 也走不通。

涉及的 adapter 不止 bilibili:zhihu 的 comment/favorite/follow/like 走 `zhihu/write-shared.js` → `node:fs/promises`(虽然只是名字被引,运行时不一定调到);未来更多 adapter 也会撞。

**修法**(commit `<next+1>`):

1. **esbuild 标 `node:*` external**(`scripts/build-marketplace-index.mjs`)
   - `external: ['@jackwener/opencli/*', 'node:*']` —— bundle 不再报错,`import https from 'node:https'` 原样保留在输出里。
   - 单条 `bundle: true` 把相对 sibling 全 inline(`getSelfUid` 就出现在文件里了)。

2. **stripModuleSyntax 升级:不删 `node:*` 而是 rewrite 成 shim 查找**(`src/sandbox/eval-core.ts`)

   ```
   import https from 'node:https';             →  const https = __nodeShim['node:https'];
   import { createHash } from 'node:crypto';   →  const { createHash } = __nodeShim['node:crypto'];
   await import('node:crypto')                 →  await __nodeShim['node:crypto']   (await 在非 Promise 上是 no-op)
   ```

   非 node 的 import 还是走原来的"全删"路径(那些名字来自注入 scope)。

3. **`src/runtime/node-shim.ts` 提供 `nodeShim` 字典**
   - `'node:crypto'`:**真实 MD5**(纯 JS,RFC 1321,`src/runtime/md5.ts`,通过 7 个标准 vector 测过)。Browser 的 SubtleCrypto 故意不支持 MD5,所以只能自己写。SHA-\* / 其他算法走 throw 提示"用 SubtleCrypto"。
   - `'node:fs'` / `'node:fs/promises'` / `'node:https'` / `'node:http'`:throw `not available in the browser` 带提示。Adapter **NAMES** them 没事(rewriter 给个 truthy 对象,destructure 不炸),CALLS them 才报清楚的错。
   - `'node:path'` / `'node:os'` / `'node:url'`:给 minimal browser-side 实现(string 拼接 / 转发到 browser globals)。

4. **两个 eval venue 都注入 `__nodeShim`**:`src/sandbox/eval-core.ts` 的 buildScope + `src/userscript/run-in-page.ts` 的 evalAdapterKeepingFuncs。`stripModuleSyntax` 是共享的,所以两边的 rewrite 行为自动一致。

**MD5 不是图轻松**:adapter 圈普遍用 MD5 做 legacy API 签名(bilibili WBI、淘宝、知乎一些老接口)。SubtleCrypto 拒绝实现是出于安全(MD5 已经 broken)。要 adapter 兼容必须自己写。纯 JS MD5 ≈60 行,against RFC 1321 vectors 全过(`tests/md5.test.ts`,包括 padding 边界 55/56/57/64/65 byte)。**只用于协议兼容,不当真用作安全 hash**。

**留没解决的**:

- bilibili `resolveBvid`(`b23.tv` 短 URL → BV ID)仍然不能跑:它用 `https.get(url, callback)`,我没造 fetch-based 等价(redirect-manual 在 browser 拿不到 Location header,得用 redirect-follow + 读 `response.url`,够 hacky 不写)。**绝大多数 bilibili adapter 不调 resolveBvid**(用户都是直接传 BV id / 完整 URL),所以不阻塞主路径。需要时再加。
- zhihu/comment 等写操作走 `node:fs` 读本地文件做附件上传 —— 本来就在 browser 里跑不动,shim throw 出错和不 ship 等价。后续如果做附件流可以接 `page.getAttachments()`。

**端到端测试**(`tests/node-shim.test.ts`):喂一段 bilibili-utils-shape 的源码 → stripModuleSyntax → new Function + 注入 nodeShim → 调出来的 `sign('hello')` 应当 = `md5Hex('hello')`。过。

**教训**:**当上游(opencli)有自己的 runtime 假设(Node、文件系统、特定 crypto),把它搬到 sandbox 不是"装个 polyfill"那么简单——polyfill 必须是 schema 级的**:每个 import 形状要有对应的 rewrite,每个 rewrite 输出的标识符要有对应的 scope 注入,每个被注入的对象要回答 adapter 真实调用模式(`createHash(algo).update(s).digest(enc)` 三层 API,不是单函数)。**rewrite 跟 scope 注入 + 静态/动态两种 import 形状必须一致**,缺一就回到 ReferenceError。这是 10.4(URL 漂移)/10.11(redirect)/10.13(API 形状)的共同形态:**当一个 contract 是分布式的(多个组件分别承担一部分),要保证所有组件互相能对上**——通过共享代码(stripModuleSyntax 是同一份)、通过类型(让 ts 顶住)、或者通过测试(end-to-end 一条龙)。

### 10.14 esbuild `as X2` alias 把 import strip + scope-inject 撕成两半

**症状**(`bilibili__subtitle` 浏览器实测):

```
ReferenceError: EmptyResultError2 is not defined
```

`bilibili__summary` 同样。

**根因**:adapter 和它 inline 的 utils.js **都从 `@jackwener/opencli/errors` 导入了同名错误类**。esbuild bundle 把两份 import 合到同一作用域,后出现的(adapter 自己的)被自动 alias 成 `*2` 后缀来避免 declarator 冲突:

```js
// marketplace/bilibili/subtitle.js 头部
import { cli, Strategy } from '@jackwener/opencli/registry';
import {
  AuthRequiredError as AuthRequiredError2,
  CommandExecutionError as CommandExecutionError2,
  EmptyResultError as EmptyResultError2,
} from '@jackwener/opencli/errors'; // adapter 的 import
// ↓ utils.js 块内联进来
import {
  AuthRequiredError,
  CommandExecutionError,
  EmptyResultError,
} from '@jackwener/opencli/errors'; // utils 的 import
```

adapter 函数体引用 `EmptyResultError2 / AuthRequiredError2 / ...`(esbuild 把所有引用都改名了);utils 函数体引用无后缀的。两边在 vitest 测试里都 work 因为 import 真的会 resolve,alias 和原名指向同一个 class。

**但运行时** `stripModuleSyntax` 把这两行 import **整条删掉**,然后 eval scope 只注入无后缀名:

```js
// src/sandbox/eval-core.ts 的 buildScope
{ cli, Strategy, AuthRequiredError, CommandExecutionError, EmptyResultError, ArgumentError, RateLimitedError, __nodeShim, ... }
```

adapter 函数体里的 `EmptyResultError2` 在 scope 里找不到 → ReferenceError。**至关重要的是这条只在跑到 `throw new EmptyResultError2(...)` 那一刻才炸**,光「装上 + 列表里能看到」不会暴露,所以 §6 的「装得上 ≠ 跑得动」教训重演。

涉及面广:整个 marketplace 121 个 .js 文件中招(几乎所有 func adapter,只要 adapter 自己 import 了 errors 名字)。

**修法**(本次 commit):

不在 runtime 加 alias 注入(脆弱:下次 esbuild 改名规则就要跟着改),而是**把 source 改干净**。一次性脚本 `/tmp/fix-aliased-errors.mjs` 对每个 marketplace `.js`:

1. 抓所有 `import { ... } from "@jackwener/opencli/errors";` 行
2. 解析每个名字,把 `X as X2` 折回 canonical `X`
3. 把所有 error-import 行合并成**一行** canonical(按字母排序的 union)
4. 把函数体里所有 `X2 / X3 / ...` standalone 标识符换回 `X`
5. 同步更新 `marketplace/index.json` 里对应条目的 `sha256`(install path 校验 sha256,不更新就装不上 —— [[web-agent-marketplace-authoritative]])

写完后全 21 个测试文件 / 258 测试还过(测试本来 alias 也 work,所以没回归),浏览器实测 `bilibili__subtitle` / `bilibili__summary` 恢复。

**教训**:**测试通过 ≠ 产线通过**,**bundle 形态 + runtime contract 必须共享同一份"导入名字解析规则"**。这次的 gap:

1. **vitest 走真 import 路径**(`@jackwener/opencli/errors` 真的 resolve 到 `src/runtime/errors.js`),所以 alias 也 work
2. **runtime 走 strip + 注入**,只认无后缀名

两条路在「import 形态等价于注入 scope」上有隐性 contract,bundle 工具(esbuild)又自由地引入新形态(alias),contract 就坏了 —— 跟 10.13 一样,「打包 → 字符串 → eval」每多一级抽象就多一层隐式假设要对齐。

**这次本来该早一步抓到**:Phase B 选样测试时挑的 xiaohongshu/search / hackernews 都是**单一 errors import 源**的形态(adapter 没 utils 或 utils 没 errors)。一旦换成 bilibili/zhihu 这种 utils 重度依赖的 site,alias 形态立刻浮现。**端到端选样要刻意覆盖代码形态多样性,不要只挑最自包含的跑通就盖章** —— 这条 §10.8 写过,还是没记住。下次 marketplace 测样要刻意挑「最长的、有 utils 的、有 sibling 链的」,而不是最像 hello-world 的。

**还有一条**:**marketplace 一旦改成手动维护**(commit [`e9c211c`] 起),这种 bundle artifacts 残留就是「需要 lint 的源码」级别的债务,不是「重跑就好」。建议下次再写「跑过一次的 build 脚本」前先 lint 输出:**单个文件不许有同 module 的两条 import** 是最直接的 invariant。

### 10.15 `cachedIndex` 永不失效 — uninstall/reinstall 装回老 source

**症状**:修完 §10.14 之后,用户在浏览器里:reload extension → SidePanel 卸载 `bilibili/subtitle` → 重新安装 → **同一个 `EmptyResultError2 is not defined` 又来一遍**。

控制台 fetch 看 marketplace 里的文件,**Chrome 端给的是干净的新版**(无 `*2` alias),但用 console 打开 IDB 看 installed_adapters 里 `bilibili/subtitle` 的 `source` 字段,**装着的还是旧版**(含 `*2`)。证据:JS string `.length` 9309,9309 - 9117 = 192 char 差,正好对应旧版多出的 `as X2` alias 字符串总长。

**根因**(两层叠加):

1. **`src/sidepanel/marketplace.ts` 顶层 `let cachedIndex: MarketIndex | null = null;` 永不重置**。SidePanel 页面在 ext reload 之间**不会自动重启**(只有 SW 重启),它的 JS module-level state 整段保留。SidePanel 装的 `MarketAdapter` 对象来自 `cachedIndex`,所以 `a.sha256` 一直是首次打开 Market tab 时的版本。
2. **`fetch()` 没标 `cache: 'no-store'`**。chrome-extension:// 的 URL 跟普通 HTTP 一样走浏览器 cache。如果 Chrome 恰好缓存了上一次 fetch 的旧 .js 响应,这次 fetch 还给老内容。

两者叠加 → `fetchAdapterSource(a)` 用**老 sha256** 校验**老 .js 内容**,**两个老对老 match**,sha256 校验通过 → 老 source 写进 IDB。用户看到「安装成功」,运行依然炸。

**修法**(本次 commit):

1. **删掉 `cachedIndex` module-level cache**。Marketplace tab 本来就在 React state 里缓存渲染结果(每次 mount 拿一次),不需要 module-level 那层。85KB 的本地 fetch 是即时操作,没性能损失。
2. **`fetch(..., { cache: 'no-store' })`** 在 `fetchMarketIndex` 和 `fetchAdapterSource` 两处都加上。即便 Chrome 想缓存也得绕过 disk → 永远拿最新 dist。
3. **`tests/marketplace.test.ts` 的 fetchMock 断言** 加上第二个参数 `{ cache: 'no-store' }`(否则单元测试反过来失败)。

**用户验证步骤**(必须按顺序):

```
npm run build          # 更新 dist
chrome://extensions    # 点 reload 按钮(让 SidePanel 拿到新 JS)
SidePanel              # 卸载受影响 adapter → 重装
```

注意 reload 不重启 SidePanel 页面这件事是 Chrome 的行为,不是我们的 bug。如果 SidePanel 已经打开**且**有 module-level cache,reload 后必须**关 SidePanel 再开**才能让新 JS 上来。但删了 cachedIndex 之后,这步可省。

**教训**:**module-level cache 是 SPA 的「跨 reload 泄漏面」**。React/Preact 组件状态会在 mount/unmount 时自然清掉,但 module-level `let` / `Map` 是常驻的 —— ext reload 都不重启它们。任何需要「在 ext 升级 / 重载之后必须重读」的东西(market index、用户设置、外部资源指纹)都**不应该在 module-level 缓存**。让 React state 做缓存,或显式提供 invalidate API。

**另一条**:**chrome-extension:// 的 `fetch` 不是天然「读盘」**。它走完整的 HTTP cache 路径,跟外网 fetch 一样。开发自己写的资源(dist 里的 .js / .json)如果有「我改了你要拿新的」语义,**默认必须** `cache: 'no-store'`,否则 ext reload 后还可能拿到老内容。

### 10.16 `registry.js` 警告对 installed func adapter 误报

**症状**(SW boot 日志):

```
[registry] bilibili/subtitle registered with neither func nor pipeline — it cannot execute.
[registry] bilibili/summary registered with neither func nor pipeline — it cannot execute.
... (34 条,几乎每个 installed func adapter 都报一遍)
[web:install] restored 34 installed adapters (35 commands)
```

警告说「它不能执行」,但用户实际跑 `bilibili__subtitle` **能跑出结果**。误报。

**根因**:func adapter 的捕获 def 经过 sandbox eval → SW IDB → loadInstalledOnBoot 这条链,**closure 不可序列化**,所以重启后 `def.func` 是 undefined。但 dispatcher 会查 `def._userScriptSource`(install 时存的 source string,Phase B func 用 chrome.userScripts.execute 注入页面跑)。`registry.js` 的 cli() 检查只看 `func` + `pipeline`,**不看 `_userScriptSource`**,所以漏判 → 警告满天飞。

**修法**(本次 commit):cli() 的「无法执行」判定加一条 `hasUserScriptSource = typeof def._userScriptSource === 'string' && def._userScriptSource.length > 0`。三条路径都没了才警告。

**教训**:**警告条件要跟实际执行路径同步**。dispatcher 有 3 条 routing(func / pipeline / \_userScriptSource),registry 只看 2 条,长期信号噪音掩盖真问题。下次加新执行路径时,把 registry 的判定也带上 —— 或者反过来,**把「能跑」的判定写在 dispatcher 一处,registry 调它**。现在分两份,未来再加路径就会再次脱钩。

### 10.17 sandbox.html cross-origin load 错误 ——【未解决,已知噪音】

> **状态(2026-06 更新)**:**仍未修好**。下面记的「删 WAR 双声明」是一次**合理但无效**的尝试——删掉是对的(sandbox.html 确实不该进 WAR),但**报错照旧**。说明根因不是 WAR/sandbox.pages 双声明。**当前结论:大概率是 Chrome MV3 sandboxed-iframe 的良性内部噪音,extension 代码层面不一定改得掉。不影响功能(install/capture/vision 全正常),暂列已知问题,以后再查。** 别再误信下面那段「修法 → 报错消失」。
>
> **再更新(2026-06,尝试三)**:给 host iframe 加了元素级 `sandbox="allow-scripts"` 属性(见文末「尝试三」)。加完用户**暂时没再复现**这条报错——但**用户自己也不确定是否真解决**,需要后续多测才知道。按本节教训,**不宣布修好**,标记「待确认」。

**症状**:

```
Unsafe attempt to load URL chrome-extension://<id>/sandbox.html
from frame with URL chrome-extension://<id>/sandbox.html.
Domains, protocols and ports must match.
```

URL 和 frame URL 都是 sandbox.html。控制台一直有这条,虽然不影响 adapter 跑(install/capture 正常),但是噪音。

**(初版误判)**:一开始以为是 sandbox 脚本自己在 load 资源,或 ext reload 后 iframe 变「断头」自我导航。逐条排掉了:`eval-host.ts` 只 postMessage,`dist/sandbox.html` 纯 inline script(`.src=`/`import(`/`fetch(` 三处都是误报——分别是消息字段 `d.src`、stripModuleSyntax 的正则字符串、和一个从不被调的 utils 函数定义),`sandbox-host.ts` 的 iframe 只建一次。**都不是。**

**真根因**:`sandbox.html` 在 manifest 里被**同时**声明进了两处,给了它**互相矛盾的 origin**:

- `web_accessible_resources` → 让它以**扩展 origin**(`chrome-extension://<id>`)被加载。
- `sandbox.pages` → 让它以 **opaque(null)origin** 被加载(MV3 sandbox 的本意)。

SidePanel 用 `iframe.src = chrome.runtime.getURL('sandbox.html')` 嵌它时,Chrome 对「这个 frame 到底算哪个 origin」拿不准:WAR 说扩展 origin,sandbox.pages 说 opaque。enforcement 一来一回(先按一个 resolve,sandbox 规则再把它按 opaque 重定),就报「load X from frame X / origins must match」。

而 **WAR 对 sandbox.html 根本是多余的**:WAR 只在「**web origin**(content script 注入的页面、外部网页)要 fetch 这个资源」时才需要。sandbox.html 的**唯一**加载者是 `sandbox-host.ts`——SidePanel(扩展页)用 iframe 嵌它,而扩展页嵌自己的 `sandbox.pages` **不需要 WAR**。(对照:`userscript-runner.js` 和 `marketplace/*` 确实要 WAR,因为它们从网页 / userScripts 世界加载。)

**尝试过的(无效)**:从 `manifest.json` 的 `web_accessible_resources` 删掉 `sandbox.html`(commit `2e486bf`),原以为 WAR 与 sandbox.pages 双声明给了它矛盾 origin 是根因。**实测删完报错照旧**——所以双声明不是根因。这个删除本身**保留**(sandbox.html 的唯一加载者是 SidePanel 用 iframe 嵌它,扩展页嵌自己的 `sandbox.pages` 不需要 WAR;`userscript-runner.js`/`marketplace/*` 才需要 WAR,因为它们从网页世界加载),只是它**没解决报错**。

**还没查清的方向**(留给下次):

- 可能是 MV3 sandboxed iframe 从 `about:blank` 导航到 sandbox.html 时,opaque origin 与 chrome-extension:// 的 same-origin 检查冲突,Chrome 记一条警告但仍放行(很多带 sandbox iframe 的 MV3 扩展都见过这条,疑似无害的平台噪音)。
- 待验证:换成 `chrome.runtime.getURL` 之外的加载方式、或给 iframe 显式 `sandbox` 属性、或干脆不用 sandbox iframe(install 期的 eval 改走别的 venue)是否能消掉。

**教训(关于诊断本身)**:**「改完没立刻在真机复测就宣布修好」是这次的错**。我基于「WAR/sandbox.pages 双声明」的合理推断改了 + 写进 docs「报错消失」+ commit + push,但用户后来的日志显示报错还在。**配置类 / 平台行为类的「修复」尤其要在真浏览器里亲眼确认报错消失再下结论**,推断再合理也不算数。

**尝试三(2026-06,元素级 sandbox 属性,待确认)**:`sandbox-host.ts` 给 host iframe 在建立时加 `el.setAttribute('sandbox', 'allow-scripts')`(并保持先设属性、后设 `src`)。

- **先排除了「我们的代码在加载 sandbox.html」**:`grep` 扫 `dist/sandbox.html`,无 `import.meta`/`document.baseURI`/`document.currentScript`/`new URL`/`new Worker`/`location.href`/`chrome.runtime`;只剩 `import(`×2(`stripModuleSyntax` 正则字符串)、`fetch(`×1(未调用的 util)、`.src=`×1(消息字段),全是既有误报。所以剩下能触发的只有 **frame 过渡本身**。
- **推断**:plain `<iframe>` 元素去加载一个「commit 时才变 sandboxed(opaque origin)」的页面,Chromium 在这个 **plain→sandboxed 的 origin 过渡**上记这条 same-origin 警告;元素**一开始就声明 sandbox**,就没有过渡可记。
- **为什么 `allow-scripts` 够、且不破坏 eval**:内联脚本要 `allow-scripts` ✓;`new Function` 的 eval 由**页面 sandbox-CSP 的 `unsafe-eval`** 管(CSP 指令,不受 iframe sandbox flag 影响)✓;故意**不给 `allow-same-origin`** 以保持 opaque、与 `sandbox.pages` 一致;parent↔sandbox 的 postMessage 本就 target `'*'`、parent 侧也不校验 `event.source`,跨 opaque origin 照常。
- **结果**:用户加完**暂未复现**报错,但**未证实**(平台噪音本就时有时无),install/eval 仍正常。**不宣布修好**,留作「待后续多测确认」。若以后确认无效,这条属性当作无害硬化保留或回退皆可。

### 10.18 全量审计:注入 scope 用 stub → 一批 func 静默错 / 错误映射失效

**背景**:用户要求「检查所有 adapters,把能发现的错都修了」。不靠逐个跑,先写一个静态分析脚本(`/tmp/recon-adapters.mjs`)扫全部 marketplace adapter,按 bug 形态分类:

- **A**:从 `@jackwener/opencli/*` import 了一个**运行时 scope 里不存在**的名字 → 跑到就 ReferenceError。
- **B**:injected 名字的 esbuild `*2` 别名残留(§10.14 的回归)。
- **C**:import 了一个**运行时被 stub 掉**的 util 且在 func body 里真的调用 → 静默错(不抛,只是结果错)。
- **D**:`node:*` import(shim 只实现 md5,其余 throw) / 残留相对 import。
- **E**:func 里调了 in-page 不支持的 `page.*`(captureNetwork)。

扫描结论:B/E = 0(前面已修干净),D 已知且大多只 NAME 不 CALL。真正的新雷在 **A 和 C**,根都是同一个:**注入 scope 有两份手抄、且都用 stub**。

**根因**:adapter 被 eval 时能看到的全局,由两处**各自手写**:

- `src/sandbox/eval-core.ts buildScope()` —— 安装时 CAPTURE(只跑 top-level `cli()`,不跑 func)
- `src/userscript/run-in-page.ts evalAdapterKeepingFuncs()` —— RUNTIME(真跑 func body)

两份漂了,而且 RUNTIME 那份把 opencli 的 utils 全 stub 成废物:

```js
htmlToMarkdown: (v) => v,          // 原样返回 HTML,不转 markdown
mapConcurrent: async () => [],     // 直接返回空数组
throwIfLoginWall: (v) => v,        // 不做 login-wall 探测
parseJsonOrThrowLoginWall: (v) => v,
// createMarkdownConverter —— capture scope 有,runtime scope 根本没有
// log —— 两份都没有
// 错误类 —— 都是本地 mkErr 现造的,不是 runtime/errors.js 的真类
```

后果(全部**测试测不出来**,因为 vitest 走 alias 解析到 `src/runtime/opencli/utils.ts` 真实现,测试用真 util,产线用 stub —— 又是 §10.14 那种「test 过 / 产线挂」的错位):

1. **chatgpt/detail、chatgpt/read** 用 `htmlToMarkdown(html)` → 产线返回原始 HTML 而不是 markdown(错输出,不报错)。
2. 任何用 `mapConcurrent` 的 func → 拿到 `[]`(静默丢数据)。
3. **weread/shelf、zhihu/collection、zhihu/collections** 用 `log.warn/.info` → `log` 没注入 → 跑到就 **ReferenceError**(Class A)。
4. **createMarkdownConverter** 在 func 里调 → runtime scope 没有 → ReferenceError。
5. **最隐蔽**:dispatcher(`src/tools/dispatcher.ts:294-314`)用 `e instanceof AuthRequiredError / RateLimitedError / EmptyResultError`(`runtime/errors.js` 的真类)判错类型并映射 UX。但 runtime scope 注入的是**本地 mkErr 现造类**,adapter `throw new AuthRequiredError(...)` 抛的是那个冒牌类 → dispatcher 的 `instanceof` **永远 false** → 登录墙 / 限流 / 空结果的 UX 对所有 installed func adapter **从来没生效过**。

**修法**(本次 commit):把「adapter 能看到什么」收敛成**一份**——新建 `src/runtime/adapter-scope.ts` 的 `buildAdapterScope(onRegister)`,注入:

- **真错误类**(从 `runtime/errors.js` import,dispatcher 同一个 module 实例 → `instanceof` 对得上)
- **真 utils**(turndown-backed `htmlToMarkdown` / `createMarkdownConverter` / 真 `mapConcurrent` / 真 login-wall 探测,从 `runtime/opencli/utils.ts` import)
- **真 `log`**(`runtime/opencli/logger.ts`,底层 `runtime/log` 用 `safeChrome()` 守 chrome,sandbox 里降级到 console)
- `__nodeShim` 不变

`eval-core.ts buildScope` 和 `run-in-page.ts evalAdapterKeepingFuncs` 都改成调它。CAPTURE 路径其实用不到真 utils(不跑 func),但共享一份就是为了**杜绝再次漂移**(§10.16 的教训:「adapter 能跑/能看到什么」要写在一处)。

代价:turndown(~50KB)现在进 sandbox IIFE 和 userscript-runner IIFE(runner 46KB→57KB)。两个 venue 都有 DOM,turndown 能跑。可接受。

安全性:utils 全是纯字符串 / DOM 变换(无 fetch / chrome),不破坏 sandbox 的隔离前提。

**附带修**:`marketplace/reddit/.js` —— 一个 **basename 为空**的畸形文件(`ls` 默认不显示 dotfile 所以一直没注意到)。它是 `reddit/subscribed`,但 build 当时把 name 算成了空串,落地成 `reddit/.js`,index 里 `name:""` + `source:"reddit/.js"`。`git mv` 成 `reddit/subscribed.js`,index 条目修 name/source/sha256。内容没变,sha256 值不变(只是挪了位置)。

**教训**:

- **「注入式 eval 的 scope」是一种 API,有两份手抄就一定会漂**。这次跟 §10.14(esbuild alias)、§10.15(cachedIndex)同形:**一个 contract 被复制成多份,复制体之间迟早不一致**。收敛成一份 + 用真实现,比「两份各自打补丁」省后患。
- **stub 是「为了让 capture 跑通」的临时物,不该泄漏到 runtime**。capture 不跑 func body 所以 stub 无害,但同一套名字被 runtime 复用就把「无害占位」变成了「静默错」。**临时 stub 要在类型 / 命名上跟真实现区分,别让它们共享同一个符号名被无差别复用**。
- **静态分类扫描**(import 的名字 ∉ 注入 scope?stub util 在 body 里被调?node: 被 call 还是只被 name?)是审计这类「装得上但跑出错」的高性价比手段——一次扫全量,比逐个手跑省几个数量级。脚本留在 `/tmp/recon-adapters.mjs`,下次加站 / 改 scope 后可复跑。

### 10.19 SW 才一会就被回收 + 「继续」丢上下文(两个独立 bug,连环出现)

**症状**(用户跑 `bilibili__comment`,一个 **write** adapter):

1. 工具「执行中」没多久 → 红字「**会话因扩展后台被回收而中断了。再发一句话可以接着聊(基于历史上下文)**」。
2. 用户发「继续」→ 模型回「**我这边没有看到之前的对话记录**」,完全没上下文。提示里承诺的「接着聊」是假的。

两个 bug 独立,但连环触发(1 把 SW 杀了,2 在恢复路径上把历史丢了)。

**Bug 1 根因:keepalive 只靠「开着一个 port」,不够**。`src/sidepanel/App.tsx` 开了 `chrome.runtime.connect({name:'web-keepalive'})`,注释写「An open Port keeps the SW pinned per MV3 spec」。**这个假设过时了**:当前 Chrome 里一个**空闲**的连接 port **不会重置 30s idle 计时器**。日志甚至打了「keepalive port connected (total=1)」,SW 照样被回收。`bilibili__comment` 期间 SW 在等 write-confirm + userScripts RPC,自己**不发任何 `chrome.*` 调用** → 30s 到点被杀 → in-memory `activeSessions` 蒸发。

**Bug 1 修法**:加**主动自 ping**(`src/background/service-worker.ts`)。有任何 session 在跑时,`setInterval` 每 20s(< 30s)调一次廉价 `chrome.runtime.getPlatformInfo()`——异步扩展 API 调用算「活动」,重置 idle 计时器。`setInterval` 只在 SW 活着时 tick,所以「有活跃 session → SW 永不被回收;最后一个 session 结束 → 立即释放」。在 `driveApiSession` 开头 `startKeepalivePing()`,`finally` 里 `stopKeepalivePingIfIdle()`(gated on `activeSessions.size===0`)。原 port 留着当次要信号 + 面板一关就放 SW 走。

**Bug 2 根因:错误路径把 sessionId 扔了,跟「接着聊」的承诺自相矛盾**。`App.tsx:283` 原本 `if (m.reason === 'error') setSessionId(null)`。而被回收的恢复路径(`recoverInterruptedSessionsOnBoot`)发的正是 `reason:'error'` → SidePanel **把 sessionId 置空**。用户发「继续」时 `sid = sessionId ?? makeSessionId()` → sessionId 是 null → **新开一个 session** → `loadSession(新id)` 返回 null → `makeSession` 空历史。**历史其实一直在 IDB**(engine 每个 turn 增量 `saveSession`:user 消息一进来就存、每个 assistant turn 存、每个 tool 结果存),是 SidePanel 在恢复时把线头丢了。

**Bug 2 修法**:`SessionDoneEvt` 加 `recoverable?: boolean`。恢复路径发 `recoverable:true`(历史在 IDB,可续)。`App.tsx` 改成 `if (m.reason === 'error' && !m.recoverable) setSessionId(null)` —— 可恢复中断**保留 sessionId**,下一条消息 `loadSession` 拿回带 `apiMessages` 的 session,engine 从 `session.apiMessages` 续种 → 上下文回来了。真·fatal error 仍然清掉、重开。

**附带修 race**:`recoverInterruptedSessionsOnBoot()` 在 SW 顶层 boot 时跑(line 139),会跟「唤醒这次 boot 的那条 USER_MESSAGE」并发。若 `handleUserMessage` 已经把 session 放进 `activeSessions` 在续跑,recover 的 `listSessions({status:'running'})` 可能又把它标 'error' + 弹个假 banner 盖在进行中的 turn 上。加一行 `if (activeSessions.has(s.id)) continue;` 跳过正在驱动的 session。

**教训**:

- **「开着 port 就能保活」是 MV3 的老都市传说**。可靠的保活是**主动产生 chrome.\* 活动**(自 ping / 周期消息),不是被动持有连接。任何「等外部慢操作(用户确认 / 远端 RPC)」的 SW 路径都得在等待期间自己制造活动,否则 30s 一到就没。
- **恢复路径的承诺要跟代码对账**。banner 写「接着聊(基于历史上下文)」,代码却把 sessionId 清了——**UI 文案和状态机走向必须一致**,不然就是骗用户。续聊的前提是「持久化的是什么、恢复时读的是什么、UI 绑的 id 是不是同一个」三者对齐;这次断在第三环。
- **持久化要增量、不要只在 finally**。engine 每步 `saveSession` 是对的(所以历史没真丢);`driveApiSession` 的 `finally` save 只是兜底——**SW 被 OS 回收时 `finally` 不保证执行**,真正的耐久性来自循环内的 checkpoint。

### 10.20 func adapter 在未登录站点上**白等 60s** 才报错

**症状**(`weibo__me`,用户没登录微博):第一次调用**整整 60 秒**后报 `runner timed out after 60000ms`,模型重试,第二次 6 秒返回正确的 `AuthRequiredError: Authentication required for weibo.com`。错误结论是对的(§10.18 的错误映射在真机生效了),但第一次那 60s 纯属白等。

**根因**:`src/userscript/sw-runner.ts` 的 runner 编排只有三条出路 settle:收到 `DONE`、收到 `NAVIGATE_RESTART`(func 主动 `page.goto`)、或 60s 超时。`port.onDisconnect` 是个 **no-op**,注释假设「port 在 DONE 前断开 ≈ func 请求了导航,resolveNavigate 会兜住」。

但 weibo 未登录会 **服务端 302 重定向** `weibo.com → weibo.com/newlogin`。这个跳转是**页面自己发起的**,不是 func 调 `page.goto`:刚注入连上、发完 INIT 的 runner 上下文被跳转**销毁** → port 断开,但**既没 NAVIGATE_RESTART 也没 DONE**。于是没有任何东西 settle → 干等到 60s 超时。(日志里还伴随 bfcache 的 "The page keeping the extension port is moved into back/forward cache" —— 同类:页面被移走 → port 断。)第二次之所以快,是因为那时重定向已经落定在登录页,runner 跑起来了,func 拿到 null API 响应 → 抛 AuthRequiredError。

**修法**(本次 commit):

1. **`onDisconnect` 不再 no-op**:调 `session.reportDisconnect()`,settle 出一个新的 `kind:'reinject'`。**幂等**——外层 Promise 只 resolve 一次,所以正常 DONE 后的断开、以及 navigate 路径自带的断开都是 no-op,不会重复处理(`settle` 用 `sessionsByTab.get(tabId)===session` 守住 delete,旧 port 的迟到断开也不会误删新 session)。
2. **编排循环处理 `reinject`**:`waitForTabSettled(tabId)`(轮询 tab 到 `status:'complete'`,封顶 4s,别 mid-redirect 又注入又断)后**重新执行 runner**。落到哪个页面就在哪跑——func 自己的 goto-trampoline + 抽取逻辑会接管(未登录就快速 null → AuthRequiredError),不再死等超时。
3. **`maxReinjects` 3→5**:自发重定向现在也吃一个 cycle(以前只有显式 navigate 吃),给登录重定向链留点收敛余量。每 cycle ~1s,最坏 fast-fail ~5s,远好过 60s。

**教训**:**「连接断开」是一个独立的、必须显式处理的 settle 信号,不能假设它总跟某个已知信号同时发生**。这次的洞:编排器把「port 断」默认等价于「func 请求了导航」,但页面有**一万种自己跳走的方式**(302 / meta-refresh / JS location / bfcache),全都断 port 却都不发 NAVIGATE_RESTART。凡是「等一个外部事件、同时持有一个会被外部销毁的连接」的状态机,都要把**连接意外断开**当成一等公民的转移,且转移要**幂等**(因为正常完成路径也会断连)。跟 §10.19「等慢操作时 SW 被回收」同源:**等待态要枚举所有打断方式,逐个给出路**,别只设计 happy path + 一个兜底超时。

**附带(同一处 port 断开的另一面)**:控制台还有一条

```
Unchecked runtime.lastError: The page keeping the extension port is moved into
back/forward cache, so the message channel is closed.
```

每次 goto 导航都刷一条。**无害**(就是上面那个 bfcache 断 port),但是噪音。根因:goto 把旧页面塞进 bfcache → 持有 runner `connect()` port 的那个页面被缓存 → Chrome **带着 `lastError` 拆掉 channel**;我们的 `onDisconnect` 没读 `lastError` → Chrome 报「Unchecked」。修法:`onDisconnect` 里 `void chrome.runtime.lastError;` 把它**消费掉**(这是 Chrome 文档给的标准姿势——「想知道断开是不是出错,在 onDisconnect 回调里读 lastError」)。顺带:SW 侧给 runner port 的 `postMessage`(INIT / RPC 回复)包了 `safePost` try/catch,免得对一个刚断的 port post 在 async 监听器里抛未捕获;keepalive port 的 onDisconnect 同样读一下 lastError。**教训**:port 异常断开会 set `lastError`,**onDisconnect 回调有义务读它**,否则每次断开都是一条「Unchecked」噪音。

### 10.21 多次 `page.goto` 的 func 在 trampoline 上**来回打转**(ping-pong)直到 reinject 上限

**症状**(`weibo__favorites`,用户已登录):调用 ~31s 后报
`adapter exceeded 5 navigate-reinject cycles`,什么都没取到。日志里 tab 在
`weibo.com` ↔ `www.weibo.com/u/page/fav/<uid>` 之间**反复横跳**,每次 reinject
吃一个 cycle,跳满 6 次就放弃:

```
navigate → www.weibo.com/u/page/fav/1654935391  (iter 1/6)
navigate → weibo.com                              (iter 2/6)
navigate → www.weibo.com/u/page/fav/1654935391   (iter 3/6)
navigate → weibo.com                              (iter 4/6)
... 直到 exceeded
```

**根因**:installed func adapter 跑在**页面内**(USER_SCRIPT world),`page.goto`
是个 **navigate-then-reinject trampoline**(见本文件头 + §10.10/§10.11):跨文档
导航会销毁 runner 的执行上下文,SW 必须**重新注入 runner、从头重跑整个 func**。
这套模型只对两类 func 透明:**无 goto**(~75%)和**单一有效 goto**(~24%)。

`weibo/favorites` 是**两次跳到不同 logical page** 的 func:

```js
await page.goto('https://weibo.com'); // ① 读 uid
const uid = await getSelfUid(page);
await page.goto('https://www.weibo.com/u/page/fav/' + uid); // ② 抓取
```

`weibo.com` 与 `www.weibo.com` 在 URL parser 眼里是**不同 origin**。重跑语义下:
落到收藏页那次 replay 会**无条件重新执行 ① 的 `goto("https://weibo.com")`**
(此刻 `sameLogicalPage(收藏页, weibo.com)` 为 false,`lastNavigatedUrl` 又只兜
一层)→ 跳回首页;下一次 replay 又触发 ② → 跳回收藏页……死循环。本文件头其实早
写了「multi-goto / interleaved funcs(~1%)fall back to the CDP PageShim」——
但那是**built-in opencli 路径**才有的退路;**installed adapter 只有 userScripts
一条路,没有 CDP PageShim 兜底**,所以多次跳转的 func 必须**自身写成幂等可重跑**。

更一般地:trampoline 安全 ⟺ **从头重跑在每次导航后都做单调前进**——一旦执行已经
越过某个 goto,重跑不能再往回跳。任何「`goto A`(无条件)… `goto B`,A≠B」且
到了 B 之后重跑会重新触发 `goto A` 的 func,都会 ping-pong。

**修法**:把抓取前的导航**用「我是不是已经在最终页」的 URL 守卫包起来**,让落到
最终页的那次 replay 直接跳过前置导航、去抓取(单调前进):

```js
let favUrl = await page.getCurrentUrl().catch(() => '');
if (!/\/u\/page\/fav\/\d+/.test(favUrl)) {
  await page.goto('https://weibo.com');
  await page.wait(2);
  const uid = await getSelfUid(page);
  favUrl = 'https://www.weibo.com/u/page/fav/' + uid;
  await page.goto(favUrl);
}
await page.wait(4);
// ...抓取(不变)...
```

收敛成**一次**导航;未登录也快速 fail(getSelfUid 抛 AuthRequiredError),不再打转。

**全量审计**(用 workflow 把 32 个 `≥2 .goto(` 的 adapter 各一个 agent 扫了一遍,
按「重跑单调性」分类):

| 类别                      | 数量 | 处理                                                                                                                                                      |
| ------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SAFE**                  | 12   | 不动——两次 goto 在互斥分支 / 同一 logical page / 已有 URL 守卫(chatgpt·claude·gemini 的 send/ask、douban/subject、douban/marks、linkedin/salesnav-thread) |
| **PING_PONG_FIXABLE**     | 14   | 加 URL 守卫修掉(见下)                                                                                                                                     |
| **INTERLEAVED_NEEDS_CDP** | 6    | **本轮不修**,见下                                                                                                                                         |

加上 weibo/favorites 共 **15 个**用同一守卫范式修掉:`douban/reviews`、
`linkedin/{connect,profile-experience,profile-projects,thread-snapshot}`、
`twitter/{article,followers,list-remove,profile}`、`v2ex/daily`、`weread/book`、
`xiaohongshu/{creator-notes,creator-notes-summary}`、`youtube/transcript`。每个守卫
**只包住「本来就坏的多跳路径」,arg 提供 / 单跳 / 抓取代码逐字不变**——这些 adapter
现状是 100% 打转(根本跑不通),所以守卫**只可能改善、不可能让能跑的退化**。
个别带「跨页读」的(`douban/reviews` 的 `full=true`、`xiaohongshu/creator-notes`
的 capture 流水线)做**优雅降级**(replay 落到最终页时 `return []`,让上层 fallback
接手),而不是抓错页的数据或继续打转。每个 adapter 源改完都轮了 `index.json` 的
`sha256`(§11.4 的硬门控)。

**6 个 INTERLEAVED_NEEDS_CDP 为何不修**:`linkedin/{jobs-preferences,profile-read,
salesnav-message,search,services-read}`、`twitter/reply-dm` 在**两次导航之间读了页面
DOM,且那份数据进了返回结果**(`goto A; r1=读A; goto B; r2=读B; return [r1,r2]`)。
trampoline 的最后一次 replay 坐在 B 上,重跑时 `读A` 会读到 B 的 DOM → 数据错乱。
URL 守卫救不了——它们真的需要「页面外的 CDP 控制器」那种「goto 后执行继续、不重跑」
的模型,而 installed adapter 没有。**先记下来、留作后续**(要么改成用 `page.evaluate`
里 `fetch` 同源取数据避免导航,要么单独给 installed adapter 接一条 CDP 执行路)。

> **更新**:这 6 个已在 **§10.22** 全部修掉——用第三条路:**`sessionStorage` 同源状态机**
> (这些导航全是同源,snapshot 跨 reinject 存活)。读 adapter 直接做;写 adapter
> (`twitter/reply-dm`、`linkedin/salesnav-message`)额外加幂等门防重发(详见 §10.22)。

**回归护栏**:`tests/run-in-page.test.ts` 加了一个 `driveTrampoline` 驱动器,真把
「跑 func → navigating 就挪 location.href + 重跑」的 SW reinject 循环模拟出来,
断言:**无守卫的两跳 func 一定打到 reinject 上限**(复现 bug),**有守卫的一跳收敛
并抓取成功**(证明修法)。这样这一类 bug 不靠真机也能拦住。

**教训**:

1. **「从头重跑」的执行模型对 func 有一个隐性契约:导航序列必须单调可重放**。无 goto
   / 单跳天然满足,多跳必须靠 URL 守卫显式满足。这跟 §10.4(URL 漂移)、§10.11
   (redirect)、§10.18(注入 scope)同形:**一个分布在多组件间的契约,每个组件都得
   自己对上**——这里是「每个 `page.goto` 都得能在重跑里认出自己已经走过」。
2. **静态审计要按「bug 形态」全量扫,别等用户一个个踩**(同 §10.18/§13.1)。一个
   `weibo__favorites` 暴露的是一整类:`grep '≥2 .goto('` → 32 个候选 → workflow
   并行分类 → 15 个真坏。下一次遇到任何「单点症状」先问「这是哪一类,全量有几个」。
3. **守卫范式里 `page.getCurrentUrl()` 是生产必有、测试 fake 常缺的方法**——见下个小坑。

**附带坑(测试 fake 不完整)**:加完守卫,15 个 adapter 的移植测试一片红——
`page.getCurrentUrl()` 在 fake page 上**不是函数**,`.catch` 还没接上就先 throw
`TypeError`(`await page.getCurrentUrl().catch(...)` 先求值 `page.getCurrentUrl()`)。
生产里 `makeLocalPage`/`PageShim` **永远**有 getCurrentUrl,是这些早于守卫写的 fake
page 工厂没补。修法:照 `zhihu-page.ts` 的既有约定,给相关 fake-page 工厂默认补
`getCurrentUrl: vi.fn().mockResolvedValue('')`——返回**空串**(不匹配任何守卫正则)
所以 func 照旧导航,既有断言全保。**教训**:**给 adapter 加了新的 `page.*` 调用,
等于改了 page 契约,所有 fake page 都得跟着补全**;fake 的「最小可用」会在契约扩张时
变成「不完整」(同 §10.8/§10.14「测样要覆盖真实形态多样性」)。

### 10.22 INTERLEAVED func:用 `sessionStorage` 状态机把「跨页读」做成 trampoline-safe

**背景**:§10.21 把 6 个 `INTERLEAVED_NEEDS_CDP` adapter(`linkedin/{jobs-preferences,
profile-read,salesnav-message,search,services-read}`、`twitter/reply-dm`)留作后续——
它们在两次导航之间**读了页面 DOM 且那份数据进了返回结果**(`goto A; r1=读A; goto B;
r2=读B; return merge(r1,r2)`)。纯 URL 守卫救不了:落到 B 的那次 replay 跳过 `读A`
就丢了 A 的数据,不跳过又会把 B 的 DOM 当 A 读。

**修法**:把 func 改写成**URL 驱动的状态机**,把每页 snapshot 暂存进**本 tab 的
`sessionStorage`**(同源导航 + reinject 都存活),在最终页恢复并合并。本轮这些 adapter
的导航**全是同源**(`www.linkedin.com` 内部 / `twitter.com` 内部),所以 sessionStorage
能跨 reinject 存活。范式:

- 顶部读 `page.getCurrentUrl()`;**不在最终页**就跑前置 stage(scrape → `buildScratchSetScript`
  暂存 → goto 下一页),goto 触发 reinject;**最终 stage** scrape 自己的页、用
  `buildScratchGetScript`(`JSON.parse`)恢复暂存、`buildScratchClearScript` 清键、返回合并。
- 三段以上就链式:每个非最终 stage scrape+stash+navigate,各自用「我是否已越过本 stage 的页」
  做 URL 守卫(单调前进,§10.21 的不变量照旧成立)。
- `SCRATCH_KEY` 每 adapter 唯一:`"__web_<site>_<name>__"`。
- **硬约束**:single-goto / arg 提供 / 已安全的路径**逐字节不变**——只有 interleaved 多跳
  路径变状态机(如 `services-read` 只在「读自己 owner-edit」即无 services-url 且无 profile-url
  时才 4 段 interleaved;`profile-read` 只在读自己 profile 时;`search` 只在 `--details` 时)。
- 复用既有 scrape 脚本 + normalize helper **不变**,只改 func 控制流。

helper 三件套(inline 在 adapter unwrap helper 之后),发出**带 guard** 的 sessionStorage
脚本喂 `page.evaluate`,被存储拦截的页降级为 clear error 而非 throw:

```js
function buildScratchSetScript(key, jsonValue) {
  return `(() => { try { sessionStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(jsonValue)}); return true; } catch (e) { return false; } })()`;
}
function buildScratchGetScript(key) {
  return `(() => { try { return sessionStorage.getItem(${JSON.stringify(key)}); } catch (e) { return null; } })()`;
}
function buildScratchClearScript(key) {
  return `(() => { try { sessionStorage.removeItem(${JSON.stringify(key)}); return true; } catch (e) { return false; } })()`;
}
```

**测试范式**:单测里 `page.goto` 不 throw,状态机**线性**跑完一遍(stage1→stage2…)。
fake page 须:`getCurrentUrl: vi.fn().mockResolvedValue('')`(空串 → 进 stage 1);
`page.evaluate = withSessionScratch((script)=>{ /* 既有 per-script scrape */ })`
(`tests/adapters/_helpers/session-scratch.ts` 用内存 Map 模拟那 3 个 storage 脚本、其余
落到你的 scrape)。既有断言全保,合并结果与改写前逐字一致。

**本轮抓到的真 bug(`linkedin/services-read`,owner-edit 4 段路径)**

- **症状**:`fails closed on the media page when the stash is lost` 测试期望
  `CommandExecutionError`,实际抛 `TypeError: Invalid URL`(`code: ERR_INVALID_URL,
input: ""`)。即 sessionStorage 被禁(set/get 全 no-op)时,fail-closed 走的是裸
  `TypeError` 而非约定的 clear error。
- **根因**:owner-edit 路径 discover 出 `servicesUrl` 后 `mergeScratch` 暂存,但存储被禁
  → stage 2 里 `const stashUrl = (await readScratch(page)).servicesUrl` 取回 `undefined`;
  fake `getCurrentUrl()` 恒返回 `''` → `baseServicesUrl = stashUrl ||
(isServicesPageUrl('') ? ... : '')` = `''`。随后 `deriveEditUrl('' || '')` →
  `new URL("")` → **抛 `TypeError`**。约束 #3 要求「最终页暂存丢失须抛 clear
  CommandExecutionError」,这里在**进入最终页之前**就被 `new URL("")` 抢先炸了,错误类型错。
- **修法**:在 `deriveEditUrl/deriveMediaUrl` **之前**对 `baseServicesUrl` 加守卫——空就抛
  `CommandExecutionError("... lost its Services page URL across the edit navigation
(sessionStorage unavailable?)")`;并把后面 `deriveMediaUrl(baseServicesUrl || hereServices)`
  里现已成死代码的 `|| hereServices` 兜底去掉(守卫已保证非空)。改完测试 9/9 绿,esbuild exit 0。
- **教训**:state machine 里**任何「从暂存恢复出来、再喂给 `new URL()`/`deriveXxx()` 的值」
  都要先判空再用**——存储被禁是 fail-closed 的合法触发路径,不能让它绕过你精心写的 clear
  error 从一个**更底层、更难懂**的构造函数(`new URL`)里漏出来。fail-closed 的错误类型本身
  就是契约的一部分(上层按 `CommandExecutionError` 决定降级),裸 `TypeError` 会击穿它。

**`linkedin/search`(`--details` 是 LOOP 状态机,不是定段 2-stage)**

- **形态**:`--details` 默认 false。LIST 在搜索页单 goto 取到(已安全,逐字节不变)。开了
  `--details` 后 `enrichJobDetails` 是个**导航循环**:对每个 job `goto job.url; scrape 描述`。
  改写成 **loop 状态机**:stash `{ jobs, cursor, enriched }` 进 `__web_linkedin_search__`;
  每次 replay 落在 `jobs[cursor].url`,scrape→push→`cursor++`→`goto jobs[cursor].url`(→ 再
  reinject);cursor 耗尽则清键返回 enriched。顶部 resume 守卫:`includeDetails &&
typeof page.getCurrentUrl === 'function'` 且 URL 命中 `/jobs/view/` 且有 live stash 才进
  loop——**搜索 goto 与 voyager list-fetch 不在 per-job replay 重跑**(list 从 stash 恢复)。
  per-row 失败语义(`no url` / `fetch failed: ...` / `missing description`)全保。
- **新增 degrade(防 ping-pong,落实约束「never loop」)**:loop SM 不是「最终页恢复暂存、丢了
  就抛 clear error」那种定段形态——它**靠 stash 在每次 reinject 间存活**。若 sessionStorage 被
  禁:stage-0 seed 写 setItem(guard 返回 false)→ 导航到 job[0] → reinject → resume 守卫
  `readDetailsStash` 取回 null → 落到**全新搜索** → 重新 seed → 又导航到 job[0]……**无限
  ping-pong**(正是 spec 警告的 "never loop")。修法:`stashDetailsState` 写完**立刻 getItem
  读回验证**(guard set 返回 false 时 readback 为 null),只有读回成功才证明下次 reinject 能
  resume;读不回就**在 stage-0(首次导航之前)/ loop 中途**调用 `degradeRemainingJobs`:把剩余
  job 直接产出 `detail_error: "details unavailable for in-page execution"` 的非富集行,**不再
  导航**。所以这条 adapter 的 fail-closed 是**降级返回**(read,无副作用,部分富集即可),不是
  抛错——与 `services-read`(write 前置,必须 fail-closed 抛错)的契约不同。
- **测试**:`tests/adapters/linkedin/search.test.ts` 新增 3 个 func 级 `--details` e2e:
  (1) 跨导航富集 2 个 job、断言搜索页只 goto 一次、voyager list **不**逐 job 重取;
  (2) per-row 语义(no-url 行 + missing-description 行)保持;(3) `blockStorage: true` 时
  **不导航任何 job 页**(`gotoUrls` 里无 `/jobs/view/`)且全行降级。原 19 个 `enrichJobDetails`
  断言(LINEAR 路径,单测/非 trampoline 运行时仍走它)全保。`withSessionScratch` 内存 Map 模拟
  storage 脚本;degrade 测试不能用它(它内部拦截 setItem 必存)——改用裸 `vi.fn`,setItem→false、
  getItem→null,真 scrape 落到 `scrape()`。esbuild exit 0,`tsc --noEmit` exit 0,22/22 绿。
- **教训**:**loop 状态机的 fail-closed ≠ 定段状态机的 fail-closed**。定段是「最终页丢暂存就抛
  CommandExecutionError」;loop 没有「最终页」,丢暂存意味着**下一跳会重走入口 → 自我重入**,
  所以必须在**导航之前**用「写后读回」证明 stash 可存活,存不活就**就地降级、绝不导航**。判据是
  「这次 set 的值我现在能 get 回来吗」,不是「set 脚本返回了 true 吗」——guard 脚本的返回值与
  「值是否真落盘且能跨 reinject 读回」不必然一致,只有读回才是证据。

**写操作的幂等性(read/write 的关键非对称)**:纯读 adapter(`jobs-preferences`/
`profile-read`/`services-read`/`search`)replay 多次只是重复 scrape 同源 DOM,无副作用——
天然 idempotent。**写** adapter 的状态机最后一段「send」必须**单次触发**:replay 重跑绝不能
二次发送。本轮两个写 adapter 各自的论据:

- **`twitter/reply-dm`(写循环,confidence 高)**:两层守卫。(1)**硬前置 DOM 门**:发送
  脚本在 focus 输入框 / click 发送 _之前_,当 `skip-replied`(默认 true)时读该会话自己的
  DOM(`DmScrollerContainer`),若 `chatText.includes(messageText)` 就返回 `skipped` 不发——
  因为我们发的就是 `messageText`,**任何 replay 落回已发过的会话都会看到自己的消息而短路**。
  (2)**单调 cursor**:`cursor++` 和 stash 都在 `goto 下一会话` *之前*完成,reinject 后从
  `cursor+1` 续跑,刚发过的会话不会被重入。两者叠加:正常路径 cursor 不回头,`skip-replied`
  DOM 门是「整条命令被重试 / cursor 走错」时的兜底。**注意**:用户显式 `--skip-replied false`
  时第 1 层失效,仅靠 cursor 单调性——sessionStorage 被擦才可能重发(罕见,已记)。

- **`linkedin/salesnav-message`(写,发 InMail **耗 credit**,confidence 高)**:**消灭发送后导航**
  来根治。credit-costing 的 POST 本就是同源 `fetch`(不导航);唯一的发送后副作用来源是旧版的
  「落地页核验」`goto(leadUrl)` —— 它是发送之后**仅有的** reinject 点。改法:**核验也走 `fetch`**
  —— 发送 POST 经 `requireFetchResult` 已断言 HTTP 2xx(非 2xx/auth 直接抛),那就是 LinkedIn 对
  `createMessage` 的成功确认;再用 credits 前后差(`creditsAfter < creditsRemaining`)佐证(open-link
  免费发不耗 credit,故只报告不强求)。**发送之后不再有任何 `page.goto`**,所以 func **发送后永不
  reinject** → 那个 `fetch` 一趟命令**必然只发一次**。发送 _之前_ 的导航(可选的 SALES_HOME 预热、
  以及未解析 `/in/` recipient 时 `resolveRecipient` 的 lead 探测)都有 URL 守卫防 ping-pong,且都
  严格在发送上游 —— 早期 pass 在到达发送前就 `NAVIGATE_RESTART`,只有最终 pass 流到发送一次。
  这比旧的「sessionStorage 哨兵 + 落地页实时 DOM 守卫」两道门更强:旧法残留一个
  **「存储跨导航被擦」⨯「已发活动渲染延迟」同时发生 → 可能二次发送** 的竞态(故当时记为 confidence 中);
  **去掉发送后导航后该竞态从根上消失**(没有发送后 replay,就没有重发的入口)。代价:核验从「抓落地页
  DOM 文本」变成「信任发送 API 的 2xx + credits 差」——对 `createMessage` 这种动作端点,2xx 即创建成功,
  与该 adapter 对 profile/credits 两个 `fetch` 的信任方式一致。`salesPageShowsSentMessage` /
  `salesLeadUrlFromParts` 退化为 `__test__` 纯函数(不再被 func 调用)。**仍建议真机验证**(写 adapter
  上线前用一次性会话试),这批改完照例**不自动 commit**、等用户确认。

**教训**(写操作单发的两档强度,优先用上面那档):

1. **最强 —— 让副作用之后没有导航**:`page.goto` 是唯一的 reinject 来源,所以**只要副作用
   (这里是发 InMail 的 `fetch`)之后不再有任何 `page.goto`,func 就永不在发送后 reinject,单发是
   *结构性* 保证,无需任何守卫**。`salesnav-message` 就是把发送后的「落地页核验 goto」换成同源
   `fetch` 核验做到的。判据:**把所有 reinject 点列出来,确认副作用严格在最后一个之后**——能做到就
   不要留任何「发送后导航」。
2. **次强(当写本身就是导航循环、躲不开发送后导航时)** —— 如 `twitter/reply-dm`:把「副作用是否已
   发生」做成**可观测、跨 reinject 存活的事实**(媒介自身的 DOM 证据,如 `skip-replied` 读会话里
   有没有我发的那条)+ **单调推进的 cursor**(stash 在 goto 之前)。这是退而求其次,因为它依赖
   「证据已渲染 / 存储存活」这类运行时条件。

纯读没这负担。一旦 func 带副作用:**先想能不能把副作用挪到所有导航之后**(消灭 reinject 点);
做不到再上「可观测哨兵 + 单调 cursor」;两者都给不出一句话的幂等论据,就 fail-fast,别赌。

## 11. 市场布局 v2:per-file + sha256(为公开市场铺路)

> 关键改动 commit:`<next>`(本节描述的整体 schema-v2 切换)。

### 11.1 为什么不能继续一个 JSON 包到底

v1 把 345 个 adapter 全部 inline 进一个 `marketplace/index.json`(2.0MB / 3060 行),想法是"单文件可托管在任何地方(gist/S3/CDN/gh-pages)"。这个简化在初期合理,但跑了一阵后暴露三个问题:

1. **改不动**:想看一个 adapter 的代码,要在 3000 行 JSON 里挖一段 escape 过的字符串源码,IDE 无语法高亮、无跳转、grep 噪音爆炸。AI agent 读这玩意儿尤其惨——一次 read 撑爆 context。
2. **缓存粒度太大**:任何一个 adapter 改一行,整个 2MB 重下。远程市场化之后这是浪费;本地包也有 git diff 体积问题(每次 build 整个文件 churn)。
3. **schema 没准备好长线**:v1 字段(`{site, name, source, type, ...}`)漏了所有"市场即将需要"的元数据 —— 版本号、作者归属、tier(官方/社区)、内容哈希。要等远程上线再加,就得做一次 schema 迁移 + 老 cache 兼容。提前把字段加齐,更省事。

### 11.2 v2 schema

```
marketplace/
  index.json                  # metadata only, ~116KB for 284 adapters
  <site>/<name>.js            # bundled adapter source (one file per adapter)
```

`index.json` 每条:

```jsonc
{
  "site": "zhihu",
  "name": "answer-detail",
  "description": "知乎单个回答完整内容(按 answer ID 获取)",
  "access": "read",
  "type": "func",
  "tier": "official", // 或 'community' — 远程社区 adapter 上线后启用
  "author": "opencli", // 社区 adapter 写 GitHub handle
  "version": "1.0.0", // 手动 bump;真正的 upgrade 判定靠 sha256
  "source": "zhihu/answer-detail.js", // 相对路径,远程/本地同一份 schema
  "sha256": "1dc7b57b...", // 内容哈希:防替换 + upgrade 检测
}
```

顶层加 `version: 2`(schema 版本)+ `bundledAt`(ISO 时间戳)。客户端见到 `version !== 2` **拒绝加载**,而不是宽松解析丢字段,防止 half-migrated cache 静默 fail。

### 11.3 fetch 路径:两阶段 + 哈希校验

```
SidePanel 打开 → fetchMarketIndex() → index.json (~116KB) 一次性
                                    → 显示卡片
用户点 install → fetchAdapterSource(adapter)
                     → URL = new URL(adapter.source, baseUrl)
                     → 拉单个 .js (5-30KB)
                     → 算 sha256, 跟 adapter.sha256 比
                     → 不匹配抛错,绝不 silently 用差异 bytes
                → installAdapterFromSource(text, ...)
```

`baseUrl` 当前 = `chrome.runtime.getURL('marketplace/')`(本地包)。**远程市场上线时只改这一处**——schema 不动、fetch 代码不动、install 路径不动。这是当下做 v2 重写的最大价值:**远程 readiness 几乎零代码差**。

### 11.4 为什么 sha256 而不是 ETag / version

- **内容寻址 vs 元数据**:ETag 是服务器声明,version 是作者声明,都需要"信"。sha256 是**客户端可验证**的事实 —— index 说 X,body 是不是 X,自己算一遍就知道,不需要信任中间任何一环。
- **防"审核后偷换"**:未来开发者市场最现实的攻击是 review 通过后悄悄换 body。CDN/storage 端没"内容 immutable"保证。客户端校 sha256 是唯一可靠门控。
- **upgrade 检测**:installed adapter 存 sha256(install 时记下);客户端定期跟当前 index 比对,不同 → "有新版可用"。比 version 字符串可靠(开发者忘 bump 也能检测到)。
- **本地包也得校**:即便 built-in,也防 dist 被外部工具篡改 / build 时部分文件 stale。零信任默认更省事。

### 11.5 兼容性

- **已装 adapter**:source 已经在 IndexedDB,**不需要再走市场 fetch**,完全 untouched。schema-v2 只影响"装新 adapter"路径。
- **手动 paste-install**:不走市场,源码直接进 sandbox eval,跟以前一样。
- **老的 `marketplace-index.json` URL**:废弃。`web_accessible_resources` 移除该条目,改成 `marketplace/index.json` + `marketplace/*/*.js` glob。老的 dist 重 build 即新。

### 11.6 没做的事(留给后续 PR)

- **远程 baseUrl 设置项**:`chrome.storage.local` 加个 `remoteMarketUrl` 字段 + SidePanel 设置 UI。代码层 fetch 已支持(`fetchMarketIndex(baseUrl)` / `fetchAdapterSource(adapter, baseUrl)` 都接 baseUrl 参数)。
- **community tier UI**:`MarketAdapter.tier` 字段已存在,但 Adapters.tsx 还没按 tier 分组渲染。等远程跑通了再做。
- **审核 / 上传 pipeline**:需要后端 + GitHub-style 提交流。完全独立工程。
- **upgrade 提示**:installed adapter 存 sha256 字段,周期性跟 index 比对,UI 弹"有更新"。代码 hook 点都已就位(`installed-store.ts` schema 加 `sha256` 字段即可)。

## 12. 对未来「自己拼 Tampermonkey 替代品」的人

底层能力已经全部解锁:

- USER_SCRIPT world(`chrome.userScripts` API,Chrome 138+)有 DOM + `chrome.runtime.connect/sendMessage` + 可配 CSP
- runner 注入和双向通信链路已建好(`src/userscript/runner.ts` + `src/userscript/sw-runner.ts` + `protocol.ts`)
- page.\* RPC 桥已建好,跟 CDP-based PageShim 拼接(`src/userscript/rpc-server.ts`)
- 安装/卸载/启停/持久化已有(`src/adapters/install-manager.ts` + `installed-store.ts`)
- 跨重启恢复已有(`loadInstalledOnBoot`)
- session 内热刷已有(`getRegistryVersion()` + `session.lastSeenRegistryVersion`)

差什么:

- URL 匹配自动注入(目前是 agent 主动调时按需注入;Tampermonkey 是页面加载时自动跑)→ 用 `chrome.userScripts.register({matches, runAt, js})` 替代 `execute`
- `GM_*` API shim(`GM_xmlhttpRequest`/`GM_setValue`/`GM_getValue`/...)→ 包装现有 `page.*` RPC 或加 SW 的 `chrome.storage` 路由
- 脚本编辑器 UI(现在只有「贴码安装」 + 市场浏览)

→ **架构上不用动**,加这三层就成 Tampermonkey 替代品。但我们目标不是这个,所以不做。

## 13. 适配器测试覆盖:从 opencli 移植(2026-05-31 sweep)

marketplace 改为手动维护(§10 / commit `e9c211c`)后,bundle 后的 adapter 失去了 opencli 仓库里的 `*.test.js` 保护。这次做了一轮全量移植,把 opencli 的测试搬到「我们实际 ship 的 bundle 产物」上,既补回行为护栏,也用「忠实移植的断言能否通过」当 porting bug 探针。

### 13.1 方法

- **先静态审计再补测**:`/tmp/recon-adapters.mjs` 扫全量 adapter 按 bug 形态分类(import 的名字 ∉ 注入 scope / stub util 被调 / `node:` / 残留 alias / captureNetwork),确认系统性的坑在 §10.18 一把修完,剩下的 per-adapter 逻辑 bug 用移植测试来逼出来。
- **per-site 并行 workflow**:14 个 shipped 且有 opencli 测试的站点,各一个 agent 移植 + 自行 `vitest` 跑绿,只许写 `tests/`,不许动 `marketplace/`/`src/`/`index.json`(避免并发写 index.json 冲突;真 adapter bug 集中由 orchestrator 串行修 + 轮 sha256)。
- **bilibili 作为参考样板**(§10.14 期间手写的 7 个测试 + `tests/adapters/_helpers/bilibili-page.ts`):agent 照着它学 porting 套路。

### 13.2 移植时的固定 divergence(都是机械适配,不是 bug)

1. `getRegistry().get('site/name')`(opencli 的 Map)→ `findAdapter('site','name')`(我们 registry 是数组,`src/runtime/registry.js`)。
2. 错误类从 `src/runtime/errors.js` import,不是 `@jackwener/opencli/errors`。
3. **没有 `./utils.js` 模块边界可 mock**——bundle 把 utils inline 了。改成在 adapter **真正跨的最低边界**拦截,通常是 `page.evaluate(<string>)`:fake page 解析 fetch 的 URL → 路由到 `vi.fn()`(见 bilibili-page.ts);signing 参数(wbi 的 wts/w_rid 之类)在路由层剥掉再断言。
4. URL query 参数回来都是**字符串**:opencli 断言 `{oid: 123}` → 我们 `{oid: '123'}`。
5. fake page 作为**第一个实参**传给 inlined apiGet(opencli 在模块级 mock,用 `{}` 当 page);断言 `page.apiGet` 被 `(page, path, opts)` 调用。

### 13.3 发现的 seam 谱系(每站不一样,所以 per-site agent 是对的拆法)

- **API-routing + 签名**:bilibili(wbi)、douyin(`browserFetch`)、weibo —— fake page 解析 fetch URL 路由。
- **DOM-driven**:linkedin / douban / claude / xiaohongshu —— `goto`/`wait`/`autoScroll` + `page.evaluate(<提取脚本>)` 返回 canned payload。
- **global fetch**:weread、wikipedia —— adapter 直接用全局 `fetch`(wikipedia 的 func 签名甚至是 `async (args)=>`,根本不收 page),测试 stub `globalThis.fetch`。
- **pure helper via `__test__`**:notebooklm / youtube/channel / zhihu 部分 —— bundle 通过 `export { __test__ }` 暴露 inlined 纯函数,直接单测。

### 13.4 结果

- **+882 测试,14 站点,全绿**;全量套件从 268 → **1150 tests / 138 files**(本地 `npx vitest run` 实测,非 agent 自报)。
- **0 个 adapter bug**:pipeline/func adapter 是 opencli 的忠实 esbuild 产物,行为一致;系统性的坑(注入 scope stub / 错误类 instanceof / log 缺失)已在 §10.18 统一修掉,所以移植阶段没再炸出新的逻辑 bug。
- **跳过(记录在案,非偷懒)**:
  - 纯 helper 测试,但该 helper 被 inline 成 file-local 且 bundle 没 `__test__` 导出(linkedin/posts 的 activityUrl/parseMetric、xiaohongshu/note 的 parseNoteId 等)——其行为通过 func 间接覆盖了。
  - **依赖 jsdom 的 DOM 提取测试**(xiaohongshu + linkedin):opencli 用 `new JSDOM()` 把生成的 `buildXExtractJs` 脚本喂真 DOM 跑。当时没装 jsdom——**唯一真正的覆盖缺口**,那些 DOM 提取脚本整体没被执行过,正是 porting bug 可能藏身处。→ 已在 §13.6 补回。

### 13.5 教训

- **测「你 ship 的产物」,不是「上游源码」**。opencli 测的是带 `./utils.js` 模块边界的源文件;我们 ship 的是 inline 后的 bundle。同一个断言,mock 的接缝完全不同——直接 copy opencli 测试会全红。
- **per-site 拆分是对的**:14 站 14 种 seam,没有「一个 generic fake page 通吃」。让每个 agent 读自己站的 adapter + opencli 测试自己推接缝,比预先设计统一 helper 更省、更对。
- **移植测试 = 廉价的 porting-bug 探针**:忠实搬 opencli 的断言,能过就证明 bundle 行为对;过不了且不是机械适配问题,就是真 bug。这轮 0 bug 本身就是「bundle 管线忠实」的证据。

### 13.6 补回 jsdom DOM 提取测试(同 sweep 收尾)

装 `jsdom@29`(devDep),把上面跳过的 DOM 提取测试补回来。这些测试**不依赖 mock seam**——opencli 直接 `new JSDOM(html)` + `dom.window.eval(buildXxx(...))` 把**生成的提取脚本字符串**喂进真 DOM 跑,断言抽取结果。所以近乎逐字移植(只改 builder 的 import 路径 + `__test__.` 取法)。

- 4 个 adapter 的 builder 在 bundle 里都够得着:`buildCommentsExtractJs`(comments,直接 export)、`__test__.buildLocateAndMaybeDeleteScript`(delete-note)、`buildSearchExtractJs`/`buildScrollUntilJs`(search,直接 export)、`__test__.buildSentInvitationsScript`(sent-invitations)。
- jsdom 不做 layout,要把 opencli 的 `offsetParent` polyfill / `getComputedStyle` stub 一起搬(可见性判定靠它们)。programmatic `new JSDOM()` 在现有 `environment:'node'` 下直接能用,不用改 vitest 配置。
- **补回 5 个 DOM 测试,全绿,0 adapter bug**:把 5 个 builder 跟 opencli 原版逐行 diff,生成脚本**一字不差**——再次证明 esbuild bundle 忠实。全量套件 1150 → **1155 / 138 files**。
- 剩下没补的只有「纯 helper 被 inline 成 file-local 且 bundle 没 `__test__` 导出」那几个(linkedin/posts、xiaohongshu/note),要补得改 marketplace 源码加导出 + 轮 sha256,收益不抵改动,**留着**(行为已通过 func 间接覆盖)。

### 10.23 `youtube__transcript` 报 `Caption URL returned empty response`——timedtext 的 pot-token 时代

**症状**:`youtube__transcript {url}` 失败,`CommandExecutionError: Caption URL returned empty response`。

**根因**:这条报错来自 adapter 的**最后一层兜底**(strategy 3,`transcript.js` 里 fetch
`ytInitialPlayerResponse.captions...captionTracks[].baseUrl` 那段)。能走到这层,说明前面两层都没拿到字幕:

1. **player 抓取**(读 `movie_player`、hook fetch/XHR、`setOption('captions',…)`+`playVideo()`,轮 15s 等播放器自己发的带 `pot=` 的 json3 timedtext 请求)——这层**依赖视频真的开始播放**;标签页非前台 / autoplay 被拦 / 播放器没发 caption 请求时就 miss。
2. **network capture** 回放——同理没抓到。

到了 strategy 3,它 fetch 的是服务端渲染进 HTML 的**裸 `baseUrl`**。YouTube 近一年改了:`/api/timedtext` URL **缺少 `pot`(proof-of-origin token)时返回空 body(HTTP 200 但 0 字节)**。裸 baseUrl 天生没有 pot(pot 是客户端 BotGuard 现生成的),所以必然空 → 报这条错。注意 strategy 1 的 URL 过滤里本就强制 `url.includes('pot=')`,正是同一个原因。

**修法**:加一层**不依赖 pot 的兜底**——InnerTube `get_transcript`(就是 YouTube UI「显示转写」面板用的接口),插在 network-capture 之后、裸-baseUrl 之前:

- 从 `ytcfg.data_` 取 `INNERTUBE_API_KEY` + `INNERTUBE_CLIENT_VERSION`,先 POST `/youtubei/v1/next` 拿
  `getTranscriptEndpoint.params`(深搜,容忍路径变动);拿不到就**兜底构造** `base64(pb{1:base64(pb{1:videoId})})`。
- 再 POST `/youtubei/v1/get_transcript {params}`,**深搜** `transcriptSegmentRenderer`(`startMs/endMs/snippet.runs[].text`)凑 segments。返回直接给字幕文本,**完全绕开 timedtext URL + pot**。
- 这层 best-effort:任何一步失败就**静默 fall through** 到原来的 watch-HTML 路径(保留「无字幕」的友好报错 + 语言列举)。源码改了 → 同 commit 轮了 `index.json` 的 sha256(`92d53e…`→`9b761b…`)。

**教训**:① YouTube 字幕已进入「**必须有 pot**」时代,任何"直接 fetch baseUrl/timedtext"的路子都会拿到**空 200**(不是 4xx,容易被误判成"有字幕但空")。② 可靠的 pot-free 路子只有两条:让**播放器自己发请求再 hook**(strategy 1,但依赖播放),或走 **InnerTube `get_transcript`**(UI 同款,稳)。③ 兜底层要会**静默退让**,不能把自己的失败 throw 出去盖掉下游更准的报错(如"该视频无字幕")。

**追加(lang 稳健性)**:实测发现**带 `lang:"en"` 反而失败、不带就成功**。根因是选轨逻辑不对称:`pickTrack` 在指定语言时只 `find(code===lang)`、**不区分 asr / 人工**,容易选中 asr 轨(其裸 baseUrl 受 pot 锁→空);不指定时则优先 `kind!=='asr'`(人工轨,能成)。修法:让指定语言也**优先人工轨**,且**请求的语言不存在时回退到 auto 顺序**(player 的 `pickTrack` + watch-HTML 兜底的选轨都改),这样「传 lang」最差也不劣于「不传」。教训:**带 lang 参数的精确化路径,行为不能比 auto 默认更差**——很多 adapter 的「指定 X」分支会忘了继承默认分支里的偏好/回退。

### 10.24 安装的 marketplace adapter 过期检测 + 自动 reload(免手动卸载重装)

**背景**:§10.23 修 `youtube__transcript` 时,用户**忘了重新 install adapter**,跑的还是旧源码,以为没修好。marketplace adapter 是**手维护**的(改源码必轮 `index.json` 的 sha256,见本文顶部规则),装着的那份是「当时的源码快照」存在 IDB(`installed_adapters.source` 逐字保存),**不会**因为 bundle 更新而自动跟进——只能手动卸载+重装。这对开发期(频繁改 adapter)很烦。

**做法**:加一条「开 sidepanel 时自动对账 + 重装漂移的 adapter」链路:

- **检测放 SW 侧**(`install-manager.ts#findStaleMarketplaceAdapters`):`InstalledAdapterSummary` 不带 source(消息体不想驮整段源码),但 SW 直接持有 IDB 全量记录 + 有 `crypto.subtle`。它 `listInstalled()` → 过滤 `origin.type==='marketplace'` → fetch 本地 `marketplace/index.json` → 对每条算 `sha256(installed.source)` 跟目录的 `sha256` 比;**不一致即漂移**。目录里已删掉的 adapter **不动**(绝不自动卸载)。任何 I/O 失败 → 返回空(不能因为目录读不到就卡住)。比的是 **sha256 不是 semver**(version 只是信息性的)。
- **重装放 sidepanel 侧**(`adapters-client.ts#reconcileStaleAdapters`):SW 只能返回漂移 id——**它不能 eval**(eval/capture 在 sidepanel 的 sandbox iframe 里)。所以 sidepanel 收到漂移列表后,对每个走**既有幂等重装路**(`fetchAdapterSource`(校 sha256)→ `installAdapterFromSource`(sandbox eval → `INSTALL_ADAPTER` → `installFromCaptured` 先 unregister 再 register,保留 `installedAt`))。单个失败**吞掉**,下次开 sidepanel 再试。
- **触发点**:`App.tsx` 挂载时 `void reconcileStaleAdapters()`,更新了就弹一条几秒自消失的 toast(`已自动更新 N 个市场 adapter:…`)。sandbox iframe 是**懒创建**的(`ensureSandbox`),从 App 挂载触发没问题。

**消息**:新增 `LIST_STALE_ADAPTERS` / `LIST_STALE_ADAPTERS_RESP {stale:{id,title}[]}`,只驮 id+title(通常 0 条),不驮源码。

**教训**:① 手维护 + sha256 闸的代价就是「装着的会过期」,**得有对账机制**否则开发期天天踩(忘重装)。② **检测**(要 source+crypto+目录)和**执行重装**(要 sandbox eval)天然分属 SW / sidepanel 两侧,别硬塞一边——SW 出诊断、sidepanel 落地,复用既有幂等装链。③ 自动 eval 第三方源码听着吓人,但这里**只重装用户已装过、且 sha256 现校于本地 bundle** 的那份,信任级别 = 当初手动装,安全。④ 加了 adapter 的新 evaluate 步骤会**打乱按序 mock 的 port 测试**(`transcript.test.ts` 的 `page.evaluate` 序列),改 adapter 必同步顺手把测试的 call 序号/桩补上(本次 +1 个 `get_transcript` 步)。

### 10.25 `get_transcript` 兜底是「哑」的:用了假 context → /next 不给 transcript 面板 → 每次都白跑 25s 再死

**症状**(§10.23/§10.24 上线后回归):本来 OK 的 `youtube__transcript {url}`(不带 lang)反而报 `Caption URL returned empty response`;另一些视频**60s 超时**——但用户自己在页面点「显示转写」**秒出**。

**根因**:§10.23 加的 `get_transcript` 兜底**根本没生效**,两个错叠加:

1. **context 是假的**:我手搓了个最小 `{ client: { clientName:'WEB', clientVersion:'2.2024…' } }`。YouTube 的 `/next` 在 context 不全(缺 `visitorData`/正确版本等)时**不返回 transcript 引擎面板**,于是 `findParams` 找不到 `getTranscriptEndpoint.params` → 构造的兜底 params 又不一定对 → `get_transcript` 拿不到 → 返回 null。
2. **位置是最后**:这条兜底排在 player 抓取(轮 ~25s 等播放)+ network capture **之后**。于是每个走兜底的视频都先**白白耗 25s** player 轮询,再 get_transcript(还失败),再 watch-HTML 裸 baseUrl(pot 锁→空 200)→ 报 empty;链路再叠 trampoline 重入就 60s 超时。「不带 lang 原来 OK」只是当时 player 路径**碰巧**抓到了,换个视频/时机就崩——本质是兜底从来没真正接住过。

**修法**(两条一起):

- **context 用真的**:`window.ytcfg.data_.INNERTUBE_CONTEXT`(页面自己用的那份,含 client/版本/visitorData/hl-gl),没有才退到最小版。这样 `/next` 才会带 transcript 面板,`getTranscriptEndpoint.params` 拿得到。params 取序:**先 fresh `/next`(锁当前 videoId)→ 再 `window.ytInitialData`(watch 页已有面板)→ 最后构造 protobuf**。
- **顺序提到最前**:`get_transcript` 变成**第 1 个策略**(navigate 之后立刻跑),命中就秒返回、**不碰 player 轮询**;只有它没接住才退到 player→capture→watch-HTML。等于跟 UI 的「显示转写」同款路径同款速度。

**取舍**:`get_transcript` 拿的是面板**默认轨**,所以 `get_transcript`-first 命中时 **lang 偏好被忽略**(指定语言的精确选轨仍由后面的 player 路径负责,但只有 get_transcript 失败才轮到它)。绝大多数视频只有一条/默认即所需,可接受;真要指定非默认语言再说。

**教训**:① 调 InnerTube 私有 API **必须用页面自己的 `INNERTUBE_CONTEXT`**,自己拼最小 context 会被服务端「降级」(少返回面板/continuation),还特别难查——表现是「没报错但就是空」。② 兜底**位置即性能**:慢且常失败的策略(player 轮 25s)排在快且可靠的(get_transcript)前面,等于给每次成功都加了 25s 税;**快的可靠的要排第一**。③ 「原来 OK」可能只是**侥幸**(player 抓到了),别把侥幸当契约——加确定性的主路径(get_transcript-first)才是修复。

### 10.26 `get_transcript` 还是空 + 60s 超时:它跑在 **youtube 首页** 上,params 取错了源

**症状**(§10.25 上线后仍失败):一次 `Caption URL returned empty response`,一次 **60s 超时**。看 SW 日志才看清真相:`senderUrl: 'https://www.youtube.com/'`——agent **复用了停在首页的 youtube tab**;第一个 evaluate(`scriptLen 3179`)就是 get_transcript,`valuePreview: 'null'`——它**在首页上跑、返回 null**;随后落进 player/`prepareYoutubeApiPage` 兜底,在首页 goto 上 **trampoline ping-pong(§10.21)→ 60s 超时**。

**根因**:§10.25 让 get_transcript 从「当前页的 `ytInitialData` / 一个 `/next`」找 transcript 面板的 params。但当前页是**首页**:首页的 `ytInitialData` 是首页信息流、不含我们这条视频的转写面板;首页 context 的 `/next` 也不带。于是 `findParams` 找不到 → 构造的 params 不一定对 → get_transcript 空。本质:**params 的来源不能依赖「tab 当前停在哪」**——而 §10.21 的「首页就跳过导航」又保证了 tab 很可能就停在首页。

**修法**:get_transcript 自己 **`fetch('/watch?v=<id>')` 把 watch 页 HTML 抓回来**,从里面抽 `ytInitialData`(复用 adapter 既有的 `extractJsonAssignmentFromHtml`)再 `findParams`。同源带 cookie 的 fetch 从**任何** youtube 页都能成,所以**不依赖导航、也不碰 trampoline**;watch 页的 `ytInitialData` 一定带转写面板(用户能点「显示转写」即证明)。取序变成:**watch-HTML 的 ytInitialData → `/next` → 构造**。get_transcript 命中即秒返回,player/兜底/超时都不会碰到。

**教训**:① func adapter **不能假设 tab 停在「对的页」**——复用 tab 很常见,当前页可能是首页/上一个视频/搜索页。要数据就**自己 fetch 那条 URL**,别读「当前页恰好有没有」。② 一条错误日志里的 `senderUrl` + `valuePreview:'null'` + `scriptLen` 比四轮盲改都值钱——**先看真实运行日志再动手**。③ 这类「只能在真实登录浏览器里复现」的 adapter,改完务必让用户贴一次运行日志/控制台验证,别靠纯推理迭代(本类问题已第 4 次)。

### 10.27 真·根因(第 6 轮才定位):func 从不导航到 watch 页 → player 路径瘫痪;get_transcript 又 400

**怎么定位的**:控制台 snippet 被聊天框**转义/智能引号**搞坏(反复 `Invalid or unexpected token`),改用「**在 adapter 里塞临时诊断、靠 SW 日志的 `valuePreview` 回传**」的办法,两轮把真相挖出来:

1. 第一轮诊断返回 `{psrc:'html', keys:'t:object'}` —— params **从 watch HTML 成功抽到**(我的解析没问题),但 `data` 是 `null`(`typeof null==='object'` 落进 else 分支),即 `get_transcript` 的 fetch **非 2xx**。
2. 第二轮诊断返回 `{st:400, body:'…Precondition check fai…'}` —— `get_transcript` 回 **400 `FAILED_PRECONDITION`**。这是 InnerTube 出了名难搞的错(要精确的 client/visitor 前置条件),**追它是无底洞**。

**真根因(两条)**:

- **get_transcript 对这条视频(以及很可能很多视频)就是 400**,pot-free 的 API 路子此路不通。
- 日志里 player evaluate(`scriptLen 9947`)**3ms 就返回 null** = 页面上**没有 `movie_player`** = tab 停在**首页**、视频根本没加载。而 **player 抓取才是真正能用的路子**(播放器自己发的 timedtext 请求带合法 pot,被我们 hook;6 轮前那次成功的完整字幕就是它产出的)。player 瘫痪,只因 func **从没导航到 watch 页**:`onHomepage` 守卫分不清「dispatcher 刚把 tab 开在首页」和「trampoline 弹回首页」,把**首次导航也跳过了**。

**修法**:

- 导航判据从 `onHomepage` 改成 **`onThisWatch`**(`/[?&]v=/` 且 url 含本 videoId):不在本视频 watch 页就 `goto(watchUrl)`;trampoline 重入时已在 watch 页 → 跳过 → **全程只一次导航、无 ping-pong**。
- **删掉 `prepareYoutubeApiPage` 的 `goto(首页)`**——它正是和 watch goto 对打的另一只手(§10.21 的 ping-pong 源头);下面的 watch-HTML `fetch('/watch')` 同源,在哪都能跑,不需要先回首页。
- get_transcript 保留为「快速首选」(命中即 pot-free 秒返回),但**去掉构造 params 的兜底**(从不对、只会 400),并明确:它失败就让 **player 路径接管**。

**教训**:① 浏览器里跑的诊断**别走「让用户粘控制台」**——富文本会把引号/反斜杠转义掉;**把诊断塞进 adapter 的返回值、靠现有日志回传**才稳。② `valuePreview` 里 `t:object` 这种「`typeof null`」的坑要会读。③ 一个守卫(`onHomepage`)同时管「首次导航」和「重入去抖」必然分不清两种语义——**去抖要用「是否已到目标态(onThisWatch)」判据,而不是「是否在某个中转态」**。④ 别为一个 `FAILED_PRECONDITION` 死磕私有 API,**先回到已被证明能用的路径**(player 抓取)。

### 10.28 Timeline 收尾打磨:思考步骤可折叠 + 首步去掉悬空竖线 + 多步任务最终答复跑到中间步骤

承接 §10.21/§10.22 的 plan-card / timeline 工作,这轮三处打磨。前两处纯 UI,第三处是行为 bug(用户点出「可能跟 `update_plan` 有关」——确实)。

**1)思考步骤现在可折叠(对齐 tool 行)**

此前 timeline 里 `kind==='reasoning'` 的行(模型 `reasoning_content` 思考 + 叙述)是**常驻展开**的一坨文字,而 tool 行早就能折叠(`TimelineToolRow` 的 `open` 状态)。把 reasoning 行抽成 `TimelineReasonRow` 组件,复用 tool 行的 head/body 折叠骨架:**默认收起**,收起态在 `.tl-label.think` 显示一行斜体 teaser(优先叙述、否则思考首行,`\s+`→空格压平),展开后显示完整思考 + 叙述。整条 timeline 因此读成「一行一步」的干净链路,而非夹着大段推理。CSS:把 `.tl-row.reason` 从原来的 `flex-direction:row`(图标+文字并排)改回 `.tl-row` 默认 column(head 在上、body 在下);`.tl-row.done` 保留并排(它无折叠)。

**2)第一个 step 不再画上方那截悬空竖线**

连接线是每行一条 `.tl-row::before`(`top:-7px; bottom:-7px`,故意上下各探出 7px 让相邻行的线连续;图标不透明圆点盖住其后的线)。一组 timeline 的**第一行**,其图标**上方**那截(到 `-7px`)没有上一行可连,是悬空线头。修法:`:not(.tl-row) + .tl-row::before`(前一兄弟不是 tl-row,即紧跟 user/answer 气泡后的首行)+ `.tl-row:first-child::before`,把 `top` 从 `-7px` 改成 `11px`(落在图标圆点内、被圆点盖住 → 线实际从图标底缘 ~24px 才露出 → 上方无线头)。连续的 tl-row(含 `✅ 完成` 的 done 行)不命中该选择器、仍保留满高线,**向下链路不断**。

**3)多步任务:最详细的回答跑到了中间某步,最后反而只剩一句总结**

**症状**:多步 task 跑完,**中间某个 step** 里贴着一大段详尽结论,而最后那条 answer(`✅ 完成` 之后的气泡)反倒是空洞总结。

**根因**:`classifyTurn`(`App.tsx`)的判据是「某条 assistant turn 之后、下一条 user 消息之前**还有 tool turn**,就归为中间 `reasoning` 步;否则才是最终 `answer`」。而模型**习惯把详细结论和收尾的 `update_plan`(标最后一步 completed)塞进同一条消息**——这条消息带了 tool_call(update_plan),于是其正文被判成中间 reasoning 步显示;真正不带 tool_call 的末条消息只剩总结、成了 answer。即:**详细内容因为「与一个 update_plan 同条」被降级成中间步**(正是用户「跟 update_plan 有关」的直觉)。

**修法**(纯 prompt,不动 `classifyTurn`——它的语义没错):让模型**最终回答单独成条、且不带任何工具调用**;要标最后一步完成就**先单独 `update_plan` 收尾,下一条消息再作答**。三处同一规则层层兜住:

- `systemPromptApi()` 的「工作方式(多步任务)」新增「最终回答留到最后、单独成条」一条(并 bump `PROMPT_VERSION` → `2026-06-03.1`);
- `renderPlanBlock()`(有计划时每轮注入的计划块)结尾补「全部做完后先单独 update_plan 标完最后一步,再单独一条作答」——正好命中多步场景;
- 自检消息(`api-engine.ts`,各步落定后的 `[自检]`)把「直接给用户最终答复」改成「用一条**不带任何工具调用**的消息给出**完整、详细**的最终答复(别只给一句总结)」。

**教训**:① 看似 UI 归类 bug,根子在**模型把「终态动作 + 终态答复」耦合在同一条消息**——修 prompt 比改归类对(「turn 后面还有 tool 就算中间步」本身没错)。② 「内容显示在错误 step」类问题,先看**分类判据的输入**(这里是 turn 序列里 tool 的相对位置),即可反推是模型的消息编排触发的。③ 同一收尾规则在 system prompt / 每轮计划块 / 自检三处各落一遍,才兜得住模型不同时机的收尾。

### 10.29 `zhihu__search --type question` 几乎必空:严格过滤通用搜索 → 改为「从答案反推问题」

**症状**(真机 trace,并行测试时发现):一个任务里几个 `zhihu__search` 失败——`中医调理肝肾 气血`、`肝肾亏虚 如何调理`、`气血不足 怎么补` 全是 `EmptyResultError: No question results found`,其中一个还**跑了 16.5s 才报空**;而同义的 `type:all` 查询 2.5s 就返回一堆结果。用户反映「这些词我自己搜是有内容的」。

**根因**:`marketplace/zhihu/search.js` 不管 `type` 是什么,都只打**通用搜索**端点(`search_v3?...&t=general`),再**客户端按 type 过滤**。知乎通用搜索对这类自然语言长查询返回的**几乎全是 answer / article、极少 question 对象**;`type:question` 把它们全过滤掉 → 为了凑够 `limit` 条 question 一直翻页(故 16.5s 慢)→ 仍是 0 → 抛 `EmptyResultError`。即:内容是有的(都在答案里),但「只保留 question 对象」这条过滤跟知乎的返回结构对不上。

**修法**(改 adapter + 走 marketplace 子模块流程):`type:question` 不再做严格过滤,改为**从每条命中反推它背后的问题**——直接的 question 命中用自己;answer 命中取其 `obj.question`(id+name);article 无父问题,跳过;按 question id 去重,`votes` 用答案的 `voteup_count` 当热度提示。新增纯函数 `deriveQuestionRow(obj)`(导出到 `__test__`),在结果循环里 `type==="question"` 时走它、其余 type 原样走 `normalizeResultItem`(`all`/`answer`/`article` 行为不变)。流程:改 `marketplace/zhihu/search.js` → `shasum -a 256` 重算 → 同步轮换 `marketplace/index.json` 里该条 `sha256`(并 bump `version` 1.0.0→1.1.0)→ 提交并推子模块 → 主仓 bump 子模块指针。**注意**:① marketplace 也吃主仓 eslint —— 初版 `let questionId = null` 触发 `no-useless-assignment`(两分支都重新赋值、else 直接 return),改成 `let questionId;` 无初值;**改完源码 sha 又变了,要再轮换一次 index.json**。② 装过的旧副本不会自动升级——见下「教训」。

**教训**:① 站点搜索的「按类型」往往是**客户端过滤通用结果**,而不是真有独立的类型化端点;当某类型(question)在通用结果里稀疏,严格过滤就会「有内容却报空」。**反推**(从答案拿问题)比「换端点」更稳,也更贴合用户意图(「找关于 X 的问题」= 大家在答的那些问题)。② 改 marketplace adapter 是**两段式 sha 轮换**:任何一次源码改动(哪怕只为过 lint)都要重算 sha 回填 index.json,否则安装路径的哈希校验会拒绝。③ 这个空结果还**放大了串行**:模型搜不到就改词重试,重试天然一回合一个 → 看着像「搜索不能并行」。其实 dispatcher 已能并行(同 trace 里两条 `type:question` 搜索同时跑),根因是**失败逼出的串行重试**——修好搜索,串行重试自然消失。④ 旧副本升级:运行时从 GitHub raw `main` 取 index.json+源码;**已安装的 adapter 是本地快照**,但面板会**自动对账并升级**(§10.30)——也可在「市场」页重装或 `load_adapter` 临时加载。详见 docs/parallel-execution.md §11–12。

### 10.30 已安装市场 adapter 自动升级:面板开启时 +「每 3 分钟」对账 sha

**背景**:§10.29 改了 zhihu/search 并推了远端,但**面板那会儿一直开着**,装着的旧副本没被换掉(只能手动 `install_adapter` 重装)。其实面板早有「漂移对账」:`reconcileStaleAdapters()`(`adapters-client.ts`)→ SW `findStaleMarketplaceAdapters()`(`install-manager.ts`):列出 `origin==='marketplace'` 的已装项,拉远端 `index.json`(`cache:'no-store'`),按 `${site}/${name}` 比 `sha256(installed.source)` vs 远端 sha,漂移的就重新 fetch(sha 校验)+ 重装(幂等,offscreen eval)+ ADAPTERS_CHANGED。**但它只在面板 mount 时跑一次**——所以「面板开着时」推的新版收不到。

**改法**(`App.tsx` 的对账 useEffect):从「仅 mount」加上**每 3 分钟轮询一次**(`document.hidden` 时跳过,省得看不见还拉 index),复用同一个 `reconcileStaleAdapters` + toast。这样面板开着时,新版最多 ~3 分钟内自动替换并提示「已自动更新 N 个市场 adapter」。轮询间隔是 `App.tsx` 里的 `RECONCILE_INTERVAL_MS`,要更灵敏就调小(代价:更频繁地 fetch index)。

**教训**:① 加功能前先 grep——「自动升级」其实已存在(`reconcileStaleAdapters` on mount),缺的只是「开着时也查」,加一个 `setInterval` 复用既有路径即可,别另起炉灶。② 漂移判据是 **sha(源码) vs 远端 index sha**,不是 semver `version`(version 仅信息性)——所以 §10.29 那种改动**必须轮换 sha** 才会被识别成「有新版」。③ 轮询成本 = 每次一个 `index.json` fetch(no-store);3 分钟一次可接受,再用 `document.hidden` 砍掉看不见时的拉取。

### 10.31 `zhihu__collection` 撞「知乎视频(zvideo)」类型直接抛错 → 整页取不到(异构列表「一条挂掉全页」)

**症状**(E2E 任务测试 E-19,bridge):`zhihu__collection {id:770546762, offset:20}` 与 `{id:135689507}` → `CommandExecutionError: Zhihu collection returned unsupported content type: zvide`(`zvideo` 被截断显示);同夹 `offset:0`(该页恰好没视频)正常返回 20 条。即收藏夹里只要混进一条「知乎视频」,含它的那一页(乃至整夹)就全军覆没。

**根因**:`marketplace/zhihu/collection.js` 的 `mapCollectionItem` 只认 `answer`/`article`/`pin` 三种 `content.type`,对其它类型(这里是 `zvideo`)**直接 `throw`**(原意是「不让 row 静默空白」),但 throw 发生在结果 `.map()` 里 → **一条未知类型让整页 reject**。知乎收藏夹是**异构列表**(回答/文章/想法/视频…混排),硬性「只认三种、否则抛」必然在视频收藏上炸。

**修法**(改 adapter + 走 marketplace 子模块流程):① 给 `zvideo` 加一条分支(取 `content.title`/`description`/`url`(无则拼 `https://www.zhihu.com/zvideo/${id}`)/`author.name`/`voteup_count`);② 把「未知类型」与「缺 title/url 的畸形项」的两处 `throw` 都改成 **`return null`(跳过)**,func 末尾 `.map(...).filter(Boolean)` 滤掉。这样视频被正常收录、未来新类型也只是被跳过而非炸整页。流程:改源 → `shasum -a 256` 重算(`b5ee3ff5…`→`acff5629…`)→ 轮换 `marketplace/index.json` 该条 `sha256` + bump `version` 1.0.0→1.1.0 → 提交推子模块 → 主仓 bump 指针。

**教训**:**异构列表 adapter(收藏夹/feed/timeline/通知)对未知 item 类型要「降级跳过」,绝不能让一条挂掉整页**——与 F-20(reddit subscribed 的 `u_` 个人 sub 让整列空)同一类。「不让 row 静默空白」初衷没错,但实现应是「跳过该行(+可选 debug 日志)」而非 throw。凡遍历用户异构数据的读路径(尤其收藏/历史/feed)都按这条审一遍。对应 findings.md F-23。

**复测**(bridge):推子模块 `2bbe51a` 后,SW 重启(bridge daemon 掉过一次、自动重连)清掉旧 temp-load,重新 `load_adapter zhihu/collection` 取到 v1.1.0;之前必炸的两页——`770546762 offset 20`(返 18 条,含 `[zvideo] 48个英语音标示范`)、`135689507`(返 6 条,含 `[zvideo] 耳鸣缓解小技巧`)——都正常返回,zvideo 行带 title/url。状态:✅ 已修并复测。

### 10.32 author `bilibili__collect`(收藏写)+ 改正 `bilibili__favorite` access write→read

**背景**(E2E 写测试 E-22 / findings F-25):要"收藏 BV1xdEA6TEqY 再取消",但市场**没有 bilibili 收藏-写工具**——`bilibili__favorite` 名为收藏、**实为 read**(`fid/limit/page`,`apiGet` 列 `/x/v3/fav/folder…list-all` + `/fav/resource/list`),且 `access` 误标 `write`(F-16 同类)。

**author 新 adapter `bilibili/collect.js`**:`POST /x/v3/fav/resource/deal`(`rid=aid`、`type=2`、`add_media_ids`/`del_media_ids`、`csrf=bili_jct`),**同一工具正反向**(`--action add|remove`)+ `--execute` 闸(无则拒写);默认收藏夹取 `created/list-all` 里 `attr==0` 的那个(925019769「默认收藏夹」)。复用 `comment.js` 整套 helper(`apiPost`/csrf、`resolveBvid`、`bvid→aid` via `/x/web-interface/view`、`requireOkPayload`)。**先 `eval_js` 验 deal API**(add+remove 净零、code 0)再落 adapter。改正 `bilibili/favorite.js` `access:"write"→"read"`(它只读)。

**marketplace 流程(新增 adapter)**:写 `bilibili/collect.js`(算 sha + 在 `index.json` **新增一条**:site/name/description/access/domain/type/tier/author/version/source/sha256 + `count` 284→285),favorite.js access 改 + 轮换其 sha,提交推子模块 `2d89245`、主仓 bump 指针。**bridge 复测**:propagate(~35s)后 `load_adapter bilibili/collect` → dry-run 拒写、`collect{BV1xdEA6TEqY,add,execute}` 进默认夹(`bilibili__favorite` 核验置顶)、`collect{remove}` 消失,**净零** ✅。

**教训**:① **新增 adapter = 写 `.js` + 在 `index.json` 加条目(sha+source+access)+ bump `count`**——与改源一样要算 sha,别漏 count;② 写 adapter 复用同站已有 write(comment.js)的 csrf/aid helper,别重造;③ 落 adapter 前先用 `eval_js` 把写 API 跑通(可逆净零),adapter 只是把验证过的逻辑包起来;④ 名字别误导(`favorite`=读收藏夹 vs `collect`=收藏视频写)。对应 findings.md F-25。

### 10.33 author `zhihu__unlike`(取消赞,补 F-24)

**背景**(E2E 写测试 E-21 / findings F-24):`zhihu__like` 幂等(再调仍 Liked、票数不变),市场无 `zhihu__unlike` → 可逆点赞对撤不回来,E-21 的赞一度暂留。

**author `zhihu/unlike.js`**:与 `zhihu/like.js` **同构**——同一 `parseTarget`/`assertAllowedKinds`(加 `unlike:['answer','article']`)/`requireExecute`/`buildResultRow`、同一 `POST /api/v4/{answers|articles}/{id}/voters`、`credentials:include`、`--execute` 闸,**唯一区别 body `{type:'neutral'}`**(like 是 `'up'`)。**先 `eval_js` 验**:neutral POST 返回 `success:true / voting:0 / voteup_count:41`(顺手把 E-21 的赞 42→41 撤了)。

**marketplace 流程**:写 `zhihu/unlike.js`(算 sha + index.json 加条目 + `count` 285→286),推子模块 `815960b`、主仓 bump 指针。**bridge 复测**:propagate(~60s)后 `load_adapter` → dry-run 拒写 → `zhihu__like`(41→42)→ `zhihu__unlike`(42→41),POST 响应 + **authoritative GET** 都 41,净零 ✅。

**注(缓存陷阱)**:`zhihu__answer-detail` 在 unlike 后**一度仍读到 42**,而直接 GET `/api/v4/answers/{id}` 已是 41——**核验写效果要用操作本身的响应或直查接口,别只信详情读**(详情 API 有缓存/CDN 滞后)。

**教训**:① 可逆写对缺反向工具就 author 一个——like/unlike 是镜像,**改一个 `type` 字段**即可;② 验证写效果别只信详情读(可能缓存),用操作响应或直接查询接口。对应 findings.md F-24。

### 10.34 `youtube__transcript` 偶发 `navigate failed: goto timeout after 30000ms`(重 SPA 全量 load 超 30s → 硬失败)

**症状**:`youtube__transcript`(及任何走 PageShim 导航的 adapter)在 YouTube watch 页**偶发**失败,报 `navigate failed: Error: goto timeout after 30000ms`,用户原话"有时是 ok 的"。真机经 bridge 复测同一视频(3Blue1Brown "Vectors | Chapter 1")连跑 3 次都 ok(13/16/42s)——慢 load 那次逼近上限,说明失败只发生在该次页面 `load` 慢到 >30s 时。

**根因**:`src/runtime/page.ts` 的 `PageShim.goto` 只等 tab 完整 `load`(`chrome.tabs.onUpdated` status==='complete'),30s 未到就**硬 reject**。YouTube watch 是重 SPA(播放器/缩略图/广告),`complete` 经常 >30s。而 adapter 本不需要整页 load——`marketplace/youtube/transcript.js:412` 明确传了 `page.goto(url, { waitUntil: "none" })`,但该选项在 func/userScripts 链路里层层被丢:`makeLocalPage.goto(url)` 只收 url、`rpc('goto',{url,tabId})` 不带 opts、`rpc-server` 调 `page.goto(req.url)`、`page.ts goto(url)` 签名也只有 url——`waitUntil` 从未抵达,退化成默认 30s 全量等待。

**修法**(`src/runtime/page.ts`,共享 choke point,单文件低风险):goto 超时**即放行**而非 reject——只要 tab 已导航(URL 非空/非 about:blank)就继续(DOM 早可用,adapter 自有 network capture / 轮询兜底),仅当根本没导航才抛。同时**认账 `waitUntil:'none'`**:`fast` 时预算缩到 ~8s 且无条件放行。pipeline 的 `navigate` 步骤直接把 `{waitUntil}` 传给 `page.goto`(pipeline.ts:1065),**直接受益**;func 链路经「超时放行」恢复可靠。

**待办(可选提速)**:把 `waitUntil` 沿 `makeLocalPage.goto → rpc('goto') / NavigateRestartError → sw-runner → page.goto` 线程化,func adapter 就能在 ~8s 而非 ~30s 放行。本次未做(trampoline 链路较绕,且「超时放行」已解决可靠性这一用户诉求)。

**教训**:① 重 SPA 的「导航完成」别等 `load`——DOMContentLoaded 远早于此,等全量 load 既慢又脆;② 一个被声明的选项(`waitUntil`)要跨进程链路逐环转发时,**任一环漏传就静默失效**——在 choke point 兜底(超时放行)比逐环追更稳;③ 真机偶发失败要按「快/慢 load」维度复现,单看 N 次成功会漏判。对应 findings.md F-26。

### 10.35 `weread-official__search` 首调即 `request failed`:`fetch` 的 `AbortSignal` 过不了 runner→SW 端口

**症状**:接通 secrets env 注入后(凭据 vault → `process.env.WEREAD_API_KEY`,见 `docs/adapter-secrets.md`),`weread-official__search` 不再报 "WEREAD_API_KEY is not set",改报 `CommandExecutionError: weread-official /store/search request failed`。这是 adapter `callGateway` 里 **`fetch(...)` 本身抛异常**的 catch 分支(`marketplace/weread-official/search.js:52`),不是 `!response.ok`(那会报 `HTTP <status>`)也不是 `errcode`——说明请求在**客户端就抛了**,根本没到网关。而上一轮用 `curl` 直打 `/store/search` 是 200、20 组结果,网关本身没问题。

**根因**:`browser:false` func 的全局 `fetch` 被换成 `swFetchVia`(`src/userscript/run-in-page.ts`),把请求经 `page.fetch` RPC 代理到 SW 直发(绕 CORS,见 F-5)。`callGateway` 为做客户端超时传了 `signal: AbortController.signal`。`page[method]=(...args)=>rpc('fetch',{args:[url,init]})` 会把整个 `init`(含 `signal`)走 `port.postMessage` 过 runner→SW 端口——**`AbortSignal` 不在结构化克隆/chrome 消息可传类型里**,`postMessage` 抛 `DataCloneError`(或被降级成 `{}` 后让 SW 端 `fetch({signal:{}})` 抛 `TypeError`),两条路都让 `page.fetch` reject → adapter 看成 "fetch 失败"。这是 **`swFetchVia` 早就存在的限制**(arxiv/wikipedia 等不传 signal 的 browser:false adapter 一直没踩到),被 secrets 注入「修好上一环后才暴露」——典型级联。

**修法**(`src/userscript/run-in-page.ts`,单 choke point):新增 `sanitizeFetchInit(init)`,在交给 `page.fetch` 前把 `init` 收敛成**可结构化克隆的安全子集**——`method` / 规范化后的 `headers`(`Headers` 实例 / `[k,v][]` → 纯对象)/ 非 stream 的 `body` / 一组字符串布尔标准选项,**显式丢弃 `signal`**(客户端超时让位,runner 的整体 60s 超时仍兜底)。`sanitizeFetchInit` 导出做单测(丢 signal、规范化 Headers、输出可 `structuredClone`)。注意 **Node 24 的 `structuredClone` 反而能克隆 `AbortSignal`**(Node 把它列进可序列化),所以"原始 init 不可克隆"这条断言只在浏览器 `postMessage` 成立,单测不要依赖它——断言「净化后不含 signal」才对。

**教训**:① 一个修复打通后,常立刻撞到下一环的历史欠债(env 注入 → fetch 代理限制),按「症状从 A 变 B」判断是进展而非回退;② 跨进程边界传对象,**只送纯数据**——`AbortSignal`/`ReadableStream`/`Headers` 实例这类带内部槽的对象要么丢要么先规范化,别整个 `init` 直塞;③ Node 的 `structuredClone` ≠ 浏览器 `postMessage` 的可传类型集合(`AbortSignal` 就是反例),用 node 单测复现浏览器克隆限制会误判。对应 findings.md F-5(fetch 代理的同源限制谱系)。

### 10.36 func adapter 被租到**非可注入** tab(about:blank / chrome://)→ `userScripts.execute` 报 host-permission

**症状**:验证 weread-official 期间,`weread-official__notes`(及任何 func adapter)连续报 `chrome.userScripts.execute failed: Error: Cannot access contents of the page. Extension manifest must request permission to access the respective host.`,而 `weread-official__search` 在**同一路径**早些时候是好的。bridge `list_tabs` 前后对比:**没有新开 tab**(总数不变)——说明 dispatcher **复用**了一个已存在 tab,而那个 tab 不可注入。manifest 是 `host_permissions: ["<all_urls>"]`,所以唯一注入不了的只剩**受限 scheme**(`about:blank` / `chrome://newtab` / `chrome://*`)。

**根因**:复现条件是**测试中途 SW 重启**(我跑 explore + 大量 tab 操作把 keepalive 搞断,SW 回收重启——`weread-official__search` 一度变 "tool not found" 即 ephemeral 清空的旁证)。SW 重启后 `ensureAgentWindowId` 走恢复路径(`recallWindowId` / `findAgentGroupWindow` 重新认领旧 agent 窗口,该窗口带一个 `about:blank` 占位 tab),tab 池的内存态也清零;此后 func 路径**租到了一个停在受限 scheme 的 tab**。而 `sw-runner.ts runOnceWithPort` 在 `us.execute` 前**不校验目标 tab 是否可注入**,直接把 `about:blank` 喂给 execute → 上述报错。注意这跟 weread-official 的鉴权/secrets 无关——纯 tab 池健壮性。正常会话里 bridge keepalive 一直钉着 SW,极少触发(所以是 edge case)。

**修法**(`src/tools/dispatcher.ts`,func 注入前的统一兜底):新增 `ensureInjectableTab(tabId, site, domain)`——`us.execute` 之前 `chrome.tabs.get` 看 tab.url,**不是 `http(s)` 就先 `tabs.update` 导到站点 landing(与池 `open()` 同一 URL 逻辑)+ `waitForTabComplete`**。best-effort:导不动就让后面的 execute 抛清晰错。这是 defense-in-depth——不管那个非可注入 tab 是怎么租进来的(占位 tab / 内存态残留 / 被导走),注入前都把它拉回可注入页。happy path(tab 本就在 http(s))零开销跳过。**未能现场复确认**:reload 会清掉降级态,该 edge case 不易按需复现;本修只验证不回归(正常路径仍通)+ 逻辑显然正确(受限 tab 先导到 http(s) 再注入)。深层根因(池为何会租到受限 tab)留作后续。

**教训**:① `<all_urls>` 下「注入失败」基本=**目标 tab 是受限 scheme**,先查 tab.url 而非 host_permissions;② 跨 SW-重启的恢复路径是 bug 温床(内存态清零 + 旧窗口认领),凡「重启后才坏、reload 就好」的都往这儿看;③ 把易碎的外部前置(池租到的 tab 可能不可注入)在 choke point 兜底,比追每条租用路径稳——和 §10.34「choke point 超时放行」同一思路。对应 findings.md(weread wr_vid 调查尾注)。

### 10.37 agent 窗口 / tab 池三连修:① 没注入受限 tab 的根因 ② 任务后 tab 不关 ③ tab 开到用户窗口

接 §10.36(那只是在注入前兜底守卫),这次挖根因 + 修了用户报的三个 tab 行为问题。三者同属一个子系统(`agent-window.ts` 窗口跟踪 + `site-tab-pool.ts` 租用生命周期),共同主题是 **MV3 SW 重启把内存态清零 + `getAgentWindowId()` 是同步读**。

**① 受限 tab 被租(§10.36 的根因)**。`tabOps.findExisting`(dispatcher)用**同步** `getAgentWindowId()` 取 agent 窗口 id 来限定「只复用 agent 窗口里的 tab」;SW 重启后该 id 要等 `ensureAgentWindowId()`(async 恢复)跑完才有,期间是 `undefined` → findExisting 直接返回 undefined → 池**跳过窗口里已有的可用 tab**、改去 `open()` 新开,旧 tab 沦为孤儿;且复用逻辑在窗口未就绪时容易摸到半成品 tab。**修**:`findExisting` 改 `await ensureAgentWindowId()`(把它 export 出来),保证先恢复/创建窗口再 query —— 复用可靠、不再重复开。§10.36 的注入守卫继续兜底症状。

**② 任务结束后 tab 不关**。reaper(`reapPoolTabs` → `reapCreatedFreeTabs`)只在 SidePanel 会话结束(`activeSessions===0`)时跑,且只关**内存里 `created` 标记的 free tab**。SW 重启后 `created` 集清零 → 重启前开的池 tab 变孤儿,reaper 看不见 → 越积越多;bridge-only 用法则**从不触发** reaper。**修**:把池开的 tab id **持久化到 `storage.session`**(`web:poolCreatedTabs`,与 agent 窗口 id 同寿命);reaper 加第二趟 durable pass:遍历持久集,**还开着且当前没被租用**(`SiteTabPool.isLeased` 跳过在飞的 bridge 调用)的就关。只有经 `tabOps.open` 的池 tab 会进这个集——`open_url`/explore/用户自己的 tab 不会——所以绝不会误关用户想留的页。

**③ tab 开到用户窗口**。`open_url` 早就走 `createAgentTab`(带 `windowId` → 落 agent 窗口),但 `generic__screenshot` / `get_page_text` 仍是裸 `chrome.tabs.create({url})`——**省了 `windowId` → Chrome 落在当前聚焦窗口**(用户的),临时 tab 在用户眼前闪一下再删。**修**:这俩也改用 `createAgentTab`。

**教训**:① 「窗口 id 同步读 + 恢复是异步」这组合在 SW 重启后必有时序坑——依赖窗口 id 的地方都该 `await` 恢复;② 内存态的清理器要对「SW 重启丢状态」鲁棒——把需要跨重启存活的最小集合(这里是池开的 tab id)持久化,比事后猜哪些是孤儿稳;③ 凡「开 tab」一律走唯一 seam(`createAgentTab`),别散落 `chrome.tabs.create`——少一处就漏一处窗口隔离。需 reload 扩展验证(SW 行为)。对应 §10.36、findings.md。

**真机复测补强(A1 + A2)**:reload 后经 bridge 实测,①②③ 在干净态都通(`weread-official__search ✅`、`open_url`/`get_page_text`/`screenshot` 落 agent 窗),但**重度 bridge 测试**把 agent 窗口堆到 14 个 controlled tab 后,池又开始租到坏 tab、`search` 连续失败;手动关掉整个 agent 窗口(→ 14 tab 全清、重建干净窗)后立刻恢复。两点根因 + 补强:

- **A1 守卫从「查 URL scheme」升级为「探针」**:`ensureInjectableTab` 原来只认受限 scheme(`http(s)` 一律放行),但**被 discard / 错误页 / 退化的 junk tab** 即便 URL 是 `https://weread…` 也注入不了——升级为 `chrome.scripting.executeScript({func:()=>true})` **实探注入性**,失败就导到 landing 重来。这才真正自愈「池租到坏 tab」,不管坏在哪。
- **A2 bridge 侧收割**:reaper 原只在 SidePanel 会话结束触发,**bridge(本项目主场景)永不触发** → tab 只进不出、越堆越坏。在 `bridge-client` 加**去抖空闲收割**:每条命令结束后排程,新命令进来就取消,真空闲 ~10s 才 `reapPoolTabs`(仍只关空闲池 tab、跳过在租的)。
- **教训④**:「能不能注入」别从 URL 猜,**直接探**——`<all_urls>` 下 URL 看着没问题(`https://`)但 tab 可能被 discard / 是错误页;探针一次 executeScript 比任何 URL 启发式都准。**教训⑤**:每种「会话结束」语义(SidePanel 任务结束 vs bridge 空闲 vs explore_stop)都要各自挂清理钩子,别假设只有一种。

### 10.38 agent 装完 adapter 也调不动:func 延期注册被静默吞掉 + agent 没有临时加载工具(session s_mraayd01)

**症状**:用户让 agent 总结知乎问题,agent ①没先查 adapter 直接通用工具硬抓;②被提醒后
`find_adapters` 找到 `zhihu/question`,先后猜了 `generic__load_adapter`/`load_adapter` 两个
不存在的工具名(双双 tool not found);③改走 `install_adapter`,返回 `{installed, registered: 0}`
——装"成功"了,随后调用 `zhihu__question` 仍 tool not found,agent 只能对用户说"适配器
看起来还在加载中"(不实)并回退通用结果。

**根因**(三层):

1. **环境**:zhihu 的两个适配器都是 **func 型**,注册依赖 `chrome.userScripts`;用户刚换装
   分支构建 = chrome://extensions 里的**新扩展条目**,「允许用户脚本」开关按扩展记忆、
   **默认关闭** → `isRunnableNow(func)=false` → `registerRunnable` 全部跳过(`registered:0`,
   defs 只持久化不注册)。"以前能用现在不行"即此——不是代码回归,是重装重置了开关。
2. **产品缺陷 A**:`install_adapter`(agent 工具)的结果**吞掉了 deferred 原因**——
   `AGENT_INSTALL_ADAPTER_RESP` 根本不带 `deferredFunc/deferredUnsupported`(InstallOutcome
   里有,面板 UI 能显示,唯独 agent 链路丢了)。模型看到 `registered:0` 无从判断,只能盲试。
3. **产品缺陷 B**:临时加载(`loadEphemeralAdapter`,T7 方向 1)只暴露给了 **bridge**
   (合成工具表)和**侧栏 UI**(LOAD_ADAPTER 消息)——SidePanel agent 的 registry 里从来
   没有 `load_adapter`。模型猜这个名字说明语料/描述里暗示过它,但它在 agent 侧不存在。

**修法**:

1. 新增 `src/tools/generic/load-adapter.ts`(access:read——加载本身沙箱 eval + sha256 校验,
   与 T7 设计一致;write 适配器运行时仍会确认),包装 `loadEphemeralAdapter` 注册进 generic
   工具表;func-无开关的情况沿用它现成的明确报错。
2. `AgentInstallAdapterResp` 增 `deferredFunc/deferredUnsupported`,面板 handler 透传;
   `install_adapter` 在 `registered===0` 时返回**行动指引 note**:func 型 → 告诉用户去
   chrome://extensions 开「允许用户脚本」再重载扩展,且**当前别再重试该工具**;
   unsupported → 改用通用工具。
3. system prompt 经验法则**第一条**改为「动手前先查 adapter」(主流站点数据任务先
   `find_adapters`,一次性 → `load_adapter`,常用 → `install_adapter`),find_adapters 的
   description 同步(PROMPT_VERSION 2026-07-07.4)。
4. **主动检测 + 引导(用户跟进要求)**:Adapters 页顶部实时检测 `chrome.userScripts`
   可用性,开关没开就亮警示横幅——写清开启路径(扩展详情 → 允许用户脚本;Chrome <138 开
   开发者模式),带两个按钮:「打开扩展设置」(深链 `chrome://extensions/?id=<本扩展>`)、
   「我已开启,点我生效」(发 `REREGISTER_ADAPTERS` 让 SW 重跑 `loadInstalledOnBoot`,幂等,
   被搁置的 func 适配器就地注册,无需重启浏览器;若 SW 仍拿不到 API,如实提示重载扩展)。

**教训**:①「装成功但注册 0」是一个**必须向调用方解释**的中间态——任何 install/register
两段式流程,第二段的失败原因要全链路透传到发起方,否则上游只能编造解释;②同一能力
(临时加载)暴露给多个 surface(bridge/UI/agent)时,漏掉哪个 surface 哪个就会"猜工具名";
③换装扩展(unpacked 换目录/新装)会重置 per-extension 浏览器开关(userScripts),真机
测试换构建后先检查「允许用户脚本」。

### 10.39 `load_adapter` 撞开关未开:引导只在中间步骤一闪而过,最终回答里没了(session s_mrbhronz)

**症状**:用户全新装扩展(**0 个已装 adapter**),让 agent「看下我的知乎首页」。agent ①先
`find_adapters` 找到 `zhihu/recommend`(对);②`generic__load_adapter` 加载,撞「允许用户脚本」
开关未开而 `failed`;③中间步骤气泡里顺口说了一句「适配器需要开启用户脚本权限,我直接用通用
工具打开知乎首页」,随后用通用工具滚动抓取,把首页推荐**漂亮地整理**了出来。**但最终回答
(A17)里完全没有**「允许用户脚本 / chrome://extensions / 适配器」等字样——用户永远不知道:
只要打开那个开关,以后这类任务就能一步到位。那句关键引导只在中间气泡一闪而过,滚走了。

**根因**(两层,都是 §10.38 遗留的边角):

1. **环境**:这台是全新扩展条目,`chrome.userScripts` 开关默认关。且**一个 func adapter 都没装**
   → 会话启动时 `disabledFuncAdapterNote()` 返回 `null`(它只在**已装** func adapter 时才发)→
   没有 `environmentNote` 注入系统提示 → §10.38 那条「请如实告知用户去启用」的**站位规则根本没触发**。
   §10.38 的护栏假设「用户已经装了 func adapter」,而"发现→临时加载→撞墙"这条**装之前**的路
   落在护栏外。
2. **产品缺陷**:`load_adapter` 的失败信息(`ephemeral-adapter.ts` `registered===0` 分支)是一句
   **裸报错**「加载失败:func 型适配器需要…开启…」,不像 `install_adapter` 的 note 那样是给模型的
   **行动指令**。模型把它当成一次性障碍——提一嘴、绕过去、到最终回答就忘了。

**修法**(两处,互补,不依赖是否已装 func adapter):

1. `ephemeral-adapter.ts` 把 `registered===0` 的 `error` 从裸报错改成**行动指令**:明确让模型
   「改用通用工具完成本次任务,并**在最后给用户的回答里**用一句话引导他开启该开关,方便以后」。
2. `api-system-prompt.ts`「无 adapter 时…经验法则」加一条**站位规则**:`load_adapter`/`install_adapter`
   因该开关失败时,照常用通用工具完成,但**务必在最终回答里给一次**开启引导(chrome://extensions →
   本扩展 →「允许用户脚本」→ 重载;Chrome <138 先开开发者模式),**只给一次**别中间反复念。
   `PROMPT_VERSION` → `2026-07-08.1`。

**教训**:①护栏别只覆盖「稳态」——§10.38 只想到「已装 func adapter 却关了开关」,漏了**更常见
的首用路径**「还没装、临时加载时撞开关」;任何"能力不可用"的引导都要覆盖**装之前/装之后**两条路。
②给模型的失败信息要写成**它下一步该干什么 + 最终该对用户说什么**的**指令**,而不是甩一句现象;
现象会被当成一次性障碍绕过,指令才会留到最终回答。③「最终回答里必须提到 X」是一类反复出现的
需求(§10.38 的环境提示、这次的开关引导)——它们都不能只靠中间气泡,中间步骤气泡是会滚走的。

**后续(第二个 session s_mrbij8cc:反过来根本不查 adapter)**:同一句「看下我的知乎首页」,
这回模型的 reasoning 是「先看看有没有打开知乎标签页,或者直接打开」——**完全没调 `find_adapters`**,
直奔 `open_url` + `get_text`。即"动手前先查 adapter"是条**软经验法则,采样不稳**:上一 session 查了、
这一 session 没查。而一旦跳过 `find_adapters`,上面第 2 条「撞开关再引导」也**永不触发**——用户连
"有个适配器、开个开关就能一步到位"都不知道。

**根因**:模型缺一个**确定性输入**——它不知道「允许用户脚本」开关的真实状态,只能凭感觉猜要不要
走适配器路;而这个状态扩展**本就知道**(`isUserScriptsApiAvailable()`,同步、廉价)。

**修法(把开关状态喂进系统提示,用户选的方向)**:

3. `engine-driver.ts` 新增 `adapterStrategyNote()`,**每轮**按开关真实状态注入 `## 运行环境提示`
   (取代原先只在"已装 func adapter 且开关关"才发的 note):**开** → 主流站点数据任务先 `find_adapters`
   →`load_adapter` 一步到位,别一上来硬抓;**关** → `type:func` 适配器跑不了、别耗时,用 `type:pipeline`
   或通用工具完成,并在最终回答引导用户开开关。把**侧栏警示横幅**(`disabledFuncAdapterNote`,仅
   已装 func 变暗时)与**提示词策略 note** 拆成两路,后者恒发、前者按需。
4. `find-adapters.ts` 输出**加 `type` 字段**(`pipeline` / `func` / `unknown`)+ 说明:pipeline 不吃
   开关随时可用,func 需要开关。没有它模型无从执行"关就跳过 func、留 pipeline"——`find_adapters` 之前
   只回 site/name/说明/access/domain,漏了决定性的一维。
5. `api-engine.ts` 去掉原 `## 运行环境提示` 后那句硬编码「…这些当前不可用的站点工具…」尾巴——note
   现在自带双分支指令,开关**开着**时那句"不可用"会自相矛盾。

**教训(续)**:④"要不要用某能力"别只靠提示词里的软规则赌采样——**把决定该能力可用性的真实状态
喂给模型**(这里是开关的布尔值),软规则才有依据、才稳定。⑤给模型看的候选列表要带**能让它做决定
的那一维**:`find_adapters` 漏了 `type`,等于让模型"关着开关也只能盲选",补上后 on/off 两条路都能自洽。

### 10.40 去掉 marketplace「安装」——adapter 一律按需 load(2026-07-09)

**背景 / 决定**:自 §10.38 起,agent 有了 `load_adapter`(临时加载、不落盘),且 `adapterStrategyNote`
(§10.39)让 agent 开任务前先 `find_adapters`。既然「发现→加载→用」已是常态,marketplace 的**持久安装**
就多余了(它唯一的额外价值是「常驻工具表、免每次加载」,但代价是每次对话都占 token)。用户拍板:**去掉安装**,
marketplace adapter 一律按需 `load_adapter`。

**修法**(边界:只砍 marketplace 安装,**探索合成的 adapter 仍持久化**——那是 explore 流程的交付物):

- **agent 面**:删 `install_adapter` 工具(`tools/generic/install-adapter.ts` + `_all.ts` 导入);
  `load_adapter` / `find_adapters` / `LOAD_ADAPTER_TOOL` / 系统提示 §「主动提醒」+「无 adapter 驾驶」/
  `engine-driver` 的 `adapterStrategyNote` 里所有「install / 安装」措辞改为「按需加载、无需安装」。
- **消息面**:删 `AGENT_INSTALL_ADAPTER(_RESP)`(agent→面板装的旧通道)+ App.tsx 里对应的
  `installHandler`。**保留** `INSTALL_ADAPTER` / `UNINSTALL_ADAPTER` / `LIST_INSTALLED` /
  `installFromCaptured` / `installAdapterFromSource` —— 它们现在只服务**探索合成的持久化**(synthesize →
  captured defs → 落盘 + 注册)与其删除。
- **bridge**:删 `generic__install_adapter` 拦截 + `installAdapterTool`;`install-marketplace.ts` 随之
  变死代码,删掉。外部 agent 也改用 `load_adapter`。
- **UI(Adapters 页)**:从三标签(已安装 / 探索生成 / 市场)砍成两个——**市场**(浏览 + 每行「运行」试跑 /
  「加载到本会话」给 agent 用)+ **探索生成**(持久化的合成 adapter,启用 / 停用 / 删除)。去掉「已安装」标签、
  贴码安装表单、市场行的「安装」按钮与「已安装」徽标。`installSource` / `onRestore` 现只剩「恢复市场版」这条
  遗留路(explore-only 视图里不会触发)。
- **不迁移**(product 未上线):历史遗留的 marketplace-installed 行仍在库里、仍能用,只是不再从 UI 管理;
  不做清理(与工作流那次同策)。

**教训**:①「安装 vs 临时加载」本质是**持久化 + 常驻 token vs 按需 + 零常驻**的取舍;一旦 agent 能自动
`find→load`,持久安装的收益(免加载)就抵不过它的成本(占 token)——顺产品「LLM 自驱」的纹理,砍掉更简单。
②砍功能前先分清**同一套持久化机制**被几个入口复用:这里 `installFromCaptured` 同时服务 marketplace 安装
**和** explore 合成落盘,只能砍入口(install 工具 / 市场按钮 / 贴码)、不能砍机制,否则误伤 explore。
③`load_adapter` 的注册是**会话级**(SW 重启失效),这正是「不占常驻 token」的来源——面板点「加载到本会话」
和 agent 调 `load_adapter` 走同一条 `loadEphemeralAdapter`,语义一致。

### 10.41 `/` 面板可引用**所有** adapter + 引用即加载 + 市场目录缓存(2026-07-09)

接 §10.40:既然 adapter 不再安装、只按需 load,那用户要在输入框用 `/` 引用某个具体 adapter 时,面板必须
知道**全部** marketplace adapter(而不只是已加载的)。同时用户反馈「市场每次打开都要重新加载」——远程目录
每次开都网络往返、慢。两件一起修。

**修法**:

- **面板目录 = 注册表 + 市场目录**:`mergeToolCatalog(registry, market)`(`commands.ts`,纯函数+单测)把
  `GET_ALL_TOOLS`(generic + 已加载/合成,带 arg schema)与整份 marketplace 目录(仅元数据)合并、按 tool
  去重(注册表优先)。App.tsx 挂载时 `fetchMarketIndex()` 拉目录进 `marketAdaptersRef`,`getPaletteTools()`
  现取合并结果。**三个输入框**都用它:主输入框、工作流编辑器、**计划任务的 prompt 框**(后者本是纯
  `<textarea>`,换成 `CommandEditor`——现在也能 `/` 插入工具/适配器;编辑回填走 `pendingPrompt` + 挂载后 seed)。
- **引用即加载**:`⟦tool:site__name⟧` 令牌进到 SW 后,`driveApiSession` 开跑前 `preloadReferencedAdapters`
  扫用户文本,把**未注册的非 generic** adapter 逐个 `loadEphemeralAdapter`(并发、吞错)——这样令牌真的可调用
  (旧 `⟦wf:..⟧` 注入的临时加载版)。三种来源(主输入框发送 / 工作流配方 / 计划任务 prompt)都经 `driveApiSession`,
  一处覆盖。
- **市场目录缓存(stale-while-revalidate + TTL)**:`fetchMarketIndex` 改成缓存优先——命中且新鲜(<6h)即时
  返回、零网络;命中但过期也即时返回**并后台刷新**(下次就新);冷启动才阻塞拉网。§10.15 安全:凡随后要
  **sha256 校验源码**的路径(load / restore / reconcile)传 `{forceFresh:true}`(拿新 sha 配新源码),纯浏览/
  搜索/面板用缓存。

**教训**:①去掉安装后,「用 `/` 引用具体 adapter」只有把**全量目录**喂进面板才成立——能力删了,发现入口要
补回来(和 §10.40「删功能要补发现入口」同理)。②「引用」和「可调用」是两件事:令牌能插入 ≠ 工具已注册;
用**确定性预加载**(SW 一处扫文本)兜住,别指望模型每次都记得先 `load_adapter`。③缓存远程目录时,把
**只读展示**(可容忍稍旧)和**要 sha 校验的取用**(必须新)分开——前者缓存求快,后者 `forceFresh` 求对,
正是 §10.15 那个坑的正解(那次是 install 用了缓存 sha 配 HTTP 缓存旧源码;现在 install 没了、load 强制新)。

### 10.42 adapters-first 确定性化 + 发现省 token(2026-07-10)

**症状**(用户长期反馈,提示词修过多轮始终复发):①agent 收到任务经常**不先查 adapter**,直接
open_url + 通用工具硬抓——「动手前先 find_adapters」写在 system prompt(§10.39 的策略注入)也只是
概率性生效;②已注册 adapter 一多,**每次 LLM 调用都携带全量 tool schema**——`selectTools` v1 只在
>40 个工具**且任务文本含英文站点 token**时才收窄,中文任务(「帮我看看小红书…」)永远匹配不上
`xiaohongshu`,fallback 又是「不认识就全保留」→ 实际从不收窄;③`find_adapters` v1 打分是
「query 按空格切词 + substring」——中文查询天然**不分词**(「微博热搜」是一个 token),别名表/同义词
组都挂在整词精确 lookup 上 → 中文查询大面积 0 分。

**根因**(共同主题):把「adapters 优先」当成**要模型记住的规则**,而不是**发生在系统里的事实**;
把「目录太大」交给**一次性的、以英文 token 为键的**文本匹配。规则会被遗忘,匹配键对不上就静默失效。

**修法**(四件,互相咬合):

1. **开局自动匹配(engine-driver `adapterMatchNote`)**:`driveApiSession` 起跑前,用 find-adapters
   的 v2 打分把 userText 对 marketplace 目录(缓存优先)+ 当前注册表打一遍分,`siteHit` 的 top5 直接
   注入「运行环境提示 → 适配器提示」:已注册的标「已加载,直接调用」(并 markSiteActive 保证 schema
   展开),未注册的给出精确的 `load_adapter{site,name}` 调用。**搜索在模型第一个 token 之前就已发生**,
   「记得去搜」变成「照着列表用」。explore 模式跳过(交付物本来就是新 adapter)。
2. **open_url 即时提示(`adapter-hints.ts`,dispatcher 挂钩)**:模型真的开始用通用工具驾驶某站点时
   (generic__open_url 成功),若该站点**有 marketplace adapter 且一个都没注册**,在**工具结果里**附
   `adapter_hint`(每 origin+site 只提示一次)。工具结果是模型注意力的焦点——在犯错的当口提醒,比
   system prompt 里的第 40 行有效得多。
3. **`find_adapters` 打分 v2(命中率)**:①**词表抽取**代替纯空格切词——站点 token+别名+任务同义词
   (≥2 字)凡**包含于** query 就算词项,「微博热搜」→ [微博, 热搜],「zhihu热榜」也拆得开;query 里的
   URL 提取 `siteFromHost` 站点名;②**加权**:站点/别名/域名命中 3 分 ≫ 命令名 2 分 ≫ 描述 1 分,
   「微博 搜索」必然把 weibo__search 排在 twitter__search 和 weibo__like 前面;③语料 = marketplace
   index **∪ 注册表**(用户自探/自装的也可发现),返回加 `status`(已加载:直接调用 / 未加载:先
   load_adapter);④`my-` explored 命名空间按 baseSite 参与别名匹配。纯函数(`extractTerms` /
   `scoreAdapter` / `rankAdapters`)供 ①/单测复用;别名表抽到 `src/tools/site-aliases.ts` 共享。
4. **工具目录收窄 v2(省 token,`tool-select.ts` + `active-sites.ts`)**:①站点匹配改**别名/命名空间
   感知**(「知乎」→ zhihu / my-zhihu);②新增 **session-active sites**(SW 生命周期的小集合):任务
   文本点名过、find_adapters 命中过(已注册的)、load_adapter 加载过的站点保持展开——「继续」这类
   后续轮不丢工具;③**没点名任何站点时也收窄**(v1 是全量 fallback):隐藏站点的工具压成**每站一行
   的 digest**(`site: name(arg, opt?)`)注进 system prompt——隐藏≠不可用,工具**仍在注册表**里,
   照 digest 的名字+参数**直接调用也能执行**;要完整 schema 就 find_adapters 一下,下一轮自动展开。
   >15 站再退化为「站点(数量)」。子 agent 同规则(按子任务文本收窄;显式 allowed_tools 则不动)。

**量级**:290 个 adapter 若全注册,全量 schema ≈ 数万 token/次;digest 每站一行 ≈ 几百 token,
generic 基础目录(~37 个)不变。阈值仍 40:轻用户(少量 adapter)完全无感。

**教训**:①要模型「先做 X」,最稳的办法是**系统替它把 X 做了**、把结果放进上下文——提示词只负责
「照着结果行动」;②纠偏信息放**工具结果里**(犯错当口、注意力焦点),不放 system prompt 深处;
③多语言匹配的键(站点名/任务词)必须集中一处(site-aliases + 同义词组)且**双向包含**地比,不能指望
散在 290 份描述里;④「收窄目录」的安全网是**降级可用**:digest 里的工具仍可直接调用 + find_adapters
可再展开,收窄才敢默认开。单测:tests/generic-find-adapters.test.ts(分词/加权/排序)、
tests/tool-select.test.ts(别名/active/digest)。真机验证待做(见 docs/tests/platform.md)。

### 10.43 从 xhs-operator 移植 4 个缺失的小红书适配器(2026-07-10)

**背景**:`~/code/browser-agent/xiaohongshu-operator/src/tools/xiaohongshu` 里有 marketplace 缺的
适配器。对比后 marketplace 独缺 5 个:`feed` / `notifications` / `download`(读)、`comment-create` /
`publish`(写);反向 marketplace 独有 `delete-note`。既有的同名文件(search 等)marketplace 版反而
**更新**(带 rednote / issue #1506 修复),所以**只增不覆盖**。

**为什么不能直接 copy(改写点)**:operator 与 web-agent 的 runtime 同源(都出自 opencli),但有三处差异:

1. **import 形式**:marketplace `.js` 在沙箱里 eval,`stripModuleSyntax`(`src/sandbox/eval-core.ts`)
   把**所有非 node 的单行 import 整行删掉**,符号全由 `buildAdapterScope`(`src/runtime/adapter-scope.ts`)
   注入。operator 用 `../../runtime/registry.js`,marketplace 惯例用 `@jackwener/opencli/*`——改成惯例
   形式(功能上都会被删,纯为与 9 个既有 xhs 文件一致)。
2. **helper 内联**:operator 的 `download` / `comment-create` 从 `./note-helpers.js` import
   `buildNoteUrl` / `parseNoteId`。该文件**不在注入 scope**,跨文件 import 被 strip 后符号即 undefined
   → 运行时 ReferenceError。**把用到的 helper 原样内联进各自文件**(note-helpers 只依赖 `ArgumentError`,
   已在 scope)。`user-helpers.js` 无人用(`user.js` 已在 marketplace),不动。
3. **无文件系统 / screenshot 无 path**:comment-create 在错误路径上 `page.screenshot({path:'/tmp/…png'})`
   调试——web-agent 的 `screenshot()` 无参、返回 base64、无处落盘,是误导性 no-op(背景 tab 上还多一次
   无用 CDP 往返),**全部删掉**。dry-run 里原本借 `ensureComposerActive` 返回值判断展开态,改为直接查
   overlay(`hasComposerOverlay`),更准。

**兼容性核对**(逐条确认,不靠猜):`page.evaluate` 在 web-agent 返回**原始值**(`evalJs` 直接 return
`result.result.value`,不像 delete-note 里那段 `{session,data}` 解包——那是防御性遗留,对普通返回是透传),
所以 operator 适配器直接用 evaluate 结果是对的;4 个文件用到的 `page.*`(goto/evaluate/wait/autoScroll/
downloadFile/insertText/screenshot)在 web-agent shim **全部存在**且签名一致(web-agent 的 `wait` 是 operator
的超集);错误类构造签名(`AuthRequiredError(domain,msg)` / `EmptyResultError(source,msg)` /
`CliError(code,msg,help)` / `ArgumentError(msg,help)`)全部匹配。

**为什么 `publish` 暂缓(不引入)**:publish 依赖**用户附件回填**——`page.getAttachments()` 拿图、拿不到就
抛 `NeedsAttachmentsError` 让侧栏弹「上传卡」,用户加图后二次调用再发。但 web-agent **这条链路没实现**:
`dispatcher` 的 `createPageShim(tabId)` 不传 attachments、`RunInstalledFuncArgs` 无 attachments 字段、
`NeedsAttachmentsError` 在 UI 层零处理。直接引入 → `getAttachments()` 恒为 `[]` → 永远抛「需要附件」且
无从提供 = **必坏**。诚实起见不上;要支持得先在 web-agent 建附件卡 + 把 attachments 一路传到 func runner
(独立一块工作,已记此处备忘)。

**离线校验**:临时 node harness 复刻 `stripModuleSyntax` + `buildAdapterScope`,顶层 eval 4 个文件(正是
capture 路径做的:跑模块体、捕获 `cli()`、不跑 func),断言各自注册出正确 site/name/access/args/columns——
4/4 通过。**注意**:这只证明**能注册**,不证明**真机能跑通**(func 体要真实页面 + CDP);真机验证挂在
`docs/tests/adapters.md` 的 ☐/⏭️ 行,待跑。

**index.json**:4 条按站点分组插入(紧跟既有 xhs 段),各带 sha256(install/load 路径强校验,见
[[webchat-agent-marketplace-authoritative]]),`count` 290→294。写操作(comment-create)`access:'write'`,
运行时仍走写确认门,与 delete-note 同。

**教训**:①移植适配器先核**三件事**——import 会不会被 strip 掉符号(要内联跨文件 helper)、用到的 `page.*`
在目标 shim 是否齐备且返回形状一致、错误类构造签名是否对得上;②`page.evaluate` 返回形状是隐形雷区(有的
runtime 包 `{session,data}`,web-agent 不包)——逐字核 shim,别假设同源就一样;③一个适配器依赖的**宿主能力**
(这里是附件卡链路)不存在时,宁可**暂缓并说清**,也不上一个必坏的工具(truthful-status)。

### 10.44 市场目录加「立即更新」按钮(2026-07-10)

**症状**:刚 push 到 marketplace 的适配器,用户在「市场」页看不到。

**根因**(两层缓存叠加):①`fetchMarketIndex()` 是**缓存优先 + 6h TTL 的 stale-while-revalidate**
(§10.41):命中且 <6h 直接返回缓存、零网络;过期也**先返回旧的**、只在后台刷新——所以新目录**要到下次
打开才可见**。②`Adapters.tsx` 的市场 tab 是**懒加载且只加载一次**(`useEffect` 守卫 `if (tab!=='market'
|| market || marketErr) return`):一旦 `market` state 有值,整个面板生命周期内**再不重取**,切走切回也不刷新。
两者叠加 → 不关面板就永远看不到新适配器,关了也得等 6h + 重开两次(一次触发后台刷新、一次才读到)。

**修法**:市场工具栏(筛选行右侧)加「更新目录」按钮 → `onRefreshMarket` 调
`fetchMarketIndex({ forceFresh:true })`**绕过缓存**直连 GitHub raw 拉 `index.json`,更新 `market` state +
写回缓存,toast 报「共 N 个适配器」。市场加载失败的错误态也加了「重试」(同一 handler)。按钮复用 `.pill`
样式 + `IconRefresh`,`margin-left:auto` 靠右。**自动更新节奏不变**(6h),这只是给用户一个**立即拿最新**的手动出口。

**教训**:「缓存优先 + 懒加载只跑一次」对**低频变更**的目录是对的默认(省网络、开面板快),但**发布方**
(刚 push 完想立刻验证)和**缓存**天然冲突——给一个显式的 forceFresh 出口即可,别去缩短 TTL(那样惩罚所有
只浏览的用户)。同类:任何「后台 stale-while-revalidate」的 UI 都该配一个手动刷新,否则「我刚改了怎么没变」
会反复出现。

**补丁(同日,第二处坑)**:市场页刷新后,**agent 输入框 / 工作流定义 / 计划任务 prompt 框**这三处的
`/` 命令面板仍是旧目录。根因:三者的 palette 走 `App.tsx` 的 `marketAdaptersRef`,它在 App 挂载时用
**缓存优先的 `fetchMarketIndex()` 只拉一次**、之后再不更新;市场页的 forceFresh 只更新了它**自己**的 state。
修法:App 已有的 `chrome.storage.onChanged`(local)里加一条——`marketIndexCache` 被写入时(forceFresh 刷新
**和** 6h 后台刷新都会写),把 `marketAdaptersRef.current` 同步为新目录(`INDEX_CACHE_KEY` 从 marketplace.ts
导出、别用魔法串)。`getPaletteTools()` 每次开 `/` 现算、读的是 ref,所以下次开面板即生效、无需重开。
**教训**:同一份远程数据被**多个视图各自缓存**(市场页 state + App 的 palette ref)时,别让刷新只更新点它的
那个视图——让所有副本都从**同一个 storage 缓存**经 `onChanged` 同步,一次刷新处处生效(顺带让后台自动刷新
也流进 palette)。**排查清单**:改了远程目录看不到时,数一数它在前端被**缓存了几处**——这次就有两处
(市场页 + palette),漏一处就复现。

### 10.45 真实会话复盘 s_mregtz8u:adapter_hint 空 url 假死 + 读取时刻不提示 + 「首页」被偷换成搜索(2026-07-10)

用户导出会话审计(X 找 gpt-5.6 → find_in_page → 打开知乎回答 → 被质问「不是有知乎 adapter 吗」),
§10.42 刚上的三道防线被真实使用打出三个洞:

**① adapter_hint 从未触发(真 bug)**。`open_url {active:true}` 打开知乎页,返回 `{"url": "", …}`——
刚创建的 tab 还没加载完,`tab.url` 是**空串**,而 open-url.ts 用的 `tab.url ?? url`(`??` 挡 null 不挡
空串)把空串放了出去;dispatcher 的 hint 代码 `typeof r?.url === 'string' ? r.url : args.url` 又把空串
当有效值采纳 → `url ? … : null` 短路 → **active 打开的页面永远不会有适配器提示**。修:open-url 改
`tab.url || url`;dispatcher 改为 **args.url 优先**(那才是明确的目的地,result.url 可能还在加载)。
**教训**:`??` 与 `||` 的选择要按「空串是否合法值」逐处想——URL 场景空串≈无值,一律 `||`;凡「从结果里
取值、结果可能未就绪」的链,优先取**输入参数**这个确定源。

**② 提示只挂在 open_url,漏掉「读取」时刻**。该会话 agent 是对**已开 tab**(用户自己的知乎首页)做
find_in_page / get_text_from_tab——不经过 open_url,①修好也提示不到。把 JIT hint 扩到
`get_page_text`(args.url)与 `get_text_from_tab`(tab_id → chrome.tabs.get 取 url):**打开**和**读取**
是 generic 硬抓的两个入口,都要设卡;仍每 origin+site 一次、explore 跳过。

**③「在我的 x首页查找…」被执行成全站 twitter__search**。用户要的是**自己登录后的 feed**
(twitter__timeline 就在市场里),搜索结果 ≠ 他首页上看到的内容——任务语义被静默偷换。两手修:
find-adapters 的 feed 同义词组补 `首页/timeline/home`(「推特 首页」现在把 timeline 排在 search 前,
有单测);system prompt 加一条「别偷换任务语义:我的首页/时间线/feed=用户自己的 feed,用 timeline/feed
类适配器或打开首页读,不要换成全站搜索」。PROMPT_VERSION → 2026-07-10.3。
**教训**:「近似能力替换」(搜索替 feed、列表页替详情页)是模型的常见静默降级——发现一例就把该语义
写进同义词表(检索侧)+ 提示词(执行侧)双侧堵。

(同会话第四个发现——active 展示页不回收——是 janitor 的生命周期缺口,修法见
docs/agent-harness.md §10.38 补丁。正面结果:新工具 find_in_page 真机首秀即跑通。)

### 10.46 真实会话复盘 s_mrfp7oj4:探索成功却「探索生成」恒为 0——合成通过改为自动入库,「安装」按钮退场(2026-07-11)

用户导出会话审计(kgb101 探索:search_book 试跑通过,download_book 两次合成超时),暴露一个
产品级断层 + 两处 UI 遗留:

**症状**:① 探索成果卡片上还挂着「安装」按钮——但 §10.40 之后产品语义已是「无需安装」;② 试跑
通过的适配器打开「适配器 → 探索生成」tab 仍是 **0 个**——用户合理期待探索成功的成果自动出现在那里。

**根因**:§10.40 砍安装时只砍了 **marketplace** 的入口,探索合成的持久化(`installFromCaptured`,
origin `explore`)被完整保留——但它的**唯一触发点是探索卡片上的「安装」点击**。合成→`verifyExploreAdapter`
只做 `registerSessionDefs`(会话级注册,SW 重启即失效)+ `persistExploreAdapter`(只落到 **session
行**上,供导出/卡片恢复,不进 installed store)。于是「探索生成 tab(读 installed store 里
origin=explore 的行)」与「探索产物(躺在 session 里)」之间没有任何自动通路——概念上已删除的按钮成了
唯一的桥。

**修法**(通过验证即入库,删除权还给用户):

- **SW 自动入库**(`explore-driver.ts` `persistSynthesizedAdapter`):`synthesize_adapter` 的冒烟
  **通过** → `installFromCaptured` + `markVerified('passed', 'N 行')` + `broadcastAdaptersChanged`;
  **write 型跳过冒烟**的也入库(标 `untested`——安装按钮没了,这是 write 型进「探索生成」的唯一路径,
  状态如实)。合成失败不入库。`verifyExploreAdapter` 顺手把沙箱 eval 出的 defs 返给调用方,免二次 eval。
- **heal 语义随行**:自动入库的 origin 判定需要面板才知道的 healTarget(修复跑要**覆盖原 id**,
  origin manual+healedFrom,不能 re-home 成 `my-` 新副本)。`UserMessageReq`/`SessionState` 增加
  `healTarget`(**单轮语义**:每条 USER_MESSAGE set/clear),SW 端按面板原「安装」的同一张映射表定 origin。
- **面板**:探索卡片删「安装」按钮;**手动试跑通过 → 同样自动入库**(import/backstop/repair 行的通路)
  + 试跑真失败时把库里行的验证状态如实改 failed(**拒绝≠失败**:write 拒跑 / tool not found 不降级,
  按 handleRunTool 的两个错误串守卫);「已安装」徽标改「已保存」。删 `reconcileInstalledFlags`
  (installed 标志现在由 SW 事件如实带来)。
- **试跑 fallback 修正(顺手修的旧 bug)**:原「tool not found → 自动安装再跑」对 explore origin
  **从来跑不通**——安装会 re-home 成 `my-<site>__<name>`,重跑的还是无前缀名,照样 not found。改为新消息
  `REGISTER_SESSION_ADAPTER`(SW offscreen eval → `registerSessionDefs`,不落盘),语义与「会话级注册」
  对齐,passed/failed/untested 行 SW 重启后都能再试跑。
- **市场行删「加载到本会话」**(用户点名):它与「引用」重复——引用即把工具 chip 递给 agent,agent 自会
  load;手动预加载已无场景。「运行」保留(内部仍走 `loadAdapter` 临时加载)。

**教训**:①砍「入口」时要把该入口**独占的副作用**列出来搬家——§10.40 列了「installFromCaptured 同时
服务两个入口,只能砍入口不能砍机制」,但漏了反向检查:「explore 持久化只剩这一个入口,按钮删了谁来触发?」
砍完后应 grep 谁还调它、每条产物路径是否仍有归宿。②「验证通过」就是天然的入库门槛——用户的心智是
「探索成功=成果保留」,不是「成功后还要点一下」;把删除权(探索生成 tab 里删)代替确认权,交互更顺。
③状态同步要区分「拒绝执行」与「执行失败」:把 policy 拒绝写成 failed 会污染真实的健康状态。
(同会话另一观察:download_book 两次「合成超时:180s 内模型无响应」——是主模型侧的响应耗时问题,
与本条产品断层无关,暂不动;若高频出现再考虑合成超时的重试/换模型策略。)

### 10.47 Folding "open" into "read", and three ways an agent tab got closed under us (2026-07-26)

Prompted by the user noticing that **localmd, driving WebCLI, always did `open_url` → `get_page_text`**
even though the overwhelming majority of those pages were never clicked or scrolled — plus a follow-up
question: "can the auto-reap be closing tabs, so a later `scroll_page` fails with tab-already-closed?"
The merge turned out to be **already done** (`get_page_text`'s `url` mode opens, reads and closes by
itself; `get_text_from_tab` was folded in long ago). The real problems were that **the descriptions
taught the opposite**, and that **three separate paths really do close tabs** — one of them by handing
back the id of a tab it had just destroyed.

**Symptom**: ① external agents made the two-call round trip every time (an extra round trip, plus a
leaked tab); ② intermittent `tab N no longer exists (closed?)` — `scroll_page` / `click` holding a dead
tab id.

**Root cause (three, independent)**:

- **① The dead-handle trap (the direct one)**. `get_page_text{url}` removes its tab in `finally` but
  still returned `tabId`. To a model, `tabId` means "the page is still there", so the next
  `scroll_page{tab_id}` is guaranteed to fail. `screenshot{url}` had the same flaw (returned `tab_id`).
  `get_html` / `list_links` / `get_dom_outline` happened to return no id, so they were safe.
- **② The two shells fought over one tab-group name**. `GROUP_TITLE = 'Web Agent'` is a constant in
  `controlled-tabs.ts`, and **that file is shared by both shells** — while tab groups are
  **browser-global** (`tabGroups.query` sees groups created by other extensions, and `windows.remove`
  can close their windows). So with the full extension and WebCLI both installed, **each shell's
  `reapOrphanAgentWindows` (one pass per SW lifetime, on the first agent tab) treated the other's agent
  window as a leaked duplicate and closed it** — taking with it every tab the external agent was
  working on. Under MV3, WebCLI's SW restarts constantly, so this fired often.
- **③ The janitor's origin exclusion list was missing `webmcp`**. `run-tabs.ts`'s header says external
  origins like bridge/verify are never recorded (external agents own their tabs' lifecycle), but the
  dispatcher only excluded `'bridge'`. Post-F-30 the Port-MCP path passes `'webmcp'`, so those tabs were
  recorded — never reaped at run end (there is no run), but swept wholesale by the 6-hour
  `sweepStaleRunTabs`. (WebCLI itself goes through `core/execute-generic` and has **no** janitor at all
  — yet `open_url`'s description promised "tabs are reaped automatically", flatly contradicting
  `WEBCLI_INSTRUCTIONS`' "close the tabs you open". Contradictory instructions mean the model picks one
  at random.)

**Fix**:

- `get_page_text` gains **`keep_open`** (url mode only): the actual one-call merge of
  `open_url` + `get_page_text` — the tab stays, is `adoptTab`ed into the group, and comes back as a live
  `tabId` + `created_tab: true`. **Without it, no tab id is returned at all — the result says
  `tab_closed: true`** (say "it's gone" rather than hand over a dead id); `screenshot{url}` likewise.
- **The janitor now keys off a result marker, not the tool name**: both `open_url` and
  `get_page_text{keep_open}` emit `created_tab: true` and the dispatcher records on that — otherwise
  every future "leaves a tab behind" tool silently escapes cleanup. `'webmcp'` joins `EXTERNAL_ORIGINS`,
  matching what `run-tabs.ts` already documented.
- **The tab-group title becomes this extension's own manifest name** (full = `Web Agent`, WebCLI =
  `WebCLI`; read lazily, falling back to the old value when unavailable). Legacy aliases
  (`WebChat Agent`) are looked up per title, so WebCLI does not inherit them. The two shells are now
  invisible to each other.
- **Three places reworded** — the real answer to "why does it always make two calls": `open_url` now
  says "if you want the content, don't use me — call `get_page_text {url}`", and **drops the
  auto-reap promise that only held in the full shell** (that promise belongs to the system prompt);
  `get_page_text` leads with the one-call read; `WEBCLI_INSTRUCTIONS` / the `webcli-bridge` skill / the
  `bridge` skill all teach "read = one call, read-then-act = `keep_open`, `open_url` only when you want
  the tab without its text"; the system prompt gains the same rule (PROMPT_VERSION → 2026-07-26.1).

**Lesson**: ① **having the capability ≠ the model using it** — a tool description *is* its UI, and the
first path shown in the examples becomes the canonical one. When asking "why does the model call it this
way", go read the text it actually reads (tool description / instructions / skill) before touching code.
② **Never return a handle you are about to destroy**; either keep it alive or say plainly that it is
gone — encode the lifecycle in the result instead of hoping the caller remembers the tool's semantics.
③ **For any constant shared across shells, ask whose namespace it lives in**: storage is per-extension,
but tab groups and windows are **browser-global** — sharing a title means sharing the right to delete.
④ When adding a value to an exclusion list (origin allowlist / denylist), grep every comparison site; an
exclusion the docs claim but the code lacks is the hardest kind of drift to spot.

**Full-catalog sweep in the same batch (all 26 WebCLI tools, see docs/webcli.md §11)**: four more
instances of the same classes — ① `close_tab`'s description said "the system auto-reaps at task end, no
explicit cleanup needed" (exactly backwards in WebCLI); ② `open_url`'s `active` arg help repeated the
same "auto-reaped at task end"; ③ `get_html` / `query_dom` / `get_dom_outline` / `wait_for_selector` /
`list_links` all said "omit `tab_id` to use the Explore session tab" — WebCLI's explore gate is
permanently null, so omitting it can only error; reworded to "required unless an Explore session is
running" (true in both shells); ④ **`read_more` is a dead tool in WebCLI** — the oversize stash it pages
through is written only by `agent/engine-history.ts`, so with no agent loop there is never a stash id,
and the Port-MCP path truncates without one anyway; moved to `_all.ts`, taking WebCLI from 26 to **25
tools**. Also unified the "where does a tabId come from" wording to include
`get_page_text {keep_open:true}` (scroll_page / get_interactives / find_in_page / get_html / list_links),
so the one-call path is discoverable from whichever entry point the agent happens to read.

**Lesson from that batch**: **a shared tool description is one public contract served to both shells** —
lifecycle promises (who reaps the tab), mode promises (what an omitted arg falls back to) and existence
promises (is the tool named here actually registered) can each hold in only one shell. All three are
invisible to `tsc` and to every behavioral test, because they are **prose**. Hence
`tests/webcli-tool-surface.test.ts`, asserting directly over the `_generic` registry: no reap /
task-lifecycle wording, no Explore-tab-as-default phrasing, no reference to an unregistered tool,
membership and count locked. **And the regexes were re-checked against the pre-fix strings to prove the
assertions are not vacuous** (all five offenders caught). When you write an invariant test, always
verify it would have caught the bug you just fixed.

### 10.48 Three shells, three different answers to "whose tab is this" (2026-08-17)

Prompted by the user, from the localmd side: "the tab groups and tabs localmd Connect opens are never
closed when it finishes." The localmd half of that has its own fix (the app now records the tabs a turn
opened and closes them in the turn's `finally`); this section is the extension half, and the audit it
forced across all three shells.

**Symptom**: after a session of localmd driving the extension, the user is left with a separate Chrome
window holding a "localmd Connect" tab group full of pages — one per site touched by `run_adapter`, plus
every `open_url` page — and nothing ever closes them short of quitting the browser.

**Root cause**: a tab opened in this codebase belongs to exactly one of two classes, and the shells did
not agree on either.

- **Tabs the CALLER holds** (`open_url`, `get_page_text {keep_open}` — the id comes back in the result).
  These are the external agent's by contract; `EXTERNAL_ORIGINS` keeps them out of the run-tab janitor
  precisely so the 6h stale sweep cannot yank one out from under a long-lived session (§10.47 ③). That
  contract was right, and nobody on the localmd side was honouring it — the extension's own
  `instructions` say "close background tabs when done" and the calling app never even showed that text to
  its model. Fixed there, not here.
- **Tabs the EXECUTOR opens** (the per-site pool). These are not the caller's at all: a pool tab's id
  never leaves the executor, so the external agent could not close one if it tried. The full shell reaps
  them on a debounced idle pass off the bridge's `onCallStart`/`onCallEnd` (§10.37). **localmd Connect
  never armed one** — its executor is a separate copy of the dispatcher's pool wiring
  (`src/localmd-connect/execute-adapter.ts`), and the copy left the reaper out. Worse, the doc note
  explaining the omission asserted the external agent would close them instead, which was never possible.
- **The agent WINDOW itself.** Its `about:blank` placeholder is deliberate (`agent-window.ts`): it keeps
  the window from churning open/closed around every task. In the full shell, with a SidePanel task
  possible at any moment, that is the right trade. In a headless shell the same placeholder is a whole
  extra window with a coloured tab group in it, standing for hours after the last call — which is a large
  part of what the user was actually looking at.

**Fix**:

- **`src/tools/pool-reaper.ts`** — the dispatcher's durable pool-tab tracking (`storage.session` mirror +
  single-writer chain + the two-pass reap that spares leased tabs) extracted verbatim into
  `createPoolReaper(pool, storageKey)`, and used by BOTH executors. A second hand-rolled copy is how the
  first one drifted; one implementation is the point.
- **`src/core/idle-sweep.ts`** — `createIdleSweep(run, idleMs)`, the debounce the full shell had inline,
  now shared. Cancelled while a call is in flight, so it fires only when the shell is genuinely quiet and
  never in the gap between two calls of one task. Deliberately a `setTimeout`, which dies with the worker:
  surviving an MV3 recycle would need `alarms`, and the shipping localmd manifest does not ask for it.
- **localmd Connect** arms that sweep: reap the pool, then close the agent window if only the placeholder
  is left. **WebCLI** arms it too, for the window alone — it has no pool, and its tabs are the caller's.
- **`closeIdleAgentWindow()`** counts only `about:blank` as empty. A tab mid-navigation reports an EMPTY
  `url` with its destination in `pendingUrl`, so treating "no url" as blank — which the existing
  orphan-window reaper does, in a context where it is safe — would close a window around a page still on
  its way.
- What was NOT done: recording external-origin `open_url` tabs so the 6h sweep collects them. That is
  exactly what §10.47 ③ removed three weeks ago, for a reason that still holds.

**Lesson**: ① **"the caller owns it" is only a contract if the caller can act on it** — the pool-tab note
claimed an owner that had never been handed a handle, and an unfalsifiable ownership claim in a doc reads
as a decision when it is really a gap. When you write "X closes these", check that X can. ② **A shell
built by copying another shell's module inherits its behaviour minus whatever the copy dropped, silently**
— the dropped piece here was the only thing closing tabs. Extract before the second copy, not after the
bug. ③ **An anti-churn measure is a bet on how often the next thing happens**; the same placeholder that
saves a window-open per task in an interactive shell is hours of clutter in a headless one. Re-ask the
question per shell instead of inheriting the constant.
