# 经典扩展对照:能力包络与模式地图(2026-07-06)

把主流 Chrome 扩展逐个映射到本项目的原语上,回答两个问题:**现有能力能覆盖什么**、
**加哪些能力解锁面最大**。方法:用户报菜名 + 检索安装量数据(DebugBear 2024 统计:
AdBlock 67M / ABP 46M / uBlock 36M / Grammarly 50M / Google Translate 40M /
GoFullPage 8M / React DevTools 4M / Power Automate 4M;Tampermonkey ~11M 等),
逐个判定 ✅/◐/❌ 并归因到模式。roadmap **H11** 即出自本分析。

## 模式框架

| # | 模式 | 落点 | 状态 |
|---|------|------|------|
| ⓪ | **站点任务自动化**(读写站点、批量、定时) | 探索→adapter→工作流/计划任务 | ✅ **主场** |
| ① | **读/析当前页**(体检、提取、问答) | agent 任务/快捷方式;探索模式可加仪器(eval_js/Performance API/network) | ✅ |
| ② | **静态改造页面**(per-site CSS/JS) | 站点脚本(matches 禁全网通配,by design) | ✅ 单站 |
| ③ | **浏览器编排**(tab/窗口/清单) | 通用工具组合(list_tabs/close_tab/manage_tabs/notes) | ✅ |
| ④ | **页面内持续智能**(自动翻译、写作辅助、页内浮层) | ❌ 缺页面↔LLM 桥 → **roadmap H11** | ☐ |
| ⑤ | **扩展平台层**(newtab、全局快捷键、popup、录屏、全网脚本、browsingData) | 逐个权衡的新功能 | ❌ |
| ⑤b | 子模式:**页面内常驻交互 UI**(hover 检查器、拾色器、侧栏树、VisBug 面板) | 站点脚本 JS 理论可写=让 LLM 现写小前端,质量不可靠;缺"官方注入组件积木" | ☐ |

## 对照目录(节选,判定=不加新功能的前提下)

