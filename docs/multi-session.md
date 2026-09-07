# 多会话并行(SidePanel,2026-07)

一个面板同时驱动/观察多个 agent 会话:正在跑的会话可以放到后台继续执行,随时开新对话
或切回旧会话,互不打断。本文记录设计决策与已知限制;实现全部在 **panel 层**
(`src/sidepanel/App.tsx`),SW 侧零改动。

## 1. 为什么 SW 侧不用改

调研结论(2026-07-03):单会话从来不是引擎限制,而是 UI 视图限制。

- `activeSessions` 本来就是 `Map<sessionId, {session, abort}>`(`runtime-state.ts`),
  bridge / 计划任务早就在无面板时并发驱动 run;
- 所有 SW↔panel 消息都带 `sessionId`,`steerQueue` / confirm-prompts 的 pending map 均按
  id 键控;keepalive 是计数式(`stopKeepalivePingIfIdle` 看 `activeSessions.size`);
- 每一步(assistant turn / tool result)都 `saveSession` 落 IndexedDB。

真正的三个限制点:① panel 只持有一个 `sessionId`,`eventBelongsToCurrentSession` 把其他
会话的事件**整体丢弃**;② `onNewChat` 会主动 abort 正在跑的会话;③ 交互卡(写确认 /
plan 审批 / H9 接管)只对当前会话渲染,切走的会话的请求被静默丢到 5-10 分钟超时
(§10.19 那类"长 await 单点故障")。

## 2. 核心决策

### 2.1 切换 = IDB 重载 + 续接实时流,不做 N 路内存镜像

panel **不**为每个后台会话镜像完整 turns 流。后台会话只记轻量状态
(`bgSessions: Map<id, {status, unread, updatedAt}>`,token patch 级事件做 no-op 短路防
重渲染);切换时 `switchToSession`:

1. `GET_SESSION` 从 IDB 整载历史(每步都落库,所以不丢);
2. `GET_SESSION_STATE` 取 `activeSessionIds` 判断 running —— 比持久化的
   `session.status` 真(SW 死亡会留下 stale 'running');
3. 先同步写 `sessionIdRef` 再异步 setState,切换瞬间到达的目标会话事件不被丢;
4. 之后实时事件直接续接在加载的历史上。

代价:切换瞬间一次 IDB 读;换来的是内存/复杂度便宜一个数量级。

**emit-先于-save 的重复窗口**:api-engine 对 assistant turn 是 `appendTurn → emit →
saveSession`,切换期间"刚从 IDB 读到的 turn 又以事件形式到达"会重复 —— tool trace 本身
按 id 去重,assistant turn 用「最近 6 条 (iteration, text) 相同即丢弃」兜底
(`onAssistantTurn`)。

### 2.2 交互卡按 sessionId 入库,永不丢弃

写确认(`WRITE_CONFIRM_REQ`)和 H9 接管**只发送一次**(只有 plan 卡每 3s 重发,
confirm-prompts.ts),所以 panel 收到即按 `sessionId` 存进
`pendingConfirms / pendingTakeovers / pendingPlans` 三张 Map —— 无论属不属于当前会话。
当前会话的渲染卡片;后台会话的在会话条亮「待输入」角标 + 首见 toast
(`seenPromptIds` 去重 plan 重发),切过去卡片就在。

清理点:该会话 SESSION_DONE(SW 端 await 已随 run 解决/中止)、面板内决策、删除会话。

已知边界:SW 端确认有 5 分钟超时自动 decline;若用户超过 5 分钟才切过去,卡片可能已
过期 —— 点了会收到 unmatched RESP(SW 侧 warn,无害),run 早已按 decline 继续。v1 接受。

### 2.3 后台运行的进入/退出

- `onNewChat` / `switchToSession` 前先 `detachCurrentIfRunning()`:running 的当前会话进
  `bgSessions`(status running),**不再 abort**;
- 面板打开时 `GET_SESSION_STATE` 发现已在跑的会话(bridge / 计划任务驱动)自动入条;
- 幽灵对账:SW 半路死掉不会广播 SESSION_DONE,条目会永远挂着 —— 有条目时每 10s 慢轮询
  `GET_SESSION_STATE`,不在 activeSessions 的直接移除;
- 并发上限 **3**(`MAX_PARALLEL_SESSIONS`,startRun 前置检查+toast):再多会互相抢
  site-tab-pool 租约和 LLM 配额。

### 2.4 会话条(session strip)——只在"真并行"时存在

用户定的原则(2026-07-03 真机反馈):**能不用就不用**。会话条只在后台还有**没跑完**的
会话时出现;后台会话一结束(done/error/abort/checkpoint)立即离条 —— toast 已通知,
结果在历史会话里 —— 没有并行时整条不渲染。因此条上不存在"已完成/未读"状态
(最初版的 done 绿点 + unread 橙点双点表达在真机被判为费解,已删)。

条目:当前会话在首位;后台会话 = 琥珀脉冲点 + 预览标签(LIST_SESSIONS 的
first-user-turn preview,displayText 优先)+ **开始时间后缀**(测并行常用同一句话,
同文字 pill 靠时间区分)+ 待输入角标。点击切换,tooltip 写明「不打断执行」。
样式遵守 mobile-first(无 hover-only)。

