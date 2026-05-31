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

- `src/sidepanel/marketplace.ts` — fetchMarketIndex + entryId + FEATURED_IDS
- `scripts/build-marketplace-index.mjs` — 从 opencli `clis/` 生成 index.json(支持 `--popular` site allowlist)
- `src/sidepanel/Adapters.tsx` — 「已安装」「市场」双 tab + 贴码安装 + 启用/卸载 + 类型筛选 + Phase B 警告 + 安装结果分类 toast
- `marketplace/index.json` — 默认 bundle,**284 个 adapter**(73 pipeline + 211 func,27 个热门站点)

**Phase B func 型**(✅)

- `src/userscript/run-in-page.ts` — in-page runner 可测核心(makeLocalPage、evalAdapterKeepingFuncs、sameLogicalPage、runAdapterInPage)
- `src/userscript/rpc-server.ts` — SW 侧用 PageShim 兑现 chrome._/CDP 类 page._ 方法
- `src/userscript/protocol.ts` — 共享 port 消息类型(PORT_NAME、WORLD_ID、INIT/RPC/DONE/NAVIGATE_RESTART)
- `src/userscript/runner.ts` — Vite 打包成自包含 IIFE `dist/userscript-runner.js`
- `src/userscript/sw-runner.ts` — `configureWebchatWorld` + `handleRunnerPortConnect` + `runInstalledFuncAdapter` 编排循环
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
   4) chrome.userScripts.execute({worldId:'webchat-runner',
                                  js:[{file:'userscript-runner.js'}]})
       │
       ▼
runner.ts (USER_SCRIPT world,自带 DOM + chrome.runtime.connect):
   - mark('loaded') DOM 属性
   - chrome.runtime.connect({name:'webchat-userscript-runner'})
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

**根因**:runner 在 USER_SCRIPT world 设 `window.__webchatRunner` 当 marker。SW 用 `PageShim.evaluate` 读它 —— 但 PageShim.evaluate 走 CDP `Runtime.evaluate`,**默认 MAIN world**。两个 world 的 `window` 是**同一对象但全局变量绑定隔离**。所以 marker 写在 USER_SCRIPT、读在 MAIN,永远读不到。

**修法**(`5fe4f6e`):marker 改用 **DOM 属性**(`document.documentElement.setAttribute('data-webchat-runner', ...)`)。USER_SCRIPT 和 MAIN 共享 DOM,属性两边都能读。

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
   - 关键:**把 marker 字符串嵌进 `.message`**:`super(\`${NAVIGATE_RESTART}|${url}\`)`。`String(err)`不再是`[object Object]`,而是 `NavigateRestart: **webchat_navigate_restart**|<url>`— 即使被 adapter`${err.message}` 插值进新错误也保留可恢复信号。

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
