# E2E 任务测试(agent 真实场景)

> 这是 [adapters.md](./adapters.md)(单 adapter"单元测")之上的一层:**给定一个任务,
> agent 能否正确制定计划、选对工具、正确串行/并行、出错时自行调整、最终给出靠谱结果**。
> 这才是真实使用场景。逐个跑,结果回填本文件;问题记入 [findings.md](./findings.md)(F-N)。

**Progress**: ☐ 0 / ✅ 22 / ❌ 0 / ⚠️ 1 _(✅ 全部跑完;写缺口已补:E-21 经自建 `zhihu__unlike`、E-22 经 `bilibili__collect` 闭环 · ⚠️ = E-17 browser:false 宿主 tab,已查清=MV3 eval venue 必然产物、by-design 非 bug)_

---

## 1. 怎么测

- **入口**:面板(SidePanel)对话框直接粘贴提示词——测的是完整 agent loop(计划、并行预跑、
  子代理、tab 池、reaper)。个别任务可用 bridge 对照(标注了的才用)。
- **每个任务记录**:结果列(✅ 通过 / ❌ 失败 / ⚠️ 部分通过)+ 一句话结论。失败的在
  findings.md 立 F-N(症状/根因/修法/教训),adapter 源问题另记 adapter-hot-plug §10.x。
- **顺序**:A→I 由浅入深;前面失败的根因不解决,后面大概率连锁失败。
- **写操作(Tier I)**:逐个、可逆、确认后执行,绝不批量(README §6 政策)。

## 2. 评估维度(每个任务都看这五条)

1. **计划**:分解合理、粒度恰当(不漏步、不过度规划)、与最终执行一致。
2. **工具选择**:优先站点 adapter 而非 generic 硬抓;参数名/值来自 schema 和上一步结果
   (不是编造);不踩 node-only / 已知废弃工具。
3. **编排**:无依赖的读**并行**(主循环并行预跑,≤5);有依赖的**串行**且数据正确传递;
   同站多任务走 tab 池;无重复/多余调用。
4. **韧性**:失败 → 诊断 → 调整(换参数/换工具/换站点)或诚实报告;不无限重试、不伪造结果
   (truthful reporting:done/failed/skipped 分明)。
5. **结果质量 + 资源卫生**:答案完整准确、附来源链接;任务结束后 agent 开的 tab 被 reaper
   自动回收(不动用户自己的 tab)。

## 3. 并行/回收的判读方法

- **并行**:面板时间线里同一批步骤**几乎同时开始/完成**(折叠时间戳相同);`同站并行`时
  Chrome 里出现同站多个 tab(≤5);对照:总耗时应明显小于逐个串行之和(参考:zhihu ×3
  串行 32s → 池化并行 12s)。
- **Reaper(顺带验证 F-3)**:任务结束后几秒内,**agent 开的** tab 自动关闭;**用户自己开的**
  tab 不动。E-7 是主要验证场景。
- **SW 稳定**:长任务全程无"连接断开/重启"(F-8 已修,长任务是它的回归测试)。

## 4. 已知坑(测前先知道)

- `youtube__transcript` 60s 超时未修(F-10,capture-bridge 架构项)——任务别依赖它。
- `gemini__deep-research-result` F-21 已修待复测,且会**导出 Google Doc(写型副作用)**。
- chatgpt 冷开 tab 慢:tab-load 预算已 30s→45s,需 reload 后生效。
- `xiaohongshu` 详情类要**完整带 xsec_token 的 url**(F-14);`weread-official` node-only(F-7)。

---

## Tier A 冒烟(单工具,确认链路通)

#### E-1 HN 头条

- 提示词:`看下 Hacker News 现在的头条前 5 是什么`
- 预期工具:`hackernews__top`(单调用,pipeline,无 tab)
- 通过标准:5 条标题+链接;**只调一个工具**,无多余步骤/无开 tab。
- 结果:✅ 通过 — 单调用 `hackernews__top {limit:5}` 返回 5 条(标题+url+id/by/score),未开 tab(tabs 5→5,前后快照字节一致)。注:bridge 路径,编排/reaper 维度本任务 N/A。

#### E-2 维基摘要

