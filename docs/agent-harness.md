# Agent Harness — 长 loop 稳定性 + Plan 模式

> 本文是 agent harness 改造的 **plan-of-record**。整体架构见
> [architecture.md](./architecture.md)(§3 是当前循环);本文聚焦"如何让循环扛得住
> 长 loop + 引入 Plan 模式",并按项目规矩在 §10 累积实施过程的
> **症状 / 根因 / 修法 / 教训**。
>
> 分支:`feat/agent-harness-plan-mode`。

## 1. 目标

把 `api-engine` 的循环从"短问答可用"升级到"几十步长 loop 仍保质保稳",并引入
Claude-Code 式 **Plan 模式**(审批门 + 实时清单)。两条主线:

- **稳定性**:单次 API 抖动 / 上下文撑爆 / 重复失败 不再杀死整会话。
- **可控性**:复杂任务先出可审批的计划,执行期维护实时 todo,跑动中可 steering。

## 2. 现状与缺口(改造起点)

当前循环 `api-engine.ts:apiEngine.run()`:`sanitizeHistory(历史)+user` → 最多 12 轮
→ 每轮重拉工具、`POST /chat/completions`、串行执行 tool_calls、回灌 → 不再调工具即
DONE,满 12 轮 `max_iterations` 硬停。对短问答很好,长 loop 会死在下面 7 处:

| #   | 缺口                                            | 文件:行                 |
| --- | ----------------------------------------------- | ----------------------- |
| 1   | 无规划阶段,模型每轮重推意图 → 漂移              | —                       |
| 2   | `maxIter=12` 硬停、裸文案、模型不知预算无法配速 | `api-engine:29,418,673` |
| 3   | 无上下文压缩,`messages` 无限增长(仅 sanitize)   | `api-engine:264`        |
| 4   | API 一次抛错即 `finish('error')`                | `api-engine:494–498`    |
| 5   | 无防卡死,可重复同一失败调用烧光预算             | —                       |
| 6   | 信任"无 tool_calls = 完成",无校验               | `api-engine:535`        |
| 7   | tool_calls 串行                                 | `api-engine:543`        |

## 3. 设计:两支柱 + 复用已有接缝

复用(不另起管线):

- **Specialist 拦截**(`handleSpecialistCall:145`,`view_image/generate_image` 在 `:581`
  被拦截、不走 dispatcher)→ `submit_plan / update_plan / spawn_subagent` 照搬。
- **写操作审批门**(`requestWriteConfirmation:446` + `pendingConfirmations` + 超时)→
  计划审批门同款。
- **会话持久化 + 重启恢复**(`session:65` / `recover…:196`)→
  compaction / checkpoint / 续跑 的现成底座。

**支柱 A — Plan 模式**:两阶段状态机。规划阶段**工具层强制只读** → `submit_plan` 呈递
计划 → 审批门 → 执行阶段 plan 块每轮注入、`update_plan` 维护实时清单(TodoWrite 语义:
恰好一个 in_progress、做完即勾、activeForm)。批准的 plan **播种** todo。

**支柱 B — 稳定性地基**:重试退避、防卡死熔断、自适应预算、结构化 LLM 压缩 +
microcompaction、收尾 verify-with-evidence、优雅 checkpoint→续跑。

## 4. 权威契约

**新拦截工具**(引擎拦截,不走 dispatcher):

- `submit_plan({goal, steps[]})` — 规划期;→ `PLAN_PROPOSED` → 审批门阻塞。
- `update_plan({updates:[{id,status,note?}]})` — 执行期;TodoWrite 语义。
- `spawn_subagent({task, allowed_tools?})` — 隔离嵌套 `run()`,**串行**,只回摘要。

**消息**(`messages.ts`):`UserMessageReq.mode:'chat'|'plan'`;SW→SP
`PLAN_PROPOSED / PLAN_UPDATED / PLAN_DECISION_REQ`;SP→SW
`PLAN_DECISION_RESP{decision,editedSteps?}`、`STEER_MESSAGE{text}`;
`SESSION_DONE.reason += 'checkpoint'`。

**状态**(`session.ts`):`mode` / `plan:PlanState` / `budget{stepsUsed,promptTokens}`。

