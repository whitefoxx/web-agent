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
  - 超时范式,零新机制。

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

- **设计**:新增 `src/agent/memory-store.ts`(**独立** IndexedDB 库 `web-memory`,不碰
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

### 10.13 跟进 — 反思/重规划收尾 + 实时 token/步数计量条

补齐两个 🟡 项里有产品价值的:

- **② 反思 / 重规划(plan 模式收尾)**:原来的"未完成步骤 nudge"升级成**至多一次的收尾
  自检**(`reflectedOnce`):模型想结束时若有 approved plan——有未完成步骤就催它收尾;全部
  完成则让它**对照 goal 自检**(有无遗漏/质量问题),需要就 `update_plan` 加步骤继续,否则
  给最终答复。补上 #3 的"自动反思"环节。
- **① 实时计量条**:引擎每轮 emit `run_stats{step,promptTokens,completionTokens}` →
  `RUN_STATS` → composer 上方小字「步 N · 上下文 ~Xk tok · 输出 ~Yk tok」(运行中显示,
  结束清空)。补上 #20 的 UI 计量。
- **教训**:收尾自检 gate 必须 at-most-once(`reflectedOnce`)否则死循环;计量条复用既有
  metrics 字段,零额外计算。测试 1291→1293(`runScenario` 加反思 + run_stats 两条断言)。

---

### 10.14 steering 插话在「最后一轮」必丢 —— drain 只在循环顶部、内存队列被 finally 清掉(2026-06-03 修)

**症状**:运行中插话(steering),会话没被打断(符合设计),但插的话**没生效**;重开会话时,
那条中途插入的 message **不见了**。

**根因**:steer 的整条生命周期里,**唯一**把它写进 `session.history` + 落盘的地方,是
`api-engine` 循环**顶部**那一次 `takeSteerMessages()`。但循环的终止出口——模型给出最终答复
(无 tool_call)走 `return finish('no_more_commands')`——是**直接 return、不回到顶部**,不会
再 drain。时间线:

1. 模型进入**最后一轮** `complete()`,流式吐最终答复;
2. 用户恰恰这时看到答复跑偏、插话 → SW `handleSteer` 把文本塞进**内存** `steerQueue`
   (session 还 active,所以排得进去——这就是"没打断会话"的表象);
3. 这一轮返回纯文本、`toolCalls` 为空 → `return finish('no_more_commands')`,循环结束,**再没
   回到顶部 drain**;
4. 这条 steer 从没 `push` 进 `messages`、从没 `appendTurn`、从没落盘;
5. SW 的 `finally` `steerQueue.delete(session.id)` 把内存队列丢掉 → **永久丢失**。

重开会话是 `historyToUiTurns(s.history)` 从落盘 history 重建;用户当时看到的 `↪ …` 气泡只是
`App.tsx` 的**本地乐观 UI**,从没持久化。**结论:steering 只在"模型后面还有下一轮(还会再调
工具)"时有效;一旦在最后一轮插话(恰恰是看到最终答复才想纠正的高频场景),必丢。** 次要触发
路径:答复刚结束、UI `running` 还没翻 false 的瞬间插话,SW `!activeSessions.has` 直接静默
`return` 丢弃,症状一模一样。

旧测试 `steering: a mid-run injected message reaches the very next turn` 一直绿,是因为它的
`responses` 第一条是 **tool call**,强行制造了第二轮才 drain,从没覆盖"最后一轮是纯文本"这条
路径——假安全感。

**修法**(核心 + 加固):

- **引擎(治本)**:顶部 drain 抽成 `drainSteers()`(fold 进 `messages` + `appendTurn` + 落盘,
  返回是否 fold 了),并在**每个** `return finish('no_more_commands')` 出口
  (`!toolCalls` 与 `finish_reason!=='tool_calls'` 两处)**先 drain 一次**:有 steer 就 `continue`
  多走一轮让模型真正回应它,没有才 finish。
- **SW(堵 race)**:`handleSteer` 在 session 已 idle 时不再静默 `return`,改走
  `rerouteSteerAsFollowUp` —— `loadSession` 后当作一次正常后续 `driveApiSession` 续跑(load
  期间若又变 active 则改回入队 `enqueueSteer`)。晚到的 steer 因此变成普通后续轮,绝不静默丢。
- **回归测试**:steer 落在**纯文本最后一轮**(`takeSteerMessages` 在第 2 次调用才返回它)→ 断言
  它逼出第二次 `complete()`、进了下一轮 context、且进了 `session.history`。1303 vitest 全绿。

**教训**:**「插话」的持久化不能搭车在循环的 drain 时机上**——drain 点(顶部)与退出点(中途
`return`)不重合时,凡是"只在 drain 点持久化"的东西,在"插话恰好发生在最后一轮"时必然丢。规则:
**任何"被 fold 进上下文才算数"的用户输入,必须在每一个 loop-exit 之前再 drain 一次**;承载它的
队列是纯内存(`finally` 会清),所以落盘必须发生在丢队列之前;UI 的乐观气泡 ≠ 持久化,二者要对账。

---

### 10.15 plan 清单结束停在 0/N —— 勾选全靠模型自觉、无兜底,且缺 skipped/failed 词汇(2026-06-03 修)

**症状**:plan 模式跑完,活儿其实都做了,但清单显示 0/4、四步全是 `○`,一个都没打勾。

**根因**:清单勾选 100% 由每个 step 的 `status` 驱动(UI `PlanChecklist` 纯按 status 渲染),而
status 只在模型主动调用 `update_plan` 时才变(`api-engine` 把整张列表整体替换)。这一轮模型一次
`update_plan` 都没调——submit_plan 把步骤种子化为全 `pending`,模型把这张"别人给的清单"当静态的、
不维护,连 `in_progress` 都没标过。唯一的安全网是一次性反思(`reflectedOnce`),且只是软提醒:模型
无视它直接给最终答复,循环就在 0/4 收场。**没有任何确定性兜底**把结束时的清单对账成真实状态,UI
就忠实显示了那张全 pending 的种子清单。

**修法**(用户的要求是"如实",不是"自动打钩=假装完成"):

- **扩词汇**:`PlanStepStatus` 增加 `skipped`(主动跳过)、`failed`(尝试失败),贯穿
  `parsePlanSteps` / `update_plan` 工具 enum / `MARK` / `renderPlanBlock` / UI;`activeForm` 复用为
  skip/fail 的一句原因。`planProgress` 增加 `settled`(= completed + skipped + failed)。
- **结束时强制对账(确定性,但不造假)**:模型想结束却还有未落终态(pending/in_progress)的步骤时,
  `reflectedOnce` 这一次不再只发软提醒——而是 `forceReconcile`:下一轮 `tool_choice` 强制成
  `update_plan`,要求模型把每个剩余步骤**如实**标成 completed / skipped / failed(后两者写原因)。
  **不**自动 stamp completed(那是假装成功)。模型若仍不如实标,保留诚实的 pending,绝不伪造。
- **UI 区分**:`✓` 完成 / `⊘` 跳过 / `✗` 失败(红) / `▸` 进行中 / `○` 未开始;标题显示
  「N/total(X 跳过 · Y 失败)」。
- **stall 计量改用 settled**:把一步标 skipped/failed 也是进展,不该触发 no-progress 熔断。
- 测试:planProgress settled、parsePlanSteps/renderPlanBlock 接受 skipped/failed、引擎"未落定步骤→
  强制 update_plan→如实落 completed+skipped→收尾"。1303→1307 全绿。

**教训**:**真实状态不能依赖模型自觉回填,更不能为了清单好看而造假。** 给够词汇(skipped/failed
而非只有 completed)让模型能如实表达;在"结束"这个确定性时点强制对账(forceReconcile + 强制
tool_choice),但只让模型填真值、不替它伪造。诚实 > 好看:宁可显示失败/跳过,也不要假的 ✓。状态机的
真值要么由真实执行结果写入(完成/失败),要么由显式决策写入(跳过),绝不由"反正结束了"推断。

> **更新(§10.17)**:本节的「强制 update_plan 对账」因 GLM thinking mode 拒绝 object tool_choice
> 而 400,已改为 nudge-only(`tool_choice:'auto'` + 提示)。诚实兜底不变。

---

### 10.16 选了「先计划再执行」却没让确认计划 + 中途要计划无入口(2026-06-03 修)

**症状**:用户明确选了「先计划再执行」(plan 模式),任务却没弹计划确认卡、直接给了答案;中途插话
「给出 plan 给我 confirm」也没用。

**根因**:plan 模式的规划阶段有**两个模型自作主张的逃生门**,都绕过了用户的明确选择:

