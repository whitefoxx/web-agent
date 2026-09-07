# 代码体检 — 2026-07-05

全仓库健康审计。方法:先跑基线门禁 + 气味统计,再按子系统 fan-out 6 个只读子代理
(vision / agent-engine / generic-tools+dispatcher / background-MV3 / explore-synthesize-adapters /
sidepanel-UI),各返回带 `file:line` 的高信号问题清单;最后对**最严重的几条亲自读码对抗性复核**。

## 基线(健康)

`tsc` ✅ · `eslint` ✅ · `vitest` **1725 pass** · `build` ✅。
气味:`@ts-ignore`/`eslint-disable`/`TODO`/`@ts-nocheck` **全 0**,`console.log` 仅 2,
`any`/`as any` 25,非空断言 15。**纪律很好** —— 问题几乎全在**逻辑/健壮性/泄漏/MV3 生命周期**,不在卫生。
热点体量:`App.tsx` **6965 行**(巨石),`api-engine.ts` 1990。prettier 欠债 19 文件(已知,历史 UI-sweep)。

## 反复出现的 bug 类(最有价值的结论)

1. **超时/挂死类(F-34 复发)** —— F-34 的修法(`anySignal([signal, AbortSignal.timeout])`)只接进了
   `explore/synthesize.ts` 的 LLM 调用 + `consumer-test.ts`,**没接进引擎自己的 LLM 调用、vision 子调用、
   合成后 pipeline 自动验证**。一个连上就卡住的 endpoint 会把整个会话挂到用户按 Stop 或 SW 回收。**这是头号类**。
2. **MV3「内存态误当持久」类** —— 需跨 SW 回收存活、却只存在模块级内存的状态:img_N 注册表、
   `keepaliveConnections`、`confirm-prompts` 待决门、pool-tab 持久集(RMW 竞态)、`steerQueue`;
   以及**反向**:schedule 开机对账每次把 interval 闹钟推后 → 长周期几乎不触发。
3. **非原子 RMW / 丢更新类(F-35 复发)** —— 健康存储当年修过(单事务 + 保留 notes),但同一形态在
   pool-tab 持久集、`installed-store` 的 enable/verify 两 setter 里复现。
4. **provider 形状 / vision 边界** —— 分离 vision slot 失败时回退把 `image_url` 塞给纯文本主模型(400);
   用户附图路径没走 `toVisionDataUrl` 归一化 + provider 门(Aliyun 超时 / Kimi 400);provider 检测靠 host/enum 嗅探易误判。
5. **沙箱/注入硬化** —— opencli pipeline 表达式沙箱的 `BLOCKED_KEYS` 只挡成员访问键,反射方法把敏感名当**字符串实参**绕过;
   `eval_js` 的写门被 `click`/`type_into` 的表单提交绕过(action 工具在 explore 外、无写确认)。

---

## Tier 1 — 正确性/可靠性,建议尽快修(均已亲自复核 = 真)

- **[高·已核实] img_N 解析到错图(静默)** — `src/agent/image-registry.ts:30/35/47`(+`api-engine.ts:184/1869`)。
  `registries` 是模块内存,`registryFor` 缺失即 `seq:0`;**无从历史回种**。SW 回收+恢复后,新图重铸 `img_1`,
  与 `apiMessages` 里仍在的旧 `[img_1]` 撞号 → `view_image("img_1")` 静默返回**另一张图**,违反本文件 line16
  「never a silently wrong image」承诺。**修**:会话启动时扫 `apiMessages` 里最大 `img_N` 给 `seq` 打高水位
  (旧 token 之后解析为 null=优雅过期),或持久化注册表按会话回种,或 token 带 boot epoch。
- **[高·已核实] 核心 LLM 调用无超时** — `src/agent/chat-completion.ts:117/130/160`。`fetch` 与流式 `reader.read()`
  只带 `opts.signal`(用户 Stop),无 timeout;连上就卡的 endpoint 挂死整会话。**修**:`anySignal([signal, AbortSignal.timeout(N)])`
  + 给流加逐块看门狗。