**参数(默认,可调)**:

- 重试:`maxAttempts=3` / `base=600ms` / `max=8s` / 指数退避 + 50–100% 抖动 / 认
  `Retry-After` / abort 不重试(`resilience.ts`)。
- 压缩:`usage.prompt_tokens` 越阈值触发;保留 system + plan + 最近 6 轮,更早摘要成
  ledger。
- 防卡死:同 `(tool,args)` 连续失败 3 次熔断;8 轮零 plan 进展熔断(后者随 Plan 落地)。
- 预算:步数 12 → 自适应 ~40 + token 护栏;满则 checkpoint(非硬停)。

**压缩 ledger 段**(仿 Claude Code 续聊 summary,适配浏览器):用户意图 / 已完成步骤 +
关键结果 / 抓到的关键数据(笔记·URL)/ 当前 tab 状态 / 下一步(对 plan)/ 错误与限流 /
待确认项。

## 5. 分阶段

| Phase                        | 交付                                                                                                 | 状态       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- | ---------- |
| **0** 稳定性地基             | 重试退避 · 防卡死 · 自适应预算 · 结构化压缩 + microcompaction · `## Doing tasks` prompt · checkpoint | **进行中** |
| **1** Plan 工件 + 清单       | `plan.ts` · `update_plan`(TodoWrite) · plan 注入 · 实时清单 UI                                       | 待         |
| **2** 审批门(headline)       | 只读规划阶段 · `submit_plan` · 审批门 · PlanCard · Chat/Plan 切换 · plan 播种 todo                   | 待         |
| **3** 校验 + steering + 续跑 | verify-with-evidence · `STEER` 注入 · checkpoint→继续                                                | 待         |
| **4** 子 agent               | `spawn_subagent` 上下文隔离(串行 · 只回摘要)                                                         | 待         |
| 选-流式                      | SSE + `ASSISTANT_TURN_PATCH` 增量渲染                                                                | 纳入       |
| 选-指标                      | 每 run 结构化指标 + 日志页 run summary                                                               | 纳入       |
| 选-长期记忆                  | 跨会话记忆(新存储 + 召回)                                                                            | 纳入       |

## 6. 完整性矩阵(20 提醒覆盖)

✅ 已在核心 / ➕ 提醒后补强 / ⏸️ 轻量版或暂缓。

| 提醒                   | 处置 / 落点                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------- |
| 规划器(结构化输出)     | ✅ P2 `submit_plan`                                                                    |
| 执行器(重试回退)       | ✅ P0 重试 + P2 按 plan 执行                                                           |
| 反思/重规划            | ➕ `update_plan` 可改/插步 + P3 校验驱动重规划                                         |
| 上下文管理(总结)       | ✅ P0 结构化 LLM 压缩                                                                  |
| 稳定性(步数/校验/日志) | ✅ P0 自适应上限 + 防卡死 / P3 校验 / `log.ts` + harness trace                         |
| 并行步骤 + 展示可干预  | 展示+干预 ✅ P2/P3;并行步骤 ⏸️(tab 并发=ping-pong 风险)                                |
| 工具验证 + 沙盒/安全   | ✅ write-confirm + dispatcher 参数校验 + sandbox eval + P2 只读门 + P4 `allowed_tools` |
| 人机协同(HITL)         | ✅ write-confirm / P2 计划审批 / P3 steering                                           |
| 多智能体               | ✅ P4 子 agent(+ 现有多模型 slots)                                                     |
| 记忆类型细分           | ➕ 短期=消息窗 / 工作=plan+ledger / 长期=跨会话记忆(纳入)                              |
| 可观测/监控(OTel)      | ⏸️ 无 collector → 指标-lite(纳入)                                                      |
| 错误恢复 + 优雅降级    | ✅ P0 retry/熔断/checkpoint + 降级阶梯                                                 |
| 工具约束/权限          | ✅ `access` + write-confirm + P2 只读 + P4 `allowed_tools`                             |
| 上下文压缩细节         | ✅ P0(§4 算法)                                                                         |
| 缓存(LLM 响应)         | ⏸️ 不可依赖 → 稳定排序利于命中                                                         |
| 流式 + 中断            | 中断 ✅(abort + P3 steering);流式 ➕ 纳入                                              |
| 状态持久化             | ✅ IDB session-store + P0 扩(plan/budget/ledger)                                       |
| 评估/测试框架          | ✅ vitest + harness 单测;场景 eval ⏸️ 暂缓                                             |
| 提示词管理(版本)       | ➕ 片段集中 + 版本常量 + git                                                           |
| 成本控制(token 预算)   | ✅ P0 token 预算 + UI 计量条                                                           |
| 动态工具选择/注册      | ✅ 已存在(每轮重拉)+ ➕ 工具集过大时子集化                                             |
| 多模态                 | ✅ 已存在;压缩须遵守"图仅一轮"                                                         |