#### 2.4.1 坑:当前会话被自己重复渲染成一条后台 pill(session s_mrbij8cc 反馈)

**症状**:一句「看下我的知乎首页」跑完后,会话条上出现**两条一模一样**的
「看下我的知乎首页」——一条是当前 tab(灰点/idle),另一条是琥珀点 + 「刚刚」
的后台 pill。看着像"同一个当前会话被重复表示"。

**根因**:`bgSessions`(后台会话集合)本应**永不包含当前前台会话**,但这条不变式
没有被强制。开面板时的发现副作用(`GET_SESSION_STATE` → 把 SW 里 active 的 session
塞进 `bgSessions`)用 `id !== sessionIdRef.current` 过滤当前会话,而**首次挂载时
`sessionIdRef.current` 还是 `null`** —— 于是那个马上要被恢复成"当前"的会话先被塞进
`bgSessions`,恢复后它既是当前 tab、又在 `bgSessions` 里 → `stripEntries`(= `bgSessions`)
把它再渲染一遍。当前 tab 的点跟随真实 running 态(跑完变灰),后台 pill 的点是
**硬编码 running**(琥珀)+「刚刚」——正好就是那两条。

**修法**(三处,层层设防):

1. **不变式副作用**(根因):`useEffect([sessionId])` —— 每当当前会话 id 变化,就把它
   从 `bgSessions` 里剔除(`mapWithout`)。挂载竞态里"发现塞入 → 恢复成当前"这条路,
   恢复那一刻即被清掉。
2. **渲染兜底**:`stripEntries` 过滤掉 `id === sessionId` —— 即便不变式副作用慢一拍
   (它比渲染晚一个 tick),那一帧也不会闪出重复 pill。
3. **可见性门槛**:会话条的渲染条件从 `bgSessions.size > 0` 改为 `stripEntries.length > 0`
   —— 若 `bgSessions` 里只剩(被过滤掉的)当前会话,整条不再渲染,契合 §2.4「能不用
   就不用、只在真并行时存在」。

**教训**:①"当前会话 ∉ 后台集合"是一条**必须显式强制的不变式**,不能靠调用点各自小心
——一处挂载竞态就破;用 `useEffect([sessionId])` 把不变式钉在状态源头。②凡是"用 ref
过滤自己"的副作用,都要问一句**首次挂载时那个 ref 是不是还没赋值**(这里就是 `null`)。
③派生列表(`stripEntries`)与其可见性门槛要用**同一个过滤后的口径**,别一个看
`bgSessions.size`、一个看过滤后的条目,否则会出现"门开着但里面是空/是重复"的错位。

## 3. 明确留后(有理由)

- **explore 多实例**:`explore/session.ts` 的 `_active` 全局单例未动。第二个会话开
  explore 会命中已有的 "already active" 异常 → `driveApiSession` catch 后降级普通执行并
  提示。真正多实例要把单例改按 owner 的 Map(F-30 已有 owner/origin 隔离地基),与
  browseract-comparison Tier1 ② 的"真并发多会话留后"同批做。
- **后台会话的泳道/流式气泡**:subagent lanes 与 streaming 是瞬态 UI,切走即弃,切回不
  恢复(turns 里有最终结果)。
- **从会话条直接停止后台会话**:目前要切过去再停;避免误触,先不加。
- **bridge 维度的命名会话/所有权**:与本文正交(那是外部 agent 之间的隔离),见
  browseract-comparison ②。

## 4. 打开面板自动恢复上次会话(2026-07-08)

**决策**:面板挂载时**自动切到最近一条会话**,而不是停在 WelcomeCard。原来只在欢迎卡
放一个「↩ 继续上次的会话」手动链接(`resumeLastSession`);现在挂载即恢复,回到"上次
离开的地方"。

**实现**(`App.tsx`,复用既有单点入口,零新状态):原本"取最新 session id 填欢迎卡链接"
那个 `useEffect` 里,拿到 `list[0].id` 后除了 `setLastSessionId`,再直接 `await
switchToSession(latest)`——`switchToSession` 本就是"把某会话载入前台"的唯一入口(IDB 整
载历史 + 按 `activeSessionIds` 决定 `running`,见 §2.1),所以恢复态/续接实时流全都免费复用。

**必须的守卫**(否则会和别的恢复路径打架):仅当

- URL **没有** `?session=`(那条 `useEffect` 已负责恢复指定会话),且
- URL **没有** `?fullpage`(带 session 的由上一条处理;不带 session 的整页 tab = 显式"新
  开一个空对话",不该被抢),且
- `sessionIdRef.current === null`(用户没抢在 LIST_SESSIONS 返回前就发了消息)

才 auto-open。想要空白对话:表头 `新对话 (+)` 一直在。

**已知小瑕疵**:挂载到 LIST_SESSIONS 返回之间会**闪一下 WelcomeCard**(那一刻 `turns=[]
&& !running`),之后被 `switchToSession` 灌入 turns 顶掉。本地 IDB 往返很快,先不加
"restoring…" 占位;真机若觉得闪就补一个挂载期的抑制态。

## 5. 测试

真机行在 `docs/tests/platform.md` §5;涉及交互卡路由的坑位若真机爆雷,post-mortem 记
`docs/agent-harness.md` §10.x 并回链本文。
