# page-agent ↔ web-agent 对照 & 借鉴

源项目:`alibaba/page-agent`(本机 `~/code/page-agent`)—— 一个 in-page GUI agent,
DOM 引擎整段移植自 `browser-use`。它和本项目处在**互补的两端**:本项目在 harness 编排
(压缩 / 预算 / 熔断 / 插话 / Plan / 子 agent / explore→synthesize / opencli / 网络抓包)、
多 profile、原生多工具并行、诚实 prompt 上更成熟;page-agent 在**单页 DOM 感知 + 动作执行 +
弱模型容错**这三件"脏活"上更扎实(因为移植了久经考验的 browser-use 引擎,又为"自带任意 LLM"
做了很重的跨模型适配)。

本文档 = 这次对照的方法论 + 借鉴清单(backlog) + 实施日志。按 CLAUDE.md「审计/设计决定要记进
docs」维护:每落地一项,就在 §3 记 做了什么 / 为什么 / 怎么做 / 已知局限 / 怎么验证。

> 方法论:通读 page-agent 的 `core` / `llms` / `page-controller` / `extension`(多页)/ `mcp`,
> 与本项目 `src/tools/generic/*`、`src/agent/*`(api-engine / chat-completion / resilience)、
> `src/config/llm-config.ts` 逐维对照,只保留"page-agent 明显更强、且本项目尚未具备"的点。

---

## §1 架构对比(一句话)

| 维度     | page-agent                                                                                           | web-agent                                                                  |
| -------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 工具协议 | 单个 **macro-tool**,强制每步输出 `evaluation/memory/next_goal` + 恰好一个 action(forced tool_choice) | 原生**多工具** `tool_choice:'auto'`,可一回合多调用 → 并行读 / 子 agent fan-out |
| 感知     | 每步自动注入 `<browser_state>`(全页索引化可交互元素 + 滚动态)                                        | 按需:模型自己调 `get_interactives`/`get_page_text`/…                           |
| DOM 引擎 | content-script 内常驻 `PageController`(browser-use 移植)                                             | SW 里 `chrome.scripting.executeScript` 注入自包含函数                          |
| 跨模型   | `modelPatch` 按族系改写请求体 + `normalizeResponse` 修畸形输出                                       | `chat-completion` 直发 + GLM-5 用 `auto`+nudge 规避                            |
| 多页     | `MultiPageAgent` 换 `RemotePageController`(同接口、走消息)                                           | 自有 SW / dispatcher / site-tab-pool                                           |

**本项目已领先、无需借**:遮挡检测(`get-interactives.ts` 的 elementFromPoint 中心+4角,H10)、
Set-of-Mark、退避重试 + `ThrashTracker`/`NoProgressTracker` 熔断、压缩 / 预算 / Plan / 子 agent /
多 profile 能力槽、诚实 prompt(`api-system-prompt.ts`「失败要诚实 / 用证据说话」)。

---

## §2 借鉴 backlog(按价值/成本排序)

状态:☐ 待办 · ▶ 进行中 · ✅ 已落地 · ⏭️ 暂不做

### Tier 1 — 直接提升"无 adapter 通用驾驶"成功率

- ✅ **① `get_interactives` 可交互判定加宽**:补 `cursor:pointer` / `role` / `onclick`-`tabindex`
  自定义控件(见 §3.1)。
- ✅ **② `click` 真事件序列 + 命中测试**:把裸 `el.click()`(`click.ts`/`click-by-text.ts`)换成
  page-agent 的 `pointerover→…→pointerdown→mousedown→focus→pointerup→mouseup→click` +
  `elementFromPoint` 取最深目标(`page-controller/src/actions.ts:64`)。见 §3.2。
- ✅ **②b `type-into` contenteditable Plan-A**:补 `beforeinput`/`InputEvent` 再 verify,失败才
  execCommand,给 Slate/Quill/React 富文本编辑器更稳。见 §3.3。

### Tier 2 — "自带任意 provider" 的跨模型健壮性

- ✅ **③ 跨模型健壮性(重定范围)**:核查发现本项目请求体精简(`{model,messages,tools,tool_choice:'auto',max_tokens}`),
  照搬 page-agent 的 modelPatch ≈ 90% 死代码;改做真实需要的两块——**A** `parseToolArgs` 修复畸形工具参数,
  **B** `patchBodyForModel`(OpenAI 推理模型 `max_tokens→max_completion_tokens` + 接缝)。见 §3.4。
- ✅ **④ tool-call 参数修复**:autoFixer 的安全子集已并入 ③A(围栏 / 双重 stringify / 散文抽取);
  「无 tool_call 时从 content 反推工具调用」**刻意不做**(与 `tool_choice:'auto'` 下「无调用=最终答复」冲突)。见 §3.4。

### Tier 3 — 感知 / 隐私 / 信任 丰富化

- ✅ **⑤ 常驻滚动态**:`get_interactives` 返回加 `scroll`(上/下还剩多少像素 / 屏数、处于 X%、是否到顶到底)。
  见 §3.5。
- ✅ **⑤b 内层可滚容器**:`get_interactives` 加 `scrollables`(overflow 容器 ref + 四向剩余距离);`scroll_page`
  加 `ref`/`selector` 滚某个容器(向上走到最近可滚祖先)。见 §3.6。
- ✅ **⑥ `/llms.txt` 零配置站点提示**:`open_url` 与建 tab 并行抓 `<origin>/llms.txt`(按 origin 缓存,
  `null`=试过没有;截断 1500 字),命中才挂到结果 `llms_txt` 字段。比源多一道 **HTML 守卫**(SPA catch-all
  常对任意路径回 200 HTML)。`src/tools/generic/llms-txt.ts`。源:`core/src/utils/index.ts`。
- ✅ **⑦ `transformPageContent` 文本脱敏钩子**:用户正则在 dispatcher 的 redaction pass 里**与 secret 值打码
  同一道**作用于所有工具结果(匹配 → `«标签»`);设置在「凭据与脱敏」页。`src/config/redaction-store.ts` +
  `dispatcher.redactResult`。源:`core/src/types.ts`。原描述:工具结果送模型前过一道可配置正则脱敏(本项目原只
  对截图 / 日志脱敏)。源:`core/src/types.ts:148`。