- **[高·已核实] vision 子调用无超时** — `src/agent/specialist.ts`(`postJsonAbsolute`)。同挂死类,且**会话启动**就为用户附图跑 `visionDescribe`。**修**:同上 bound。
- **[高·已核实] 合成后 pipeline 自动验证无界** — `src/background/explore-driver.ts:269`(+分页 :333)→`src/runtime/page.ts:295`。
  `verifyExploreAdapter` 跑新合成 adapter,pipeline 到 `page.evaluate`(CDP `Runtime.evaluate awaitPromise:true` 无 deadline)。
  func 路径有 60s、合成 LLM 有 180s,**唯独 pipeline 验证没界** → F-34 深一层复发。**修**:给 verify 的 executeAdapter 套 timeout + 给 evalJs 加 deadline。
- **[高·已核实] interval 计划任务漂移/几乎不触发** — `src/background/schedule-runner.ts:76-89`。`syncAllAlarms` 每次 SW 开机
  无条件 `clear`+`create(when=now+period)`;MV3 频繁开机 → interval 首触发被不断推后(daily 靠 `nextDaily` 绝对时刻,安全)。
  **影响保留的计划任务功能**(被删的监控当年也有同一潜伏 bug)。**修**:create-if-absent(先 `alarms.get`),或 `when` 锚到 `lastRun+period`。
- **[中·子代理报] 循环内未捕获 reject 跳过 `finish()`** — `src/agent/api-engine.ts:783`(try)/`1981`(finally 无 catch)。
  `ctx.requestPlanDecision`(:565/:1198,文档说超时/关面板会 reject)或任一 `saveSession()`(IDB 配额)reject 逃逸 →
  不发 `session_done`、`status` 卡 `running`、UI 卡死。**修**:循环外 `catch → finish('error')`。

## Tier 2 — 健壮性 / 资源 / 契约

- **[高·子代理报] debugger.attach 泄漏** — `src/runtime/submission-capture.ts:192`、`src/runtime/network-recorder.ts:74`。
  `attach` 成功后紧跟的 `Fetch/Network.enable` 在 try 之外;抛错则刚拿的调试附着无从 detach → 卡「正在调试」横幅 + 挡后续 attach。**修**:enable 套 try,失败 `if(didAttach) detach` 再 rethrow。
- **[中·已核实] dispatcher.executeAdapter 无外层保护** — `src/tools/dispatcher.ts:145-183`。secrets/redact/substitute/withKeyLock/inner 均无 try/catch 包裹;
  任一抛出跳过 `recordHealthOutcome`+`withAdapterNotes` 并**返回 rejected promise**(违反所有调用方依赖的 `{ok:false}` 契约;SidePanel 路径直接崩,健康两路都漏记)。`executeAdapterInner` 多处 catch-return 但**不可证完全**。**修**:body 套 try/catch 汇到 `failed()`+记健康。
- **[中高·子代理报] pool-tab 持久集非原子 RMW** — `src/tools/dispatcher.ts:590-606`。`chrome.storage.session` 读-改-写 + `addPoolCreatedTab` fire-and-forget;
  池本就并行开 tab(≤5/站)→ RMW 互相覆盖丢 id → SW 重启后成不可回收孤儿 tab(正是该集要保证的反面)。**修**:单写者串行化,或每 id 一键。
- **[中·子代理报] keepaliveConnections 回收后失真** — `src/background/runtime-state.ts:36`(消费 `notifications.ts:49`、`bridge-client.ts:234`;面板端口 `App.tsx:736`)。
  用内存 Set 当「面板开着吗」;面板端口只在 mount 建一次、无重连 → SW 回收唤醒后新 SW 的 Set 空 → 面板明明开着却发多余「任务完成」通知 / bridge `await_user_action` 误拒「侧边栏没打开」阻断人工接管。**修**:面板 `onDisconnect` 重连,或用真实往返 ping 判活。
