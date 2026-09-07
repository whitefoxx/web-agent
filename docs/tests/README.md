# 系统性端到端测试（real-browser / 真机）

> 这是一套**活文档**:对 284 个 marketplace adapter + 30 个通用工具 + 12 个 bridge 合成工具 +
> 平台功能(并行/自动升级/记忆/计划模式…)做**真机**测试,逐个过、记录结果、修问题、总结经验。
> 单元测试(`tests/`)覆盖纯逻辑;**这里覆盖单测覆盖不了的**:真实登录态、页面/CDP、网络、跨工具
> 编排。

## 1. 目的

- **验证每个 adapter / 工具在真实浏览器里能跑、结果正确**(单测用 mock,测不到真站点/登录/反爬)。
- **把发现的问题闭环**:症状 → 根因 → 修法 → 教训,沉淀成可复用的经验。
- **产出经验**给后续:改进现有 adapter、explore 新 adapter、写工作流/快捷方式时少踩坑。

## 2. 范围与文件

| 文件                         | 内容                                                             |
| ---------------------------- | ---------------------------------------------------------------- |
| [README.md](./README.md)     | 本计划:目的 / 方法 / 分层 / 策略 / 记录规范(先读这个)            |
| [adapters.md](./adapters.md) | **284 个 adapter 的逐条 checklist**(按站点;由 `index.json` 生成) |
| [platform.md](./platform.md) | 30 个通用工具 + 12 个 bridge 合成工具 + 平台功能的 checklist     |
| [site-probes.md](./site-probes.md) | **常用站点探针**:拿真实站点跑一遍,验**基础能力**够不够(不是维护站点 skill——失败先分「站点变更」还是「base 缺口」) |
| [tasks.md](./tasks.md)       | **E2E 任务测试**:给定任务,验 agent 的计划/工具选择/串并行/容错   |
| [findings.md](./findings.md) | **问题 / 修法 / 经验**的滚动日志(症状/根因/修法/教训)            |

## 3. 环境与前置

- **驱动方式**:外部接入 bridge(`web-tools/bridge/server.mjs`,默认 `127.0.0.1:8787`)。用 `curl`/HTTP
  打 `/command`(见 [external-agent-control.md](../external-agent-control.md) 与 `web-agent` skill)。
  这条路径**一次只跑一个工具**,正好适合"逐个过 adapter"。
- **登录态**:站点 adapter 大多依赖用户在该站点的**真实登录**。测前确认登录了哪些站;没登录的
  记 🔒(blocked),不算失败。
- **写操作开关**:外部接入里的 **允许外部写操作** 必须开,write adapter 才会真正执行(见 §6)。
- **catalog 时序坑**:SW reload 后 bridge 的 `/tools` 可能只剩 30 个 generic(站点 adapter 还没
  load 完就推了 catalog);**直连 `/command` 仍可用**(registry 已加载)。要测 not-installed 的,先
  `load_adapter {site,name}`(临时加载,返回 arg schema),再调 `<site>__<name>`。

## 4. 测试方法(每个 adapter 的标准动作)

1. **拿到 arg schema**:已安装的看 `/tools`;没装的 `load_adapter {site,name}`(返回 args)。
2. **构造最小可用入参**跑一次 `/command`,挑**只读、低风险**的入参(如 search 用常见关键词)。
3. **判读结果**:`{ok:true, result:…}` 且 result 结构/内容**合理**(非空、字段对、无串台)才算 ✅;
   `ok:false` 看 error 分类:
   - `auth_required` / 登录态 → 🔒(blocked,需登录),不是 adapter 的错。
   - `rate_limited` → ⏭️(限流,过会再试),记一下。
   - `EmptyResultError` → **可能是 bug**(换个明显有内容的入参复核;参考 §10.29 知乎搜索那次)。
   - 其它 error → ❌,去 findings.md 立案。
4. **记录**:在 adapters.md 对应行的 **结果** 列写 ✅/❌/🔒/⏭️ + 一句话;❌ 同步进 findings.md。
5. **多面看**:adapter 不只"能跑",还要看**翻页 / 限制 / 字段完整性 / 中文/emoji / 长内容截断**等;
   能并行的(同回合多个只读)顺手验证并行(见 platform.md 并行项)。

## 5. 分层与优先级(从安全到有风险)

- **A — 公共 API,无需登录**(`arxiv` `bluesky` `devto` `hackernews` `lobsters` `stackoverflow`
  `wikipedia`):确定、无副作用、无登录依赖 → **先全测**,作为冒烟基线。
- **B — 登录态下的只读**(其余站点的 🟢read):登录了就测;没登录记 🔒。站点的**公共内容只读**
  (search / hot / trending / 公开 profile)常常无需登录也能跑,优先这些。
- **C — 写操作**(🔴WRITE,63 个):**默认不自动跑**,见 §6。

通用工具 / bridge 工具 / 平台功能见 platform.md,与 A/B 并行推进。

## 6. 写操作策略(⚠️ 有真实副作用)

write adapter 会**真的**发帖/评论/点赞/关注/删除。规矩:

- **逐个、显式获得用户同意**才跑;**绝不**批量自动跑 write。
- 优先 **dry-run / 可撤销** 的(部分 adapter 自带 dry-run,如 linkedin `connect`/`salesnav-message`);
  能点赞→取消、关注→取关这种**自我可逆**的成对验证。
- **破坏性**(`delete` / `unsubscribe` / `block` 等)默认 ⏭️ skip,除非用户明确点名要测且可接受后果。
- 测 write 前确认 **允许外部写操作** 已开;测完如有残留(测试帖/评论)提醒用户清理或用对应
  删除 adapter 收尾。

## 7. 状态图例 & 通过判据

`☐` 未测 · `✅` 通过 · `❌` 失败(→ findings.md) · `🔒` 阻塞(需登录/前置) · `⏭️` 跳过(注明原因)

**✅ 通过** = 真机调用 `ok:true` 且结果**结构正确 + 内容合理**(不是空壳、不串台、字段齐)。"能返回
但内容明显不对"算 ❌(如 §10.29:type=question 必空)。

## 8. 记录规范(闭环)

- 每跑一个:在 adapters.md / platform.md 勾掉并填**结果**列(一句话结论)。
- 失败:在 **findings.md** 立一条,按 **症状 / 根因 / 修法 / 教训** 写(和 `docs/adapter-hot-plug.md`
  §10.x 一致的形状)。如果是 adapter 源码 bug,修复走 marketplace 子模块流程(改源码 → 轮换
  `index.json` 的 sha256 → 推子模块 → 主仓 bump 指针,见 [CLAUDE.md] 与 §10.29),并在
  `adapter-hot-plug.md` §10.x 也留档(adapter 类 bug 的长期家)。
- 跑完一轮:更新 adapters.md 顶部 **Progress** 计数 + 在 findings.md「经验总结」补本轮教训。

## 9. 维护(adapter 增减时)

marketplace 加/删 adapter 后,重新生成 checklist(保留已填结果需手动合并,或先看 diff):

```bash
# 重新生成 docs/tests/adapters.md 的清单(脚本见本次提交的生成逻辑 / git 历史)
# 思路:读 marketplace/index.json → 按站点出表。生成后把旧的「结果」列手动并回。
```

更细的维护约定写在仓库根的 `CLAUDE.md`「系统性测试文档」一节。