## 7. 暂缓(记录在案,非丢弃)

- **场景 eval 框架**:mock provider 跑 golden 多轮回归(最有价值但可晚做)。
- **完整 OTel**:客户端无 collector → 指标-lite 替代。
- **LLM 响应缓存**:任意兼容端点不可依赖 provider cache → 仅保证 system + tool schema
  稳定排序。
- **并行步骤执行**:tab/CDP 并发 = ping-pong 风险(见 adapter-hot-plug §10.4/§10.21),
  仅"不同 tab 只读"谨慎可选。

## 8. 守规矩

纯 harness 改动**不碰** marketplace / adapter sha256;每个非平凡修法提交前在 §10 记
症状/根因/修法/教训;不自动 commit/push;每 Phase 收尾 `npm run check`。

## 10. 实施日志(症状 / 根因 / 修法 / 教训)

### 10.1 Phase 0 slice 1 — 重试退避 + 防卡死原语(`resilience.ts`)

- **背景**:缺口 #4 / #5。`chatCompletion` 一次 throw 即 `finish('error')`(整会话死);
  模型可空转重复同一失败调用,烧光步数预算。
- **修法**:新增 `src/agent/resilience.ts` 纯原语
  (`isRetriableStatus / isRetriableNetworkError / parseRetryAfter / retryDelayMs /
sleep / toolCallKey / ThrashTracker`),`tests/resilience.test.ts` 全覆盖;
  `chatCompletion` 内置有界重试(仅 408/429/5xx + 网络错误,abort 不重试,认
  `Retry-After`)。`ThrashTracker` 已就绪,下个 slice 接入主循环。
- **教训**:重试边界要"只重试会自愈的"——4xx(bad-request/auth)与 abort 必须**直穿**,
  否则只是延迟用户该立刻看到的错误。退避带抖动避免惊群;退避等待要 abort-aware,
  否则 Stop 后仍空等。

### 10.2 Phase 0 slice 2 — 自适应预算 + 防卡死接入 + 优雅 checkpoint

- **背景**:缺口 #2 / #5。`maxIter=12` 硬停 + 裸 `max_iterations`,30 步任务在 12 步
  暴毙;模型不知预算无法配速;`ThrashTracker`(slice 1 已建)尚未接入主循环。
- **修法**:
  - 新增 `src/agent/budget.ts` 纯模块(`budgetVerdict / shouldCompact /
    renderBudgetNote` + `DEFAULT_BUDGET`,步数 40 / soft 80k / hard 120k token),
    `tests/budget.test.ts` 全覆盖。
  - `api-engine.ts` 主循环:`for(;;)` + 每轮 `budgetVerdict` 闸门;system prompt 每轮
    追加 `renderBudgetNote`(模型据此配速);用真实 `usage.prompt_tokens` 跟踪上下文;
    每个工具调用后 `thrash.record`,同 `(tool,args)` 连续失败 3 次或预算耗尽 → 不再
    硬停而是 `finish('checkpoint')`。
  - 新增 `OrchEvent` 的 `notice` 事件(SW 转 `SESSION_NOTICE`)+ `SessionDoneReason`
    的 `'checkpoint'`(可恢复、保留 session 绑定,镜像 SW-recycle 的 recoverable 路径);
    App.tsx 对 checkpoint 不再追加冗余系统行(notice 已解释)。
