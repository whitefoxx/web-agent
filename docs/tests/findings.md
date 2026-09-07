# 测试发现日志(问题 / 修法 / 经验)

> 真机测试中发现的每个问题在这里立一条,形状:**症状 / 根因 / 修法 / 教训**(和
> `docs/adapter-hot-plug.md` §10.x 一致)。adapter 源码类 bug 的**长期家**仍是 adapter-hot-plug.md
> §10.x;这里偏"测试视角"的发现 + 跨条目的**经验总结**。每条给个 `F-N` 编号,方便在
> [adapters.md](./adapters.md) / [platform.md](./platform.md) 的结果列里引用。

## 条目模板

```
### F-N  <一句话标题>(<site>__<name> / <功能>)
**症状**:实测怎么错的(入参 + 返回 + 现象)。
**根因**:为什么。
**修法**:怎么修的(若改 marketplace adapter,记 sha 轮换 + 子模块流程)。
**教训**:对后续 adapter / explore / 工作流的可复用经验。
状态:✅ 已修并复测 / 🔧 修了待复测 / 📌 已记录待处理
```

---

## 已有发现(本轮测试前已暴露,留档)

### F-1 知乎 `zhihu__search --type question` 几乎必空

**症状**:`中医调理肝肾 气血` 等多词查询 + `type=question` → `EmptyResultError`(还慢:一次 16.5s);
同义 `type=all` 秒回一堆。
**根因**:adapter 只打通用搜索 `t=general` 再客户端按 type 过滤;通用搜索对自然语言长查询返回的
几乎全是 answer/article、极少 question 对象 → 严格过滤后空。
**修法**:`type=question` 改为**从答案反推问题**(`deriveQuestionRow`);轮换 `index.json` sha →
推子模块 → bump 指针。真机复测:同一查询返回 6 个相关问题。详见 `adapter-hot-plug.md` §10.29。
**教训**:站点"按类型搜索"常是**客户端过滤通用结果**,某类型稀疏就会"有内容却报空";`EmptyResultError`
要用"明显有内容"的入参复核,别当成"没数据"。
状态:✅ 已修并复测

### F-2 SW reload 后 bridge `/tools` 只剩 30 个(generic)

**症状**:reload 扩展后 `curl /tools` 只列 generic;站点 adapter 不在列。
**根因**:SW 启动时 catalog 在已安装 adapter load 完之前就推给 bridge 了,且之后没 ADAPTERS_CHANGED
刷新。
**修法**:暂未改(直连 `/command` 仍可用,registry 已加载;要测 not-installed 用 `load_adapter`)。
**教训**:**别用 `/tools` 判断"装了什么"**——它可能是 reload 后的过期快照;以 `/command` 实际能否
调用为准。
状态:🔧 已修待复测(boot 时序刷新已实现,见下「deferred-fix 续」F-2 更新)

### F-3 并行后 agent 开的 tab 堆积(SW 重启更明显)

**症状**:任务结束后多个站点 tab 没关;尤其跨 SW 重启会越积越多。
**根因**:每站点 tab 池只 adopt 一个已有 tab、其余新开,且无回收;重启后 adopt 一个又新开 N-1 →
泄漏累积(cap 提到 5 后更明显)。
**修法**:加**空闲 reaper**(`reapCreatedFreeTabs`):所有 run 空闲时关掉**池自己开的**空闲 tab,
绝不碰用户自己的/adopt 的或在用的。详见 `parallel-execution.md` §11。
**教训**:池化共享资源要有"用完归还 + 空闲回收",且必须能区分**自己开的**和**用户的**,只回收前者。
状态:✅ 已修;**真机复测已补(2026-06-11,E-7)**——用户用 SidePanel 跑「知乎热榜×3」(trace
`s_mq8ubsj4_wgcheb`):3× `zhihu__question` 同批并行开 tab 池,**任务结束这些 tab 自动关闭**(用户目视
确认 + session idle),用户自己的 tab 未动。注:**reaper 只在 SidePanel agent-loop 任务结束触发,bridge
路径无任务生命周期 → 测不到**(详见下方「本轮:E2E」)。

---

## 本轮:Tier A 公共站点 sweep(2026-06-10)

测了 7 个公共站点的只读 adapter(bridge `/command`,not-installed 的先 `load_adapter`)。
最初 25 ✅ / 8 ❌ / 2 ⚠️;**定位并修掉 F-4(browser:false 丢参)后 → 29 ✅ / 5 ❌(=F-5)/ 2 ⚠️**。
详见 [adapters.md](./adapters.md) 各行结果列。

- ✅ **通过**:`bluesky`(8/9)、`devto`(3/3)、`hackernews`(pipeline 7 + `read`)、`lobsters`
  (pipeline 4 + `read`/`domain`)、`stackoverflow`(4/4)、`wikipedia__summary`。pipeline + **修好后的**
  func 都正常拿到参数、返回结构合理。
- ❌ **F-5**(见下):`arxiv`×4、`wikipedia__search`——`browser:false` func 在页面里 fetch 非 CORS 跨源 API。
- ⚠️ **待复核**:`bluesky__profile`(bsky.app 返回空 list)、`hackernews__user`(pg 返回空 list)——
  调用 `ok:true` 但结果空,疑似入参语义/返回 shape 问题,换已知有效输入复核(暂不算失败)。

### F-4 `load_adapter` 加载的 **func** 适配器**丢失入参**(pipeline / 已安装 func 不受影响)

**症状**:对**未安装**的 func 适配器,先 `load_adapter {site,name}`(返回正确 arg schema)再调
`<site>__<name>` 并传**正确的参数名**,func 仍报参数为空/undefined:

- `arxiv__search {query}` → `query cannot be empty`;`arxiv__recent {category}` → `category "undefined"`
- `lobsters__domain {domain}` → `domain is required`;`lobsters__read {id}` → `short_id: undefined`
- `hackernews__read {id}` → `Invalid HN item id: undefined`;`wikipedia__search {query}` → `Failed to fetch`(空 query 拼出坏 URL)

**真因**(已定位,非 ephemeral):是 **`browser: false`**。这些 func 声明的是 `func(args)`(单参,
args 即 kwargs),而运行时**一律按 `func(page, kwargs)` 调**(`run-in-page.ts`)——单参 func 收到的
第一个实参是 **page 对象**,`args.query` 取到 `page.query`=undefined → 报"参数为空"。佐证:失败的
arxiv/wikipedia/lobsters-read/hackernews-read 全是 `browser:false` + `func: async (args)`;能用的
`zhihu__question` 是 `func: async (page, kwargs)`(默认 browser:true)。之前"未安装才坏"是巧合(测的
未安装的恰好都是 browser:false 单参,装着的 zhihu 是双参)。

**影响**:运行时**完全忽略 `browser` 标志**——所有 `func`+`browser:false` 适配器(arxiv、wikipedia、
weread/weread-official、v2ex me/notifications、hackernews/lobsters 的 read…**约 25 个,跨 11 站**)被
参数错位打挂。(pipeline+browser:false 不受影响——它们走 SW fetch、不进 run-in-page。)

**修法**:`run-in-page.ts` 的 `runAdapterInPage`——`def.browser === false` 时按 `func(kwargs)` 调,
否则 `func(page, kwargs)`。**一处运行时改动修好所有 func+browser:false**,无需逐个改 marketplace。
加单测 `run-in-page.test.ts`(F-4 回归)。**真机复测**:`wikipedia__summary` / `hackernews__read`(71 条) /
`lobsters__read` / `lobsters__domain` 现在 ✅(入参到位)。
状态:✅ 已修并复测(参数错位部分)。剩下的 arxiv + wikipedia\_\_search 暴露出**另一个**问题 → F-5。

### F-5 `browser:false` func 在**页面里 fetch 非同源/非 CORS 的 API** → `Failed to fetch`

**症状**:F-4 修好后,`arxiv__*`(4)、`wikipedia__search` 仍 `TypeError: Failed to fetch`;而同为
`browser:false` func 的 `wikipedia__summary` / `hackernews__read` / `lobsters__*` 正常。

**根因**:`browser:false` func 本意是"无页面、纯 HTTP"(opencli 在 node 里跑,无 CORS)。本扩展把 func
跑在**页面的 userScripts world**,`fetch(...)` 受**页面 CORS** 约束:

- ✅ 同源(lobste.rs 抓 lobste.rs)或 CORS-open(HN firebase `*`、wiki REST summary)→ 通。
- ❌ 跨源且非 CORS-open:`export.arxiv.org`(老 Atom API 不发 CORS 头)、wikipedia 搜索端点;且 arxiv
  **无 domain** → 池开 `arxiv.com` 这种错页,更必挂。

**影响**:browser:false func 里凡是 fetch 非 CORS-open 跨源 API 的都挂(arxiv 全部 + 个别 wiki 等);
多数 browser:false func 抓自家同源 / CORS-open API,不受影响。

**修法**:采用候选 ①——`run-in-page.ts` 给 `browser:false` func 装一个 `globalThis.fetch` shim,经
`page.fetch` RPC 把请求转到 SW(`rpc-server.ts` 新增 `fetch` handler:直接 SW `fetch`,`<all_urls>`
免 CORS),返回值包成 Response-like(`ok/status/headers.get/json/text`);`fetch` 加进
`RPC_METHODS`/`SERVER_METHODS`(lockstep 测试通过)。**一处运行时改动修一类**,无需改 marketplace;
加单测(run-in-page F-5 回归)。**真机复测**:arxiv search/author/paper/recent + wikipedia
search/page/random/summary 全 ✅。
状态:✅ 已修并复测。(遗留:`wikipedia__trending` 仍返回空 list ——另一个 ⚠️,待查,非本条。)

---

## 本轮:公共读 sweep(auth 站点的免登录读,2026-06-10)

跑了 douban / v2ex / reddit / bilibili / zhihu / youtube / weread 的公共读。**16+ ✅**
(douban hot/top250、v2ex hot/latest/nodes、reddit 全、bilibili search/hot、zhihu hot/recommend/question、
youtube search)。zhihu `recommend` 有数据 → 用户已登录知乎。新发现 F-6 / F-7;⚠️ 几个返空待查。

### F-6 v2ex topic/node/member/user 返 404 —— 真因:pipeline **丢弃 `fetch.params`**(非 API 废弃)

**症状**:`v2ex__node`/`topic`/`member`/`user` → `Fetch failed: 404 https://www.v2ex.com/api/topics/show.json`
(注意 URL **没有 `?id=`**);`replies` 返空。同站 `hot`/`latest`/`nodes` 正常。
**初判(已推翻)**:以为 v2ex 关停了 v1 公开 API。
**实测推翻**:`curl '/api/topics/show.json?id=1219312'`(带 UA)**正常返回**主题 JSON;
`'/api/members/show.json?username=livid'` 也正常 → v1 API 活着,只是**请求没带 query**。
**真因**(运行时 class bug):pipeline 的 `FetchStepDef`/`doFetch` **不认 `fetch.params`**(只有 `wait`
步骤读 params)。凡用 `fetch:{url, params:{...}}` 的 adapter(v2ex topic/node/member/user/replies +
hackernews/search,共 6 个)→ params 被丢 → 打 paramless URL → 404 / 空。hot/latest/nodes 把参数内联进
url,所以没事。
**修法**:`pipeline.ts` 给 `FetchStepDef` 加 `params`,`doFetch` 求值后用 `URLSearchParams` 追加到 url
(跳过 undefined/空、与已有 query 合并)。**一处修一类**,无需改 marketplace、无需抓页/md5。加 pipeline
单测(F-6 回归)。**附带**:hackernews/search 的 query 之前也被丢(返回近期而非搜索结果),这下真生效。
**教训**:又一条"opencli 移植件假设的能力本运行时没实现"(继 F-4/F-13)——arg 默认值、`fetch.params`、
`evaluate(fn,args)` 都是。"404/空"先看**请求 URL 对不对**(参数到了没),别先怪上游下线。
状态:✅ 已修并复测——v2ex topic/node/member/user/replies 全通,hackernews search query 真生效

### F-7 `weread-official__*` 引用 `process.env`(node-only,浏览器里 `process is not defined`)

**症状**:`weread-official__search` → `ReferenceError: process is not defined`;8 个命令都读
`process.env.WEREAD_API_KEY`。
**根因**:weread-official 走"官方 agent gateway",要**服务端 API key**(`WEREAD_API_KEY` 环境变量)——
是 **node-only** 的;浏览器既无 `process` 也无该 key。crash 只是表象,根上它在浏览器里不可用。
**修法**:不适合浏览器运行时 → **标 ⏭️ skip**,用 cookie 版 `weread`(浏览器可用)代替。若真要支持,得走
"key 在 UI 配、不进 agent 上下文"的路子(类比 LLM key,超出本轮)。
状态:⏭️ 跳过(node-only;用 `weread` 代替)

### F-8 长批次 bridge 调用中途 **SW 断连重启**,后续调用全部 `extension not connected`

**症状**:wave-3(22 个调用、纯 bridge、面板大概率没开)跑到 ~160s 时,`instagram__explore` 返回
`extension disconnected`(WS 在调用中途关闭),其后 13 个调用全部 `extension not connected`;随后
SW 自动重启、WS 重连(ephemeral 注册全丢,catalog 退回 30)。**单独复跑 instagram\_\_explore 干净失败
(返回登录页 HTML)且 SW 存活** → 不是该 adapter 专属,是平台级。

**根因**(最可能):bridge 路径没有 active keepalive——`startKeepalivePing`(主动 `chrome.*` 调用,
真正能重置 MV3 30s idle timer 的东西,见 §10.19)只在 `activeSessions` 非空时运行,而 **bridge 调用
不进 activeSessions**;bridge-client 的 20s WS 心跳**不可靠**(§10.19 的教训:port/WS 流量 ≠ 活动)。
长批次里某个调用一旦超过空闲窗口就可能被杀。

**修法**:bridge-client 增加 `setBridgeBusyHooks`,`call` 处理全程 `onBusy/onIdle`(finally 释放);
SW 注册 hooks:在途 bridge 调用 >0 时 `startKeepalivePing()`,`stopKeepalivePingIfIdle` 同时检查
`activeSessions` 和 `bridgeBusyCount`。
**教训**:① **每条"会长时间运行"的路径都要接 keepalive**——agent loop 接了,bridge 忘了;新增执行
入口时要过一遍"SW 会不会在我跑一半时被杀"。② 批量真机测试本身就是 keepalive 的压力测试。
③ SW 重启的连带:ephemeral 注册全丢 + bridge catalog 退化(F-2)——sweep 工具要能容忍(本 harness
每次调用前重新 load_adapter,天然自愈)。
状态:✅ 已修并复测——wave-3b 连续 11 个调用(含一个 60s 超时的 youtube transcript,正是以前最容易
被杀的窗口)全程无断连,后续调用照常成功。

---

## 本轮:wave-3b(被 F-8 打断的 13 个补跑,2026-06-10)

11 跑完(douyin 中断补跑、linkedin 按用户要求**未执行**就停了批次):✅ instagram profile(公开主页
**免登录**可用)、youtube video/comments、bilibili video/comments/summary(AI 总结可用)、zhihu
answer-detail。❌:youtube transcript(F-10)、douban subject(F-9)、v2ex topic/member/user(F-6 扩面)。
🔒:douyin hashtag(创作者后台 API error -2,需登录)。**F-8 复测通过**(见上)。

### F-9 `douban__subject` 的 evaluate 脚本引用**模块作用域 helper** → 页面里 `normalizeText is not defined`

**症状**:`douban__subject {id:1292052}` → `page.evaluate threw: ReferenceError: normalizeText is not
defined at splitDoubanTitle`。
**根因**:adapter 在模块顶层定义了 `normalizeText`/`splitDoubanTitle` 等 helper,然后把**引用这些
helper 的代码**塞进 `page.evaluate` 执行——evaluate 经 CDP 在页面 MAIN world 跑,**看不到 adapter
模块作用域**,引用即 ReferenceError。同站 `book-hot`/`movie-hot`/`top250` 没用这种 evaluate 写法,所以没事。
**修法**:待改 marketplace(douban/subject.js):把 evaluate 脚本改成**自包含**(helper 内联进脚本字符串),
或抓回原始数据在 func 侧加工。
**教训**:**evaluate 脚本必须自包含**——这是 §10.14 同类陷阱的另一变体(那次是 eval scope 的错名引用,
这次是 evaluate 跨进程边界引用模块 helper)。explore/synthesize 生成 adapter 时同样要守这条。
状态:📌 已记录待处理(marketplace adapter)

### F-10 `youtube__transcript` 60s 超时(bridge `CALL_TIMEOUT_MS` 上限)

**症状**:`youtube__transcript {url:"…jNQXAC9IVRw"}` 60.0s 后 `timeout waiting for extension`;同 URL 的
`video`/`comments` 都正常。
**背景**:transcript 是老大难(`adapter-hot-plug.md` §10.21–10.27 连修六轮)。
**已定位的核心阻塞**:transcript(1003 行)最可靠的取字幕路径是 **player network-capture**——
`page.startNetworkCapture('/api/timedtext')` → 播放器自己带 pot token 拉 timedtext → `readNetworkCapture`。
但 `startNetworkCapture`/`readNetworkCapture` 是 **CDP PageShim 专属、"deliberately NOT RPC-able"**(返回
live handle),**userScripts/bridge 路径的 page shim 没有**(同 F-17 的 waitForCapture,但 capture 本身更难
桥接)。于是 `canCapture=false` → 跳过 capture,落到 fetch 回退(youtubei get_transcript 会 400
"Precondition check failed"、bare baseUrl 被 pot 锁 → 空),且有 ~25s player poll → 累计 >60s 超时。
**真因**:**网络捕获机制没桥接到 userScripts world**;这不是清爽的一处修,要把 capture 生命周期 RPC 化
(start→SW 缓冲 CDP 网络事件→read),是一项**架构改动**。
**修法**:defer——留作专门的"capture-bridge"工作项(届时 transcript + 其它 capture 类 adapter 一起受益)。
状态:📌 deferred(阻塞于 capture-bridge 架构改动;根因已定位)

## 本轮:⚠️ 复核 + 修(2026-06-10)

清 ⚠️ 堆:`douban__search` 其实**需要 `type`**(默认空,补 `type:movie` 后 ✅,算用法/默认问题非硬 bug);
`hackernews__user`/`bluesky__profile` 对**有效输入仍返空** → 定位到 F-11(运行时,已修);
`bilibili__ranking`/`wikipedia__trending` 仍 ⚠️(单独查);`tiktok` ×2 = 🔒;`v2ex__replies` 归 F-6。

### F-11 单对象 fetch 的 pipeline 返空(`profile`/`user` 一类)

**症状**:`hackernews__user {username}`、`bluesky__profile {handle}` 对有效用户都返回**空 list**
(`ok:true` 但 0 行),换不同用户也一样。
**根因**:`pipeline.ts` 的 `executeFetch` SINGLE 路径——fetch 结果是**单个对象**(profile/user 接口
返回对象,非数组)、又没设 `asRows` 时,代码 `return rows`(沿用**之前的** rows = 空),把对象丢了;
后面的 `map` 就在空 rows 上跑 → []。数组结果才会成为 rows。即 fetch→map 直连**单对象端点**时,对象
被吞。(`select` 步骤本会"单对象包成一行",但这些 adapter 是 fetch→map 直连、没 select。)
**修法**(运行时,一处修一类):SINGLE 路径加——**没有前序 rows 且结果是非空对象**时 `return [data]`
(当作一行),让随后的 map 能转换;有前序 rows 的"补充 fetch"仍保持 rows 不变(不破坏 list→detail
旁路)。加 pipeline 单测(F-11 回归)。**影响面**:所有 fetch→map 直连单对象端点的 pipeline
(各站 profile/user/me/subject 一类)一并修好,无需改 marketplace。
状态:✅ 已修并复测(HN user/bluesky profile reload 后通)

### F-9 修复 + F-13 / F-6 处置(#3)

- **F-9 `douban__subject`** → **已修**:movie evaluate 不再注入 `splitDoubanTitle.toString()`(它引用模块
  helper `normalizeText`,页面里没有 → ReferenceError);改成 evaluate 返回 `fullTitle`、func 侧拆分
  (helper 在 func scope 存在)。已改 marketplace + 轮换 sha(`9ea3ee2`)+ 推子模块(8061506)。**复测**:
  缓存刷新后复测通(肖申克 rating 9.7;用户已登录 douban)。
- **F-13 `bilibili__ranking`** → **见下,真因已更正(非 wbi/md5),已修**。
- **F-6 `v2ex`** → **已修(真因是 pipeline 丢 `fetch.params`,非 v1 API 废弃)**:见下方更正后的 F-6
  条目;一处运行时改动修好 topic/node/member/user/replies(+ hackernews search)。

