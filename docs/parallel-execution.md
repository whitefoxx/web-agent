# 并行执行(parallel steps)— 计划书

> 目标:让一个任务里**相互独立的步骤并行跑**,像 Claude Code 的并行 Task 那样,但适配"浏览器是共享资源"这个根本约束。本文是 plan-of-record:v1、v2 已实现;**v3 第一步(每站点 tab 池,§11)+ 第二步(主循环并行只读 tool_calls,§12)已实现**,其余 v3 仍是路线图。

## 1. 背景与目标

用户视角:"一个 plan 里有些 step 可以并行,能不能像 Claude Code 一样并行跑?"

可以。但浏览器 agent 和 Claude Code(操作文件,天然可并行)最大的不同是:**浏览器是共享的可变状态**——同一个标签页上并发点击/输入/导航会互相打架,同一个站点的 tab 被两个调用同时 attach CDP 会冲突。所以并行的形态不是"盲目并行所有 tool_calls",而是**并行隔离的只读子 agent**(每个子任务一个隔离上下文),并由调度层保证对共享 tab 的访问是串行的。

## 2. 现状(并行之前)

- **工具调用串行**:一个回合里模型即便发多个 `tool_calls`,引擎也是 `for (const call of toolCalls)` 逐个 `await`(`api-engine.ts`)。
- **子 agent 串行**:`spawn_subagent`(Phase 4)一次一个(`runSubagent`),**只读、不可嵌套**,把文字结论(digest)折回主上下文。
- **tab 模型**(`tools/dispatcher.ts`):
  - 站点 adapter(`xiaohongshu__feed`)→ `ensureSiteTab(site)` 解析出**每站点共享的一个 tab**;`humanPaceForSite` 只是**按时间戳延时,不是互斥锁**——并发同站点调用不会被串行化。
  - 通用工具(`open_url`/`click`/`type`/`get_page_text`…)`site:'generic'`,操作的是参数里显式的 `tab_id`。
  - 纯 HTTP pipeline(hackernews/coingecko…)无 tab、无 CDP,SW `fetch` 直连。

## 3. 两条硬约束

1. **工具协议**:一条带 `tool_calls` 的 assistant 消息,**下一条 assistant 消息之前必须把每个 tool_call 都用 tool 结果回应**。⇒ 一个回合里 fan-out 的子 agent **必须全部跑完**才能进入下一回合。所以 `Promise.all` 式 fan-out 只并行**同一回合内**的工作;跨回合/跨 step 的并行需要调度器(见 v3 DAG)。
2. **浏览器共享态**:对**同一个 tab**(站点 adapter 的 per-site tab,或通用工具的同一个 `tab_id`)的并发操作会损坏页面/CDP 状态。⇒ 必须有**按 tab 维度的串行化**。纯 HTTP(无 tab)和不同 tab/不同站点之间才是真正安全的并行点。

## 4. 设计原则

- **模型驱动 fan-out,而不是引擎跑 DAG**:模型最清楚哪些 step 独立。让它在一个回合里发多个 `spawn_subagent` 就够了——这已经覆盖了大部分价值。形式化的"引擎依赖 DAG 调度器"是 v3 的 stretch,不是必需。
- **隔离靠"按 key 串行化",而不是给每个子 agent 塞一个独立 tab**:站点 adapter 忽略外部传入的 tab(自己 `ensureSiteTab`),所以"每子 agent 独立 tab"对它们无效。改为在 **dispatcher 层加按 key 的互斥锁**:同 key(同站点 / 同 tab)串行,不同 key 并行。这让既有的"共享 per-site tab"模型在并发下变安全,且无需大改 tab 体系。
- **只读 + 写仍走主 agent**:子 agent 只读(本就如此),避免并发写冲突;写操作仍由主 agent 串行执行 + 确认(或 auto 模式,见 [architecture §29])。

## 5. 锁 key 的算法(v1 的安全基石)

`lockKeyFor(adapter, args)`(在 `dispatcher.ts`):