- **[中·子代理报] bridge 入站调用无超时 + 换 socket 后回错端口** — `src/background/bridge-client.ts:581-643`。无 per-call 超时;卡住的 `ctrl.run`/`executeAdapter` 让 `bridgeBusyCount>0` 无限钉住 SW;WS 中途重连则 `reply` 发到旧 closed socket 被吞 → 外部 agent 挂到自身超时。**修**:每调用超时回错 + 跟踪在途 id、重连时对活 socket 结算。
- **[中·子代理报] vision 失败回退把 image_url 塞纯文本主模型** — `src/agent/api-engine.ts:236-239`。分离 vision slot 时 `visionDescribe` 抛错 → `attachAsImageUrl()` 把 image_url 块发给**只能文本**的主模型 → 整个开场请求 400。**修**:回退成文本提示,不发 image_url。
- **[中·子代理报] attachAsImageUrl 跳过归一化+门控** — `src/agent/api-engine.ts:205-212`。用户附图不走 `toVisionDataUrl`、不做 `providerAcceptsHttpImageUrl` 门(与 turnImages :1931-1942 不一致)→ Aliyun「下载超时」400 / Kimi 收不了裸 URL 400。**修**:同 turnImages 归一化+丢不可取图。
- **[中·子代理报] 预算/压缩仅靠 usage.prompt_tokens** — `budget.ts:39/45`、`api-engine.ts:331`。provider 不回 usage → `shouldCompact` 与 token 检查点静默失效,仅 `maxSteps=40` 兜;单结果上限 64KB × 40 步可撑爆窗口 → 硬 400 且从不压缩。**修**:无 usage 时用字符估算兜底。

## Tier 3 — 安全硬化

- **[中·已核实] opencli pipeline 沙箱可绕(原型污染)** — `src/runtime/opencli/pipeline.ts:385-400`。`SAFE_GLOBALS` 暴露完整 `Object`,`BLOCKED_KEYS` 只挡**成员访问键**;
  `Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Object.keys),'constructor').value` 把敏感名当**字符串实参**取到真 `Function`(CSP 挡了 eval→无 RCE),但 `Object.defineProperty(Object.getPrototypeOf([]),…)` 是纯调用 → **SW 全域原型污染**。威胁面=装了恶意 adapter 的 `${{ }}` 表达式。**修**:别暴露裸 `Object`,给 keys/values/entries/assign/freeze 的白名单壳。
- **[中·子代理报] toVisionDataUrl 先全量缓冲再查大小** — `src/agent/fetch-image.ts:147`。`arrayBuffer()` 读完才比 6MB;超大/恶意响应先撑爆 SW 内存。**修**:先看 `content-length` 超限即 bail,或流式截断。
- **[低·子代理报] eval_js 写门被 action 工具绕过** — `click.ts:184`(`.click()` 可提交表单)、`type-into.ts:220-255`(`submit:true`→Enter/`requestSubmit`)均 `access:'read'`、在 explore 外、无写确认门。**修**:文档标注,或对可提交的 action 调用在非 capture_submission 探索时加写确认。
- **[低·子代理报] sha256=一致性非真实性** — `src/sidepanel/marketplace.ts`。index.json 与 adapter body 同源取,哈希只防 index/body 偏斜,不防恶意 ORIGIN;`reconcileStaleAdapters` 面板打开时静默重装上游改过的 adapter(无 per-update 用户门)。`remoteMarketUrl` 无 in-`src` 写入口(dev/fork-only),故无产品内写向量。**修(若要真实性)**:离线签名 index / pin 发布方。

## Tier 4 — 更低优先(正确性小瑕 / 健壮性)