- 提示词:`用维基百科查一下 Alan Turing 是谁,两句话总结`
- 预期工具:`wikipedia__summary`(browser:false func,走 SW fetch 代理)
- 通过标准:准确摘要;不去开 wikipedia 页面硬抓。F-4/F-5 修复的 agent 场景回归。
- 结果:✅ 通过 — 适配器未安装→`find_adapters`→**临时 `load_adapter` wikipedia__summary**(未安装/SW 重启失效)→SW-fetch 取回准确 2 句摘要+来源,未硬抓页面。期间出现的 `www.wikipedia.org` 标签经核为**用户自有**(`controlled:false`/`active:true`),非 adapter 所开;二次调用(Ada Lovelace)不开 tab/不导航。F-4/F-5 回归 OK。**⚠️ E-17 更正**:browser:false func 实会开**宿主 tab**,故此处 `www.wikipedia.org` 很可能是 `wikipedia__summary` 的宿主 tab(**非用户自有**);"二次调用不导航"与"宿主 tab 复用、停在站点 base"同样自洽,当时归因有误。摘要结论不变,仅 tab 归因更正。(`controlled` 字段对 adapter 宿主/取数 tab 均为 false,不可靠——见 findings.md。)

## Tier B 串行依赖(list→detail,数据要从上一步取)

#### E-3 知乎搜→问→答

- 提示词:`知乎上搜"睡眠质量改善",挑最热的一个问题,把高赞回答的要点总结给我`
- 预期工具:`zhihu__search` → `zhihu__question`(id 来自搜索结果)→ 需要时 `zhihu__answer-detail`
- 通过标准:链路 id 全部来自上一步返回(不是编造);总结贴合实际回答内容。
- 观察点:F-1 修复回归(search type 行为);串行依赖不该被错误并行。
- 结果:✅ 通过 — `zhihu__search{type:question}`(F-1 OK,返回真问题)→ 按 votes 选最热 q19575624(2053赞「睡眠非常浅…」)→ `zhihu__question{sort:default}`(答案 content 截断 200 字)→ 对最高赞 A4(OwlLite,289)`zhihu__answer-detail{max-content:0}` 取全文,要点忠于原文+附链接;id/url 全部来自上一步(无编造),严格串行未误并行。**行为发现**:zhihu 走**浏览器 tab 取数**(navigate 复用单 tab,空闲时 `controlled=False` → 该字段无法标识 zhihu 取数 tab);bridge 无 reaper,遗留 tab 由我手动关闭(对照 wikipedia/HN 为纯 SW-fetch 不开 tab)。reaper 真验留 E-7。

#### E-4 B 站搜→详情+AI 总结(混合编排)

- 提示词:`B站搜一个讲《置身事内》这本书的视频,告诉我视频信息和官方AI总结`
- 预期工具:`bilibili__search` → **并行** `bilibili__video` + `bilibili__summary`(同一 bvid 的两个独立读)
- 通过标准:第二阶段两个读并行(时间线同批);bvid 取自搜索结果。
- 结果:✅ 通过 — `bilibili__search{type:video}` 选定 BV1Y9wbzdEFw(score 14.9w「深度拆解置身事内」)→ **并行** `bilibili__video`+`bilibili__summary`(并发 curl,wall **11.69s ≈ max(11.66, 2.23) 非 sum 13.9** → 证实两读真重叠)。bvid 取自搜索 url(无编造);视频信息(播放14.9w/赞3988/币1482/藏4766,11m52s,发布2026-03-14)+官方AI分段总结(大纲+时间戳)均完整。**卫生**:bilibili 走浏览器 tab 取数(开了 homepage + 视频页 2 个 tab,`controlled=False`),bridge 无 reaper → 我手动清理;用户自开的 HN tab 未动。

#### E-5 HN 头条评论分析

- 提示词:`看下 HN 排第一的帖子在讨论什么,把评论区的主要观点列出来`
- 预期工具:`hackernews__top` → `hackernews__read`(id 来自第一步)
- 通过标准:观点确实来自评论内容(抽查 2 条);id 传递正确。
- 结果:✅ 通过 — `hackernews__top{limit:1}` → #1 id 48478969(Anthropic Fable 护栏,201pts/184评)→ `hackernews__read{id,depth:2,limit:18}` 取 57 条顶层评论。归纳 5 类主要观点(静默降级/计费透明/误伤过度拦截/CPU降频类比/反方澄清);抽查 2 条(@daedrdev「silently…worse model without revealing」、@micah94「bioweapon…yellow dog vomit fungus」)与原评论一致;id 正确传递,严格串行。HN 纯 SW-fetch 无 tab(用户自开的 HN tab 未动)。

## Tier C 同站并行(tab 池 / 并行预跑)

#### E-6 HN 三条并行抓正文(无 tab 并行)

