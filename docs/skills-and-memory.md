# 技能(skills)与 我的记忆(memory)

> 2026-07-17 在 `product` 分支落地两件事:(1) 把隐藏的「我的记忆」恢复并**重做成
> ChatGPT 式单文档**;(2) 新增「技能」——类 Claude Code 的**单文件 markdown skill**,
> 走渐进披露(agent 按需加载)。二者都可在输入框用 `/` 唤起、也能让 agent 会话中创建。

---

## 一、我的记忆 memory —— 从「一条条」改成「单文档」

### 为什么改
旧模型是 IndexedDB 里一条条 `MemoryFact`(agent `remember` 一次追加一条,注入时取前
N 条)。参照 ChatGPT 的 Memory summary,改成**一份自由 markdown 文档**:用户可直接
整篇编辑,也可以用一句话让 AI「Add or update」。**暂不做**从会话里自动提取——完全靠
用户写 + agent 辅助改。

### 数据模型(`src/agent/memory-store.ts`)
- `MemoryState = { enabled, content, updatedAt }`,存 `chrome.storage.local` 的 `memory` 键
  (单个小值,不再用 IDB,省掉 schema/版本)。默认 `enabled: true`。
- 读写:`getMemory` / `setMemoryContent` / `setMemoryEnabled` / `appendMemory`(bridge 用)。
- 纯函数(有单测 `tests/memory.test.ts`):
  - `renderMemoryBlock(state, cap=4000)` —— `enabled && content` 才注入,超长截断。
  - `renderMemoryExport(state)` —— 导出为带日期标题的 markdown。

### 「Add or update」= 一次定向 LLM 改写(`src/agent/memory-edit.ts`)
`editMemoryWithLLM(current, instruction)`:用 `resolveSlots()` 拿主模型 + `chatCompletion`
做**一次性**补全(无工具、无页面),系统提示要求「融入新信息 + 保留仍有效的旧内容 +
去重精简,只输出文档本身」。它**不是** agent 会话。SW 里由 `EDIT_MEMORY_LLM` 路由驱动,
改写后 `setMemoryContent` 落盘并把新 state 回给面板。

### 注入 & agent 工具
- `api-engine.ts`:`memoryBlock = FEATURES.memory ? renderMemoryBlock(getMemory()) : ''`,
  与 `skillsBlock` 合成 `recallBlock`,在 plan / exec 两处系统提示里注入。
- 工具从 `remember({fact})`(追加一条)换成 **`update_memory({content})`**:agent 已在上下文
  里看到当前记忆全文,传回**整合后的完整新版本**,intercept 整篇覆盖(`enabled=false` 时拒写)。

### 消息路由(SidePanel ↔ SW,`messages.ts` / `message-router.ts`)
`GET_MEMORY` → `MEMORY_STATE`;`SET_MEMORY{content}`、`SET_MEMORY_ENABLED{enabled}` →
`MEMORY_STATE`;`EDIT_MEMORY_LLM{instruction}` → `MEMORY_EDIT_RESP{state|null, error?}`。
(旧的 `LIST/ADD/UPDATE/DELETE_MEMORY` 全部删除。)

### UI(`App.tsx` `MemorySection`)
启用开关 + 一块可编辑的整篇 textarea(保存 / 还原 / 导出)+ 底部「Add or update」指令框
(回车或按钮触发 `EDIT_MEMORY_LLM`,更新中禁用)。CSS 见 `style.css` `.memory-enable` /
`.memory-doc-actions` / `.memory-addupdate` / `.memory-instruction`。

### bridge(`bridge-client.ts`)
`save_memory(fact)` = `appendMemory`(追加一行);`list_memories` = 返回整篇 blob;
`delete_memory` 因无逐条 id 退役,换成 `clear_memory`(清空)。⚠️ bridge **submodule** 里
的工具清单/SKILL 仍可能写着 `delete_memory`——外部 agent 调它会「未知工具」,无害;
下次动 bridge 时同步改。

### 恢复开关
`FEATURES.memory` 在 `product` 由 `false` 翻成 `true`(`main` 一直是 `true`)。见
[product-hidden-features.md](product-hidden-features.md) §1。

### ⚠️ main↔product 合并注意(数据迁移)
`product` 从没上过旧的 fact-list,所以**无需迁移**。但 `main` 上如果已有旧 IDB
`web-memory/facts` 数据,这次改成 `chrome.storage.local` 单 blob **不会自动搬**——真要合到
main 时得写一次性迁移(读旧 IDB → 拼成 blob → 写新键),否则老用户的旧记忆读不到。

---

## 二、技能 skills —— 类 Claude Code 的单文件 md

### 定位:技能 ≠ 工作流
| | 工作流(shortcut) | 技能(skill) |
|---|---|---|
| 触发 | **用户**在输入框 `/` 唤起、插进输入框 | **agent** 按 description 判断相关时**主动**加载 |
| 形态 | 一段提示词配方 | 单文件 markdown 说明书(name + description + body) |
| 机制 | 展开成文本 | **渐进披露**:提示里只列 name+用途,`use_skill` 按需拉正文 |

两者都能在 `/` 面板手动插入;技能的 body 也能嵌 `⟦tool:..⟧`(工具/适配器/工作流)。

### 数据模型(`src/skills/store.ts`)
`Skill = { id, name, description, body }`,存 `chrome.storage.local` 的 `skills` 键
(同 shortcuts 套路)。CRUD:`listSkills` / `getSkillByName` / `saveSkill` /
`saveSkillByName`(按名 upsert,agent 用)/ `deleteSkill`。纯函数
`renderSkillsBlock(skills)`(单测 `tests/skills-store.test.ts`):**只**广告 name+description。

### 注入 & agent 工具(`api-engine.ts` / `engine-tools.ts`)
- `skillsBlock = renderSkillsBlock(listSkills())`,并入 `recallBlock`。始终开(无技能=空块)。
- `use_skill({name})`:intercept 返回该技能 body(正文里 `⟦tool:..⟧` 作为执行引导)。**始终**注册。
- `create_skill({name, description, body})`:按 name upsert(非探索模式,和 create_workflow 并列)。
- 系统提示 prose 见 `api-system-prompt.ts`「把能力固化 & 串联」段新增的技能条目。

### `/` 面板(`commands.ts` / `command-editor.tsx`)
- `CommandItem` 新增 `kind:'skill'`;`gatherCommands(shortcuts, tools, skills, opts)` 多返回一个
  `skills` 组(第三参默认 `[]`,老调用点不传即无技能,不破坏 recursion 约束)。
- `command-editor` 面板加「技能」分组(📄);选中技能 = `insertTextWithTokens(body)`(和工作流一样,
  body 里的 token 变 chip)。
- 主输入框 `/` 现含 命令 / 工作流 / **技能** / 工具四组。
- **技能编辑器自身**的 `/` 只给 工作流 + 工具/适配器(`skills: []`),防止技能嵌自己。

### UI(`App.tsx` `SkillsSection` + 菜单)
镜像 `ShortcutsSection`:name 输入 + description 输入 + `CommandEditor` 正文(`/` 可插工具/适配器/
工作流)+ 列表(插入 / 编辑 / 删除)。菜单在「工作流」下方加「技能」(📄 `IconFile`)。
`View`/`PAGE_LABELS` 加 `skills`;App 持有 `skills` state,`storage.onChanged` 同步。

### 没做 / 有意留后
- 技能**不分文件夹、不带资源**(就单文件 md);要更复杂再说。
- 不自动从会话「学」技能——只手动写 / 让 agent `create_skill`。
- 技能没有独立启用开关(有 body 即视为可用);要软开关再加字段。