- ✅ **⑧ SimulatorMask「代理正在操作」遮罩**:被控 tab 上注入一层 `pointer-events:none` 的覆盖层(右上角
  「🤖 Web Agent 正在操作」徽标 + 会滑向每次点击/输入位置并泛起涟漪的光标),让旁观用户看到 agent 在做什么。
  `click`/`click_by_text`/`type_into` 拿到动作坐标后 fire-and-forget `flashAgentCursor(tabId,x,y)` 注入
  `src/tools/generic/_agent-cursor.ts`;幂等、自动隐藏、纯装饰(任何失败都吞掉,绝不影响真实点击)。真机
  eval_js 验证:覆盖层注入且 `overlayBlocksClicks:false`(命中测试穿透到页面 BODY)。源:`page-controller/src/mask/SimulatorMask.ts`。

### Tier 4 — 架构启发(可选)

- ⏭️ 同接口换传输(`RemotePageController`)、reflection-before-action 轻量版、多 tab 收进 Chrome
  tab-group。对照参考,不一定动手。

---

## §3 实施日志

### §3.1 ① get_interactives 可交互判定加宽 ✅

**症状(借鉴动机)**:`src/tools/generic/get-interactives.ts` 原先只按固定选择器找可交互元素
(`button, [role=button], input[submit/button]`、`a[href]`、`input/textarea`、`select`、
`[contenteditable]`)。现代 web app 大量用 role-less `<div onClick>` / `<span>` / `cursor:pointer`
卡片做控件——这些**全部漏掉**。语义更全的 `get_a11y_tree` 又是 explore-only + 需 CDP,普通任务用不上。
→ 无 adapter 通用驾驶时,模型「看不见」一大类按钮。

**根因**:可交互判定是纯选择器枚举,没有 browser-use 的 `cursor`/事件/role 启发式。

**修法**:在 `collectInteractives`(注入页面、保持自包含)末尾、`paintOverlay` 之前,新增一类
`clickables` 扫描,沿用 browser-use(经 page-agent `dom_tree/index.js:701` 验证)的三类信号:

1. 交互性 ARIA role(`menuitem/menuitemcheckbox/menuitemradio/tab/option/radio/checkbox/switch/
treeitem/gridcell/link`);
2. 显式点击信号(`onclick` 属性 / 非负 `tabindex`);
3. 计算后 `cursor: pointer`。

关键去重:`cursor` 是**继承**属性,可点卡片会让所有后代都算 pointer。所以 cursor 信号只在
**引入 pointer 的那个元素**(其 parent 不是 pointer)上触发——即"可点根",把一条 pointer 链塌成
单个 ref。再叠两条 distinctness 规则:非 distinct(无自有点击信号)的元素,若祖先已打标 / 或自身
包裹了已打标的原生控件,则跳过(让更精确的内层控件代表)。每个命中写 `data-web-ref`、返回
`{ref, text, why}`,`why` 标明命中原因(便于调试)。`paintOverlay` 自动把新 ref 一并编号高亮。

- 扫描有界:`document.body.querySelectorAll('*')`,`visited > 8000` 即停;`clickables` 达
  `max_per_category` 即停。`getComputedStyle` 只在前两类信号未命中时才调。
- 工具 description 增列 `clickables` 类,并在 `counts` / 返回体加入该类。
- 复用既有 `isVisible`(含遮挡测试)与 `seen`(跨类去重)。

**已知局限**:深层"纯 pointer 继承、各层都无自有信号"的嵌套控件(如整条工具栏 pointer、内部按钮靠
React listener 无 role/onclick),会塌到最外层 pointer 祖先——与 browser-use 同样的取舍。需要更细
时,模型可对该容器再 `get_interactives` 或改用 `get_a11y_tree`(explore)。

**验证**:

- 静态:typecheck / eslint / 1446 unit tests / vite build / prettier(本文件)全绿。
- **真机(经项目自身 bridge 的 `eval_js`,explore 会话注入新算法的 JS port,真实 Chrome)**:
  - **确定性 fixture**(真 `getComputedStyle` cursor 继承 + `elementFromPoint`):**9/9 检查全过**。
    旧扫描只找到 3 个原生(`nb`/`wb` 按钮、`na` 链接);新扫描多抓 **5** 个自定义控件——
    `d1`(onclick)/`d2`(cursor)/`d3`(role=menuitem)/`d4`(tabindex)/`card`(cursor)。去重正确:
    `cspan` 塌进 pointer 父级 `card`、不单独打标;`wrap`(pointer 但包了原生按钮)被跳过、让位给内层
    `wb`;`plain`(无信号)不误抓。
  - **真站 github.com**(已登录,4740 元素):原生 160、新增 `clickables` **12**——全是 `<summary>`
    「Add or remove reactions」表情选择器(真实可点、旧扫描完全漏掉,`<summary>` 不在任何原生类里),
    `why` 全 `cursor`。**不噪**(12/4740,无 div 泛滥)。
  - 结论:正确性 + 真实价值 + 不噪 三者均经真机确认。⚠️ 仍建议在装了本分支构建的扩展上,用真实任务
    端到端跑一遍(本工具 + `click` 串起来),作为集成层面的最终确认。

### §3.2 ② click 真事件序列 + 命中测试 ✅

**症状(动机)**:`click.ts` / `click-by-text.ts` 的页面内点击是裸
`el.scrollIntoView + el.focus?.() + el.click()`。`el.click()` 只派发一个 `click` 事件——对只监听
`pointerdown` / `mousedown` / hover 的控件(自定义 widget、hover 才出现的菜单、拖拽手柄、很多 React
组件)毫无反应。

**根因**:没有模拟真实指针的完整事件序列,也没有命中测试。

**修法**:两处点击都换成 page-agent / browser-use 的完整 W3C 序列(**自包含、内联**——`executeScript`
只序列化传入的那个函数,引用模块级 helper 会在页面里 ReferenceError,所以不能抽公共函数,与本仓库
`isVisible` 在多个页面函数里各自内联同理)。流程:`getBoundingClientRect` 取中心点 → `elementFromPoint`
命中测试取最深目标(在 el 内才用,否则回退 el)→ 依次派发
`pointerover/enter → mouseover/enter → pointerdown → mousedown → focus(原 el,preventScroll) →
pointerup → mouseup → click()`。返回值加 `used_hit_target` 便于调试。

**局限**:同步派发、不插入真实 ~100ms 级延时(点击后稳定靠工具的 `wait_ms`);跨调用无状态,不做
page-agent 那种「blur 上一个点击元素」的 hover 清理(每次都是独立 `executeScript`)。

**验证**:

- 静态:typecheck / eslint / prettier(两文件)/ 1446 tests / vite build 全绿。
- **真机 A/B**(bridge `eval_js`,explore,真实 Chrome):构造只听 `mousedown` / `pointerdown` /
  `mouseover` 的 div + 原生 `<button>` + 「外层 click 处理、内层 span」结构,旧实现(`el.click()`)与新
  序列各点一遍。**ALL_PASS**:旧实现漏掉 mousedown/pointerdown/hover(均 false),新序列三者**全部触发**;
  原生 button 两者都触发;新序列命中测试到内层 span(`usedHit:true, targetId='inner'`)且 click 冒泡到外层
  处理器。
- ⚠️ 真站点击有副作用(导航 / 提交),未在真站乱点——A/B 已直接证明机制差异。建议在装了本分支构建的扩展上,
  用真实任务端到端再确认一次。

### §3.3 ②b type-into contenteditable Plan-A ✅

**症状(动机)**:`type-into.ts` 的 contenteditable 分支直接 `execCommand('insertText')`。execCommand 在
浏览器选区插入,而 React/Lexical/Slate/ProseMirror 这类受控编辑器有自己的选区 / 模型,可能不认浏览器选区,
导致插不进或插错位置。

**根因**:缺少受控编辑器赖以更新模型的 `beforeinput`/`InputEvent`(带 `inputType`+`data`)信号。

**修法(非回归设计)**:在原 execCommand 路径**前面**加一层 page-agent 的 Plan A——先把选区放到要编辑处
(替换=全选,追加=移到末尾),派发**合成** `beforeinput`(`inputType:'insertText'`,`data:text`);若编辑器
**取消**了它(`preventDefault`,说明它自己会处理),就**不**手动改 DOM;否则 `el.innerText = expected` 并补发
`input`。随后 verify 结果是否 == 期望;不等才回退到**原来的** execCommand 路径(Plan B)。因为 Plan B 就是
改动前的行为,所以 ②b **只会多覆盖、不会回归**。

**局限**:受控编辑器若设了 DOM 但其内部模型仍 stale,提交时可能发旧值——这是受控 contenteditable 的固有难点
(input 用 native setter 能解,contenteditable 没有等价物)。Monaco/CodeMirror/Draft.js 仍不保证。

**验证**:

- 静态:typecheck / eslint / prettier / 1446 tests / vite build 全绿。
- **真机 A/B**(bridge `eval_js`,explore,真实 Chrome):三种受控编辑器,**ALL_PASS**——
  - 普通 contenteditable:Plan A 派发 `beforeinput:insertText:"hello"` + `input`,replace→`hello`、append→`hello world`;
  - **受控编辑器**(取消 beforeinput 并自行 apply):我们正确**跳过**手动改写(`planAMutated:false`),终值取编辑器自身结果 `typed`——不 clobber;
  - **仅信任 trusted 的编辑器**(忽略合成事件):Plan A 落空 → verify 失败 → **Plan B(execCommand,trusted)接管**(`usedPlanB:true`),终值 `fallback`——证明回退即旧行为、不回归。
- ⚠️ 真实受控编辑器(Slack/Notion/X 发帖框)各异,建议在真站发帖框上端到端再确认一次。

### §3.4 ③ 跨模型健壮性:工具参数修复(A) + 按模型补丁(B) ✅

**先纠正分析**:动手前核对了本项目所有请求体(主循环 / 规划 / 子 agent / 压缩 / vision / synthesize),发现统一
只发 `{ model, messages, tools, tool_choice:'auto', max_tokens }`——**不发** temperature / parallel_tool_calls /
forced tool_choice / reasoning_effort。page-agent 的 modelPatch 恰恰主要改写这些,所以**直接照搬 ≈ 90% 死代码**。
于是把 ③ 重定为本项目**真实**需要的两块。