- 提示词:`把 HN 前 3 条的讨论都抓来,各用一句话概括`
- 预期工具:`hackernews__top` → **3× `hackernews__read` 并行**(browser:false,无 tab)
- 通过标准:3 个 read 在同一批(主循环并行预跑生效);概括各自对得上。
- 结果:✅ 通过 — `hackernews__top{limit:3}`(ids 48478969/48484584/48480978)→ **3× `hackernews__read` 并发**:wall **6.97s ≈ max(6.94) 非 sum 15.77s** → 同批并行成立。三条各一句话(Fable护栏静默降级争议 / AI agent 给 Fedora 提烂补丁的供应链担忧 / πFS 用 π 偏移"存"数据的信息论玩笑),均对得上评论原文。HN 纯 SW-fetch:3 个 read **零开 tab**(期间出现的 item 48449187 等 HN tab 系用户/SidePanel 自身活动、非我所开,未动 → 教训:按"我实际抓的 URL/id"归因 tab,勿靠计数或 `controlled`)。注:首次因测试脚本误用 zsh 不支持的 `mapfile` 失败→已 zsh-safe 重跑(工具链问题,非 adapter)。

#### E-7 知乎热榜 ×3 并行(tab 池 + reaper 主验证)

- 提示词:`知乎热榜前 3 个问题,每个看一下高赞回答,汇总成一段话给我`
- 预期工具:`zhihu__hot` → **3× `zhihu__question` 并行**(同站 tab 池,≤5 tab)
- 通过标准:① Chrome 出现多个 zhihu tab(并行);② 总耗时 ≪ 串行(参考 12s vs 32s);
  ③ **任务结束后这些 tab 自动关闭**(F-3 reaper 的真机复测!);④ 用户自己开着的 zhihu tab 不动。
- 结果:✅ 通过(bridge 验并行/tab池 + **SidePanel trace 验 reaper**)— `zhihu__hot` 未装→临时 `load_adapter`→热榜前3→ **3× `zhihu__question` 并发**。**bridge 路径**:①✅ 3 个 zhihu tab(逐 qid,≤5,tab 池成立);②✅ wall 24s≈max 非 sum 57s;④✅ 只关我开的 3 个、用户 tab 未动;③ reaper bridge 无法触发(无任务生命周期)→ 手动模拟回收。**SidePanel trace 复核**(用户导出 `s_mq8ubsj4_wgcheb`):agent 计划与 bridge 完全一致——`zhihu__hot`→**3× `zhihu__question` 同批**(三者 `started` ts 全 = 1781142639661 → 并行预跑坐实),wall≈max(26.5s) vs 串行 64.5s;**任务结束 tab 自动关闭(用户目视确认 + session status idle)→ ③ F-3 reaper 真机通过**。⇒ 结论:bridge 忠实复现 agent 的计划/并行/取数/质量,唯 reaper/tab 生命周期须走 SidePanel(本条已补验)。**小注**:`sort:default`+`limit:3` 非严格按票数排序、且随时间变动,真·最高赞可能落在默认前 3 之外——"看高赞"宜 `sort` 票数或加大 `limit`。

## Tier D 跨站并行 / 对比

#### E-8 HN vs lobsters 话题对比

- 提示词:`对比一下 "Rust" 在 Hacker News 和 lobsters 上最近讨论的热点有什么不同`
- 预期工具:`hackernews__search`(F-6 修复后 query 真生效)+ `lobsters__hot`/搜索 **并行**
- 通过标准:两站调用并行;对比有实质内容(各自要点+异同),不是两段无关罗列。
- 结果:✅ 通过 — 临时 load `hackernews__search` + `lobsters__tag{tag:rust}`,**并行**(wall 1.18s ≈ max,均 SW-fetch 零开 tab)。**韧性亮点**:HN 按 `date` 排出来多是非 Rust 帖 → 切开发者态用**控制查询** `query=PostgreSQL`(返回干净 Postgres 结果)确认 **query 生效、F-6 未回归**;根因是 **Algolia 容错把短词 "Rust" 模糊匹配到 must/Bust/TrustName**。改用 `relevance`(12/12 命中)+ 标题过滤,如实区分"最近真·Rust"(HN 仅 2-3 条:Xfce/Redox、OCaml→Rust)与"全站热点"(Discord Go→Rust 1582👍 等)。对比有实质:HN=偶发大新闻(迁移/生态戏剧/明星工具,评论上千)vs lobsters=日常硬核(分配器/unsafe/编译器后端,频繁专精);交集=Redox OS、OCaml→Rust 翻译。**用法教训**:`hackernews__search` 短词宜 `relevance` 或后过滤,`date` 排会被 Algolia typo 容错污染(非 adapter bug)。

