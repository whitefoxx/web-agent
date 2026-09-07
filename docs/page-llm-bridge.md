# 页面↔LLM 桥(H11 P1)— 站点脚本的 `__webLLM` API

分支 `feat/page-llm-bridge`,2026-07-06。零新权限。出自 docs/extension-patterns.md
的模式④缺口:站点脚本是静态 CSS/JS,页面里没有通往扩展 LLM 的路——沉浸式翻译、
页内摘要浮层、写作辅助整类做不了。本桥补上这条路。

## 架构(一条消息通道 + 三层防线)

```
site-script js (USER_SCRIPT world)
   __webLLM.call(prompt, {system})        ← 编译期注入的前导码(闭包变量,非全局)
      └ chrome.runtime.sendMessage({type:'PAGE_LLM_CALL', scriptId, prompt, system})
          ↓  (userScripts.configureWorld({messaging:true}) 打开;默认 USER_SCRIPT world,
          ↓   与 func-adapter 的命名 world(configureWebWorld)互不干扰)
SW: chrome.runtime.onUserScriptMessage        ← 专用事件:页面 MAIN world 的 JS 到不了
   background/page-llm.ts handlePageLlmCall
      ① 授权:scriptId 必须存在 + enabled + llmAccess(与 js 同一道用户确认授予)
      ② 来源:sender.tab.url 必须命中该脚本自己的 matches(偷到 scriptId 也没用)
      ③ 限额:30 次/5min + 300 次/天(滑窗,按脚本)、全局并发 3、
              prompt ≤6000 字 / system ≤1000 字、max_tokens 1000、超时 60s
      → resolveSlots().primary → chatCompletion → {ok, text} / {ok:false, error}
```

要点:

- **信任边界靠通道而非秘密**:`onUserScriptMessage` 只接收 USER_SCRIPT world 的
  runtime.sendMessage(网页自身需 `externally_connectable` 才能给扩展发消息,我们
  不声明)。scriptId 只是路由键,防线是 ①②③。
- **授权模型**:`SiteScript.llmAccess`(store 字段)只在带 `js` 时可设(buildSiteScript
  丢弃无 js 的悬空授权);create_site_script 的确认框明确写出「允许它在页面里调用
  你配置的 AI 模型 + 限频 + 会产生用量」。
- **前导码**(store.ts `llmBridgePreamble`)在 `buildInjectionCode` 的 IIFE 内、用户
  js 之前注入——`__webLLM` 是闭包绑定,连 USER_SCRIPT world 的全局都不是。
- **prompt-injection 立场**:页面内容是不可信输入。桥只做"文本进、文本出"的单轮
  completion,无工具、无会话、无记忆;脚本作者(agent)应在 system 里限定任务。
  限频+封顶保证最坏情况只是浪费一点额度。

## Agent 用法(已写进 create_site_script 工具描述)

`llm_access: true` + js 里:

```js
__webLLM.call(
  JSON.stringify({ task: 'translate to zh', texts: paras.map(p => p.textContent) }),
  { system: '你是翻译引擎,输入 JSON{texts},输出等长 JSON 数组,只回 JSON' }
).then(raw => { const out = JSON.parse(raw); /* 逐段插入译文节点 */ });
```

约定:**多段合并成一次调用、JSON 进出**(工具描述里已提醒),别逐段各调——限频
就是为逼出这个用法。

## 文件

- `src/background/page-llm.ts` — 桥本体:SlidingWindowLimiter / urlMatchesPatterns
  (纯,单测)+ handlePageLlmCall(校验链)+ initPageLlmBridge(SW boot 接线)。
- `src/site-scripts/store.ts` — `llmAccess` 字段、`llmBridgePreamble`、
  `buildInjectionCode(css, js, preamble?)`、compile 注入。
- `src/agent/engine-tools.ts` / `api-engine.ts` — 工具参数 `llm_access`、确认文案、
  结果文案。
- `src/background/service-worker.ts` — boot 调 `initPageLlmBridge()`。
- `tests/page-llm.test.ts` — 限流窗口、pattern 匹配(含 evil-suffix 域名)、校验链
  fail-closed、编译前导码(有 js 才有授权、前导码在用户 js 之前)。

## 真机验证清单(未过前不并 main)

1. chrome「允许用户脚本」开着;reload 扩展,SW 日志见 `page↔LLM bridge ready`。
2. 让 agent 给某站建一个 llm_access 脚本(最小验证:js 里 `__webLLM.call('说 ok')`
   然后 `document.title = 结果`)→ 确认框应出现"页内调用 AI"字样 → 同意后刷新页面
   看效果。
3. 头号场景:「给 X 站做双语对照:每次打开自动把正文段落翻译成中文插在原文下面」
   → agent 应生成 llm_access 站点脚本(批量 JSON 翻译 + 插入 DOM)。
4. 负面:同一 scriptId 从不匹配的站点发消息应被拒(改 matches 后旧页面调用报
   「来源页面不在匹配范围」);限频超 30 次/5min 报限频错。

## 留后(P2 候选)

- 每脚本 token 用量统计,显示在侧栏「站点脚本」行上(现在只有次数限制,无用量可见性)。
- `__webLLM.stream()`(流式)与 `translateBatch()` 便捷方法。
- 站点脚本页的 llmAccess 标识 + 单独撤销开关(目前 UI 不显示该标志,撤销=删脚本重建)。
- 廉价槽位路由:桥调用走 cheap/vision 之外的独立 slot,与主对话配额隔离。

## 验证结果(2026-07-06,bridge 驱动真机)

- ✅ 信任边界:真实页面 MAIN world `chrome.runtime.sendMessage` 不存在(eval_js 确认)。
- ✅ 端到端(头号场景):agent 一句话生成 llm_access 双语脚本(localhost 夹具
  `docs/tests/fixtures/llm-bridge.html`)→ 确认框含"页内调用 AI"字样 → 刷新后
  **后台 tab** 中 `#status="bridge: ok3"`、3 段 `.zh` 中文插入原文下,翻译质量良好。
- 🐛 第一轮失败 → **F-37**(findings.md):js 默认 document_start 读空 DOM +
  错误静默;已修(js 默认 document_idle、暴露 run_at、console.error 兜底)。
- 限频/来源校验为单测覆盖(真机未压测)。

## F-38 跟进:`{json:true}`(2026-07-06,HN 真机曲折的产物)

真实目标测试(「打开 HN 自动翻译标题」,用户只给目标)暴露:模型返回的 JSON 常带
代码块围栏,页内解析三连败,agent 迭代 5 版脚本才通(靠放弃 JSON)。修:call 增加
`{json:true}` —— SW 侧追加"只输出 JSON"提示 + `extractJsonPayload` 剥围栏/取块/
校验,失败明确报错;工具描述强制引导用该选项。findings.md F-38。
