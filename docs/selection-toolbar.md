# 划词助手(text-selection toolbar,2026-07)

选中网页文字 → 浮出快捷工具条:**高亮**(跨刷新持久)| **翻译 / 解释 / 总结**(可自定义
的 LLM 单次调用)| **问一下**(带着选中内容回侧边栏对话)。参考对象是市面划词助手类产品
的交互;设置模型按用户要求做成**黑名单**:开启后所有站点生效,黑名单站点除外。

## 1. 为什么不是 adapter

adapter 是"agent 调用的工具"(一次调用→返回),没有常驻生命周期;工具条是**常驻页面的
UI**(监听 selection、渲染浮层、动作直达 LLM)。explore 合成的是任务型工具,产不出 UI
组件;func-adapter 常驻监听属于滥用工具模型(无开关/卸载/设置归属)。故做成平台功能:
manifest content script + SW 单次 completion + SidePanel 设置页。

## 2. 架构

```
manifest content_scripts (http/https, document_idle, 顶层 frame)
  └─ src/content/selection-toolbar.ts   惰性:enabled && 非黑名单才挂监听
       ├─ shadow DOM 工具条/结果浮层(页面 CSS 摸不到;页面侧仅一个 <style> 管 <mark>)
       ├─ 高亮:selection → TextQuote 描述 → <mark> 包裹 → storage.local 持久
       ├─ LLM 动作:SELECTION_LLM → SW 单次 /chat/completions(60s 超时)→ 浮层显示
       └─ 问一下:SELECTION_ASK → SW 同步 sidePanel.open + storage.session 暂存引用
src/selection/settings.ts    设置(storage.local['selToolbarSettings'],content/panel 共用)
src/selection/anchor.ts      文本锚定纯函数(jsdom 单测)
src/selection/highlights-store.ts  高亮持久化(selHl:<url> 每页一键,上限 200 条)
src/background/selection-actions.ts  SW 两个 handler
SidePanel:菜单「划词助手」设置页 + pendingSelectionAsk 消费进输入框
```

### 2.1 注入方式:manifest 常驻 + 脚本内惰性,而不是按需 executeScript

选了「manifest 全 http(s) 声明 + 脚本头部按设置自宕」而不是 SW 监听 tabs.onUpdated 按需
注入,理由:不依赖 SW 存活、天然覆盖 SPA、无重复注入竞态,且 **storage.onChanged 让
开关/黑名单改动对已打开页面即时生效**(免刷新)。代价是每页解析一个小 bundle
(~10KB gzip 级,惰性早退)。黑名单匹配是后缀语义(`example.com` 覆盖子域,不误伤
`notexample.com`),www 两侧透明。

### 2.2 高亮持久化:TextQuoteSelector 锚定

存储形状 = W3C 注解的 TextQuote:`{exact, prefix(30 字), suffix(30 字)}`。恢复时:
线性拼接页面文本节点(跳过 script/style/noscript/template/textarea)建索引 → 原文精确
匹配(找不到再做**空白折叠回退**,应对重渲染改变空白)→ 多处命中用前后文逐字评分消歧
(创建时另有 near 位置参与打分)→ 命中区间按文本节点切段包 `<mark>`(跨元素边界安全,
splitText;已在自家 mark 内的段跳过 = 恢复幂等)。SPA 软导航用 2s 轮询 URL 变化重锚;
迟渲染页面 2.5s 后补一次。上限:每页 200 条、单条 4000 字。点已有高亮 → 取消/复制。

已知边界:页面文案本身变了(exact 找不到)高亮静默丢——TextQuote 的固有限制,接受。

### 2.3 LLM 动作 = 单次 completion,刻意不走 agent 循环

划词动作的价值是"秒回",走 agent 循环(工具目录+历史+循环)既慢又贵。SW 侧
`handleSelectionLlm`:resolveSlots().primary → 一条 system(直接给结果,勿客套)+
user(动作 prompt + 选中文本 + 页面标题)→ 60s 超时。自定义动作 = 用户写 prompt
(设置页可增改删/排序,上限 8 个;预置 翻译/解释/总结)。

**Shared with localmd Connect (2026-09-04, revised 2026-09-05).** The system
prompt and the input cap live in `src/selection/prompt.ts`, read by this shell's
service worker and by localmd Connect's. Only the ANSWERER differs: this shell
posts to its own configured provider, that one has no API key and asks the
localmd app over MCP `sampling/createMessage` (docs/localmd-connect.md §14.4o).