#### E-9 一部电影三路并行

- 提示词:`电影《肖申克的救赎》:豆瓣的评分和简介、维基百科条目摘要、再去 YouTube 找个预告片链接,汇总给我`
- 预期工具:**三路并行** `douban__subject(1292052 或先搜)` + `wikipedia__summary` + `youtube__search`
- 通过标准:三个不同站点并行(不同 site pool 互不阻塞);汇总结构清晰、链接可点。
- 观察点:douban subject 是 F-9 修复回归。
- 结果:✅ 通过 — 临时 load `douban__subject`;**三路并行** `douban__subject{1292052,movie}` + `wikipedia__summary` + `youtube__search{type:video}`,wall **21.46s ≈ max 非 sum 42.7s**(不同 site pool 不互阻)。**F-9 回归 OK**:douban 返回 肖申克 9.7分(329万评)/导演德拉邦特/142min/简介齐全。维基:1994 德拉邦特,改编自斯蒂芬·金中篇。YouTube:命中官方预告(Warner Bros,1:41)`watch?v=PLl99DlL6b4`。汇总结构清晰、链接可点。**卫生**:douban+youtube 走 tab(各开 1 个)、wikipedia SW-fetch;我手动回收 2 个 adapter tab。注:首次清理因 zsh 不 word-split `$ids`(同 mapfile 根因)只关了个空,逐个显式关后成功——属我的 bash 工具链,非 adapter。

#### E-10 微博热搜 × 知乎热榜重叠

- 提示词:`今天微博热搜和知乎热榜各看前 5,有没有重叠的话题?`
- 预期工具:`weibo__hot` + `zhihu__hot` **并行**
- 通过标准:并行;"重叠"判断讲道理(同事件不同措辞应能对上)。
- 结果:✅ 通过 — `weibo__hot` + `zhihu__hot`(E-7 临时 load 仍在)**并行**(wall 14.59s ≈ max(14.56))。微博前5(广西爆炸/王楚钦国乒/丝路逐光/杨幂带货/旅游城市)vs 知乎前5(美CPI/世界杯版权/铁拳教育/高考迟到/Loop工程)。**重叠判断有理**:前5 无同一事件直接重叠,最接近的"体育"大类也是乒乓 vs 世界杯版权(不同事件);进一步指出两榜调性差异(微博=即时/社会/娱乐"发生了什么";知乎=深度/议题"怎么看待")。**卫生**:weibo+zhihu 各开 1 个 homepage tab,用 `${=ids}` 显式 split 后逐个回收(修正前述 zsh word-split 坑)。

## Tier E 容错与自我调整(故意为难)

#### E-11 不存在的 ID(诚实失败)

- 提示词:`看下知乎问题 99999999999999 说了什么`
- 预期行为:调用失败后**如实报告**(问题不存在/获取失败),可建议搜索;**不得**编造内容、
  不得无限重试。
- 通过标准:0 伪造;重试 ≤1 次;给出下一步建议。
- 结果:✅ 通过 — `zhihu__question{id:99999999999999}` 返回 `{ok:false, error:"Failed to fetch question data"}`。**0 伪造**(adapter 正确失败、未编内容);**0 重试**(ID 明显非法,重试同果——优于盲目重试);如实报告"问题不存在/获取失败" + 给下一步(用 `zhihu__search` 按关键词找真问题 / 核对 ID)。卫生:失败仍开了 1 个 zhihu tab,已回收。**小瑕疵**:错误类型标 `AuthRequiredError` 误导(实为不存在/抓取失败,非鉴权;已登录)——adapter 错误归类可改进,但不影响"诚实失败"判定。

#### E-12 未登录站点(识别 + 说明/换路)

- 提示词:`帮我看下 Instagram 上 nasa 的最新帖子`
- 预期行为:撞登录墙(instagram 未登录)→ 明确告知需登录;若主动换可达来源
  (如 x/bluesky 的 NASA 官号)需**说明这是替代方案**。