**A — 工具参数修复(autoFixer 的安全子集)**:`api-engine` 原先 `JSON.parse(args||'{}')`,解析失败就 `warn`
然后**空参数**跑工具(静默错误)。新增 `parseToolArgs`(`engine-history.ts`):happy path 与裸 `JSON.parse`
等价;**仅在解析失败时**修复——去 ` ```json ` 围栏、解双重 stringify、从夹带散文里抽第一个 `{…}`;非对象
JSON(数组 / 裸值)归 `{}`。**只多恢复、不改已正确的调用**。5 处解析点统一改用它。
刻意**不**做 autoFixer 的「无 tool_calls 时从 content 反推工具调用」——那会与本项目 `tool_choice:'auto'` 下
「无 tool_call = 给最终答复」的语义冲突。

**B — 按模型补丁(modelPatch 的有效部分)**:新增 `model-patch.ts` 的 `patchBodyForModel`,在 `chat-completion`
发送前对**副本**改写。当前唯一真实修法:OpenAI 推理模型族(`o1/o3/o4`、`gpt-5+`,经 `normalizeModelName` 去前缀
归一)**拒收 `max_tokens`、要 `max_completion_tokens`**——`custom`/`openai` 指到这类模型会每次 400。其余 provider
(deepseek/glm/kimi/minimax/gpt-4o)是 no-op。这是未来 per-model 调整的接缝。

**局限**:B 只覆盖走 `chatCompletion` 的调用(主循环 / 规划 / 子 agent / 压缩 / synthesize);`specialist.ts` 的
vision 子调用自带 fetch,未纳入(影响小,后续可补)。

**验证**:两者都是**纯函数**,确定性单测(node,无需真机):

- `tests/tool-args.test.ts`(7 例):happy path、空/`null`/`undefined`、代码围栏、双重 stringify、散文抽取、
  非对象归 `{}`、垃圾归 `{}`。
- `tests/model-patch.test.ts`(7 例):`normalizeModelName`;o-系 / gpt-5+ 命中、gpt-4o / 其它 provider 不命中;
  rename 生效、非推理模型不动、不覆盖已存在的 `max_completion_tokens`、无 `max_tokens` 时 no-op。
- typecheck / eslint / **1460 tests(+14)** / vite build 全绿。`api-engine.ts` 的 prettier 告警是**改动前就有的**
  (HEAD 即不干净,见 split 提交),我新增的行 prettier-clean,故未整文件 reformat(遵仓库约定:只格式化自己的增量)。

### §3.5 ⑤ get_interactives 常驻滚动态 ✅

**症状(动机)**:`get_interactives` 只返回视口内 / 可见元素,不告诉模型「视口外还有没有内容」。模型读完一屏
常不知道该不该 `scroll_page`(`scroll_page` 自身有滚动态返回,但读 interactives 这一步拿不到),于是漏看折叠内容
或盲滚。

**修法**:在 `collectInteractives` 末尾按 page-agent 的 header/footer 模型算一个 `scroll` 字段(只读
window/document 指标,O(1),不加每元素扫描):`scroll_y / page_height / viewport_height / pixels_above /
pixels_below / pixels_right / pages_below / at_top / at_bottom / more_above / more_below / percent_scrolled`。
description 同步说明。

**范围**:本次只做**窗口级**滚动态(覆盖最常见的整页滚动 feed)。**内层可滚容器**的自动检测 + 按 ref 滚某个容器
(聊天消息列表等)拆为 ⑤b——`scroll_page` 目前只滚 window。

**验证**:窗口滚动指标依赖真实布局(jsdom 全 0),走真机:bridge `eval_js` 注入 5000px 高页,在 顶 / 中(2000)/
底 三处算 `scroll`,**ALL_PASS**——顶:`at_top, more_below, percent=0, pixels_below=4212`;中:`more_above &
more_below, percent=47, pixels_below=2212, pages_below=2.8`;底:`at_bottom, !more_below, percent=100`。

### §3.6 ⑤b 内层可滚容器 + 容器滚动 ✅

**症状(动机)**:⑤ 只给窗口级滚动态。聊天消息列表 / 侧栏 / 弹窗等**内层 overflow 容器**有自己的滚动条,而
`scroll_page` 只滚 window,够不着——本项目主打的恰恰是聊天类网页(消息区常是内滚容器)。

**修法**:

- `get_interactives` 新增 `scrollables` 类:在既有那遍 `querySelectorAll('*')` 扫描里顺带检测 overflow:auto/scroll
  且有真实滚动距离的容器(先用 `scrollHeight - clientHeight` 廉价预筛,过了才读 `getComputedStyle`),给 ref +
  四向剩余距离 `{up,down,left,right}`,cap 15;它是独立类、不再当点击目标。
- `scroll_page` 加 `ref`/`selector`:有则进**容器模式**——从该元素**向上走**到最近的可滚祖先(ref 可能指向容器内
  某元素),瞬时(非 smooth,读回准)滚一个容器高度的 70–100%,返回 before/after/max/at_top/at_bottom,到头早停;
  不传则维持原**窗口**行为不变。

**验证**:依赖真实布局(overflow、scrollTop),走真机:bridge `eval_js` 造「200px 高 overflow:auto 容器 + 内部
1300px 可滚内容 + 内层锚点 + 一个无溢出的 static 容器」,**ALL_PASS**——检测:scroller `{up:0,down:1300}`、
static/inner 均 `null`(只认真容器);滚动:从 `#inner` ref **向上走命中 #scroller** 并滚动(0→183)、`bottom`
到底(after=1300=max, at_bottom)、static 无可滚祖先返回 `scrollable:false`。

---

## §4 第二轮对照(2026-07-07)——准绳:「Control web interfaces with natural language」的成功率

第一轮(§2/§3)借完了 page-agent 的动作执行层(①②②b)和跨模型层(③④)。第二轮由
用户看到 page-agent 的操作遮罩 + 可视编号截图触发,但把评估准绳明确定为**text-based
DOM manipulation 的成功率**(服务 SaaS Copilot / 智能表单填写 / Accessibility 三类
use case)。按这个准绳重新过秤,结论有几处反直觉,记录如下。分支 `feat/page-agent-r2`。

### §4.1 过秤结论(方法论:每项问"LLM 因此多做对了什么?")

| 项                                   | 对文本操控成功率                                                                                                    | 判定                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | -------------------- |
| ⑨ 交错式层级 DOM 文本序列化          | **最大**——browser-use/page-agent 成功率的真正核心                                                                   | 借,头号              |
| ⑩ 表单交互启发式(prompt 实战规则)    | 中高——"输入后弹建议框没处理"是表单经典翻车点                                                                        | 借,便宜              |
| 编号的**文本**部分(索引供 LLM 引用)  | 已有等价物:ref `r1`/`f5r3` + `new:true`(≈`*[35]`)                                                                   | 已覆盖               |
| 编号的**可视**部分(页面画彩色编号框) | **零**——LLM 看不见;价值=人的信任/监督+vision 兜底                                                                   | 借,降级为"信任层"(B) |
| 操作遮罩拦截误点                     | 间接有——前台观看场景(Copilot/Accessibility 恰是),真实鼠标 hover/误点会关掉 agent 刚展开的菜单、抢焦点               | 借,第二梯队(A)       |
| antd/React 框架补丁                  | **空壳**:`patches/antd.ts` 的 `fixAntdSelect` 循环体是注释、什么也不做;react.ts 只给根节点打 not-interactive 降误报 | 不借(就记这一行)     |
| 每步自动注入 `<browser_state>`       | 有,但每步全量感知的 token 代价大;折中成"改动型工具返回轻量回执",并入⑩                                               | 轻量版并入⑩          |

**关键认识**:用户截图里"可交互颜色+可视编号"直觉上像是成功率来源,拆开看其实是
两件事——LLM 的成功率来自**文本里的索引嵌在页面结构中**(⑨),而**页面上的可视编号**
是给旁观人类和 vision 兜底用的(B)。两者共用同一套 ref,但价值维度完全不同。

### §4.2 第二轮 backlog

- ✅ **⑨ `get_interactives` 树状文本视图(`format:'tree'`)**:借 browser-use 的
  `flatTreeToString` **输出格式**、不借实现(它 vendor 的 `dom_tree/index.js` ~2000 行,
  而本项目 `collectInteractives` 在遮挡检测/shadow DOM/iframe 上已更强)。格式要素:
  缩进表父子;可交互元素 `[ref]<tag attrs>text />`;**普通可见文本穿插其间**(这是
  扁平清单最大的丢失——哪个 label 挨着哪个 input、区块标题、表格行上下文);`*[ref]`
  标新元素;属性白名单(`title/type/checked/name/role/value/placeholder/alt/aria-label/
aria-expanded/contenteditable/id/for/aria-haspopup/data-state` 等,源:
  `dom/index.ts` DEFAULT_INCLUDE_ATTRIBUTES);文本截断。扁平清单保持默认,tree 是
  opt-in 格式;iframe 子树带帧前缀。ERP/CRM 表单(20 个长相相同的 input 只靠版式区分)
  是扁平清单的死穴、tree 的主场。