| 工具类型                                                   | key                                                      | 效果                                                                                                                                                                                    |
| ---------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 通用工具(`site:'generic'`)带 `tab_id`                      | `tab:<tab_id>`                                           | 同 tab 串行,不同 tab 并行                                                                                                                                                               |
| 通用工具无 `tab_id`(如 `open_url` 新开、`list_tabs`)       | `null`(不锁)                                             | 各自新开 tab,安全并行                                                                                                                                                                   |
| 站点 adapter,**纯 HTTP** pipeline(无 page)                 | `null`(不锁)                                             | 无共享 tab → 安全并行(**用户的"HN 前 3 条逐条抓"正是这类,可并行**)                                                                                                                      |
| 站点 adapter,func / 需要 page 的 pipeline / installed-func | **v1**:`site:<baseSite>` · **v3 起**:`null`(改走 tab 池) | **v1**:同站点串行(避免同 tab 双 attach)。**v3 起**:不再加站点锁,改由[每站点 tab 池](#11-v3-第一步--每站点-tab-池已实现)为每个并发调用分配**独占 tab**,同站点并行(≤ 池上限),不同站点并行 |

`baseSite` 去掉命名空间前缀,让 `my-xiaohongshu` 和 `xiaohongshu` 共享一个分桶(和 `humanPace` 一致)。锁实现是**按 key 的 promise 链**(`withKeyLock`),`fn` 在前一个同 key 任务 settle 后才跑;链尾永不 reject,以免一个失败卡死整条链。**v3 起,站点 adapter 的隔离从这把锁迁移到 tab 池**(§11);`withKeyLock` 现在只剩通用工具同 `tab_id` 这一条串行路径。

## 6. v1 — 安全的并行子 agent(已实现)

1. **dispatcher 按 key 串行锁**:`executeAdapter` 用 `lockKeyFor` 求 key,有 key 就 `withKeyLock(key, () => executeAdapterInner())`。这是并行的安全前提(子 agent 的工具调用走 `ctx.executeTool → executeAdapter`,自动被覆盖)。
2. **并行 fan-out**:主循环遇到**多个** `spawn_subagent` 时,用并发池(上限 `SUBAGENT_PARALLEL_CAP = 5`)并发跑,结果**全部完成后**再按序折回(push tool 结果 + emit trace + 存档),避免并发改 `messages`/`session` 的竞态。单个 `spawn_subagent` 仍走原内联路径。
3. **提示模型 fan-out**:`spawn_subagent` 描述 + system prompt 告诉模型:**相互独立的子任务,一个回合里一次性发多个 `spawn_subagent`**,它们会并行执行。
4. **测试**:`withKeyLock` 单测(同 key 串行、不同 key 并行、失败不卡链、提交顺序);并发复用既有 `mapConcurrent`。

不变量:写不并行;子 agent 不可嵌套;digest-only 折回。

## 7. v2 — 可见 & 可控(已实现)

1. **结构化事件 + 并行泳道 UI**:`spawn_subagent` 从模糊的 `notice` 升级为结构化 `subagent` 事件(`start` / `done`,带 id、task、ok、digestChars、durationMs)。面板按 id 渲染**并行泳道**:每条子任务一行,**真实状态**(运行中 / 完成 / 失败)——不伪造 ✓(见 [feedback-truthful-status-reporting])。
2. **每回合 fan-out 上限**:除了并发数上限(5),再加一个**每回合子 agent 总数上限**(`SUBAGENT_FANOUT_MAX`),超出就拒绝多余的并提示模型分批,避免一回合炸开几十个子 agent 撞 rate limit / 烧 token。
3. **预算**:每个子 agent 已有 `SUBAGENT_MAX_STEPS` 步数上限;并行只是同时跑多个,不放大单个预算。

## 8. v3 — 编排(部分实现)

按"先打地基、再上层"的顺序:

1. **每站点 tab 池(已实现,§11)** + **主循环并行 tool_calls(已实现,§12)**:第一步把"每站点一个共享 tab + 站点锁"换成**每站点 tab 池**——同站点的并发调用各租一个独占 tab,真正并行(≤ 池上限),是"同站点也能并行"的地基。第二步让**主回合里相互独立的只读 `tool_calls` 并发执行**(此前主循环 `for…await` 串行,所以面板里模型若不 fan-out 就看不到并行)——这样普通的多工具调用(不必走 `spawn_subagent`)也能并行,直接解决"面板没并行"。
2. **显式依赖 DAG 调度器**:让 agent 声明 step 依赖(D 依赖 B+C),引擎调度——就绪的并行、有依赖的等前置。这才让"plan 里的并行 step"成为引擎一等公民(v1 是模型在单回合内 fan-out;DAG 是跨回合调度)。和现有 Workflow 工具会收敛。
3. **有界递归子 agent**:子 agent 可再 fan-out,深度受限。
4. **专职角色 + 对抗式校验**:scout / extractor / verifier 不同 profile;一个发现让 N 个 verifier 投票后才采信。接 roadmap 里"外部 agent 驱动 explore"。
5. **跨子 agent 综合/去重**:fan-out 回来的重叠结果做 merge/dedup(workflow synthesis 套路)。
6. **持久化 / 恢复**:fan-out 中途 SW 被回收时,恢复 N 个在途子 agent。MV3 下很难,保持 fan-out 有界 + checkpoint。

## 9. 风险与天花板

- **成本 / rate limit** 是并行宽度的真实上限(Claude Code 并行 Task 同样撞这堵墙)。⇒ 上限 + 预算。
- **MV3 SW 回收** 中途打断 fan-out;in-turn fan-out 因 keepalive(active session)还好,跨回合 DAG 要 checkpoint。
- **无法 headless E2E**:浏览器并发的真实表现(双 CDP attach、页面竞态)只能在加载到 Chrome 后点测;单测覆盖锁/池/折叠逻辑,浏览器行为靠设计保证 + 真机验证。

## 10. 测试策略

- 单测:`withKeyLock`(串行/并行/失败不卡链/提交顺序)。并发复用既有 `mapConcurrent`;fan-out 折叠与事件流靠 typecheck + 真机验证(浏览器并发无法 headless 跑)。
- 真机:加载 `dist/`,跑一个"从 3 个不同站点各取一条"的任务,确认 3 条泳道并行、状态真实、结果正确;再跑"同站点 3 次"确认被锁串行不崩。

## 11. v3 第一步 — 每站点 tab 池(已实现)

### 动机:为什么"面板里跑知乎没有并行"

用真机(外部接入 bridge)实测"知乎搜中医气血/肝肾 → 取 3 个热门问题答案"这个任务,
并发触发 3 个 `zhihu__question`,完成时间 **12.3 / 21.5 / 32.3s**(均匀错开 ~10s)、
总墙钟 32.25s ≈ 3×单次——**串行**。对照同一 bridge 的"HN 前 3 条"(纯 HTTP、无 tab):
5.8 / 8.0 / 8.6s 同时落地、总 8.66s——**并行**。差异定位到 dispatcher。

"面板里没并行"有三层叠加原因:

1. **主循环 `tool_calls` 本来就串行**(`for (const call of toolCalls) await …`)。v1 只让
   `spawn_subagent` fan-out 并行,没动主循环。→ **面板那次最可能卡在这层**:模型用的是普通工具
   调用,引擎逐个 await。(仍未解,是 §8 第 1 条的"下一步"。)
2. **即便 fan-out,同站点也被站点锁串行**:v1 的 `lockKeyFor` 给站点 adapter 返回
   `site:<baseSite>`,一把锁。
3. **根因**:所有同站点调用共用**一个 per-site tab**(`ensureSiteTab`),锁是为了防止两个调用
   同时 `chrome.debugger.attach` 同一个 tab(`createPageShim` 对"已 attach"会**静默复用且非
   owner**,先 detach 的那个会把另一个的 CDP 会话搞坏)。

关键洞察:站点 adapter 多是在页面里 `fetch(url,{credentials:'include'})`——**只需要站点
origin(带 cookie),不操作 DOM**。所以给每个并发调用**各自一个 tab** 就能真并行,N 个 tab =
N 个独立 attach,互不干扰。

### 改动

- **`src/tools/site-tab-pool.ts`(新)**:`SiteTabPool` —— 每站点一个**有界 tab 池**。
  `acquire(site,domain)` 租一个**独占** tab:① 复用空闲且仍存活的池内 tab → ② 首次分配时
  **adopt 用户已开着的该站 tab**(保留旧"复用你的 tab"行为、不平白多开)→ ③ 未达上限就**新开
  后台 tab** → ④ 满了就**排队**,等 `release()`。`release()` 把 tab 交给下一个 waiter 或归还
  空闲表。Chrome 调用藏在 `TabOps` seam 后面,核心排队/容量逻辑可 headless 单测
  (`tests/site-tab-pool.test.ts`)。上限 `POOL_MAX_PER_SITE = 5`(与 `SUBAGENT_PARALLEL_CAP` 一致)。
- **`dispatcher.ts`**:三条站点路径(func / 需 page 的 pipeline / installed-func)从
  `ensureSiteTab` + 站点锁,改成 `sitePool.acquire → 租约 → humanPace → createPageShim → run →
detach → release`。`lockKeyFor` 对站点 adapter 改返回 `null`(隔离改由池保证),只剩"通用工具同
  `tab_id`"还串行。`chrome.tabs.onRemoved` → `sitePool.forget` 把被关掉的 tab 从池里剔除(腾出
  名额给 waiter,且绝不把死 tab 发出去)。