- 通过标准:不伪造;登录墙诊断正确;替代方案(若有)有标注。
- 结果:✅ 通过(分两段验证)—— ① **字面任务**:`instagram__user{nasa}` **登录态/登出态都返回真实帖子**(NASA 公开号,IG 对登出用户也放出最近帖;用户登出后复跑数据仍刷新 👍166006→166115,证非缓存)→ Artemis II 宇航员公布、Webb/Chandra 成像、梅西耶64 等。② **登录墙复测**(用户登出 IG 后):`instagram__saved`(读自己收藏,**必须登录**)→ `SyntaxError: Unexpected token '<', "<!DOCTYPE"`,且 adapter 开的 tab 停在 `instagram.com` 登录页 → **确系登录墙**(IG 返回登录 HTML、adapter 拿去 JSON.parse)。agent **正确诊断"需登录"、0 伪造**;收藏类无替代源(你自己的数据),公开号则有 Bluesky/X 备选(已说明)。**发现 F-22**:IG 登录墙报错隐晦(JSON 解析错而非干净 auth 错;`<!DOCTYPE` 即墙的信号)。tab 已回收。

#### E-13 不可用工具陷阱(node-only)

- 提示词:`用 weread-official 搜《三体》`
- 预期行为:发现 weread-official 不可用(F-7 node-only,现已优雅失败)→ **改用 `weread__search`**
  并说明原因;或如实解释为何无法照办。
- 通过标准:不硬撞多次;调整路径正确。
- 结果:✅ 通过 — 按要求先试 `weread-official__search`:① arg 名错(传 `query`,schema 要 `keyword`)→ 报错清晰即改对;② 改对后 `AuthRequiredError: WEREAD_API_KEY is not set` → **确认 node-only**(F-7,需服务端 key、浏览器无;F-19 后优雅失败不再 crash)。**正确换用 `weread__search{query:三体}`** → 5 本(三体全集/刘慈欣 正版 bookId 695233 + 同人若干)。未反复硬撞 official、路径切换正确并说明原因;weread tab 已回收。**小注**:两个 weread adapter arg 名不一致(official=`keyword`,weread=`query`),易绊 agent。

#### E-14 模糊任务(澄清或显式假设)

- 提示词:`帮我研究一下那个很火的 AI 模型`
- 预期行为:要么**反问澄清**(哪个模型?),要么**明确陈述假设**("我假设你指 X,因为…")再做。
- 通过标准:不在未澄清时盲目跑一堆站点;假设(若有)写在结论开头。
- 结果:✅ 通过(走"明确陈述假设"分支)— 识别出"那个很火的 AI 模型"有歧义,**未盲目跑站**;把假设**置顶**(=Fable,Anthropic 最新模型,理由:当天 HN 头条第一、护栏争议,本会话 E-1/E-5 已抓到),基于已有上下文给出聚焦速览(静默降级/误伤),并邀请用户确认或改指别的模型(GPT/Gemini/…)再展开。无 tool 调用、无 tab。

## Tier F 工具选择正确性

#### E-15 generic 工具的本分

- 提示词:`打开 https://example.com 看看页面上写了什么`
- 预期工具:`generic__open_url` + `generic__get_page_text`(没有站点 adapter 适用)
- 通过标准:不套用无关站点 adapter;结束后 reaper 收 tab。
- 结果:✅ 通过 — `generic__open_url{example.com}`(tabId 102644586)→ `generic__get_text_from_tab` 取到"Example Domain … for use in documentation examples …"(IANA 占位页,措辞为更新后新版)→ 主动 `close_tab` 回收(bridge 无 reaper,手动模拟)。未套用任何无关站点 adapter,工具选择正确。

#### E-16 adapter 优先于硬抓

- 提示词:`v2ex 上 python 节点最近有什么话题`
- 预期工具:`v2ex__node {name:"python"}`(F-6 修复后可用)
- 通过标准:用结构化 adapter,**不是** open_url+get_page_text 硬抓页面。
- 结果:✅ 通过 — 临时 load `v2ex__node{name:python,limit:10}` 返回 10 条结构化话题(rank/title/author/replies/url),**F-6 回归 OK**(node name 参数生效、非 paramless 404)。用结构化 adapter、**未** generic 硬抓;v2ex API 走 SW-fetch、**0 tab**。内容:python 节点近期偏 AI/LLM(AI 网课/文本拟人化/RAG/CodexSaver/AI 爬虫提效)+ Python 项目(复刻红警2/张量语言/缠论代码)。

#### E-17 纯 API 工具(不开页面)

