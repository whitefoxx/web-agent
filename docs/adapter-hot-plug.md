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

### 10.14 esbuild `as X2` alias 把 import strip + scope-inject 撕成两半

**症状**(`bilibili__subtitle` 浏览器实测):

```
ReferenceError: EmptyResultError2 is not defined
```

`bilibili__summary` 同样。

**根因**:adapter 和它 inline 的 utils.js **都从 `@jackwener/opencli/errors` 导入了同名错误类**。esbuild bundle 把两份 import 合到同一作用域,后出现的(adapter 自己的)被自动 alias 成 `*2` 后缀来避免 declarator 冲突:

```js
// marketplace/bilibili/subtitle.js 头部
import { cli, Strategy } from "@jackwener/opencli/registry";
import { AuthRequiredError as AuthRequiredError2, CommandExecutionError as CommandExecutionError2, EmptyResultError as EmptyResultError2 } from "@jackwener/opencli/errors";  // adapter 的 import
// ↓ utils.js 块内联进来
import { AuthRequiredError, CommandExecutionError, EmptyResultError } from "@jackwener/opencli/errors";  // utils 的 import
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
5. 同步更新 `marketplace/index.json` 里对应条目的 `sha256`(install path 校验 sha256,不更新就装不上 —— [[webchat-agent-marketplace-authoritative]])

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
[webchat:install] restored 34 installed adapters (35 commands)
```

警告说「它不能执行」,但用户实际跑 `bilibili__subtitle` **能跑出结果**。误报。

**根因**:func adapter 的捕获 def 经过 sandbox eval → SW IDB → loadInstalledOnBoot 这条链,**closure 不可序列化**,所以重启后 `def.func` 是 undefined。但 dispatcher 会查 `def._userScriptSource`(install 时存的 source string,Phase B func 用 chrome.userScripts.execute 注入页面跑)。`registry.js` 的 cli() 检查只看 `func` + `pipeline`,**不看 `_userScriptSource`**,所以漏判 → 警告满天飞。

**修法**(本次 commit):cli() 的「无法执行」判定加一条 `hasUserScriptSource = typeof def._userScriptSource === 'string' && def._userScriptSource.length > 0`。三条路径都没了才警告。

**教训**:**警告条件要跟实际执行路径同步**。dispatcher 有 3 条 routing(func / pipeline / _userScriptSource),registry 只看 2 条,长期信号噪音掩盖真问题。下次加新执行路径时,把 registry 的判定也带上 —— 或者反过来,**把「能跑」的判定写在 dispatcher 一处,registry 调它**。现在分两份,未来再加路径就会再次脱钩。

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

**Bug 1 根因:keepalive 只靠「开着一个 port」,不够**。`src/sidepanel/App.tsx` 开了 `chrome.runtime.connect({name:'webchat-keepalive'})`,注释写「An open Port keeps the SW pinned per MV3 spec」。**这个假设过时了**:当前 Chrome 里一个**空闲**的连接 port **不会重置 30s idle 计时器**。日志甚至打了「keepalive port connected (total=1)」,SW 照样被回收。`bilibili__comment` 期间 SW 在等 write-confirm + userScripts RPC,自己**不发任何 `chrome.*` 调用** → 30s 到点被杀 → in-memory `activeSessions` 蒸发。

**Bug 1 修法**:加**主动自 ping**(`src/background/service-worker.ts`)。有任何 session 在跑时,`setInterval` 每 20s(< 30s)调一次廉价 `chrome.runtime.getPlatformInfo()`——异步扩展 API 调用算「活动」,重置 idle 计时器。`setInterval` 只在 SW 活着时 tick,所以「有活跃 session → SW 永不被回收;最后一个 session 结束 → 立即释放」。在 `driveApiSession` 开头 `startKeepalivePing()`,`finally` 里 `stopKeepalivePingIfIdle()`(gated on `activeSessions.size===0`)。原 port 留着当次要信号 + 面板一关就放 SW 走。

**Bug 2 根因:错误路径把 sessionId 扔了,跟「接着聊」的承诺自相矛盾**。`App.tsx:283` 原本 `if (m.reason === 'error') setSessionId(null)`。而被回收的恢复路径(`recoverInterruptedSessionsOnBoot`)发的正是 `reason:'error'` → SidePanel **把 sessionId 置空**。用户发「继续」时 `sid = sessionId ?? makeSessionId()` → sessionId 是 null → **新开一个 session** → `loadSession(新id)` 返回 null → `makeSession` 空历史。**历史其实一直在 IDB**(engine 每个 turn 增量 `saveSession`:user 消息一进来就存、每个 assistant turn 存、每个 tool 结果存),是 SidePanel 在恢复时把线头丢了。