- **取舍**:本 slice **未**把 `run()` 抽成可注入的 `driveLoop`——决策逻辑已全部下沉到纯
  模块(`budget.ts` / `resilience.ts`)并单测覆盖,主循环只是顺序编排;权衡 230 行整段
  搬移的匹配风险后,改用就地小改 + 纯模块测试。引擎级集成测(注入假 completion 驱动多
  轮)留作后续(`run()` 还依赖 `resolveSlots`/IDB,需先解耦)。
- **教训**:① checkpoint 复用既有 recoverable 续聊路径,几乎零新管线;② 防卡死要在工具
  结果**已回灌**后再判断,断点 sibling tool_calls 由 `sanitizeHistory` 在续跑时补齐;
  ③ token 上限 model-dependent,当前是安全网,真正压上下文靠 slice 3 压缩。

### 10.3 Phase 0 slice 3 — 结构化 LLM 压缩 + `## 工作方式` prompt(Phase 0 收尾)

- **背景**:缺口 #3。`messages` 无限增长 → 长 loop 必撑爆窗口。
- **修法**:
  - 新增 `src/agent/compaction.ts` 纯模块(`findCompactionBoundary` 找**不切断 tool 组**
    的干净边界 / `renderHistoryForSummary` 截断渲染 / `buildCompactionMessages` 结构化
    摘要 prompt / `applyCompaction` 原地 splice),`tests/compaction.test.ts` 覆盖。
  - `api-engine.ts` 主循环每轮先 `compactIfNeeded()`:`shouldCompact(promptTokens)` 真
    则发一次**摘要子调用**(主模型,无工具)把 older 半截压成一条进度摘要 user 消息,
    `lastPromptTokens` 归零等下轮重测;失败则跳过(hard-token checkpoint 兜底)。
  - `api-system-prompt.ts` 加 `## 工作方式`(先规划/用证据/高效用工具/预算意识),
    仿 Claude Code 的 Doing-tasks 骨架。
- **取舍**:microcompaction(逐条清陈旧大结果)被结构化整段压缩**吸收**,加之单条结果
  插入时已 64k 截断,暂不单独做。
- **教训**:压缩边界必须保证 older 无悬空 tool_calls(切点走过 tool 即可),否则续发请求
  400;摘要消息用 `role:'user'` 最安全(不破坏 tool 配对、不挑 provider)。

**Phase 0 完成**:retry/backoff(§10.1)+ 自适应预算/防卡死/checkpoint(§10.2)+ 结构化
压缩/prompt(§10.3)。typecheck 干净,测试 1254 全绿(+40)。引擎级集成测仍欠(见 §10.2
取舍)。

### 10.4 Phase 1 — Plan 工件 + 实时清单(TodoWrite 语义)

- **背景**:缺口 #1。无 todo 脚手架,模型每轮从历史重推意图 → 漂移。
- **修法**:
  - 新增 `src/agent/plan.ts` 纯模块(`PlanState`/`PlanStep` + `parsePlanSteps` /
    `seedPlan` / `planProgress` / `renderPlanBlock`),`tests/plan.test.ts` 覆盖。
  - `update_plan` 工具(TodoWrite 语义:**传完整列表**、恰好一个 in_progress、做完即
    标 completed),引擎拦截(不走 dispatcher)→ 写 `session.plan` → emit `plan_updated`
    → ack 模型。`renderPlanBlock(session.plan)` 每轮注入 system(无 plan 时给一句使用
    提示)。
  - 协议:`OrchEvent.plan_updated` → SW 转 `PLAN_UPDATED`;`SessionState.plan` 持久化
    (跨重启 + 历史视图);App.tsx 新增 `PlanChecklist`(inline 样式,免改 CSS)实时勾选,
    新对话清空、打开历史时载入。
- **教训**:full-replace 比 id 增量更稳(无 id 管理、模型不会引用失效 id);plan 持久化进
  `SessionState` 自动获得跨 SW-recycle 续跑 + 历史回看,零额外管线。
- **欠**:no-plan-progress 熔断(N 轮 completed 不增)留到 Phase 3(需配合校验语义)。