- 提示词:`把 arxiv 论文 1706.03762 的标题、作者和摘要给我`
- 预期工具:`arxiv__paper`(browser:false,SW fetch)
- 通过标准:不去开 arxiv.org 页面;摘要正确(Attention Is All You Need)。
- 结果:⚠️ 部分 — 临时 load `arxiv__paper{id:1706.03762}` 返回**完全正确**的标题(Attention Is All You Need)/8 位作者/2017-06-12/Transformer 摘要(走 arxiv API,**非硬抓页面**)→ 工具选择+数据 ✅。**但"不开页面"未达成**:实测 `browser:false` func **会开一个 `arxiv.org` 宿主 tab**(func 必须在某页面的 userScripts world 执行,只有 data-fetch 被 SW 代理);关掉再取另一篇(BERT)宿主 tab 重现 → 坐实。该宿主 tab 真机 SidePanel 由 reaper 收、bridge 上残留(已手动收)。**更正模型**:adapter 取数其实**三类**——pipeline(HN/lobsters,真不开 tab)/ browser:false func(wikipedia/arxiv,**开宿主 tab**、data SW 代理)/ browser:true func(zhihu/bilibili…,导航 tab)。⇒ E-2 把 `www.wikipedia.org` 门户 tab 判为"用户自有"很可能有误(应是 `wikipedia__summary` 的宿主 tab)。 **【SW 调查结论 2026-06-11】** 试过让 browser:false func 改在 SW 跑以去掉宿主 tab——**走不通**:func 是 JS 闭包,要 `eval`(`new Function`)才能跑,而 **MV3 SW 禁 eval**(CSP);eval venue 只能是 http 页面的 `userScripts` world(`chrome.userScripts` 只能注入 http/https、不能 about:blank/SW)→ **宿主 tab 是 MV3 eval venue 的必然产物,非 adapter/数据问题**(func 只用已 SW 代理的 fetch、不碰 page/DOM)。唯一能去掉可见 tab 的是 **offscreen sandbox iframe**(扩展已有,供 install/load),但它**故意丢闭包**(安全边界),要用它跑 func 得把 sandbox-host 改成 eval+invoke+回传 + 给 sandbox fetch 架 →offscreen→SW 代理 + 处理并发——**实打实的功能改动,留作未来项**。⇒ **E-17 判定:by-design、根因已查清,非 bug**;保留 ⚠️ 仅表"不开页面"字面未达成(真机 reaper 自动收、用户无感,仅 bridge 残留)。

## Tier G 长程综合(多阶段 + 综合质量)

#### E-18 小型调研报告(多站并行 + 深读 + 综述)

- 提示词:`调研一下"AI agent 浏览器自动化"当前的讨论热点:HN、reddit 的 r/programming、X 上各看一圈,给我一页综述:分来源列要点,最后总结共识与分歧`
- 预期编排:三站搜索**并行** → 挑 2-3 条深读(并行)→ 综合输出
- 通过标准:阶段清晰;并行批次合理;综述区分"来源说了什么"和"你的归纳";链接齐全。
- 观察点:这是最接近真实使用的任务;关注中途有无 SW 断连(F-8 回归)、结束后 tab 回收。
- 结果:✅ 通过 — **阶段清晰**:① 三站**并行**搜索(`hackernews__search` relevance + `reddit__search{subreddit:programming}` + `twitter__search`;wall 45s ≈ max,**F-8 无断连**);② **深读** HN Skyvern(id 41936745,327👍/74评)+ reddit Atlas/ARIA 帖(selftext 2258 字);③ 综述分来源列要点 + **共识/分歧分开写 + 链接齐全**。**韧性亮点**:twitter 冷开 `tab-load timeout`(45s)→ 走 **adopt 路径**(先 `open_url x.com` 预热→retry `twitter__search` 27s 成功)。**卫生**:关掉明确属我的(3× x.com + 1 个裸 `news.ycombinator.com` 宿主 tab);**留下 1 个 `www.reddit.com`**——与用户自有的同 URL 无法区分,保守不动(真机 reaper 靠自身簿记可分,bridge 不能)。内容真实(Skyvern/Atlas-ARIA/Obscura/usekernel×Anthropic)。

#### E-19 个人数据汇总(登录态 + 分页)