- ✅ **⑩ 动作回执 + 表单启发式**:A) `click`/`type_into`/`select_option` 返回轻量回执
  (`url_changed`/`new_elements` 计数,复用 new 基线)——不盲飞、不操作过期 ref;
  B) 借 `core/src/prompts/system_prompt.md` 的实战规则进工具 description/system prompt:
  输入后必查建议下拉;同一动作 ≤3 次;有 `pixels_below` 才滚;"输入动作被打断 ≈ 弹了
  建议框"。
- ✅ **⑩b 回执带新元素摘要**(源自真实任务战报 §4.3.0b):后探针对比前探针的候选签名集,
  把**新出现的可交互元素**现场打 ref(`n<salt><i>`)+ 文本直接放进回执 `new_interactives`
  (cap 8)——消灭「重扫赶不上易逝弹层」的竞态(携程建议下拉几秒即失焦自关,LLM 往返后
  已抓不到)。见 §4.3.5。
- ✅ **B 编号框 run 期间默认常开(信任层)**:`paintOverlay` 从 opt-in 调试参数升级为
  run 期间自动重绘 + 当前动作目标加粗/脉冲;仍 `pointer-events:none`;设置开关默认开。
- ✅ **A 拦截遮罩 + 命中测试改造 + 死人开关**:`_agent-cursor.ts`(⑧,纯装饰)升级为真
  拦截遮罩(`pointer-events:auto` 吞用户鼠标/键盘/滚轮,源:`mask/SimulatorMask.ts`)。
  两个本项目特有的硬约束:
  1. **命中测试冲突**——`click.ts` 的 `deepElementFromPoint`、`get-interactives` 的遮挡
     采样都用 `elementFromPoint`,遮罩变 `auto` 后会命中遮罩自身。**不用** page-agent 的
     "动作前 `enablePassThrough` / 动作后 `disable`"开关法(改共享 DOM 状态,需 try/finally,
     跨注入脆),改用 `elementsFromPoint()` 遍历跳过 `data-wa-mask` 标记——纯读、无竞态。
  2. **死人开关(必须)**——page-agent 的控制器活在页面里能自己 dispose;我们的遮罩从 SW
     注入,而 **MV3 SW 会死**(空闲/崩溃/重载),没有死人开关就会把用户页面永久冻住。
     设计:遮罩自带 8–10s **硬自毁**定时器,每个 agent 动作心跳续命;run 结束显式拆除
     (best-effort);`pagehide` 清理兜底;动画层按 `visibilityState` 暂停(agent 常态驱动
     后台 tab,拦截层纯 CSS 零成本可常驻,动画白烧 CPU)。

### §4.3 实施日志(随做随记)

#### §4.3.0 真机验证记录(2026-07-07,分支构建装入用户 Chrome,经 bridge 驱动)✅

方法:分支 `dist/` 构建装入真实 Chrome → `node bridge/server.mjs`(主仓库副本,worktree
子模块未装依赖)+ `python3 -m http.server 8123` 起夹具 → `/command` 驱动**真实工具**
(非 eval_js 移植——扩展本身就是被测代码),eval_js 只做读断言与测试道具注入。**14/14 全过**:

- **⑨ tree(tree-form.html,后台 tab)**:区块结构完整穿插(两组同名字段靠 legend/hint
  文本可区分)、`options=北京|上海|广州` + 活 `value=北京`、`checked=true`、
  `display:none` 文字正确缺席、promo 卡(cursor)入 clickables。页面里出现的
  `<div>Explain />` 是用户 Chrome 其他扩展注入的真实 DOM,非误报。
- **⑨ iframe(iframe.html)**:子帧树带 `--- iframe f5129: url ---` 头,refs 正确
  `f5129r1` 前缀,子帧文本穿插正常。
- **⑨ \*new(explore tab + eval_js 注入两个新按钮)**:重扫 `new_count:2`,两行行首
  `*[r2]`/`*[r3]` 精确命中,旧元素不带星。
- **⑨ 真站 sanity(github.com 登录态,only_in_viewport)**:30 行 / 992 字符,结构可读
  (repo→描述→语言→star 数→Star 按钮成组),无需截断;未触发 400 行上限。
- **⑩ popup_appeared**:promo 点击(道具:弹 role=listbox)→ `popup_appeared:true` +
  hint 到位;+1 元素低于 >3 噪声阈值,`new_elements` 正确缺席。
- **⑩ clean click**:submit 点击 → 回执零误报,`#status=submitted`。
- **⑩ url_changed**:导航按钮 → `{from: tree-form, to: interactive}` + 「ref 全失效」hint。
- **B 编号框**:get_interactives 后 `__web-som-overlay` 自动出现(10 框,
  `pointer-events:none`);scroll 事件一发即整层移除。
- **A armed**:点击后亚秒探针:`pointerEvents:auto`、`opacity:1`、视口中心
  `elementFromPoint` 命中遮罩(`centerInMask:true`)——真实用户点击会被吃掉。
- **A 自家动作穿透**:armed 窗口内连续 click/type_into 照常生效(`status:submitted`、
  `status:input:ship-phone`、`final_value=13800138000`)——elementsFromPoint 跳
  `data-wa-mask` 有效。
- **A deadman**:两次工具调用间隔 >8s 的探针读到 `pe:none, opacity:0`——超时自动解除
  (无意间成了最真实的死人开关验证:没有任何显式拆除,纯靠页内定时器)。
- **B 目标脉冲数据链**:type_into 返回 `w:248, h:22`(rect 已传至脉冲框)。

视觉观感(脉冲/光标/遮罩动画)留给用户人眼确认。

#### §4.3.0b 用户真实任务战报(2026-07-07,SidePanel 三案例,session s_mra51ru4_tjgmdm)✅

用户亲跑三个真实任务,全部成功;工具轨迹(session export)复盘出的硬证据:

- **⑨ tree 被自发采用**:11 次 `get_interactives` **全部**主动传了 `format:"tree"`
  (携程首扫即用,无人示范)——工具 description + system prompt 的引导生效。
- **⑨ 同名字段区分(灵魂测试)**:tree-form 夹具上,agent 读完**一次**树后**一批并行**
  发出 5 个填写调用(r2 张三/r3 收货电话/r4 李四/r5 发票电话/r7 select 广州),
  ref 全部落在正确区块;checkbox 取消勾选后还重扫核实、提交后 `get_text` 读回
  `status:submitted`(用证据说话 ✓)。
