# 经典 Chrome 扩展 vs web-agent — 能力盘点与方向

> 目的:把市面上流行/经典的扩展逐个对照「聊天能不能直接做 / 能不能探索合成 adapter / 需要什么平台能力」,
> 从覆盖图里找**缺口和方向**。结论在 §3。

## 1. 评判框架(四桶)

- **A 聊天即得**:现成 generic 工具 / bridge 一次调用就够(页面 JS、HTTP、CDP 已封装)。一次性、当场跑。
- **B 探索合成 adapter**:某站确定性抽取/操作,可复用(explore→synthesize 的主场)。
- **C1 常驻注入**:要「每次访问自动改页面」——一条 registered content script(CSS/JS)。→ **[[site-scripts-design]]** 那个原语。
- **C2 扩展 API 特性**:要 `chrome.*`(截屏/下载/cookies/tts/discard/alarms…),手写在 generic/平台层;有的权限已具备。
- **C3 网络层 / 需新权限**:`declarativeNetRequest` 拦请求 —— manifest 没有,单列。
- **C4 不该做**:安全红线(密码库/凭据填充)。

我们已有的地基:generic 工具(open_url/get_page_text[markdown]/get_html/get_interactives/screenshot[full_page]/
click/type/scroll/wait_for_selector/network 读/find_structured_data/eval_js…)· adapter 合成 · workflows/shortcuts/
memory · **schedules(alarms,H3)** · await_user_action · 权限含 `downloads/cookies/bookmarks/readingList/tabGroups/
scripting/alarms`,**没有** `declarativeNetRequest`。

## 2. 盘点表

| 扩展(类别) | 它做什么 | 桶 | 现状 / 缺口 |
| --- | --- | --- | --- |
| **GoFullPage** 截长图 | 整页截图 | **A ✅ 已实现** | `screenshot full_page`(CDP clip+分段拼接,F-36);比它更干净 |
| Awesome/Nimbus 截图 | 截图+标注+录屏 | A(截)/ C2(录) | 截 ✅;标注=UI;录屏=`tabCapture` 需加,重 |
| **Loom** 录屏 | 录屏+托管 | C2 ❌ | 要 `tabCapture`/媒体管线,重平台特性 |
| **Web Scraper / Data Miner / Instant Data Scraper** | 点选抓列表/翻页 | **B ✅✅ 核心主场** | explore→synthesize 就是它,且产出确定性+可复用,**更强** |
| Table Capture | 抓表格 | A/B ✅ | `find_structured_data` / adapter |
| SelectorGadget | 找 CSS 选择器 | — ✅ | 本就是 explore 内部机制 |
| **iMacros / Automa / UI.Vision** RPA | 录制+回放宏 | **B ✅✅ 核心主场** | explore 录 trace→合成→回放 + workflows 串联,**本质是更聪明的 Automa** |
| **Evernote/Notion Web Clipper** | 剪藏页面→笔记 | **A+B ✅✅ 甜点** | `get_page_text markdown` + Notion adapter/MCP;聊天「剪藏到 Notion」 |
| Pocket / Instapaper 稍后读 | 存 URL+抽正文 | A ✅ | `readingList` 权限 + markdown 抽取 |
| Raindrop / 书签类 | 存书签+元数据 | A ✅ | `bookmarks` 权限 + 抽标题/图 |
| **Honey / Keepa / Camelizer** 比价 | 读价+**长期追踪**+优惠码 | A+B+**schedule** ✅ 强 | 读价=adapter;追踪=**schedules(已有)**;自动填码=写自动化 → 组合即得 |
| Distill.io 网页变更监控 | 定时抓+diff+通知 | B+**schedule** ✅ 强 | adapter 抓 + schedule 定时 + notifications;**已有零件,缺封装** |
| **Dark Reader** 全站暗色 | 常驻注 CSS(invert/滤镜) | **C1** | 正是 site-scripts:常驻 CSS `filter:invert`,一条规则搞定 |
| **uBlock Origin / AdBlock** | **网络层**拦广告请求 | **C3 ❌** | 要 `declarativeNetRequest`;cosmetic 隐藏可走 C1,但真拦截缺 |
| I don't care about cookies / Consent-O-Matic | 自动关 cookie 同意弹窗 | A(当场)/ C1(常驻) | 当场 `click_by_text` ✅;常驻自动 = site-scripts |
| **Immersive Translate / 沉浸式翻译** | 页面**双语常驻**翻译 | A(当场)/ C1(常驻) | 当场整页翻 ✅;悬浮/双语常驻注入 = site-scripts(CSS+JS) |
| Grammarly 语法 | **实时**行内批改+浮层 | C1+引擎 ⚠️ | 选中文本当场查 ✅;实时行内浮层=常驻注入+引擎,重 |
| SponsorBlock | 跳赞助段(社区库+实时控播) | C1+外部库 ⚠️ | 常驻 JS 可控播;缺社区时间轴库(可 crowd/自动检测) |
| Return YouTube Dislike / Enhancer for YouTube | 注入数据/UI 微调 | C1 | 常驻 JS 注入(+ API)= site-scripts |
| Reader View / Mercury | 清爽阅读视图 | A(当场)/ C1(常驻) | 当场 markdown ✅;常驻美化=注入 |
| Video DownloadHelper | 找+下媒体 | A/B ✅ | `find_in_network` 找流 + `downloads` 权限(下自己的内容) |
| OneTab / Toby 标签管理 | 存/组织标签会话 | A/C2 ✅ | `list_tabs` + `tabGroups` + 存 memory/workflow |
| The Great Suspender | 挂起省内存 | C2(小) | `tabs.discard` 需加;小特性 |
| Cookie AutoDelete | 按站清 cookie | C2 ✅ | `cookies` 权限已有 |
| Wappalyzer 技术栈 | 识别站点技术 | A/B ✅ | `get_html`+network+LLM 判断 |
| Lighthouse 性能审计 | 跑性能/最佳实践 | C2(部分) | CDP `Performance`/`Audits` 域可做基础版 |
| eye dropper / ColorZilla 取色 | 屏幕取色 | A(部分) | 截图后按坐标读像素;或 `EyeDropper` API |
| WhatFont 识别字体 | 看元素字体 | A ✅ | `eval_js getComputedStyle` |
| **LastPass / 1Password / Bitwarden** 密码库 | 凭据库+自动填 | **C4 🚫 红线** | 输入凭据/管密码是禁区(安全规则),不做 |
| Privacy Badger / Ghostery 反追踪 | 网络层拦 tracker | C3 ❌ | 同 uBlock,要 DNR |

