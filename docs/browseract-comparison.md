# BrowserAct(browser-act/skills)↔ web-agent 对照 & 借鉴

源项目:`browser-act/skills`(本机 `~/code/browser-act/skills`)—— 商业产品 BrowserAct
(反检测浏览器云 + CLI)的公开 skills 仓库。结构与本项目高度同构:入口 skill(≈ 我们的
bridge skill)+ `browser-act-skill-forge`(探索一次→生成可复用 Skill 包,≈ 我们的
explore→synthesize→replay + adapter-author)+ `solutions/` 70+ 站点技能目录(≈ 我们的
marketplace)+ docs。差异在底盘:它是**独立 Chromium/CLI/云代理**路线(卖点=反爬三层:
指纹伪装→自动过验证码→remote-assist 人接管),我们是**用户真实 Chrome 扩展**路线(骑真实
登录态,大多数反爬根本不触发;免代理/免指纹,代价是无匿名批量)。反检测/代理/验证码云是
它的护城河,与我们哲学不同,**不借**;可借的集中在——写操作零副作用探索、探索方法论的
纪律与判据、产物契约、skill 分发架构。

本文档 = 这次对照的方法论 + 借鉴清单(backlog)+ 实施日志。按 CLAUDE.md「审计/设计决定
要记进 docs」维护:每落地一项,在 §3 记 做了什么/为什么/怎么做/已知局限/怎么验证。

> 方法论:通读其 README / 入口 SKILL / docs 全部 9 篇(agent-design、commands、
> concurrency、anti-blocking、browser-modes、headless、remote-assist、skills、skill-forge)/
> skill-forge 的 SKILL.md + 三个 reference(exploration_extraction / exploration_operation /
> output_template,共 ~1200 行方法论)/ 抽查 2 个 solutions 产物(goofish-search-list 本地
> DOM 型、zhihu-search-api-skill 云 API 型);与本项目 `docs/llm-explore-research.md`(A–E
> 杠杆)、`src/tools/generic/*`、`bridge/skills/*`、`docs/tests/findings.md`(F-29/F-30)
> 逐维对照,只保留「它明显更强、且我们尚未具备/尚未成文」的点。

---

## §1 架构对比(一句话)

| 维度 | BrowserAct | web-agent |
| ---- | ---------- | ------------- |
| 底盘 | 独立 Chromium + 云指纹/代理/验证码;chrome-direct 附身本地 Chrome 是 1 配额特例且霸占用户浏览器 | 用户真实 Chrome 扩展是**默认态**,后台 tab + operating 遮罩与用户共存 |
| 驱动协议 | CLI 单命令串行(`--session s1 click 3`),bash `&&` 链 | 原生多工具 `auto` + 一回合并行 + harness(压缩/预算/熔断/Plan/子 agent) |
| 感知 | `state` 索引化元素表 + `*` 增量标记,token 优先 | ref 索引 + 遮挡检测 + SoM + a11y 树 + dom-outline + 结构化数据扫描 + 网络抓包(更全,但无增量标记) |
| 探索→复用 | skill-forge:决策树(API→UI 触发抓包→DOM→AI)+ 逐路径通关判据 + 产物模板 20 条填写规范 | explore v1+v2 + W1 oracle/W2 能力;判据与产物契约较薄(见 §2 Tier 2) |
| 产物形态 | SKILL.md + `scripts/*.py`(argparse 拼 JS 字符串给 eval,f-string 转义地狱) | marketplace `cli({})` JS 模块 + sha256 强制 + 热插拔(**严格更优**,不借) |
| 写操作探索 | **HAR + 断网离线捕获**:零副作用拿到提交请求结构 | F-29:探索期真产生副作用;现修法 = eval_js 静态写拦截(只堵不疏) |
| 多会话 | 显式命名会话 + 所有权(不用别人创建的)+ 8h 回收 | bridge 单通道,F-30 串扰 |
| skill 分发 | 两层:入口 skill 薄壳(触发词)+ 运行时 `get-skills --skill-version` 拉指令 + 版本握手 + 状态条件化 directives | bridge skill 静态全文(134 行),扩展升级后用户侧 skill 会漂移 |
| 人机协作 | `remote-assist` 生成任意设备可开的接管 URL,完成后 agent 无缝续跑 | 本来就在用户浏览器里,接管零成本,但**无成文的移交-续跑协议**(agent 碰到登录/验证码只会失败上报) |

**已领先、无需借**:adapter 完整性(hash 强制 + 热插拔)vs 它的裸文件安装;感知工具族
(遮挡/SoM/结构化数据/find_in_network);harness 编排与熔断;真实登录态省掉整个反爬层;
`.py` 拼 JS 的产物形态不如我们的 JS 模块。它 docs 里的 API-first、SSR 内嵌 JSON、签名
token 处理、golden-sample 健康检查等,我们 `llm-explore-research.md` C1/C3/C7/E1 已覆盖。

---

## §2 借鉴 backlog(按价值/成本排序)

状态:☐ 待办 · ▶ 进行中 · ✅ 已落地 · ⏭️ 暂不做

### Tier 1 — 写操作与多客户端安全(补当前最大敞口,直连 F-29/F-30)

- ✅ **① 离线捕获协议(写探索零副作用)** 【2026-07-03 已落地为 `capture_submission` 并真机 E2E 14/14 通过,见 §3 landing】—— 它的 operation 探索安全协议:
  `har start → network offline on → 填表+点提交 → 等 1~2s → har stop → offline off →
  立刻导航走(防重试重发)`,零副作用拿到 POST/PUT 的完整请求结构(端点/方法/body 字段/
  GraphQL mutation 识别),再评估「API 直连可行(字段可参数化、无动态凭证)/ 降级 DOM
  提交」。这是 F-29 的**建设性**答案:我们现在的 `detectWriteIntent` 只会拦(agent 无法
  继续探索写任务),离线捕获让 agent「真做一遍但发不出去」,既安全又采到合成写 adapter
  所需的证据。落点:generic 新工具 `capture_submission(tab_id)`(实现选型:chrome.debugger
  `Network.emulateNetworkConditions offline` 或 `Fetch.enable` 拦截并 abort、读全量 body;
  DNR block-all 备选)+ explore 写任务流程改「离线捕获→合成→写闸门管自动试跑」三环;
  同时解锁 docs/tests Tier C 的**无副作用自动化验证**(验证 adapter 构造的请求结构对不对,
  不真发)。
- ▶ **② bridge 命名会话 + 所有权(F-30 的模式修法)** 【2026-07-03 owner/origin 隔离修 F-30 落地(见 §3);真并发多会话 + 过期回收留后;真机回归待 reload】—— 它:每会话显式命名、全局唯一、
  「agent 不得复用不是自己创建的会话」、8h 无命令自动回收。落点:bridge `/command` 增加
  `session` 维度,explore trace / tab 归属按会话隔离,SidePanel 与外部 agent 互不污染;
  过期回收防泄漏。