- **⑩ url_changed 直接救了任务**:携程只读日期框被 type_into 误触发了表单提交,
  `url_changed` 回执带回跳转 URL(`round-sha-bjs?depdate=2026-07-08_2026-07-11`)——
  agent 从 URL 里看出「变成了往返 + 错日期」,立刻改走构造单程 URL 的路子并成功。
  没有回执这一步只能盲猜。
- **⑩ new_elements 兜住了无 ARIA 的下拉**:输入"上海"后携程建议列表**没有任何
  role/aria**(`popup_appeared` 未触发),`new_elements:25` 兜底报出,agent 正确
  识别「出现了建议列表」。
- **异常恢复符合启发式**:日期只读、下拉抓不到,agent 都在 2-3 次尝试内换路子
  (URL 直达 / press_key Enter),没有原地打转。

**发现的真实感知缺口(非 bug,记录为改进方向 ⑩b)**:携程建议下拉是**易逝弹层**——
LLM 往返几秒后重扫时,下拉已因失焦自动关闭,于是 agent 拿不到下拉项的 ref
(它自己说「下拉建议没有 ref 可点」后换路子成功)。根治方向:**回执里直接带新元素
摘要**(popup/new_elements 触发时,后探针顺带把新出现的可交互元素 ref+文本列进回执,
如 `new_interactives:[{ref,text}...]`),模型无需再发一次赶不上趟的重扫。已列入
§4.2 backlog(⑩b ☐)。

#### §4.3.0c 用户真实任务战报二(2026-07-07,weixinshu 后台统计,session s_mra6pya5_obdv0q)

用户跑「查时光书各类别 6 月销售」,任务基本完成但自己发现两个问题;复盘出**两个真 bug +
两个修复**:

1. **计划最后一步永远"整理中"**。轨迹:agent 唯一一次 `update_plan`(把 1-3 步标
   completed、第 4 步标 in_progress)→ 紧接着给最终答复 → run 结束,没人收尾;用户
   戳了一句才补标。**根因**:引擎里本来就有防这个的「收尾对账」(§10.15,模型要结束
   但计划有未落定步骤时强制一次如实 update_plan)——但门槛是 `session.plan?.approved`,
   **只对计划模式生效**;聊天模式下 agent 自建的待办(approved=false)完全绕过。
   **修法**:对账分支放宽到**任何有步骤的计划**(用户可见的清单不许说谎,与
   truthful-status 原则一致);「目标自检」分支维持 plan-mode-only(重,聊天待办不需要)。
2. **只拿到 6/23-30 的数据,没点「下一页」**。轨迹:统计页 tree 输出 401 行——侧栏菜单
   ~80 行、**报表每个单元格占一行**(30 天 × 10 列 ≈ 300 行),400 行上限把表格下方的
   分页控件整个截掉(+148 行);agent 按截断提示改用 only_in_viewport 再扫,还是被截
   (+14 行),分页恰好仍在刀口下——它从头到尾**看不见**「下一页」,只能如实报告
   「仅有最近两周」。**根因**:tree 序列化每个文本节点一行,密集表格把行预算吃穿。
   **修法**:①**同深度连续文本合并**(表格一行 10 格 → ~1 行,整页缩到 ~120 行,
   分页自然浮出并带 ref);② system prompt 经验法则补一条「数据不全先找表格下方的
   分页/加载更多/日期范围,别急着下结论」(PROMPT_VERSION 2026-07-07.3)。

**教训**:⑨ 的 400 行截断在"表格型后台"(恰是 ERP/CRM 主场)是系统性风险——截断策略
必须先压縮低信息密度的文本,而不是均匀砍尾巴;文本合并是结构性解法,truncation 只留作
最后防线。

#### §4.3.1 ⑨ format:'tree' ✅(真机全过,见 §4.3.0;表格压缩修正见 §4.3.0c)

**实现**:`collectInteractives` 加第 4 参 `wantTree`;既有各类扫描打完 `data-web-ref`
后,从 `document.body` 做一次组合树 walk(9000 节点上限、独立于扫描的 8000):

- **缩进 = 打标祖先数**(不是 DOM 深度)——正符合 browser-use prompt 里"缩进表示嵌套在
  上面哪个带编号元素之下"的语义,结构信息密度最高;
- 打标元素一行 `[ref]<tag 属性>own text />`,`own text` 走 `ownText()`——**遇到嵌套打标
  元素即停**(browser-use 的 get_all_text_till_next_clickable),菜单容器不会把每个
  menuitem 的文字重复一遍;
- 属性白名单 + 属性值截断 40;`value`/`checked` 优先读**活的** DOM property(HTML attr
  常缺);与可见文本重复的 aria-label/title/placeholder 丢掉;
- **`<select>` 行内带 `options=a|b|c|+N`**——tree 模式不返回扁平数组,不带这个模型就看
  不到选项了(实现时发现的回归,已修);
- 内滚容器行内带 `scrollable=up:0,down:1300`(⑤b 数据换个出口);
- 普通文本:`covered` 标志(打标祖先的行已含其文本)→跳过;父元素 `textVisible`(rect+
  computed style,带 Map 缓存)+ 连续重复行去重;**不做遮挡测试**(每个文本父元素 5 点
  elementFromPoint 太贵——已知局限:开着 modal 时背景文本会漏进来,与 browser-use 同);
- 分支剪枝 `branchDead`:**零 rect 才读 computed style**,display:contents 包装层(零
  rect 但子元素照常渲染)不会被误剪;
- shadow DOM:`kids()` 走**组合树**(有 shadowRoot 走 shadow children,`<slot>` 用
  `assignedNodes({flatten})` 拉回被分发的 light children);
- 400 行截断 + 提示传 `only_in_viewport:true`;overlay(`__web-som-overlay`/
  `__wa_overlay`)跳过。

SW 侧(纯函数,可单测):`namespaceTreeRefs`(子帧树 `[r3]`→`[f5r3]`,**锚定行首**,页面
文本里字面 "[r3]" 不会被改写)、`starNewRefsInTree`(new:true 的 ref 行首加 `*`,即
browser-use 的 `*[35]`)、`mergeFrameResults` 拼接子帧树(`--- iframe f4: url ---` 头)。
tree 模式返回 `{tree, counts, scroll, frames?}`,**不带扁平数组**(否则 prompt 双倍开销);
扁平扫描照跑(打 ref + 喂 new 基线)。