## 3. 综合:强在哪 / 缺什么 / 往哪走

### 3.1 已经很强(甚至更优)的两大类
- **抓取 / 数据提取**(Web Scraper、Data Miner、Table Capture):explore→synthesize 是它们的超集——LLM 驱动 +
  **确定性可复用产物** + 翻页硬校验(⑦)+ 契约(⑨)。这类基本「聊天即得或一次探索即得」。
- **自动化 / RPA**(Automa、iMacros、UI.Vision):录 trace→合成→回放 + workflows/shortcuts/schedules。**我们本质是更聪明的 Automa**。
- 外加**一次性 capture/read/clip**(GoFullPage✅、Reader、Web Clipper):generic 工具直给。

→ 这三类占了「效率类」扩展的大头,而且我们的形态(对话 + 确定性产物 + 可存工作流)往往**比原扩展更好用**。

### 3.2 反复出现的**头号缺口:常驻页面改造(C1)**
Dark Reader、cosmetic 去广告、沉浸式翻译(常驻)、Consent-O-Matic、SponsorBlock、YouTube 增强、Reader 常驻美化……
**它们全是同一个原语:一条 per-site 的 registered content script(CSS/JS)。** 也就是说 [[site-scripts-design]]
**不只是「去广告」——它是解锁一整类最流行扩展的那块缺失积木。** 这把「要不要做 site-scripts」从「加个去广告」
重估为「**补上唯一缺的常驻注入原语,一次吃下 Dark Reader 类 + cosmetic adblock + 常驻翻译 + cookie 自动关 + 站点微调**」。
→ **方向一(高杠杆):做 site-scripts 原语**,去广告只是它的首个用例。

### 3.3 便宜的组合缺口:**监控 / 定时(schedule × adapter)** — ⛔ 评估后不做(2026-07-05)
Keepa 比价追踪、Distill 网页变更监控 —— 零件全有(adapter 抓 + `schedules` 定时 + `notifications` 通知 + memory 存基线),
缺的只是**一层封装**:「盯 X 的 Y 字段,变了通知我」。
→ 曾按此实现过「监控」封装 = adapter + schedule + diff + notify(MVP `change/drop/rise` + 阈值 `below/above`,
  提交 `b7b0c23`/`6261204`),但**真机联调反复受阻(扩展 reload 拿不到新 bundle)、感知价值有限**,经用户决定**整体移除**
  (revert 两个提交,working-tree 未再提交)。**`schedules`(计划任务)本身保留**——监控只是借它的 `Cadence`/`alarmInfo`。
  若日后重启:零件都还在,监控仍是那层薄封装。

### 3.4 真缺口:**网络层拦截(C3)**
uBlock / Ghostery 的核心是拦请求,要 `declarativeNetRequest`(manifest 没有)。cosmetic 隐藏(C1)能盖一部分体验,
但**省流量/反追踪拦不了**。→ **方向三(需决策)**:是否加 DNR 权限做真拦截——权限面变大、审查更严,单独评估,不在近期。

### 3.5 明确不做
- **密码库/凭据填充**(LastPass 类):安全红线(C4)。
- **重媒体管线**(Loom 录屏):`tabCapture`+编码,投入产出比低。

### 3.6 一句话方向
> 我们在**「抓取 + 自动化 + 一次性 capture」**上已经追平甚至反超经典扩展;**最大的、且高杠杆的缺口是「常驻页面注入」**
> —— site-scripts 一个原语解锁 Dark Reader / cosmetic 去广告 / 常驻翻译 / cookie 自动关 一大片。其次是用现成 schedule
> 零件封个「监控」。网络层拦截和录屏/密码库,分别因权限成本和安全红线,近期不追。

---

关联:[[site-scripts-design]](常驻注入原语的具体设计)· [[roadmap]](若有,把方向一/二排期)。