- 提示词:`看看我知乎收藏夹里都收藏了什么,主要是哪些主题?`
- 预期工具:`zhihu__collections` → `zhihu__collection`(逐夹,必要时分页)
- 通过标准:遍历了真实收藏(抽查 2 条);主题归纳合理;不泄漏到回答之外的多余内容。
- 结果:✅ 通过(**F-23 修复后复测**)— 临时 load `zhihu__collections`/`collection`,列出 **7 夹**(主夹「我的收藏」40 + 「收藏」6 + 5 个单条夹)。首测撞 **F-23**:`zhihu__collection` 遇收藏里的**知乎视频 zvideo** 直接抛错,主夹 p2 + 「收藏」夹整页取不到(仅 20/51)。**切开发者态修了 F-23**(`zhihu/collection.js` 加 zvideo 分支 + 未知/畸形类型 `return null` 跳过;轮换 sha 1.0.0→1.1.0,推 marketplace `2bbe51a`)→ SW 重启后重新 `load_adapter` 复测:**p2 ✅ 18 条(含 zvideo「英语音标示范」)、「收藏」✅ 6 条(含 zvideo「耳鸣缓解小技巧」)** → 全遍历通了。完整主题:**AI/工具(最突出:Nano Banana/Midjourney/VSCode/AI绘画)、读书书单、健康养生、摄影绘画、时政历史、认知心态**;抽查多条属实;尊重个人数据只给主题、tab 已回收。详见 adapter-hot-plug §10.31。

## Tier H 记忆

#### E-20 保存偏好 + 跨会话生效

- 步骤:① 对 agent 说 `记住:我偏好简洁的中文回答,要点用列表`;② **新开会话**问
  `我让你记住的偏好是什么?照着它回答我:什么是 MV3?`
- 通过标准:偏好被保存(记忆页可见);新会话能取回并**实际照做**(简洁+列表)。
- 结果:✅ 通过(SidePanel trace `s_mq93t0bq` + bridge `list_memories` 双验)— ① **偏好存住**:`list_memories` 列出 3 条记忆,第 3 条正是「用户偏好简洁的中文回答,要点用列表呈现」(step-1 保存成功);② **新会话取回**:新 session(iterations:0)的 trace 显示 agent 从**注入的系统提示**读到该记忆(被动召回,reasoning 明说"不需要调用任何工具"),与 list_memories 完全一致;③ **实际照做**:答「什么是 MV3」用**中文+列表**(定义/核心变化/动机/影响;SW 取代背景页、远程代码禁令、DNR、Promise 化——准确无编造),并融合其它记忆(因果链条/理论联系实际)。**机制**:长期记忆经**系统提示注入**实现跨会话,不靠 active list 调用(bridge 测不到这半,靠 trace + list_memories 旁证,同 E-7 套路)。小瑕疵:agent 复述偏好把 LLM 误写"LLV"(仅输出笔误,记忆正确)。

## Tier I 写操作编排(明天、逐个、可逆、需确认)⚠️

> 政策:一次一个;先确认再执行;只做**有撤销对**的;破坏性(delete/post 公开内容)默认跳过。
> 同时观察:**写操作是否被并行预跑正确排除**(write 永远串行)+ 面板是否要求确认。

#### E-21 知乎点赞对(like → unlike)

- 提示词:`给知乎回答 3327505767 点个赞,完成后告诉我,然后取消这个赞`
- 预期工具:`zhihu__like`(两次,先 like 后 unlike;**串行**,各自确认)
- 通过标准:两步都有真实效果(可在网页核对);全程没有并行化写操作。
- 结果:✅ 通过(**自建 `zhihu__unlike` 后闭环**)— 原测:`zhihu__like{target:完整URL,execute}` 点赞生效(41→42,回答 by 之灮《补气血补肝肾》),但 **`zhihu__like` 幂等非 toggle、市场无 `zhihu__unlike`**(F-24),赞一度暂留。**切开发者态 author 了 `zhihu__unlike`**(`POST .../voters {type:neutral}`,镜像 like 的 type:up;`--execute` 闸),推 `815960b`。复测闭环:dry-run 拒写 → `zhihu__like`(41→42)→ `zhihu__unlike`(42→41),**净零**;authoritative GET 核验 voteup_count=41(注:`answer-detail` 一度读到 42 系其详情 API **缓存滞后**、非未生效)。**E-21 的赞已撤回**。韧性:首次裸 `/answer/id` 被拒(要完整 URL)→ 重试成功;写严格串行。详见 findings F-24 / adapter-hot-plug §10.33。

#### E-22 B 站收藏对(favorite → 取消)