1. **直接作答**(`runPlanningPhase`):模型在规划阶段不调 `submit_plan`、直接给文字 → 旧逻辑
   `return 'answered'` → 当「简单任务」收尾,没计划、没确认卡。
2. **`simple:true`**(submit_plan 处理):模型把计划标 `simple:true` → 系统「任务较简单,直接开始」,
   自动批准、不弹卡。

两者都是**模型在替用户决定"要不要确认"**。而且执行阶段没有 `submit_plan` 工具,中途想要一个可
确认的计划也**没有入口**——插话只会被当普通消息折进去。

**修法**(用户拍板:① 选了 plan 模式就不准跳过确认;② 中途要计划从插话文字识别意图):

- **严格 plan 模式**:删掉 `simple:true` 自动批准(submit_plan 一律走 `requestPlanDecision` 弹卡);
  规划阶段「直接作答」不再 `return 'answered'`,而是 `forceSubmitPlan`——下一轮 `tool_choice` 强制
  `submit_plan`,逼出一个可确认的计划(哪怕任务简单)。从 SUBMIT_PLAN_TOOL 里移除了 `simple` 参数。
- **中途重规划**:`looksLikeReplanRequest(text)`(`plan.ts` 纯函数,关键词启发式:含"计划/规划/plan"
  且含"确认/给我/列出/重新…")。drainSteers 折叠插话时若命中 → 置 `pendingReplan`;执行循环顶部消费
  它 → 重新跑 `runPlanningPhase`(submit_plan → 确认卡)→ 批准后带新计划continue执行。chat / plan
  两模式都生效(chat 模式也能"插话→可确认计划")。
- 测试:simple 不再跳过确认、直接作答被强制 submit_plan、插话触发重规划进确认门、`looksLikeReplanRequest`
  正反例。1307→1311 全绿。

**教训**:**用户的显式选择 > 模型的自我判断。** 模式开关代表用户意图(选了"先计划再执行"=我要审),
不能让模型用"我觉得简单"把它优化掉。要兜住,就在关键时点给**确定性入口**:强制 `tool_choice`(逼出
计划 / 逼出对账,见 [§10.15]),而不是发个软提醒寄希望于模型配合。意图识别这类"宁滥勿缺"的入口,
误报代价低(多弹一次可拒绝的卡)就可以接受。

> **更新(§10.17)**:本节的「强制 submit_plan」因 GLM thinking mode 拒绝 object tool_choice 而 400,
> 已改为有界 firm nudge + 优雅放行(超过 `MAX_PLAN_NUDGES` 就让答案通过、不再报错)。

---

### 10.17 强制 tool_choice 在 GLM-5 thinking mode 下 400 整个会话(2026-06-03 修)

**症状**:选了「先计划再执行」,跑了一会儿(模型在规划阶段还做了 8 次 youtube 搜索、然后输出
6724 字直接作答),最后 **400 报错**会话挂掉:
`invalid_parameter_error: The tool_choice parameter does not support being set to required or object in thinking mode`。

**根因**:§10.16(强制 submit_plan)、§10.15(强制 update_plan 对账)、§10.16(重规划)都用
**对象形式的 `tool_choice`**(`{type:'function', function:{name}}`)来"保证"模型一定调某工具。但
用户的 provider(阿里云 maas 的 **glm-5**)在 **thinking mode** 下**硬拒绝** object/`required`
形式的 tool_choice → 400 → 规划阶段 `complete()` 抛错 → 整个会话 `error`。**强制 tool_choice
不可移植。** 另外能看到:模型在规划阶段直接用只读工具把任务做了(搜了 8 次)、再想直接作答——
我那个"强制 submit_plan"本意正是拦它,却因 400 反而把会话搞挂。

**修法**:**删掉所有 object `tool_choice` 强制**,改成可移植的「有界 firm 提示 + 优雅兜底」:

- 规划阶段模型直接作答 → firm nudge(明确"把『先研究X』写成计划步骤,不要现在就执行"),至多
  `MAX_PLAN_NUDGES`(3)次;超了**优雅放行**(`return 'answered'` + 一条 warning notice),不再
  死循环到 `error`。
- §10.15 对账、§10.16 重规划同样改 `tool_choice:'auto'` + 提示(不再强制)。诚实兜底不变:对账
  不替模型造假、放行不假装有计划。
- 测试:新增「模型死活不计划 → 优雅放行不报错」用例;去掉原来断言 forced tool_choice 的部分。
  1311→1312 全绿。

**教训**:**「强制模型一定调某工具」没有可移植的硬保证**——object/`required` 的 tool_choice 至少在
GLM thinking mode 会 400。portable 的只有 `'auto'` + 强提示 + 有界重试 + 优雅兜底。任何"强制/对账/
重规划"机制都必须能在 provider 拒绝时**降级**,而不是把异常抛成整个会话失败。这条把 §10.15、§10.16
里"forced tool_choice"的实现都收敛成了 nudge-only。

---

### 10.18 plan 模式对齐业界做法(Claude Code / Codex)+ 修掉脱节的规划提示词(2026-06-03)

**起因**:用户问「先计划再执行」业界(尤其 Claude Code / Codex)怎么做、参考他们;且 §10.17 删掉
`simple` 后,规划提示词 `systemPromptPlan` 还在讲 `simple=true/false`、还写着「纯问答→直接回答即可」
——和工具脱节、且明着给模型「不出计划」的台阶下,正是 glm-5 跳过计划的一大原因。

**调研结论**:

- **Claude Code plan mode**:只读权限层(`--permission-mode plan`)下**允许研究/读**,模型研究够了用
  专门的 **ExitPlanMode** 工具呈现计划 → 用户批准 → 才退出 plan 模式去执行。研究是被鼓励的(把计划
  写准);呈现计划是一个**必须显式调用的工具**;模型若不呈现计划,会出现「无计划」的报错——**和我们
  遇到的失败模式一模一样**。
- **Codex**:`update_plan` 是**实时 todo**(透明/追踪,任意时刻一个 in_progress),审批是**逐命令**
  (shell / apply_patch)而非"整份计划一次性确认"。
- **映射**:web 的 **plan 模式 ≈ Claude Code plan mode**(只读研究 + `submit_plan`≈ExitPlanMode +
  审批门);**update_plan ≈ Codex/TodoWrite** 实时清单。**架构已经对了**,差距只是:弱模型(glm-5)不
  可靠地"呈现计划",加上提示词脱节。

**修法**(跟 Claude Code 对齐,而不是砍工具):