### 10.5 Phase 2 — Plan 模式审批门(headline)

- **设计**:`UserMessageReq.mode:'chat'|'plan'`。plan 模式下 `run()` 先跑
  `runPlanningPhase()`:system=`systemPromptPlan()`(强制只读),工具=注册表里
  **非 write** 的 + `submit_plan`(+ vision);写工具既被**过滤**也在执行处**二次拦截**
  (lookupAdapter.access==='write' → 拒)。模型 `submit_plan({goal,steps})` →
  `ctx.requestPlanDecision(plan)`(镜像 write-confirm 的 SW↔SP 门 + 10min 超时)→
  - approve(可带 editedSteps)→ `session.plan={...,approved:true}` → emit
    `plan_updated` → **落入执行循环**(已有 plan 注入 + update_plan)。
  - reject 无反馈 → 取消;reject 带反馈 → 回灌让模型改后重 submit。
  - 无 tool_calls(模型直接答)→ 简单任务,直接结束。
- **协议**:`PLAN_DECISION_REQ/RESP` + `PlanDecision`;`EngineContext` 加 `mode` +
  `requestPlanDecision`;App.tsx composer 加 Chat/Plan 切换、`PlanApprovalCard`
  (可编辑步骤再批准,镜像 WriteConfirmCard)。
- **取舍**:mode 是**逐消息**的(不黏在 session),每条 plan 消息重新规划——可预测,
  避免"批准过一次后续都跳过规划"的歧义。规划阶段复用执行阶段的工具处理逻辑有一定重复
  (in-place 结构所限),用 `emitFinal`/`ackTool` 小闭包收敛。
- **教训**:只读保证要**双保险**(过滤 + 执行拦截)——只过滤不够,模型可能直接喊出写工具
  名,executeTool 会照跑(带 write-confirm)。审批门完全复用 write-confirm 的 pending-map
  + 超时范式,零新机制。

### 10.6 Phase 3 — verify-with-evidence + steering

- **Steering**:`STEER_MESSAGE{sessionId,text}`(仅作用于运行中的 session)→ SW
  `steerQueue` Map → `EngineContext.takeSteerMessages()` 引擎每轮**迭代顶部**(此刻所有
  tool_calls 已应答,插 user 消息安全)drain 并并入 `messages`。App.tsx:运行中输入框可用,
  Enter / 「插话」按钮发 steer(不杀会话),Stop 仍在。
- **校验**:模型想结束(无 tool_calls)时,若有**已批准且未完成**的 plan,注入一次性
  nudge(列出未完成步骤,要求完成或显式标记),`verifiedOnce` 保证至多一次,避免死循环。
- **取舍**:no-plan-progress 熔断**故意不做**——步数预算(40)+ 防卡死(同调用 3 连败)+
  校验 nudge 已覆盖失败面,而"N 轮无进展"启发式易误杀正当的长步骤。预算是最终兜底。
- **教训**:steering 注入点必须在迭代顶部(tool 配对干净处);steerQueue 在 `driveApiSession`
  finally 清理,避免跨 run 串味。

### 10.7 Phase 4 — 子 agent 上下文隔离

- **设计**:`spawn_subagent({task, allowed_tools?})` 拦截工具。`runSubagent` 跑一个独立
  `subMessages` 的小循环(自有 15 步预算 + 子 agent system prompt),工具=注册表**只读**
  子集(再按 `allowed_tools` 收窄),**禁写、禁嵌套**。子 agent 的中间消息**不进**主
  `messages`,只把最终文字 digest 作为 spawn_subagent 的 tool 结果回灌主循环 → 主上下文
  只增加一段摘要而非成堆原始数据(长 loop 最大杠杆)。
- **并发**:**串行**——共享 `ctx.executeTool`(同一 CDP/tab 世界),并行会触发
  trampoline/ping-pong(见 adapter-hot-plug §10.4/§10.21)。
- **UI**:主面板只显示「🧵 子 agent 开始 / 完成」notice + 一条 trace 卡,内部步骤 headless
  (保持主对话干净——正是隔离的目的)。