- get-interactives iframe 合并后**无全局上限** → token 爆(`get-interactives.ts:148`);paintOverlay 贴的是**本地 ref** 非命名空间 ref(截图上的号 ≠ 要传 click 的号,`:317`)。
- scroll-page 容器滚动**没 parseFrameRef** → iframe 内层 scrollable 滚不动(`scroll-page.ts:59`,与 click/type 不一致)。
- session.history 无上限 + `saveSession` 每次 push 全量重序列化 → O(n²) 写放大 + IDB 行膨胀(`session.ts:107-115`);配额撑爆会级联到上面的 finish-skip。
- confirm-prompts 待决门(写确认/接管/plan)仅内存 → SW 硬回收全丢,boot 只能把会话置 error 手动重试(`confirm-prompts.ts`)。
- installed-store enable/verify 两 setter 两事务 RMW(F-35 类,`installed-store.ts:203-226`)。
- vision:注册表 FIFO 非 LRU(热引用被早逐,`image-registry.ts:44`);inline 上限 6 vs 8 不一致(`api-engine.ts:1858/1860`);visionInline 同轮既发 `[img_N]` 又发裸字节(冗余);engine-history flatten 占位符对多模态主模型写死假的「不支持视觉」(`engine-history.ts:99`)。
- `finish_reason!=='tool_calls'` 但有 tool_calls 时提前结束、模型没消费本轮结果(`api-engine.ts:1974`)。
- screenshot 拼接 OOM 回退 16000 > CHUNK 12000 可再失败(`screenshot.ts:200`)。
- agent-window 的 onRemoved 系监听器惰性注册非顶层(`agent-window.ts:56`、`controlled-tabs.ts:33`)—— MV3 唤醒可能漏派发(已被 storage.session 恢复重度缓解)。
- ≥2 个后台/bridge 会话同时待接管时,全局接管卡任取其一、无会话标签/队列提示(`App.tsx:1814`)。
- steerQueue 未持久化(`engine-driver.ts:60`,回收即丢,影响小)。

## 子代理复核为「干净」(记录以便下次跳过)

- **占位符回声成历史**:处理正确 —— 四处 `stripDataUrls` 都传注册表 token;`normalizeImageDataUrl` 拒收 `[图片已省略]` 回声;`view_image` 全废输入给精确恢复提示。
- **两 tool-loop 分歧(F-34 邻域)**:当前**同步**,但靠 tool-list 排除而非对称 handler —— planning loop 只提供 generic-reads+submit_plan+view_image(都处理);`update_plan`/`spawn_subagent`/`remember`/`notes`/`synthesize_adapter`/`create_*`/`run_workflow` 仅主 loop 有 handler,planning 安全**仅因**其 tool-list 不列它们(误调 → `lookupAdapter` 对无 `__` 名返 null → 优雅 not-found)。**往 planning tool-list 加这些而不加 handler 会重引 bug**。`await_user_action` 两 loop 共享 `parseAwaitUserAction`,对称安全。
- **tool_choice**:四处全 `'auto'`,无 forced/required/object → 避开 GLM-5 400 崩溃类。
- **orphan backfill**:`sanitizeHistory` 是 F-34 修法,正确(未答 tool_call 补「已中断、工具仍在、可重试」而非旧的模糊「[已中断,无结果]」)。
- **SHA256 强制**:每条执行 marketplace 源的路径都在**同一份**将被 eval+持久化的源上先验哈希(无 TOCTOU);`fetchAdapterSource` 不匹配硬抛、各调用方传播,从不回退到字节。手贴/探索合成为本地源(设计上无哈希)。
- **adapter-health-store**:`applyOutcome` 保留 `notes: prev?.notes`(F-35 修法在),两写者各单事务 RMW,无丢更新。
- **explore recorder owner/origin 隔离**、**consumer-test**(60s+fail-open)、**def-capture MAIN-world eval**(opaque-origin sandbox iframe,无 chrome.*,10s bound)、**region-capture 裁剪数学**、**page.ts CDP 清理**、**WS 重连退避**、**session-gate**(交互 prompt 在门之前 return,老 bridge-takeover-drop 不复发):均干净。

## 修复状态

用户决定:**Tier 1→2→3→4 逐条修、一条一 commit**,严禁引入新 bug(2026-07-05 起)。
进度随修随记(每条修完在此勾掉 + 附 commit/post-mortem)。