- **pacing 改为 per-tab**:`humanPaceForSite(site)` → `humanPace(bucket)`,站点 adapter 的桶是
  **租到的 tab**(`tab:<id>`),所以并行的不同 tab 各自计时、不再互相 pace 成串行;通用工具仍是
  `'generic'` 桶。**权衡**:同站点的反爬最小间隔从"每站点"放宽到"每 tab"(并行本就意味着同时发
  数个请求,正是用户要的;真实浏览器也并行发请求)。

### 不变量 / 边界

- **每个租约 = 一个 tab 独占**:两个调用永不同时 attach 同一 tab(取代旧锁的安全保证)。
- 不同站点、纯 HTTP(无 tab)一如既往各走各的,不受池约束。
- 并行后每站点最多留 ~5 个后台 tab(被后续调用复用,不每次开关)。**任务结束(所有 run 空闲)后**
  由 reaper 关掉**池自己开的**空闲 tab(`SiteTabPool.reapCreatedFreeTabs` → dispatcher `reapPoolTabs`,
  在 service-worker 的 run-done 分支、`activeSessions.size===0` 时调用)——**绝不关用户自己的 / adopt
  的 tab,也不碰在用的租约**;下次同站点调用再重新预热。这样并行不会让 agent 开的 tab 堆积。
