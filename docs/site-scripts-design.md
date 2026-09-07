# 站点脚本(常驻去广告 / 页面增强)— 设计 v1

> 状态:**MVP 已实现(2026-07-04)**,离线门禁绿(1693 测,+19),真机待验。把「explore 找出某站点的
> 广告/噪声元素 → 注册一条**常驻**规则,每次访问该站自动隐藏」做成一等公民,像内建一个轻量油猴 + 去广告器。
> ad-removal 是头号用例,机制通用。落地清单见 §10。

## 0. 一句话

新增「**站点脚本**」资源类型:`{matches, hideSelectors?, css?, js?}` 的常驻规则,用 **`chrome.userScripts.register`**
注册(现有 `userScripts` 权限即可、Chrome 自动跨会话持久),IDB 存一份做管理/对账,侧栏可查看/开关/删除,
agent/bridge 有 `create_site_script / list / delete` 工具,后续接 **explore 辅助的「找广告选择器」**授权流。

## 1. 为什么这样选(机制对比)

⚠️ **实现期修正**:最初设计想用 `scripting.registerContentScripts`(号称零开关),但它的 `css`/`js` 只接受
**打包进扩展的文件路径,不接受内联代码**——动态用户规则用不了。真正支持内联代码的是 **`chrome.userScripts.register`**
(`js:[{code}]`),扩展的 Phase B 已在用 userScripts(configureWorld),所以复用它、零新权限,代价是需要 chrome 的
「允许用户脚本」开关(与 func adapter 同一开关、同一降级提示)。

| 机制 | 权限 | 持久 | 需「Allow user scripts」开关 | 内联代码 | 结论 |
| --- | --- | --- | --- | --- | --- |
| **`userScripts.register`** ✅ 采用 | `userScripts`(已有) | ✅ Chrome 自持久 | ✅ **需要**(同 Phase B) | ✅ `js:[{code}]` | 唯一支持**动态内联**的常驻注入;注入 JS 里同步 append `<style>` 做 cosmetic 隐藏,`document_start` 近乎无闪 |
| `scripting.registerContentScripts` | `scripting`(已有) | ✅ | ❌ | ❌ **仅文件** | 动态规则无法用(致命);否则本来更优 |
| `declarativeNetRequest` | ❌ 要改 manifest | ✅ | ❌ | — | 真·网络层拦请求(uBlock 式);**不在 v1**,权限成本高 |
| CDP `Fetch`/`Network` 拦截 | `debugger`(已有) | ❌ 只在 attach 期间 + 黄条 | — | — | 不适合常驻 |

**范围声明**:v1 是 **cosmetic(DOM/CSS 隐藏)**,不是网络拦截 —— 广告仍会下载、只是不显示(不省流量)。这点在
UI/文档诚实标注(与 ④ 敏感门「诚实注明实际效果」同源)。

## 2. 数据模型

```ts
// src/site-scripts/store.ts  (镜像 installed-store 的 IDB 模式)
export interface SiteScript {
  id: string;              // 主键,如 `sitescript_<rand>`;稳定
  label: string;           // 展示名,如 "知乎去广告"
  matches: string[];       // content-script match patterns,如 ["https://*.zhihu.com/*"]
  /** cosmetic 隐藏:选择器列表 → 合成 `sel{display:none!important}` 注入。v1 主路径。 */
  hideSelectors?: string[];
  /** 高级:原样注入的 CSS(用户/explore 产出,审阅后)。 */
  css?: string;
  /** 高级:原样注入的 JS(如 MutationObserver 重隐藏动态广告)。需显式高危确认。 */
  js?: string;
  runAt: 'document_start' | 'document_end' | 'document_idle'; // 默认 document_start
  enabled: boolean;
  origin: { type: 'explore' | 'manual' | 'agent'; note?: string };
  createdAt: number;
  updatedAt: number;
}
```