- 提示词:`把 B 站视频 BV1xdEA6TEqY 收藏一下,确认成功后再取消收藏`
- 预期工具:`bilibili__favorite` 对
- 通过标准:同上;收藏夹状态前后一致(净零)。
- 结果:✅ 通过(**自建 adapter 后闭环**)— 首测:`bilibili__favorite` 实为 read(列收藏夹)、市场无收藏-写工具(F-25,未发生写入)。**切开发者态 author 了 `bilibili__collect`**(`/x/v3/fav/resource/deal`,add/remove 同工具,`--execute` 闸)+ 改正 favorite `access write→read`,推 marketplace `2d89245`。复测正是 E-22 任务:`collect{BV1xdEA6TEqY, add, execute}` → 进默认收藏夹(`bilibili__favorite` 核验置顶)→ `collect{remove, execute}` → 消失,**净零**;dry-run(无 execute)正确拒写;严格串行。详见 findings F-25 / adapter-hot-plug §10.32。

#### E-23 X 书签对(bookmark → unbookmark)

- 提示词:`在 X 上把 @AnthropicAI 最新一条推文加书签,然后再移除这个书签`
- 预期工具:`twitter__tweets {username:"AnthropicAI"}` → `twitter__bookmark` → `twitter__unbookmark`
- 通过标准:读到的 tweet-id 真实;书签加/删都生效;读并行无所谓,**写严格串行**。
- 结果:✅ 通过(唯一闭环的写测试)— `twitter__tweets{AnthropicAI}`(adopt 路径:先 warm x.com 0.8s→tweets 14s)取到最新推 `status/2064783418844762489`(「AI is advancing…」♥4454,真实非 pinned)→ **暂停确认**→ `twitter__bookmark{url}` ✅「Tweet successfully bookmarked」,`twitter__bookmarks` 核验该推已置顶 → **再暂停确认**→ `twitter__unbookmark{url}` ✅「removed from bookmarks」,再查目标已消失、回到原书签列表 → **净零**。bookmark/unbookmark 是**独立正反向写工具**(对比 E-21 zhihu 无 unlike、E-22 bilibili 无 favorite-写),故可逆对闭环;两次写**严格串行、各自确认**,无 `execute` 闸但靠「允许外部写操作」门控。

---

## 附录:写操作清单(明天的 adapter 级写测试)

按可逆性分组;政策同 README §6(逐个、确认、dry-run 优先、破坏性跳过)。

**可逆对(优先测,净零)**

- zhihu:`like`/unlike(同一工具反向)、`follow`/unfollow、`favorite`/取消
- bilibili:`favorite` 对、`comment`(对自己动态,测后删?B 站删评走页面——慎)
- twitter:`like`/`unlike`、`bookmark`/`unbookmark`、`follow`/`unfollow`、
  `retweet`/`unretweet`、`block`/`unblock`(用测试号对象!)、`list-add`/`list-remove`(自己的 list)
- youtube:`like`/`unlike`、`subscribe`/`unsubscribe`
- reddit:`upvote`(再点一次取消)、`save`/取消、`subscribe`/取消
- instagram(若登录):`like`/`unlike`、`save`/`unsave`、`follow`/`unfollow`、collection-create/delete 对
- tiktok(若登录):`like`/`unlike`、`save`/`unsave`

**内容创建(建议只在自己内容/测试内容上,opt-in)**

- zhihu `comment`/`answer`、bilibili `comment`、reddit `comment`/`reply`、twitter `reply-dm`、
  notebooklm `create`/`write-note`/`generate-*`、jimeng `generate`、gemini `ask`/`deep-research`、
  chatgpt/claude `ask`/`send`(对 AI 站:会产生会话记录,低风险)

**破坏性(默认 ⏭️,除非明确要求)**

- weibo `delete`、twitter `delete`、xiaohongshu `delete-note`、douyin `delete`、twitter `hide-reply`

**已知注意**:`twitter list-add/list-remove` 实为 write(F-16 已更正);`v2ex daily`(签到)是写;
`gemini deep-research-result` 名为读、实会导出创建 Google Doc(F-21)。**`zhihu like` 是幂等(非 toggle)且
市场无 `zhihu__unlike`——「同一工具反向」不成立,zhihu 可逆对暂不能用 adapter 闭环(F-24,待自建 unlike adapter)。**

---

## 维护

- 跑完一个任务就回填**结果列**(✅/❌/⚠️ + 一句话),更新顶部 Progress。
- 失败 → findings.md 立 F-N;是 adapter 源问题的走 marketplace 子模块流程并在
  adapter-hot-plug.md §10.x 留 post-mortem;是编排/平台问题的修 runtime。
- 新增任务往对应 Tier 追加(编号顺延);大场景变更(新站点/新能力)时补一节。