- **OneTab / Session Buddy** ③ ✅:list_tabs→存笔记→close_tab;恢复=笔记链接/open_url。快捷方式化。
- **Infinity/Momentum(newtab)** ⑤ ❌:`chrome_url_overrides` 平台能力,chrome://newtab 不可注入。
- **沉浸式翻译** ④ ❌(核心);划词翻译/整页另译 ✅。→ H11 头号场景。
- **Dark Reader** ② ◐:单站暗色站点脚本 ✅;全网+智能配色引擎 ❌。
- **简悦 SimpRead** ②+① ✅七成:去广告/排版=站点脚本;一次性阅读=extract-markdown;导出 Notion/Obsidian ◐(探索写 adapter / obsidian:// URI)。
- **Wappalyzer / META SEO / Glimpse / Lighthouse-lite** ① ✅:get_html+eval_js+list_network+get_a11y_tree → LLM 报告(比规则库多"解释+建议");常驻角标/评分引擎 ❌。
- **Vimium** ⑤ ❌:全局键盘+tabs 控制;单站 j/k 玩具 ◐。与产品定位错位(加速人手 vs 替人动手)。
- **Loom / 录屏** ⑤ ❌(tabCapture+UI+存储);agent 图文教程(自己走流程+逐步截图)是另一种解法。
- **GMass** ⓪ ✅◐:探索 Gmail→send adapter→列表循环+LLM 逐封个性化;批量写撞安全策略(逐封确认/auto 自担),小批量合适。
- **OctoTree** ⑤b ◐:GitHub API 允许 CORS,站点脚本理论可写侧栏树;问答式替代 ✅。
- **WhatFont / CSS Peeper / ColorZilla / JSONView** ①→✅问答式(「这个标题什么字体」「提取设计体系」「解读这份 JSON」);常驻交互器 ⑤b。
- **VisBug** ②+① ◐→✅换形态:对话式改样式→满意后固化站点脚本。
- **Fake Filler** ①/⓪ ✅✅:get_interactives+type_into,LLM 生成语义合理假数据;常用表单可固化 adapter。**最佳内置快捷方式素材。**
- **Click&Clean** ⑤ ❌:需 browsingData 权限,与 2026-07-06 权限收缩方向相反,产品上不做。
- **AdBlock 系(67+46+36M,最大品类)** ②/⑤:DOM 级隐藏 ✅(站点脚本);**网络级拦截 ❌(缺 declarativeNetRequest)**。
- **Grammarly(50M)/ LanguageTool** ④ ❌:全网输入框持续辅助 → H11 第二场景。
- **Google Translate(40M)** ④/①:整页另译 ✅,原地对照 ❌ → H11。
- **Honey/Keepa(购物)** ⓪ ✅:试优惠码/价格追踪=站点自动化+计划任务(比价本来就是测试用例)。
- **Tampermonkey(~11M)** ≈站点脚本品类验证:我们的差异化=**agent 生成脚本**而非人写。
- **Power Automate(4M,RPA)** ⓪:与主场同类,验证"浏览器 RPA"有真实需求。
- **GoFullPage(8M)** ✅已有(整页截图 F-36 修复);**Monica/Sider 类 AI copilot**:摘要/页面对话 ✅,页内浮层/全网划词写作 → H11。
- **密码管理(LastPass 等)** 不碰:安全产品,信任门槛不同维。

## 能力增补排序(解锁面 ÷ 成本)

**第一梯队:**
1. **H11 页面↔LLM 桥 + 页内 UI 组件积木(⑤b 一起解)** — 解锁模式④整类:沉浸式翻译、
   Grammarly 级写作辅助、页内摘要/悬停解释、智能填表。对标品类体量最大(Grammarly 50M +
   Translate 40M + AI copilot 全类)。积木(浮层/侧栏/高亮器)让 agent 不必每次现写 UI。
2. **declarativeNetRequest 网络规则层** — 解锁最大安装品类(拦广告/跟踪器,合计 150M+)
   与请求改写;差异化=agent 按站点探索生成精准规则(DOM 隐藏已有,网络级是缺口)。中成本。
3. **平台入口三件套:toolbar popup 快捷面板 / chrome.commands 全局快捷键 / contextMenus 右键** —
   不新增"能力",但把已有模式①③从"开侧栏→点→发送"压到"一键":Wappalyzer/OneTab 的爽感
   本质是入口近。小成本,放大存量功能的杠杆最大。

**第二梯队(便宜补场景):**
4. **tabs.discard 挂起标签页** — tabs 权限已有,近零成本;OneTab 编排的无损变体(释放内存不关页)。
5. **剪藏/导出通道**(Notion/Obsidian/Readwise):通用 webhook/API 导出配置,或按站探索写 adapter。
6. **cookie 工具**(EditThisCookie 场景):cookies 权限已有,加确认门控的读写工具,开发者向。

**第三梯队(重/需产品决策):** 录屏(tabCapture)、newtab 接管、密码管理(不做)。

**不用加、已是主场**:RPA(Power Automate)、比价/优惠码、定时抓取(schedules)、
高亮批注(划词助手)、截图标注、userscript 管理(站点脚本)。

## 判定时反复用到的判据(沉淀)

1. 先问宿主:功能活在**网站页面里**(①②④)、**浏览器编排层**(③)、还是**扩展平台层**(⑤)?
2. 页面里的再问:静态(②站点脚本够)还是要**持续调用智能**(④缺桥)?
3. 交互形态单独判:内核能做 ≠ 体验对齐——"点图标瞬间出结果"类差距都在入口(→三件套)。
4. agent 版的差异化固定出现在:**解释性报告、跨页巡检、语义生成(个性化/假数据)**——
   原插件是规则,我们是智能;这些场景应做成内置快捷方式当卖点。