- **主路径只用 `hideSelectors`**(纯 CSS 生成,安全:CSS 不能读页/外传)。`css`/`js` 是高级口,单独把关(§6)。
- 存储:新 IDB store `web-agent-sitescripts`,CRUD 函数镜像 `installed-store`
  (`putSiteScript/getSiteScript/listSiteScripts/deleteSiteScript/setSiteScriptEnabled`)。

## 3. 注册 / 生命周期(单一事实源 = IDB,注册是投影)

```ts
// src/site-scripts/register.ts
// 把一条 SiteScript 编译成 chrome.scripting 的 RegisteredContentScript
function compile(s: SiteScript): chrome.scripting.RegisteredContentScript {
  const cssParts: string[] = [];
  if (s.hideSelectors?.length) cssParts.push(`${s.hideSelectors.join(',')}{display:none!important}`);
  if (s.css) cssParts.push(s.css);
  return {
    id: s.id,                       // 用同一 id,便于 update/unregister
    matches: s.matches,
    runAt: s.runAt,
    world: 'ISOLATED',              // CSS/常规 JS 够用;不碰页面 JS 上下文
    ...(cssParts.length ? { css: [cssParts.join('\n')] } : {}),
    ...(s.js ? { js: [{ code: s.js }] } : {}),  // 高级口(§6 门)
    persistAcrossSessions: true,    // Chrome 跨会话保留
  };
}
```

- **写路径**:add/edit/toggle → 写 IDB → `registerContentScripts`(或 `updateContentScripts`);disable/delete → `unregisterContentScripts({ids:[id]})`。
- **boot 对账**(镜像 `loadInstalledOnBoot`):`syncSiteScriptsOnBoot()` —— 读 IDB enabled 集合 vs
  `getRegisteredContentScripts()`,补注册缺的、注销多余的(防 IDB↔Chrome 漂移)。挂在 service-worker 启动(§ `loadInstalledOnBoot` 旁)。
- 注:Chrome 本就持久化 registered scripts,boot-sync 主要是**纠漂移 + 让 IDB 当唯一管理入口**。

## 4. 授权作者流(怎么找广告选择器)

三条路,产物都落成一条 `SiteScript` 给用户**确认后**才注册:

1. **explore 辅助(头号,复用现有管线)**:新 explore 目标类型「找广告/噪声」——agent 用 `get_html`/
   `get_interactives`/`get_dom_outline` 观察页面,LLM 挑出广告容器选择器(横幅、信息流广告、浮层、
   "推广"标),产出 `hideSelectors` 候选 + 每条命中数/示例(像 verify oracle 那样给证据),**在页面上高亮预览**
   (复用 get_interactives 的 SoM 高亮或临时注 CSS 描红),用户确认哪些真是广告 → 存为 SiteScript。
2. **手动**:用户直接在侧栏填 `matches` + 选择器。
3. **agent 工具**:对话里说「给知乎去广告」→ agent 走路 1,收尾调 `create_site_script`。

**耐久性**:选择器要偏结构/语义(`[data-ad]`、`.ad-banner`、`aria-label*="广告"`),躲开随机 hash 类
(复用 F-33 的 `looksHashedModule` lint 反过来**警告**易碎选择器)。

## 5. 侧栏管理 UI(镜像工作流/快捷方式卡)

新区块「**站点脚本 / 去广告**」,复用统一 `.item-*` 卡(移动优先、tap 展开、无 hover-only):
每行 = label + matches 摘要 + **开关(enabled)** + 展开看/编辑选择器 + 删除。空态给一句「让我给某站去广告」引导。
顶部一句诚实说明:「cosmetic 隐藏,不拦网络请求」。

## 6. 安全(常驻注入是高危,重点)

常驻脚本**每次访问匹配站点都自动跑**,能力强,必须严守:

- **注册=写操作,永远确认**:复用 ④ `confirmBeforeUse` 精神——弹卡列出「站点 matches + 将隐藏的选择器/将注入的 JS」,
  用户点确认才注册。auto 模式也确认(常驻副作用不可当普通读)。