- 池只让"**dispatcher 层**的并发"真并行;面板主循环要真并行,仍需 §8 第 1 条的"主循环并行
  `tool_calls`"。本步的并行可由 **bridge 并发 `/command`** 或 **`spawn_subagent` fan-out** 触发。

### 真机验证(已完成)

加载新 `dist/` 后,用 bridge 重跑"同站点 ×3"(3 个 `zhihu__question` 并发):

| 场景                    | 各自完成时刻(相对批次起点) | 总墙钟     | 结论                     |
| ----------------------- | -------------------------- | ---------- | ------------------------ |
| 改前(站点锁)            | 12.3 / 21.5 / 32.3s        | **32.25s** | 串行(≈ 3×单次)           |
| 改后 · RUN 1(冷,开 tab) | 15.1 / 20.9 / 25.2s        | **25.17s** | fetch 重叠,但开 tab 串行 |
| 改后 · RUN 2(热,复用)   | 2.1 / 12.0 / 12.1s         | **12.14s** | **真并行**(≈ 最慢单次)   |

`list_tabs` 证实池开了 **3 个独立 tab**(各停在自己的问题页):一个是 **adopt 用户原有的知乎 tab**,
另两个是池**新开的后台 tab**;3 份结果都正确、互不串台、不崩。冷/热差异 = 池"预热"成本:RUN 1
要新开 2 个 tab(pump 单飞 → 开 tab 串行),RUN 2 全部复用池内 tab → 干净并行。

观察到的两点(非本步阻塞,记此备查):

1. **冷启动开 tab 串行**:pump 单飞,`takeOrCreate` 逐个 `await open`,所以一批冷调用的多个新 tab
   是依次开的(每个 ~3-5s)。预热是一次性的(tab 常驻复用)。**可选优化**:同步占名额 + 并行开 tab。
2. **adopt 会导航用户的 tab**:zhihu func 会把租到的 tab `page.goto` 到问题页;adopt 用户已开的
   知乎 tab 时就改变了用户正在看的页面(**旧的单一共享 tab 模型本就如此,非回归**)。**可选改法**:
   自动化只用专属后台 tab、不碰用户的 tab(代价:用户已开着该站时也会多开一个)。