> 小结(#2/#3):**跨切面的 #2 已清**——F-11(单对象 pipeline,运行时一处修一类)+ wikipedia trending
> 复活 + douban search 需 type。**站点局部的**(F-6 v2ex / F-9 douban / F-13 bilibili)里 F-9 已修推送,
> F-6/F-13 因"上游关 API / 需浏览器 md5"留到对应站点专测处理(已记清根因+方案)。

## 本轮:站点专测 zhihu→bilibili→xiaohongshu→weibo(2026-06-10)

逐站全读路径过。**zhihu 8/8 读 ✅**(收藏/收藏夹/答案评论补齐)、**bilibili 12/13 读 ✅**(me/history/
dynamic/subtitle 1152 行/feed/following/user-videos;ranking=F-13)、**xiaohongshu 6 读 ✅**
(search/user/creator-profile/creator-stats/note/comments)+ F-14/F-15。写操作一律 ⏭️ opt-in。

### F-14 `xiaohongshu__note`/`comments` 需**完整签名 URL**(裸 note-id 被拒)

**症状**:`note {note-id:"<24hex>"}` → `ArgumentError: xiaohongshu note now requires a full signed URL`;
传 search 返回的**完整 url**(带 `xsec_token`)就 ✅(note 拿到标题/正文,comments 拿到楼层)。
**根因**:小红书给笔记详情/评论加了 `xsec_token` 校验;adapter 已要求完整签名 URL,但 arg 仍叫 `note-id`
(易误导成传裸 id)。
**修法**:用法层面——**把 search/feed 行里的完整 `url` 原样传给 `note-id`**;可选:arg 改名/补 help。
**教训**:有反爬签名的站(xhs `xsec_token`、bilibili `wbi`),**详情类命令的 id 常要带 token**;
explore/工作流要把列表项的完整 url 串下去,别只留裸 id。
状态:✅ 用法已明确(传完整 url 即通);arg help 可改进

### F-15 `navigate-reinject 超 5 轮`(一类:xhs creator-notes、douban marks…)

**症状**:`xiaohongshu__creator-notes` 与 **`douban__marks`** 都在 ~32–39s 后 `adapter exceeded 5
navigate-reinject cycles`;同站 `creator-profile`/`creator-stats`/`douban photos` 等正常。
**波及面**:不是单 adapter——**跨站复现**(xhs creator-notes/creator-notes-summary、douban marks),
说明是某种页面交互模式撞上 navigate trampoline 的 5 轮上限(§10.21 族),不是某站特例。
**根因**(待精确定位):这些命令在 func 里反复 `page.goto`(分页/切 tab/滚动触发 SPA 路由),每次
goto 抛 NavigateRestart → SW reinject → 重跑 → 又 goto…循环到上限。需带 SW 日志看**每轮 goto 的目标 URL**
(是真的换页,还是 sameLogicalPage 判定漏了导致空转,如 §10.21 的 trampoline 幂等问题)。
**真因(已定位)**:这类命令用 **goto 分页循环 + 累加状态**(douban marks:goto(/mine) 取 uid,再
`while` 里 goto 每页)。每个 goto 抛 NavigateRestart → SW **从头重跑 func**,循环状态(offset/累加数组)
丢失,且早先的 goto(/mine→/people 重定向)与分页 goto **互相 ping-pong** → 撞 5 轮上限。**根上**:
goto-分页-循环与"重定向即从头重跑"的 trampoline 模型不兼容。
**修法**:把分页改成**不导航主 tab 的 in-page fetch + DOMParser**(同源 + credentials:include),整个命令
**零 goto**、一次执行跑完。douban/marks 已照此重写(getSelfUid 也改 fetch /mine 取重定向后 url 的 uid)。
**真机复测**:`douban__marks {uid:"ahbei"}` 返 5 条(解析正确);本账号 collect/wish/all 皆空 = 该号无标记。
**遗留**:`xiaohongshu__creator-notes`/`creator-notes-summary` 同类,但 creator-center 多为 JS 渲染(非
服务端 HTML),fetch+DOMParser 未必够,可能要走其内部 API——单独处理(deferred)。
**教训**:**goto 不要放进分页循环**;凡"翻页/取详情"在 func 内循环的,用 in-page fetch(或 SW fetch)抓,
不要 page.goto——否则每翻一页就重跑整个 func。explore 合成 adapter 也要守这条。
状态:✅ douban marks 已修并复测;xhs creator-notes 同类待单独修(deferred)

## 本轮:x/twitter 专测(2026-06-10)

34 个 adapter。**读 10 ✅**(search/profile/trending + timeline/bookmarks/lists/likes/followers/tweets/
thread,均已登录)。⚠️ 若干为"空属正常"(list-tweets=我列表成员0、device-follow 空、article 对非
Article 正确报错)。写 14 个 + 误标的 list-add/list-remove → ⏭️ opt-in。新发现 F-16/F-17/F-18。

### F-16 `twitter__list-add` / `list-remove` 在 index.json 里**误标为 read**(实为 write)

**症状**:两者 `access` 在 catalog 里是 `read`,但 desc 明说 "Add/Remove a user to/from a list you own"
——**会改你拥有的列表**。
**根因**:adapter 的 access 元数据标错(或 index 生成时取值有误)。
**修法**:把这俩的 access 改成 `write`(marketplace adapter 元数据 + 轮换 sha)。**当前先 ⏭️ 不盲调**。
**教训**:**别只信 catalog 的 access**——动词性命令(add/remove/create/delete)即便标 read 也要按 write
对待;写保护(`允许外部写操作`)依赖 access 正确,这种误标会让"读"白名单漏过真实写。
状态:✅ 已修(index.json access read→write;源 cli() 本就声明 write,运行时写保护一直正确,这里只是更正 catalog 元数据)

### F-17 `twitter__notifications`:`page.waitForCapture is not a function`(userScripts 路径缺该方法)

**症状**:`notifications` → `TypeError: page.waitForCapture is not a function`。adapter 流程是
`installInterceptor → waitForCapture(5) → getInterceptedRequests`。
**根因**:`installInterceptor`/`getInterceptedRequests` 是 RPC-able(在 RPC_METHODS),但 `waitForCapture`
只定义在 **CDP PageShim**(`src/runtime/page.ts:825`),**没桥接到 userScripts 的 page shim**(run-in-page)。
**修法(候选)**:在 run-in-page 的 page shim 加 `waitForCapture(timeout)`——**轮询 `getInterceptedRequests`
直到非空或超时**(复用已 RPC-able 的拦截器原语)。一处运行时改动修好网络捕获类 adapter。留到 deferred-fix
批次做 + 真机复测 notifications。
状态:✅ 已修并复测——run-in-page 的 page shim 加 `waitForCapture`(非破坏性等待,不 poll 消费拦截缓冲);reload 后复测:notifications 返回 5 条 ✅

### F-18 `twitter__following`:`Cannot read properties of null (reading 'length')`(following 解析 bug)

**症状**:`following` 崩 `null.length`;同站 `followers`(逻辑更简单)正常。
**根因**:following.js 比 followers.js 多一套 queryId/operation-metadata 处理
(`sanitizeQueryId`/`normalizeOperationFallback`/`sanitizeTwitterOperationMetadata`,queryId 可为 null),
某条路径对 null 取 `.length`。需对读 following.js 定位未保护的 `.length`。
**修法**:marketplace 修(对齐 followers.js 的简单解析,或给 null 路径加保护)+ 轮换 sha + 真机复测。
留到 deferred-fix 批次。
状态:✅ 已修并复测——真因是 following 用了 `evaluate(fn,...args)`(Playwright 形式),本运行时 evaluate 只收字符串 → fn/args 丢失 → null.length。改成 string-form(JSON.stringify 内联 url/headers,对齐 tweets/likes/followers)+ 轮换 sha + 推送;同步更新两处 adapter 单测;reload+缓存后真机复测:following(explicit user + detect-me)均 ✅

## 本轮:youtube 专测(2026-06-10)

14 个。**读 7 ✅**(search/video/comments + feed/history/subscriptions/channel,已登录,feed 里都是
Claude 视频)。transcript=F-10(60s 超时,deferred)。watch-later/playlist 撞 F-19(已修待复测)。
写 4(like/subscribe/unlike/unsubscribe)⏭️ opt-in。

### F-19 浏览器缺 `process` → 引用 `process.*` 的 adapter 崩(youtube watch-later/playlist 等)

**症状**:`youtube__watch-later` / `youtube__playlist` → `ReferenceError: process is not defined`(都有一行
`process.stderr.write(...)` 调试输出);weread-official(×8)/notebooklm(×6)/v2ex(me/daily/notifications)
也因 `process.env.X` 报同样的错。
**根因**:opencli adapter 从 Node 移植,偶有 `process` 引用——youtube 两个是**残留的 stderr 调试行**(无
功能),其余是 `process.env`(真依赖,node-only)。userScripts world 无 `process`。
**修法**:run-in-page 装**最小 `process` polyfill**(`installProcessPolyfill`:no-op stderr/stdout + 空
env,仅当 global 无 process 时)。youtube 两个的 stderr.write 变 no-op → 正常返回;env 类读到 undefined →
**优雅失败(无 key)而非崩**。全市场无 `typeof process` 探测,安全。加单测(F-19 回归,44 绿)。
**教训**:浏览器跑 node 移植代码,**缺的全局(process/Buffer/...)优先在运行时补 polyfill**——比逐个改
adapter 稳;但真依赖(`process.env` 要 key)polyfill 只能让其"优雅失败",node-only 的仍 ⏭️。
状态:✅ 已修并复测——youtube watch-later/playlist 通;notebooklm list 附带修好;v2ex me 改为优雅失败(tab-load,非 process 崩)。

## 本轮:deferred-fix 续(F-2 / F-13,2026-06-10)

### F-2(更新)SW boot 后 bridge catalog 停在 30(generic)

**修法**:`service-worker.ts` boot 把 `loadInstalledOnBoot().then(() => refreshBridgeCatalog())`——已安装
adapter 进 registry 后再推一次 catalog(bridge 常在这个异步 load 完成前就连上、收到只含 generic 的 catalog;
WS 没连上时是 no-op,onopen 再推完整集)。
状态:✅ 已修并复测(reload 后 `/tools`=92)

### F-13 `bilibili__ranking` 返空 —— 真因:func adapter **没拿到 arg 默认值**(不是 wbi/md5)

**症状**:`bilibili__ranking {}` / `{rid:0}` 返回空 list;`{limit:20}` / `{limit:5}` 正常。
**初判(已推翻)**:以为 `/ranking/v2` 要 wbi 签名、而 wbi 的 md5 用 `node:crypto`(浏览器没有)。
**实测推翻**:`curl ranking/v2?rid=0&type=all`(带正常 UA)**免签名**返 `code:0 + 100 条`;且**显式传
limit 就通**。→ 与签名无关。
**真因**(运行时 class bug):`dispatcher.ts` 只在 **pipeline** 路径调 `withArgDefaults`(填声明的 arg
默认值);**三条 func 路径**(installed func / generic / site func)直接传 `opts.args`,**默认值没填**。
ranking 的 `results.slice(0, Number(kwargs.limit))` 在 limit 省略时 = `slice(0, NaN)` = `[]`。opencli 在
CLI 层统一填默认值,移植来的 func adapter 都假设默认值已在 kwargs 里。
**修法**:三条 func 执行路径都改 `withArgDefaults(adapter, opts.args ?? {})`——**一处修一类**(所有依赖
arg 默认值的 func adapter),无需改 marketplace、无需 md5。
**教训**:跨运行时移植要对齐**整条 arg 处理链**(默认值/类型强制/positional),func 与 pipeline 一视同仁;
"返空"先查**入参链路**(默认值填了没),别先怀疑站点签名——本条差点为此写一个 JS md5。
状态:✅ 已修并复测(reload 后 `bilibili__ranking {}` → 20)

## 本轮:more sites(reddit / douban / AI 站,2026-06-10)

reddit **9/10 读 ✅**(已登录 u/redditscrat:home/saved/upvoted/whoami + 公共 read/user/subreddit-info/
user-posts/user-comments;subscribed=F-20)。douban photos ✅、reviews ⚠️(空)、marks=F-15 类。bluesky
thread ✅、zhihu search ✅。AI 站:**claude status/history ✅**(已登录)、notebooklm status ✅(current/
history 需先 `open`)、**chatgpt tab-load 超时 >30s**(claude 25s 险过)、gemini deep-research-result=F-21。

### F-20 `reddit__subscribed` 打错端点(404)

**症状**:`reddit__subscribed` → `HTTP 404 /subreddits/mine/subscriptions.json`;同站其它登录读正常。
**根因**:reddit `/subreddits/mine/<where>` 的 where ∈ {subscriber, contributor, moderator}——"我订阅的"
是 **`subscriber`**;adapter 写成 `subscriptions`(那是 OAuth API 的名,www 的 `.json` 没有)。
**修法**:① `subscriptions.json` → `subscriber.json`(端点);② 端点修好后暴露**第二层**:严格解析对
第一行 `u_<name>` 个人 sub(url `/user/…`,无 `/r/`)直接 throw 整列空——改成**跳过**(return null + filter,
map 后再 slice)。两改都在 `reddit/subscribed.js`,轮换 sha,已推子模块(54cf792)。
状态:✅ 已修并复测——subscribed 返回 4 个订阅(endpoint 改对 + 跳过 u\_ 个人 sub)

### F-21 `gemini__deep-research-result`:`page.tabs is not a function`(shim 缺 tab 枚举)

**症状**:`TypeError: page.tabs is not a function`(adapter 在 `page.tabs().catch(()=>[])` 里调,但
`.catch` 救不了——`undefined()` 是**同步** TypeError)。
**根因**:gemini deep-research 把结果开在**新标签页**,adapter 用 `page.tabs()` 枚举前后标签来找它;本
运行时 page shim 没有 `tabs()`。仅此 1 个 adapter 用,且 deep-research 是重/写型流程,需完整跑通才能验。
**修法**:采用候选 ①——page shim 加 `tabs()`:`fetch`/`getCookies` 同款 RPC,SW 侧 `fulfillTabs` 走
`chrome.tabs.query({})`,裁成 `{id,url,title,active}`;`tabs` 加进 `RPC_METHODS`/`SERVER_METHODS`(lockstep
通过)。通用可复用(任何"结果开在新 tab"的 adapter 都能用)。
状态:✅ 已修并复测——reload 后经 bridge 真机复跑 `gemini__deep-research-result`:**无 page.tabs 崩溃**、
clean 跑完 57s,返回友好"Deep Research 仍在准备/导出"提示(本号最新会话无已导出报告 → happy-path 的 URL 导出需
真报告才能 full 验;本条以"崩溃消除"为准 → 达成)。

### (观察)chatgpt tab-load 超时 / notebooklm 会话前置

- `chatgpt__status`/`history` → `failed to open chatgpt tab: tab-load timeout`(30s)。claude.ai 25.3s
  **险过**,chatgpt.com 更重 → 超时。非 adapter bug,是**池 tab-load 30s 上限对重型 SPA 偏紧**。
  **已改**:预算 30s→45s(dispatcher tabOps.open,待 reload 复测);且夜测证实 **adopt 路径完全正常**
  (先 open_url 预开 chatgpt.com → `status` 0.8s ✅ Login:Yes)——冷开是唯一瓶颈。
- `notebooklm__current`/`history` → `No notebook open`(要先 `notebooklm open <id>`)。是**会话前置**,非
  bug;完整测要走 open→current→history(留待 notebooklm 专项)。

## 夜间收尾(2026-06-10 深夜,自主)

只读探测清掉一批 ⚠️/☐:`douban__reviews`(ahbei 验证解析,本号空=无影评)✅;
`chatgpt__status` **adopt 路径 0.8s 通过**(冷开慢是唯一问题 → tab-load 预算 30s→45s,待 reload);
`v2ex__me`(id7368)/`notifications`(空=0 未读,与 me 一致)✅;`weread` 全家 🔒(干净 auth 错误,
未登录确认)。`v2ex__daily`(签到=写)、F-21 复测(deep-research-result 会导出 Google Doc=写型副作用)
都留给白天。新增 `docs/tests/tasks.md`(E2E 任务测试,23 个任务 + 写操作附录)。

---

## Session 总结(2026-06-09/10 · 第一轮全面真机 sweep)

**覆盖**:284 个 adapter 处置 213(✅135 · 🔒15 · ⚠️9 · ⏭️52 · ❌1 · 🔧1);站点专测:Tier-A 公共 7 站、
zhihu、bilibili、xiaohongshu、weibo、x/twitter、youtube、reddit、douban、AI 站(claude/notebooklm/
chatgpt/gemini);平台项 9 条勾验(并行 v3 ×2、keepalive、load_adapter、tab 工具等)。

**修掉并真机复测 18 个**:F-1/2/3/4/5/6/8/9/11/13/15/16/17/18/19/20(+ F-21 待复测、F-7 判定跳过)。
其中**运行时 class-fix 9 个**,每个一处改动修一类:

| 类                         | 修复                                                             |
| -------------------------- | ---------------------------------------------------------------- |
| opencli 能力缺口(最大一类) | F-4 调用约定 · F-13 arg 默认值 · F-6 fetch.params · F-19 process |
| 页面世界限制               | F-5 fetch→SW 代理(CORS) · F-17 waitForCapture · F-21 page.tabs   |
| MV3 生命周期               | F-8 bridge keepalive · F-2 catalog boot 时序                     |
| 编排模型                   | F-15 goto-分页循环 ↔ 重注入不兼容(in-page fetch 模式)            |

**还欠**(都已定位根因):F-10 transcript(阻塞于 capture-bridge 架构项)、F-15-xhs(creator-center
JS 渲染,需内部 API)、F-21 复测、chatgpt 45s 复测。**明天**:写操作(Tier C/I,逐个 opt-in)+
[tasks.md](./tasks.md) E2E 任务逐个过。

**方法论上最值钱的三条**:① 真机 sweep 是发现"运行时没实现移植件假设能力"的唯一手段——单测全绿
也拦不住(它们 mock 掉了恰恰缺失的那层);② 修一个 bug 常暴露下一层(F-20 端点→解析;F-4→F-5),
**复测要跑到全绿为止**;③ 初判常错(F-6"API 废弃"、F-13"要 md5"),**先验请求/入参,再怪上游**。

## 本轮:E2E 任务测试(tasks.md E-1~E-12,bridge/外部接入,2026-06-11)

第二轮换打法:不再单测 adapter,而是**给 agent 真实任务**,经 bridge/外部接入由 Claude 充当 agent
逐个跑(计划→选工具→编排→自检→回填),验证整条 agent loop。详见 [tasks.md](./tasks.md) 各结果列。
进度 **✅ 12 / ⚠️ 0 / ☐ 11**(E-1~E-12),**0 ❌**;adapter 源问题仅 F-22(IG 登录墙报错隐晦,非功能失败)。全是读路径,写 Tier I 待 opt-in。

- **冒烟/串行/并行都过**:E-1/2(单工具,wiki 走临时 load)、E-3/5(串行 list→detail,id 全取自上一步、
  截断时升级 detail)、E-4(混合:搜→video+summary 并发,wall≈max)、E-6(HN×3 并发)、E-8(HN vs
  lobsters 跨站并行)、E-9(电影三站并行,douban F-9 回归 OK)、E-10(微博×知乎热榜并行,有理判重叠)。
- **容错**:E-11(不存在 id → 诚实失败,0 伪造 0 重试 + 下一步)、E-12(① nasa 公开号登出仍可读;
  ② 用户登出 IG 后 `instagram__saved` 撞登录墙,agent 正确诊断"需登录"——见 F-22)。

### reaper 真机复测达成(补 F-3 的"待补")+ bridge 测不了 reaper(方法论关键)

E-7「知乎热榜×3」是 reaper 主验证。**bridge 路径测不出 reaper**——reaper 是 SidePanel agent-loop
**任务结束**才触发的空闲回收;bridge 是一串独立 `/command`、**无任务生命周期**,所以 adapter 开的 tab
调用后一直不关(我每条任务按"抓过的 URL"手动收以模拟)。**用户用 SidePanel 跑同一 prompt 导出 trace
`s_mq8ubsj4_wgcheb`**:计划与 bridge 完全一致(`zhihu__hot`→3× `zhihu__question` **同批**,三者
`started` ts 全 = 1781142639661 → 并行预跑坐实,wall≈max 26.5s vs 串行 64.5s),**任务结束 tab 自动
关闭** → F-3 真机复测达成。⇒ **bridge 忠实复现 agent 的 计划/并行/选工具/质量,唯 reaper 与 tab
生命周期必须走 SidePanel**(必要时让用户跑一遍导出 trace 对照)。

### adapter 取数**三类**(决定 bridge 下要不要手动收 tab)—— E-17 更正(原写"两类",漏了宿主 tab)

- **① pipeline(真不开 tab)**:hackernews(top/read)、lobsters——纯 SW fetch,bridge 下零残留。
- **② browser:false func(开"宿主 tab")**:wikipedia(summary)、arxiv(paper)——func 必须在某页面的
  userScripts world 执行,故池**在站点 base 开一个宿主 tab**(`www.wikipedia.org` / `arxiv.org/`),只有
  **data-fetch 被 SW 代理**(F-5);宿主 tab **复用、停在 base、不导航到目标**。E-17 实测:关掉再取另一篇
  arxiv,宿主 tab 重现 → 坐实。⇒ **E-2 把 wikipedia 门户判为"用户自有"是误判**(应是 summary 的宿主 tab)。
- **③ browser:true func(导航 tab)**:zhihu、bilibili、weibo、douban、youtube、instagram——func 在页面里
  **导航到目标 URL** 抓;串行复用单 tab、**并发 → tab 池**(E-7 开 3 个,≤5)。
- 共性:②③ 都开 tab,bridge 无 reaper → 残留,需按"抓过的 URL/站点"手动收;空闲时 `controlled=False`,
  **不能靠 controlled 区分 agent/用户**(真机 SidePanel 的 reaper 有自己的池簿记,bridge 没有)。

#### 为什么 ② browser:false func 必开宿主 tab(SW 调查结论,2026-06-11;E-17)

试过"让 browser:false func 改在 SW 跑、从而不开 tab"——**走不通,是 MV3 硬限制**:

- func(即便 browser:false)**本质是个 JS 闭包**,运行时拿到的是**源码字符串**,要先 `eval`(`evalAdapterKeepingFuncs` → `new Function(src)`,`run-in-page.ts:379`)才能恢复闭包并调用。
- **MV3 service worker 禁止 `eval`/`new Function`**(CSP)→ SW 里跑不了。现在的 eval venue 是**某个 http(s) 页面的 `userScripts` world**(其 CSP 允许 eval);而 `chrome.userScripts` **只能注入 http/https 页面**(不能 about:blank/chrome://)→ **宿主 tab 省不掉**,且必须是站点 base 这种真页面。
- 卡点**纯粹是 eval 没地方放**,不是取数:func 只用全局 `fetch`(已被 SW 代理、免 CORS,F-5),**不碰 page.evaluate/DOM**。
- 唯一能去掉**可见** tab 的 venue = **offscreen document 的 sandbox iframe**(扩展已有,供 install/explore/`load_adapter` 免面板 eval,`offscreen-eval.ts`)。但它**只 eval + 回传 def 元数据、故意丢掉闭包**(安全边界:闭包过不了 `postMessage`,见 `dispatcher.ts:164-167`)。要用它跑 func 需:① 把 `sandbox-host` 扩成"eval + invoke func(kwargs) + 回传结果";② 给 sandbox 里的 fetch 架一条 sandbox→offscreen→SW 的代理通道;③ 处理并发(offscreen 单例)。是**实打实、且动安全敏感路径的功能改动**。

**判定**:E-17 是**已查清的 by-design 限制,非 bug**——数据正确、走 API、真机由 reaper 自动收(用户无感),仅 bridge 路径残留。彻底消除需做"offscreen-func 执行"(留作未来项,工程量与 F-10 capture-bridge 同量级)。

### hackernews\_\_search 短词被 Algolia 容错污染(非 bug,F-6 的 query 是生效的)

E-8 搜 "Rust" + `sort:date` 返回一堆非 Rust 帖。**开发者态用控制查询** `query:PostgreSQL`(返回干净
Postgres)证实 **query 生效、F-6 没回归**;根因是 Algolia typo-tolerance 把短词 "Rust" 模糊匹配成
must/Bust/TrustName。**用法**:短词搜 HN 用 `sort:relevance` 或按标题后过滤。

### F-22 instagram 登录墙下的读报错隐晦(`Unexpected token '<'` 而非干净 auth 错)

**症状**:用户登出 IG 后 `instagram__saved {limit:5}` → `page.evaluate threw: SyntaxError: Unexpected
token '<', "<!DOCTYPE "... is not valid JSON`;同时 adapter 开的 tab 停在 `instagram.com`(登出即登录页)。
对照:公开号 `instagram__user{nasa}` **登出仍可读**(IG 对公开账号放出最近帖),不受影响。
**根因**:登录墙下 IG 对数据端点返回**登录页 HTML**,adapter 没先判 HTML/重定向就直接 `JSON.parse(html)`
→ "Unexpected token '<'"。报错指向"解析"而非"未登录"。
**修法**(marketplace,可选):登录类读在解析前判 `<!DOCTYPE`/重定向到 `/accounts/login` → 抛
`AuthRequiredError("instagram 需登录")`。属错误信息质量问题,调用本身已正确失败(未伪造)。
**教训**:**`Unexpected token '<', "<!DOCTYPE"` 出现在"应返回 JSON"的读上 = 登录墙/重定向**(拿到 HTML
登录页)——agent 可据此诊断"需登录",不必依赖 adapter 给干净 auth 错;配合"开的 tab 停在 /login"佐证。
状态:📌 已记录待处理(marketplace 错误信息可改进;agent 侧已能诊断)

### F-23 `zhihu__collection` 撞"知乎视频(zvideo)"类型直接抛错(整页取不到)

**症状**(E-19):`zhihu__collection {id:770546762, offset:20}` 与 `{id:135689507}` → `CommandExecutionError:
Zhihu collection returned unsupported content type: zvide`(zvideo 被截断显示)。同夹 `offset:0`(该页无
zvideo)正常返回 20 条。
**根因**:adapter 的 item 类型分发只覆盖 article/answer/pin 等,**遇到 `zvideo`(知乎视频)未识别就 `throw`**,
而非跳过/降级 → 收藏夹里只要有一条视频,整页(乃至该夹)就全取不到。
**修法**(marketplace,`zhihu/collection.js`):给 `zvideo` 加最小处理(取 title/url)或对 unknown 类型
**跳过**(`return null` + filter),不要抛错;轮换 `index.json` sha + 推子模块。
**教训**:**异构列表 adapter(收藏/feed/timeline)对未知 item 类型要降级跳过,别让一条挂掉整页**——同
F-20(reddit subscribed 的 `u_` 个人 sub 整列空)同一类教训。
状态:✅ 已修并复测——`zhihu/collection.js` 加 zvideo 分支 + 未知/畸形类型 `return null` 跳过(`.filter(Boolean)`);轮换 sha(`b5ee3ff5→acff5629`)+ bump 1.0.0→1.1.0,推子模块 `2bbe51a`。SW 重启后 re-`load_adapter` 复测:主夹 p2(18 条,含 zvideo)、「收藏」夹(6 条,含 zvideo)均通。详见 adapter-hot-plug §10.31。

### F-24 zhihu 无 unlike adapter,且 `zhihu__like` 是幂等(非 toggle)→ 可逆写对无法用 adapter 闭环

**症状**(E-21,写测试):`zhihu__like {target, execute:true}` 点赞成功(votes 41→42,`outcome:applied`);**再调一次想取消,仍返回 `Liked`/`applied`、votes 不变(42)**——不是 toggle。`find_adapters zhihu` 列出的写工具只有 `answer/comment/favorite/follow/like`,**没有 unlike/取消赞**。
**根因**:① `zhihu__like` 只实现"点赞"(幂等),无反向;② 市场缺 `zhihu__unlike`。tasks.md 写操作附录「zhihu like/unlike(同一工具反向)」是**错误假设**,实测推翻。
**修法**:待**自行 explore/author `zhihu__unlike`**(走 web-adapter-author 流程:知乎 unvote = `POST /api/v4/answers/{id}/voters` body `{type:"neutral"}`,带 `x-xsrftoken`;录制→合成→install/load)。在此之前 zhihu 的 like/follow/favorite「可逆对」**撤不回来**——要么不测、要么手动撤。
**教训**:**别信文档说的"同一工具反向"**;写之前先 `find_adapters` 确认反向工具真实存在。**可逆对测试的前提 = 反向操作有可用工具**,否则会在用户账号留下无法自动还原的状态(E-21 的赞**暂留** votes 42,待 unlike adapter 做出来后撤——用户已知并选择稍后自建)。
状态:✅ 已修——**author 了 `zhihu__unlike`**(`POST /api/v4/answers/{id}/voters {type:"neutral"}`,镜像 `zhihu__like` 的 type:up;`--execute` 闸;复用 like.js 的 parseTarget/buildResultRow),推子模块 `815960b`。`eval_js` 先验(neutral POST 把 E-21 的赞 42→41、voting:0)→ 落 adapter → bridge 复测 like→unlike 净零。详见 adapter-hot-plug §10.33。

### F-25 `bilibili__favorite` 实为 read(列收藏夹)却标 access:write;且无 bilibili 收藏-写 adapter

**症状**(E-22):要收藏视频 BV1xdEA6TEqY,但 `bilibili__favorite` schema 是 `fid/limit/page`、`description:我的收藏夹`,源码 `apiGet /x/v3/fav/folder/created/list-all` + `/x/v3/fav/resource/list`——**是"列出我的收藏夹内容"的读**,不收藏任何视频。市场 15 个 bilibili adapter 里**没有任何一个打 `/x/v3/fav/resource/deal`(add/del_media_ids)**,即**没有收藏-写工具**。
**根因**:① `marketplace/bilibili/favorite.js` 的 `access:"write"` **标错**(实为 read,与 F-16 twitter list-add 同类的元数据错标);② 市场缺 bilibili 收藏/取消收藏的写 adapter。tasks.md 期望的「`bilibili__favorite` 对」不成立。
**修法**:① 改 `bilibili/favorite.js` access `write→read` + 轮换 sha(纯元数据更正,顺手);② 要测 E-22 需**自行 author bilibili 收藏-写 adapter**(`POST /x/v3/fav/resource/deal`,`add_media_ids`/`del_media_ids` 同工具正反向,带 csrf=bili_jct)。
**教训**:同 F-16/F-24——**写测试前先核实工具真实语义**(读 schema/源,别只看名字或 catalog 的 access)。`favorite` 这种名字既可能是"收藏(写)"也可能是"我的收藏夹(读)"。E-22 因此**未发生任何写入**(干净阻塞,无需还原)。
状态:✅ 已修——**author 了 `bilibili__collect`**(`POST /x/v3/fav/resource/deal`,`--action add|remove` + `--execute` 闸,默认收藏夹 attr==0;复用 comment.js 的 apiPost/csrf/resolveBvid/bvid→aid)+ 改正 `bilibili/favorite.js` `access write→read`,推子模块 `2d89245`。bridge 复测:dry-run 拒写、add→视频进默认夹、remove→消失,**净零** ✅。详见 adapter-hot-plug §10.32。

### F-26 `youtube__transcript` 偶发 `navigate failed: goto timeout after 30000ms`(重 SPA 全量 load 超 30s)

**症状**:youtube transcript 经 bridge **偶发**失败 `navigate failed: Error: goto timeout after 30000ms`,用户"有时是 ok 的";真机同一视频(3B1B "Vectors")连跑 3 次都 ok(13/16/42s)→ 失败只在该次页面 `load` >30s 时。
**根因**:`src/runtime/page.ts` 的 `PageShim.goto` 硬等完整 `load`(`status==='complete'`,30s reject);YouTube watch 是重 SPA,`complete` 常 >30s。adapter `transcript.js:412` 传的 `page.goto(url,{waitUntil:"none"})` 在 func/userScripts 链路(makeLocalPage→rpc('goto')→rpc-server→page.goto)层层被丢,退化成 30s 全量等待。
**修法**:`page.ts goto` 超时**即放行**(tab 已导航就继续、非 reject;DOM 早可用 + adapter 自有轮询兜底)+ 认账 `waitUntil:'none'`(缩短预算到 ~8s)。单文件改共享 choke point,pipeline 直接受益、func 经超时放行恢复可靠。详见 adapter-hot-plug.md §10.34。
**状态**:✅ 已修并复测——reload 后经 bridge 真机复跑 `youtube__transcript`(3B1B Vectors):ok、返回 13.6k 字 transcript、~55s(goto 超时即放行,不再 30s 硬挂)。

### F-27 `scroll_page` 窗口模式在后台标签页(active:false)不滚动(smooth 被 rAF 节流)

**症状**:bridge 对 `open_url {active:false}` 开的**后台** github tab 连发 `scroll_page {direction:down,times:2}`
→ `scrollY` 始终 0(完全没滚);同一工具对 **active** 的 wikipedia tab 正常(0→1404,percent 0→3)。
`get_interactives` 的 `scroll` 显示 `more_below:true, pixels_below:6342`(页面确实可滚),但窗口没动。
**根因**:窗口滚动用了 `behavior:'smooth'`,平滑滚动由 rAF 驱动,而 Chrome **暂停后台标签页的 rAF** → 平滑
动画根本不跑,scrollY 不变。agent 常用后台 tab(`open_url` 默认 `active:false`),所以这条**静默失效**影响面大。
**修法**:`scroll-page.ts` 窗口三处 `behavior:'smooth'` → `'auto'`(瞬时)。瞬时滚动不走 rAF,后台 tab 照样滚,
且立即读回的 scrollY 准确(原 smooth 下立即读回是动画前值)。「类人节奏」由随机步幅 + 抖动间隔保留,不靠平滑
动画。与 ⑤b 容器模式(本就用瞬时)一致。
**教训**:① 给 agent 用的滚动一律用**瞬时**——平滑滚动在后台 tab 不可靠、读回还不准;② 真机测要覆盖**后台
tab**(`active:false`)这一 agent 常态,只测 active tab 测不出这个坑。
**状态**:✅ 已修并复测——reload 扩展到本分支构建后,对**后台** github tab 复跑 `scroll_page` → 0→1377(percent 22%);顺带 ⑤b 容器模式真机也过(react.dev 内滚容器 ref 0→182 到底)。分支 `feat/page-agent-borrows`;关联 §3.5/§3.6。

### F-28 `press_key` 键盘事件三连坑:frame 焦点仿真 / 非活动 tab 丢键 / Escape 被降解(2026-07-02)

**症状**:新工具 `press_key`(CDP `Input.dispatchKeyEvent`)在 shadow-dom 夹具上,调用全部 `ok` 返回但页面
keydown 监听器毫无反应;加了全键日志后发现三层问题:① agent-window 的活动 tab 上事件不投递;② 非活动
(hidden)tab 上**完全**收不到任何键(连 document 层都没有);③ 修了 ①② 后 Escape 仍异常——被投成
**两个 `key='Meta'` 的 keydown**(ArrowDown / 字符 / Ctrl+Enter 均正常)。
**根因**:① agent window 永远不是 OS 焦点窗口,Blink 只把键盘投给"自认为有焦点"的 frame(puppeteer/headless
靠 `Emulation.setFocusEmulationEnabled` 解决的正是这个);② 键盘输入只到达**渲染中**的 tab,hidden tab 的
输入被浏览器侧丢弃(mouse/hover 系带坐标不受此限,F-27 的 rAF 是另一类同族坑);③ macOS 上无 `text` 的
`type:'keyDown'` 走浏览器加速键路径,可能被降解(puppeteer 对非文本键一律发 `rawKeyDown`)。
**修法**:press-key.ts ① attach 后 `Emulation.setFocusEmulationEnabled {enabled:true}`(detach 自动复位);
② 目标 tab 非活动时先 `chrome.tabs.update {active:true}`(agent window 内用户无感;返回 `activated` 字段);
③ page.ts `pressKey` 非文本特殊键(Escape/方向键等)改发 `rawKeyDown`(Enter 保持 `keyDown`+`text:'\r'`
原形状,适配器在用,不回归)。
**教训**:CDP "ok" 只代表协议受理,**不代表事件到达页面**——键盘类工具必须用带监听日志的夹具端到端断言
(shadow-dom.html 的 `kbd:`/`doc:` 双层日志就是为此加的);后台 tab 是 agent 常态,键盘和滚动(F-27)一样
必须专门覆盖。
**状态**:①② ✅ 已修并真机复测——ArrowDown / 字符 / Ctrl+Enter 在 active tab 落 keydown;后台 tab3
`activated:true` 且 ArrowDown 真达(修前完全丢);rawKeyDown 对 ArrowDown 无回归。③ **Escape 在本机仍不达**:
`rawKeyDown` 形状下页面完全无感(连 Meta 噪音都没了),`keyDown` 形状下降解为 2×`key='Meta'`;同路径其它键
全通 → 工具侧机制已正确,疑本机某第三方扩展在 capture 层拦截 Escape(夹具页面里出现过非本夹具的
「Explain」注入按钮,证明有扩展在改页面;2×Meta 疑为其再派发产物)。**换一台干净 profile 复测 Escape**
后再定论;工具保持 rawKeyDown(puppeteer 同款,正确形状)。

### F-29 探索写任务时 agent 在探索阶段就产生真实副作用(写闸门管不到)(2026-07-02)

**症状**:任务「给指定仓库点 star」的 explore 里,agent 为"把操作做一遍"用 eval_js 直接对
`facebook/react` 提交了 star form(trace seq 64「Star form submitted」→ seq 91「already_starred」)
——探索结束时 react 真被 star 了(所幸幂等、可手动取消)。W1 写闸门(F-28 同批)确实起效:合成后
`github__star` **无一次自动冒烟**(trace 里 `github__*` action = NONE),但它只挡"合成后的自动试跑",
挡不住 agent 在探索期间的手动副作用。
**根因**:explore 的范式是"在真实页面上亲手做一遍"(录制动作+网络+DOM 才能合成),对**读**任务无害,
但对**写**任务,"做一遍"本身就是执行副作用。eval_js 是 MAIN world CDP 通道、带登录态、可直接 fetch
带 CSRF token 的写接口——agent 探索"怎么 star"时自然就真 star 了。写闸门设计在"合成→冒烟"这一环,
比副作用发生点晚。
**修法(已实现,2026-07-02;待真机复测)**:两层——

- **eval_js 写拦截(机制,加固)**:eval-js.ts 新增 `detectWriteIntent(code)` 纯函数,高精度静态扫写信号
  (`method:'POST'/PUT/DELETE/PATCH` 选项、`XHR.open(写方法)`、`.submit()`/`.requestSubmit()`、`sendBeacon`);
  explore 模式下命中且未传 `allow_write:true` → **默认拒绝执行**,返回指导 error(教它改用 get_interactives/
  get_html/read_network 观察写接口形状来合成)。`allow_write:true` 是逃生阀(仅用户明确要求验证时)。宁缺毋滥:
  裸字符串 `"POST"`(读 form.method)不命中,不打扰读探索;抓不到动态拼 method(`'PO'+'ST'`)是接受的漏,
  靠 prompt 兜。注:这挡 eval_js 直接网络写,**挡不住 click 真按钮**(点击写意图无法静态判定)——那靠 prompt。
- **侦察纪律 + 如实收尾(prompt,主力)**:exploreModeNote 新增"写任务——侦察不是执行"段(观察 form
  action/method/token → 推断即可合成、别真提交;写适配器"未验证"是对的,验证留对话内写确认);"如实收尾"条
  加"写任务额外":探索期间若产生真实写副作用必须**显式如实**告知(不得轻描淡写成"执行流程说明"——正是本条
  bundle 里 agent 犯的)。
- +9 单测(detectWriteIntent 命中写 / 不误伤读,含 F-29 trace 里的真实 GitHub star 片段)。
  **教训**:写闸门只覆盖"合成后自动冒烟"一个点,**探索阶段的手动副作用是独立的敞口**;写任务的 explore
  需要一套"侦察而非执行"的纪律(prompt + 可能的 eval_js 写请求拦截),否则"探索一次"= 真写一次。read
  任务不受影响。这条决定了「explore 支持写适配器」要走多远——见 [[llm-explore-research]] 第三波议题。
  **bundle 验收(s_mr3kzq6i)**:写闸门本身**三点全过**——① 卡片 `github__star` 状态 `untested`、
  `access:'write'`、verify=`None`(确实没自动跑);② 给 agent 的反馈正是设计文案「写操作不自动试跑…如实
  说明该适配器未经试跑验证」;③ 但 agent 收尾**只如实了一半**:说了"未自动试跑、需写确认",却**只字未提
  探索期间它已用 eval_js 真的 star 了 react**(总结把 `already_starred` 当成"执行流程说明"轻描带过)。
  → 证实敞口是 F-29 本体(探索副作用)+ 收尾话术把它含糊化,而非写闸门失效。修法应同时含:侦察纪律
  (不真提交)+ 收尾必须显式声明"探索期间已产生的真实写副作用"。
  状态:✅ 机制层已修并真机复测——eval_js 写拦截(detectWriteIntent + allow_write 逃生阀)+ exploreModeNote
  侦察纪律/如实收尾。**真机(2026-07-02,bridge explore 会话 + 直接喂 eval_js,github.com/sindresorhus/is)**:
  T1 `fetch(action,{method:'POST'})` → 拦截(ok:false + 指导 error);T2 `form.requestSubmit()` → 拦截;
  T3 只读侦察(读 form.action/method,返回体里含 `method:"post"` 字符串)→ **放行**(高精度不误伤);
  T4 `allow_write:true` → 放行。**prompt 层(侦察纪律 + 如实收尾)未端到端复测**——需一次真实 panel 写探索
  观察 agent 是否改走观察路线 + 收尾如实(click 触发的副作用只能靠 prompt 兜);留待下次带写任务的 explore。

**修法(补,2026-07-03)——建设性半边落地 `capture_submission`**:原修法只**堵**(detectWriteIntent),
代价是 agent 根本没法探索写任务(整类写 adapter 硬顶)。新增 generic 工具 `capture_submission`(arm/disarm/
status)+ CDP 核心 `src/runtime/submission-capture.ts`:arm → **真填表点提交** → disarm,写请求(POST/PUT/
PATCH/DELETE / GraphQL mutation)被 CDP `Fetch` 拦截 + 记录 + **中和**(abort,永不发服务器,零副作用),
读请求(GET / GraphQL query)放行;捕获结构(端点/方法/body 字段,cookie·授权·CSRF 头脱敏)喂进 explore
trace → `synthesizeAdapter` 合成 `access:'write'` adapter(prompt 加写-adapter 引导)。exploreModeNote 写任务
改「路线 A `capture_submission` 实做 / B 观察推断」,eval-js 写拦截文案指向它。**离线门禁全绿**(tsc/eslint/
1541 测试[+16]/build/prettier);**真机 E2E 通过 14/14**(2026-07-03 reload 后经 bridge,夹具
`docs/tests/fixtures/write-form.html`):写(fetch POST / GraphQL mutation / 原生表单 POST=Document)全 `neterror`
中和、页面未跳转;读(GET / GraphQL query)放行;Cookie+x-csrf-token 脱敏;body 三型解析。这把 F-29
从"只堵"补成"堵+疏",解锁写任务探索 + Tier-C 无副作用写测。详见 [[docs/browseract-comparison.md]] §3(2026-07-03 landing)。

### F-30 bridge `/command` 调用会污染进行中的 SidePanel explore trace(2026-07-02)

**症状**:任务 A 复验时我经 bridge 发 `juejin__hot_articles {limit:5}`,恰逢用户已在侧栏开跑任务 B,
该调用被记进了 **B 的活跃 trace**(explore_mr3ktpji seq 32);任务 C 的 trace 开头也混入了我验证 B 时发的
`163__hot_songs {limit:3}`(seq 0)。这次无害(没进合成切片、没干扰结果),但属实是串扰。
**根因**:`executeAdapter`(dispatcher.ts)是所有工具的统一 choke point,末尾无条件
`getActiveExploreSession()?.recordAction(...)`——它认的是"当前有没有活跃 explore 会话",**不区分调用来自
SidePanel agent 还是 bridge `/command`**。bridge 是独立入口、无会话概念,发的任何工具调用都会被计进当时
恰好活跃的那个 explore trace。
**修法(待议,未改)**:候选——① recordAction 只记来自"拥有该 explore 会话的那个 driver"的调用(给
executeAdapter 传入调用来源标记,bridge 路径不记进 panel trace);② 或更简单:bridge 与 SidePanel explore
互斥时告警。影响面小(仅"一边 bridge 一边侧栏 explore"这个测试期特有场景),优先级低。
**教训**:测试纪律——**验证 adapter 别在用户 explore 会话进行中经 bridge 发**(会串进 trace);要么等会话
结束,要么用一个明确不在 explore 的读工具。已据此调整:后续复验都等 panel 会话 done 再发。
状态:✅ **已修(2026-07-03,候选①)**——`ExploreSession` 加 `owner`(SidePanel = chat sessionId / bridge =
`'bridge'`),`executeAdapter` 加 `origin`(agent 传 sessionId、bridge 传 `'bridge'`、verify/workflow 不传),
`recordAction` 仅当 **`exploreShouldRecord(owner, origin)`**(= `!origin || owner===origin`)才记。修**双向**串扰
(bridge↔sidepanel)+ sidepanel↔sidepanel(B 的调用不再记进 A 的 explore);未标 origin 的 verify 冒烟照常记。
6 单测(`tests/explore-owner-isolation.test.ts`);真机回归(bridge explore 仍记自身 + 交叉不记)待 reload。

### F-31 get_dom_outline 不穿透 open shadow DOM(已知局限,待补)(2026-07-02)

**症状**:W2 shadow 穿透那批只改了 click 系 / query_dom / wait_for_selector / get_html / get_interactives /
type_into 的深查询,**漏了 get_dom_outline**。真机确认:对 shadow host(fixtures/shadow-dom.html `#host1`)
`get_dom_outline` 返回 `nodes:0`——看不到 shadow 内结构。
**根因**:get-dom-outline.ts 的注入函数用 `root.querySelector(rootSel)` + 递归 children,没走 open shadowRoot
(同批其它工具加了 deepQuery,它没加)。非 bug、是覆盖遗漏。
**修法(已修并复测)**:get-dom-outline.ts 的 root 解析改 deepQuery(穿透 open shadowRoot),遍历用
function 声明的 emit↔walk(避 TDZ),host 节点先 emit 一行 `#shadow-root` 再缩进遍历 shadowRoot 子树,
light children 保持原缩进(非 shadow 输出不变)。**真机(2026-07-03,shadow-dom.html `#host1`)**:从
`nodes:0` → 8 节点,完整显示 `#shadow-root` + button#sbtn / div#scard / select×3 option / input / label。
**教训**:一次"给一批工具加同一能力"的改动要**列全清单逐个核**——get_dom_outline 就是这批里被漏掉的那个;
真机 sweep(F-31 正是 sweep 中发现)是这类遗漏的兜底。
状态:✅ 已修并复测

### F-32 合成源码把 pipeline `${{ }}` 表达式写进反引号模板串 → eval 语法错(2026-07-03)

**症状**:验证便宜复利簇(任务 1 豆瓣 Top250,真机 SidePanel explore)时,第一次合成
`douban__movie_top250` **失败**,`verify.error = "Unexpected token '.'"`;第二次(repair)才通过。
**根因**:模型把 pipeline 的 `${{ args.limit }}` 表达式写进了 evaluate 的**反引号模板串**里
(`` evaluate: `(async () => { const limit = …${{ args.limit }}…; })()` ``)。JS 注册期**先**把模板串的
`${…}` 当插值解析,`${{ args.limit }}` → `{ args.limit }` 是非法对象字面量 → 语法错。`${{ }}` 本该只用在
**普通字符串**值里(引擎替换),放进反引号串必炸。repair loop 兜住了,但第二版改成硬编码 `page<10` 抓满
250 再 slice——**能跑但低效**(limit=50 也拉满 250),原本 `ceil(limit/25)` 的高效分页被这坑逼退。
**修法(已修,离线可测)**:① `lintSource` 加**模板串 `${{` 检测**——单遍扫 backtick 奇偶态,只在 template
literal *内*出现的 `${{` 报警(引号字符串里的 `${{` 前面 backtick 数为偶、不误报);4 单测覆盖 bug / 正确用法 /
普通 `${x}` / adapter[1] 形态。② synth prompt 加一条:`${{ }}` 只用普通字符串、别写进反引号模板串,evaluate
用参数改单引号 + 拼接。
**教训**:`${{ }}`(pipeline 表达式)与 `` `${…}` ``(JS 模板插值)是两套语法,撞在反引号里必炸——这是继
arg-leak、evaluate(fn)(F-18)之后 evaluate 字符串处理的**第三类**静态可查坑,统一由 lintSource 兜。**真机
explore 验证是抓这类"自愈但低效"退化的有效手段**(单测不会自己写出这种源码;是任务 1 真跑才暴露)。见
[[docs/browseract-comparison.md]] §3(便宜复利簇 landing)。
状态:✅ 已修(lint + prompt);离线门禁绿;真机新 lint 生效待 reload(与任务 2 一起复验)。

### F-33 混淆-class lint 漏了 CSS-modules `Name__hash` 型编译类名(2026-07-03)

**症状**:任务 2(GitHub 仓库搜索)合成的 adapter 用了 `.Content-module__Content__mHmep` /
`.Footer-module__footer__kjBR4` / `.Repositories-module__stargazersLink__KRMAf`(webpack CSS-modules
编译类名,尾段随机 hash),但 `lintSource` **没警告**(反馈 `自动检查发现`=0)。模型自己兜住了(加
`[class*="Content-module"]` 前缀 fallback + 已知限制诚实标注),但 lint 本该提示。
**根因**:混淆-class 检测的 token 正则 `\.[A-Za-z][A-Za-z0-9]{3,9}\b` 不含 `_`/`-`,且过滤器 `if (/[-_]/) return false`
**直接排除任何带分隔符的类**——正好把 CSS-modules(`Name-module__local__hash`)/ styled-components(`sc-<hash>`)
整族漏掉。原检测只针对无分隔符的短随机串(`.YzCcne`)。
**修法(已修,离线可测)**:token 正则放开到含 `_`/`-`;带分隔符的类走新 `looksHashedModule`——命中
`-module__`(webpack)/ `sc-<hash>`(styled-components)/ `css|jss-<hash>`(emotion/jss)/ 尾段 `__<hash>`
(且是复合类:有 `-` 或 ≥2 个 `__`,hash 段 mixed-case 或带数字)则警告;高精度不误伤 BEM/kebab
(`search-result__title` / `block__element` / `header__nav-button` 不报)。4 组新单测(含全大写 hash `KRMAf`
——旧 mixed-case 检查也漏的那种)。
**教训**:「混淆类」不止无分隔符短串;现代前端(CSS-modules / styled-components / emotion)的编译类\*\*带分隔符

- 尾随 hash**,判据要看**尾段\*\*而非整串。真机 explore(任务 2)是发现 lint 盲区的有效手段。
  状态:✅ 已修(lint + 4 单测),离线门禁绿(1585)。结清 [[docs/browseract-comparison.md]] §3 便宜复利簇 landing
  列的「留后:混淆-class lint 补 `Name__hash`」。

### F-34 `synthesize_adapter` 挂起 → 孤儿工具调用 → 模型幻觉「我没有这个工具」(2026-07-03)

**症状**:真机测分页(ProductHunt,会话 `s_mr4lnzaw`)——agent 把提取代码在 `eval_js` 里调通(50 条产品),
调 `synthesize_adapter` 合成。结果**卡住约 19.5 分钟**(合成 trace ts=…3410906 → 用户首句「go on」ts=…4579050),
用户连发「go on / 怎么回事呀 / 继续」都没响应;恢复后该 `synthesize_adapter` 调用的工具结果是 **`[已中断,无结果]`**,
模型据此**推断自己「工具集里没有 synthesize_adapter」**(纯幻觉——它前一步的 `note_finding` 明明生效),放弃合成、
转去 `find_adapters` 找现成 adapter。用户报「合成失败,说工具集里没有 synthesize_adapter」。
**根因(两层)**:① **合成 LLM 调用无超时、且没传 signal**——`chatCompletion` 的 `fetch` 本身无 timeout(只认
`opts.signal`),而 `handleSynthesizeAdapter`→`synthesizeAdapter` **一个 signal 都没传**(`explore-driver.ts:437`);
端点一旦 stall,`await fetch` 无限挂,阻塞整个 agent loop(主循环撞同样的 fetch 时用户还能按 Stop 中止,嵌套的合成
调用连这条路都没有)。工具结果一直没落盘 → sanitizeHistory 重建时把这条孤儿 tool_call 补成占位。② **占位文案误导**:
`[已中断,无结果]`(`engine-history.ts:136`)读起来像「工具跑了、返回空」,模型顺着就得出「这工具没用 / 我没有它」。
**修法(已修,离线可测)**:① `synthesizeAdapter` 内给合成调用套 `AbortSignal.timeout(180s)`,并用新纯函数
`anySignal([opts.signal, timeoutSignal])`(`resilience.ts`)与调用方 signal 合并——stall 变成**可重试的超时错误**
(「合成超时:180s 内无响应,请用同一 name 重新 synthesize_adapter 重试(工具可用)」),agent 照常 repair-retry。
② 占位文案改成**点名工具 + 明确「被中断、未执行完成、工具仍可用、可重调、写操作先核实」**——杜绝「工具不存在」的
误读(对所有工具生效,非只合成)。6 单测(anySignal)+ 改 2 条 sanitize-history 断言。
**教训**:① MV3 里任何**嵌套/非交互的 LLM 调用都必须有超时**——主循环靠用户 Stop 兜底,子调用没有,无 timeout =
潜在无限挂。② **给模型看的"中断占位"是提示词的一部分**:含糊的 `[无结果]` 会让模型编出错误世界模型(幻觉工具缺失),
写清「中断/可重试」直接改变它的下一步决策(与 truthful-status 教训同源)。③ 真机长任务(合成)才暴露超时缺口,单测测不到。
状态:✅ 已修(timeout + anySignal + 占位文案 + 单测),离线门禁绿(1620);真机复现难(需端点 stall),
**建议真机复测**:reload 后重跑 ProductHunt 分类分页探索→`synthesize_adapter`,确认能正常合成/或超时可重试(见测试清单)。

### F-35 ⑩ 经验笔记被下一次调用清空(outcome 写入不保留 notes)(2026-07-03)

**症状**:真机验 ⑩ 读回——用户已用 `note_adapter_experience` 给 `zhihu__search` 记了笔记(agent 回「已记下」),
之后经 bridge 让该 adapter **失败**(`limit:99999` → ArgumentError,`ok:false`),错误里**却没有** 📝 历史经验笔记。
排查确认失败确实走了 `withAdapterNotes`(executeAdapter 末尾无早返回),即读到的 `notes` 是空。
**根因**:`adapter-health-store.ts` 的 `applyOutcome`(每次工具调用都经 `recordRun` 触发、**重建**整条 health 记录)
返回的新对象**没带 `prev.notes`** → `store.put(next)` 把笔记**覆盖清空**。写笔记的 `recordAdapterNote` 用 `{...base, notes}`
保留了其它字段,但反过来 outcome 写入不保留 notes——于是**笔记写完后,只要该 adapter 再被调用一次(成功或失败),
笔记就没了**。本次正是我先成功调了一次 `zhihu__search`(3 行)把笔记冲掉,随后的失败自然读不到。
**修法(已修,离线可测)**:`applyOutcome` 返回对象补 `notes: prev?.notes`,让笔记跨 outcome 写入存活。1 单测(成功+失败
两次 outcome 后 notes 仍在)。
**教训**:①「读-改-写」IDB 记录若**重建**而非 `{...prev}`,极易丢新加的并行字段(notes 和 health 是两条写路径、共用一条记录)。
② ⑩ 的离线单测只覆盖了 `appendNote`/`toHealthId`,没覆盖「写 note → 再跑一次 → 读回」的**跨写路径**交互——真机端到端才炸出来。
状态:✅ 已修 + 单测;真机复测需 reload 后**重记一次笔记**(旧的已被冲掉):SidePanel 让 agent `note_adapter_experience`
`zhihu__search` → 再 bridge 调 `zhihu__search {limit:99999}` 失败 → 错误尾部应带「📝 该 adapter 的历史经验笔记」。

### F-36 `screenshot full_page` 平铺重复视口而非截整页(无 clip 的 captureBeyondViewport)(2026-07-04)

**症状**:真机演示长截图(Wikipedia 长文,bridge 调 `generic__screenshot {full_page:true}`)——返回 2108×76730px
的"长图",但内容是**同一屏视口反复平铺**,不是页面的连续内容;高度也是乱算的(agent 窗口无固定尺寸加剧)。
**根因(两层)**:① CDP `Page.captureScreenshot {captureBeyondViewport:true}` **不带 `clip` 时不会自动按内容尺寸截**——
它只是解除视口边界,配后台/无尺寸的 agent 窗口,合成器拿不到明确区域就把当前视口平铺填充(Puppeteer/Playwright 的
fullPage 都是先量 `Page.getLayoutMetrics` 再 clip,这步我们漏了)。② 修了 clip 后暴露第二层:真实内容高(该文
1280 宽下 48496px)**超过 GPU 单张截图上限**(~16k),单张必然截断,"完整"必须分段。
**修法(已修,真机验过)**:`screenshot.ts` full_page 路径改为——(a) 独占 debugger 时先
`Emulation.setDeviceMetricsOverride` 规整 1280 桌面宽(后台窄窗不再 reflow 畸高;detach 自动还原);
(b) `Page.getLayoutMetrics` 读真实内容尺寸,**clip 到它**(根治平铺);(c) 高于 12000px 按段用 clip 逐段截,
`OffscreenCanvas` 拼成一张连续 PNG(fixed 元素只在首段渲染一次,无每段重复);50000px 硬上限 + 拼接失败降级
到最大单张(带 cap_note 说明,绝不比未拼接差)。
**验证**:真机 bridge 复测同一页 → PNG **1280×48496 与 content_size 完全一致**,多高度采样带内容各不相同
(章节/表格/参考文献),整页缩略连续无重复。
**教训**:① `captureBeyondViewport` ≠ fullPage——**没有 clip 就没有"整页"语义**,必须 getLayoutMetrics+clip
(对照 Puppeteer 实现);② "尺寸看起来对"不等于内容对——平铺 bug 的产物尺寸也"很像整页",**判据要采样多个高度
对比内容**;③ 修一层常暴露下一层(clip 修好才看到 GPU 高度上限),真机验证要跑到"内容正确"为止。

## 本轮:generic 只读工具 platform sweep(2026-07-02,W1/W2 构建)

方法论:W1/W2 落地构建装好后,经 bridge 系统性把 platform.md §1/§2 里长期 ☐ 的**只读**工具过一遍
(explore 会话 + 真实站点 stackoverflow 问题页 / example.com / 市场 / 浏览器数据),写类(create_bookmark /
add_to_reading_list / install_adapter / create_workflow / create_shortcut)用户睡眠期不测。

结果:**16 个 generic 只读 + 3 个 bridge 只读工具全部 ✅,零新 bug**(不像 F-27/F-28 那批交互工具)。
覆盖:get_page_text / get_text_from_tab / get_active_tab / find_structured_data / get_a11y_tree /
get_dom_outline / query_dom / list_network / read_network / find_in_network / list_trace / eval_js /
search_bookmarks / search_history / list_reading_list / find_adapters(+ list_workflows / list_shortcuts /
list_memories / explore_start / explore_stop)。逐个结果填进 platform.md 结果列。

几个值得记的确认点:① `list_trace` 的 `site` 正确解析为 `stackoverflow`(DeepSeek field report 的 siteFromHost
两段后缀修复生效);② `get_active_tab` 正确返回**用户**活动 tab 而非探索 tab(语义隔离对);③ `find_structured_data`
在真实站点抓齐 jsonld(字段名 `type`)/meta/feeds/microdata/state 五类;④ eval_js 写拦截(F-29)在真站点
form 上按设计工作。教训:只读工具这一层已扎实,下一批真机价值在**交互/写 + 端到端任务**(需 reload)。

## 本轮:untested-reads sweep(已登录 / 免登录读,2026-06-24)

按"未登录就跳过、先做已登录 / 免登录"扫了 adapters.md 里剩下的 ☐ 只读。**最重要教训(踩坑)**:每个站点的
**首次冷调用**(tab 池刚开的标签页、页面没就绪)常返回 auth/401/登录墙错误,被我误判成"未登录"而标 🔒——
实则用户登录着,**warm 复测就通**。claude / instagram / douyin 我最初标的 **15 个 🔒 全是冷开假阴**,已逐一复测改正。

最终:

- ✅:`reddit__hot`、`jimeng__history`(空)/`workspaces`、`gemini__new`、`chatgpt__new`、
  `notebooklm__open/get/summary/source-list/source-get/source-guide/source-fulltext`(开本后整链);
  **instagram** `user/profile/explore/followers/following/search/saved`(冷开首测 401/登录墙,复测全通);
  **claude** `history/new/read`(冷开首测 AuthRequired,复测通);
  **douyin** `profile/videos/collections/activities`(冷开首测"用户未登录",复测通)。
- ⏭️:`weread-official__*`(7)——`list-apis` 复测 `WEREAD_API_KEY not set`,确认 **F-7 整站 node-only**,用 cookie 版 `weread` 代替。
- ⚠️(已登录但有真问题 / 没数据 full 验):notebooklm `note-list`(本本无笔记)/`notes-get`(无 note id);
  chatgpt `read`(新会话空)/`detail`(时序);claude `detail`(EmptyResult,但 read 同会话有内容 → 提取/时序);
  douyin `drafts`(API "Url doesn't match")/`hashtag`+`location`(API error -2,疑权限/endpoint)/`stats`(需 aweme_id)/`user-videos`(需 sec_uid)。
- 🔒(仍真未登录):`weread`(cookie 版)×9。

教训:① **冷开假阴**——首次调用失败别急着判 🔒;**同站点 warm 复测一次**再下结论(`status` 说 Login:Yes 但
`history` 报 AuthRequired 这种不一致 = 时序,不是登出)。② func adapter 的"current X"类要先 open/new 起上下文;
arg 按 schema(notebooklm `open`=`notebook`、weread-official `book`=`bookId`、douyin `location`=`query`/
`user-videos`=`sec_uid`)。③ instagram private API / douyin creator 后台都靠浏览器登录态,冷开时该态可能还没就绪。

## weread 登录后复测 + weread-official key 验证(2026-06-25)

用户登录微信读书后复测 cookie 版 `weread`:**5 ✅**(shelf/search/ranking/ai-outline/book-search)、**4 ⚠️**
(book/notebooks/highlights/notes 报 `CliError: Not logged in to WeRead`)。根因:`book.js` 这类走
`i.weread.qq.com` 的 API,登录判据是 **`wr_vid` cookie**(`getCurrentVid`);shelf/search 走 web 页 / 公开端点不
需要它。web 登录态下 `wr_vid` 未暴露给 adapter(httpOnly / 域 / 时序?)→ 这 4 个判为未登录。待查:`wr_vid` 是否
存在 / 可读。

**weread-official(= Tencent/WeChatReading skill,key `wrk-…`)**:拿用户 key 直接 POST
`https://i.weread.qq.com/api/agent/gateway`(`Authorization: Bearer`,`api_name:/store/search`)→ **HTTP 200、
20 组结果**——**key 与 gateway 都正常**。但 8 个 weread-official adapter 是 `browser:false` + `process.env.WEREAD_API_KEY`,
而本运行时的 process polyfill **env 恒为空**(`src/userscript/run-in-page.ts:466 env:{}`)→ 浏览器里永远拿不到 key
(F-7 的真正卡点)。**结论**:weread-official 功能本身可用,缺的是**运行时把 adapter env var(WEREAD_API_KEY)注入
`process.env` 的机制**(设置里存 key → 注入 polyfill env)——这是个**功能**,不是 bug。短期用 cookie `weread` 覆盖
大部分读。

### 后续(2026-06-25):env 注入功能已建 + wr_vid 根因定位 + 决策「走 weread-official」

**① env 注入功能已落地**(commit `2f696be`,见 `docs/adapter-secrets.md`):凭据 vault(`chrome.storage.local`)→
按 adapter 源码里的 `process.env.NAME` 注入到隔离 USER_SCRIPT world 的 `process.env`,key 全程不进模型上下文。
真机 bridge 实测 `weread-official__search "三体"` → **3 行真实结果、key 已打码**。weread-official 这 8 个 adapter
不再被 F-7 卡住。(过程中还顺手修了 `swFetchVia` 丢 `AbortSignal` 的级联 bug,见 adapter-hot-plug §10.35。)

**② cookie 版 `weread` 的 4 个 ⚠️(book/notebooks/highlights/notes)wr_vid 真·根因**——bridge + `generic__eval_js`
在登录态 weread.qq.com 页实测:

- 用户**确实已登录** web(`wr_name`/`wr_avatar`/`wr_gid`/`wr_localvid` 在 `document.cookie`)。
- `wr_vid` / `wr_skey` 是 **httpOnly**(`document.cookie` 看不到;CDP `page.getCookies` 能拿到)——所以 adapter 不是
  「读不到 wr_vid」,而是**发不出去**。
- **根因**:`fetchPrivateApi` 手动塞 `Cookie` 请求头,而 **`Cookie` 是 fetch 的 forbidden header**,浏览器静默丢弃
  (opencli 在 node origin 能塞,搬进 USER_SCRIPT world 就被丢)→ 请求**裸奔无鉴权** → errcode **-2010「用户不存在」**。
- 实测换 `credentials:'include'`(让浏览器自动带上 httpOnly cookie):cookie **确实带上了**(errcode 变 **-2012
  「登录超时」**)——但 `wr_skey` 会话**已过期/需签名**(weread web app 会悄悄刷新/签名,裸 API 调用不会)。所以
  cookie 这条路**在浏览器里本质脆**:即便修掉 forbidden-header,仍卡在 -2012。

**③ 决策:走 weread-official**(官方 gateway,vault 跑通)覆盖同一批数据。cookie 版 book/notebooks/highlights/notes
**判为被取代**(superseded),不再投入修 forbidden-header(修了也过不了 -2012)。**reload 后 bridge 实测
weread-official 8/8 ✅**:list-apis(18)/shelf(131)/readdata(30)/notes(20)/search(三体)/book(三体 129)/
review(20)/discover(12)——`notes` 即取代 cookie notebooks/highlights/notes。

**④ 顺带定位 + 修了一个 tab 池健壮性 bug**:复测 `notes` 一度连续报 `userScripts.execute … Cannot access contents
of the page`,根因是**测试中途 SW 重启**后,func 路径被租到停在受限 scheme(about:blank / chrome://)的 tab,而
`runOnceWithPort` 注入前不校验可注入性(纯 HTTP 的 browser:false adapter 也要 _一个_ host 跑 runner)。修法:dispatcher
新增 `ensureInjectableTab`——注入前若 tab 不在 `http(s)` 就先导到站点 landing(defense-in-depth)。详见 adapter-hot-plug
§10.36。正常会话 keepalive 钉着 SW,极少触发;深层「池为何租到受限 tab」留作后续。

**教训**:① httpOnly cookie「JS 看不到」≠「adapter 拿不到」——CDP getCookies 能读,真正的坑常在**发送**侧
(forbidden header / credentials 模式);② 跨进程把整个 `init` 直塞会踩 forbidden-header 与不可克隆对象两类坑
(后者见 §10.35);③ 站点私有 API 的会话(skey)往往要 web app 在线刷新/签名,裸调注定 -2012,**有官方 gateway
就别跟私有 API 的会话机制较劲**。

## 经验总结(滚动,跨条目)

- **`EmptyResultError` ≠ 没数据**:先用"铁定有内容"的入参复核,再判断是 adapter bug 还是真空(F-1)。
- **node-only 依赖**(F-7):adapter 需服务端 key /`process.env`(weread-official)——浏览器里跑不起来,
  node-only 的标 ⏭️。(注:F-6 一度被当成"v2ex 关 API",实为 pipeline 丢 `fetch.params`——见下文,先验"请求
  对不对"再怪上游。)
- **"运行时没实现 opencli 假设的能力"是一整类**(F-4/F-6/F-13/F-18):arg 默认值、`fetch.params`、
  `evaluate(fn,args)`、browser:false 调用约定——移植件默认这些都在,本运行时漏了就静默错(返空/404/NaN)。
  新站点遇怪象先怀疑这条。
- **登录态先确认**:站点 adapter 大量依赖登录;`auth_required` 记 🔒 不算失败,但要和"真 bug"区分开。
- **写操作有真副作用**:能可逆/ dry-run 才测,破坏性默认跳过(见 README §6)。
- **真机才暴露的类别**:登录/cookie、页面渲染时序、CDP attach、反爬限流、并发共享 tab——这些单测
  全测不到,正是本套文档的价值。
- **运行时要尊重 adapter 声明的调用约定**(F-4):`browser:false` = `func(kwargs)` 单参,默认 =
  `func(page, kwargs)` 双参;运行时若一刀切按双参调,单参 func 就把 page 当 kwargs 读到一堆 undefined。
  F-4 修复后,未安装的 func 也能用 `load_adapter` 真机测了(CORS 类除外,见 F-5)。
- **页面里的 `fetch` 受 CORS 限制**(F-5):`browser:false` func 本该无页面纯 HTTP,跑在页面里就被
  CORS 挡(非同源/非 CORS-open 的会 `Failed to fetch`);根治是把 func 的 `fetch` 代理到 SW(免 CORS)。
- **判读要看返回 shape**:`ok:true` 不等于通过——`bluesky__profile`/`hackernews__user` 返回**空 list**
  也是 `ok:true`;空结果/不合理 shape 要标 ⚠️ 复核,别直接打 ✅(README §7)。
- **bridge 路径测不了 reaper / tab 生命周期**(E-7):reaper 只在 SidePanel agent-loop 任务结束触发,
  bridge 是独立 `/command`、无任务生命周期 → adapter tab 调用后不回收。reaper/自动关 tab/tab 池这类
  判据**必须走 SidePanel**(让用户跑一遍导出 trace 对照,如 `s_mq8ubsj4_wgcheb`);bridge 只忠实复现
  计划/并行/选工具/质量,这几维和 SidePanel trace 逐步一致。
- **bridge 下归因 tab 别信 `controlled`**:adapter 的 fetch-tab 空闲时 `controlled=False`,与用户 tab
  无法区分;按**"我实际抓过的 URL/id"**匹配回收(F-3"只收自己开的"在 bridge 上靠这个落地)。
- **adapter 取数三类(E-17 更正,原以为两类)**:① pipeline(HN/lobsters)真不开 tab;② browser:false
  func(wikipedia/arxiv)开**宿主 tab**(站点 base、不导航、data 走 SW 代理——别误判成用户 tab,E-2 就栽这);
  ③ browser:true func(zhihu/bilibili/weibo/douban/youtube/instagram)**导航 tab**(串行复用、并发→池)。
  ②③ 在 bridge 下残留要手动收(真机 reaper 会收)。
- **HN 搜短词用 relevance**:`hackernews__search` + `sort:date` + 短词(如 "Rust")会被 Algolia 容错匹配
  (must/Bust/Trust…)污染;用 `sort:relevance` 或按标题后过滤(非 bug,F-6 的 query 生效)。
- **取"高赞"要 detail**:`zhihu__question` 答案 content 截 ~200 字、`sort:default`+小 limit 非严格按票 →
  真·最高赞可能不在默认前几;要全文/最高赞用 `zhihu__answer-detail` 或 sort 票数 / 加大 limit。
- **临时 load 是测未装 adapter 的正道**:`find_adapters`→`load_adapter`(不安装/不落盘/SW 重启失效/不占
  常驻 token);测试一律用它,别 `install_adapter`(会进每轮工具表占 token)。
- **(测试工具链)zsh 不 word-split 未引用变量**:`for id in $ids` 只跑一次整串 → 用 `${=ids}` 显式 split;
  `mapfile` 是 bash-only;`while read` 漏无尾换行的最后一行。bridge 测试的 cleanup 脚本反复踩这几个。
- **`Unexpected token '<', "<!DOCTYPE"` = 登录墙**(F-22):应返回 JSON 的读拿到 HTML 登录页就这么报;
  agent 据此诊断"需登录"(配合"开的 tab 停在 /login"),别当成解析 bug。公开内容(如 IG 公开号)常不撞墙。
- _(随测随补)_

### F-37 站点脚本带 js 默认 document_start → 读 DOM 全空 + 错误静默吞掉(2026-07-06,页面↔LLM 桥真机验证发现)

**症状**:agent 为夹具页(llm-bridge.html)生成的 llm_access 双语翻译脚本,创建成功、
确认框正常,但刷新页面后 #status 不变、无 .zh 插入——脚本"看起来根本没跑",
且没有任何报错可查。

**根因**:两层叠加。① `create_site_script` 工具层没暴露注入时机,`buildSiteScript`
对所有脚本默认 `runAt: document_start`——js 在 body 尚未解析时执行,`querySelectorAll`
读到空、`#status` 也不存在;② 注入包装 `try{js}catch(_e){}` 把异常完全吞掉,
坏脚本与从未注入不可区分。

**修法**(feat/page-llm-bridge 分支):① 带 js 的脚本默认 `document_idle`
(纯 css/hide 仍 document_start 防闪烁);② 工具新增 `run_at` 参数(enum)+
描述明确"js 立即读 DOM 别用 document_start,要更早介入用 MutationObserver";
③ catch 改为 `console.error('[web-site-script]', e)` 落页面控制台。
单测:默认时机矩阵 + console.error 存在性(tests/page-llm.test.ts)。

**教训**:① 给 LLM 用的工具,凡有"时机/环境"隐含假设(DOM ready、登录态、
viewport)都要么暴露成参数、要么把安全值设为默认——模型不会自己想到 document_start
时 body 是空的;② 静默吞错的包装层在"生成的代码"场景是调试灾难:生成物首次运行
即失败时,必须有一条可观察的报错通道。

**验证**(bridge 驱动,2026-07-06):重建同 label 脚本后刷新夹具页,后台 tab 中
`#status="bridge: ok3"`、3 段 `.zh` 中文插入原文下方、翻译质量良好——页面↔LLM 桥
(H11 P1)端到端打通;MAIN world 无 chrome.runtime.sendMessage(信任边界)同轮确认。

### F-38 页内 LLM 返回的 JSON 带围栏/夹杂文字 → 页内解析三连败(2026-07-06,HN 双语真机)

**症状**:用户只给目标(「打开 HN 时标题自动翻译成中文」),agent 方法论全对
(看 DOM → preview → 创建 → 刷新验证 → 读 #status 自查),但 5 次 create_site_script
才成功——中间三轮都败在同一处:`__webLLM.call` 返回的"JSON"带 markdown 代码块
包裹或夹杂说明文字,页内 `JSON.parse` 失败;agent 先加容错、再换解析、最后放弃 JSON
改用编号行格式才通。

**根因**:桥把模型的**生文本**原样丢回页面,让每个生成的脚本自己解决"模型不守
JSON 纪律"——而这个问题引擎侧早已集中解决过(parseToolArgs 的剥围栏/修复阶梯)。
教科书级的"同一鲁棒性问题在新表面重新出现"。

**修法**(feat/page-llm-bridge):`__webLLM.call(prompt, {json:true})` —— SW 侧
①在 system 末尾追加"只输出 JSON 本体"提示;②返回前 `extractJsonPayload`(直接
parse → 剥 ```json 围栏 → 从散文里取首尾括号块,均校验后才接受),失败则明确报
「模型没有返回可解析的 JSON」。工具描述改为**要结构化输出必须传 {json:true},别
自己在页面里写 JSON 容错**。单测:围栏/散文/干净/不可解析四态 + preamble 透传。

**教训**:桥这类"给生成代码用的 API",凡是引擎里已解决过的模型鲁棒性问题
(围栏、格式漂移),要作为**服务端选项**下沉进 API,否则每个生成物都要在真机上
重新踩一遍;判断信号就是 agent 在同一个坑连续迭代≥2 次。

### F-39 chrome://extensions「错误」页被已处理错误 + bridge 离线 WS 报错刷屏(2026-07-07,用户真机反馈)

**症状**:扩展管理页的「Errors」列表一片红:大量 `%c[web:%s]%c … page evaluate threw
[object Object]`、`api ← 429`、`chatCompletion failed`(全是**已被捕获并处理**的错误——有
重试/分类/用户提示),以及 bridge 未启动时每次重连都新增一条
`WebSocket connection to 'ws://127.0.0.1:8787/' failed: ERR_CONNECTION_REFUSED`。用户观感
=「扩展坏了」。

**根因**:①日志模块 `error()` 用 `console.error` 打印,而扩展错误收集器**照单全收**
console.error(还不认 %c 格式化、对象只显 [object Object]);对已处理错误这是误报。
②`new WebSocket()` 被拒是**浏览器层**日志,任何 try/catch 都压不住;`want=true` 但 bridge
没跑时,指数退避的每次重试都添一条。

**修法**:①`log.ts emit`:error 级别**打印降为 console.warn**(LogEntry 仍记 error 级,
应用内日志页分类不变);真正的意外崩溃(如 panel ErrorBoundary)仍直接 console.error、
照常进错误页——错误页只留"真坏了"的信号。②`bridge-client.connect`:先
`fetch /ping(1.5s 超时)`探活——fetch 失败只是可吞的 rejected promise;**探活通过才
`new WebSocket`**,离线期零 WS 报错。

**教训**:console.error 在扩展语境里不是"打日志"而是"向用户报障"——已处理的错误走它
等于狼来了;无法捕获的浏览器层报错(WS 拒连),用**可捕获的探针**(fetch)前置挡掉。

### F-40 `generic__web_search` bing 在中国网络 7/7 返回 0 结果(ready 选择器等在容器上、抓早了)(2026-07-16,用户真机会话 s_mrn7dcjk)

**症状**:一个会话里 `web_search` 对 bing 连发 7 次(含 `wigolo github`、`wigolo MCP`、
用户确认自己浏览器能搜到的 `Firecrawl vs Exa vs Tavily…`),**全部 `count:0`**;同会话
google 2/2、duckduckgo 2/2 正常。每次 bing 返回 `wait.reason:"selector"`、
`readyState:"interactive"`,`page_url` 是 `cn.bing.com/search?…`(www.bing.com 在国内 302 到
cn.bing.com)。

**根因**:**不是选择器 bug,是抓早了(timing)**。把 cn.bing.com 实际 SERP 存成夹具
(`tests/fixtures/cnbing-serp.html`)跑 `extractSerp('bing')` → **9/9 结果、直链外链、标题+摘要
齐全**,证明抽取算法对真 DOM 完全正确。真机失败是因为 ready 选择器只等**容器** `li.b_algo`:
cn.bing 流式输出时,第一个 `<li class="b_algo">` **前置塞了一大坨内联 CSS `<link>`**(几十 KB)
才轮到 `<h2><a>` 内容;`li.b_algo` 一出现(readyState 还 interactive、里面只有 CSS)
`waitForPageReady` 的 selector 短路就返回,`extractSerp` 在结果锚点解析出来前就跑 → 0。
google/ddg 的 ready 选择器本就指向**内容**(`a h3` / `.result-link`)、且不前置 CSS,所以没中招。
www→cn 跳转**不是**主因:抓取时 `location.href` 已是 cn.bing.com。

**修法**(纯健壮性,不改选择器、不写死区域):①`buildEngine` 每个引擎的 ready 选择器改为等
**结果链接**而非容器:bing `li.b_algo` → `li.b_algo h2 a`;google `#search h3` → `#search a h3`;
ddg 也统一到 `a.result-link`。②func 里加**零结果重试**:非 blocked 且 `results.length===0` 时
`sleep(700)` 再抽,最多 3 次(引擎无关的兜底,防任何流式/水合滞后;blocked 页短路不重试)。
夹具回归测试 2 条并入 `generic-web-search.test.ts`(共 10/10)。tsc/eslint/两壳 build/全量 1890 测试全绿。

**教训**:①SERP/流式页的"就绪"要等**内容锚点**,别等容器——容器可能先出现且被前置资源撑着,
`readyState:"interactive"` 下短路会抓到半成品。②"选择器对不对"和"抓的时机对不对"是两件事:
先把真机的 DOM 存成夹具喂给现有算法,能一刀切开这两类根因(这次一测就排除了选择器,直指 timing)。
③零结果不等于无结果——对易变/流式来源加一个便宜的**重试兜底**比调选择器更耐久。

**后续(2026-07-16 同日,用户确认 bing ✅ 后的加固)**:借 F-40 把 web_search 从"单引擎脆抓"升级为
"级联+兜底",让任何单点失效都不致命——① **引擎级联**:不指定 engine 时按 `google→bing→duckduckgo`
依次尝试、取第一个出结果的(`tried[]` 记轨迹);② **`max_wait_ms` 可调**(默认 12000,不写死),
慢/重页用户或 agent 可调大重试;③ **文本回退**:三家都解析不出结构化结果(selector 失效 / SERP 变
/ 验证页)时,回退返回 SERP 的**可见纯文本**(`fallback:"text"`+`text`),agent 仍能读懂——这条
open_url→get_page_text 的路子也正是**自定义/不原生支持的引擎**的通用走法(只是没有结构化解析)。
单测扩到 15/15(加 parseEngine 级联/别名、buildEngine URL+ready 选择器断言)。
状态:✅ bing 用户真机确认已修;二轮增强(级联/max_wait_ms/文本回退)🔧 已测离线、真机待验。

### F-41 `manage_tabs back/forward` — `chrome.tabs.goBack/goForward` 在 agent 窗口/debugger 附着的 tab 上假报"无历史"(2026-07-16,经 bridge 真机测试发现)

**症状**:新增的 `manage_tabs(action:"back"/"forward")` 经 bridge 真机测,**每次都 `navigated:0`、
不动**。复现:`open_url nav.html` → `click #toB` 导航到 interactive.html(url 确实变了)→ `back` →
无效。换 explore tab 用两次 `open_url` 造真实历史后同样失败。

**根因**:**不是历史缺失,是 `chrome.tabs.goBack` 本身在这类 tab 上不灵**。用 `eval_js` 直接探测:
`history.length === 3`(about:blank+nav+interactive,**历史确凿存在**);且**在页内跑 `history.back()`/
`history.forward()` 完美工作**(interactive↔nav 双向都对)。但 `chrome.tabs.goBack(tabId)` 仍抛一个
"无历史"类错误——manifest **已声明 `tabs` 权限**(排除权限缺失),推测是后台 agent 窗口 /
非聚焦 / `debugger` 附着(explore 用 CDP)的 tab 上 `chrome.tabs.goBack/goForward` 的已知脆性。

**修法**:back/forward 改为**注入 `history.go(±1)`**(`chrome.scripting.executeScript`)而非
`chrome.tabs.goBack/goForward`——① 真机 `eval_js` 已证 `history.back()/forward()` 在同环境可靠工作;
② 同权限面(scripting,到处在用),无需新权限;③ 跨文档导航 OK。边界处是无副作用的 no-op
(同浏览器后退键),`navigated` 表"已触发"、agent 读 url 确认移动。单测改走 `chrome.scripting`
mock(不可注入 tab→errors、死 tab→not_found),tab-manage 10/10;两壳 build、全量 1930 全绿。

**教训**:①`chrome.tabs.goBack/goForward` 别信——在 agent 常态(后台/受控/debugger 附着的 tab)会
假报无历史;**页内 `history.go()` 注入更稳**,且权限面更小。②诊断"动作没生效"先用 `eval_js` 把
**真相探出来**(`history.length` + 页内 `history.back()`),一步就把"历史缺失"和"API 脆性"两条根因
分开——省掉反复 rebuild/reload。③附带纠正:manifest **早已有 `cookies`/`downloads` 权限**,
之前说 get_cookies/downloads"要新权限"不准;它们没做是因为**定位**(不属浏览器动作原语),不是权限。
状态:🔧 已修 + 单测过;**用户最终真机复测 back/forward 待确认**(底层 `history.go` 机制已 bridge 实测通过)。

### F-42 `list_webmcp_tools` 算出了 `source` 却没往外返回(2026-07-29,经 bridge 真机测试发现)

**症状**:夹具 `webmcp.html` 注册两个页面工具,`list_webmcp_tools` 正确返回
`supported:true count:2` + 两个工具的 name/description/inputSchema,但 **`source` 恒为
`undefined`**。而 `docs/webcli.md` §14.5 明写着"回报哪个入口命中(`source`)"——文档描述的契约
在真机上是假的。

**根因**:页内探测函数把 `source` 算好了(`if (found) out.source = found.source`),但 `cli()`
的 `func` 手工重组返回对象时**漏了这一个字段**:`{tabId, url, supported, api_present, count,
tools, probed, note?, hint?}` —— 一个白名单式的转发,新增字段只要没写进去就静默消失。

**修法**:`...(r.source ? { source: r.source } : {})`。

**教训**:**手工白名单转发是"字段静默丢失"的温床**,而 tsc 帮不上忙——`r.source` 存在于源类型
里,不转发不是类型错误。这类 bug 只在"文档承诺 A、实现返回 B"的比对里露头,而离线单测测的是
探测函数(它是对的),恰好跨不过这条缝。**凡是文档里写了"会返回 X"的字段,真机跑一次读一眼返回**
——本条就是这么抓到的,成本一次调用。

### F-43 `fill_form {submit:true}` 在最后一个字段是 contenteditable 时静默什么都不做(2026-07-29,经 bridge 真机测试发现)

**症状**:6 字段批量(最后一项是 `#note`,contenteditable)+ `submit:true` → `filled:5/6`
正常,但夹具 `#status` 里**没有 `form:submitted`**,表单根本没提交,且**没有任何报错或提示**。

**根因**:提交路径取的是 `lastEl.form` —— `.form` 只存在于**表单控件**(input/select/textarea)
上。contenteditable 是个 `<div>`,`.form` 为 `undefined`,于是 `requestSubmit()` 那一支整个跳过;
而在 div 上派 Enter 键事件不会触发提交。富文本框做表单最后一个字段**非常常见**(留言、备注),
所以这不是边角。

**修法**:`lastEl.form ?? lastEl.closest('form')` —— contenteditable 在 `<form>` 里时也能找到。

**教训**:**"取一个只有某类元素才有的属性"必须配一个对所有元素都成立的兜底**。同时这是一条
**静默失败**:工具报了 `filled:5/6` 一切正常,唯一的破绽是页面副作用没发生——如果夹具没有把
提交写进可读 DOM(`form:submitted`),这条测试会以"通过"结案。再次印证 fixtures 那条
「效果要能被读工具观测」的约定不是形式主义。

### F-44 「截图用 jpeg 省 token」是错的:平坦 UI 页上 jpeg 比 png 还大(2026-07-29,经 bridge 真机实测)

**症状**:给 `screenshot` 加完 `format/quality/max_width` 后,工具描述、`WEBCLI_INSTRUCTIONS`、
webcli skill 三处都写了"`format:"jpeg"` 通常能把体积砍到几分之一"。真机实测直接反例:

| 页面                               | png    | jpeg q80         | webp q80 | jpeg + max_width |
| ---------------------------------- | ------ | ---------------- | -------- | ---------------- |
| 夹具 `fill-form.html`(平坦色块 UI) | 141 KB | **157 KB(更大)** | 63 KB    | —                |
| Wikipedia 图文页                   | 985 KB | 574 KB           | 357 KB   | 134 KB(mw=1024)  |

**根因**:JPEG 的 DCT 对**大面积纯色 + 锐利文字边缘**是最坏情况,而这恰好就是 app UI 截图的
全部内容;PNG 的行滤波 + deflate 在纯色块上反而极高效。WebP 两种页面都赢(0.36–0.45×),
因为它同时有有损模式和更好的无损/预测编码。而**最大的杠杆根本不是编码器,是分辨率**:
`max_width:1024` 一项就是 ~4×(像素数按平方降)。

**修法**:三处措辞改成 **「先 `max_width`,有损选 `webp`,别反射性用 jpeg」**,并把"jpeg 在
平坦 UI 上会比 png 大"这条反直觉事实直接写进工具描述(附实测数字),因为 agent 只读描述。
`docs/webcli.md` §14.1 同步改。

**教训**:**"业界常识"级别的性能断言也要在自己的负载上量一次再写进给 LLM 的描述里**。这条
guidance 是我照 chrome-devtools-mcp 的 `--screenshotFormat`(它默认 png,并未推荐 jpeg)自己
推演出来的,推演方向反了——而它会被每个 agent 读到并照做,错的 guidance 比没有 guidance 更贵。
另外:agent 截图的**主流负载是 app UI,不是照片**,以后凡是给截图/图像相关做优化,基准页要用
UI 页而不是图片页。

### F-45 夹具用 `setInterval` 镜像状态 → 后台 tab 被节流,读回来永远慢一拍(2026-07-29)

**症状**:`fill-form.html` 用 `setInterval(dump, 250)` 把各字段当前值写进 `#dump`。经 bridge 连续
两轮 `fill_form` + `get_page_text` 断言,读回的 `#dump` **恒为上一轮的值**,看起来完全像
"`fill_form` 报告 `filled:4/5` 但其实没写进去"——一度按工具 bug 去查。

**根因**:那个 tab 是 `active:false` 开的(agent 的常态),**Chrome 把后台 tab 的 `setInterval`
节流到约每分钟一次**,`dump()` 根本没跑。同步写入的 `#status`(在各 `input`/`change` 监听里)
一直是准确的,两者一对比就定位了。

**修法**:`mark()` 里同步调 `dump()`,`setInterval` 只留作"没有事件的状态变化"的兜底。

**教训**:和 [F-27](#) 同一族(后台 tab + rAF 被节流)。**夹具的可观测量必须在事件处理里同步写,
不能挂在 timer/rAF 上**——否则夹具自己会制造假阴性,而假阴性最贵:它让你去改一个没坏的东西。
写新夹具时按这条自查一遍。

### F-46 relay 的 `ready` 帧在真机上必然竞态:document_start 的 postMessage 赶在页面监听器之前派发(2026-07-30)

**症状**:`relay-client.html` 主链路真机首跑 `no-relay`;加了 DOM 标记后复跑,轨迹是
`marker:hjdccc init:… call:ok` 而 **`relay-ready` 一次都没出现** —— ready 帧确实发了,
但派发进队列的时刻页面 `<body>` 里的脚本还没执行、监听器不存在,帧被丢弃。

**根因**:`window.postMessage` 是异步任务;document_start 注入的中继先于 HTML 解析完成运行,
它 post 的 ready 在下一个任务派发,而小页面的解析+内联脚本何时让出任务队列无保证——实测这台
机器上 ready 总是先于监听器。"attach 早 ⇒ 页面一定收到" 是错觉。

**修法**:双信号。① 中继在 document_start 同步写 `document.documentElement.dataset.webcliRelay = <extId>`
——页面任何时刻**同步**读,无竞态,且顺带解决"到底注入没注入"的可观测性(错 host 的 `marker:none`
和错端口的 `marker:yes`+超时因此可区分);② ready 帧保留,仅对已在监听的 SPA 是加速。页面侧协议:
**以标记为首选检测**,没收到 ready 也可直接发帧(`ext` 可省略,从回帧学),README 已改。

**教训**:凡是「注入脚本 post 一条 announce 给页面」的设计,默认它会竞态,必须配一个**可同步轮询的
带内状态**(DOM 标记/属性)。以及:这个 bug 在单测里不可能出现(jsdom 没有解析器让出时序),
只有真机 + 把负例做成可观测(`no-relay` 也写进 #status)才能捉到。

### F-47 `manage_tabs` 把错误当**返回值**吐出来,于是 `ok:true` 说的是「成功」而不是「失败」(2026-08-06,localmd Connect 联调时踩到)

**症状**:联调收尾要验一条刚建的站点脚本是否在**新页面加载**时生效——`manage_tabs
{action:'reload', tab_id: N}` 返回 `{"ok":true, "result":{"error":"reload requires tab_ids"}}`,
但我只看了 `ok`,当它 reload 成功了;随后读到元素仍是 `display:inline-block`,于是判定
**站点脚本坏了**,差点去查 userScripts 注册链路。实际站点脚本一直是好的——换一个全新 tab
打开立刻 `display:none`,是那个 tab 压根没重新加载(它是脚本创建**之前**载入的文档)。

**根因**:两层叠加。① `tab-manage.ts` 里 8 处参数校验写的是 `return { error: '…' }`——
错误是**返回值**不是异常,而执行器只把**抛出**归类为失败,于是错误被裹进一个成功的信封。
② 参数名是 `tab_ids`(复数),而工具面里**其余每个 tab 工具都叫 `tab_id`**;`validateArgs`
对「未知的多余参数」是宽容的(只对缺失的必填参数严格),所以按类比写单数 = 参数被静默丢弃 +
ids 为空 + 返回一个"成功的错误" = **静默 no-op**。

**修法**:8 处 `return {error}` → `throw new Error(...)`(错误就该是错误);`tab_ids ?? tab_id`
接受单数别名,arg help 里写明。测试同步改断言为 `rejects.toThrow`,并新增别名用例——原测试
断言的是旧的错误形状,它挂掉正是变更该有的动静。

**教训**:**「错误作为返回值」在 LLM 工具面里比在人类 API 里危险得多**——人类会读 error 字段,
模型(和赶时间的我)读的是 `ok`。工具契约只有一条:失败必须让信封是失败的。另一条:同一族工具
里**参数名不一致**就是个陷阱,而"宽容忽略未知参数"把陷阱变成了静默陷阱——宽容要么配别名,要么
配警告,不能只是丢弃。第三条:这个 bug 三个壳都有、上架的 WebCLI 里也有,**只有真机联调能撞见**,
因为单测调的是 `tool.func` 直接拿返回值,根本看不见"信封"这一层。

### F-48 cockpit 徽章在三个壳里都自称 "Web Agent"(2026-08-06,用户在 localmd Connect 联调时肉眼发现)

**症状**:localmd Connect 驱动页面时,右上角浮层写的是「🤖 Web Agent is working」——用户装的是
localmd Connect,页面却报另一个产品的名字。

**根因**:`_agent-cursor.ts`(**通用**工具集,三壳共用)里 `badge.textContent = label || '🤖 Web
Agent is working'`,而 `click`/`type_into`/`hover`/`select_option` 全部传 `label: undefined`,
于是**永远**走硬编码兜底。WebCLI 上架版同样一直在打错名字,只是没人盯着看。

**排查中我自己也错了一次**:先 grep 了 `armAgentMask`(localmd bundle 里确实是 0),就断言
"这是全量扩展留下的僵尸遮罩"——查错了模块。用户坚持"不应该改成 localmd Connect 吗",复查
`grep -rl __wa_badge dist-localmd/` 才发现本壳的 bundle 里就有。**教训:一个符号为 0 不能证明
一个功能不存在,要 grep 的是那个可见字符串本身。**

**修法**:`flashAgentCursor`(跑在 SW,读得到 manifest)缺省时从 `productShortName()` 取名——
与 tab-group 标题**同一个来源、同一套 `shortLabel`**;页面内兜底改成不含产品名的
「🤖 Agent is working」,这样将来漏传的调用方最多笼统,不会张冠李戴。

**教训**:与 §10.47 的 tab-group 标题是**同一个教训的第二次发作**——共享代码里任何面向用户的
产品名都必须从 manifest 派生。当年只修了 tab 组标题,没有去搜"还有哪里硬编码了产品名",于是
同一个 bug 在另一个表面上又活了半年。修一类 bug 时,要把**这一类**都搜一遍。

### F-49 商店拒收带 `key` 的 zip,而我们的 manifest 故意带 `key`——这个坑踩了不止一次(2026-08-07)

**症状**:上传 localmd Connect 的 zip,dashboard 报
_"There was a problem uploading your file. Please try again. key field is not
allowed in manifest."_ 用户明确说**不是第一次出现**。

**根因**:两个都对、但组合起来是坑的事实。① 我们的 manifest **故意**带 `key`
——那是 unpacked 加载时钉住扩展 id 的唯一手段,dev 构建可寻址、id 可复现全靠它
(`webcli-releases.md` §1)。② 商店从 CRX 签名分配身份,**拒绝**一个试图自己声明身份的
manifest。于是「直接 zip 掉 `dist-*/`」这个最自然的动作必然产出被拒的包。

**而文档在这件事上给了错误的保证**:`webcli-releases.md` §1 原文写着
「leaving `key` in the uploaded zip is **harmless**」——那是我从「商店会忽略 key」
**推断**出来的,从没验证过。一句未经检验的推断被写成结论,又被后续每一次发版信任。

**修法**:`scripts/pack-store.mjs`(`npm run pack:webcli` / `pack:localmd`)。要点是
**在暂存副本上剥离 `key`,绝不动 `dist-*/` 本身**——构建产物必须保持可 unpacked 加载
且 id 稳定,一个就地修改它的步骤会悄悄把这个性质拿走。脚本还顺带断言 `manifest.json`
在 zip 根、`key` 确实没了,失败就非零退出。§1 的错误结论已改正。

**第二次踩(同日)**:修好脚本后**又被拒一次**——因为脚本用 `os.tmpdir()` 写文件,macOS 上那是
`/var/folders/…/T/`,而所有文档和口头交代都说包在 `/tmp/`。于是 `/tmp/` 里那个**同名的**手工旧包
(带 key)还躺着,用户传的是它。脚本明明打印了正确路径,但**同名文件存在于两个位置**时,人会按
记忆去拿,不会读输出。已改成写死 `/tmp` 并先删同名文件。

**教训**:**「A 会忽略 B」推不出「带着 B 是安全的」**——忽略和拒收是两种行为,中间隔着
一次实测。更要紧的一条:这个坑之所以反复踩,是因为防线是**清单里的一句散文**,而人会忘;
凡是「每次发版都必须记得做的机械动作」,正确的落点是**脚本**,不是文档。文档该写的是
**为什么**,脚本该做的是**保证**。而第二次踩补上了这条的后半句:**自动化还必须消灭旧路径**——
一个产出物如果可能出现在两个位置且同名,那自动化只是把陷阱挪了个地方。输出位置要可预期,
并且主动删掉同名的历史产物。

### F-50 表格单元格用 `textContent` 拍平 → 表格布局的页面剪出来一个链接都没有(2026-09-03,localmd Connect 剪藏器真机测试发现)

**症状**:用户报「`get_page_text` 没拿到链接的 url,后续想读某个链接的详情还得重新读一遍页面」。
真机复现:`clip_page {url:"https://news.ycombinator.com/", mode:"full"}` 返回 12244 字的
markdown、**0 个链接**。

**根因**:两层,只修一层没用。① `format:"text"` 走 `innerText`,本来就不含链接——这层是设计。
② `format:"markdown"` 走 `extractPageMarkdown`,`A` 分支确实产出 `[text](href)`,但 `href`
**原样写出**,相对路径到了模型手里没有 base 就没法跟。③ 真正致命的是 `tableToMd()`:它对每个
单元格取 `c.textContent`,而 `textContent` 会把标记**整个丢掉**。HN 是纯 `<table>` 布局,
于是每一个链接都在进入 `A` 分支之前就被拍平成了纯文本——**修好 ② 对 HN 一点用都没有**。

**修法**:① `A` / `IMG` 的 href/src 一律用 `new URL(target, doc.location.href)` 解析成绝对地址
(tab 路径和 `fetch_url` 原始路径都传 `location.href`,所以两条路一致)。② `tableToMd` 改成把单元格
内容交给**同一个 walker**(新的 `cellToMd`),块级标记折成一行、字面 `|` 转义。顺带修掉一个既有
bug:`querySelectorAll('tr')` 会钻进嵌套表格,布局表里每个内层行会被输出两次——现在用
`closest('table') === table` / `closest('tr') === tr` 只取本表本行。HN item 页复测:链接从 0 变 17。

**没改的**:`format:"text"` 默认值仍然不含链接。改默认值会同时影响三个壳的 `get_page_text`,
风险不对等;改为在 `LOCALMD_CONNECT_INSTRUCTIONS` 里明说「接下来可能要跟链接就用
`format:"markdown"`」。

**教训**:**一个症状可以有两个独立的根因,先找到的那个会让你停下来。**「链接是相对路径」是个真
bug,修完看起来也像修好了——但在真正报障的那类页面上,链接早在另一条代码路径里就没了。
判据很简单:**修完必须回到最初那个页面上验证**,而不是在自己造的夹具上验证。

### F-51 「正文密度选择器」在 `<main>` 内部再 narrow 一层,把 MDN 文章的导语丢了(2026-09-03)

**症状**:给剪藏器加了 readability-lite 的正文密度打分(段落类元素给父节点计分,得分最高者胜出)。
自造夹具全过。拿四个真实页面离线跑对照,MDN 的 `Range` 参考页 `before=8054 → after=4610`,
**丢掉 20/66 行实质内容**,第一行就是 "This feature is well established…" ——文章导语和兼容性说明。

**根因**:打分只统计**段落类元素**(P/PRE/LI/BLOCKQUOTE/TD)的文字量,而 MDN 的方法列表是一堆长
`<li>`,导语只有几个短 `<p>`。于是「方法列表占了 `<main>` 里段落类文字的 60% 以上」这个门槛轻松
通过,选择器就把 `<main>` 收窄成了方法列表。**门槛用错了分母**:它衡量的是「候选块占段落类文字的
比例」,不是「占页面全部文字的比例」。

**修法**:不再在语义根内部收窄。页面自己声明了 `<main>` / `<article>` / `[role=main]` 就**信任它**,
密度打分只在**没有**语义根时启动(HN 那种纯表格布局、无语义标记的页面——正是它被发明出来要解决的
场景)。四页对照复测:MDN / Wikipedia / GitHub 全部 100% 无损,HN 仍然只丢顶部导航、外层包裹行和
页脚,故事与全部评论连同链接都在。

**教训**:**自造夹具只能证明你实现了自己设想的规则,不能证明这条规则对。** 这个打分器在我写的夹具上
100% 符合预期,是四个真实页面把它证伪的——而代价本来会很大:`extractPageMarkdown` 是三个壳的
`get_page_text` 共用的,一次悄悄丢正文的收窄会影响所有下游。凡是「启发式地决定丢掉哪部分内容」的
改动,**验收必须是真实页面的语料对照**,而且要拿**改动前的行为**当基线、逐行报告丢了什么——只看
「新结果看起来不错」是发现不了这类问题的。另一条:**丢真内容比留下杂质坏得多**,启发式在拿不准时
应该退回到「全都要」。

### F-52 「笔记没写出来」——其实写出来了,我查错了目录,然后基于这个错误结论连造了三个假说(2026-09-03)

**症状**:剪藏链路真机联调的最后一段。用户点了「Clip page to localmd」,收件箱确实收到了
条目,但 `ls ~/code/trace/inbox/` 是空的。于是判定「localmd 的 drain 没跑」,开始查扩展为什么
没推送通知。

**接下来花掉的时间**:三个假说,依次是 ①MV3 SW 被回收后广播名单(内存 Set)清空、页面的
Port 断了不会自己重连;②`onClientReady` 没触发;③`inboxCount()`(`store.count()`,唯一没被
验证过的 IDB 调用)挂住或返回 0。每一个都成立得像那么回事,还翻了 relay content script、
核心的 `handleRpcMessage` 分支、`withStore` 的事务竞态。

**根因**:`writeClip` 走的是 `landingPathFor(name, await usesRawLayout())` —— 用户的 KB
**有 `raw/` 目录**,所以笔记按设计落在 `raw/articles/`,不是 `inbox/`。**功能从头到尾就是好的**:
笔记 13 KB、frontmatter 完整、正文含表格、图片是真实 PNG。是我只 `ls` 了一个目录就下了结论。

**修法**:`find ~/code -name "Three sites*"` —— 一条命令,本该是第一条。

**为什么会这样**:用来证伪的那次检查(`find ~/code/trace -name "*.md" -newermt "-20 minutes"`)
跑在 drain 之前,返回空;后来条目消失时我没有重跑它,而是把「条目消失 + inbox/ 空」直接读成
「ack 了但没写」。**一个过期的阴性结果被当成了当前事实。**

**教训**:三条,按重要性排。

1. **「东西不在」是所有结论里最不该靠单点观测下的那一个。** 断言某个产物不存在,搜索范围必须
   覆盖它可能出现的全部位置——而「它会落在哪」恰恰是代码里一个**条件分支**决定的
   (`usesRawLayout()`),我却按其中一个分支去查。凡是落点由条件决定的产物,验证要么全盘搜,
   要么先把那个条件读出来。
2. **在推进假说之前,先重跑那个把你送上这条路的观测。** 阴性结果有时效性,尤其在异步系统里。
3. 与 [[F-51]] 同源:那次是自造夹具证明不了规则对,这次是自造的检查方式证明不了结论对。
   **两次都是「验证手段本身没被验证」。**

### F-53 `chrome.history.search` 按访问时间**筛选**、却报告 URL 的**全局**最后访问时间——时间游标分页必然重复(2026-09-03,Phase 2 真机首测)

**症状**:`search_history` 连翻两页,第一页 5 条、第二页 5 条,**两页交集为 1**;且第二页并非
严格更旧。游标值形如 `1788419845017.464`(带小数——Chrome 的 `lastVisitTime` 是浮点毫秒)。

**根因**:分页设计成「按结束时间游标」——因为历史是时间序列,用偏移分页会在 agent 翻页期间
被新访问挤动。这个推理本身没错,**错在对 API 语义的假设**:
`chrome.history.search({text, startTime, endTime})` 筛选的是「该 URL 在窗口内**有过访问**」,
但每行返回的 `lastVisitTime` 是**这个 URL 的全局最后一次访问**,不受窗口约束。于是一个「最近看过、
很久以前也看过」的 URL,在窄窗口和宽窗口里**都命中**,而且两次都带着同一个(很新的)时间戳。
游标往前推一毫秒挡不住它——它的时间戳压根不在被推的那个位置。

**修法**:改成**在单次有界查询上做偏移分页**(`maxResults: offset + limit + 1`,多要一行用来判断
还有没有下一页),并给分页深度设上限 1000 行(每页都要重跑查询,无界分页等于为了拿尾巴向 Chrome
要整部历史);超过就报错让 agent 用 `query` / `days` 收窄。偏移分页那个「新访问挤动」的缺点还在,
但「偶尔错位一行」远好过「稳定重复一行」。

**为什么单测没抓到**:我的 `chrome.history.search` 假实现写成了
`rows.filter(r => r.lastVisitTime <= end && r.lastVisitTime >= start)` —— 即「按行自己的
lastVisitTime 筛选」。**假实现复刻了我对 API 的错误理解**,于是它忠实地验证了这个误解。真实
浏览器是第一个不同意的。现在假实现改成按 `visits[]` 数组筛选、报告 `max(visits)`,并种了一行
「最近 + 很久以前各访问一次」的数据;回归断言是「翻完所有页,URL 不重复,且不同页大小得到同一
个全集」。

**教训**:**一个 mock 只能验证你对被 mock 对象的理解,不能验证这个理解是对的。** 凡是 mock 的
是外部 API(尤其是「筛选条件」和「返回字段」不是同一个东西的 API),先去读一遍它的语义文档,
再让 mock 的形状由文档决定而不是由自己的直觉决定;能真机跑一次的,真机那次才是验收。
与 [[F-51]]([夹具证明不了规则对])、[[F-52]]([验证手段本身没被验证])同一族,这已经是第三次了。

### F-54 `preview_site_script` 把**语法错误**报成 `ran: true`——「跑了但什么也没做」和「压根没跑」不可区分(2026-09-03,Phase 3 真机测试顺带发现)

**症状**:用 `dry_run_js` 跑一段带顶层 `await` 的 JS,返回
`{"dry_run":{"ran":true,"logs":[]}}` —— 没有错误、没有日志、没有返回值。同一段代码去掉
`await` 就正常返回 `logs` 和 `returnValue`;而 `throw new Error("boom")` 能正确报出
`error`。所以工具**只在语法错误这一种情况下说谎**,而那恰恰是 agent 盲写 JS 时最常犯的错。

**根因**:`buildDryRunCode` 把用户的 JS **字面嵌进**一个同步 IIFE
(`(function(){ try{ ... }catch(e){...} })()`)。语法错误让**整个包装器**解析失败,于是那个
本该捕获它的 try/catch 根本不存在。Chrome 的 `userScripts.execute` 这时返回一个既没有
`result` 也没有 `error` 的帧,而 `dryRunSiteScriptJs` 里写着
`if (!out || typeof out !== 'object') return { ran: true, logs: [] }` —— 把「什么都没拿到」
当成了「跑完了,只是没输出」。

**修不了的那半**:本想在 try 里用 `new Function(js)`,让语法错误变成可捕获的运行时错误。
真机一试被 CSP 挡了:站点脚本注册和 dry-run 都用 `world:'USER_SCRIPT'` **不带 worldId**,
即默认 user-script 世界,而 `configureWebWorld()` 配的是**具名世界** `web-runner`。默认世界
没有 `unsafe-eval`(也没有 `messaging`,所以那里 `chrome.runtime.sendMessage` 也不存在)。
注册和 dry-run 用的是同一个世界,所以工具描述里「同一个执行世界」的说法是准确的。

**修法**:既然包装器只要能解析就必然返回对象,那「什么都没拿到」就是一个**可以确诊**的信号。
改成 `ran:false` + 一条指名道姓的错误:不能有顶层 `await`(这里是普通函数不是 async 函数)、
括号引号要配对、`return` 不能在函数外;并明确告诉调用者「运行时错误会带着自己的消息回来,
所以这是语法问题不是逻辑问题」。工具描述也补上了这个世界的两条限制(无顶层 await、无 eval)。

**教训**:**「拿不到结果」和「结果是空的」必须分开报。** 这两者在代码里长得一模一样
(`if (!out) return <success>`),但对读的人意义相反。判据:写下每一个 `return` 之前问一句
——**如果这条路径是失败,我这么写还能看出来吗?** 和 [[F-47]] 同类(`manage_tabs` 把错误当返回值),
只是那次是 `ok:true` 说成功,这次是 `ran:true`。凡是布尔字段叫 `ok`/`ran`/`found` 的地方,
都值得回头看一眼它在「什么都没发生」时取什么值。

### F-55 MV3 的 SW 一被回收,relay 的 Port 就死了,而**页面永远不会知道**——推送侧静默失效(2026-09-03)

**症状**:用户点了几次「Ask localmd」,跳过去之后 agent 会话里**什么上下文都没有**。查收件箱:
**9 条 ask 全部积压未处理**,localmd 一条都没 drain。而早些时候剪藏那条是成功落盘的,所以机制
本身是通的。

**确证**:重载 localmd 页面 → 9 条**瞬间全部消化**。所以「连接时收得到」(`onClientReady`),
「连上之后收不到」(`broadcast`)。

**根因**:Chrome 会在空闲几分钟后回收 MV3 的 service worker(扩展重载同理),连带干掉所有
`chrome.runtime.Port`。而 `onDisconnect` 只在**内容脚本**这一侧触发,relay 从来没把它转发给页面。
于是页面以为自己还连着、Tools 那一行还是绿的、扩展的每一次广播都发给了空气。
`McpRelayClient` 里 `onLost` 的注释白纸黑字写着「永远不会被调用:没有生命周期事件可观察」——
**事件是有的,只是在另一侧**。

**修法**:relay 在 `onDisconnect` 时 postMessage 一个 `{closed:true}` 帧;localmd 的
`McpRelayClient` 收到就 reject 所有在途请求并调 `onLost`,行变红,而 App.vue 早就有的
「窗口获得焦点时重试失败的行」把它自愈——重连触发 `onClientReady`,积压随即消化。**「回到那个
标签页」就是恢复动作,而「回到那个标签页」正是 Ask localmd 干的事。**

**改这一版时踩的小坑**:`closed` 帧没有 `msg` 字段,而 `onFrame` 开头就有
`if (!d || ... || !d.msg) return`。第一版把 `closed` 检查放在这道守卫**后面**,于是新帧被
无声丢弃、单测直接红。守卫的顺序本身就是协议的一部分。

**教训**:**「A 会在下一次调用时暴露」推不出「不需要主动告知」。** 当连接的意义之一是**对方可以
主动发起对话**时,「等下次调用才发现断了」这个方向就是反的——推送侧的失效不会产生任何调用去暴露它。
凡是引入 server→client 推送的地方,都要先问:**这条链路断了,谁会第一个知道?** 如果答案是「没有人」,
那这条链路就还没做完。与 [[F-52]] 呼应:那次是我自己没重跑观测,这次是系统里没有任何观测。

### F-56 「截图/剪藏/Ask/存标签页全都点了没反应」——一次读错的标签页把整个 popup 变成了死的(2026-09-03)

**症状**:popup 改版后用户报告:点截图按钮弹窗不消失、剪选区没结果、Ask 会话里什么都没有、
save tabs 也失败。四个功能同时坏,而它们前一版全是好的。

**根因**:新 popup 加了一句「这一页能不能捕获」的判断:
`for (const [b] of captureButtons) b.disabled = !s.capturable`。`capturable` 来自 SW 的
`userActiveTab()`,它用的是 `chrome.tabs.query({active:true, lastFocusedWindow:true})` ——
**而 popup 打开时,「最后获得焦点的窗口」可能就是 popup 自己**,那个窗口没有标签页,于是
`capturable:false`,五个按钮全部 `disabled`,点击被浏览器直接吞掉,没有任何事件、没有任何报错。
save tabs 那个按钮没被禁用,但 SW 里同样拿不到标签页,于是返回错误。

**两处修法**:① **popup 自己解析自己的标签页**(`chrome.tabs.query({active:true,
currentWindow:true})` 在 popup 里是明确的)并把 `tabId` 一起发给 SW;SW 收到就用它,拿不到才
回退到 `userActiveTab()`(键盘快捷键没有 popup,只能走回退)。② **判断失败时放行而不是禁用**:
只有在**确知** URL 且它不是网页时才禁用按钮。一次读不到就让整个界面失去反应,比试一下然后
拿到一句解释坏得多。

**顺带修的第三件**:截图和 Ask 现在**发出消息就立刻关闭 popup**,不再等回调。区域截图的回调
要等用户拖完框才来,而 popup 正压在要拖的那个页面上。

**验证手段本身的问题(这才是重点)**:我上一次「验证」popup 是把构建产物用 http 服务起来截了张图。
那个环境里 `chrome` 不存在,脚本在第一行 `chrome.runtime.getManifest()` 就死了——**我证明了排版,
对脚本一无所知**,而 bug 全在脚本里。现在补了 `tests/localmd-popup.test.ts`:在 jsdom 里加载真实的
`popup.html`、stub 掉 chrome、import 真实的 `popup.ts`、然后**真的去点按钮**,断言消息发出去了、
带着 tabId、以及「读不到页面时按钮仍可用」。写完立刻把旧行为改回去跑了一遍,确认它会红。

**教训**:**一张界面的截图不能证明这个界面是活的。** 凡是「点了没反应」这一类,截图、排版检查、
类型检查全都无能为力——它们看的是静态结构,而故障在事件是否真的被派发。UI 的验收必须包含
**一次真实的交互**:要么真机点一次,要么在 jsdom 里把脚本跑起来点一次。另外,
[[F-51]]/[[F-53]] 的那条在这里第三次成立:**新写的测试要先证明它能抓到你刚修的那个 bug**,
否则你只是增加了一个绿灯。

### F-57 扩展重载/更新后,已经开着的标签页里的内容脚本是孤儿——「只有刷新一遍才看到」(2026-09-03)

**症状**:剪藏、截图、Ask 都成功了,但打开 localmd 看不到结果,**必须刷新一次页面**才出现。
截图那条还额外把我们自己的呼吸边框和 loading 提示拍进了图里。

**根因(两个,叠在一起看像一个)**:

① `chrome.scripting.registerContentScripts` 只对**将来的导航**生效。扩展一重载(正式版则是自动
更新),已经开着的那些标签页里的旧脚本立刻变成孤儿——`chrome.runtime` 失效、relay 的 Port 断了,
而**新脚本不会被注入进去**。于是 localmd 那个标签页手里是个死 relay,推送到不了、
`onClientReady` 也没机会触发,直到用户手动刷新。这也是 [[F-55]] 当时反复出现的背景。

② localmd 的文件树不监听磁盘。drain 把文件写进去了,但树没重读,所以侧栏里看不见。

**修法**:① SW 在 `onInstalled`(安装和更新都会触发)里用 `chrome.scripting.executeScript` 把
`web-relay.js` / `page-tools.js` 重新注入到所有匹配的已开标签页;两个脚本都加了重入守卫
(`window.__localmdRelay` / `__localmdPageTools`),对已经有活脚本的标签页是空操作。
② drain 写完文件后调 `syncAfterFsChange()`。

**顺带修的第三件**:整页截图把**我们自己的界面**拍了进去。工作提示和呼吸边框是画在页面 DOM 里的,
CDP 截图当然会拍到。现在截图前后用一条 `display:none` 的样式规则把它们藏起来再恢复(用样式而不是
删节点,恢复后动画状态不变)。边框动画本身也是截图滚动拼接时不停重绘的东西之一,藏起来同时也减轻了
用户报告的闪烁。

**教训**:**注册一个内容脚本 ≠ 现在就在跑。** 凡是用 `registerContentScripts` 的地方,都要问
「已经开着的页面怎么办」——answer 必须是显式的一次 `executeScript` 补注入,并配一个重入守卫。
另一条更普适:**任何画在页面里的 UI 都会进截图**,自己的界面尤其容易忘,因为你不把它当"页面内容"。

### F-58 The relay ran with `EXT_ID === undefined` — every capability died at once, and a refresh could not bring them back (2026-09-03, regression from the F-57 fix)

**Symptom**: after the F-57 build, nothing reached the knowledge base any more: not
screenshots, not clips, not asks. Worse than before — a page refresh had at least
worked until then, and now it did nothing either. No error anywhere: no console
output on the page, nothing in the service worker log.

Evidence taken on the live browser before the fix, over the dev daemon
(`generic__query_dom` on both open localmd tabs):

```
<html lang="en" data-localmd-connect="undefined" data-theme="light">
```

**Root cause**: the F-57 commit added a re-entry guard to `web-relay.ts` and placed it
ABOVE the `const EXT_ID = chrome.runtime.id` line. The guard called `runRelay()`,
which reads `EXT_ID` synchronously. Function declarations hoist, so the call was
legal; the constant was not initialised yet.

Under ESM that is a `ReferenceError: Cannot access 'EXT_ID' before initialization`
— loud, and the new test proves it. But the shipped file is a content script that
esbuild bundles as an IIFE, and there it **lowers `const` to `var`**, so the same
code runs and `EXT_ID` is simply `undefined`. The relay then did three things in
order: marked the document with `dataset.localmdConnect = undefined` (the string
`"undefined"`), announced itself with `ext: undefined`, and installed a listener
whose first real check is "a frame naming another extension is dropped". localmd's
client reads the marker, echoes `ext: "undefined"`, and `"undefined" !== undefined`
— every frame the page ever sent was rejected as addressed to another install. The
port is opened lazily on the first forwarded frame, so it never opened; with no
port there was no push either. The whole channel was dead in both directions, and
a refresh re-ran the same broken script.

**Fix**: the two constants now sit above the guard, and the guard says in a comment
why it must stay below them. `tests/localmd-web-relay.test.ts` boots the real
module in jsdom with a stubbed `chrome` and asserts the marker equals the real id,
the `ready` frame carries it, a frame the page addresses reaches the port, a frame
naming another install is dropped, a push comes back with the id, `closed` is
posted when the port dies and the next frame redials, and a second injection
attaches nothing. Verified to fail against the old ordering (suite fails in
`beforeAll` with the TDZ error). Nothing in the repo imported this file before, so
nothing could have caught it.

**Lesson**: two things.

- **A module that runs on import gets its constants first, then its side effects.**
  Hoisted function declarations make "call it from the top" look fine and the
  bundler's `const`→`var` lowering makes the failure silent, so this class of bug
  passes tsc, passes the bundle, and passes the browser. Only executing the module
  catches it — the same lesson as F-56, one layer down: **the popup, the options
  page and now the relay each have a test that runs the real script**, because a
  script that dies or misfires on line 1 is invisible from every other layer.
- **When "everything broke at once", look at the one thing everything shares.**
  Clip, screenshot and ask have nothing in common except the relay. The first
  five minutes went to the individual features; the marker attribute answered
  it in one query. Ask for the shared layer's evidence first.

### F-59 A count-only inbox batch of full-page screenshots exceeded the relay frame — truncated to non-JSON, read as "empty", and every capture behind it stuck for good (2026-09-03)

**Symptom**: after F-58 the relay was healthy — localmd's Tools row said Connected
with the right extension id and all 51 tools — yet nothing the user captured
reached the folder: not screenshots, not clips, not asks. No error anywhere, and
a page refresh changed nothing.

Evidence over the dev daemon: `list_inbox` held 8 items; the same call returned
**28.6 MB** of JSON. Two full-page PNG screenshots of one article at 8.8 MB each,
a third at 7.9 MB, a clip with inlined images at 2.9 MB, two asks at 232 bytes
each behind them. The localmd Connect shell's outbound frame ceiling is 16 MB.

**Root cause**: three things, each reasonable alone.

1. `list_inbox` bounded a batch by COUNT (`limit`, default 5 / 10 from localmd)
   and never by bytes. Two full-page screenshots are two items and 18 MB.
2. The service worker's `sendToolContent` keeps a reply under `maxOutboundBytes`
   by cutting the text to 80% repeatedly and appending a note. That is right for
   prose and fatal for JSON: the result is not a shorter document, it is not a
   document.
3. localmd's `parseInbox` turned anything that failed `JSON.parse` into `[]`,
   deliberately, "rather than guessing" — so the drain saw an empty inbox,
   returned success, acked nothing, and the row stayed green. Every poke and
   every return to the tab repeated the same call with the same result; the two
   tiny asks were queued behind the elephants and never came up.

Why it appeared now: full-page capture landed in the interaction pass and was
verified with ONE screenshot (8.8 MB fits under 16 MB). The failure needs two.

**Fix**, at three layers:

- **Bytes, not just count.** `pickInboxBatch` (src/localmd-connect/inbox.ts)
  walks oldest-first and stops before the item that would cross
  `INBOX_BATCH_BYTES` (12 MB, pinned to ≤ 75% of `LOCALMD_FRAME_BYTES`, which
  the service worker now imports as its ceiling so the two cannot drift). It
  always returns at least one item so the queue moves; an item too large to
  travel even alone comes back stripped and flagged `oversized: true` with its
  size, and only by itself — never mixed into a batch of whole items that the
  reader acks as one. Since the ack path broadcasts `notifications/localmd/inbox`
  on every change, a queue of several batches drains itself: drain → ack → poke
  → drain.
- **Smaller at the source.** A whole page is now encoded as WebP at quality 85
  (`FULL_PAGE_FORMAT` / `FULL_PAGE_QUALITY` in region-shot.ts) — the one capture
  that is big by construction should not be lossless. The screenshot tool's own
  measurements put webp at ~0.4x of PNG. Region captures stay PNG. localmd names
  the file for the codec it arrived in instead of hard-coding `.png`.
- **Failure is visible.** localmd's `parseInbox` now throws on text that is not
  JSON (the drain's catch swallows it, but it is a thrown error in the console,
  not a success). An `oversized` item is acked with a console warning naming the
  page and its size, so what is queued behind it arrives.

Tests: `tests/localmd-inbox-batch.test.ts` (budget, at-least-one, oversized alone,
bytes-not-chars, budget/frame ratio, full-page codec) and localmd's
`connectInbox.test.ts` (non-JSON throws, oversized flag parsed and acked, WebP
named `.webp`).

**Lesson**: **a size limit on one side of a wire needs a matching limit on the
other side, or the wire has a silent failure mode.** The frame ceiling was set
with clips in mind and nobody asked what the producer of the largest payload
does when two of them queue up. And a defensive `return []` on a parse failure
is not defensive: it converts "the transport failed" into "there is nothing
here", which is the one thing the caller cannot distinguish from success. When
input is malformed, throw; let the layer that owns the error decide.

### F-60 "So many duplicates" — a queue delivered all at once, twenty pictures beside one note, and image links CommonMark does not read (2026-09-03, after F-59)

**Symptom**: the moment F-59 let the queue drain, the folder filled up: `-2`
and `-3` copies of the same notes, three screenshots of one page, and twenty
files `(99+ 封私信) 首页 - 知乎-2-1.webp … -2-20.png` interleaved with the notes in
`raw/articles/`. It read as duplication. One of three old screenshots of the
same page did not arrive at all.

**What it actually was** (checked file by file, md5 on the images):

- Nothing was written twice. The `-2`/`-3` notes are separate clips the user
  made of the same page at different times (three of one page across the
  afternoon), all held back by F-58/F-59 and delivered together; the three
  screenshots likewise (two queued, one new). Repeated gestures made *because*
  nothing seemed to happen — the cost of the earlier silence, not a new bug.
  A second tab of the app was open, but the deployed build has no drain, so
  the two-tab race (below) had not fired yet.
- The twenty files are the pictures of ONE clip of the Zhihu homepage —
  avatars, icons, covers, an ad pixel — all distinct, written **beside the
  note** by `writeClip`, in a folder that otherwise holds notes.
- Worse, the note referenced them as `![]((99+ 封私信) 首页 - 知乎-2-1.webp)`. A
  bare CommonMark destination cannot contain spaces or unbalanced parentheses;
  marked renders that as plain text. Every one of the twenty pictures rendered
  as its own source string. (Checked directly against `marked.parse`.)
- The missing screenshot was acked without a file. The item is gone, so its
  cause cannot be recovered from here; the permanent-drop paths in the drain
  (`parseScreenshot` / `parseClip` returning null) said nothing, which is what
  made it unrecoverable. They now warn with the page URL.

Behind it, two queue behaviours that the multi-batch world exposed:

- **A poke that arrived mid-drain was dropped** (the `running` guard returned
  early), and one drain was one batch. So of four batches, the poke pulled one
  and the rest waited for a coincidence — another capture, a tab switch. That
  is why the eight items trickled in over two minutes rather than at once.
- **Two tabs of the app on one origin both drain the same queue.** Both are
  poked, both list the same items, both write and both ack: every capture
  twice. Not triggered yet (production has no drain), certain once it does.

**Fix**:

- `writeClip` (localmd `lib/clip.ts`) files pictures where the folder files
  pictures — `landingPathFor` → `raw/images/` in a raw layout, the inbox beside
  the note otherwise — still named after the note, and writes the reference as
  a relative path with the syntax-breaking characters encoded
  (`markdownTarget`: space, parentheses, `%`; CJK left readable). The app's
  link resolver already `decodeURIComponent`s. Pinned by `clipWrite.test.ts`,
  including a marked round-trip that shows the old form did not parse.
- `drainInbox` (localmd `lib/connectInbox.ts`) is now rounds: one `list_inbox`
  + writes + one ack per round, repeated while the reply's `pending` says more
  is queued and the round made progress (bounded by `MAX_ROUNDS`); a poke that
  arrives while a drain runs marks it for one more look at the end. The
  receipts — tree refresh, the one-clip open, the ask draft — happen once per
  drain, and the draft combines the asks of every round instead of the last
  round overwriting the first. The whole drain runs under a Web Lock per
  server (`navigator.locks`, `ifAvailable`), so two tabs on one origin take
  turns; where the API is missing the drain simply runs.
- `parseInboxReply` carries `pending`; `parseInbox` is kept for callers that
  only want items.

**Not changed, deliberately**: re-clipping a page the KB already holds still
creates a numbered copy. The extension knows the page is saved (`kbIndex`, the
popup says so), and the alternative — overwriting the existing note — would
destroy edits the user made to it. Whether "Clip this page" on a saved page
should refresh, confirm, or copy is a product decision to take after real use,
not a bug fix. Nor were tiny images (icons, avatars, tracking pixels) filtered
at the source: the visible problem was placement and syntax, and a size floor
would be a guess.

**Lesson**: a burst of delayed deliveries LOOKS like duplication; check the
bytes before treating it as one (md5 took ten seconds and settled it). And
every Markdown you generate is parsed by a strict parser somewhere: a filename
is not a link destination until it is encoded as one.

### F-61 The popup claimed a page was saved at a path the user had deleted — a cache of the folder that nothing ever revalidated (2026-09-04)

**Symptom**: the popup on a page showed a green `Saved 9/3/2026` and the note's
path, for a note the user had already deleted in localmd. Reported as "the popup
panel is out of sync with localmd".

**Root cause**: `kb-index.ts` is a map of page URL → note path in
`chrome.storage.local`, written in ONE place — `ack_inbox`'s `written` argument,
when localmd says which file it wrote — and read by the toolbar badge, the popup
and `clip_page`'s `already_in_kb`. Nothing ever removed an entry. The extension
cannot see the folder, so it has no way to learn that a note was deleted or
moved; the module's own header called this out and dismissed it ("the worst that
does is a badge that is wrong until the next clip corrects it"). That estimate
was wrong in kind, not in degree: the badge is the extension's answer to "have I
already saved this?", and an answer that is confidently wrong is worse than no
answer at all.

**Fix — the folder's app revalidates, because it is the only side that can.**

- Two tools on the extension (surface 51 → 53): `list_saved_pages` returns the
  whole index, `sync_saved_pages` takes `forget` (URLs whose notes are gone) and
  `moved` (`{url, path}` for notes that turned up elsewhere). Entries are still
  only CREATED by `ack_inbox`; these two just let their owner correct them.
- `lib/connectSaved.ts` in localmd reads the index, checks each path with
  `fs.exists`, and only when something is missing walks the note cache to see
  whether a note declaring that `url:` in its frontmatter exists somewhere else
  — a moved note stays saved, which matters because the agent reorganizes the KB
  with consent. A candidate is verified with `exists` before being trusted: the
  note index can lag the disk, and swapping one dead path for another would be
  worse than forgetting.
- Run at three moments: on connect (what changed while nothing was listening),
  on `deleteEntry`/`renameEntry` in the files store (the moment the truth
  changes — imported lazily, since files sits under the store that owns the
  connection), and on every return to the tab (a note deleted from a terminal).
- The badge is repainted from `chrome.storage.onChanged` on `kbIndex:` keys, not
  only on tab activation — otherwise the tab being looked at keeps its green KB
  until the user switches away and back, which is the same complaint one layer
  down.

**Lesson**: **a cache of another system's state needs a revalidation path from
the moment it exists, not a comment explaining why staleness is tolerable.** The
header here reasoned about how *often* it would be wrong and never about what
being wrong *costs* — and the cost was the one thing the feature sells, that the
browser knows what the folder knows. When only one side can see the truth, the
protocol needs a direction for it to travel; here that meant admitting the index
to the tool surface, which is exactly the seam that already existed.

### F-62 A hand-written extension-page URL opened a blank tab, and a menu that pushed the buttons it sat above (2026-09-04)

**Symptom**: `chrome-extension://…/options.html#annotations` would not open —
the popup's Annotations entry produced a blank tab. Reported alongside two
interaction complaints: switching knowledge base threw the user into localmd's
tab, and the folder picker pushed the capture buttons down the popup.

**Root cause**, three separate ones:

① The bundler (`@crxjs/vite-plugin`) emits HTML entries at their SOURCE path.
The manifest says `options_ui.page = "src/localmd-connect/options.html"`, and
`dist-localmd-dev/` contains exactly that — there is no `options.html` at the
root. `chrome.runtime.getURL('options.html')` therefore returns a URL that has
never existed, and Chrome answers it with a blank tab: no console error on the
page (there is no page), nothing in the service worker. The popup's gear had
always worked because `openOptionsPage()` reads the manifest.

② The KB switch focused localmd's tab. That was a deliberate choice — a lapsed
File System Access grant needs a user gesture in that page — but it optimised
for the rare case at the cost of the common one: the user is switching folders
on the way to capturing THIS page, and being moved to another tab loses it.

③ The picker was an in-flow list, so opening it pushed everything below it down.
In a 328px popup with no room to grow, that moves the button the user is about
to press, and with four folders pushes it out of the window entirely.

**Fix**: the path comes from `chrome.runtime.getManifest().options_ui.page`,
with `openOptionsPage()` as the fallback if a build ever omits it — pinned by a
popup test that asserts the exact URL. The switch broadcasts and returns; the
popup stays where it is, shows the name it asked for, and re-reads the mirrored
state a few times plus on its 2s poll, so the confirmation appears where the
request was made (if no page received the notification it says localmd is not
connected rather than opening it). The picker is `position: absolute` over the
content, closing on pick, outside click and Escape.

**Lesson**: **never spell out an extension page's URL — ask the manifest.** The
build decides where a page lands, and the failure mode of guessing is a blank
tab with no error anywhere, which reads as "the feature is broken" rather than
"the path is wrong". And a menu in a fixed-size surface floats; anything else
moves the controls it sits above.

### F-63 `all: unset` in a more specific rule silently resized the highlight swatches — ellipses with dead gaps between them (2026-09-04)

**Symptom**: the in-page highlighter's five colour swatches rendered as ellipses
rather than circles — the second report of this, after a "fix" in the
interaction pass that changed nothing. And, stranger: clicking some colours
closed the mark bar and changed the colour, while clicking others appeared to do
nothing at all.

**Root cause**, measured on a real page rather than reasoned about:

```
.bar .swatch  →  18 x 12 px
```

Two rules, in this order:

```css
.bar button { all: unset; ... padding: 6px 9px; border-radius: 7px; }
.swatch     { all: unset; ... width: 15px; height: 15px; border-radius: 50%; }
```

`.bar button` is (0,1,1); `.swatch` is (0,1,0) — so the more specific rule wins
every property they share. That much was expected. What was not: **`all` is a
shorthand for EVERY property**, `width` and `height` included, so `.bar button`'s
`all: unset` also beat `.swatch`'s width and height. The swatch therefore had no
size of its own and was drawn at its padding: 18×12, with `border-radius: 7px`.
An ellipse, and the earlier fix (adding `flex: 0 0 auto` and explicit width and
height to the same losing selector) could not have worked.

The second half follows from the first. A 18×12 target with `margin: 0 2px` and
the bar's `gap: 2px` leaves **6px of dead space between neighbours**, inside a bar
that is ~30px tall. Aiming at where a circle looks like it should be lands on the
bar itself, which has no handler — so the colour does not change and the bar does
not close. Which of the five that happens to is a matter of pixels, which is why
it read as "yellow and pink work, the others do not".

**Fix**: `.bar .swatch` (0,2,0) beats `.bar button`, and every property that rule
touches is restated rather than assumed. The target is then made bigger than the
ink with an `::after` at `inset: -5px`, so the gaps belong to the swatch either
side of them instead of to nothing.

**How it was found**: by measuring in the real browser. The probe drove the
fixture page through the daemon — build a selection, raise the toolbar, read
`getBoundingClientRect()` off each swatch inside the (open) shadow root, then
click all five colours in turn and report whether the bar survived. The size came
back 18×12, which named the cause in one number; the clicks all behaved
correctly, which is what ruled out a logic bug and pointed at the hit target.

**Verified** on the fixture page after the fix, by the same probe:

```
ink: 16x16 ×5   radius: 50%   gap between ink: 6px
element in the middle of a gap: swatch   (was: the bar itself)
yellow/green/blue/pink/purple: bar closed, colour applied
```

**A reload of the extension was not enough.** The re-entry guard added in F-57
(`window.__localmdPageTools`) makes a re-injection into a tab that already has a
live script a no-op — which is what it is for, since two copies would give every
page two toolbars. The consequence is that an open tab keeps running the
PREVIOUS version of the in-page script until the page itself is reloaded, and
that is exactly what "some colours still behave differently" meant, followed by
"refreshing seems to have fixed it". Correct behaviour, worth knowing: an
extension reload ships a new service worker and new extension pages; only a page
refresh ships a new content script to a tab that is already open.

**Lesson**: **`all: unset` is not "reset this element's own look" — it is a
declaration of every property at once, and it wins wherever its selector wins.**
Two rules that both use it do not merge; the more specific one erases the other
entirely. And when a UI bug is reported twice, stop reading the CSS and measure
the element: `18x12` ended an argument that two rounds of reasoning had not.

---

### F-64 An error frame answering an answer — the reply path posted our own request id back to the page (2026-09-04, found while building §14.4o)

**Symptom**: none yet, in the sense that nothing was broken in a shipped build —
this is the failure the reverse LLM channel would have walked into on its first
day. The extension had never sent a request of its own, so no reply frame had
ever arrived at `handleRpcMessage`, and the guard that mishandles one had never
run.

**Root cause**: every failure branch in the extension's inbound path answers a
frame it dislikes with an error carrying **that frame's id** — sensible for a
bad REQUEST, wrong for a REPLY. A JSON-RPC response has no `method`, so it fell
straight through `if (m.jsonrpc !== '2.0' || typeof m.method !== 'string')` and
came back to the page as `-32600 not a valid JSON-RPC 2.0 request`, stamped with
an id from the EXTENSION's id space. The page has its own pending map keyed by
the ids IT minted, and both sides number from 1.

Measured on the live browser against the pre-fix build, by posting a reply frame
into the relay from the dev app's USER_SCRIPT world:

```
to-ext   {"jsonrpc":"2.0","id":"probe-2","error":{"code":-32603,"message":"roots/list is not supported"}}
to-page  {"jsonrpc":"2.0","id":"probe-2","error":{"code":-32600,"message":"not a valid JSON-RPC 2.0 request"}}   ← the echo
```

The same shape existed on the localmd side in mirror image: `onFrame` checked
the `notifications/` prefix and then looked every remaining id up in its pending
map, so an incoming REQUEST with id 1 would have resolved the tool call the app
had in flight as id 1.

**Fix**: both sides now decide what a frame IS before deciding what to do with
it. The extension recognises "has an id, has a result or an error, has no
method" as an answer ahead of every guard — routed to the waiting caller, or
dropped when nobody is waiting, because a response is never responded to. The
app reads `m.method` first: a method means the far side is talking to us, not
answering us. On top of that the extension mints STRING ids (`srv-1`) where
every client id is a number, so the collision is unrepresentable rather than
merely avoided.

**Lesson**: **a bidirectional JSON-RPC channel has two id spaces, and the moment
the second one opens, every "reply with an error" branch written for the first
becomes a way to inject a frame into the other side's pending map.** Adding a
direction to a protocol is not additive — it re-qualifies every existing branch,
and the ones to re-read are the error paths, because they are the branches that
were never exercised. Cheap structural insurance: make the two id spaces
different TYPES, and the confusion cannot be written down.

---

### F-65 After an extension reload, a localmd in a background tab never reconnects — the relay healed itself and nobody on the page noticed (2026-09-05, first day of §14.4o in real use)

**Symptom**: reload the extension, then press Translate on a page without
touching the localmd tab first. `localmd opened but did not connect in time`,
every time. Clicking the localmd tab once made it work.

**Root cause**, in three parts, only the last of which was wrong:

1. An extension reload takes every port with it. The relay content script
   forwards that to the page as `{closed:true}`, the app's `onLost` puts the
   Connect row in `error`. Correct.
2. The transport then heals ITSELF: the service worker re-injects `web-relay.js`
   into open tabs at boot (`injectIntoOpenTabs`). **Measured, not assumed** — a
   `ping` posted into a localmd.app tab that had been open across the reload
   came back answered, so the relay was alive the whole time.
3. Nothing on the PAGE noticed, because a client is what starts an MCP
   conversation. The only thing that re-probed a failed row was `retryFailed()`
   on `focus` / `visibilitychange`, and a background tab gets neither. The
   extension id had not changed either, so `recheckRelay` returned early.

So the wake found the tab (`ensureLocalmdTab` returns an existing tab without
checking anything about it), waited 20 s for a handshake that nobody was going
to start, and reported a timeout against a tab that was open, healthy and one
click from working. "Click the tab" worked because that is a focus event.

**Fix**, on both sides of the same signal — the relay already announces every
attach with a `ready:true` frame, and nobody was listening:

- **localmd** (`stores/mcp.ts`): a window listener for that frame reconnects
  Connect rows whose status is `error`. Only `error` — `connecting` is somebody
  else's handshake in flight, and re-entering it would build a second client for
  one row. `isRelayReadyFrame` moved into `lib/connectRelay.ts`, where the rest
  of the frame vocabulary lives.
- **the extension** (`ask-model.ts` / the SW): when the wake finds a tab that was
  ALREADY open, it injects one `postMessage` of that same `ready` frame before
  waiting. Injected rather than sent, because the whole problem is that there is
  no port to send on. An app too old to listen ignores it, and the wait then
  ends in a message that names the manual fix instead of blaming the clock:
  *"localmd is open but not connected to the extension — switch to its tab once,
  or reload it."*

**Verified** on the real browser by reproducing the state deliberately — post
`{closed:true}` into the dev app, then `{ready:true}`, and watch what it sends:

```
after closed:  []                                                    ← the bug, reproduced
after ready:   initialize, notifications/initialized, tools/list, tools/call, tools/call
```

No focus, no click, no reload.

**Lesson**: **a self-healing transport is not a self-healing connection.** The
layer that reconnects is not the layer that has to notice, and in a
client/server protocol only one side is allowed to start — so the side that
heals must SAY so, and the side that cannot start must listen. The tell was
sitting in the code the whole time: `web-relay.ts` posts `ready:true` on every
attach and the client's header called it "a hint, never required". A hint that
nobody consumes is a signal that has been thrown away.

Second lesson, cheaper: **"the tab exists" is not "the app is listening."**
`ensureLocalmdTab` answers a question about Chrome, and every caller that then
waits for the APP to do something has to provoke it, or say what it wants when
nothing happens.

---

### F-66 The selection toolbar came straight back on top of its own answer — the mouseup that ends the click lands on the page (2026-09-05)

**Symptom**: click Translate or Explain and the popover opens, but the toolbar
is still there, over it. Picking the open-ended "Ask…" left no toolbar, so the
two looked like different code paths.

**Root cause**: the menu button is removed by the handler that runs on
**mousedown**. The mouseup that completes the same click therefore lands on
whatever is underneath — the page — and the document's mouseup handler is the
one that raises the toolbar. The selection is still live (nothing had cleared
it), so it raised it again, half a frame after the click that dismissed it.

"Ask…" escaped only by accident: its box calls `textarea.focus()`, which
collapses the page selection as a side effect, so the re-raise found nothing to
show. A feature working for the wrong reason is the same bug wearing a hat.

**Measured** on the live page rather than argued, by driving the real content
script through the daemon (`preview_site_script {dry_run_js}` — the USER_SCRIPT
world shares the DOM, and the toolbar's shadow root is `mode: 'open'`). The
probe dispatched the mousedown AND the mouseup a real click also sends:

```
bar:true  selAfterClick:live  panel:true  quote:true  scan:1  barBack:true
```

The same probe on the "Ask…" path returned `barAfter:false`, which is what
named the difference: the selection, not the code path.

**Fix**: `releaseSelection()` — every bar action clears the selection once it
has captured what it needs (`runPrompt` and `send`). Nothing is lost visually,
because the scan overlay is now what says which passage is being worked on.

**Lesson**: **a handler that removes its own element on mousedown hands the
mouseup to whatever was underneath.** Anything listening for mouseup on the
document is then a second, invisible handler for the same click — and if it
reads state the click was supposed to consume (here: the selection), it undoes
the click. Consume that state in the handler rather than relying on the click
"being over".

Second lesson, the one that keeps recurring: **the synthetic half of an
interaction is not the interaction.** Dispatching only `mousedown` in a probe
would have shown this working perfectly. The bug lives in the event the probe
did not send.

### F-67 "The bar won't dismiss" came back a third time — two page-tools instances, one orphaned by the very extension reload that installed the fix (2026-09-07)

**Symptom**: On a highlight, clicking the FIRST colour left the toolbar up, the
gaps between the swatches then looked wider, and clicking any second colour
dismissed it. Reported (twice) as "some colours dismiss and some don't" — the
same symptom F-63 and F-66 had each already fixed.

**Two fixes that did not move it.** Both were real improvements, neither was the
bug:

1. *Dead zones in the bar* (F-63's lineage). `.bar` had `gap: 2px` +
   `align-items: center` around 16px swatches, so a click between or above the
   circles landed on the bar itself — no handler, nothing happens, the bar sits
   there. Fixed by TILING the row: `gap: 0`, `align-items: stretch`, and each
   swatch a full-height padded button with the circle as an inner `.dot`. This
   removed the randomness and, usefully, turned the symptom into a crisp
   "first click never, second click always".
2. *The async re-show race*. `highlightSelection` hid the bar only AFTER
   `await addHighlight`, leaving a window in which the click's trailing mouseup
   could re-show a bar over the passage just marked. Hardened anyway: clear the
   selection and hide the bar SYNCHRONOUSLY before the await, plus a 250 ms
   `barActionAt` window in which the document mouseup declines to re-show.

**Root cause**: **two live copies of `page-tools.js` in one page.** Reloading the
extension — which is every dev iteration, including the ones installing the fixes
above — orphans the injected content script: its `chrome.runtime` context dies,
but its `document` listeners keep running. The re-injection that follows lands in
a NEW isolated world, where the `__localmdPageTools` re-entry guard is a fresh
`undefined` and therefore cannot see the old instance. Two instances, two shadow
hosts, two mouseup listeners. The live instance dismissed its own bar correctly;
the orphan then put ITS bar up over the same passage. "First click never
dismisses, second does" and "the gap changed" were simply two different
instances' bars.

**Fix**: an orphan retires itself. `retireIfOrphaned()` runs at the top of the
document mouseup/mousedown listeners: when `chrome.runtime?.id` is gone (or
reading it throws "Extension context invalidated"), the instance sets
`active = false`, drops its bar/peek/panel and removes its own shadow host. The
marks are deliberately NOT unwrapped — the live instance owns them now and
repaints from storage, so the full teardown would strip the survivor's
highlights.

**Lesson**: **a per-world sentinel cannot dedupe across worlds.** `window.__x`
guards re-injection into the SAME isolated world; an extension reload creates a
new one, so the guard is blind in exactly the situation that produces duplicates.
A content script that owns UI and document-level listeners needs a LIVENESS check
(`chrome.runtime.id`), not just an entry guard.

**Second lesson, the one that cost the day**: *two fixes that do not move the
symptom are evidence the model is wrong, not that the fix was too weak.* After
the first fix failed, the right move was to ask the page how many instances it
had — `document.querySelectorAll('[data-localmd-page-tools]').length`, one line —
which names the bug immediately. Reaching for a third code change instead of a
measurement is how a bug gets "fixed" three times. This is
`feedback-debug-presentation-first` applied to instance identity: verify WHAT is
on the page before theorising about why it behaves badly.

**Third, procedural**: the user tested `dist-localmd-dev/` while only
`dist-localmd/` had been rebuilt — `npm run build:all` covers the three SHIPPING
targets and NOT the dev variants, so a fix can appear to fail because it was
never in the bundle under test. After changing anything a dev build exercises,
rebuild `build:localmd:dev` too, and reload BOTH the extension and the page (a
content-script change does not reach an already-open tab).

### F-68 A reconnect in the daemon log is not a reload — three "reloaded" rounds spent on a fix that was never running (2026-09-07)

**Symptom**: A one-line fix (`create_site_script` stamping the shell's own name
into `origin.note` instead of a hardcoded "created via localmd Connect") kept
testing as FAIL over the bridge, through two extension reloads, while every
static check said it should pass.

**What was ruled out, in order** — each of these was measured, and each came back
clean:

1. The source: one registration of `create_site_script`, one `origin` assignment,
   and `buildSiteScript` honours `input.origin ?? {type:'manual'}`.
2. The bundle: `dist-webcli-dev/assets/…-B_1Gx8Dv.js` contained only the template
   literal; the sole hardcoded string left was inside the comment explaining the
   fix.
3. The loader: `service-worker-loader.js` imported exactly that hashed file, and
   no other build of it existed anywhere on disk.
4. The load path: the user read it off `chrome://extensions` —
   `~/code/web-tools/dist-webcli-dev`, the directory being rebuilt.
5. A stale dev build (the F-67 trap): real the first time —
   `build:all` had rebuilt only the shipping targets, so the dev bundle was 64
   minutes older than the source. Fixed, rebuilt, reloaded… and it still failed.

**A false lead worth naming**: a disk-wide sweep for the old string reported it
in five builds, including ones just produced. That was the sweep's own bug —
`n=$(grep -c … || echo 0)` makes `n` the two-line string `"0\n0"` when grep
matches nothing, which is `!= "0"`. A check that reports failures where there are
none burns exactly as much time as the bug.

**Root cause**: the extension's service worker was never picking up the new
bundle. What made that invisible was reading the daemon log as evidence: it
logged `extension registered: webcli-dev 0.4.0` after each round, which looks
like proof of a reload but is only proof of a WebSocket **reconnect** — the
keep-alive redial re-registers with whatever code the worker is already running,
and the version string is the manifest's, identical across the two builds.

**Fix (of the method, not the code)**: make the running code identify itself.
A one-line temporary probe — `CLIENT_NAME` changed to `webcli-dev-PROBE1426`,
rebuilt — turned "did it reload?" into a fact the daemon prints:

```
[webcli] extension registered: webcli-dev 0.4.0          ← reconnect, old code
[webcli] extension registered: webcli-dev-PROBE1426 0.4.0 ← the reload landed
```

The moment the probe appeared, the same test passed. Probe reverted, all four
dists rebuilt, both zips repacked, and each verified to contain zero occurrences
of `PROBE1426` before shipping.

**Lesson**: **when a fix "does not work", first prove which code is running.**
Every artifact on disk can be correct and the process can still be executing an
older copy — and the cheapest way to know is to make the build announce its own
identity, rather than to keep re-reading the source. A handshake, a heartbeat or
a reconnect says a process is *alive*; only something that changed in *this*
build says it is *current*.

**Corollary**: when a verification step is itself a script, the script can lie.
Two of the rounds here were spent on output from a sweep whose `|| echo 0`
fallback manufactured failures. Check the checker before trusting a surprising
result from it.