### 已修
- ✅ **Tier1-#1 img_N 撞号取错图** — `seedImageRegistry` 高水位回种(`image-registry.ts` + `api-engine.ts`),单测覆盖撞号+幂等。post-mortem: agent-harness.md §10.26。
- ✅ **Tier1-#2/#3/#4 超时类(F-34 核心路径)** — chat-completion 空闲看门狗 `makeIdleGuard`(180s,流式安全)+ specialist `anySignal+timeout`(180s)+ page.ts evalJs CDP `timeout`(60s)。单测覆盖看门狗四态。post-mortem: agent-harness.md §10.27。
- ✅ **Tier1-#5 interval 计划任务几乎不触发** — `syncAllAlarms` 开机对账改 create-if-absent(不重置已存在闹钟)。最小 chrome-stub 单测。post-mortem: agent-harness.md §10.28。
- ✅ **Tier1-#6 未捕获 reject 会话卡 running** — driver catch 里 `session.status='error'`(共享 session 对象,finally 落盘);不动 api-engine 抛出流、不双发。post-mortem: agent-harness.md §10.29。

**✅ Tier 1 全部完成(6/6)。**

- ✅ **Tier2-#7 debugger.attach 泄漏** — `submission-capture`/`network-recorder` 的 `*.enable` 套 try,失败时 detach 自己的附着再 rethrow。post-mortem: agent-harness.md §10.30。
- ✅ **Tier2-#8 executeAdapter 无外层保护** — body 套 guard,抛出经 `classifyError` 归一为 failed 结果 + 恰记一次健康。post-mortem: agent-harness.md §10.31。
- ✅ **Tier2-#9 pool-tab 集非原子 RMW** — 单写者 promise 链串行化所有变更(F-35 类复发)。post-mortem: agent-harness.md §10.32。
- ✅ **Tier2-#10 keepalive 端口不重连** — 侧栏 onDisconnect→重连,跨 SW 回收自愈(真机待验)。post-mortem: agent-harness.md §10.33。
- ✅ **Tier2-#11 bridge 调用回错端口+无超时** — reply 发当前活 socket(`ws??sock`)+ 240s 幂等超时。post-mortem: agent-harness.md §10.34。
- ✅ **Tier2-#12/#13 用户附图 attach** — inline 走 `toVisionDataUrl` 归一化+provider 门(同 turnImages);描述失败回退纯文本+notice(不塞 image_url 给纯文本主模型)。post-mortem: agent-harness.md §10.35。
- ✅ **Tier2-#14 无 usage 时预算失效** — `estimatePromptTokens(messages)` 兜底(文本~4chars/tok + 图片名义值),`usage` 缺失时用它;单测。post-mortem: agent-harness.md §10.36。

**✅ Tier 2 全部完成(8/8)。**

- ✅ **Tier3-#15 opencli pipeline 沙箱逃逸(原型污染)** — `SAFE_GLOBALS` 暴露完整 `Object`,`BLOCKED_KEYS` 只挡**成员访问键**;`Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Object.keys),'constructor').value` 把敏感名当**字符串实参**取到真 `Function`(CSP 挡 eval,但 `Object.defineProperty(原型,…)` 是纯原型污染)。**修**:换成 curated `SafeObject`(只 keys/values/entries/fromEntries/assign/freeze),省掉全部反射/原型方法。单测:逃逸表达式抛错、合法 `Object.keys` 仍通、成员访问 `constructor/__proto__` 仍挡。**教训**:白名单沙箱别暴露带**反射方法**的构造器整体;`BLOCKED_KEYS` 式的「挡成员键」挡不住「敏感名当字符串实参」——要么白名单具体方法,要么连描述符读的返回值也过滤。