另:**SW reload 后 bridge 的 catalog 暂时只剩 30 个(generic),站点 adapter 未列出**——直连调用仍
可用(registry 已加载),只是初次 catalog 在装好 adapter 之前推送、且之后没 ADAPTERS_CHANGED 刷新。
属 boot 时序问题,与本步无关,另行处理。

## 12. v3 第二步 — 主循环并行只读 tool_calls(已实现)

### 为什么需要它

§11 让 dispatcher 能并行,但**面板的主循环仍是 `for (const call of toolCalls) await …` 串行**——
v1 只让 `spawn_subagent` fan-out 并行,没碰主循环。所以模型若用普通工具调用(不走 spawn_subagent)
一次发 3 个 `zhihu__question`,引擎还是一个个等。这正是用户"面板里没并行"的第一层原因(§11 三层
诊断之首)。本步把它解决:**一个回合里相互独立的只读 adapter 调用并发执行**。

为什么安全:**一条 assistant 消息里的多个 `tool_calls` 是模型在没看到彼此结果时一次性发出的——
天然相互独立**(有依赖就会分回合)。所以同回合并发它们不改变语义;浏览器侧的安全由 §11 的 tab 池
保证(同站点各租独占 tab)。

### 改动(`api-engine.ts`)

- 主循环前加一个**并行预跑**(`for (const call of toolCalls)` 之前):挑出本回合里
  `lookupAdapter(name) && access !== 'write'` 的调用(纯只读 adapter),≥2 个就用
  `mapConcurrent(…, MAINLOOP_READ_PARALLEL_CAP=5)` **并发执行**,再**按原顺序折回**(push tool
  结果 + 完成 trace + 存档一次)。形态与 `runSubagentBatch` 完全一致。
- 顺序循环里 `if (parallelReadIds.has(call.id)) continue;` 跳过已预跑的。
- **写操作 / 被拦截的特殊工具**(`submit_plan` / `update_plan` / `spawn_subagent` /
  `create_workflow` / `view_image` / …)**不**进预跑,仍在顺序循环里逐个执行(写要逐个确认、特殊
  工具有交互/副作用)。fold 用与顺序路径相同的 `collectImageRefs`/`stripDataUrls`/`truncate`/
  `thrash.record`,行为一致。
- system prompt 提示模型:相互独立的只读查询**一回合发多个**,引擎会并行,比逐个等快。

### 不变量 / 边界

- 只并行**只读** adapter 调用;写、`spawn_subagent`(已有自己的 fan-out)、引擎拦截的工具都留在顺序路径。
- tool 结果按原 `tool_calls` 顺序折回(对顺序敏感的 provider 友好;沿用 fan-out 既有做法)。
- 并发数 `MAINLOOP_READ_PARALLEL_CAP`(5)与 tab 池上限(每站点 5)叠加:同站点最终被池夹到 5,
  混合站点可同时更多。

### 验证

- 单测 `tests/api-engine.test.ts` 新增:一回合发两个只读调用 → `executeTool` **并发**(观测到
  `maxActive === 2`,串行会是 1)、两个 `started` trace 都早于第一个 `completed`、结果按序折回。
- 真机(面板):reload 后跑"知乎搜中医气血/肝肾 → 取 3 个热门问题答案",看工具 trace 是否同时在跑、
  总时长是否≈最慢单次(而非 3×)。〔实测:见对话/下次补录。〕

## 13. agent 专用窗口 — 把 agent 开的 tab 与用户窗口彻底隔离(已实现)

**动机**(真机 E2E 后的体验问题):agent 开的 tab 全部混在用户当前窗口里;且"Web Agent"
tab group **时有时无**——谜底是分组只挂在 `generic__open_url`/explore 路径(`adoptTab`),
**站点池 `tabOps.open` 从不分组**,而大多数任务恰恰走站点 adapter。另外池的 `findExisting`
会直接征用用户已开的同站 tab。