**验证**:typecheck/eslint/prettier/vitest 1769 全绿(新增 tests/tree-view.test.ts 8 例:
命名空间/加星/树合并/子帧树无顶帧)。夹具 `docs/tests/fixtures/tree-form.html`(ERP 风格
双区块同名字段)已备,真机验证见任务清单。

**坑(记录)**:worktree 不自动 init 子模块——`tests/adapters/**` 全挂是 `marketplace/`
没 checkout,`git submodule update --init` 即愈,不是代码问题。

#### §4.3.2 ⑩ 动作回执 + 表单启发式 ✅(真机全过,见 §4.3.0)

**实现 A(回执)**:新建 `src/tools/generic/_receipt.ts`。方案是「探针→动作→探针」三次
注入,**不**往 5 个自包含动作函数里重复内联采样代码:

- `pageSigInPage`(注入探针):数**可见**弹层容器(`[role=listbox|menu|dialog]`、
  `dialog[open]`、`[aria-expanded=true]`,rect>1 才算)+ `getElementsByTagName('*').length`
  元素总数;
- `captureSig(target)` 动作前采一次(失败返回 null,回执静默降级);
- `actionReceipt(tabId, target, beforeUrl, before)`:settle 150ms(异步渲染的弹层要一拍
  才出来;工具自身 wait_ms 已先等过)→ `chrome.tabs.get` 查导航(`pendingUrl||url`)→
  未导航才再探,`diffSig` 出字段:`url_changed{from,to}`(+hint「ref 全失效,先重扫」)/
  `popup_appeared:true`(+hint「先看 new 元素,常须从建议列表选一项才算生效」)/
  `new_elements`(增量>3 才报,滤噪)。**全程 best-effort**,任何失败回 `{}`,绝不影响
  真实动作结果。
- 接线:click / click_by_text / type_into / select_option / press_key 五处,`return
{ tabId, ...r, ...receipt }`;frame-scoped 动作探同一 frame。代价:每动作 +2 次轻注入
  - 150ms settle——换掉的是模型盲飞一整步 LLM 往返。

**实现 B(启发式)**:click / type_into 的 description 写明回执字段怎么用(type_into 特别
强调「popup_appeared 别无视,很多站点必须从建议列表选一项才算生效」);api-system-prompt
新增「无 adapter 时直接驾驶网页的经验法则」4 条(先感知再动手+复杂表单用 tree;看回执;
more_below:false 别再滚+内滚容器用 ref;同一动作 ≤3 次换路子),PROMPT_VERSION →
2026-07-07.1。源:page-agent `core/src/prompts/system_prompt.md` browser_rules 的实战条目。

**验证**:typecheck/eslint/prettier 绿;新增 tests/action-receipt.test.ts 4 例(导航优先/
弹层 hint/增长阈值/关闭与缺探针→空回执)。真机(自动完成框、真导航)见任务清单。

**修过的自伤 bug**:`pageSigInPage` 的元素总数会把我们**自己注入的 overlay**(首次
flash 建 ~7 个节点)算进去→首个动作必报假 `new_elements`。探针里减掉
`__wa_overlay`/`__web-som-overlay` 两棵子树。教训:凡是"页面状态差分"类信号,
先排除自家注入物。

#### §4.3.3 B 编号框默认常开 + 当前目标脉冲 ✅(真机全过,见 §4.3.0)

**实现**:

- 新建 `src/config/cockpit-store.ts`(`CockpitSettings {marks, mask}`,默认都开,
  merge-over-defaults 模式与 selection/settings.ts 一致);侧边栏菜单新增
  「操作驾驶舱」设置页(`CockpitSection`,两个 selset-row 开关,即改即生效——工具
  每次调用都现读设置)。
- `get_interactives` 的 `highlight` 默认值从 `false` 改为**跟随 `marks` 设置**
  (显式传参仍最优先)——run 期间每次扫描自动重绘编号框。
- `paintOverlay` 加**滚动即清**:框是 position:fixed 按扫描时 rect 画的,滚动后
  会悬在错误的元素上——误导比没有更糟;`scroll` 一次性监听(capture,内滚容器
  不冒泡也能收到)整层移除。
- **当前目标脉冲**:click/click_by_text/type_into 的页面函数返回值加 `w/h`(目标
  rect),`flashAgentCursor(tabId,x,y,label,w,h)` 传入 → overlay 里新的 `__wa_tgt`
  框滑到目标位置脉冲 1.2s——旁观者一眼看到"agent 正在点的是这一个"。这一步比
  page-agent 更进(它的编号框是静态的)。

**验证**:typecheck/eslint/vitest 1775 全绿(新增 cockpit-store 2 例);App.tsx 基线
即非 prettier-clean,新增行经仓库内临时副本 + token 校验确认全部 prettier-clean,
未整文件重排(遵仓库约定)。视觉效果真机待验。

#### §4.3.4 A 拦截遮罩 + elementsFromPoint 命中改造 + 死人开关 ✅(真机全过,见 §4.3.0)

**实现**(全在 `_agent-cursor.ts` 一处 + 三个命中测试点):

- overlay 根打 `data-wa-mask` 标,创建时挂一组 swallow 监听(click/dblclick/
  contextmenu/pointer*/mouse*/wheel,stopPropagation+preventDefault,wheel 用
  `{passive:false}`)。监听常驻但只在 `pointer-events:auto`(armed)时收得到事件——
  未 arm 时事件直接穿到页面,零影响。**键盘不拦**(键盘事件走页面焦点元素、不经
  overlay;v1 已知局限)。
- `flashAgentCursor` 读 `mask` 设置:开→每次动作把 `pointerEvents` 置 `auto`
  (arm/心跳),定时器 8s(`MASK_ARM_MS`);关→保持 `none`,4.5s 纯装饰淡出。
- **死人开关 = 同一个定时器**:到点同时 `opacity:0` + `pointerEvents:'none'`——
  「隐形但拦人的墙」在结构上不可能出现;SW 被杀最多冻 8s。动作间隔 <8s 连续拦截,
  LLM 思考长于 8s 的间隙不拦(v1 取舍,换来零 SW 生命周期扫尾依赖)。`pagehide`
  一次性清理兜底(bfcache 恢复不会复活 armed 遮罩)。