The two shells' RECIPES have since diverged, deliberately. localmd Connect's are
user-editable templates with `${content}` / `${lang}` and a per-ask on/off
switch (§14.4p) — shapes this shell's `SelAction` has no concept of, so sharing
the preset list would have meant one of them carrying fields the other ignores.
What is still shared is the template FILLING (`fillPromptTemplate`), which is
where this shell would start if it ever gains the same editor.

### 2.4 问一下:用户手势窗口内开面板 + session storage 桥接

`sidePanel.open()` 必须在用户手势上下文里 —— router 对 SELECTION_ASK **同步**处理
(不能有 await 间隙)。引用文本不能直接 runtime 消息给面板:面板可能正被这次 open
拉起、还没挂监听 —— 所以 SW 写 `storage.session['pendingSelectionAsk']`,面板
**mount 时读一次 + onChanged 监听**双保险,消费后塞进输入框(带来源行)并删 key。

## 2.5 二批改进(2026-07-04,用户真机反馈)

- **结果浮层可拖拽 + 可钉住**:标题栏拖动(拖动即自动钉住);「钉住」后外点/滚动/Esc
  都不再关闭(只认自己的 ✕),可同时钉多个浮层对比;钉住的浮层用文档坐标,随文滚动。
  未钉浮层维持原来的即弃语义。拖拽/钉住做在**结果浮层**而非工具条上——工具条生命周期
  跟着选区走,拖它没有意义。
- **动作按选区长度显隐**:`SelAction.minChars`(设置页每个动作的「≥N 字」输入,0=总显),
  `visibleSelActions()` 在弹条时过滤;总结默认 120 字起(legacy 存量在 merge 时回填,
  用户显式设 0 则尊重)。
- **高亮管理列表**(设置页底部):按页分组(标题=创建时 document.title,新字段)、
  打开原页 / 单条删除 / 整页清空;**删除会同步已打开的页面**——content script 监听
  自己 pageKey 的 storage.onChanged,把 id 消失的 mark 就地 unwrap(页内「点高亮→
  取消高亮」本来就有,这补上了跨页/离页删除)。
- 列表读取用 `storage.local.getKeys()` 过滤 `selHl:` 前缀(min Chrome 138 已具备),
  避免 `get(null)` 把 installed adapter 源码等大值整个拉进面板。

三批(同日追加):

- **浮层头部按钮图标化**:钉住/复制/关闭 换成内联 lucide 风格 SVG(shadow 世界无图标
  模块);复制后闪 ✓ 反馈;钉住态 = 图标变琥珀 + tooltip 变化。
- **高亮管理下沉为二级页面**:划词助手设置页只留一个导航行(›),drill-down 进
  「高亮管理」子页(PageOverlay onBack,同 HistoryPage 模式)——设置页不再被长列表撑爆。
- **agent 可读高亮**:新 generic 工具 `get_highlights`(read):按页面分组返回
  url/标题/每条文本+日期,query 过滤(URL/标题/内容)+ limit 截断(默认 200);
  「把我的所有高亮分类总结」这类请求由 agent 调它完成。管理(删/清)仍只在面板 UI。

## 3. 留后(有理由)

- **编辑态动作**(input/textarea/contenteditable 里的改写/润色):是另一套动作面
  (写回页面),v1 明确只做阅读态,编辑态选区不弹条。
- **iframe 内选区**:v1 仅顶层 frame(all_frames 注入成本/跨帧定位复杂度)。
- **高亮列表页**(看某页/全部高亮、跳转):数据都在 storage,UI 留后。
- **结果流式**:浮层现为 spinner→整段;流式要 Port,不值当 v1。
- **快捷键触发**(参考产品的 keyboard shortcut):现有 auto/Alt 两档够用,commands API
  绑定留后。

## 4. 测试

单测:`tests/selection-settings.test.ts`(默认合并/黑名单匹配/输入归一)+
`tests/selection-anchor.test.ts`(索引/消歧/空白回退/跨节点包裹/幂等/roundtrip,jsdom)。
真机 checklist:`docs/tests/platform.md` §5「划词助手」。爆雷 post-mortem 记
`docs/agent-harness.md` §10.x 并回链本文。