**设计**(`src/background/agent-window.ts`):一个**懒建、共享**的 "Web Agent" 窗口,
SW 内存态记 `agentWindowId`;首个 agent tab 时 `chrome.windows.create`(`focused:false`,
不抢焦点),之后复用;用户关掉就重建。窗口里留一个 about:blank **占位 tab**(进组、可识别),
reaper 收内容 tab 后窗口不至于每个任务开关一次。四条开 tab 的缝全部走 `createAgentTab`:
站点池 `tabOps.open`(+`adoptTab`,分组从此一致)、`generic__open_url`、explore ×2
(service-worker + bridge-client)。**bridge(外部接入)与 SidePanel 共用这些缝,行为一致。**
`findExisting` 改为只在 agent 窗口内找(`tabs.query({windowId})`)——**再也不征用用户 tab**
(代价:放弃冷启动复用,登录态本就共享,只是首开慢一点)。

**上线连环踩的两个坑**(真机各失败一次才定位):

- **stale window id**:用户随手关掉 agent 窗口 → `tabs.create({windowId})` 抛
  `No window with id`。`windows.get` 预检有竞窗(probe 后、create 前窗口才消失),
  `onRemoved` 也可能滞后。**修法**:`createAgentTab` 自愈——create 报"窗口没了"就忘掉
  stale id 重建一次再开;`findExisting` 的 query 也兜底返回"无可复用"。
- **`chrome.tabs.group` 把 tab 拖回用户窗口(根因级)**:tab group 是**窗口级**资源;
  `tabs.group` 新建组时 `createProperties.windowId` **默认当前窗口**(=用户窗口),且
  **入组会把 tab 移动到组所在窗口** → agent 窗口唯一的占位 tab 被拖走 → 空窗口被 Chrome
  自动关闭 → window id 立即 stale → 连 self-heal 的重试也同样死法,表现为"窗口从没出现 +
  用户窗口堆 about:blank + No window with id"。**修法**(`controlled-tabs.ts`):分组改
  **窗口感知**——建组显式 `createProperties:{windowId: tab所在窗口}`,并按窗口各管各的组
  (`Map<windowId,groupId>`),入组只入同窗口的组,跨窗口移动从根上不可能。
  **教训**:窗口级资源(tab group)绝不能用全局单例 id 管;任何"把 tab 加进组/池"的 API
  都要先问一句"它会不会顺手把 tab 移走"。