- **CSS/hideSelectors 路径安全**:CSS 不能读 DOM/不能外传,天然低危 → 确认门是「你要在这些站点长期隐藏这些元素吗」。
- **`js` 高级口高危**:任意 JS 跑在匹配页 = 能读页面。**默认关**;只允许**用户亲授权**或 explore 产出**且用户逐条审阅**;
  绝不接受来自**页面内容/文档**的注入指令(违反指令边界);match 必须具体(用户选的站),禁 `<all_urls>`。
- **可见与可控**:侧栏永远能看到全部已注册脚本 + 一键全禁;注册/变更写审计。
- **诚实**:UI 注明「cosmetic,不省流量;站点改版选择器会失效,需重探」。

## 7. bridge / agent 工具(镜像 create_workflow 簇)

`CONTROL_TOOLS` 加(均 write,受 允许外部写操作 闸 + 上面的确认门):
- `create_site_script {label, matches, hide_selectors?, css?, js?, run_at?}`(重名 label 覆盖更新)
- `list_site_scripts`
- `delete_site_script {id}`
- (可选)`preview_site_script {matches, hide_selectors}` —— 在当前 tab 临时注 CSS 预览效果、不持久,给"确认前先看"。

## 8. 分期

- **MVP**:store + register/sync + `hideSelectors`(CSS-only)+ 侧栏卡 + `create/list/delete` 工具 + 确认门 +
  手动/agent 授权流。够覆盖「给某站去广告」。
- **v1.1**:explore 辅助「找广告选择器」+ 页面高亮预览 + 易碎选择器 lint。
- **v2**:`js` 高级口(MutationObserver 重隐藏动态广告)+ 导入/导出规则 + 订阅公共去广告规则集(需信任模型)。
- **不做(v1)**:网络层拦截(要 `declarativeNetRequest` 权限 + manifest 改动),单列评估。

## 9. 待决

1. `js` 高级口 v1 要不要直接砍掉,只留 CSS(最安全)?建议 MVP 只 CSS,v2 再评 JS。
2. 规则跟不跟站点 adapter 绑定(同一 `site` 命名空间)还是独立?建议**独立**(去广告≠取数,职责分离,同 findings/notes 之分)。
3. explore「找广告」是复用 explore 模式加一个 objective,还是独立轻流程?倾向前者(少造轮子)。

---