- **教训**:子 agent 必须 abort-aware(共享 `ctx.signal`)且复用主模型 cfg;digest 要求
  模型"把关键数据/URL 都写进结论",否则隔离=信息丢失。

### 10.8 选项 — 流式 SSE + 增量反馈

- **设计**:新增 `src/agent/stream.ts` 纯模块(`parseSSEChunk` 切完整 `data:` 事件 + 留尾;
  `createStreamAccumulator` 按 delta 累加 content / reasoning_content / 按 index 拼
  tool_calls / usage / finish_reason),`tests/stream.test.ts` 覆盖。`chatCompletion` 加
  `stream`/`onText`:请求体注入 `stream:true`+`stream_options.include_usage`,200 后读
  `resp.body` reader → 累加 → 回填成同一个 `ChatCompletionResponse` 形状(对调用方透明)。
- **UI**:**仅主执行轮**流式(规划/子 agent/压缩仍非流);`onText` 节流(每 ≥24 字)emit
  `iteration_progress{phase:'streaming',textLen}` → 复用既有 ProgressBanner「模型正在生成
  ~N 字」。`IterationPhase` 加 `streaming` + `textLen`。
- **取舍**:`STREAM_MAIN_TURN` 常量开关(个别 endpoint 不支持流式/stream_options 可一键关);
  retry 只在初始非-2xx 时生效,流开始后不重试(不能重放半个流);usage 靠 include_usage 带回,
  预算/压缩照常。未做"逐字渲染进气泡"(需要更多 UI 管线),live 字数已消除黑屏。
- **教训**:tool_calls 流式按 `index` 累加是关键(id/name 只在首帧给,arguments 分帧拼);
  SSE 解析要按"完整行(有 \\n)"切、留不完整尾给下个 read。

### 10.9 选项 — 指标-lite

- **设计**:新增 `src/agent/metrics.ts` 纯模块(`RunMetrics` + `newRunMetrics` +
  `renderRunSummary`),`tests/metrics.test.ts` 覆盖。`run()` 起始建 `metrics`,沿途累加
  (steps / toolCalls+errors / compactions / subagents / prompt+completion tokens),
  `finish()` 里 `log('metrics', renderRunSummary(...))`。
- **取舍**:客户端扩展无 OTel collector → 用既有 `log.ts` 环形缓冲 + 日志页当"面板"
  (按 `metrics` scope 过滤即得每 run summary),零新 UI。retry 次数不入 metrics(已各自
  warn 日志)。
- **教训**:`renderRunSummary` 把 `endedAt` 作参传入保持纯/可测;指标累加点散落但每处一行,
  借现有拦截/执行分支顺手记。

### 10.10 选项 — 跨会话长期记忆

- **设计**:新增 `src/agent/memory-store.ts`(**独立** IndexedDB 库 `webchat-memory`,不碰
  session-store 的 schema/版本)+ `remember({fact})` 拦截工具。`run()` 起始
  `listMemories()` → `renderMemoryBlock()` 注入规划/执行两阶段 system。模型调 `remember`
  存一条用户长期事实/偏好;下次 run 自动召回。`tests/memory.test.ts` 测纯 `renderMemoryBlock`。
- **记忆模型三层**:短期=消息窗(+sanitize)、工作=plan + 压缩 ledger、长期=本模块。
- **取舍**:召回是"全量注入(≤20 条)"而非向量检索——客户端无嵌入服务,事实量小,够用;
  记忆**管理 UI**(查看/删除)暂缓(`deleteMemory` 已备好,接 UI 即可)。
- **教训**:独立 IDB 库避免 session-store 版本升级冲突;`indexedDB` 只在函数内引用,模块
  顶层无副作用,故 node 测试可安全 import(只测纯函数)。

### 10.11 跟进(实地测试反馈)— 禁用 adapter 感知 + plan 可见性

- **背景**:首次实地测(b 站 plan 模式)发现模型没用 bilibili adapter 而退化到 generic。
  根因是 `chrome.userScripts 不可用` → bilibili 的 search/subtitle(func/Phase B)未注册,
  只有 hot(pipeline)在工具列表里。非 harness bug,但暴露两个 UX 盲点。