- ✅ **Tier3-#16 toVisionDataUrl 先全量缓冲再查大小(OOM)** — 加 Content-Length 预检(诚实服务器快拒)+ `readCapped` 流式上限(缺失/撒谎的 CL 也不 OOM,超 maxBytes 即停);无 stream 的 impl 回退 arrayBuffer+守卫。单测:CL 预检不读 body、流式超限拒、流式未超限通。**教训**:「读完再查大小」在不可信来源下=OOM 向量;要么先看声明的大小、要么流式带上限,别先全量缓冲。
- ✅ **Tier3-#17 eval_js 写门 vs action 工具提交 — 决定:接受为设计边界**。`click`/`type_into(submit)` 能触发表单提交、不走写确认门。但它们是**用户指令下 agent 操作页面**的基本手段(点「搜索」「下一页」),给每个「可提交的点击」加确认会**瘫痪正常交互**(= 引入新 bug)。eval_js 的写门只管 eval_js 的**直接网络写**;explore 中安全采证走 `capture_submission`。已在 `eval-js.ts` 加范围说明注释。**教训**:通用 agent 的「操作页面」≠ adapter 的「写请求」,别把前者当后者门控。
- ✅ **Tier3-#18 sha256=一致性非真实性 — 决定:接受为设计边界**。哈希是 index↔body 一致性校验(防 CDN 偏斜/缓存),非防恶意 origin(index 与 body 同源取)。但 market base URL **无 in-`src` 写入口**(dev/fork-only),产品内无覆盖向量;真实性需签名 index/pin 发布方(超范围)。已在 `marketplace.ts` 加注释。**教训**:哈希校验要说清防的是「偏斜」还是「来源」——同源取的哈希只防前者。

**✅ Tier 3 全部完成(4/4:#15/#16 修复,#17/#18 评估后接受为设计边界并记录)。**

### Tier 4(逐条)
- ✅ **vision 三小项** — image-registry `byRef` 命中时 LRU touch(热引用不再被 FIFO 早逐,单测)· 注册表 cap 对齐 `MAX_VISION_IMAGES_PER_TURN`(http 图 #7-8 也得 `[img_N]`)· engine-history flatten 占位符改中性文案(不再对多模态主模型谎称「不支持视觉」,改单测)。
- ✅ **感知三小项** — get-interactives 合并 iframe 后**全局 re-cap**(避免 cap×N 爆 token,单测)· scroll-page 容器滚动走 `parseFrameRef`(iframe 内层 scrollable 可滚,与 click/type 一致)· screenshot 拼接回退 cap 从 16000 降到 `CHUNK`(过高单截会自己失败)。
- ✅ **installed-store 单事务 RMW**(F-35 类,见上「已修」)。
- ✅ **finish_reason 处理** — 执行完 tool_calls 后**无条件循环**让模型消费结果(不再因 `finish_reason:'stop'/'length'` 提前结束、留空答案);到 2029 必有 tool_calls(无则在 1057 guard 已返回),`for(;;)` 落空即循环,受 maxSteps 约束。

**决定:以下 Tier 4 尾项评估后暂缓(各有理由,记录以免漏)——多为低价值或改动风险 > 收益,与「勿引入新 bug」权衡后择期单独处理:**
- **session.history 无上限 + saveSession O(n²)**(#T4m):性能项,非正确性;活跃期 keepalive 自 ping 撑着、写放大受单次 run 长度约束。改「history 轮转 + saveSession 去抖」触及持久化热路径,风险 > 收益,暂缓。
- **confirm-prompts / steerQueue 未持久化**(#T4n/o):SW 硬回收才丢;steer 正常完成会重投;confirm-prompts 审计里本就建议「接受为残留风险」。**接受为残留风险**,暂不持久化。
- **agent-window onRemoved 惰性注册非顶层**(#T4k):MV3 唤醒可能漏派发,但已被 `storage.session` 恢复 + 每调用 `windows.get` 重校验**重度缓解**;移到顶层需重构 SW boot 接线,收益有限,暂缓。
- **接管卡多会话无标签**(#T4l):需 ≥2 并发接管才现,极罕见;UI 改动在 App.tsx(6965 行)成本 > 价值,暂缓。
- **visionInline 同轮双发 `[img_N]`+裸字节**(#T4i):纯 token 浪费非正确性;需跟踪「本轮已 inline 的 ref」跳过铸号,中等复杂、低价值,暂缓。
- **paintOverlay 贴本地 ref 非命名空间**(#T4j):overlay 在**帧内** collectInteractives 里绘制,此时 frameId 尚未由 executeScript 结果分配,帧内拿不到命名空间 ref;根治需重构,暂记为「overlay 编号仅顶层帧可直接当 ref 用」的已知边界。