- 重写 `systemPromptPlan`:目标改成「**先产出计划给用户确认,而不是现在就把任务做了**」;明确「研究只
  为把计划写准、要轻」「**搜索/检索/抓取本身就是任务步骤,别在规划阶段做,写进计划等批准后再做**」「一旦
  清楚就立刻 submit_plan」;删掉 `simple` 和「纯问答直接回答」这些脱节/给台阶的内容(只保留"完全不涉及
  网页操作的纯知识问答"才直接答)。
- **不**砍只读研究工具——Claude Code 反而依赖研究把计划写准;砍了会丢「研究后再规划」的能力。配合
  §10.17 的有界 nudge + 优雅兜底兜住弱模型。

**教训**:弱模型下「plan-first」**没有硬保证**(Claude Code 也有"模型不呈现计划"的失败模式),靠的是
**只读权限层 + 一个"呈现计划"的专门工具 + 清晰提示(你的行动=计划步骤,别现在做)+ nudge 兜底**这套组合,
而不是强制 tool_choice(§10.17 已证不可移植)或砍研究工具。提示词必须和工具能力对齐——脱节的提示词会
直接把模型带偏。

---

### 10.19 / 10.20 plan 审批卡不弹 → 会话卡死 → "already running" / 继续变新会话(2026-06-03 修)

**症状**(连环):① 模型调了 `submit_plan`(时间线能看到),但**审批卡没弹出来**,会话卡在「规划中…」
不动(实为在等用户确认);② 之后想「继续」该会话,报 **`session ... is already running`**;③ 出错后
直接再发一句,**历史/上下文没了,像开了个新会话**。

**根因**:

1. **单条关键消息丢失(MV3)**:`requestPlanDecision` 只 `sendToSidepanel` **一次** `PLAN_DECISION_REQ`。
   SW→panel 的 `chrome.runtime.sendMessage` 在 MV3 下可能丢/竞态(traces 多,偶尔丢一条没人注意;但
   审批卡是**单条**——丢了就永远不弹),于是 `requestPlanDecision` 永久 await → 卡死。**§10.16 删掉
   `simple` 后审批卡路径变成必经**,把这个潜伏 bug 暴露了。
2. **卡死的会话留在 `activeSessions` 里**:`requestPlanDecision` 的 await **不理会 abort 信号**,Stop 也
   解不开;会话一直 active。`handleUserMessage` 见 active 就**硬报** `already running`(②)。
3. **出错丢绑定**:panel 在硬 error 时 `setSessionId(null)`,下一条消息 `sid = makeSessionId()` →
   **新会话**,丢上下文(③)。

**修法**(§10.20):

- **审批卡重发 + 去重**:`requestPlanDecision` 每 3s 重发 `PLAN_DECISION_REQ` 直到被回应/超时;panel 按
  `decisionId` **去重**(已在显示的不重置、已决策的忽略迟到重发)。丢一条/面板刚重载也能补上。
- **await 可被 abort**:`requestPlanDecision` 监听该会话的 abort signal,Stop/接管时 resolve 成 reject →
  引擎 `ctx.signal.aborted` → `return 'aborted'` → finally 清理 `activeSessions`。
- **接管而非报错**:`handleUserMessage` 遇到 active 会话(= panel 以为 idle 的 desync,通常就是卡死的
  run)→ abort 它、`waitForSessionIdle`(≤2s)、还不退就强制 `activeSessions.delete`,然后接管驱动。
  「继续」永远能成。
- **永不丢绑定**:panel 在**所有**结束原因(含硬 error)下都保留 `sessionId`;历史在 IDB,直接再发就
  续上同一会话(满上下文)。从历史页打开本来就会 `setTurns(historyToUiTurns(history))` 显示历史。

**教训**:① **MV3 下「单条关键 SW→panel 消息」是单点故障**——必须重发 + 去重(traces 靠量掩盖了丢包,
交互请求没有这层冗余)。② **引擎里任何长 await(审批/二次确认)都必须可被 abort**,否则会把会话永久钉
在 `activeSessions` 里、后续全部 `already running`。③ **出错别丢会话绑定**——历史是持久化的,让用户能
直接续,而不是悄悄开新会话。④ 写确认(`WRITE_CONFIRM`)是同一类长 await,目前靠 `handleUserMessage` 的
接管兜底;若以后单独 Stop 写确认,也应让它 abort-aware。

---

### 10.21 日志风暴:每条 log 都 setLogs → 全树重渲染(真实性能修复,但**不是**审批卡 bug 的真因)(2026-06-03)

> **更正(见 §10.22)**:本节当时**误判**成"这就是审批卡不显示的根因"。它是个真实的性能/footgun 修复(每条
> 日志都重渲染整棵树),也确实是我的诊断探针造成死循环的机制;但修完**卡片照样不显示**——真因是卡片渲染在
> 屏外(§10.22)。保留本节作为"一个真实性能修复 + 一次误判"的记录。

**(当时的)症状**:`submit_plan` 触发了,但审批卡始终不显示(还是只在 timeline 里看到 submit_plan)。重发
(§10.19)也没用——说明不是丢包,是**稳定**地不显示。

**定位手段**:加了一条 **panel→SW 诊断中继**(`PANEL_DIAG` 消息,SW 侧 `log()`,这样打到用户**本来就在看
的 SW 控制台**)。一次复现就把链路走通拍死了:`submit_plan intercepted` → `requesting plan decision`
→ `[panel] PLAN_DECISION_REQ recv {match:true}` → `[panel] handled (passed gate)` →
`[panel] pendingPlan state changed {has:true}` → `[panel] PlanApprovalCard render`。也就是说**消息送达、过了
session 门、setPendingPlan 改了状态、卡片组件确实在 render**——根本不是丢包/门/不渲染。而且 render 那行
**刷屏(死循环)**。

**根因**:面板对**每一条**日志(`subscribeLog` 本地流 + `LOG_ENTRY` 来自 SW 的转发)都 `setLogs(...)`,
而 `setLogs` 是顶层 state → **整棵组件树重渲染**。但 `logs` 只在「日志」页才显示。于是一次 run 里 SW 疯狂打
日志 = 面板**疯狂全树重渲染**(渲染风暴),把审批卡的 paint 冲掉了(渲染了但来不及/不稳定地上屏)。我那条
「render 时打一条 log」的诊断更是把它变成**铁的死循环**:render → log → `LOG_ENTRY` → `setLogs` →
重渲染 → render → …,反而让机制现了原形。

**修法**(§10.21):`logs` 只在日志页显示,所以**只在日志页打开时**才累积——`subscribeLog` 和 `LOG_ENTRY`
两处 `setLogs` 都 gate 在 `viewRef.current === 'logs'`;打开日志页时用 `requestLogs()` 从 SW 缓冲区拉历史。
`viewRef`(像 `sessionIdRef`)让只注册一次的监听器读到最新 view。诊断中继用完即删。

**教训**:① **高频事件(每条日志)驱动顶层 setState = 全树重渲染**,是个潜伏的性能/footgun,平时没事,
一旦有个需要稳定 paint 的重交互组件(审批卡)就被冲掉。把高频流 gate 到「它的产物真正被显示时」。
② **「render 了」≠「paint 了/显示了」**——别在 render 里看到日志就以为没问题。③ 定位 SW↔面板这类跨上下文
问题,**架一条打到你已在看的那个控制台的诊断中继**,一次复现就能把每一环拍死,别靠猜。

---

### 10.22 真因(绕了一大圈):审批卡渲染在「可滚动消息列表的屏外」(2026-06-03 修)

**真因(平凡得打脸)**:审批卡**渲染完全正常**——消息送达、过 session 门、`setPendingPlan` 改状态、组件
render、不抛错、`.plan-card` CSS 也没问题。它只是渲染在**可滚动的 `.messages` 列表里、可视区下方(fold 之
下)**:自动滚动只在「新增一条 turn」(`useEffect(…, [turns.length])`)时触发,而审批卡**不是 turn**,所以
从没被滚进可视区。它一直在 DOM 里,只是在屏幕外。

**修法**:把审批卡从 `.messages` 滚动流里拿出来,**钉成 `position: fixed`**(`.plan-pin` + 半透明
`.plan-pin-backdrop` 遮罩),始终可见、并强调"必须先确认"。卡片外保留一个 `RenderBoundary`(将来若真抛错,
显示出来而不是静默卡死)。

**为什么绕这么久 —— 调试方法的教训(比 bug 本身值钱)**:

1. **一直在查「数据通路」,bug 却在「呈现」。** 送达→门→setState→render 全程是好的,却在这条链上耗了好几轮。
   「东西没出现」类 bug,**第一个该确定的是:它在 DOM 里吗?在什么位置?在视口内吗?**——而不是"数据到了
   没"。顺序搞反 = 灾难。
2. **没定位就先发"修复"。** 重发(治"丢包")、§10.21 日志门控(治"渲染风暴")各自当成"就是它"发了出去——
   **全错**,每个换来一次"重载+复现"往返。**一个修复没让症状变化,本身就是该假设错了的铁证**,要更新得更快。
3. **探针自己制造了红鲱鱼。** render 里打的诊断 log → `LOG_ENTRY`→`setLogs`→重渲染→又打 log = 死循环,被我
   当成真 bug(§10.21)追了一程。**观察者效应**:诊断别在 render 里产生会触发重渲染的副作用。
4. **"render 了" ≠ "看得见"。** 探针证明组件在 render,据此正确排除了"丢包/门",**却**一头扎进"render 时抛
   异常",漏掉更大的一类:**渲染了但不可见**(屏外 / 被裁 / 被盖 / 没 paint)。"滚动容器里被推到屏外"恰恰
   最常见,却最后才查。
5. **远程盲调(看不到屏幕/DOM)** 把每个错误转弯放大成一次往返。应该**第一轮**就架"地面真相"探针(钉死它 /
   查 DOM 有没有 / 让用户开面板 inspector),而不是第 N 轮。

**元教训**:**「东西没显示」先确认它在 DOM 的哪、在不在视口,再去想数据为什么没到。** 另:§10.19/§10.20
(重发/可中断/接管/保留 sessionId)、§10.21(日志门控)都是真实改进、不白做,但都不是本 bug 的真因——别把
"顺手修的真实问题"误当成"症状的根因"。

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

### 10.23 plan 模式把活儿在「规划」阶段干完了 → 结果先出、计划卡后弹、批准后又做一遍(2026-06-06 修)

**症状**:用户在「先计划再执行」模式下跑刚探索出的 `deepseek__chat_export`。agent
直接调用了该工具、把完整会话抓出来并**给出了最终总结**;**之后**才弹出计划确认卡,
用户批准后又**重新执行了一遍**。(bundle s_mq21xee2:#1 调 deepseek\_\_chat_export → #3
给出完整答复 → #4 被 nudge → #5 才 submit_plan → 批准 → 再跑。)

**根因**:规划阶段(`runPlanningPhase`)把**所有非写工具**都开放给 agent 去「研究」。但
任务的交付物本身就是一个**只读**站点适配器(`deepseek__chat_export`,access:'read'),于是
「研究」=「把任务做完」。systemPromptPlan 其实已写明"不要在规划阶段抓取",但弱模型无视了
提示词——光靠提示词挡不住,把已安装的站点适配器摆在工具列表里它就会调。read≠research:
对"提取/导出"类任务,read 就是交付物。

**修法**(结构性,不靠提示词自觉):规划阶段的工具列表**只保留 `generic__*` 通用感知/导航
工具 + submit_plan**,把**所有站点/已安装适配器**(site!=='generic')连同写工具一并排除;
即便模型硬报这些工具名,planning 里的守卫也会拦下并回 "把它写进计划,批准后执行"。站点
适配器只在**执行阶段**开放。systemPromptPlan 也补一句:站点数据/动作工具在规划阶段不开放。
(对"先读 feed 再评论"类任务,代价是规划时不能预览 feed——但那本就该是 approve 后执行的
步骤,符合 plan→approve→execute 语义,且顺带消除了重复执行。)

**教训**:plan 模式的"只读研究"边界不能用 access(read/write)来划——要用**通用感知 vs 任务
交付**来划。交付物工具(站点适配器)在 approve 之前就不该能跑,否则"规划"沦为"执行 + 事后
补一张卡 + 再执行一遍"。提示词约束 + 工具能力必须对齐(§10.18 的老教训的又一例):既然不许
在规划阶段做任务,就别把任务工具放进规划工具表。

### 10.24 view_image 传远程 URL → 视觉服务商下载超时 400(qwen「Download multimodal file timed out」;2026-07-05 修)

**症状**:视觉槽位配 qwen3.7-plus(阿里云 compatible-mode),agent 调 `view_image` 看页面上的
图片时 400:`{"code":"invalid_parameter_error","message":"Download multimodal file timed out"}`。
GLM 视觉模型此前也报过同类:「图片输入格式/解析错误」(code 1210)。

**根因**:两条把图片送进视觉请求的路径都在发**远程 http URL**,让**服务商的服务器**去下载:
①`visionDescribe` 子调用(视觉槽≠主模型,本例)——注释甚至写着 "Images are sent as raw
URLs (the model fetches them)";②api-engine 回合末的多模态注入(turnImages)——注释写着
"toVisionDataUrl is ready … wire it back in here"。也就是说:**修这个问题的函数
(`fetch-image.ts` 的 `toVisionDataUrl`)早就写好、有单测,但两处调用点都没接线**,只留了
"待接"注释。国内 CDN(sinaimg/xhscdn 等)防盗链 + 服务商跨网拉取慢,下载即超时/403。
阿里云文档同时要求 base64 必须是严格 Data URL(`data:image/<fmt>;base64,<无空白 payload>`),
否则也会被当 URL 去下载。

**修法**:

- **接线**:`visionDescribe` 在发请求前把每张图经 `toVisionDataUrl` 内联为 data URL,拉不到的
  跳过并在答复末尾注明;全部拉不到则抛清晰错误(建议 screenshot 后再 view_image)。api-engine
  的 turnImages 注入点同样逐张内联,SW 拉取失败时回退原 URL(不回退会把"服务商其实拉得到"的
  少数场景也砍掉)。
- **强化 `toVisionDataUrl`**:data: 引用不再原样透传,而是**归一化**(payload 去空白、
  `image/jpg`→`image/jpeg`、generic/错误 MIME 用魔数嗅探修复,非 base64/非图返回 null);
  http 拉取加 20s 超时(叠加调用方 signal),content-type 不可信时按魔数认图
  (octet-stream 的图放行,伪装 .jpg 的 HTML 拦下)。
- 单测:fetch-image 归一化/嗅探/超时 + specialist 先取图后 POST 的断言重写。

**教训**:**"写好了但没接线"是最隐蔽的一种未完成**——函数有单测、注释说 ready,检索时一切
看起来都在,只有真机路径知道它没被调用。留 "wire it back in here" 注释不如当场接上,或至少
在 checklist 里挂一行真机验证项(本例 platform.md 里 view_image 一直没有行)。另外服务商侧
错误话术会误导排查方向:阿里云助理按"base64 格式不对"解释,但真正的第一性问题是"根本不该让
服务商去下载"——把字节自己取好递过去,防盗链、跨网、格式三类问题一次消失。

### 10.25 §10.24 的续集:脱敏占位符断链 —— 文本主模型引用不了自己截的图(2026-07-05 修)

**症状**(§10.24 修复后真机复测,bundle s_mr78212t):view_image 仍失败,但 args 暴露了真相:
`images: ["data:image/png;base64,[图片已省略]"]` —— 模型把**我们自己在工具结果里做的脱敏
占位符**拼回 data URL 原样传了回来。旧代码把这个假 URL 透传给阿里云 → 服务端当 URL 下载 →
「Download multimodal file timed out」;§10.24 的归一化正确拦下了它,但链路依然是断的。

**根因**(设计缺口,不是回归):截图的 base64 在给模型看的结果文本里被 `stripDataUrls`
换成 `[图片已省略]`(防几百 KB base64 撑爆上下文);真实字节只在 **visionInline**(多模态
主模型)时经 turnImages 自动附图。**文本主模型 + 独立视觉槽**的组合下,模型从头到尾拿不到
字节,也没有任何"引用"可用——api-engine 里的旧注释甚至写明了这个洞:"their base64 can't
round-trip through a view_image tool-call argument, so a model can't ask for them by
reference"。另外 `isViewableImageUrl` 只查 `data:image/` 前缀,占位符回声在 inline 路径也
能混过校验。

**修法**:给图片发**稳定引用**,让"按引用看图"成立:

- 新增 `image-registry.ts`:会话级 `img_N` 注册表(内存,SW 生存期,每会话 cap 24,按 ref
  去重;SW 回收后引用过期 → 明确报错而非静默错图)。
- api-engine 四处工具结果脱敏点(主循环并行/串行、规划、子 agent)全部改为:收集到的图片
  ref(data + http)注册进 registry,文本里的 base64 blob 替换成**可解析的 `[img_N]`**
  (stripDataUrls 加 labeler 参数);用户附图也注册。
- view_image 链路(handleSpecialistCall):先经 `resolveImageRef` 把 `img_N`/`[img_N]`
  解析回真实 ref 再校验;全无效时按情况给**精确指路**(列出可用 img id / 建议先
  screenshot);`isViewableImageUrl` 的 data: 分支改为真解析(normalizeImageDataUrl),
  占位符回声在 inline 路径也进不来了。
- 提示词对齐:view_image 工具描述 + specialistSystemNote 讲清 [img_N] 用法;shotNote 按
  **visionInline / subcall / 无视觉**三态分流——旧文案对 subcall 组合说"截图会自动作为图像
  呈现,无需 view_image",恰好是反的,等于教模型去踩这个坑。

**教训**:脱敏/截断这类"给模型看的内容变形",必须同时提供**逆向通道**(这里是 img_N 引用),
否则就是给模型埋"看得见、够不着"的死链——模型的自然反应就是把占位符抄回来,制造出看似
上游格式错误的"幻影 bug"(§10.24 最初的 Download timed out 有相当一部分就是它)。以及:
提示词与实际数据通路不一致(shotNote 对 subcall 说自动附图)会主动把模型引向死链。

#### 10.24/10.25 补:provider 的 base64 形状矩阵(GLM 裸 payload;2026-07-05)

qwen E2E 跑通后按 GLM 官方文档(docs.bigmodel.cn glm-4.6v-flash)对齐:**GLM 的
image_url.url 官方示例传"裸 base64"(无 `data:` 前缀)**;阿里云/OpenAI 兼容则要求完整
Data URL(裸 payload 会被当 URL 下载 → 超时 400)。此前 specialist-calls 注释里那个
"only ASCII characters" 4xx,很可能就是给 GLM 网关喂了 data: URL。修:`imageUrlForProvider`
(provider==='glm' 或 baseUrl 含 bigmodel.cn → 剥出裸 payload;其余原样),应用于
visionDescribe 子调用 + api-engine 两处 inline 注入(turnImages / 用户附图)。
http(s) 引用不受影响。教训:「OpenAI 兼容」不含多模态载荷形状——图片形状必须按 provider
建矩阵,新增视觉 provider 时先查它的官方示例再接。

**全 provider 矩阵**(2026-07-05 按各家官方文档逐一核实,不靠猜):

| provider              | base64 形状                                                     | 服务端下载 http URL?                                          | 出处 / 备注                                                                                                                   |
| --------------------- | --------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| OpenAI                | 完整 Data URL `data:image/<fmt>;base64,…`                       | ✅                                                            | platform.openai.com images-vision 指南:「fully qualified URL **or** Base64-encoded data URL」;JPEG/PNG/WEBP                   |
| 阿里云 qwen           | 完整 Data URL(严格形状,§10.24)                                  | ⚠️ 会下载但常超时(hotlink/跨网)                               | help.aliyun.com vision 文档;E2E 已真机验证                                                                                    |
| GLM(bigmodel.cn)      | **裸 base64,无 `data:` 前缀**                                   | ✅(1210 偶发)                                                 | docs.bigmodel.cn glm-4.6v 官方示例;唯一的异类                                                                                 |
| Kimi(moonshot.cn/.ai) | 完整 Data URL `data:image/{format};base64,{data}`               | ❌ **明确不支持**:「URL 格式的图片:不支持,目前仅支持 base64」 | platform.moonshot.cn use-kimi-vision-model;png/jpeg/webp/gif,body ≤100M;vision 模型:moonshot-v1-\*-vision-preview、kimi-k2.5+ |
| MiniMax               | 完整 Data URL(官方 schema:「Image URL **or Base64 data URL**」) | ✅(≤10MB)                                                     | platform.minimax.io text-chat-openai schema;**仅 MiniMax-M3 支持图片输入**(Text-01 纯文本),JPEG/PNG/GIF/WEBP                  |

代码落点:形状统一由 `imageUrlForProvider` 处理(GLM 剥前缀,其余完整 Data URL,
恰为默认分支——OpenAI/Kimi/MiniMax 零改动)。Kimi 那条「不收 URL」单独长出
`providerAcceptsHttpImageUrl`:turnImages 的"我方拉取失败→退回原始 URL"兜底只对
会自己下载的服务商是二次机会,对 Kimi 是必然 400 整个请求 → 该兜底按 provider 关闭,
改为丢弃该图并在注入文案里注明「另有 N 张无法读取」。visionDescribe 本就
inline-or-drop,不受影响。

### 10.26 `view_image("img_1")` 恢复后可能取到**错图**(img_N 计数器 SW 回收清零 + 历史 token 幸存;2026-07-05 体检修)

**症状**(体检发现,非现场报障):`img_N` 引用注册表(§10.25)承诺「丢了引用只会报『引用已过期』,绝不静默取错图」——但该承诺**只在单个 SW 生命周期内成立**。

**根因**:`registries` 是**模块级内存**(`image-registry.ts`),`registryFor` 未命中就新建 `seq:0`;而它铸出的 `[img_N]` token 被**逐字持久化**进 `session.apiMessages`。MV3 SW 回收后注册表清零,但历史里的 `[img_1]` 幸存。会话恢复后若**先**有新图入册,它重铸为 `img_1`(seq 从 0 起),于是历史里指向旧图 A 的 `[img_1]` 与新图 B 撞号——模型 `view_image("img_1")` 静默解析到 **B**(错图),无任何报错。触发链=SW 回收→恢复→≥1 新图入册→模型引用某个低号历史 token,长会话里全是常态。

**修法**(`image-registry.ts` + `api-engine.ts`):新增 `seedImageRegistry(sessionId, texts)`——扫描文本里的 `img_(\d+)` 取最大 N,把 `seq` 抬到该高水位(幂等、只升不降)。`runApiSession` 在**任何 registerImage 之前**用 `session.apiMessages` 的全部文本内容回种。这样恢复后新图从 N+1 起,历史里的旧 token 解析为 null(优雅「引用已过期」),**永不复用一个仍被历史引用的号**。单测覆盖撞号场景 + 幂等。

**教训**:①「per-SW-lifetime 内存 + 持久化的引用 token」是经典的跨回收失配——铸号器的高水位必须能从幸存的引用**回种**,否则回收后重号=静默错数据(比崩溃更坏)。② MV3 里凡「内存计数器 ↔ 持久化产物」都要问一句「SW 回收后计数器归零会不会与幸存产物撞」。见 `docs/health-audit-2026-07.md` Tier 1。

### 10.27 LLM / vision / pipeline 调用**无超时** → 卡死整会话(F-34 核心路径复发;2026-07-05 体检修)

**症状**(体检发现):F-34 的修法(`anySignal([signal, AbortSignal.timeout])`)当初只接进了 `explore/synthesize.ts` 的合成 LLM 调用 + `consumer-test.ts`,**没接进引擎自己的调用**。三处仍裸奔:① `chat-completion.ts` 的核心 `fetch` + 流式 `reader.read()` 只带用户 Stop 信号;② `specialist.ts postJsonAbsolute`(vision describe / image gen 子调用,且 vision describe 在**会话启动**就跑);③ `page.ts evalJs` 的 CDP `Runtime.evaluate awaitPromise:true` 无 deadline(合成后 pipeline 自动验证 + 运行期都走它)。任一 endpoint「连上就静默」→ 挂到用户按 Stop 或 SW 回收;后台/bridge 无人值守时=无限挂。

**根因**:超时是**逐调用**手接的,新增的调用点没跟上;且三处性质不同,不能一把梭:

- 主 LLM 调用会**长时间流式产出**(或推理模型静默思考数分钟),用「总时长上限」会误杀合法长请求 → 必须用**空闲看门狗**(每收到一个 chunk/响应头就重置),只杀真死的 socket。
- specialist 子调用是**一次性**的,用总时长上限即可。
- pipeline/func 的 `page.evaluate` 可能 `await` 一个永不 resolve 的 promise,最稳的是 **CDP 原生 `timeout` 参数**(引擎级终止,返回 exceptionDetails)。

**修法**:① `chat-completion.ts` 新增 `makeIdleGuard`——per-attempt 空闲看门狗(`LLM_IDLE_TIMEOUT_MS=180s`,`bump()` 在响应头+每个 chunk 重置;`dispose()` 移除对 session 信号的监听+定时器,长会话不累积监听),catch 里把「空闲超时 abort」与「用户 Stop」区分(前者按瞬时网络错误重试、后者立即抛),单测覆盖看门狗四态。② `specialist.ts`:`anySignal([signal, AbortSignal.timeout(180s)])`。③ `page.ts evalJs`:`Runtime.evaluate` 加 `timeout: EVAL_TIMEOUT_MS(60s)`。**要点**:空闲看门狗 vs 总时长——**流式/可能长的调用用空闲、一次性调用用总时长**,别用总时长砍流式(会误杀推理模型)。

**教训**:① 「给某类调用加超时」是**易漏的横切**——新增调用点必问「它会不会挂」;最好把「带界 fetch」收成唯一入口而非逐处手接。② 空闲看门狗必须**能重置**且**能分辨超时 abort 与用户 Stop**(否则要么误杀长请求、要么把超时当成用户停止不重试)。③ CDP `Runtime.evaluate` 有原生 `timeout`,别自己在 JS 层 race。见 `docs/health-audit-2026-07.md` Tier 1 #2/#3/#4。

### 10.28 interval 计划任务几乎从不触发:开机对账每次把闹钟推后一整个周期(2026-07-05 体检修)

**症状**(体检发现,影响**保留的**「计划任务」功能):间隔型 schedule(如「每 30 分钟」)在活跃使用时几乎不按时触发;每天型正常。

**根因**:`syncAllAlarms()` 在**每次 SW 开机**都对每个 schedule 无条件 `chrome.alarms.clear()` + `create(alarmInfo(cadence, now))`,而 interval 的 `alarmInfo` 返回 `when = now + period`。MV3 几乎每个事件都会拉起/回收 SW,于是每次开机都把 interval 闹钟的首次触发推到「此刻 + 周期」——只要开机间隔 < 周期,它就永远够不到触发点。每天型安全,因为 `nextDaily` 是**绝对墙钟**时刻,重建落在同一目标。(被删的监控当年是同一潜伏 bug。)

**修法**(`schedule-runner.ts`):闹钟**跨 SW 重启持久化**,所以开机对账改为 **create-if-absent**——`chrome.alarms.get(name)` 存在就跳过(让它继续走),只补**缺失**的、清**禁用**的。cadence 编辑仍由编辑时的显式 `syncAlarm()`(clear+create)处理,不在开机路径。加最小 chrome stub 单测:已存在的 interval 闹钟**不被重建**(next-fire 保留)、只补缺失、禁用的清掉。

**教训**:① 「开机对账/reconcile」默认要**幂等且保守**——`chrome.alarms` 本就持久,重建=把状态往后推;凡周期性 chrome.\* 资源,开机只补缺失别重置。② 「每天型正常、间隔型坏」这种一半坏,先看是不是**绝对时刻 vs 相对时刻**的差异。见 `docs/health-audit-2026-07.md` Tier 1 #5。

### 10.29 循环内未捕获 reject → 会话持久态卡在 `running`(体检修)

**症状**:某些异常(`ctx.requestPlanDecision` 在关面板/超时时 reject、或 `saveSession` 撞 IDB 配额)抛出后,会话在列表里/重载后**一直显示 `running`**,即便当时 UI 已经收到过一个「完成(错误)」提示。

**根因**:`api-engine` 主循环是 `try { … } finally { saveSession }`,**无 catch**;异常时不会走 `finish()`(它才设 `session.status` + emit `session_done`),finally 只把 messages 存回、**status 仍是 `running`**。上层 `engine-driver` 的确 catch 了并发了个瞬时 `SESSION_DONE(error)` 事件给侧栏(所以 UI 当下不卡),**但没改持久 status**;driver 的 finally 又 `saveSession(session)` 把 `running` 存死。即:瞬时事件有、持久态错。

**根因二(定位关键)**:`api-engine` 与 `engine-driver` **共享同一个 `session` 对象**(`const { session } = ctx` ← driver 的 `ctx = { session, … }`),所以修在 driver 侧即可被 driver 的 finally `saveSession` 落盘。

**修法**(`engine-driver.ts` catch,一行):抛出未 finish 时 `session.status = 'error'`,由 finally 的 `saveSession` 落盘。**故意不改 api-engine 的抛出流**——那样 driver catch 不再触发、`runError` 丢失、`notifyTaskDoneIfClosed` 收不到错误;driver 侧修既补了持久态又不动其余控制流,且不会双发 `session_done`(api-engine 没 finish、就没 emit,唯一 emit 来自 driver)。

**教训**:① 「瞬时 UI 事件」与「持久状态」是两条路,别只顾一条——terminal 事件发了不等于 terminal 状态落了。② 长 `try/finally` 无 catch 时,异常路径的**持久终态**要显式兜底。③ 修之前先确认对象是否共享(这里共享,才敢在 driver 侧改)。见 `docs/health-audit-2026-07.md` Tier 1 #6。

### 10.30 `chrome.debugger.attach` 成功但紧跟的 `*.enable` 抛出 → 泄漏附着(体检修 · Tier2-#7)

**症状/根因**:`submission-capture.ts` / `network-recorder.ts` 都是「`attach`(try,`didAttach=true`)→ 紧跟 `Fetch/Network.enable`(**try 之外**)」。若 tab 在 attach→enable 间被关/导航,enable 抛出,函数带着刚拿到的调试附着抛出、**无路 detach** → 卡「正在调试」黄条 + 挡该 tab 后续 attach。**修**:enable 套 try,失败时 `if (didAttach) detach(target).catch(()=>{})` 再 rethrow(只 detach **我们自己** attach 的,attach 失败=复用他人 session 的不动)。**教训**:「获取资源」与「配置资源」若分两步,第二步失败要回滚第一步——尤其 CDP 这种进程级、泄漏会卡 UI 的资源。见 audit Tier2-#7。

### 10.31 `executeAdapter` 万能入口无外层保护 → 抛出而非 `{ok:false}`(体检修 · Tier2-#8)

**症状/根因**:`dispatcher.executeAdapter` 是 agent/bridge/verify 三方共用的**唯一工具入口**,所有调用方都靠它返回 `{ok:false}` 的 `ToolExecResult`(记健康、surface 错误)。但它的 secrets 绑定 / redact / `withKeyLock→executeAdapterInner` 链**无外层 try/catch**;任一抛出 → **返回 rejected promise**,跳过 `recordHealthOutcome`+`withAdapterNotes`;SidePanel 路径(engine-driver 直接读 `.ok`/`.errorKind`)直接崩,健康两路漏记。`executeAdapterInner` 内部多处 catch-return,但**不可证完全**。**修**:body 套 guard,抛出经 `classifyError(t0,e)` 归一为 failed 结果;`recordHealthOutcome`+`withAdapterNotes`(本就内部 try/catch 不抛)在 guard 后**恰好记一次**。**教训**:凡「万能 choke point」契约上「绝不 reject / 总返回结果」,就必须有外层兜底;别指望每条内部路径都自己 catch 干净。见 audit Tier2-#8。

### 10.32 durable pool-tab 集非原子 RMW → 丢 id、孤儿 tab(F-35 类复发 · 体检修 · Tier2-#9)

**症状/根因**:`storage.session` 里的「池开的 tab id」持久集用非原子 read-modify-write(`loadPoolCreatedTabs()`→改→`set()`),且 `addPoolCreatedTab` 是 `void` fire-and-forget。池**并行**开 tab(≤5/站、跨站并发),两个 RMW 交错就互相覆盖(A 读[]、B 读[]、A 写[1]、B 写[2] → 1 丢);`onRemoved` 的并发 remove 更糟。丢掉的 id → SW 重启后不可回收的孤儿 tab——正是该集要防的。**修**:所有变更走**单写者 promise 链**(`mutatePoolCreatedTabs`),每次变更 await 前一次的写;`mutate` 无变化时返回同一数组引用以跳过冗余写;链内 try/catch 吞错保证链不中毒。**教训**:`storage.*` 的 RMW 在**并发写**下必须串行化(链/锁)或每项一键;这与健康存储当年的 F-35 同类——本仓库出现≥3 次,凡「读-改-写共享存储」都要先问会不会并发。见 audit Tier2-#9。

### 10.33 keepalive 端口 SW 回收后不重连 → 侧栏被误判「已关」(体检修 · Tier2-#10)

**症状/根因**:侧栏用「是否有 keepalive 端口连着」(SW 内存 `keepaliveConnections` Set)当「侧栏开着吗」的信号,但端口只在 mount 时 `connect` 一次、**无 onDisconnect/重连**。SW 空闲一阵仍会回收(idle 端口不可靠钉住 SW,见 runtime-state.ts),端口断开;新 SW 醒来 Set 是空的 → 明明侧栏还开着却判「已关」→ 发多余「任务完成」桌面通知 / bridge `await_user_action` 误拒「侧边栏没打开」阻断人工接管。**修**:侧栏端口 `onDisconnect` → 250ms 后重连(`disposed` 标志 + 清 timer,unmount 时不再重连);SW 侧 onConnect/onDisconnect 本就平衡加删,重连=恰一条。**教训**:凡用「连接/端口在不在」当「对端活着吗」的代理信号,必须能**跨 SW 回收自愈**(重连或改用真实往返 ping),否则回收后信号必假。需真机验证(SW 回收行为)。见 audit Tier2-#10。

### 10.34 bridge 入站调用回错端口 + 无超时(体检修 · Tier2-#11)

**症状/根因**:bridge `call` 处理里 `reply` 闭包捕获了**调用到达时的那个 `sock`**;若 WS 在「收到调用」与「回复」之间重连(`ws` 换了新 socket),回复发到**旧的已关 socket** 被吞 → 外部 agent 挂到自身超时。且无 per-call 超时,极端情况下 tool 卡住会一直钉 `bridgeBusyCount`。**修**:① reply 改发**当前活 socket**(`ws ?? sock`,模块级 `ws` 在 134 设、164/711 清,恒为当前);② 加 240s(< 服务端 ~320s)防御性超时,超时 reply 错误;`replied` 幂等(超时与真结果谁先谁算),busy 仍由 finally 在(已被上游 §10.27 收界的)调用真正结束时释放。**教训**:回复要发**当前**连接而非捕获时的;跨重连的请求-响应要么按 id 对活 socket 结算、要么幂等超时兜底。见 audit Tier2-#11。

### 10.35 用户附图两处:inline 未归一化 + 描述失败回退塞 image_url 给纯文本主模型(体检修 · Tier2-#12/#13)

**症状/根因**:① 用户附图走 inline(多模态主模型自看)时,`attachAsImageUrl` **直接 `imageUrlForProvider` 透传、不走 `toVisionDataUrl` 归一化、不按 provider 关 URL 兜底**——与 turnImages 路径不一致;带杂空白/泛 MIME 的 data URL 踩 Aliyun「下载超时」400,http URL 给 Kimi 直接 400 整个请求。② 配了**独立**视觉模型但 `visionDescribe` 抛错时,回退竟是 `attachAsImageUrl()`——把 image_url 塞给**只能文本**的主模型 → 整个开场 400,比降级文本更糟。**修**:① inline attach 改 `attachUserImagesInline`(async):每图 `toVisionDataUrl` 归一化 + `providerAcceptsHttpImageUrl` 门 + 拉不到就丢并在文案注明,与 turnImages 同款;② 描述失败回退改**纯文本 + notice**,绝不发 image_url。**教训**:图片形状归一化+provider 门是**一处约定**,凡要 inline 图片的路径都得走同一套(别让 user-image 路径漏掉);「有独立视觉模型」= 主模型看不了图,任何回退都不能给它 image_url。见 audit Tier2-#12/#13。

### 10.36 provider 不回 `usage` → 压缩+溢出守卫静默失效 → 上下文 400(体检修 · Tier2-#14)

**症状/根因**:`lastPromptTokens = resp.usage?.prompt_tokens ?? lastPromptTokens`——provider 不返回 `usage` 时 `lastPromptTokens` 恒为 0,`shouldCompact(0)` false、`budgetVerdict` 的 token 分支永不触发,只剩 `maxSteps=40` 兜底;单个工具结果上限 64KB × 数十步可撑爆窗口 → 硬 400,且从不压缩。streaming 已请求 `stream_options.include_usage`,但不合规网关照样不回。**修**:新增纯函数 `estimatePromptTokens(messages)`——文本 ~4 chars/token + tool_call args,每张 inline 图给固定名义值(不数 base64 长度,provider 按块计费);`usage` 缺失时用它兜底。单测覆盖文本/图片(不数 base64)/tool_calls/空。**教训**:凡依赖「provider 反馈的计量」驱动关键控制(压缩/预算),都要有**不依赖反馈的兜底估算**——OpenAI 兼容≠一定回 usage。见 audit Tier2-#14。

### 10.37 交互重设计:计划/探索成果回归消息流,agent 产出统一「特殊步骤」语义(2026-07-06)

**现状(改前)**:plan 清单永远渲染在消息列表**最底部**(所有 turn 之后),任务完成后仍垫底不走;探索成果卡同样永久垫底。计划卡 bg 是 `--surface-hover`,与 final answer 气泡(`--bubble-assistant`)不一致。

**目标(参考 Claude Code)**:agent 的产出都**回归 steps 时间线**;plan / final answer / 探索成果是"特殊步骤",用统一的 assistant 气泡 bg 从扁平 timeline 行里凸显:

- **计划**:还有 pending/in_progress 步骤时(`!planSettled`,含中止未完的会话)→ 仍钉底,方便盯进度;**全部到终态**(completed/skipped/failed,复用 `isTerminal`)→ 取消钉底,回到消息流"原位"——**最后一次 `update_plan`/`submit_plan` 的 tool turn** 处渲染成完整 `PlanChecklist` 卡(替换那行 trace 行)。锚点天然存在:engine 本来就把每次 update_plan 落成 tool_trace turn(含 PlanState 快照),刷新/继续会话/历史回放全都成立。settled 但找不到锚点(如 explore 种子计划从未 update)→ 回退钉底,不丢卡。
- **探索成果**:锚定在**最后一次 `synthesize_adapter` tool turn 之后**(不替换该行——行保留操作记录,卡是累积成果);导入/修复流等无合成 turn 的场景回退到底部(原行为)。
- **bg 统一**:`PlanChecklist` 容器改 `class="msg assistant plan-checklist"`(与探索卡 `msg assistant explore-card` 同款),三者共享 `--bubble-assistant`。
- **历史详情视图**(`SessionDetailView`)同款收编:plan 卡渲染在锚点处(无钉底——它是记录不是 run),兑现了 plan.ts 里"shows in the history view"的旧注释。

**顺手修的真 bug(直接影响本交互)**:history 里每个工具调用存了 **started + completed 两条** tool_trace turn(engine 两次 `appendTurn`),live 时 `onToolTrace` 按 `trace.id` 原地替换所以只见一行,但 reload/历史详情走 `historyToUiTurns` 1:1 映射 → 每个工具显示两行、其中一行永远转 spinner,还会紧贴 plan 卡出一行幽灵"更新计划"。修:`historyToUiTurns` 按 `trace.id` 去重——**位置取首次出现、内容取最后快照**,对齐 live 语义。

**实现要点**:锚点计算是纯派生(`lastToolTurnIndex(turns, PLAN_ANCHOR_TOOLS)`,ES2022 无 findLastIndex 手写倒序循环),不新增持久化状态;同一会话开新任务时旧 plan 卡会随 plan 被 update_plan 覆盖而重新进入钉底生命周期(plan 是单一活体工件,卡跟着它最新状态走,与 Claude Code TodoWrite 一致)。

**教训**:「执行中钉底、完成后归位」这类生命周期 UI,先找**已持久化的天然锚点**(这里是 update_plan 的 trace turn)再考虑加状态——锚点派生自 history 意味着刷新/恢复/历史视图零额外工作。以及:凡 live 渲染对事件流做了合并(按 id 替换),history 重放路径必须做**同构**的合并,否则两条路渲染结果漂移(started 幽灵行在这儿潜伏了很久才被这次改动逼出来)。

**跟进(同日,真机反馈第二轮)**:① in_progress 步骤的"▸"静态三角 → 真转圈 spinner(`.plan-step-spin`,复用 `.tl-spin` 外观);② 两卡右上角"收起 ▾/展开 ▸"文字 → steps 同款 `tl-chev` chevron;③ 卡片下方补时间线连接:`.plan-checklist + .tl-row::before { top:-9px }`(下一行的连接线向上跨过 flex gap 接到卡底,规则须放在「组首 top:11px」规则**之后**——同特异性靠源序生效);④ 去掉探索卡"清空卡片"(healTarget 每次 run 开始时本就重置,无泄漏);⑤ **真 bug**:`installed` 是 panel-only 标志、session 持久化不带 → 重开会话已安装的 adapter 又显示「安装」。修:恢复会话后 `reconcileInstalledFlags()` 从 installed store(`LIST_INSTALLED`,id=`site/name`)重推导——**从真源派生而非补持久化**,卸载后按钮回来也自然正确。教训:面板内瞬时 UI 标志若参与"该不该再给这个操作"的判断,恢复路径必须从权威存储重推导,不能指望它随会话活下来。(2026-07-11:「安装」按钮随「合成通过自动入库」退场,`reconcileInstalledFlags` 一并删除——`installed` 现由 SW 入库时随事件/会话持久化如实带出,见 adapter-hot-plug §10.46。)

**跟进 ⑤ 的第二锤(同日)**:上面的 reconcile 首版仍不亮「已安装」——explore 来源的安装在 `installFromCaptured` 里被移进 **`my-` 站点命名空间**(`toExploredSite`,防与市场同站冲突,docs/architecture.md §15),installed id 实为 `my-<site>/<name>`,拿 `<site>/<name>` 匹配永远 miss。修:两种 id 都试(manual/heal 安装保留原 site,explore 安装带 `my-`)。教训:凡按 id 对账,先查**写入端有没有 id 改写**(命名空间/前缀),别只看读端约定。

## §11 超长结果与输出上限:截断的三层处理(2026-07-07,用户反馈)

用户看到最终答复里混着 `…[truncated 2188]`,提出三问:截断要让用户知情;能否分治拿全量;
max_tokens 能否用户配置。盘点发现存在**两种互不相干的截断**,原先都**静默**:

1. **工具结果截断**:`engine-history.truncate`(`MAX_TOOL_RESULT_CHARS=64k`)砍尾巴,
   截掉的部分**永久丢失**——模型想要也拿不回,用户不知情。
2. **LLM 输出截断**:主循环写死 `max_tokens:4096`,超长回答被 provider 掐断
   (`finish_reason:'length'`),同样无提示、不可配。

三层修法:

- **溢出缓存 + read_more(分治)**:`runtime/oversize-cache.ts`(SW 内存,24 条 / 15min
  TTL / LRU,读命中续期);`engine-history.truncateStash` 截断时把**全文**入缓存,标记改为
  `…[已截断 N 字符…用 read_more {"id":"ov_x","offset":64000} 分段续读…]`;新 generic 工具
  `read_more(id, offset, max_chars≤60k)` 返回 `{chunk, next_offset?, remaining, done}`——
  模型循环 next_offset 即可读完(配合子 agent 逐段提炼)。api-engine 四个喂结果点
  (主循环 / 规划 ackTool / 子 agent / explore 循环)全部换用;子 agent 工具表来自
  registry 全量 read 工具,天然带 read_more。缓存是**任务内续读缓冲**而非存储:SW 重启
  即失,read_more 明确回「过期请重跑原工具」。
- **用户知情**:主循环 / explore 循环实际发生截断时 `ctx.emit notice`(「结果超长已截断
  N 字符,模型可用 read_more 续读」);`finish_reason==='length'` 时 warning notice
  (「输出达到 max_tokens 上限,内容可能不完整——LLM 配置里可调大」)。标记文本同时要求
  模型:最终答复依赖被截数据时向用户说明。
- **max_tokens 按 profile 可配**:`LlmConfig.maxTokens?`(可选,缺省 4096),LLM 配置的
  profile 编辑表单加「输出上限」数字框;主循环 / 规划 / 子 agent 三处 `cfg.maxTokens ?? 4096`。
  压缩(1024)/specialist(1500)是内部摘要,**有意不放开**。工具结果的 64k 上限也**有意
  不做成设置**——调大它治标(prompt 成本爆炸),read_more 分治才是治本。

单测:tests/oversize-cache.test.ts(分页 next_offset 到 done / 过期与未知 id / LRU 驱逐 /
truncateStash 标记可被 read_back 全链路)。

### 10.38 run-tab janitor:任务结束「清 tab」从提示词改成系统行为(2026-07-10)

**症状**(用户长期反馈,屡修不绝):任务结束后 agent 经常忘了关自己开的标签页,agent 窗口里
tab 越积越多。§10.37(adapter-hot-plug)已让**站点池** tab 自愈收割,但 `generic__open_url` 开的
tab 一直是「模型记得就 close_tab、忘了就漏」——描述里甚至写着「打开后标签页保留,不自动关闭」。

**根因**:又一个「要模型记住的规则」。收尾动作在长任务的末端,注意力最稀的地方,遗忘是常态;
且「关 tab」对模型没有任何任务收益,纯靠自觉。

**修法**(`src/background/run-tabs.ts`,与 §10.37 的 durable pool-tab 集同构):

- **记录**:dispatcher 在 `generic__open_url` 成功后,把**后台**新 tab 按 origin(sessionId)记进
  `storage.session`(`web:runOpenedTabs`,单写链防并发 RMW 丢 id)。**不记**:`active:true` 打开的
  (那是特意展示给用户的页面)、explore 专用 tab(explore-driver 自管)、`origin==='bridge'/undefined`
  (外部 agent / verify 自管生命周期)。
- **收割**:`driveApiSession` 的 finally 里,按本次 run 的 finish reason 决定——`checkpoint`(可续跑)
  **保留** tab 只刷新记录时钟(`touchRunTabs`;发「继续」还要用);其余(正常完成/错误/中止)
  `reapRunTabs(session.id)`:还开着且**非 active** 的关掉;**active 的赦免并遗忘**(用户接管过/正在看
  的页,从此归用户)。finish reason 从 `session_done` 事件顺手截获,零 schema 改动。
- **兜底 sweep**:SW 重启把 finally 吞了 → 记录还在 storage.session;所有会话空闲时
  `sweepStaleRunTabs` 收走**超过 6h 宽限**的记录(checkpoint 停车的会话在宽限内不受影响)。
- **提示词随之反转**:open_url/close_tab 描述 + system prompt 改为「结束自动回收,**要留给用户看的
  用 active:true**;长任务中途不用的页才随手 close_tab」——模型只需标注「要保留什么」(这是它本来
  就会做的动作),而不是记住「要清理什么」。

**教训**:①收尾类规则(清理/汇报/复位)最不该交给模型——它们在注意力末端、无任务收益,系统在
run 生命周期钩子里做一遍就是了;②「自动清理」的安全边界要显式列举(active=用户的、explore=别人的、
bridge=外部的),宁可少关不错关;③每种「结束」语义(正常/错误/中止/checkpoint/SW 死亡)各配对应的
清理策略,checkpoint ≠ 结束。单测:tests/run-tabs.test.ts。真机验证待做。

**§10.38 补丁(2026-07-10,会话 s_mregtz8u「为什么完成后不清理你打开的 tabs」)**:v1 的两条规则在真实
使用里都错了。①「active:true 打开的**永不回收**」——「打开看看」类任务 agent 必然 active 打开,这类
展示页于是永远漏网,用户看完就成了垃圾 tab;②「reap 时 tab.active 即赦免」——agent 窗口是后台窗口,
**最后激活的 tab 会一直 .active**,导致展示页/接管页在 v1 下被永久豁免(正是用户撞到的泄漏)。修:
展示页(userFacing)获得**完整生命周期**——记录进 `shown`,**熬过自己这轮**的 run-end reap(用户正在读),
下一轮 run **开始**时 `rotateShownTabs` 转入 `prevShown`(用户回来发新指令=看完了),那一轮结束时回收;
赦免规则从「tab.active」收紧为「**正在被看**=active 且所在窗口是 focused 窗口」(getLastFocused),被看的
展示页保留记录、下次再收,被看的后台工作 tab 则赦免并遗忘(归用户)。stale sweep 对过期 origin 连 shown
一起收。提示词同步反转:「active 展示页保留到下一个任务开始(正在看则继续保留),之后也自动回收」。
**教训**:①「永不回收」的豁免类目迟早变成泄漏类目——豁免应该是**推迟一拍**(到用户明确翻篇的信号,
这里=下一条指令),不是免死金牌;②`tab.active` 在多窗口下不等于「用户在看」,判「在看」必须联合
focused window;③清理策略的每个"例外"都要有它自己的回收路径,否则例外=泄漏。单测 tests/run-tabs.test.ts
全链路(rotate/viewed-guard/agent-window leak 回归)。

## §10.39 回答引用来源:行内上标 + 末尾来源列表 + grounded 兜底(2026-07-17,用户反馈)

**症状**:agent 引用了外链却经常**根本不给出处**;想要「引用了外链就给出可点击的引用」——正文
行内上标 `[1][2]` + 末尾「来源」列表都要。

**根因**:①系统提示词里**从来没有**引用规则,模型没有理由去写来源;②行内 `[n]` 只能模型自己放
(只有它知道哪句对应哪个源),纯渲染层给不出;③但只靠提示词,模型仍会漏写——用户的原始抱怨正是
「不给出处」。

**修法(三处配合,不动 schema)**:
- **提示词**(`api-system-prompt.ts` §关于引用来源,`PROMPT_VERSION` → `2026-07-17.1`):参考外链就
  ①句后标纯文本 `[n]`,②末尾单起一行 `来源:` 按序号列 markdown 链接,序号一一对应;URL 必须真开过、
  禁编造/占位。
- **grounded 兜底**(`src/agent/citations.ts` + `api-engine.ts`):run 全程把 agent **真正抓取/导航过**的
  外链累积进 `runSources`(只收 `fetch_url` 最终 URL + `open_url`;**web_search 命中是候选、不收**,否则
  一次搜索灌进 10 条噪声)。最终答复(无 tool_calls 那轮)`appendSourcesFooter`:模型**已给来源**(有
  `来源` 标题、或正文已含某收集到的 URL)就原样不动;**一条没给**才补一个 markdown `来源:` 列表(封顶
  12 条、按规范化 URL 去重)。只增强**展示/持久化**的 turn(appendTurn + emit),**LLM 历史 `messages`
  保留模型原文**——兜底纯属展示层,不污染模型自视。
- **渲染**(`Markdown.tsx` 新增 `cite` 属性,仅 assistant 回复用):按 `来源` 标题把正文/来源块切开,
  只在正文里把 `[n]`(排除 `[n](…)` 链接语法)替换成可点上标 `<sup class="cite"><a>`,来源块靠 marked
  天然渲染成可点链接、再包一层 `.md-sources` 做页脚样式。全部沿用现有 DOMPurify「所有 `<a>` 加
  `target=_blank rel=noopener`」钩子——点了开新标签。无 `来源` 块时 `cite` 是 no-op,不影响其它 Markdown
  调用点(笔记/reason)。

**取舍(用户拍板)**:兜底只收「真抓过的页」(fetch_url/open_url),不收 web_search 候选;行内上标必须
模型自放,兜底那条路只有末尾列表、没有上标(可接受)。

**教训**:①「让模型自觉」的输出规范,提示词是主力、但对「必须出现」的东西要配**系统层兜底**——这里
grounded 列表保证「至少有出处」,提示词负责「更好的行内对应」;②兜底触发条件要收紧成「模型**完全**
没给」(有标题 or 已含 URL 即让路),否则会和模型自己的引用打架/重复;③来源用**文本嵌进回答**(而非
新 schema 字段)最省——行内上标和末尾列表指向同一批 URL,持久化/重载/复制全天然跟随。单测
`tests/citations.test.ts`(收集去重、兜底触发/让路/封顶 8 例);真机待验。