- **修法**:
  - **禁用 adapter 感知**:SW `disabledFuncAdapterNote()`——Phase B 关 + 装了 func/mixed
    adapter 时,(a) 发一次 `SESSION_NOTICE` 提示用户去开「允许用户脚本」;(b) 经
    `EngineContext.environmentNote` 注入 system,告诉模型这些站点工具不可用、别用 generic
    假装能做。
  - **plan 可见性**:进入规划阶段先 emit 一条 notice(「🗺️ 规划模式:研究中,随后给你计划
    待批准」),让用户知道计划在路上、别过早 abort。计划本身已有 `PlanApprovalCard`(提交时
    审批、步骤可编辑)+ `PlanChecklist`(批准后实时勾选)两处展示。
- **教训**:func/pipeline 混装时"装了 ≠ 能用",环境前提(userScripts 开关)要对用户和模型
  都显式化;`npm run build` 重载后该开关常被 Chrome 重置。

### 10.12 Round 2 — 补齐剩余计划项(R1–R7)

一轮把之前刻意暂缓 / 欠的都补上:

- **R1 引擎可测化 + 集成测**:`run()` 抽成 `runApiSession(ctx, deps?)`,deps 可注入
  `complete`(LLM)/ `slots` / `budget`,**production 路径不变**(三者默认回退真实实现)。
  新增 `tests/api-engine.test.ts`:mock session-store,用假 LLM 驱动真实循环,10 个金标
  场景覆盖 chat / 工具 / thrash / budget-checkpoint / plan 审批 / 拒绝 / 只读规划 / 子
  agent / steering。
- **R2 工具子集化**:`tool-select.ts` `selectTools`——工具数 > 阈值(40)时保留 generic +
  **任务文本点名的站点**;没点到任何站点则**全保留**(绝不 strand 模型)。纯函数可测。
- **R3 逐字渲染**:流式 `onText` → `assistant_delta` → `ASSISTANT_TURN_PATCH` → App.tsx
  实时把部分 assistant 文本渲染进气泡,最终 `ASSISTANT_TURN` 落定。
- **R4 记忆管理 UI**:菜单「🧠 记忆」页,`LIST_MEMORIES` / `DELETE_MEMORY` 列出 + 删除。
- **R5 no-progress 熔断(谨慎版)**:`NoProgressTracker`——有 approved plan 且连续 N(8)轮
  **既无 plan 进展又无成功工具调用**才 checkpoint(双条件,不误杀长步骤)。
- **R6 场景 eval 框架**:即 R1 的 `runScenario` 金标场景集,作为 harness 行为回归护栏。
- **R7 prompt 版本常量**:`PROMPT_VERSION`,run() 启动日志带上,变更可追踪。
- **教训**:用"可注入 deps + 默认回退真实实现"加测试缝,比整段抽 `driveLoop` 风险小得多
  (production 零行为变化,测试 1281→1291 全绿);工具子集化的安全底线=点不到站点就全保留。

---

## 11. 完成状态(2026-06-02)

Phase 0–4 + 三个选项(流式 / 指标-lite / 长期记忆)+ Round 2 补齐项(R1–R7)**全部落地**。
typecheck 干净,**1291 vitest 全绿**(从基线 1214 +77),改动文件 eslint/prettier 干净
(仓库历史遗留的 lint/format 问题在 `tests/adapters/*` 等未触及文件,与本次无关)。

**新增纯模块**:`resilience` `budget` `compaction` `plan` `stream` `metrics` `memory-store`
`tool-select`,均单测;**引擎集成测** `tests/api-engine.test.ts`(假 LLM 驱动真实循环)。
**新工具**:`update_plan` `submit_plan` `spawn_subagent` `remember`(全部引擎拦截)。

**真正不做(技术理由,非遗漏)**:完整 OTel(metrics-lite 替代)、LLM 响应缓存(任意端点
不可依赖)、并行步骤执行(tab 并发 = ping-pong 风险)。

**建议**:在真浏览器里把 plan 模式 + 流式逐字 + 子 agent + 记忆 跑一遍冒烟验证(单测覆盖
逻辑,但 SSE / IDB / 审批门 UI 等集成路径值得一看)。
