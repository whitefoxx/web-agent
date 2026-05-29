# Adapter 运行时热插拔 + 市场 — 架构与决策记录

> 决策记录(ADR)。记录"不重 build 即可安装/卸载 adapter,并做成市场"这一功能的架构与关键取舍。
> 状态:**Phase A 全部落地**(A1 sandbox eval 宿主、A2 安装管线+UI、A3 市场)。Phase B(func 型)待做。
> 分支:`feat/adapter-hot-plug-marketplace`。最后更新:2026-05。
>
> **进度**:A1 `c7c8014` · A2-backend `3658b08` · A2-frontend `37a4904` · A3 `fed214a`。
> 现状:用户在 SidePanel ⚙ → Adapters 里「市场」一键装 / 「贴码安装」,装完即用、可禁用/卸载、跨重启持久,**全程不重 build**。默认市场目录内置 122 个 opencli pipeline adapter(`marketplace/index.json`,`scripts/build-marketplace-index.mjs` 生成);市场页 ⚙ 可配远程 index URL → **目录也不用重 build 即可更新**。pipeline 型装完能跑;func 型可安装+列出但标「待 Phase B」、暂不执行。
>
> **Phase B 方向(已定)**:用户偏好 `chrome.userScripts`(func 里 evaluate 在网页 world 本地跑、其余 page.* RPC 回 SW),sandbox+offscreen 兜底。开工前先 spike `userScripts.execute` 的"驱动模型"(goto 跨导航后注入上下文是否还在)。
>
> ⚠️ Phase A 尚未在真实 Chrome 加载里端到端验证(sandbox iframe postMessage 往返、市场 fetch、IndexedDB 持久化)。

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

### 3.2 func 型:优先 userScripts,sandbox+offscreen 兜底(Phase B,待做)

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

**待建(A2 安装管线)**
- `src/adapters/installed-store.ts` — IndexedDB(照抄 `agent/session-store.ts`)。
- `src/adapters/install-manager.ts`(SW)— installFromSource / loadOnBoot / register / unregister / 校验。
- `src/runtime/registry.js` — 加 `unregister(site,name)` + `_installed` 标记。
- SW 消息路由 + boot 恢复;SidePanel 持有隐藏 sandbox iframe 转发 eval。

**待建(A3 市场)**
- `src/adapters/marketplace.ts` — fetchIndex / fetchAdapterSource。
- `scripts/build-marketplace-index.mjs` — 从 opencli `clis/` 生成 index.json。
- `src/sidepanel/Adapters.tsx` — 市场 tab + 已装 tab + 贴码安装 + 启用/删除 + 安全提示。

**待建(Phase B func 型)**
- 优先:`chrome.userScripts` 路线(world 跑 func + `page` Proxy:evaluate 本地、其余 RPC 回 SW)。
- 兜底:`chrome.offscreen` + sandbox iframe + 全量 `page.*` RPC 桥。

## 7. 安全(贯穿)

- 安装 = 执行第三方代码。sandbox 已隔离(无 `chrome.*`、opaque origin、eval 出不去)。
- pipeline 型运行期仅跑解释器 + 受限 fetch,较安全。
- func 型(Phase B)能驱动用户**已登录**标签页 → 强安装警告 + 复用 write-confirm 门控 + 来源标识。
- 市场 index 与源码分离托管;UI 常驻"仅安装可信来源"提示。

## 8. 实施顺序

1. **A1**(✅):sandbox eval 宿主 + capture + 构建产物。
2. **A2**:安装管线 + IndexedDB + registry 卸载 + SW 路由 + boot 恢复。贴码安装端到端。
3. **A3**:市场客户端 + index 生成 + Adapters UI。
4. (暂停,等用户验收 A)
5. **B**:func 型热插拔。**先 spike userScripts.execute 驱动模型**;成立则走 userScripts,否则回落 sandbox+offscreen。
