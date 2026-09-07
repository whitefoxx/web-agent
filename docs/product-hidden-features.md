# 发布版隐藏功能(`product` 分支)

> 目的:`product` 分支是**准备对外发布的精简版**。为了让首个版本更简单,把几个「进阶」
> 功能隐藏掉。代码没有删除——只用一个功能开关文件集中关掉,**恢复 = 把开关翻回 `true`**。
>
> 当前隐藏:**我的笔记 / 凭据 / 划词助手**(`notes` / `secrets` / `selectionToolbar`)。
> **已恢复:我的记忆**(`memory`,2026-07-17 翻回 `true`,并重做成 ChatGPT 式单文档;详见
> [skills-and-memory.md](skills-and-memory.md))。
>
> `main` 分支这些开关全为 `true`(功能全开);`product` 分支按上面取舍。两个分支之间合并
> 时,冲突点基本只有这一个开关文件。

## 开关文件:`src/config/features.ts`

```ts
export const FEATURES = {
  memory: true, // 我的记忆(长期记忆)—— 2026-07-17 恢复 + 重做为单文档
  notes: false, // 我的笔记(markdown 笔记本)
  secrets: false, // 凭据与脱敏
  selectionToolbar: false, // 划词助手(划词工具条 + 高亮)
} as const;
```

一个无依赖的常量模块,被侧边栏 / 后台 SW / agent 引擎 / content-script 共用。

## 恢复某个功能(一步)

把对应开关改成 `true` 即可,所有 gate 点会同时生效——**除了划词助手还需要一处
`manifest.json` 手工改动**(见下)。改完跑 `npm run typecheck && npm test`。

---

## 各功能的 gate 点(便于核对 / 恢复)

### 1. 我的记忆 memory —— `FEATURES.memory`(现为 `true`,单文档模型见 [skills-and-memory.md](skills-and-memory.md))

- **菜单入口**:`src/sidepanel/App.tsx` `MenuDropdown` 里的「我的记忆」项,包在
  `{FEATURES.memory && (…)}` 里。
- **提示词 / 工具**:`src/agent/api-engine.ts`
  - 工具数组里 `...(FEATURES.memory ? [UPDATE_MEMORY_TOOL] : [])` —— 关掉时不给模型
    `update_memory` 工具(工具描述是这个功能对模型唯一的「广告」,不给工具即等于改了提示词)。
  - `memoryBlock`(并入 `recallBlock`)—— 关掉时不再把用户长期记忆注入系统提示词
    (`FEATURES.memory ? renderMemoryBlock(getMemory()) : ''`)。
- **未 gate(有意保留)**:`update_memory` 的 intercept、`memory-store.ts` / `memory-edit.ts`、
  `message-router` 的 GET/SET/EDIT_MEMORY 路由、bridge 的记忆读写仍在——关掉时无 UI / 不给
  工具即「死代码」,不影响用户。

### 2. 我的笔记 notes —— `FEATURES.notes`

- **菜单入口**:`App.tsx` `MenuDropdown` 里的「我的笔记」项,包在 `{FEATURES.notes && …}`。
- **工具**:`api-engine.ts` 工具数组里 `...(FEATURES.notes ? [NOTES_TOOL] : [])`。
- **未 gate**:`notes` 的 intercept、`notes-store.ts`、`LIST_NOTES` 等 message 路由
  仍在(死代码,无入口触发)。

### 3. 凭据 secrets —— `FEATURES.secrets`

- **菜单入口**:`App.tsx` `MenuDropdown` 里的「凭据」项,包在 `{FEATURES.secrets && …}`。
- **运行时**:凭据在适配器运行时注入(`secret-store.ts`)。UI 隐藏后**无法新增凭据**,
  没有已存凭据时注入就是空操作,所以运行时无需额外 gate。
- **未 gate**:`secret-store.ts` 全部逻辑、脱敏(redaction)那一道后台打码、bridge 的
  `list_secret_names` 仍在。脱敏是安全相关、与凭据解耦,**有意不动**。

### 4. 划词助手 selectionToolbar —— `FEATURES.selectionToolbar` + `manifest.json`

- **content script(需手工恢复!)**:`manifest.json` 里原本声明了
  `content_scripts: [{ js: ["src/content/selection-toolbar.ts"], matches: http/https }]`。
  在 `product` 分支**整段删除**——工具条本来默认关闭(`DEFAULT_SEL_SETTINGS.enabled=false`)
  且设置页已隐藏,删掉声明则连注入都省了(更干净、每页零footprint)。
  **恢复时:把这段 content_scripts 加回 manifest.json**(开关翻 `true` 不会自动加回它)。
- **菜单入口**:`App.tsx` `MenuDropdown` 里的「划词助手」项,包在 `{FEATURES.selectionToolbar && …}`。
- **agent 工具**:`src/tools/generic/get-highlights.ts` 的 `cli({...})` 注册整体包在
  `if (FEATURES.selectionToolbar) { … }` 里——关掉时不注册 `get_highlights`(工具条隐藏后
  没有新高亮产生,该工具永远只会读到空)。
- **测试**:`tests/generic-get-highlights.test.ts` 用 `describe.skipIf(!FEATURES.selectionToolbar)`
  ——`product` 分支该套件跳过,恢复功能后自动重新运行。
- **未 gate**:`selection-toolbar.ts` 源码、`selection/` 目录、`background/selection-actions.ts`、
  `SELECTION_LLM/ASK` 路由仍在(没有 content script 注入就永不触发)。

---

## 恢复清单(全部功能一起恢复)

1. `src/config/features.ts`:四个开关全改为 `true`。
2. `manifest.json`:把 `side_panel` 与 `action` 之间的 `content_scripts` 段加回(仅划词助手需要):
   ```json
   "content_scripts": [
     {
       "matches": ["http://*/*", "https://*/*"],
       "js": ["src/content/selection-toolbar.ts"],
       "run_at": "document_idle"
     }
   ],
   ```
3. `npm run typecheck && npm test`(get_highlights 套件应从 skipped 变回运行)。
4. `npm run build`,确认 content script 重新进 bundle、菜单四项重新出现。

## 备注

- 系统提示词(`api-system-prompt.ts`)本身**没有**用散文宣传这四个功能——它们对模型
  唯一的「提示词」就是各自的工具描述(`REMEMBER_TOOL` / `NOTES_TOOL` / `get_highlights`),
  所以「不给工具」= 已经改了提示词,无需再动 prose。
- 未 gate 的死代码有意保留:改动面越小,`main`↔`product` 合并越省事,恢复越简单。