**验证**:`tests/agent-window.test.ts`(懒建/复用/用户关窗后重建/probe-create 竞窗自愈/
并行预跑下只建一个窗口/active 聚焦/**SW 重启后复用**)+ `tests/controlled-tabs.test.ts`(组建在
tab 自己的窗口、每窗口一组、跨窗口绝不移动、组被 Chrome 回收后重建)。真机:zhihu/HN 任务 → 独立
"Web Agent" 窗口内蓝组聚齐 agent tabs,用户窗口零打扰;中途关窗,下个任务自动重建 ✅。

**第三个坑(代码体检查出,2026-06):SW 重启泄漏空窗口**。`agentWindowId` 只在内存,MV3 SW
~30s 空闲就死;下个任务 SW 重生 → `agentWindowId=undefined` → 又开一个 agent 窗口,旧的带占位
tab 永久残留 → 日积月累堆一排空 "Web Agent" 窗口;`controlled` 集合同样丢失 → `get_active_tab`
/`list_tabs` 误判 agent tab。**修法**:`agentWindowId` 持久化到 `chrome.storage.session`(活过
SW 重启、浏览器关闭即清——正好是窗口的寿命);`ensureAgentWindowId` 在内存为空时先 recall+校验、
复用现有窗口,并 `recoverWindowTracking()` 从该窗口现存的 "Web Agent" 组重建 `controlled` +
回种 group id(避免另起一组)。**教训**:凡跨任务要活的状态(窗口/控制集/explore 会话/in-flight
写)都不能只放内存——MV3 SW 随时会死,要么 `storage.session`,要么启动时对账重建。

**第四个坑(用户真机反馈,2026-06):`storage.session` recall 仍偶发失效 → 还是每次新开窗口**。
第三个坑修了之后实测**仍泄漏**:多次运行后照样堆一排 agent 窗口。根因——窗口复用唯一的两个 source
都不可靠:`agentWindowId`(内存,SW 死即丢)+ `chrome.storage.session` recall,而 recall 跨 SW 重启
偶发返回 undefined(怀疑 fire-and-forget 的 `set` 在 SW 即将回收时没刷盘 / session 在某些情形不可靠)。
两个都落空就 create 新窗口,占位 tab 让旧窗口不关 → 累积。**修法**:加 `findAgentGroupWindow()`,用
**Chrome 自己的持久标记「Web Agent」tab group** 作第三 source of truth(该组只存在于 agent 窗口
里,其 `windowId` 即该窗口);`ensureAgentWindowId` 在 recall 落空时 `?? findAgentGroupWindow()` 兜底、
校验后 re-adopt。即便内存 + storage 双失,只要 Chrome 里那个组还在就能复用。加了回归测试(清空 session
但保留 group → 复用同一窗口,不开第二个)。**教训**:跨 MV3 SW 重启要复用的资源,**别只靠内存 +
storage**——优先用 Chrome 自身的持久状态(tab group / 窗口属性)做最终判据;"逻辑对 + 单测过" ≠ 真机
不泄漏,环境层(storage 刷盘时机、SW 回收)要按最坏假设兜底。

**第五个坑(用户真机反馈,2026-07):一排同名 tab group + 抢焦点 + 残留 tab 关不干净**。三个症
状同源。**症状**:Chrome「移动到标签组」菜单里堆着二十多个同名组(多为 `WebChat Agent`、少数
`Web Agent`);每次 agent 另起窗口都**浮到前台打断**用户当前窗口的工作;运行结束后**总有残留 tab**
开着关不掉。**根因**:agent 窗口本该是**单例**,但复用一旦落空就泄漏一个新窗口,而占位 tab 让泄漏
的窗口**永不自关** → 无上限累积。落空的主因是**改名**:组标题 `WebChat Agent`→`Web Agent`(commit
`40d565c`),第三/四坑的 recovery-by-group 只查新标题 `Web Agent`,匹配不到改名前那批 `WebChat Agent`
窗口 → 升级后每次都当"没有"而新建;老窗口成永久孤儿(占位 tab 不死、又没人按旧标题查它)。reaper
(`reapPoolTabs`)只关**池开的内容 tab**、且只在运行结束触发,占位 tab / SW 中途被杀的孤儿 / 泄漏窗口
里的一切都没人关。抢焦点:`windows.create({focused:false})` 在 macOS 上挡不住新窗口浮到最前。**修法**
(三合一):① **认新旧两个标题**——`AGENT_GROUP_TITLES=['Web Agent','WebChat Agent']`,`queryAgentGroups`
查全再按标题过滤,`findAgentGroupWindow`/`recoverWindowTracking` 都用它(只用新名创建,复用到 legacy 组
就 relabel 成新名);② **建组前先去重**——`addToGroup` 在内存 map 为空时先 `queryAgentGroups(windowId)`
复用现有 agent 组,不再无脑新建(补 map 落空后 SW 重启的组重复);③ **孤儿窗口 reaper**——
`reapOrphanAgentWindows(spare)` 找出所有 agent 标题组所在窗口,把**非活动、且纯 agent(每个 tab 要么在
agent 组里、要么 about:blank 占位)**的窗口整个关掉(**含任一外来 tab 则整窗跳过**=安全阀);
`agent-window.ts` 在 SW 启动(`reapLeakedAgentWindowsOnBoot`,spare = 内存 id ?? 校验过的 storage.session
id,浏览器重启则 spare 空、全清)+ 每个 SW 生命首次 ensure 后各跑一次。抢焦点:`createAgentTab` 建窗前
`getLastFocused()` 记住用户窗口,建完(`focused:false`)把焦点**夺回**用户窗口(即便系统硬浮新窗口)。
**验证**:`tests/controlled-tabs.test.ts`(SW 重启后复用现有组不新建、legacy 组 adopt+relabel、reaper 关
纯 agent 窗口/留有外来 tab 的窗口/占位窗口)+ `tests/agent-window.test.ts`(后台建窗把焦点还给用户窗口、
boot 清理关掉泄漏窗口只留在跟踪的那个)。**教训**:① **改动持久标记(组标题/存储 key/窗口属性)= 数据
迁移**——旧数据得有识别/清理/迁移路径,否则旧记录变永久孤儿。② 占位 tab「保活」是双刃剑:窗口不churn
的代价是泄漏永不自愈,必须配一个**主动 reaper** 收口。③ 隔离性副作用(新窗口/新 tab)默认要"隐身"——
`focused:false` 不够就**创建后夺回焦点**,别信单个 flag 能挡住所有平台的浮窗行为。