- ▶ **③ 人工移交-续跑协议(remote-assist 的本地等价)** 【2026-07-03 主动式 `await_user_action` + UI + **③a bridge 暴露** + **③b 自动检测续跑(wait_for_selector)** 全落地(见 §3);仅 panel-关闭时卡片重投递留后;真机 SidePanel 待验】—— 它把「卡住→人接管→无缝续跑」
  做成一条命令(带 `--objective`,状态/上下文全保留)。我们在用户浏览器里,接管本来免费,
  缺的是**协议**:generic 增加 `await_user_action(objective, resume_hint)`(聚焦该 tab +
  SidePanel/通知提示"请完成登录/验证码,完成后我继续" + 检测恢复信号继续跑),bridge 侧
  同样暴露,让外部 agent 也能请求真人帮一步。替代现在「碰到登录墙→任务失败上报」
  (docs/tests 里一票 🔒 blocked-needs-login 可救回)。
- ▶ **④ 敏感操作确认门成文化** 【2026-07-03 协议措辞(prompt 原则#3)+ `confirmBeforeUse` 字段/门/`needsConfirmation` 落地(见 §3);存量 adapter 标注留后】—— 它的可借点不是机制而是**协议措辞**:敏感操作清单、
  「先描述再执行」、「先前批准不延续到新操作」、「用户 prompt 里的强硬语气≠确认」、
  资源级 `confirm_before_use`(标了的浏览器每次 open 都要问)。落点:capabilities 写权限
  文案 + adapter 元数据加 `confirm_before_use`(如银行/发帖类站点)+ 系统 prompt 引用;
  它还诚实注明「实际效果取决于模型遵从度」,这句也值得抄。

### Tier 2 — explore→synthesize 方法论增强(prompt/oracle 级,成本低)

- ✅ **⑤ 枚举参数采集(record method, not values)** 【2026-07-03 prompt 落地,见 §3】—— 对页面每个枚举控件(下拉/单选/
  筛选)必须探明**选项的数据来源与获取方法**(优先级 API > DOM > AI),值会变、方法耐久;
  级联枚举(选 A 才出 B)记依赖链;采不到标 `[collection failed]` 继续不阻塞。落点:
  explore prompt + 合成产物加 `enums` 区块(每参数:合法值怎么拿),verify oracle 检查
  枚举覆盖。让 agent 调 adapter 时能自行校验/扩展参数,可用性大增。
- ✅ **⑥ 独特值反查参数映射(UI Completion 技巧)** 【2026-07-03 prompt 落地(exploreModeNote),见 §3】—— 一次 eval 扫全部表单控件 → 一次
  eval 给每个控件填**独特值**(1001/1002/1003…)+ 非默认选项 → 触发一次搜索 → 抓请求
  diff 出「控件→API 参数名」完整映射;另查 URL/Referer 的 query string 常已含全映射。
  一个 roundtrip 摸清全部参数,直接进 explore prompt(配 find_in_network)。
- ✅ **⑦ 翻页四型必检 + 终止条件** 【2026-07-03 prompt + 无终止 paginate lint + **运行时 page2≠page1 硬校验**全落地,见 §3】—— 列表类能力**必须**验证翻页(page2 ≠ page1),按
  API 翻页/URL 翻页/DOM 翻页/AI 翻页四型记录:参数名/型别/下一页值来源/**终止条件**。
  我们翻页是随缘写;成文进 synth 规则 + oracle(「列表任务未验证翻页 = 不通过」)。
- ✅ **⑧ 失败纪律(fast-fail 语料)** 【2026-07-03 prompt 落地,见 §3】—— 三条抄进 explore prompt:(a) 手段失败后**不换参数
  重试**(确定性失败一次即定论,瞬时失败限一次重试),回到目标枚举替代手段选下一个;
  (b) 框架内部状态(`__vue_app__`/React fiber)**失败一次即放弃**转 DOM;(c) 效率总则
  「每次浏览器 roundtrip 必须有信息增益」+ 批量验证选择器(一次 eval 测全部候选,返回
  hit 数/首元素摘要/唯一性,不许逐个 eval)+ 大响应先在浏览器内取 count/total/sample 再
  返回。与 D2/V2.4 互补。
- ▶ **⑨ 产物契约四区块** 【2026-07-03 prompt 头注释 + Success Criteria 由 computeResultCriteria 落地;Known Limitations/Efficiency 仍 prompt-only,见 §3】—— 合成的 adapter/说明补:**Success Criteria**(只许可量化:
  `count>=1`、`核心字段非空率=100%`,禁描述性)→ 供 replay 自检 + E1 健康检查复用;
  **Known Limitations**(只写探索中实际遇到的,禁臆测;权限受限≠技术失败,标注即通过);
  **Execution Efficiency**(给调用方的批量指引:单浏览器内串行勿并行、先测 1-2 条再跑批、
  逐条落盘断点续跑);**部分成功即成功但必须告知未覆盖项**(与 truthful-status 一致)。
  落点:synth prompt + marketplace adapter 元数据/头注释。
- ▶ **⑩ 每 adapter 经验笔记(experience notes)** 【2026-07-03 落地:health-store 加 notes + `note_adapter_experience` 工具 + 失败时注入(见 §3);真机待 reload】—— 产物自带 memory 文件约定:执行前
  若存在先读(记录「某策略已失效/站点改版/反爬升级」),执行后**只有出意外才追加**一行
  `{日期}: {事} → {结论}`;正常执行不写、任务输出(用了什么关键词/返回几条)不写。
  与扩展长期记忆区分:这是**按 adapter 键控的站点经验**。落点:extension memory 按
  `adapter:{site}/{name}` 键 + replay 前注入;forge 期间不读不写(职责分离,它也这么定)。
- ▶ **⑪ 冷读者自测(consumer test)** 【2026-07-03 prompt 冷读者纪律 + **完整 consumer-test(冷读 LLM 自检 `consumer-test.ts`)** 全落地,见 §3;真机待验】—— 它交付前强制:起**子 agent** 只读生成的 SKILL.md
  照章执行最小用例集,报告逐组件通过/失败 + 「说明书哪里看不懂」;主会话不许自测(自己
  写的自己当然会用)。我们 verify 在 explore 循环内、带全上下文,测不出「说明不自足」。
  落点:docs/tests/tasks.md 方法论 + adapter-author skill 收尾步骤。另:它的合规自查要求
  「必须 Read 文件/执行命令留证,心证不算」——与我们 truthful-status 教训同源,值得进
  explore 收尾 prompt。

### Tier 3 — 分发与发现(bridge/marketplace 侧)

- ▶ **⑫ 两层 skill + 版本握手 + 动态 directives** 【2026-07-03 `/guide` 端点 + 版本握手 + **SKILL.md 真薄壳精简(146→89 行)** 落地(见 §3);get-skills 版本化拉取留后;bridge submodule 待提交】—— 入口 SKILL.md 薄壳只负责触发与
  「先跑 `get-skills core --skill-version X`」;运行时返回:环境状态 + 资源清单 + 核心
  指令 + **按当前状态生成的 directives**(多浏览器→给选择规则;没 API key→绕开付费路径),
  版本不匹配时把升级指引直接打在输出里让 agent 自己执行。我们的痛点一模一样:bridge skill
  是静态全文,扩展/桥升级后用户侧 skill 漂移。落点:`bridge/server.mjs` 加 `/guide?skill-version=`
  (返回:扩展连接状态/版本、已装 adapter 清单、可用工具、状态条件化提示、版本失配升级
  指引),`bridge/skills/web-agent/SKILL.md` 缩成薄壳。分发上它还有 GitHub Action 把
  skill 目录同步进 claude-code plugin 仓库(单源多渠道),我们 skills 仓库可抄。
- ▶ **⑬ description 触发词工程** 【2026-07-03 find_adapters 中英别名 + 任务同义词 + synth 规则落地(见 §3);index.json 290 就地增补留后;真机待 reload】—— 它给生成 skill 的 description 定了硬规范:站点名
  置前、口语/正式/缩写全覆盖、相邻场景外扩、全英文、<1024 字符、「宁可 pushy(Claude
  倾向欠触发)」。我们 marketplace `index.json` 的 description 直接喂 `find_adapters`
  匹配——同样规范化(中英触发词、站点别名如 闲鱼/xianyu/goofish)能显著提升 adapter
  发现率。落点:synth prompt 产 description 的规则 + 存量 adapter 一次性 sweep。
- ✅ **⑭ `extract` 一条命令(零仪式一发抽取)** 【2026-07-03 落地为 `get_page_text` `format:"markdown"` 并真机验证,见 §3】—— `stealth-extract url` = URL 进、
  markdown 出,无会话无清理,天然可并行,定位成 WebFetch 替代。我们等价物是
  open_url→wait→get_page_text→close_tab 四连。落点:bridge 合成工具 `extract <url>`
  (后台 tab 全流程封装 + 可选 `--output` 落盘),外部 agent(Claude Code)拿它当带登录态
  的 WebFetch,一条命令。纯组合,成本极低。
- ☐ **⑮ 资源 desc 语义记忆 + 消歧写回** —— 每资源挂自然语言 `desc`(append 语义),
  选择协议:desc 明确匹配→直接用;唯一→直接用;歧义→列候选问用户,**用户选完把结论
  append 回 desc**,下次免问(自增强)。落点:多 profile 能力槽 / tab group / 工作流的
  描述字段 + 选择-写回循环。
- ▶ **⑯ 目录/README 打法(公共仓库采用率)** 【2026-07-03 marketplace README 场景分组 + 安装话术落地(submodule 6bd022c,见 §3);skills 仓完整 README + 免费额度/star 钩子留后】—— solutions 目录按**业务场景**分组
  (ecommerce/lead-gen/social-listening…)而非按站点;安装话术统一「Tell your agent:
  Install X from {url}. Verify it works after installation.」(agent 自装自验);README
  首屏讲「agent 的浏览器要解决的四件事」这类问题定位而非功能列表;免费额度表 + star
  换 credits 的增长钩子。落点:marketplace / skills 两个公共仓库的 README 与目录页
  (从 index.json 生成、场景分组、一行安装话术)。

### Tier 4 — 感知格式(佐证已有 roadmap 项)

- ✅ **⑰ `*` 增量标记** 【2026-07-03 落地为 `get_interactives` `new:true`/`new_count` 并真机验证,见 §3】—— `state` 对「自上次调用新增/变化」的元素加 `*` 前缀,首拍全
  `*`、后续只标 delta,agent 聚焦新东西。= 我们 D2(change-observation diffs)的最小
  实现形态,佐证其优先级;get_interactives 按 tab 记上次 ref 集合、返回加 `new` 标即可,
  比完整 diff 引擎便宜一个量级,可作 D2 的第一阶段。

### ⏭️ 明确不借

- 反检测指纹/TLS 轮换/代理池/solve-captcha 云、stealth 浏览器与隐私模式 —— 云产品护城河,
  且与「骑用户真实会话」哲学冲突(我们的等价答案:真实登录态 + ③ 人工移交)。
- remote-assist 的**跨设备云中转**形态(本地场景无需;协议内核已被 ③ 吸收)。
- `.py` argparse 拼 JS 字符串的产物封装(f-string 转义地狱;我们的 `cli({})` JS 模块严格更优)。
- CLI 单命令串行驱动形态(我们原生多工具并行更强)。

---

## §3 实施日志

(落地一项记一节:做了什么 / 为什么 / 怎么做 / 已知局限 / 怎么验证。)

- 2026-07-02 建档:通读 browser-act/skills 全仓,产出 §2 十七项 backlog;①②③ 直连
  F-29(写探索副作用)/F-30(bridge 串扰)/tests 里 🔒 类失败,列 Tier 1。
- 2026-07-03 **落地 ①(离线捕获 → `capture_submission`)**:
  - **做了什么**:新增 generic 工具 `capture_submission`(arm/disarm/status)+ CDP 核心
    `src/runtime/submission-capture.ts`。探索写任务时 arm → **真填表点提交** → disarm:写请求
    (POST/PUT/PATCH/DELETE / GraphQL mutation)被拦截 + 记录 + **中和**(abort,不发服务器),
    读请求(GET / GraphQL query)放行;disarm 把捕获结构(端点/方法/body 字段,cookie/授权/CSRF
    头脱敏)喂进 explore trace(`session.recordSubmission`),`synthesizeAdapter` 据此合成
    `access:'write'` adapter(prompt 里新增写-adapter 合成引导 + 捕获块)。
  - **为什么**:F-29 现修法 `detectWriteIntent` 只堵不疏,agent 根本没法探索写任务(整类写
    adapter 硬顶)。这是**建设性**半边:真做一遍但请求发不出去 → 零副作用 + 采到合成证据。
  - **怎么做**:`Fetch.enable{patterns:[XHR,Fetch,Document], requestStage:Request}` **单 tab**
    拦截(chrome.debugger per-target,复用 explore 会话已有 attach,stop 只 `Fetch.disable`
    不 detach——镜像 network-recorder 所有权);GraphQL 按 mutation/query 区分,避免打断读;
    非 GraphQL POST 默认判写(安全偏置);handler 出错兜底 `continueRequest` 防卡页。prompt:
    exploreModeNote 写任务改「路线 A capture_submission 实做 / B 观察推断」+ eval-js 写拦截
    文案指向它。
  - **已知局限**:① armed 窗口内每个 XHR/Fetch/导航多一次 continue 往返(短窗可接受);
    ② handler 抛错兜底 continue,极端下可能漏拦一条(由"缺失捕获"暴露,不静默);③ `fulfill`
    模式回假 200 可能触发页面后续动作,故默认 `abort`。
  - **怎么验证**:离线门禁全绿(tsc / eslint / **1541 测试**[+16 新] / build / prettier)。
    **真机 E2E 通过(2026-07-03,reload 后经 bridge)**——夹具 `docs/tests/fixtures/write-form.html`,
    `explore_start → open_url → arm → 逐钮 click 读 #status → disarm`,**14/14 断言全过**:写(fetch
    POST `/api/comment`、GraphQL mutation `AddStar`、原生表单 POST `/native-submit`
    [resourceType=Document])= `neterror`(中和、页面未跳转);读(GET `/api/list`、GraphQL query)
    = `sent`(放行);`Cookie` + `x-csrf-token` 头 = `<redacted>`(content-type 保留、无明文 secret);
    body 三型解析正确(JSON `{comment,target:42}` / GraphQL `{query,variables}` / form `{title}`)。
    **附带实证**:探索 tab 上还捕到第三方 ByteDance 埋点 POST(`mcs.zijieapi.com/list`,某扩展/SDK
    注入)——说明拦截确实覆盖 tab 全部写(安全正确);对合成是噪声,agent 按端点过滤即可。
- 2026-07-03 **落地 便宜复利簇 ⑤⑦⑧⑨⑪(prompt/oracle,无需 reload)**:
  - **⑦ 翻页**:synth prompt 加翻页型别(接口/URL/DOM/cursor)+ **必须终止条件**;`lintSource` 新增
    **无终止 paginate 警告**(paginate 缺 `maxPages`/`until` → 警告;高精度,4 单测)。运行时
    page2≠page1 硬校验留后(需 runtime 改)。
  - **⑨ 产物契约**:synth prompt 要求 `cli()` 头注释三区块(成功判据[只量化] / 已知限制 / 执行效率);
    新增 `src/explore/criteria.ts` `computeResultCriteria`——把 verify **已算却丢掉**的行数 + 逐列非空率
    变成量化「成功判据」行喂给 agent(11 单测)。Known Limitations / Efficiency 目前 prompt-only。
  - **⑧ 失败纪律**:exploreModeNote 加「确定性失败别换参重试→换手段;框架内部态(`__vue_app__`/fiber)
    一击即弃→DOM;每 roundtrip 有增益 + 一次 eval 批量测选择器 + 大响应先取 count/sample」。
  - **⑤ 枚举**:synth prompt + exploreModeNote 加「枚举控件记**选项来源方法**(接口>DOM>固定)+ 级联
    依赖,写进 arg help(记方法不记死值)」。
  - **⑪ 冷读者**:exploreModeNote 加「交付前当别人写的工具审一遍(只看 args/描述/试跑返回)+ 结论
    必须有工具输出/亲读作证、不凭印象」。完整**子 agent** consumer-test(只读产物跑最小用例)留后(需 runtime)。
  - **验证**:离线门禁全绿(tsc / eslint / **1556 测试**[+15] / build / prettier)。**真机验证(2026-07-03,
    任务 1 豆瓣 Top250 / 任务 2 GitHub 搜索 / 任务 3 GitHub star,均 SidePanel explore)全过**:⑨ 头注释三区块 +
    成功判据反馈行(含 partial% 分支,实测 `language 90%`)真机确认;⑦ `start`/`page` URL 分页带终止;⑤ sort/order
    枚举合法值入 help;⑪ 任务 3「零副作用」如实收尾(对照 F-29 翻车);① `fulfill` 模式顺带补验。任务 1 还暴露并修了
    **F-32**(`${{ }}` 写进反引号模板串 → 语法错;lint 单遍 backtick 奇偶态 + prompt,见 findings F-32)。
    **留后**:⑦ 运行时翻页硬校验、⑪ 子 agent 自测、混淆-class lint 补 CSS-modules `Name__hash`(任务 2 漏警、模型自兜)。
- 2026-07-03 **落地 快赢 ⑰ + ⑭(离线门禁绿,真机待验)**:
  - **⑰ D2-lite(`get_interactives` 加 `new` 标)**:SW 侧按 tab 记上次可交互元素签名集(排除易变 `ref`),
    同一 URL 再扫时给新出现的元素标 `new:true` + 顶层 `new_count`;导航到新 URL **重置基线**(不算 new)。
    做完动作(开菜单/弹窗)再扫就能盯新控件、不重读整表。纯 SW 逻辑,`applyNewFlags` 5 单测。完整 D2 变化引擎的便宜首阶。
  - **⑭ extract-markdown(`get_page_text` `format:"markdown"`)**:`htmlToMarkdown`(Turndown)要 DOM、SW
    没有(jsdom 仅测试用、零 SW 调用点),故**在页面内**用自包含 DOM→markdown walker(标题/链接/列表/表格/
    强调/代码/引用/图,优先 `main`/`article` 正文、跳过 script/nav)转换;`get_page_text` 本就"URL→后台 tab→
    自动关",加个 `format` 即成带登录态的 WebFetch(markdown out)。9 单测(jsdom)。
  - **门禁**:tsc / eslint / **1573 测试**[+17] / build / prettier 全绿。**真机验证通过(2026-07-03,bridge,8/8)**:
    ⑭ example.com→markdown(`# 标题` + `[Learn more](url)` + 段落;`format:"text"` 无 md 标记;flag 切换正确);
    ⑰ 扫#1 基线(无 `new_count`)→ eval_js 注入按钮 → 扫#2(`new_count=2`、注入钮 `new:true`、原有 link 不标)→
    导航 `?x=1` 扫#3 **基线重置**(无 `new_count`)。
- 2026-07-03 **落地 iframe ref 语义(我方独有 —— browseract 不覆盖;最后一个 Tier-A 感知盲区)**:
  - **做了什么**:`get_interactives` 改 `executeScript({allFrames:true})` 扫**每个帧**(顶层 + iframe,含跨域),
    `mergeFrameResults` 合并——子帧元素的 `ref` 加帧前缀 `f<frameId><localRef>`(如 `f5r3`)+ `frame` 字段,
    顶层还给 `frames` 汇总(各帧 URL);`click`/`type_into` 用 `parseFrameRef` 拆出帧号 →
    `executeScript({frameIds:[id]})` 注进对应帧操作。共享 `frameRef`/`parseFrameRef`(`_helpers`)。
  - **为什么**:iframe 内容(**即便同源**)对"只注顶层"的扫描是独立 document、完全不可见,且无法操作——
    整类 Tier-A 盲区。browseract 的 DOM 模型不覆盖这块,是我们独有要补的。
  - **怎么做**:`scripting` + `host_permissions:<all_urls>` 已在 → allFrames 能注跨域 iframe,**不需新权限**;
    帧号 0 = 顶层(ref 不加前缀、向后兼容);子帧坐标是帧内相对坐标,故 iframe 元素跳过 ⑧ agent cursor。
    同源/跨域走同一条码路。
  - **已知局限**:iframe 元素可见性用**帧自身视口**判断(iframe 整体滚出顶层视口时其元素仍会返回);
    iframe click 不显示 agent cursor(坐标系不同);selector(非 ref)点击仍只走顶层帧。
  - **验证**:离线门禁全绿(tsc / eslint / **1581 测试**[+8] / build / prettier;`frameRef`/`parseFrameRef` +
    `mergeFrameResults` 纯逻辑单测)。**真机验证通过(2026-07-03,bridge,8/8)**:夹具 `iframe.html`(同源子帧)——
    扫同时返回顶层 `TOP BUTTON`(`r1`)+ 子帧 `IFRAME BUTTON`(`f4388r1` + `frame:4388`)+ 子帧 input(`f4388r2`)+
    `frames:[{4388, …/iframe-child.html}]`;click `f4388r1`→`#cstatus=child:clicked`、type_into `f4388r2`→
    `child:typed:hello`、顶层 click 回归 `top:clicked`。**跨域**走同一 allFrames + host_perms 码路(机制与同源相同,
    真跨域嵌入未夹具复验——可在真实站点抽查)。
- 2026-07-03 **落地 小清扫批(便宜离线)**:
  - **F-33 混淆-class lint 补 CSS-modules**:`lintSource` 现识别 webpack `[name]-module__[local]__[hash]` /
    `sc-<hash>` / `css|jss-<hash>` / 复合类尾随 `__<hash>`(尾段 mixed-case 或带数字),高精度不误伤 BEM/kebab
    (`search-result__title` 等不报);4 组单测(含全大写 hash `KRMAf`——旧 mixed-case 检查也漏的)。结清便宜
    复利簇 landing 列的「留后:混淆-class lint 补 `Name__hash`」(见 findings F-33)。
  - **⑥ 独特值反查参数映射**:exploreModeNote 加「一次摸清『控件→接口参数』——给每个控件填独特值(1001/1002…)+
    非默认选项 + 触发一次搜索 + find_in_network/read_network diff → 全部映射;先看 URL/Referer 的 query string 常已含全映射」。
  - **验证**:离线门禁全绿(tsc / eslint / **1585 测试**[+4] / build / prettier)。⑥ 为 prompt(运行时行为不 bridge
    可验,同便宜复利簇惯例)。
- 2026-07-03 **落地 ③ 人工移交-续跑(`await_user_action`)**:
  - **做了什么**:复用现成 H9 全栈(`requestHumanTakeover` + `HumanTakeoverReq/Resp` + 路由 + engine-driver
    网关 + SidePanel `HumanTakeoverCard`),补上**主动式入口**——新增 intercepted 工具 `await_user_action(objective,
    tab_id?)`(api-engine 拦截,经 `ctx.awaitUserAction` → `requestHumanTakeover` 带 `message`):agent 卡在登录/
    验证码/需真人判断时主动调它 → 把该 tab 切到前台 + 弹「🙋 需要你帮一步:{objective}」卡 + **暂停** → 用户点
    「我已完成」→ 续跑(点跳过/超时 → 反馈让 agent 如实告知、别假装完成)。`HumanTakeoverReq` 加 `message` 字段;
    卡片按 `message` 分主动/被动文案;exploreModeNote「被卡住」改指向它。
  - **为什么**:此前只有**被动**触发(工具撞 `AuthRequiredError` 才起 takeover);主动式让 agent 能在任意点请真人
    帮一步,救回一票 login-blocked / captcha(docs/tests 里的 🔒)。browseract Tier 1。
  - **已知局限**:**bridge 暴露**(外部 agent 请真人)留后——`await_user_action` 是 agent-loop intercepted 工具、
    非 registry,bridge 不直接可调;**自动检测续跑**(`wait_for_selector` 轮询免人工点)留后。
  - **验证**:离线门禁全绿(tsc / eslint / **1585** / build / prettier;新增均 type-checked,prettier 增量干净)。它是
    **agent-loop + SidePanel UI**,**需真机 SidePanel 跑**(reload → 给个撞登录墙的任务、或让 agent 调
    `await_user_action` → 见「🙋 需要你帮一步」卡 → 接手 → 点「我已完成」续跑),**不 bridge 可验**。
    **首测(weibo 首页,s_mr4g2gm8)未触发**:用户已登录微博、没撞墙,agent 正常取回 17 条(对);但暴露
    general prompt(`systemPromptApi`)**没提示** await_user_action——我原先只加进了 exploreModeNote。已补进
    principle #4 +bump `PROMPT_VERSION` 到 `2026-07-03.1`。
    **复测 #2(登出微博,s_mr4gpvrs)**:prompt 生效——`weibo__feed` 抛 `AuthRequiredError` → agent 决策并**调用了**
    `await_user_action`(objective 文案也对),但返回 **`tool not found: await_user_action`**!根因:它是 intercepted
    工具,而 api-engine 有**两个**工具处理循环(loop A ~499 / 主执行 loop B ~1134),我只加进了 loop A,主 loop B
    漏拦 → 落到 dispatcher 报 tool-not-found。已补 loop B(parallel-read 预批因 `lookupAdapter` 未命中已天然排除)。
    **复测 #3 通过**(reload 后登出态:`weibo__feed` 撞墙 → agent 调 `await_user_action` → 弹「🙋 需要你帮一步」卡
    + 切 tab → 用户登录 → 点「我已完成」→ agent 续跑取回首页)。✅ ③ 落地 **cb806d6**。
- 2026-07-03 **落地 ②(F-30 explore 隔离——命名会话的核心)**:F-30 = `executeAdapter`(全工具 choke point)末尾
  无条件 `getActiveExploreSession()?.recordAction`,不分调用来自 SidePanel agent 还是 bridge `/command` → bridge
  调用会串进进行中的 panel explore trace(反向亦然)。**修法**:`ExploreSession` 加 `owner`(SidePanel = chat
  sessionId / bridge = `'bridge'`);`executeAdapter` 加 `origin`(agent 传 sessionId、bridge 传 `'bridge'`、
  verify/workflow 不传);记录改 `if (session && exploreShouldRecord(owner, origin))`(= `!origin || owner===origin`)。
  修**双向**串扰 + sidepanel↔sidepanel(B 的调用不再记进 A 的 explore)。**验证**:6 单测(`explore-owner-isolation`)
  + **1591 全绿**;真机回归(bridge explore 记自身 / 交叉不记)待 reload。**留后**:完整"命名会话 + 过期回收"
  (真并发多 explore)是更大改——当前单例 explore + owner 标记已够修 F-30。
- 2026-07-03 **落地 ⑬(find_adapters 发现率——中英别名 + 任务同义词)**:290 adapter / 28 站,描述中英混杂
  (weibo/linkedin/twitter/instagram/reddit… 英文描述),中文查询「微博」「领英」「推特」搜不到。**修法**(比重写
  290 条描述更中心化):`find-adapters.ts` 加 **`SITE_ALIASES`**(每站中文名 + 高辨识度缩写,折进匹配 haystack;
  CN 名不与英文子串冲突、丢掉 x/so/ig 等歧义短拉丁)+ **`TASK_SYNONYM_GROUPS`**(搜索↔search、评论↔comment、
  私信↔message… 双向,查询词扩展)。synth prompt 加「description 带站点中英名 + 用途词」使新 adapter 也好搜。
  `adapterHaystack`/`scoreQuery` 纯函数,6 单测(微博→weibo、领英→linkedin、推特 搜索 排序、英文无回归、
  无关=0;还抓到 message≠messaging 子串坑并修)。**验证**:离线门禁全绿(**1597**);真机 find_adapters
  「微博」/「领英」/「推特 搜索」待 reload。**留后**:marketplace index.json 290 条描述就地增补(可选,别名图已覆盖
  主缺口);别名图当前在扩展、可后移进 index.json 解耦。
- 2026-07-03 **落地 ⑫(两层 skill + `/guide`,bridge submodule)**:静态全文 SKILL.md(134 行)会随扩展/桥
  升级漂移。**做法**:`bridge/server.mjs` 加 **`GET /guide`**——返回实时状态(连接 + 扩展 version/client + 已装
  站点 adapter 清单 + 工具数)+ 操作指令 + **版本握手**(SKILL.md 传自己的 `?skill-version=`,与 bridge 的
  `SKILL_VERSION` 比,不匹配 → guide 里直接打更新指令 `npx skills add …`);register 存扩展 version/client;
  SKILL.md 顶部加「先跑 `/guide`、两者冲突以 /guide 为准」薄壳指引 + 版本标记。**验证(重启 daemon,不需扩展
  reload)**:`/guide` 返回结构化字段 + `guide` markdown;版本握手 —— stale `2026-06-01` → `upToDate:false` +
  更新段、current `2026-07-03` → 干净;断连态指令正确(提示用户去侧边栏启用)。**连接态**(adapter 清单)= 同
  码路 catalog 填充即出,待扩展重连(MV3 SW 唤醒)复看。**留后**:把 134 行静态说明大幅精简成真薄壳(全靠
  /guide)+ MCP `get-skills` 版本化拉取。bridge submodule 提交 + 主仓 bump 指针。
- 2026-07-03 **落地 ⑩(per-adapter 经验笔记)**:复用 `adapter-health-store`(已按 `${site}/${name}` 键)——加
  `notes` 字段 + `appendNote`(cap 8、去连续重复,纯)+ `recordAdapterNote`/`getAdapterHealth`/`toHealthId`。
  **写**:新 intercepted 工具 `note_adapter_experience(tool, note)`,agent 仅在**意外**(站改版/反爬/策略失效)时记;
  **读**:dispatcher 在站点 adapter **失败时**把该 adapter 的笔记 append 进 error(排障时自动带出)。systemPromptApi
  主动提醒段 + 工具描述引导「只在意外记、别记正常运行」。5 单测(appendNote/toHealthId)。区别于 per-site
  findings(explore 内)与用户长期记忆。5 单测(appendNote/toHealthId)。**验证**:离线门禁全绿(**1602**)。
  **真机验出并修了 F-35**(见 [[docs/tests/findings.md]]):`applyOutcome` 重建 health 记录时没保留 `notes`,笔记写完
  后**只要该 adapter 再被调一次就被覆盖清空** → 读回永远空。修:`applyOutcome` 补 `notes: prev?.notes`(+1 单测)。
  **修后真机端到端过**:记笔记 → 强制失败 → 错误尾部带「📝 该 adapter 的历史经验笔记」。✅
- 2026-07-03 **落地 ④(敏感操作确认门:协议措辞 + `confirmBeforeUse`)**:借的是**措辞**——systemPromptApi 原则#3
  改「先把**具体动作**说清再执行 · **一次确认只对这一个动作**(不延续到后续写) · **用户强硬/着急语气 ≠ 确认**」+
  诚实注「这条靠模型遵守」。**机制**:`AdapterDef` 加 `confirmBeforeUse?`,纯函数 `needsConfirmation(adapter,
  autoApprove)`(write 非 auto 才问;`confirmBeforeUse` **永远**问,即便 read / auto 模式);`makeExecuteTool` 门改用它。
  synth prompt:银行/支付/发帖类写 adapter 加 `confirmBeforeUse:true`。3 单测。**存量标注(marketplace submodule
  f9ede83)**:给 4 个**不可逆**写 adapter 标了 `confirmBeforeUse:true` —— `twitter__delete`/`douyin__delete`(删内容)、
  `instagram__collection-delete`(删收藏夹)、`linkedin__connect`(发好友请求);各轮换 index.json sha256(装载路强校验)。
  验证了 `cli({confirmBeforeUse})`→registry(`{access:'read', ...def}` 全展开保留)→`lookupAdapter`→`needsConfirmation`
  全链路。**验证**:离线门禁全绿;真机(auto 模式调其一 → 应弹确认卡)待用户在 SidePanel 验(bridge 路径不走此门)。
- 2026-07-03 **落地 ⑯(marketplace README 采用率,submodule 6bd022c)**:README 加「290 adapters / 28 sites 场景
  分组(social / video / reading / AI)」+「Install — just tell your agent」一行安装话术(find_adapters 中英别名 →
  load/install,免手动浏览、免配置)。skills 仓的发现 description 已由 SKILL.md frontmatter 覆盖;两仓完整场景
  README(免费额度/star 钩子)可后补。纯文档,无需真机验。
- 2026-07-03 **落地 ⑦ 运行时翻页硬校验**(补齐便宜复利簇里留后的那半):`verifyExploreAdapter` 现在——列表 adapter
  若声明 page/offset 参数且返回非空数组,自动**再跑第 2 页**(page+1 或 offset+页大小)比对首行签名;第 2 页与第
  1 页高度重复(≥80%)→ 警告「翻页可能没生效,检查参数是否接进请求/URL」。纯 helpers
  `pickPaginationArg`/`nextPageValue`/`duplicateFraction`(cursor 不透明→跳过),9 单测。**验证**:离线门禁全绿;
  真机(跑个带 page 参数的列表任务看警告)待 reload。
- 2026-07-03 **修 F-34 合成挂起(真机分页测试暴露)**:真机用 ProductHunt 测⑦翻页时,`synthesize_adapter` **卡约
  19.5 分钟**、恢复后工具结果是含糊的 `[已中断,无结果]`,模型据此**幻觉「我没有 synthesize_adapter 工具」**并放弃。
  **根因**:合成 LLM 调用无超时、且 `handleSynthesizeAdapter` 根本没传 signal(`chatCompletion` 的 fetch 无 timeout)→
  端点 stall 就无限挂、阻塞整个 agent loop;占位文案又误导模型。**修法**:`synthesizeAdapter` 内套
  `AbortSignal.timeout(180s)` + 新纯函数 `anySignal`(`resilience.ts`)合并调用方 signal → 超时变可重试错误;
  `sanitizeHistory` 的中断占位改成「点名工具 + 明确中断/可重试/写操作先核实」。6+2 单测。**完整 post-mortem 见
  [[docs/tests/findings.md]] F-34**。**验证**:离线门禁全绿(1620);真机复现难(需端点 stall),建议 reload 后重跑
  ProductHunt 分页探索确认能正常合成/超时可重试。
- 2026-07-03 **落地 ③a(bridge 暴露 await_user_action)+ ③b(自动检测续跑)**:
  - **③a**:`await_user_action` 是 agent-loop intercepted 工具、bridge 调不到 → 加进 `bridge-client.ts` 的
    `CONTROL_TOOLS`(新 `awaitUserActionTool`),经 `requestHumanTakeover('bridge', …)` 复用 H9 全栈让**用户**在自己
    浏览器里看到接手卡。三处配套:①**放行会话过滤**——`App.tsx` 的 `eventBelongsToCurrentSession` 门原会**丢弃**
    非当前会话的 `HUMAN_TAKEOVER_REQ`(bridge 会话 id=`'bridge'` 永不等于 panel 当前 chat)→ 从门里摘出 takeover,
    永远显示(卡片自带 sessionId、模态、本就该跨会话显示);②**超时对齐**——server `callExtension` 对
    `await_user_action` 用 320s(> 扩展侧 300s takeover 超时),否则默认 180s 会先超时;③**panel 未开 fail-fast** +
    桌面通知(`notifyHumanTakeover`)——卡片只在开着的 SidePanel 渲染,未开就明确报错让外部 agent 转告用户开侧边栏,
    而不是干等 5 分钟超时。server SYNTHETIC 增 `await_user_action` 广告条目。
  - **③b**:`await_user_action` schema 加 `wait_for_selector` + `wait_until(appear|disappear)`;`requestHumanTakeover`
    加轮询(700ms、深穿 open shadow DOM、串行 setTimeout 不叠),选择器命中即走**同一 parked resolve** 自动续跑
    (等价于用户点「我已完成」),免手点。卡片显示「✨ 完成后自动续跑」提示。两循环用统一 `parseAwaitUserAction`
    解析(原③ two-loop 分叉 bug 的教训)。新类型 `AwaitResumeHint`(messages.ts)贯穿 agent→engine→takeover。
    8 单测(parseAwaitUserAction)。**验证**:离线门禁全绿;真机需 **本地跑 bridge**(`node bridge/server.mjs`,非 npx)
    + reload + 开 SidePanel(见测试清单)。留后:仅 panel-关闭时的卡片重投递(broadcast-once,开 panel 不回补)。
- 2026-07-03 **落地 ⑪(冷读者 consumer test)**:read adapter `verifyExploreAdapter` 通过后,`consumer-test.ts` 把该
  adapter 的**公开规格**(name/site/description/args)**单独**喂一次冷读 LLM——**不给探索上下文**(作者总觉得自己造的
  能用;独立读者才测得出「说明不自足」)。判「仅凭说明能否正确调用 + 列出会卡壳/得靠猜的点」,不清就把一行
  `消费者冷读自检:规格可能不自足——…` 并进 `allWarn`(agent-facing warning 通道)→ agent 据此补 description/help 后
  重合成。`chatCompletion` 复用 + `AbortSignal.timeout(60s)` + **fail-open**(任何错误返回 null、绝不阻塞合成)+
  模块常量 `CONSUMER_TEST_ENABLED` 一键关。为此给 `verifyExploreAdapter` 回传补 `description`(取自 captured def)。
  纯解析 `parseConsumerVerdict`/`consumerWarning` 12 单测。**验证**:离线门禁全绿(1640);真机(explore 造个说明含糊的
  adapter 看是否被点出)待 reload。
- 2026-07-03 **落地 ⑫ 真薄壳精简(bridge submodule)**:`SKILL.md` 由 **146 行 → 89 行**——砍掉会漂移的**静态工具清单**
  与**常见任务**段(现由 live 的 `/tools` + `/guide` 覆盖),只留:发现 frontmatter(逐字不动)、一段"是什么"、
  **「先跑 /guide、冲突以 /guide 为准」薄壳指引**(升为中心)、连接引导(§1 bootstrap)、最小 curl 用法、MCP 一段、
  边界四条(local-only / 写开关 / key 不过桥 / 先读 memories)。`SKILL_VERSION` 不变(2026-07-03)——精简不改协议、
  旧 SKILL.md 仍可用,不误报 stale。留后:MCP `get-skills` 版本化拉取。**验证**:frontmatter 完整、markdown 结构正常;
  真机 `/guide` 已在 ⑫ 首轮验过。

---

## §4 现状核验(audit)+ 优先级综合(2026-07-03)

方法:两个 Explore 探针(bridge/分发侧 ②⑫⑬⑭ · explore/synth 方法论侧 ⑤⑥⑦⑧⑨⑩⑪)
+ 自查 grep(Tier-1 机制 ①③④)逐条对代码核验,不是照抄文档结论。

### 4.1 逐项结论(HAVE / PARTIAL / DON'T-HAVE)

| 项 | 结论 | 关键证据 / 说明 |
| -- | ---- | --------------- |
| ① 离线捕获 | **✅ 已落地 + 真机验证(2026-07-03)** | `capture_submission` + `submission-capture.ts`,`Fetch.enable` 拦截并 abort/fulfill;建在 `network-recorder` 同款 CDP attach 上。E2E 14/14 过。详见 §3 landing |
| ② 命名会话/所有权 | DON'T-HAVE | bridge 单全局 socket(`server.mjs:204`,register 直接替换);explore 是模块级单例 `_active`(`session.ts:361`),SidePanel 与 bridge 撞同一单例+同一 tab = F-30 面;无过期回收 |
| ③ 人工移交-续跑 | **✅ 已落地(2026-07-03,offline;真机 SidePanel 待验)** | 主动式 `await_user_action`(cb806d6)+ **③a bridge 暴露**(CONTROL_TOOLS `await_user_action` → owner `'bridge'` takeover;panel 未开则明确报错;server SYNTHETIC + 320s 长超时;桌面通知)+ **③b 自动检测续跑**(`wait_for_selector`/`wait_until` 轮询自动 resolve,免手点)+ 放行 takeover 的会话过滤。留后:仅 panel-关闭时卡片重投递。详见 §3 |
| ④ 敏感确认门文案 | PARTIAL | 机制 HAVE(`WriteConfirmReq/Resp` + 卡片 UI + auto-mode);缺**协议措辞** + adapter 元数据 `confirm_before_use` |
| ⑤ 枚举参数采集 | DON'T-HAVE | arg schema 仅 `{name,type,default,help}`;prompt/lint/oracle 无枚举/选项来源/级联/`enums` 区块 |
| ⑥ 独特值反查映射 | DON'T-HAVE(有 find_in_network 邻接) | 无"填独特值→diff 请求→控件↔参数名"技法成文 |
| ⑦ 翻页必检 | DON'T-HAVE | oracle 只查 rows>0 / 空列率 / 差分重叠;无 page2≠page1 门;`PaginateStep` 是未强制的运行时原语 |
| ⑧ 失败纪律 | DON'T-HAVE | 无"确定性失败不换参重试→换手段"、无框架态一击即弃、无"每 roundtrip 必有增益/批量测选择器" |
| ⑨ 产物契约四区块 | **DON'T-HAVE(但 Success Criteria 近乎免费)** | verify oracle **已算**定量信号(行数 `explore-driver.ts:254`、逐列非空率 `:265-289`),现只当**易逝 warning** 丢掉——把它焊进 adapter 头注释就是 Success Criteria,复用现成计算 |
| ⑩ 每 adapter 经验笔记 | DON'T-HAVE(有键位) | findings 按**站点**键 → 注入 explore(非 adapter 键、非 replay 前);`adapter-health-store.ts` 已按 `${site}/${name}` 键,是挂笔记的现成槽,但现为遥测非 agent 笔记 |
| ⑪ 冷读者自测 | **✅ 已落地(2026-07-03,offline;真机待验)** | `consumer-test.ts`:read adapter verify 通过后,把 name/site/description/args **单独**喂一次冷读 LLM(无探索上下文),判"仅凭说明能否正确调用",不清就进 verify warnings → agent 据此补 description。fail-open + 超时兜底 + `CONSUMER_TEST_ENABLED` 开关。详见 §3 |
| ⑫ 两层 skill + 版本握手 | **✅ 已落地(2026-07-03,submodule)** | `GET /guide`(实时状态+指令+版本握手)+ SKILL.md 由 146 行**精简成 89 行真薄壳**(砍静态工具清单/常见任务,全指向 /guide + /tools)。留后:MCP get-skills 版本化拉取。详见 §3 |
| ⑬ description 触发词工程 | **PARTIAL(语料 290 条)** | `find_adapters` 已匹配 description+site+name+domain;但 290 adapter 仅 ~27 含别名模式,中↔英发现弱。**description 在 index.json 不在 adapter .js → 改它不需轮换 sha256**(比常规 adapter 改动便宜) |
| ⑭ extract 一命令 | **多半 HAVE(比文档便宜)** | `get_page_text` 已 URL→innerText→后台 tab→自动关(一发);runtime 已有 `htmlToMarkdown`。⑭ 缩为:给它加 markdown 选项 / bridge 薄封装 + 可选落盘 |
| ⑮ 资源 desc 语义记忆 | DON'T-HAVE | — |
| ⑯ 目录/README 打法 | DON'T-HAVE(纯文档) | — |
| ⑰ `*` 增量标记 | DON'T-HAVE | = 我方 D2-lite;get_interactives 按 tab 记上次 ref 集 + `new` 标即最小实现 |

**审计增值(改变成本估算的底座发现)**:①(network-recorder CDP 管线)、③(HumanTakeoverReq
H9-P1 已定义)、⑨(verify 已算定量信号)、⑩(health-store 已按 adapter 键)、⑪(spawn_subagent
已在)、⑭(get_page_text + htmlToMarkdown 已在)——这六项都**有现成底座**,实际成本低于文档初估。

### 4.2 与第三波路线的收敛(独立设计撞车 = 强信号)

| 我的第三波路线 | 对应文档项 | 采谁 |
| -------------- | ---------- | ---- |
| capture-bridge (F-10) | ① 离线捕获 | 采文档(它更完整:HAR+断网+防重发协议) |
| D2-lite 变化观测 | ⑰ 增量标记 | 一致;采它的便宜首阶(`new` 标) |
| 登录墙检测 + H9 | ③ 移交-续跑 | 采文档(它是完整移交协议,不止检测) |
| explore 预算/分档 | ⑧ 失败纪律 | 重叠(效率纪律) |
| **iframe ref 语义** | (无对应) | **我方独有**——它 DOM 模型不同,不覆盖这块;最后一个 Tier-A 感知盲区 |

我独立排的第三波,和一个在售商业产品的方法论,在 4/5 项上撞车——这是"下一步该做什么"最强的验证信号。

### 4.3 提议优先级(待用户拍板)

- **旗舰 ①(离线捕获 capture_submission)** = F-29 的**建设性**答案。当前 `detectVriteIntent`
  只堵不疏(`detectWriteIntent`,agent 根本无法探索写任务=整类写 adapter 的硬顶);离线捕获让 agent"真做一遍但
  请求发不出去",零副作用 + 采到合成写 adapter 所需的 POST/PUT 结构,并解锁 Tier-C 写测的
  无副作用验证。底座已在(network-recorder),需 reload 验(chrome.debugger 走后台,eval_js
  注不进)——用户已醒可 reload,不再受限。**单项类别解锁,列第一。**
- **便宜复利簇 ⑦⑨⑧⑤ + ⑪** = 纯 prompt/oracle/lint 改动,离线单测 + bridge 可验;⑨ 复用
  现成定量信号近乎免费,⑦(列表未验翻页=不过)堵最常见失败型,⑪ 用现成 spawn_subagent
  补"说明不自足"这个环内 verify 结构上测不到的洞。低成本、可叠加、直接抬合成质量。
- **快赢 ⑰ + ⑭** = D2-lite `new` 标 + extract-markdown,都有底座、bridge 可验、小时级。
- **分发/安全簇 ⑬⑫②③④** = 中价中本,按需推进(⑬ 语料 290 条改 index.json 不轮 sha256)。
- **iframe ref 语义(我方独有)** = 最后一个 Tier-A 感知盲区,独立于本文档,工程量最大。