参考实现锚点:`installed-store.ts`(IDB CRUD 模式)· `install-manager.ts:loadInstalledOnBoot`(boot 对账)·
`sw-runner.ts:configureWorld`(userScripts 用法)· `bridge-client.ts:CONTROL_TOOLS`(合成工具)·
`confirm-prompts.ts` + ④ `needsConfirmation`(确认门)· arch §16 统一卡片(侧栏 UI)。
```

## 10. MVP 落地(2026-07-04)

**做了什么**(离线门禁绿:tsc/eslint/**1693 测**[+19]/build):
- `src/site-scripts/store.ts`:`SiteScript` 记录 + **纯核心**(`buildSiteScript` 校验闸门 / `compileSiteScript`+
  `buildInjectionCode` 编译成 userScripts 内联注入 / `isValidMatchPattern`+`isTooBroadPattern` 拒全站通配 /
  选择器消毒去 `{}` 防越权)+ 独立 IDB store(CRUD,镜像 health-store)。**19 纯单测**。
- `src/site-scripts/register.ts`:`applySiteScript`/`unregisterSiteScriptById`/`refreshSiteScript`/
  `syncSiteScriptsOnBoot`——投影到 `chrome.userScripts.register`,boot 对账 IDB↔注册表。
- boot 接线:`service-worker.ts` 启动调 `syncSiteScriptsOnBoot`(紧挨 `loadInstalledOnBoot`/`configureWorld`)。
- agent 工具:`create_site_script`(**MVP 仅 cosmetic `hide_selectors`**,不开放 js/css 给工具——安全)/
  `list_site_scripts` / `delete_site_script`,双 loop 拦截 + 非探索模式。**bridge** CONTROL_TOOLS 同名三工具。
- 侧栏:菜单「站点脚本」→ `SiteScriptsSection`(统一 item-card:标签/匹配/隐藏数 + 开关 + 展开看选择器 + 删除;
  toggle 未开时提示需开「允许用户脚本」)。消息 `LIST/SET_ENABLED/DELETE_SITE_SCRIPT` + message-router 处理。

**安全落点**:matches 拒 `<all_urls>`/通配主机;选择器去 `{}`;工具只做 cosmetic;js/css 仅 store 支持、
留给将来带确认的手动/授权流(§6)。

**真机待验**(需 reload + chrome://extensions 开「允许用户脚本」):
1. 侧栏「站点脚本」空态正常;
2. 对某站(如自造夹具或某公开站)让 agent「隐藏 `.some-ad` 元素」→ 应创建规则、侧栏可见;
3. reload 该站点页面 → 目标元素消失(cosmetic 生效);
4. 侧栏关掉开关 → 再访问该站元素恢复;删除 → 规则消失;
5. bridge 路:`curl .../command create_site_script {matches, hide_selectors}` → `list` 能看到 → 生效。

**真机已验(2026-07-04)**:「隐藏知乎的广告元素」→ agent 找到 3 个广告选择器 → `create_site_script` 注册成功
(无 toggle 警告 = userScripts.register 生效)。

## 11. v1.1 + v2 落地(2026-07-04)

**v1.1(更好的作者体验)**:
- **易碎选择器 lint**:`flagFragileSelectors`(复用 F-33 混淆-class 启发式)——create 时若 `hide_selectors` 含
  随机 hash / CSS-modules / styled-components 类,结果里警告让 agent 换语义/aria/data-* 锚点。纯,单测。
- **`preview_site_script` 工具**(agent + bridge):在已开目标站的 tab 上**临时** `insertCSS`(不持久、刷新即失效)+
  数隐藏选择器命中几个元素——先看效果/验选择器,再 `create_site_script` 固化。用 `chrome.scripting`,不需「允许用户脚本」开关。

**v2(能力从"只隐藏"升级到"重排/换色/治动态")**:
- **`css` 口**:`create_site_script` 接受原始 CSS(暗色 `html{filter:invert(1)}`、重排、隐藏之外的样式)。
- **`js` 口**:接受原始 JS(MutationObserver 治动态/懒加载广告)。
- **确认门**(关键安全):带 `css` 或 `js` 的规则**弹写确认卡**(新 `ctx.confirmWrite` → `requestWriteConfirmation`,
  卡里列出要注入的 css/js),用户点确认才注册;**只有 hide_selectors 时不弹**(安全、可逆)。**bridge 路只允许
  hide_selectors**(css/js 需在 SidePanel 确认,经桥拒绝)。侧栏卡展开显示 css/js 全文(透明可审)。

**验证**:离线门禁绿(tsc/eslint/**1701 测**[+8]/build)。真机待验(reload + 开「允许用户脚本」):
① 让 agent「预览隐藏 X 站的 `.ad`」看命中数 → 满意再固化;② 「给 X 站加暗色」→ 弹确认 → 确认后 reload 生效;
③ 侧栏能看到 CSS/JS 标记 + 展开看全文 + 关/删。

## 12. 深化落地(2026-07-05)

- **高亮预览**(v1.1 补齐「页面高亮」):`preview_site_script` 加 `highlight` 模式——命中元素**描红框 + 淡红底**
  (不隐藏),先确认「要删的就是这些」再改回隐藏固化。register `previewSiteScript` + 工具 schema + agent/bridge。
- **手动新建规则表单**(侧栏):「站点脚本」页「＋ 新建规则」——填 label / 匹配站点(每行一个)/ 隐藏选择器,
  高级区可填原始 CSS/JS。用户直接授权→**不弹确认**。新 `CREATE_SITE_SCRIPT` 消息 + router 处理(支持 `id` 就地编辑)。
- **导入/导出**:导出全部规则为 JSON(面板侧下载);导入 JSON → 逐条 `buildSiteScript` 校验 + 注册,返回成功/失败数。
  新 `IMPORT_SITE_SCRIPTS` 消息 + 处理。

**验证**:离线门禁绿(1701 测,新增为纯 register/UI/消息层,非 pure);真机待 reload(highlight 经 bridge 可验、
表单/导入导出走 SidePanel)。**留后**:explore 辅助「找广告选择器」独立编排流程(当前靠 agent get_html+推理 + 高亮预览已够用)· 订阅公共规则集(需信任模型)。

## 13. JS dry-run(2026-07-09)——治「注入 JS 盲试」的失败模式

**症状**:一个「打开 HN item 页自动总结评论」的 js 站点脚本反复失败——agent `create_site_script`→`manage_tabs` 刷新
→`wait_for_selector`(5~8s)→截图/取文字 **盲试了 8 次、撞 40 步上限还没修好**(会话 s_mrdiq2ot)。

**根因**:一句静默守卫 `if(!/item\?id=/.test(location.search)) return;` —— `location.search` 是 `?id=...`(**不含
"item"**,那在 `location.pathname='/item'`),所以永远 `return`、盒子从不创建。选择器 `div.commtext.c00` 其实命中 159 个、
没问题。用 bridge 3 次 `eval_js`(查选择器命中数 + `location.*` 真值)几秒定位;agent 40 步没找到。

**为什么盲**:注入脚本跑在隔离的 USER_SCRIPT 世界,它的 **console / 抛错 / 提前 return 对 agent 全不可见**——agent 加了
`console.log('不是 item 页面')` 却**读不到**;反馈只有「`#hn-comment-summary` 没出现」,不说为什么。加上每轮 4 个工具 + 5~8s 长等。

