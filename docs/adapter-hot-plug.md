# Adapter 运行时热插拔 + 市场 — 架构与决策记录

> 决策记录(ADR)。记录"不重 build 即可安装/卸载 adapter,并做成市场"这一功能的架构与关键取舍。
>
> **状态(2026-05 更新)**:**Phase A 和 Phase B 都全部落地,真实 Chrome 端到端验证通过**。
> - Phase A:用户从市场一键装 `zhihu/hot`(pipeline)→ agent 自动调用 → 抓到热榜数据 ✓
> - Phase B:用户从市场一键装 `xiaohongshu/search`(func)→ agent 自动调用 → 在已登录 tab 里 navigate + evaluate + scroll + extract → 抓到笔记列表 ✓
>
> **当前状况**:
> - 市场内置 345 个 adapter(122 pipeline + 223 func,覆盖 ~25 个热门站点)— 见 `marketplace/index.json`
> - pipeline 型装完即用,**零额外配置**
> - func 型需 **Chrome 138+** 且用户在 `chrome://extensions` 详情页打开「允许用户脚本」开关
> - `src/tools/` 已清理:不再有内置 site adapter,只剩 `generic/`(站点无关的 open_url/screenshot/click/...),其他 site 全走市场
>
> **分支**:`feat/adapter-hot-plug-marketplace`。最后更新:2026-05。
>
> **关键 commits 链**(按时间):
> - `c7c8014` A1 sandbox eval 宿主
> - `3658b08` A2 后端(install-manager + IDB)
> - `37a4904` A2 前端(SidePanel sandbox host + Adapters UI)
> - `4318659` A3 市场客户端 + index 生成 + bundled 122 pipeline
> - `f8e54e0` B1 in-page runner 可测核心
> - `e7e8bff` B2a rpc-server(SW 侧 PageShim 兑现 page.*)
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

## 0. 动机(用户原话)

> "我最主要的诉求是不需要每次重新 build 插件才能应用新的 adapters,甚至做成有一个 adapters 市场,用户可以选择性安装对他有用的 adapters,或者自己写 adapters 但不需要重新 build 插件,**因为用户并没有这个插件的完整代码**。"

最后一句是硬约束:用户**无法 build** → 运行时安装不是优化项,是唯一可行路径。build-time 捆绑(`import-adapter.mjs` + `_all.ts`)只适合开发者预置内置 adapter,无法满足终端用户。

## 1. 核心难点:MV3 的 eval 禁令

安装一个 adapter = 把它的源码"激活"成 registry 里一条可执行的定义。源码里有 `cli({...})`,要拿到这个定义就得**执行这段源码**。但:

- Service Worker 的 CSP **禁止 `eval` / `new Function`**。
- 普通 content script 同样受扩展 CSP 限制。

所以"在哪 eval 一段不可信源码"是整个功能的技术核心。三条候选 venue(均已查证官方文档):

| Venue | eval 能力 | 额外权限 | 用户开关 | 隔离 |
|---|---|---|---|---|
| **sandboxed iframe**(`sandbox.pages`) | 默认 CSP 含 `unsafe-eval` | 无 | **无** | 最强(opaque origin,无 `chrome.*`) |
| **userScripts world**(`chrome.userScripts`) | `configureWorld({csp:'…unsafe-eval'})` | `"userScripts"` | **要**(Chrome138+「允许用户脚本」,代码无法自动开) | 中(world 隔离,可配 messaging) |
| **CDP 注入**(`chrome.debugger`) | `Runtime.evaluate`(网页 world,不受扩展 CSP) | `"debugger"`(已有) | 无(黄条) | 弱(直接在真实页面) |

## 2. 决定性分野:pipeline 型 vs func 型

这是比"选哪个 venue"更重要的事实。opencli adapter 有两类:

| | pipeline 型(opencli 大多数,且在增多) | func 型(命令式 `page.*`,如小红书) |
|---|---|---|
| 定义本质 | 纯数据 `{site,name,args,pipeline,...}` | 含 `func` 闭包,**不可序列化** |
| 装载 | eval 一次 → 提取纯数据 | eval → 但 func 存不下,只能存**源码字符串** |
| 运行 | 现有 `pipeline.ts` 解释器跑,**运行期再不碰 eval/任何 venue** | func 必须**常驻**某个能 eval 的 venue;每次调用 RPC;func 里 `page.*` 再 RPC |
| 难度 | 低 | 高 |

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
- `marketplace/index.json` — 默认 bundle,**345 个 adapter**(122 pipeline + 223 func,~25 个热门站点)

**Phase B func 型**(✅)
- `src/userscript/run-in-page.ts` — in-page runner 可测核心(makeLocalPage、evalAdapterKeepingFuncs、sameLogicalPage、runAdapterInPage)
- `src/userscript/rpc-server.ts` — SW 侧用 PageShim 兑现 chrome.*/CDP 类 page.* 方法
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
6. **B2a**(✅ `e7e8bff`):SW 侧 page.* RPC 服务端(fulfillRpc + PageShim)
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

| 阶段 | 看到的 | 推断的 | 实际的 |
|---|---|---|---|
| 第一次测 | 60s 超时,零日志 | 不知道哪一步死了 | execute 静默+ onConnect 不响应 |
| 加日志 | execute resolve frames=1 ok | 注入成功了 | ✓ |
| 加 globalThis marker | marker 永 null | runner 没跑? | marker 跨 world 不可见(10.2) |
| 改 DOM marker | marker='connected' | **真相** | runner 跑完,SW 收不到 port(10.3) |
| 加 onUserScriptConnect | port 通了,goto loop | trampoline 不对 | URL 不稳定(10.4) |

**关键启示**:**「无可见现象」的 bug 最贵**。每加一层诊断要确认它本身没 bug(我的 globalThis marker 就有 bug,误导了 1 轮)。**先验证诊断手段**,再用诊断结果推断真问题。

## 11. 对未来「自己拼 Tampermonkey 替代品」的人

底层能力已经全部解锁:
- USER_SCRIPT world(`chrome.userScripts` API,Chrome 138+)有 DOM + `chrome.runtime.connect/sendMessage` + 可配 CSP
- runner 注入和双向通信链路已建好(`src/userscript/runner.ts` + `src/userscript/sw-runner.ts` + `protocol.ts`)
- page.* RPC 桥已建好,跟 CDP-based PageShim 拼接(`src/userscript/rpc-server.ts`)
- 安装/卸载/启停/持久化已有(`src/adapters/install-manager.ts` + `installed-store.ts`)
- 跨重启恢复已有(`loadInstalledOnBoot`)
- session 内热刷已有(`getRegistryVersion()` + `session.lastSeenRegistryVersion`)

差什么:
- URL 匹配自动注入(目前是 agent 主动调时按需注入;Tampermonkey 是页面加载时自动跑)→ 用 `chrome.userScripts.register({matches, runAt, js})` 替代 `execute`
- `GM_*` API shim(`GM_xmlhttpRequest`/`GM_setValue`/`GM_getValue`/...)→ 包装现有 `page.*` RPC 或加 SW 的 `chrome.storage` 路由
- 脚本编辑器 UI(现在只有「贴码安装」 + 市场浏览)

→ **架构上不用动**,加这三层就成 Tampermonkey 替代品。但我们目标不是这个,所以不做。