- **命中测试改造**(3 处内联副本:click.ts / click-by-text.ts 的
  `deepElementFromPoint`、get-interactives 的 `deepTop`):`elementFromPoint` →
  遍历 `elementsFromPoint` 取第一个**不在 `[data-wa-mask]` 里**的元素,shadow
  下钻同样改用 `shadowRoot.elementsFromPoint`。纯读、无状态切换、无竞态——**弃用**
  page-agent 的 enable/disablePassThrough 开关法(理由见 §4.2)。deepTop 保留
  `elementsFromPoint` 不存在时(jsdom)退回 `elementFromPoint` 的 fail-open。
- 动画层无需 visibility 处理:我们全是 CSS transition/animation(浏览器对隐藏 tab
  自动节流),page-agent 需要暂停的是它的 rAF 循环,我们没有。

**取舍记录**:曾考虑「in-page setInterval + runtime.sendMessage ping SW」的强死人
开关(SW 死 ≤2s 即解除、思考期也能持续拦截),需要 SW 侧 run-活性登记 + 消息路由,
v1 不值得;若真机反馈"思考期不拦"是明显缺口再升级。→ **用户真机反馈后已升级**,
见 §4.3.6(run 全程常驻)。

#### §4.3.4b 跟进:驾驶舱开关移除,定死开启(2026-07-07,用户定夺)

用户看过设置页后拍板:「这两个选项定死,不是可选」——可视编号框 + 防误点遮罩是产品的
固定组成部分,不该让用户关。据此:删掉「操作驾驶舱」设置页与 `src/config/cockpit-store.ts`
(含单测);`get_interactives` 的 `highlight` 默认恒 true(显式传 false 仍可覆盖,给模型留
调试口);`flashAgentCursor`/`armAgentMask` 不再读设置、恒 arm。教训:先做成开关再收敛
成默认,比一开始定死再被要求开洞的代价低——这次方向相反(收敛),删起来也干净。

#### §4.3.5 用户反馈轮:⑩b 回执带新元素 + 遮罩可视化(2026-07-07)✅

用户跑完三案例后提出三点(全部落地):

1. **⑩b `new_interactives`**:`pageSigInPage` 改成**单函数双模式**(before 传 `null` 收
   候选签名表;after 传前次签名做差)——同一个函数保证两侧的候选收集/签名算法**必然一致**。
   候选=有界(cap 400)可见的 `button,a[href],input,select,textarea,li,[role],[onclick],
[tabindex],[contenteditable]`(加 `li` 正是为携程式**无 role** 的建议项);签名=
   `tag|text(40)|placeholder/aria-label(20)`。新元素**现场打 ref**(`n<salt><i>`,salt
   防跨回执撞名;下次 get_interactives 全量清 ref 时一并回收)+ 文本(cap 8)进回执,
   hint 明说「可直接 click,别先重扫」。**fail closed**:before 达 cap 时放弃 diff
   (超 cap 的一切都会像"新的",静默好过噪声)。工具 description + system prompt 经验
   法则同步(PROMPT_VERSION 2026-07-07.2)。
2. **遮罩可感知**(原来全透明,"页面冻住了"没有解释):armed 时 root 加 `__wa_armed`
   类 → `rgba(15,23,42,.08)` 轻压暗(不遮内容);deadman/淡出同步摘掉。
3. **拦截 toast**:swallow 监听里,离散交互(click/dblclick/contextmenu/pointerdown/
   mousedown/wheel,**不含 mousemove**)触发页内 toast「🤖 Agent 正在操作,已暂时接管
   此页面 — 几秒后自动恢复」,1.5s 节流、1.8s 自隐——用户点不动的瞬间就地得到解释。

**验证**:diffSig 新增单测(new_interactives 透传 + 空列表回退旧 hint);其余门禁同批。
真机:需重载扩展后验 ⑩b(携程城市输入是天然用例)+ 遮罩/toast 观感。

#### §4.3.6 遮罩升级:run 全程常驻(in-page ping + SW 活性登记)✅

用户反馈「遮罩尽量一打开就有、全程都有,不然还是容易误点」——正是 §4.3.4 取舍记录里预留
的升级路径,落地为**双层死人开关**:

- **in-page 心跳**:`agentCursorInPage` 加 `persistent` 模式(x<0 = 仅挂遮罩不动光标),
  遮罩每 2.5s `chrome.runtime.sendMessage({type:'MASK_PING'})`(注入在 ISOLATED world,
  有 runtime API)——SW 答 `alive:true` 就重置 8s 死人定时器,于是 **run 全程(含 LLM
  思考间隙)常驻**;答 false / 报错(扩展重载)/ 无应答 → 一个心跳周期内自动解除。
  `disarm`/`rearm` 挂在 root 元素属性上,后续注入更新闭包、旧 interval 拿到最新实现。
- **SW 登记**(`src/background/mask-keeper.ts`,in-memory **有意为之**——SW 重启即清空,
  ping 得 false,遮罩自灭;崩溃的 run 永远不可能留一面墙):`MASK_PING` 由
  message-router 同步应答,`alive = 已登记 && (有 session 在跑 || 距最后触碰 <45s)`
  ——后半条给 bridge 这类无 run-end 信号的驱动方兜底。
- **挂载点 = dispatcher 咽喉**:任何带 `tab_id`(或结果带 `tabId`,即 open_url 建新 tab)
  的工具调用成功后 fire-and-forget `armAgentMask`——**tab 一进 run 遮罩就在**,不等第一次
  点击。设置关闭时 armAgentMask 整体 no-op。
- **显式解除两处**:engine-driver 最后一个 session 结束时 `releaseAllMasks`(即刻,不等
  心跳);`requestHumanTakeover`(登录墙 + await_user_action 的共同咽喉)开头 `releaseMask(tabId)`
  ——**否则常驻遮罩会拦住我们请用户去点的那个页面**(实现时抓到的关键冲突);接管结束后
  下一个工具调用经 dispatcher 自动重新挂上。
- 新遮罩首次由 arm-only 注入创建时,光标停在屏外(-40,-40),不再左上角冒一支箭头。

**验证**:mask-keeper 纯逻辑 4 例单测(未登记永不 alive / session 跑着思考间隙任意长都
alive / 无 session 走 45s 闲置窗 / 重置≈SW 重启全灭);1780 全绿。真机重点:开 run 后
tab 立即有遮罩、思考间隙不掉、run 结束/接管卡出现时秒解、扩展重载后 ≤2.5s 自解。

**验证**:typecheck/eslint/prettier/vitest 1775 全绿 + vite build 过。拦截行为、
死人开关计时、armed 状态下自家 click/get_interactives 不受影响——真机必验
(见任务清单;夹具 interactive.html 可直接用)。