**Bug 2 修法**:`SessionDoneEvt` 加 `recoverable?: boolean`。恢复路径发 `recoverable:true`(历史在 IDB,可续)。`App.tsx` 改成 `if (m.reason === 'error' && !m.recoverable) setSessionId(null)` —— 可恢复中断**保留 sessionId**,下一条消息 `loadSession` 拿回带 `apiMessages` 的 session,engine 从 `session.apiMessages` 续种 → 上下文回来了。真·fatal error 仍然清掉、重开。

**附带修 race**:`recoverInterruptedSessionsOnBoot()` 在 SW 顶层 boot 时跑(line 139),会跟「唤醒这次 boot 的那条 USER_MESSAGE」并发。若 `handleUserMessage` 已经把 session 放进 `activeSessions` 在续跑,recover 的 `listSessions({status:'running'})` 可能又把它标 'error' + 弹个假 banner 盖在进行中的 turn 上。加一行 `if (activeSessions.has(s.id)) continue;` 跳过正在驱动的 session。

**教训**:
- **「开着 port 就能保活」是 MV3 的老都市传说**。可靠的保活是**主动产生 chrome.* 活动**(自 ping / 周期消息),不是被动持有连接。任何「等外部慢操作(用户确认 / 远端 RPC)」的 SW 路径都得在等待期间自己制造活动,否则 30s 一到就没。
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
await page.goto("https://weibo.com");                       // ① 读 uid
const uid = await getSelfUid(page);
await page.goto("https://www.weibo.com/u/page/fav/" + uid); // ② 抓取
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
let favUrl = await page.getCurrentUrl().catch(() => "");
if (!/\/u\/page\/fav\/\d+/.test(favUrl)) {
  await page.goto("https://weibo.com");
  await page.wait(2);
  const uid = await getSelfUid(page);
  favUrl = "https://www.weibo.com/u/page/fav/" + uid;
  await page.goto(favUrl);
}
await page.wait(4);
// ...抓取(不变)...
```

收敛成**一次**导航;未登录也快速 fail(getSelfUid 抛 AuthRequiredError),不再打转。

**全量审计**(用 workflow 把 32 个 `≥2 .goto(` 的 adapter 各一个 agent 扫了一遍,
按「重跑单调性」分类):

| 类别 | 数量 | 处理 |
| --- | --- | --- |
| **SAFE** | 12 | 不动——两次 goto 在互斥分支 / 同一 logical page / 已有 URL 守卫(chatgpt·claude·gemini 的 send/ask、douban/subject、douban/marks、linkedin/salesnav-thread) |
| **PING_PONG_FIXABLE** | 14 | 加 URL 守卫修掉(见下) |
| **INTERLEAVED_NEEDS_CDP** | 6 | **本轮不修**,见下 |

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
- `SCRATCH_KEY` 每 adapter 唯一:`"__webchat_<site>_<name>__"`。
- **硬约束**:single-goto / arg 提供 / 已安全的路径**逐字节不变**——只有 interleaved 多跳
  路径变状态机(如 `services-read` 只在「读自己 owner-edit」即无 services-url 且无 profile-url
  时才 4 段 interleaved;`profile-read` 只在读自己 profile 时;`search` 只在 `--details` 时)。
- 复用既有 scrape 脚本 + normalize helper **不变**,只改 func 控制流。

helper 三件套(inline 在 adapter unwrap helper 之后),发出**带 guard** 的 sessionStorage
脚本喂 `page.evaluate`,被存储拦截的页降级为 clear error 而非 throw:

```js
function buildScratchSetScript(key, jsonValue) { return `(() => { try { sessionStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(jsonValue)}); return true; } catch (e) { return false; } })()`; }
function buildScratchGetScript(key)   { return `(() => { try { return sessionStorage.getItem(${JSON.stringify(key)}); } catch (e) { return null; } })()`; }
function buildScratchClearScript(key) { return `(() => { try { sessionStorage.removeItem(${JSON.stringify(key)}); return true; } catch (e) { return false; } })()`; }
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
  改写成 **loop 状态机**:stash `{ jobs, cursor, enriched }` 进 `__webchat_linkedin_search__`;
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
  脚本在 focus 输入框 / click 发送 *之前*,当 `skip-replied`(默认 true)时读该会话自己的
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
  reinject** → 那个 `fetch` 一趟命令**必然只发一次**。发送 *之前* 的导航(可选的 SALES_HOME 预热、
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