**修法(通用,非 HN 定制)**:给 `preview_site_script` 加 **`js` dry-run**——把候选 js **作为源码拼进采集 wrapper**
(`buildDryRunCode`,不 eval → CSP-clean),交 `chrome.userScripts.execute({world:'USER_SCRIPT'})` 在**与真站点脚本
同一世界**跑一次,回 **console + 抛错(含行号)+ 顶层返回值**;不落盘、不含 `__webLLM`(先验 DOM 逻辑)。
`register.dryRunSiteScriptJs` + api-engine 拦截 + 工具 schema。配套把 `create_site_script` 指南改成:**先 dry-run 让 js
`return` 关键量(各选择器命中数 / `location.pathname·href·search` / 每个守卫布尔值)验通再固化,别用静默 `if(!x)return`,
凡按 URL 判断先确认 pathname 而非 search**。`buildDryRunCode` 纯函数单测(node 里 eval 验采集语义:console/返回/抛错/还原);
bridge 用同款 wrapper 跑 agent 原 bug 逻辑,console 当场回「不是 item 页面,跳过」+ `guarded-out`——一眼见根因。

**教训**:①注入代码类失败,**可观测性 > 一切**——把脚本的 console/throw/return 浮出来,一个 trivial 逻辑 bug 才不会耗掉 40 步。
②别让 agent 靠「落盘→刷新→等→截图」间接盲试,给它「跑一次拿回结果」的快回路(和 explore「先 eval_js 调通再 synthesize」同理)。
③静默 `if(!x)return` 是隐形失败之源;开发期先把 x 的真值 return 出来。**验证**:离线门禁绿(1811 测[+4]);
`userScripts.execute` 活体路(标准 API 薄封装、有开关未开兜底)真机在一次真 agent 会话里验。
