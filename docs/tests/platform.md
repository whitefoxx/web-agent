# 平台 checklist — 通用工具 / bridge 工具 / 功能

> 配合 [adapters.md](./adapters.md) 一起推进。图例同 [README.md](./README.md):
> `☐` 未测 · `✅` 通过 · `❌` 失败 · `🔒` 阻塞 · `⏭️` 跳过。失败进 [findings.md](./findings.md)。

## 1. 通用工具(`generic__*`,39)

大多无需登录(操作的是你给的 tab / URL)。`open_url` 开的 tab **不自动关**(设计如此);
`get_page_text` 抓完**自动关**。

**Tab lifecycle, per shell (2026-08-18, `ff1d6bb`).** A tab whose id the caller
holds is the caller's to close, in every shell — that is unchanged. What the
extension now cleans up is what the caller never sees:

| what                            | full ("Web Agent")             | WebCLI                    | localmd Connect                |
| ------------------------------- | ------------------------------ | ------------------------- | ------------------------------ |
| `open_url` / `keep_open` tabs   | run end (SidePanel); caller's over the bridge | caller's   | caller's (localmd closes them per turn) |
| site-pool tabs (`run_adapter`)  | idle sweep                     | no pool                   | **idle sweep (new)**           |
| agent window w/ only `about:blank` | kept (anti-churn)           | **closed on idle (new)**  | **closed on idle (new)**       |

Real-machine ✅ 2026-08-18, dev build driven from localmd.app over the relay: a
`search.douban.com` pool tab is present while `run_adapter` runs and gone ten
quiet seconds later, taking the agent window with it; `open_url` + `close_tab`
empties the window and the window follows. The sweep is cancelled while a call
is in flight, so it never fires between two calls of one task.

### 导航 / 抓取

| ☐   | 工具                | 测法                                  | 结果                                                                                                                                                         |
| --- | ------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ✅  | `open_url`          | 开 example.com,返回 tabId;tab 保留    | chatgpt 预开验证;tab 保留(adopt 路径用)                                                                                                                      |
| ✅  | `get_page_text`     | 抓一个公开页正文,非空、自动关 tab     | 2026-07-02 真机:example.com 抓 129 字正文,tab 自动关。2026-07-03 加 `format:"markdown"`(⑭,在页面内 DOM→md walker,Turndown 要 DOM/SW 没有):真机 example.com→`# 标题`+`[Learn more](url)`+段落,`format:"text"` 无 md 标记、flag 切换正确(带登录态 WebFetch) |
| ✅  | `get_text_from_tab` | 对 open_url 的 tabId 抓文本(不关)     | 2026-07-02 真机:SO 问题页抓 100k 正文(truncated),含「branch prediction」。2026-07-03 加 `format:"markdown"`(复用 extractPageMarkdown 注入已开 tab,+selector 限定;单测 14/14)2026-07-04 真机 ✅(页面对话链路:agent 对已开 tab 抓 md 并据此回答) |
| ☐   | `find_in_page`      | Ctrl+F 式页内查找:对已开 tab 查某词,返回 count + 【】上下文片段;试 regex=true、scroll_to=true(滚到并原生高亮)、非法正则报错、大小写 | 2026-07-10 新增(单测 13/13,findTextMatches 纯匹配);真机待验:innerText 匹配可见文本、window.find 滚动、正则/子串、隐藏文本不计 |
| 🔧  | `web_search`        | 通用网络搜索:给 query,返回 `results[{rank,title,url,snippet}]`(开后台 SERP tab→waitForPageReady 等**结果链接**→注入 extractSerp→抓完关 tab,同 get_page_text url 模式);验:① **`engine` 必填**(2026-07-26 起,无默认值):`"auto"` → google→bing→duckduckgo 级联,取第一个出结果的(返回 `tried[]` 轨迹);不支持的值(baidu/yahoo)**报错**而非静默改搜别家;② 指定 `engine` 只用某个,三家各返结果、跳转 url 解码为真实目标 ③ `count` 生效 ④ **`max_wait_ms`** 可调大(默认 12000)重试慢页 ⑤ 三家都解析不出/验证页 → **回退 `fallback:"text"`+`text`**(SERP 纯文本)而非空手;`blocked:true` 标验证页 ⑥ WebCLI 壳也可调 | 2026-07-16 新增(单测 8/8→**15/15**:extractSerp 每引擎选择器+redirect+bot-check、parseEngine 级联/别名、buildEngine URL+ready 选择器、真 cn.bing 夹具回归;jsdom)。**首次真机(会话 s_mrn7dcjk):google ✅ / duckduckgo ✅ / bing ❌ 7/7 空 → F-40**(cn.bing 流式把 `li.b_algo` 容器前置塞 CSS,ready 只等容器→抓早了);已修:ready 改等**结果链接**+零结果 `sleep(700)` 重试×3。**用户后续真机确认 bing ✅**。二轮增强(级联/`max_wait_ms`/文本回退)**真机待验**。设计见 [webcli.md](../webcli.md) §web_search,post-mortem [findings.md](./findings.md) F-40 |
| ✅  | `fetch_url`         | 原始(不渲染)HTTP,get_page_text 的互补:SW 侧 fetch、带 cookie、免 CORS,返回 {status,headers,body/json};验:① JSON API → `format:"json"` 解析进 json ② `format:"text"` 强制文本 ③ POST + headers + body 透传、GET 丢 body ④ max_bytes 截断+truncated ⑤ 非 200 状态 surfaced ⑥ 带登录态取需登录的 JSON 端点 ⑦ **`stream_stop`**(2026-07-31,承载 MCP Streamable HTTP):对**不关闭**的 SSE 流 `stream_stop:"first_event"` 数秒内返回、body 里能解出 `"result"`/`"protocolVersion"`、`stream_open:true`;不传该参数时旧行为逐字节不变;`headers` 里 `mcp-session-id` / `www-authenticate` 仍完整可读 | 2026-07-16 新增(单测 12/12:runFetch stub fetch——json/text/POST/GET丢body/截断/404/坏json回退/headers;parseHeaders;Node)。**bridge 真机 ✅**:本地 HTML(text/200)、`sample.json`(auto→`format:json`、嵌套解析)、404 surfaced、118KB index.json 被 max_bytes 截断→json parse 失败→**text 回退(符合设计)**。POST 回显未测(需 echo server,单测覆盖);cookie 鉴权同 credentials:include 码路。**⑦ stream_stop 真机 ✅**(2026-07-31,dev 壳 9377;单测 39/39,含 SSE 分帧 / cancel 释放连接 / max_bytes 封顶 / 默认路径无 `stream_open` 字段):`opentargets` + `first_event` **2.32s**(原超时)、body 解出 `result.protocolVersion`、`stream_open:true`(其分帧是 **CRLF**,正是 `firstDataEventEnd` 三种行结束符都收的原因);`mermaid`/`aws` 不传参回归 **245 / 171 字节**——与各自 `content-length` 逐字对上、且结果对象里**没有**新字段;`notion` 的 `www-authenticate` 完整可读;`mcp-session-id` 在**流式**路径上存活(`aws` + `first_event` → `3b62ddcf-…`;mermaid 本身不发这个头)。**`api.scite.ai/mcp` 未复现挂死**:8/8 成功,default 1.44–4.27s vs idle 3.16–3.57s、均 3128 字节、`stream_open:false`(流自己会关),原「字节到了但连接不关」假设在本机被证否——详见 [webcli.md](../webcli.md) §16 |
| ✅  | `get_html`          | 取某 tab outerHTML,可截断             | 2026-07-02 真机(shadow-dom 夹具):selector 深查询命中 shadow 内 `#scard`,无 explore 会话                                                                     |
| ✅  | `screenshot`        | 截图返回 data URL;新增 tab_id 模式(截已开 tab、保留 SPA 状态、不关闭;探索 tab 上 attach 容忍会话所有权) | 2026-07-02 真机:tab_id 模式 155KB PNG、tab 保留(url 模式未单测,代码路径未变)                                                                                |
| ✅  | `scroll_page`       | 滚动后 get_text_from_tab 看到更多内容 | active ✅(0→1404);background 原 `smooth` 不滚(rAF 节流)→ 改 `instant`,reload 复测 0→1377/22%(F-27 ✅);⑤b 容器真机:react.dev 内滚容器 ref 0→182 到底 ✅(§3.6) |

### 标签页

| ☐   | 工具             | 测法                                    | 结果                        |
| --- | ---------------- | --------------------------------------- | --------------------------- |
| ✅  | `list_tabs`      | 返回 {count,tabs[]},结构正确            | sweep 全程使用,结构正确。2026-07-03 增强:每行 +windowId、pinned/groupId(稀疏字段),有分组时附 groups 清单(id/名称/颜色/窗口)——2026-07-04 真机 ✅ |
| ✅  | `get_active_tab` | 返回当前活动 tab                        | 2026-07-02 真机:正确返回**用户**活动 tab(github/browser-act),非探索 tab |
| ✅  | `close_tab`      | 关掉 open_url 的 tab,list_tabs 确认消失 | sweep 全程使用,复查确认消失 |
| ✅  | `manage_tabs`    | 多动作 tab 管理(2026-07-03 新增,单测 9/9→11/11):面板说「把我打开的标签页按主题归类建 tab groups」→ agent list_tabs 分类 → 每类一次 `manage_tabs(action:"group")`;验证 ① 分组名/颜色正确、跨窗口各建一组不挪 tab ② 不动本扩展自己的蓝色组(skipped_controlled) ③ `ungroup`(group_id)解组 ④ `activate` 聚焦 tab+窗口 ⑤ `pin`/`unpin`/`reload`/`move` 各一次 ⑥ **`back`/`forward`**(2026-07-16 新增) | ✅ 2026-07-04 用户真机(group/pin/…);**back/forward 见 F-41**:首测 `chrome.tabs.goBack` 在 agent 窗口 tab 上假报无历史(`eval_js` 证 `history.length=3` 且页内 `history.back()` 好使)→ 改注入 `history.go(±1)`;单测走 scripting mock、10/10;**用户最终真机复测待确认**(底层 history.go 已 bridge 实测通过) |

### 交互(会改页面状态)

| ☐   | 工具                | 测法                   | 结果                                                                                                                   |
| --- | ------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| ✅  | `get_interactives`  | 列出可点元素 + ref     | github 真机:新增 `clickables` 抓到 5 个 `cursor:pointer` 自定义控件(旧扫描漏);`scroll`/`scrollables` 字段在(§3.1/§3.5);2026-07-02 shadow 深扫真机:单层+嵌套按钮/链接/输入/select/cursor 卡片全中,遮挡剔除正确(covered 不在列)、composed 检测无 shadow 误杀、:hover 隐藏项正确不在列。2026-07-03 加 `new:true`/`new_count`(⑰ D2-lite,按 tab 记签名集、排除易变 ref、导航重置基线):真机扫→注入按钮→再扫(注入钮 `new:true`、原有不标、`new_count=2`)→导航重置(无 `new_count`)。2026-07-03 加 **iframe ref 语义**(allFrames 扫每帧,子帧元素 ref 带 `f<id>` 前缀 + `frame` 字段 + `frames` 汇总;click/type_into 拆帧号注进对应帧):真机夹具 iframe.html 8/8——顶层 `r1` + 子帧 `f4388r1`/`f4388r2`,点/输进子帧(`child:clicked`/`child:typed:hello`)、顶层回归。跨域走同一码路 |
| ✅  | `click`             | 按 ref 点击,页面有反应 | wiki 真机:ref 点击 `found:true`+`used_hit_target:true`(命中测试在)+导航(§3.2);2026-07-02:shadow ref 点击(单层+两层嵌套)`#status` 落标记;`blocked_by` 遮挡反馈真机过(点名横幅,关掉后消失)。2026-07-16 加 `button`(left/right/middle)+`count`(1/2):右键发 contextmenu、双击发 dblclick,默认左单击仍走原生 el.click()(路径不变)。**bridge 真机 ✅**:`button:"right"`→`#status=contextmenu:rcTarget`、`count:2`→`dblclick:dcTarget` |
| ✅  | `click_by_text`     | 按可见文本点击         | wiki:「View history」命中 1 个 + `used_hit_target` + 导航(shadow 深扫版未单独复测)                                                              |
| ✅  | `type_into`         | 往输入框打字           | wiki search 框:native setter 写入 `final_value=browser test`(no submit);2026-07-02:shadow input 写入且事件触发(s1-input:hi)                                                |
| ✅  | `wait_for_selector` | 等某选择器出现再返回   | 2026-07-02 真机:嵌套 shadow `#sdeepbtn` 27ms 命中,无 explore 会话                                                                                                                        |
| ⚠️  | `press_key`         | fixtures/shadow-dom.html:focus `#kbd` 后按 Escape / ArrowDown / ctrl+Enter,`#status` 出现 kbd-esc / kbd-down / kbd-ctrl-enter | 2026-07-02(F-28 三连坑):focus 仿真 + 后台 tab 自动激活(`activated:true`)均真机 ✅,ArrowDown / 字符 / Ctrl+Enter 落 keydown;**Escape 本机不达**(同路径其它键全通,疑第三方扩展 capture 拦截)→ 干净 profile 复测后定论                                                                                                                        |
| ✅  | `select_option`     | shadow-dom.html:选 shadow select 的「选项A」,`#status` 出现 s1-sel:a;label/index 两种定位各试一次 | 2026-07-02 真机:label「选项A」→ value:a / index:1,shadow 内 change 事件触发(s1-sel:a);index/value 定位未单测                                                                                                                        |
| ✅  | `hover`             | shadow-dom.html:hover `#hovertrigger` 后 `:hover` 菜单展开,再 click「菜单项A」→ `#status` 出现 menuA(合成事件触发不了 :hover,必须 trusted) | 2026-07-02 真机:**后台 tab** 上 trusted mouseMoved 触发 :hover,菜单项从不可见变为可扫可点(menuA 落 status)                                                                                                                        |
| ✅  | `drag_and_drop`     | 拖 A→B(from/to 各 ref 或 selector):合成 pointer/mouse 按-移-放 + HTML5 拖放链(dragstart→dragover→drop→dragend,共享 DataTransfer);夹具 `primitives.html` #dragSrc→#dropZone | 2026-07-16 新增(单测 6/6:locatorToSelector ref→[data-web-ref]、from/to 未找到报错、drop/dragstart 触发;jsdom)。**bridge 真机 ✅**:`#dragSrc`→`#dropZone`→`#status=dropped:dragSrc`(共享 DataTransfer 把 payload 回环回来)。合成拖拽仍尽力而为,复杂 sortable/滑块库可能不吃 |
| ✅  | `file_upload`       | 给 `<input type=file>` 塞**自带内容**(content 文本 / content_base64 二进制 + filename,可 selector/mime):构造 File→DataTransfer→input.files→触发 change | 2026-07-16 新增(单测 6/6:b64ToBytes、无 input/非 file input/坏 base64 报错;input.files 赋值 jsdom 不支持)。**bridge 真机 ✅**:`file_upload{content:"hello world"}`→`#status=file:note.txt:11`+`files:1`(真 Chrome 的 input.files 赋值成功——正是 jsdom 测不到的那段)。MAIN world,无需 CDP/新权限 |
| ✅  | `handle_dialog`     | 预置弹窗自动应答防卡死:动作前先 `accept`(confirm→true/prompt→文本)/`dismiss`(confirm→false/prompt→null)/`disarm`;夹具 `primitives.html` #confirmBtn/#promptBtn | 2026-07-16 新增(单测 6/6:accept/dismiss/prompt_text/disarm + 日志累积;jsdom)。**bridge 真机 ✅**:arm accept→click #confirmBtn→`#status=confirm:true`**且 tab 不卡**;arm+prompt_text→click #promptBtn→`prompt:BridgeBot`。MAIN world 覆盖原生弹窗,不管 beforeunload/下载/basic-auth |

> ⚠️ shadow 穿透(2026-07-02)真机复测:`get_interactives` / `click` / `click_by_text` / `type_into` /
> `query_dom` / `wait_for_selector` / `get_html` ✅ 已过(shadow-dom.html:单层+嵌套可见可点、
> `blocked_by` 遮挡反馈、composed 遮挡检测无误杀;click_by_text 点「shadow按钮」→ s1-click 落 status)。
> `get_dom_outline` 的 shadow 穿透 2026-07-03 已补(F-31 ✅,`#shadow-root` 边界标注)。

### 审查 / 抽取

| ☐   | 工具                   | 测法                    | 结果 |
| --- | ---------------------- | ----------------------- | ---- |
| ✅  | `find_structured_data` | 页面 JSON-LD/结构化数据 | 2026-07-02 真机(SO 问题页):jsonld 抓到 WebSite+Organization(字段 `type`)、meta 6 键、feeds 1、microdata 6、state.jsonScripts |
| ✅  | `query_dom`            | CSS 选择器取文本/属性   | 2026-07-02 真机:`#scard` shadow 命中 count:1 + 样本,无 explore 会话;SO `div.answercell` count:26 提权后 tab_id 独立 |
| ☐   | `list_links`           | 取整页所有 `<a href>`(绝对 URL、去重、http(s) only、穿透 shadow;可选 selector 限容器 / same_origin 同源 / pattern 正则筛);返回 {url,text}[] + total/truncated。**crawl 的取链原语**(不做 crawl 工具:多页爬取由上层 agent 用 open_url+get_page_text+本工具编排)。定位同 get_html:url / tab_id / explore 会话 | 2026-07-16 新增(单测 10/10,extractLinks:绝对化/去重/同源/正则/selector 限域/limit+total/shadow 穿透/text 回退 aria-label→title;jsdom)。**真机待验**。设计见 [webcli.md](../webcli.md) §list_links |
| ✅  | `get_dom_outline`      | DOM 结构大纲            | 2026-07-02 真机(SO):30 节点结构大纲(tag#id.class + own-text),提权后普通模式可用;2026-07-03 F-31:补 shadow 穿透后 `#host1`→8 节点含 `#shadow-root` |
| ✅  | `get_a11y_tree`        | 无障碍树                | 2026-07-02 真机(SO):CDP AX 树 RootWebArea→banner→link 语义结构(字段 `outline`),nodeCount 生效 |
| ✅  | `find_in_dom`          | 值→稳选择器 + 列表单元  | 2026-07-03 真机:shadow「shadow可点卡片」→ div#scard;Trending「strix」→ span.text-normal + **unit article.Box-row ×17**(混淆 class 过滤、跨 shadow) |
| ✅  | `eval_js`              | 在页面跑一段 JS 返回值  | F-29 真机:读片段返回 form 数据;写片段(fetch POST / requestSubmit)被 detectWriteIntent 拦截、allow_write 逃生阀放行 |
| ✅  | `get_highlights`       | 划词助手高亮的 agent 读取(2026-07-04 新增,单测 3/3):先在两三个页面高亮几段 → 面板问「总结我的所有高亮」→ agent 调用返回按页分组数据;query/limit 各试一次 | ✅ 2026-07-04 用户真机 |
| ✅  | `capture_submission`   | 写请求安全捕获(arm/中和/disarm) | 2026-07-03 真机 E2E **14/14**(夹具 write-form.html):写(fetch POST / GraphQL mutation / 原生表单 POST=Document)=`neterror` 中和不发、页面未跳;读(GET / GraphQL query)=`sent` 放行;Cookie+x-csrf-token 脱敏、content-type 保留;body 三型(JSON/GraphQL/form)解析;附带捕到第三方埋点 POST(证明覆盖全 tab 写)。详见 browseract-comparison §3 |

### 网络

| ☐   | 工具              | 测法              | 结果 |
| --- | ----------------- | ----------------- | ---- |
| ✅  | `list_network`    | 列出某 tab 的请求 | 2026-07-02 真机(SO):8 endpoints,method/contentType/hasBody 齐全(SO heartbeat + 广告/consent XHR) |
| ✅  | `read_network`    | 读某请求的响应体  | 2026-07-02 真机:`url:"heartbeat"` matched 2、status 200、完整响应体 |
| ✅  | `find_in_network` | 按关键词找请求    | 2026-07-02 真机:搜 "sorted" 命中 1(广告请求 body 含页面上下文) |
| ✅  | `list_trace`      | 列出 trace        | 2026-07-02 真机:traceId/site=**stackoverflow**(siteFromHost 正确)/counts/endpoints/hint |

### 浏览器数据 / 市场

> 2026-07-06:书签/历史/阅读清单 5 个工具(`search_bookmarks`/`create_bookmark`/
> `search_history`/`list_reading_list`/`add_to_reading_list`)连同 `bookmarks`/
> `history`/`readingList` 权限一起移除(收窄安装提示),从本表删行;历史测试结果见
> git 历史。roadmap T4 有记录。

| ☐   | 工具                  | acc | 测法                  | 结果 |
| --- | --------------------- | --- | --------------------- | ---- |
| ✅  | `find_adapters`       | 🟢  | 搜市场 adapter        | 2026-07-02 真机:「知乎热榜」语义搜索精准命中 zhihu/hot        |
| ☐   | `install_adapter`     | 🔴  | 安装一个,已安装列表+1 |      |

## 2. Bridge 合成工具(15)

| ☐   | 工具                 | acc | 测法                                                                                               | 结果                                                |
| --- | -------------------- | --- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| ✅  | `load_adapter`       | 🟢  | 临时加载某 not-installed adapter,返回 args,随后可调                                                | 整个 sweep 的主力:ephemeral 加载→返回 args→随后可调 |
| ☐   | `contribute_adapter` | 🟢  | 对已装 adapter 生成预填 GitHub issue(源码+报错,label adapter-heal/broken)→ 返回 URL 供用户审阅提交 | H2-P4;不写站点,仅产出 URL                           |
| ✅  | `find_adapters`      | 🟢  | 见上(也走 generic)                                                                                 | 2026-07-02:「知乎热榜」→ zhihu/hot                  |
| ✅  | `explore_start`      | 🔴  | 开探索会话(开 tab)                                                                                 | 2026-07-02:F-29 + sweep 全程使用,返回 traceId/tabId |
| ✅  | `explore_stop`       | 🔴  | 关探索会话                                                                                         | 2026-07-02:stopped:true + traceId,tab 关闭          |
| ✅  | `list_workflows`     | 🟢  | 列工作流                                                                                           | 2026-07-02:返回真实工作流(name/description/steps)   |
| ☐   | `create_workflow`    | 🔴  | 建一个工作流,list 里出现                                                                           |                                                     |
| ✅  | `list_shortcuts`     | 🟢  | 列快捷方式                                                                                         | 2026-07-02:返回真实快捷方式(label/kind/text/tool)   |
| ☐   | `create_shortcut`    | 🔴  | 建一个,list 里出现                                                                                 |                                                     |
| ✅  | `list_memories`      | 🟢  | 列记忆                                                                                             | 2026-07-02:返回真实长期记忆(id/text)               |
| ☐   | `save_memory`        | 🔴  | 存一条,list 里出现                                                                                 |                                                     |
| ☐   | `delete_memory`      | 🔴  | 删一条                                                                                             |                                                     |
| ☐   | `notes`              | 🟡  | CRUD 笔记(create/list/search/get/update/delete);写动作受写闸,读始终可用                            | 不注入上下文,仅用户明确要求时读写                   |
| ☐   | `get_llm_config`     | 🟢  | 读 LLM 配置(**apiKey 必须 redacted 成 hasKey**)                                                    |                                                     |
| ☐   | `set_llm`            | 🔴  | 切模型/改 model(**不接受 apiKey**)                                                                 |                                                     |

## 3. 平台功能(单测覆盖不全,真机验证)

| ☐   | 功能                     | 测法                                                                                    | 结果                                                |
| --- | ------------------------ | --------------------------------------------------------------------------------------- | --------------------------------------------------- |
| ✅  | 并行 v3-1 同站点 tab 池  | bridge 并发 N 个同站点只读 → 完成时刻聚拢=并行(对照 docs/parallel-execution §11)        | zhihu×3:串行32s→池化并行12s(bridge,06-09)           |
| ✅  | 并行 v3-2 主循环并行只读 | 面板里让模型一回合发多个只读 → tool trace 同时在跑、总时长≈最慢单次                     | 面板 trace 同批折叠验证(06-09)                      |
| ☐   | 并行 v1/v2 子 agent 扇出 | 面板任务触发多个 spawn_subagent → 泳道并行、状态真实                                    |                                                     |
| ☐   | key-lock 同 tab 串行     | 并发对同一 generic tab_id 操作 → 串行不崩                                               |                                                     |
| ☐   | tab 池上限=5             | 同站点并发 >5 → 最多 5 个 tab,其余排队                                                  |                                                     |
| ☐   | **空闲 tab reaper**      | 跑完一个开了后台 tab 的任务 → 空闲后池开的 tab 被关、用户自己的 tab 留着                | E-7 任务主验(修复见 F-3)                            |
| ☐   | adapter 自动升级         | 面板开着时推一个 adapter 新版 → ~3 分钟内自动替换 + toast(docs/adapter-hot-plug §10.30) |                                                     |
| ☐   | 写确认 / auto mode       | 写操作弹确认;auto mode 开后跳过确认                                                     |                                                     |
| ☐   | 任务完成通知             | auto mode + 关面板 → 完成后系统通知,点开回到结果                                        |                                                     |
| ☐   | 计划模式                 | plan 模式:submit_plan 出审批卡 → 批准后执行;update_plan 更新清单                        |                                                     |
| ☐   | 记忆注入(面板)           | 存一条记忆 → 新会话里模型能体现(系统提示注入了 renderMemoryBlock)                       |                                                     |
| ✅  | 记忆(bridge)             | 外部 agent 不自动加载;需显式 `list_memories`(skill 已提示,见 §10 SKILL)                 | 设计确认不自动加载;SKILL 已加"先 list_memories"提示 |
| ☐   | 工作流执行               | create_workflow(带 {{N.field}}/for_each)→ run_workflow 跑通、模板替换正确               |                                                     |
| ☐   | 快捷方式                 | create_shortcut → 面板 / 输入展开正确(token 统一显示 /NAME)                             |                                                     |
| ⚠️  | SW keepalive / 恢复      | 长任务 + 关面板不中断;SW 回收后能恢复                                                   | bridge 在途 keepalive 已验(F-8);面板长任务+恢复待测 |
| ✅  | view_image 图片内联+引用(§10.24/§10.25) | 视觉槽配独立模型(如 qwen3.7-plus):① 看一张**站内/防盗链**图片(微博/新闻配图)→ 不再出现「Download multimodal file timed out」/GLM 1210;② **screenshot → view_image**:截图结果文本应显示 `[img_N]`,模型把 `img_N` 传给 view_image 后能正确描述截图(不再回声 [图片已省略]);③ 传过期/乱造的 img_99 → 工具报错并列出可用引用;④ 多模态主模型 inline 路径同样各试一张 | ✅ 2026-07-05 用户真机 E2E:screenshot→结果文本出 [img_1]→view_image(["img_1"])→qwen3.7-plus 正确描述,无 Download timed out(场景②③主链路;①防盗链图与④inline 未单独跑,同码路);辅证:bridge 真机截图 dataUrl 严格形状校验过 |

## 4. 本程新增功能(2026-06:agent 窗口 · H1 自愈 · H3 计划任务 · 笔记 · H2 MCP)

> 这批只过了单测 + typecheck + build,**真机逐项验证待跑**。触发方式见各行「测法」。
> agent 窗口 / 健康自愈 / 计划任务 / 笔记**只需面板**;MCP / 审计日志 / 禁写 / `contribute_adapter` **需起 bridge + 开外部接入**。

### agent 专用窗口 / 隔离

| ☐   | 功能              | 测法                                                                                                        | 结果 |
| --- | ----------------- | ----------------------------------------------------------------------------------------------------------- | ---- |
| ☐   | agent 专用窗口    | 面板或 bridge 跑一个会开 tab 的任务 → agent 的 tab 进**独立窗口**(不混进当前窗口);同任务多 tab 归同一 group |      |
| ☐   | 窗口存活 / 自愈   | 手动关掉 agent 窗口后再跑任务 → 自动新建,不报 `No window with id`                                           |      |
| ☐   | SW 重启后窗口跟踪 | 跑任务开窗 → 等 SW 空闲回收(~30s)→ 再跑 → 复用同一窗口、不泄漏出第二个空窗(storage.session 恢复)            |      |

### adapter 健康 + 自愈(H1)

| ☐   | 功能                          | 测法                                                                                                                                             | 结果 |
| --- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| ☐   | 健康监测 (P1)                 | 让某 adapter 连续失败(临时改坏选择器)→ Adapters 行出现健康徽标(degraded → broken,阈值 3;blocked/基础设施错不计)                                  |      |
| ☐   | 主动失效横幅 (P2c)            | adapter 跨入 broken 的那一刻 → 面板顶部一次性横幅(修复 / 报告)                                                                                   |      |
| ☐   | 一键就地修复 (P2a/b)          | 点「修复」→ 探索重录 → 装为本地覆盖(原 id、origin manual、免 sha 漂移)→ 健康清零                                                                 |      |
| ☐   | 修复标记 + 恢复市场版 (#1/#2) | 修复后 Adapters 行显示 healed 标记;点「恢复市场版本」→ 重装市场原版                                                                              |      |
| ☐   | 社区报告回流                  | broken 行/横幅「报告失效」+ healed 行「贡献修复」→ 预填 GitHub issue(label adapter-broken/heal,仅报错+源码、**不含**抓取数据);长源码走剪贴板回退 |      |

### 计划任务(H3-P1)

| ☐   | 功能             | 测法                                                                      | 结果 |
| --- | ---------------- | ------------------------------------------------------------------------- | ---- |
| ☐   | 新建 / 管理      | 计划任务页选工作流 + 节律(每天 HH:MM / 每隔 N 小时)→ 列表出现,可开关 / 删 |      |
| ☐   | 立即运行         | 点「立即」→ 工作流无头跑 → 结果存成一条 `[定时]` 笔记 + 上次状态更新      |      |
| ☐   | 定时触发(无面板) | 设每隔 1 分钟、关面板 → alarm 后台触发、笔记自动新增(证明无需面板)        |      |
| ☐   | alarm 跨 SW 存活 | 建任务后等 SW 回收 → syncAllAlarms 重注册,定时仍触发                      |      |

### 笔记 / 记忆导出

| ☐   | 功能            | 测法                                                                 | 结果 |
| --- | --------------- | -------------------------------------------------------------------- | ---- |
| ☐   | 笔记 CRUD(面板) | 我的笔记页 增 / 删 / 改 / 搜(关键词高亮);纯文本 Markdown(图片仅链接) |      |
| ☐   | 不注入上下文    | 存一条笔记 → 新会话模型**不会**自动知道(对照:记忆会注入)             |      |
| ☐   | 存为笔记        | 助手回复下「存为笔记」→ 该回复进笔记 + toast                         |      |
| ☐   | 多选导出        | 笔记 / 记忆页多选 → 导出下载 .md;复制 / 存为笔记后有 toast           |      |

### MCP 深度 / 外部接入信任(H2)

| ☐   | 功能                         | 测法                                                                                          | 结果 |
| --- | ---------------------------- | --------------------------------------------------------------------------------------------- | ---- |
| ☐   | MCP prompts                  | MCP 客户端 prompts/list → `author-adapter` / `find-or-load-adapter` / `summarize-tabs` 可取用 |      |
| ☐   | MCP resources                | resources/list → `web://server-info`(含定位 + 最省路径)、`web://adapters`(目录)       |      |
| ☐   | 外部调用审计日志 (P2a/H7-P1) | 外部 agent 调工具 → 外部接入页实时列出(工具/成功失败/写标记/时间,最新在上);关 SW 再开仍在     |      |
| ☐   | 按站点禁写 (P2b)             | 某站点加进禁写名单 → 即便全局写开关开着,该站点写操作仍被挡                                    |      |

### 人接手登录 / 验证(H9-P1)

| ☐   | 功能            | 测法                                                                                                                                                    | 结果 |
| --- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| ☐   | 卡住时人接管    | 手动模式让 agent 调一个会撞登录墙的 adapter(未登录的站点)→ 任务**暂停**、自动切到该标签页、面板弹「🔐 需要你接手登录/验证」卡(继续 / 回到标签页 / 放弃) |      |
| ☐   | 登录后重试      | 在该标签页登录后点「继续」→ 同一工具**自动重试一次**并成功(新 cookie 满足鉴权)                                                                          |      |
| ☐   | 放弃 / 超时     | 点「放弃」(或 5 分钟超时)→ 原 auth 错误回给模型,按错误正常往下走                                                                                        |      |
| ☐   | auto 模式不打扰 | auto mode 下撞登录墙 → **不**弹接管卡,直接把错误回给模型(无人值守语义,同写确认)                                                                         |      |

### 感知升级 / Set-of-Mark(H10-P1)

| ☐   | 功能               | 测法                                                                                                                                                 | 结果 |
| --- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| ☐   | occlusion 顶层过滤 | 在有弹窗 / 遮罩的页面调 `get_interactives` → 被盖住的按钮/链接**不出现**;弹窗内的元素正常返回                                                        |      |
| ☐   | 不误杀(fail-open)  | 普通无遮挡页面调用 → 元素数量与之前基本一致,可见元素不被误删;视口外元素(`only_in_viewport=false`)照常返回                                            |      |
| ☐   | SoM 高亮覆盖层     | `get_interactives` 传 `highlight=true` → 页面每个可交互元素出现彩色编号框(编号=ref)、不挡点击;再调 `screenshot` 得带框截图;下次调用 / 60s 后自动消失 |      |

### browseract 尾批 + F-34 合成挂起修复(2026-07-03,待验)

> ⚠️ ③a bridge 项必须**本地跑 bridge**(`node bridge/server.mjs`,不是 `npx …` —— submodule 改动未推,npx 拉到的是旧版),并 **reload 扩展** + **开着 SidePanel**(接手卡只在开着的面板渲染)。

| ☐   | 功能                     | 测法                                                                                                                                                                                             | 结果 |
| --- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| ☐   | F-34 合成不再挂起        | 探索一个站点(如 ProductHunt 分类分页,复现原 bug 的场景)→ 亲手 `eval_js` 调通提取 → `synthesize_adapter` → 能正常合成返回;若模型端 stall,≤180s 返回「合成超时…请用同一 name 重新调用」而非无限挂、且不再出现 `[已中断,无结果]` 幻觉 |      |
| ☐   | ③a bridge 请真人(开面板) | `node bridge/server.mjs` + reload + 开 SidePanel;`curl -s localhost:8787/command -d '{"tool":"await_user_action","args":{"objective":"请登录示例站","tab_id":<id>}}'` → 面板弹「🙋 需要你帮一步」卡 + 桌面通知 + curl **阻塞**;点「我已完成」→ curl 返回 `{"ok":true,"result":{"resumed":true}}` |      |
| ☐   | ③a 面板未开 fail-fast    | 关闭 SidePanel 后同一 curl → **立即**返回 `{"ok":false,"error":"…侧边栏没打开…"}`,不干等 5 分钟                                                                                                  |      |
| ☐   | ③a 跨会话不被丢          | bridge 触发的 takeover(会话 id=`bridge`)即便面板当前停在别的 chat 会话,卡片**照常显示**(原会话过滤会丢弃,现已放行)                                                                            |      |
| ☐   | ③b 自动检测续跑          | `await_user_action` 带 `wait_for_selector`(登录后才出现的选择器,如头像)+ `tab_id` → 在页面完成登录后 **无需点「我已完成」**,选择器一出现即自动续跑;卡片显示「✨ 完成后自动续跑」提示             |      |
| ☐   | ⑪ 冷读者自测             | explore 造一个 description 含糊 / 参数无 help 的 read adapter → 合成**通过后**返回里带「消费者冷读自检:规格可能不自足——…」;把 description/help 补清后用同名重合成 → 该警告消失                    |      |
| ☐   | ⑫ 薄壳 SKILL.md          | 装 / 更新 skill 后 `SKILL.md` 为 89 行薄壳(静态工具清单已移除);agent 按它**先跑 `/guide`** 拿 live 工具表 + 指令,`/guide?skill-version=2026-07-03` 显示 `upToDate:true`                          |      |

### 早前 pending 收尾:⑩ 经验笔记 + ④ confirmBeforeUse(2026-07-03)

| ☐   | 功能                        | 测法                                                                                                                                                                          | 结果 |
| --- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| ✅  | ⑩ 经验笔记读回(含 F-35 修) | SidePanel 让 agent `note_adapter_experience` zhihu__search → bridge 调 `zhihu__search {limit:99999}` 失败 → 错误尾部带「📝 该 adapter 的历史经验笔记」。**通过**(F-35 修复后) |  ✅ 2026-07-03 bridge 验 |
| ☐   | ④ confirmBeforeUse 生效     | SidePanel **auto 模式**下调一个已标 `confirmBeforeUse` 的 adapter(如 `twitter__delete`,先 load_adapter)→ **仍弹写确认卡**(普通 write 在 auto 下不弹)→ 点取消不会真删。⚠️ 需先等 marketplace 推送经 GitHub raw CDN 生效(~几分钟);bridge 路径不走此门,必须 SidePanel |      |

## 5. 本程新增功能(2026-07:页面菜单 · 与页面对话 · 多会话并行)

> 2026-07-04 用户真机过一轮:**全部通过 ✅**(含后续修的弹层位置/✕ 归位/模式化/会话条精简)。
> 设计文档:architecture.md §32 + multi-session.md。

### 🌐 页面菜单 + 引用卡

| ✅  | 功能               | 测法                                                                                                                            | 结果 |
| --- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ---- |
| ✅  | 上拉菜单 + 当前页头 | 开一个普通网页 → 点输入框下 🌐 → 上弹菜单,头部显示该页 favicon+标题+URL;点 backdrop 关闭                                          | ✅ 2026-07-04 用户真机 |
| ✅  | 不可读页置灰       | 活动页为 chrome:// 或新标签页 → 菜单头提示「仅支持 http/https」,两个菜单项 disabled                                                | ✅ 2026-07-04 用户真机 |
| ✅  | 总结此页面(锁 tab) | 点「总结此页面」→ 气泡显示短语「总结此页面」+ 下方引用卡(favicon/标题/URL);**点完立刻切走 tab**,总结的仍是原页(prompt 内嵌 tab_id) | ✅ 2026-07-04 用户真机 |
| ✅  | 引用卡点击         | 点引用卡 → 聚焦原 tab;关掉原 tab 再点 → 新开该 URL                                                                                | ✅ 2026-07-04 用户真机 |
| ✅  | 历史还原           | 总结跑完 → 历史会话里该轮气泡仍是短语+引用卡(非完整 prompt);历史列表 preview 显示「总结此页面」                                    | ✅ 2026-07-04 用户真机 |
| ✅  | favicon 回退       | 无 favicon 的站点(或加载失败)→ 引用卡显示主机名首字母 glyph                                                                       | ✅ 2026-07-04 用户真机 |

### 与页面对话

| ✅  | 功能             | 测法                                                                                                                             | 结果 |
| --- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---- |
| ✅  | 钉当前页 chip    | 菜单点「与页面对话」→ 输入框上方出现该页 chip(favicon+标题,可 ✕);placeholder 变「问关于这个页面…」                                  | ✅ 2026-07-04 用户真机 |
| ✅  | 多 tab 选择器    | 点「+ 标签页」→ 上弹 checkbox 列表(所有 http/https tab);勾选/取消同步 chips;「完成」收起                                            | ✅ 2026-07-04 用户真机 |
| ✅  | 首发注入读取指令 | 钉 2 个 tab 后提问 → 气泡=问题原文 + 2 张引用卡;agent 逐个调 `get_text_from_tab(format:"markdown")` 后基于内容回答                     | ✅ 2026-07-04 用户真机 |
| ✅  | 追问不重复注入   | 同组页面第二次提问 → 无引用卡、无重复读取指令,agent 直接用历史里的内容回答                                                            | ✅ 2026-07-04 用户真机 |
| ✅  | 改组重新注入     | ✕ 掉一个 chip 或加一个新 tab 再提问 → 重新出引用卡 + 读取指令                                                                         | ✅ 2026-07-04 用户真机 |
| ✅  | tab 已关回退     | 钉住的 tab 手动关掉再提问 → agent 改用 `get_page_text(url=…)` 重开抓取                                                                | ✅ 2026-07-04 用户真机 |

### 多会话并行(multi-session.md)

| ✅  | 功能               | 测法                                                                                                                                      | 结果 |
| --- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| ✅  | 新对话不打断       | 跑一个长任务 → 点「+ 新对话」→ 顶部出现会话条,旧会话脉冲点+开始时间;旧任务后台跑完 → toast「一个后台会话已完成」+ **它的 pill 消失**(无其他并行时整条消失——会话条只在真并行时存在)          | ✅ 2026-07-04 用户真机 |
| ✅  | 双会话并行         | 后台跑任务 A,再发任务 B → 两个都执行完、互不串消息;会话条随时点切,切换「不打断执行」                                                       | ✅ 2026-07-04 用户真机 |
| ✅  | 切换 = IDB 重载    | 切回运行中的会话 → 完整历史 + 后续实时流式续接;无重复 assistant 气泡(切换窗口去重)                                                          | ✅ 2026-07-04 用户真机 |
| ✅  | 后台写确认不丢     | 后台会话撞到写确认 → toast「后台会话在等你确认」+ 会话条「待输入」角标;切过去确认卡就在,批准后继续                                            | ✅ 2026-07-04 用户真机 |
| ✅  | 后台 plan 审批     | plan 模式会话切到后台 → 角标亮;切回来审批卡在(3s 重发保证);批准后执行                                                                      | ✅ 2026-07-04 用户真机 |
| ✅  | 并发上限 3         | 3 个会话在跑时再开第 4 个 → toast 拒绝                                                                                                       | ✅ 2026-07-04 用户真机 |
| ✅  | 面板重开发现后台   | bridge/计划任务驱动一个 run 时打开面板 → 会话条自动出现该会话                                                                                 | ✅ 2026-07-04 用户真机 |
| ✅  | 幽灵对账           | (难复现)SW 被杀后残留的运行中 pill ≤10s 内自动移除,不永远挂着                                                                                | ✅ 2026-07-04 用户真机 |
| ✅  | 删除后台会话       | 历史页删一个后台运行中的会话 → run 被中止、条目从会话条消失                                                                                   | ✅ 2026-07-04 用户真机 |

### 划词助手(selection-toolbar.md;2026-07-04,单测 17/17)

| ✅  | 功能               | 测法                                                                                                                                        | 结果 |
| --- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| ✅  | 开关即时生效       | 菜单 → 划词助手 → 开启;**不刷新**已打开的普通网页,选中一段文字 → 工具条浮出;关掉开关 → 同页选中不再弹                                        | ✅ 2026-07-04 用户真机 |
| ✅  | 翻译/解释/总结     | 选中英文段 → 翻译 → 浮层秒级出中文(复制/✕ 可用);解释、总结各试一次;未配 API Key 时给出指引文案                                              | ✅ 2026-07-04 用户真机 |
| ✅  | 高亮 + 持久化      | 选中一段(可跨粗体/链接边界)→ 高亮 → 黄底出现;**刷新页面**高亮自动恢复;点已有高亮 → 取消高亮/复制;再刷新确认已删                              | ✅ 2026-07-04 用户真机 |
| ✅  | 问一下             | 选中文字 → 问一下 → 侧边栏(未开则自动打开)输入框出现引用块(「…」+ 来源),补一句问题发送正常                                                  | ✅ 2026-07-04 用户真机 |
| ✅  | 黑名单             | 把某站加入黑名单(或「+ 当前站点」)→ 该站(含子域)选中不弹条,其他站正常;移出黑名单即恢复——全程无需刷新                                        | ✅ 2026-07-04 用户真机 |
| ✅  | Alt 触发模式       | 触发方式改「按住 Alt」→ 普通选中不弹;按住 Alt/⌥ 选中才弹                                                                                     | ✅ 2026-07-04 用户真机 |
| ✅  | 自定义动作         | 设置页加一个动作(如「改写:把选中文本改写得更简洁」)→ 工具条出现该按钮且可用;↑↓ 调序生效;删除后按钮消失                                        | ✅ 2026-07-04 用户真机 |
| ✅  | 编辑态不打扰       | 在 input/textarea/富文本编辑器里选中文字 → 不弹条(阅读态专用,编辑态留后)                                                                    | ✅ 2026-07-04 用户真机 |

### 划词助手二批+三批(拖拽/钉住/长度显隐/高亮管理二级页/图标化/agent 读高亮;2026-07-04 用户真机**全部通过 ✅**)

| ✅  | 功能               | 测法                                                                                                                                          | 结果 |
| --- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| ✅  | 浮层拖拽=自动钉住  | 翻译出结果 → 按住浮层标题栏拖到别处 → 跟手移动、松手停住,「钉住」自动变「已钉」                                                                  | ✅ 2026-07-04 用户真机 |
| ✅  | 钉住语义           | 已钉浮层:点页面别处/滚动/Esc 都**不关**,随页面内容一起滚动;✕ 才关;未钉浮层行为照旧(外点/滚动即关)                                              | ✅ 2026-07-04 用户真机 |
| ✅  | 多浮层对比         | 钉住一个翻译 → 另选一段再点解释 → 两个浮层并存;新动作只替换**未钉**的那个                                                                       | ✅ 2026-07-04 用户真机 |
| ✅  | 总结按长度显隐     | 选 <120 字 → 工具条**没有**总结按钮;选长段 → 出现;设置页把总结的「≥字数」改 0 → 短选区也显示                                                    | ✅ 2026-07-04 用户真机 |
| ✅  | 高亮管理(二级页)   | 划词助手设置页 →「高亮管理 ›」进子页(← 可返回):按页分组(标题/条数/时间),点标题打开原页且高亮已恢复;单条 ✕ 删除;整页「清空」                     | ✅ 2026-07-04 用户真机 |
| ✅  | 删除同步已开页     | 目标页开着 → 在面板列表删它的一条高亮 → **该页黄底立即消失**(不刷新);清空同理                                                                  | ✅ 2026-07-04 用户真机 |
| ✅  | 浮层按钮图标化     | 结果浮层头部为 📌/复制/✕ 三个图标(tooltip 齐全);复制后图标闪 ✓;钉住后图标变琥珀                                                               | ✅ 2026-07-04 用户真机 |
| ✅  | agent 读高亮       | 面板问「把我的所有高亮分类总结」→ agent 调 `get_highlights`(可加 query/limit)→ 按页分组的高亮进上下文,总结合理引用原文                          | ✅ 2026-07-04 用户真机 |

### adapters-first 确定性化 + 目录收窄 + run-tab 回收(2026-07-10,单测过、真机待验)

| ☐   | 功能                   | 测法                                                                                                                                              | 结果 |
| --- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| ☐   | 开局适配器提示         | 面板发「帮我看看知乎热榜」(zhihu 未加载)→ 首轮 system prompt 的「运行环境提示」含「适配器提示」列出 zhihu 命中 + load_adapter 指引;agent 第一步就 load 而非 open_url 硬抓 | |
| ☐   | open_url 即时提示      | 强行让 agent 用通用工具开一个有适配器且未加载的站点 → open_url 结果带 `adapter_hint`,agent 随后切换到 find_adapters/load_adapter;同 origin+site 第二次不再提示 | |
| ☐   | find_adapters 中文命中 | `/command` 或对话触发 find_adapters("微博热搜") → weibo 相关排最前,status 字段区分已加载/未加载                                                       | |
| ☐   | 目录收窄 + digest      | 加载/安装 >40 个工具后发一个不点名站点的任务 → 请求体 tools 只有 generic+active,system prompt 出现「未展开的站点适配器」digest;按 digest 直接调用隐藏工具能执行 | |
| ☐   | 收窄不丢工具           | 任务点名「小红书」(中文别名)→ xiaohongshu 工具全展开;下一轮发「继续」→ 仍展开(active sites)                                                          | |
| ☐   | run-tab 自动回收       | 让 agent open_url 开 2-3 个后台页完成任务 → 任务结束(正常/报错/中止)后这些 tab 自动关;checkpoint(「继续」暂存)不关                                     | |
| ☐   | 展示页延迟回收(§10.38补丁) | 「打开看看」(active:true)→ 任务结束 tab **保留**给用户看;**下一条指令**的任务结束后该 tab 自动关;若用户正盯着它(focused 窗口的 active tab)则再豁免一轮 | |
| ☐   | adapter_hint 触发      | 无 zhihu adapter 加载时让 agent 打开/读取知乎页 → open_url **和** get_text_from_tab 结果都带 `adapter_hint`(修复了 active 打开 url 为空不触发的 bug)      | |

## 6. chrome-devtools-mcp 借鉴批(2026-07-29,`feat/webcli-devtools-borrows`)

设计见 [webcli.md](../webcli.md) §14 与 [devtools-mcp-comparison.md](../devtools-mcp-comparison.md) §6。
离线单测 29 例(`tests/devtools-borrows.test.ts`)+ **真机 18/18 全过**(经 `webcli-dev` bridge 9377
驱动,新夹具 `fill-form.html` / `webmcp.html` / `tall.html`)。真机跑出 4 个问题,已修并复验:
[F-42](./findings.md)(source 未透传)、[F-43](./findings.md)(submit 对 contenteditable 静默失效)、
[F-44](./findings.md)(jpeg guidance 是错的)、[F-45](./findings.md)(夹具 setInterval 假阴性)。

| 结果 | 项 | 测法 | 结论 |
| --- | --- | --- | --- |
| ✅ | `screenshot` format/quality | 同页三种编码比 `bytes`,查 dataUrl 前缀 | 夹具 UI 页 png 141KB / **jpeg 157KB(更大!)** / webp 63KB;图文页 985/574/357KB。mime 跟着 format 变。**→ F-44 改了三处 guidance** |
| ✅ | `screenshot` max_width | 宽屏页 `max_width:800` | `image_size={800,407}`、23KB;不传时无 `image_size`。图文页 jpeg+mw1024 = 134KB(对 985KB png 是 7×) |
| ✅ | `screenshot` 长页 + 有损 + 缩放 | 造 `tall.html`(21120px)跑 `full_page` × {png,webp} × {原尺寸, max_width:640};**零依赖 Node PNG 解码**逐行扫输出 | 分块拼接触发(21120 > CHUNK 12000);**无任何全透明行**、接缝 y=6000 前后 3 行均为正常彩色行、黑哨兵**恰好两条** `[0,29]`+`[10530,10559]`(画错 y 会在中间复制出 TOP 哨兵)。缩放路径 1280×21120 → 640×10560 正确 |
| ✅ | `screenshot` 非法 format | `format:"gif"` | `unsupported format "gif" — use one of: png, jpeg, webp`,不静默回退 |
| ✅ | `fill_form` 文本批量 | 7 字段一次(ref+selector 混用) | `filled=7/7`;`#status` 逐字段 `input`+`change` 都触发了(app 的 handler 真跑到) |
| ✅ | `fill_form` select/checkbox/radio | select 分别按 **可见文字**("Japan"→`jp`)和 **option value**(`cn`)各测;checkbox `"true"`/`"false"`;radio | 四级匹配的前两级都命中;checkbox/radio `final_value` 与 `#status` 一致 |
| ✅ | `fill_form` React 受控框 | `#tracked` 装了 React 式 own-property value setter | `#status` = `tracked:input=tracked-value:bypassed-tracker` —— **走的是原型 setter,绕过了 tracker,`input` 事件仍带新值**。§14.2 的说法真验到了 |
| ✅ | `fill_form` 部分失败 | 6 字段里塞一个 `rDEAD` | `filled=5/6`,只有那条 `ok:false, error:"element not found"`,其余照填,顶层带 `hint` |
| ✅ | `fill_form` iframe | 子帧 ref `f1622r2` | `filled=1/1`,`final_value` 从帧内读回正确;每帧一次注入 |
| ✅ | `fill_form` submit | 末字段为 contenteditable + `submit:true` | **初次静默失效(F-43)**;改 `closest('form')` 后复验 `#status` 出现 `form:submitted` |
| ✅ | `wait_for_selector {text}` | 已有文字 / 大小写不敏感 / 超时 | 3ms 命中、`matched.text` 回显;`"name=carol"` 匹配到页面上的 `name=Carol`;超时给的是**文字版 hint** |
| ✅ | `wait_for_selector` 互斥 | 都不传 / 都传 | `provide either selector … or text` / `pass only one of selector and text` |
| ✅ | `wait_for_selector` selector 回归 | `#country` | 1ms 命中,`matched.selector` 回显 |
| ✅ | 工具档位 core | popup 切 "Core only" | daemon `/tools` = **恰好 13 个**,正是 `CORE_TOOLS`;`hover`/`query_dom`/`list_webmcp_tools` 确认不在目录里 |
| ✅ | 隐藏≠禁用(**核心断言**) | core 档下直接调三个被隐藏的工具 | `hover`/`query_dom`/`list_webmcp_tools` **全部 ok**;对照:真不存在的 `no_such_tool` 仍 `tool not found`(过滤没退化成放行一切) |
| ✅ | 工具档位热切换 | 连着 daemon 时改档 | **不重连**即从 28 → 13(`refreshCatalog`)。⚠️ 初版这个键**没有任何 UI 可达**,只能去 SW 控制台敲——已给 popup 加下拉,数字由 SW 从活注册表报回 |
| ✅ | `list_webmcp_tools` 空页 | example.com | `supported:false api_present:false probed:['navigator.modelContext']` + "正常情况"的 hint,不报错。**顺带确认此 Chrome 无原生 `navigator.modelContext`** |
| ✅ | `list_webmcp_tools` 有工具 | 夹具 `webmcp.html`(无原生 API 时只在本页装 shim,`#status` 如实报 `impl=shim`) | 列出 `echo`/`add_item` + inputSchema;`source=navigator.modelContext.listTools`(**初次为 undefined,F-42**) |
| ✅ | `call_webmcp_tool` | `echo` / `add_item` / 错名 / 非对象 input | `{status:'success',output:{...},called:'execute'}`;`add_item` **真副作用**:页面列表多一条 + `#status` 出 `added:from-agent`;错名列出可用名;`[1,2]` 报"必须是 JSON 对象" |
| ✅ | WebMCP MAIN world | 夹具 shim 定义在页面 MAIN world | 能读到 = 证明 `world:'MAIN'` 生效(ISOLATED 有自己的 navigator,看不到),同时 `call` 也在同一世界里执行 |

⚠️ **未覆盖**:`fill_form` 在**真实 React 站**上的端到端(夹具只模拟了 value tracker,没验完整
受控组件的 state→re-render 回路);拼接失败降级支路(`cap_note`)未触发(需要 canvas OOM);
原生 WebMCP(浏览器还没有)。


### 6b. Web-app relay(2026-07-30,§15;夹具 `relay-client.html`)

真机 4/4 过(webcli-dev,popup 添加 `http://localhost:8123` 后经 bridge 驱动)。
跑出一个真发现:**`ready` 帧竞态是实测存在的** —— 主链路那一跑里 `relay-ready` 从未出现
(document_start 的 postMessage 在页面监听器挂上前就派发了),是 DOM 标记
`<html data-webcli-relay>` 启动了流程 → 协议文档以标记为首选检测,`ready` 只是尽力而为(F-46)。

| 结果 | 项 | 测法 | 结论 |
| --- | --- | --- | --- |
| ✅ | 端到端 roundtrip | popup 加 `localhost:8123` → 开 `relay-client.html` | `marker:hjdccc init:webcli-dev tools:28 call:ok`(list_tabs 真调通) |
| ✅ | 错 host = 不注入 | 同页经 `127.0.0.1:8123` 开 | `marker:none no-relay` —— pattern 按 host 圈定,没注入 |
| ✅ | 错端口 = 注入但服务拒 | 起 8124 второй server,开 `localhost:8124` 同页 | `marker:hjdccc fail:initialize timed out` —— 中继在(host 匹配),SW 按**精确 origin** 拒。两层门的两半分别验到,且靠 marker 与上一行可区分 |
| ✅ | popup 添加源生效 | 用户在 popup 输 `localhost:8123` → Add → 无需任何 reload,新开页面即注入 | storage.onChanged → registerContentScripts 热生效 |
| ☐ | 移除源 | popup ✕ 删除 → 刷新夹具页 → `marker:none no-relay` | 与添加同一条码路(reconcile 的 unregister 支),未单独真机跑 |
| ✅* | SW 冷启动缓冲 | 单测钉死(tests/web-origins.test.ts:帧缓冲、fail-closed、空表拒);真机上 WS 心跳(20s)让 SW 常温,冷启动路径日常难以触发 | \*离线验证;真机复现需停 daemon+等回收,未跑 |

## 7. localmd Connect shell (2026-08-06, real machine)

First real-machine pass of the third shell (docs/localmd-connect.md), driven via
`BRIDGE_PORT=9378 node webcli-bridge/server.mjs` + `/command`, unpacked
`dist-localmd/` (id `enodecpmlecfpmofogpmbagdcfheamgf` at the time — since
2026-08-18 that key is the DEV one and belongs to `dist-localmd-dev/`, while a
shipping build takes the published `bgennb…`), "Allow user scripts" ON.

| ☐   | item                            | how                                                                                        | result                                                                                                                                                                                                 |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ✅  | WS bridge connect               | daemon `/status`                                                                           | `client:localmd-connect tools:36` (redial alarm picked it up ≤1min after daemon start)                                                                                                                 |
| ✅  | generic path                    | `fetch_url {url, format:"markdown"}` example.com                                           | markdown extracted, headers/cookies flags intact                                                                                                                                                       |
| ✅  | `find_adapters`                 | query "hackernews"                                                                         | rows ranked; `status` shows the run_adapter-oriented wording — the last-write-wins re-registration works on-device                                                                                     |
| ✅  | `run_adapter` pipeline          | hackernews/top, limit 3                                                                    | first call `loaded:true` + `args_spec`, real rows; second call skips loading (no `loaded` field); `args` accepted as object AND JSON string                                                            |
| ✅  | direct call after load          | `hackernews__top {limit:1}`                                                                | executes via the shell executor's site path                                                                                                                                                            |
| ✅  | schema-bearing arg error        | arxiv/search without `query`                                                               | error embeds full arg schema (`query` required + help text) → corrected call succeeded                                                                                                                 |
| ✅  | `run_adapter` func path         | arxiv/search {query, limit:3}                                                              | THE high-risk chain in one pass: ephemeral sandbox eval → site pool tab (grouped under "localmd Connect") → `configureWebWorld` + userscript-runner inject → `onUserScriptConnect` port → results back |
| ✅  | bad `args` string               | `args:"not json"`                                                                          | clear "must be a JSON object" error, nothing executed                                                                                                                                                  |
| ✅  | `preview_site_script`           | fixture `interactive.html`, hide `#card` + `dry_run_js`                                    | `css_preview {matched:1, injected:true}`; dry-run in USER_SCRIPT world returned computed `display:"none"` — transient injection proven by readback                                                     |
| ✅  | `create_site_script` → persists | hide-only, matches `http://localhost/*`                                                    | saved + registered (`runnable:true`); FRESH page load has `#card` at `display:none` with no preview involved                                                                                           |
| ✅  | `set_site_script_enabled false` | then fresh load                                                                            | `#card` back to `inline-block` (unregistered on disable)                                                                                                                                               |
| ✅  | `delete_site_script`            | then `list_site_scripts`                                                                   | list empty; popup Site scripts section empty                                                                                                                                                           |
| ✅  | popup                           | eyeballed by user                                                                          | green "Ready for localmd.app", Tools 36, seeded `https://localmd.app` present, user-added origins listed                                                                                               |
| ✅  | relay end-to-end                | fixture `relay-client.html?marker=localmdConnect` (origin `localhost:8123` added in popup) | `marker:enodec init:localmd-connect tools:36 call:ok` — marker detect → initialize (instructions delivered) → 36-tool list → real `tools/call`                                                         |
| ✅  | relay negative (host gate)      | same page via `http://127.0.0.1:8123`                                                      | `marker:none no-relay` — host-scoped injection layer holds                                                                                                                                             |
| ☐   | dual-shell coexistence          | `?marker=webcliRelay` on the same page                                                     | `marker:none` — the user's store WebCLI has no `localhost:8123` origin, so only one relay was present; add it there to exercise both markers + targeted-frame-executes-once                            |
| ✅  | tab hygiene                     | close_tab sweep after each stage                                                           | all test tabs closed; no janitor exists by design (WebCLI contract)                                                                                                                                    |

Fixture change: `relay-client.html` now takes `?marker=webcliRelay|localmdConnect`
and adopts the marker value as the targeted `ext` id from the start (with two
shells sharing the envelope, untargeted frames are no longer acceptable —
fixtures/README.md updated).

### 7b. localmd Connect ↔ localmd.app end-to-end (2026-08-06)

localmd's client side landed (marker `localmdConnect`, catalog entry replacing
the webcli row, `connectGuard.ts` implementing the confirm contract). Driven
from this side through the bridge on 9378, against localmd's dev server on
`http://localhost:5173` with deepseek-v4-flash as its model.

| ☐   | item                              | result                                                                                                                                                                                                                                                                                           |
| --- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ✅  | relay marker on localmd's page    | `data-localmd-connect = enodec…`; `data-webcli-relay` null — the two shells do not collide                                                                                                                                                                                                       |
| ✅  | localmd connects                  | Settings → Tools: "Connected — localmd Connect is answering this site", extension id shown, **36 TOOLS** listed                                                                                                                                                                                  |
| ✅  | licence gate                      | paid-tier row connects (gate passes for a licensed install)                                                                                                                                                                                                                                      |
| ✅  | read adapter, one turn            | `enable 2 tool(s)` (36 tools trip localmd's defer threshold, as designed) → `find_adapters{"hacker news top stories"}` 1.7s → `run_adapter{site,name,args}` 11s → real HN rows. The agent passed `args` as a **JSON string** — the string/object tolerance in run_adapter is what made that work |
| ✅  | write adapter — prompt-layer gate | asked for a v2ex check-in: the agent read `access:write` off find_adapters and asked in prose BEFORE calling anything                                                                                                                                                                            |
| ✅  | write adapter — code-layer gate   | on "确认", it called `run_adapter{v2ex/daily}` → connectGuard held the call and rendered the confirm card ("This marketplace adapter has write access… runs once, only if you confirm") → **Skip** → not executed, and the agent explicitly refused to retry the write                           |
| ✅  | site script, full loop            | agent's own path: `open_url` → `query_dom` (element exists) → `preview_site_script{highlight}` (matched 1) → `create_site_script` → confirm card → **Confirm** → a FRESH page load has `#card` at `display:none` with the injected `#card{display:none!important}` present                       |
| ✅  | cleanup                           | script deleted, list empty, test tabs closed                                                                                                                                                                                                                                                     |
| ☐   | popup "Site adapters" list        | added after this pass; the tools refuse `chrome-extension://` URLs by design, so the rendering needs a human eyeball — the data path (`searchableCorpus` + `rankAdapters`) is the one proven above                                                                                               |

Two bugs fell out of this pass, both pre-existing and both in ALL three shells:
[F-47](./findings.md) (`manage_tabs` returned errors as values, so a failed call
looked like `ok:true` — it made a working site script look broken) and
[F-48](./findings.md) (the cockpit badge told every shell's users that "Web
Agent" was driving). Both fixed and re-verified on the real browser: `reload`
with `tab_id` now actually reloads and a missing arg comes back `ok:false`; the
badge reads "🤖 localmd Connect is working".

### 7c. localmd Connect — the dev/store split, verified on the dev build (2026-08-07)

After the shipping build lost its daemon and its editable origin list
([localmd-connect.md](../localmd-connect.md) §12), `dist-localmd-dev/` was
loaded unpacked (replacing the store-shaped build — same id until publish) with
"Allow user scripts" on, and driven through the bridge on 9378.

| ☐   | item                              | result                                                                                                                                                                                                                          |
| --- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ✅  | dev build identity                | daemon `/status` reports `client: localmd-connect-dev`, 36 tools; manifest name `localmd Connect (dev) - Browser Superpowers`, 10 permissions incl. `alarms`, id `enodec…`                                                      |
| ✅  | dev-only origin                   | `http://localhost:8123` (the fixture server) carries `data-localmd-connect` — the store build allows only localmd.app, so this row is what proves the two builds differ                                                         |
| ✅  | localmd origin                    | `http://localhost:5173` carries the marker too                                                                                                                                                                                  |
| ✅  | own tab group                     | agent tabs land in `localmd Connect (dev)`, beside the older `localmd Connect` group — per-shell titles keep each shell's orphan reaper off the other's windows                                                                 |
| ✅  | F-47 fix present                  | `manage_tabs {action:"reload", tab_id}` → `reloaded:1` and a planted DOM probe is gone                                                                                                                                          |
| ✅  | F-48 fix, the strong form         | the cockpit badge reads **"🤖 localmd Connect (dev) is working"** — it tracks the manifest name, which a hardcoded string could not do. The dev build's `(dev)` suffix is what makes this a real test rather than a coincidence |
| ✅  | adapters unbroken by the refactor | `run_adapter{hackernews/top, limit:2}` loaded on demand and returned real rows                                                                                                                                                  |
| ✅  | site scripts unbroken             | `list_site_scripts` → `runnable:true`, empty list                                                                                                                                                                               |
| ✅  | popup                             | user-confirmed: Site adapters + Site scripts only, plus the dev-only CLI disclosure. The Web app access section is gone                                                                                                         |

Not covered here, and deliberately: the SHIPPING build's behaviour. A
localmd-dev build proves nothing about `dist-localmd/` — it carries an extra
transport and two extra origins — so the release checklist requires smoke-testing
the real artifact, driven from localmd.app itself since it has no daemon
([localmd-connect-releases.md](../localmd-connect-releases.md) §4 step 5).

### 7d. The knowledge-base capture round (2026-09-03/04, dev build + daemon 9378)

The capture chain (docs/localmd-connect.md §14) and the six bugs it took to make
it work: [F-58](./findings.md) … [F-63](./findings.md). Driven from this side
through `BRIDGE_PORT=9378`, unpacked `dist-localmd-dev/` (id `enodec…`), against
localmd's dev server on `localhost:5173` and the fixtures on `localhost:8123`.
Surface: **55 tools** (was 51 — `list_saved_pages`, `sync_saved_pages`,
`sync_kb_folders`, `get_kb_folders`).

**Read the result column as evidence, not as a claim.** Where a row says a
number, that number was measured on the machine; where it says ☐, the code is
written and tested offline and nobody has watched it work.

| ☐   | item                                | how                                                                       | result                                                                                                                                                                                                 |
| --- | ----------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ✅  | relay marker, the bug               | `query_dom html` on both localmd tabs                                     | `data-localmd-connect="undefined"` — the string, on production AND dev tabs. One query named F-58 after two rounds of reasoning had not                                                                |
| ✅  | relay marker, after the fix         | same query after reload                                                   | `enodecpmlecfpmofogpmbagdcfheamgf` on both                                                                                                                                                              |
| ✅  | tool surface                        | daemon `/status` + `/tools`                                               | `client:localmd-connect-dev tools:55`, all names present                                                                                                                                                |
| ✅  | localmd sees the shell              | Settings → Tools → the Connect row                                        | "Connected — localmd Connect is answering this site", extension id shown, 51 tools at the time                                                                                                          |
| ✅  | inbox size, the bug                 | `list_inbox {limit:10}` with 8 items queued                               | **28.6 MB** in one reply: two full-page PNGs at 8.8 MB, one at 7.9 MB, a clip at 2.9 MB, two asks at 232 B. Frame ceiling is 16 MB → truncated to non-JSON → read as an empty inbox (F-59)             |
| ✅  | the queue drains                    | after the fix, `list_inbox {summary:true}`                                | `pending 0`; the notes and images are on disk under `raw/` with matching timestamps                                                                                                                     |
| ✅  | full-page capture is WebP           | `ls -l raw/images/`                                                       | `…kciter.so.webp` **1.3 MB** beside the two PNG captures of the same page at **5.9 MB / 6.6 MB** — the codec change is what keeps a batch inside one frame                                              |
| ✅  | clip images, the bug                | `md5` over the 20 files of one Zhihu clip                                 | all distinct (not duplicates), all written INTO `raw/articles/` beside the note, and the note referenced them by a name with spaces and parentheses — `marked.parse` renders that as text, not an image |
| ✅  | swatch geometry, the bug            | probe: `getBoundingClientRect()` on each swatch in the open shadow root   | **18×12**, radius 7px. `.bar button { all: unset }` erased the swatch's own width and height (F-63); the 6 px gaps between them belonged to nothing, which is why some colours "did nothing"           |
| ✅  | swatch geometry, after the fix      | same probe                                                                | **16×16** ×5, radius 50%, gaps 6 px, `elementFromPoint` in the middle of a gap returns `swatch`; all five colours close the bar and write their colour                                                  |
| ✅  | mark bar contents                   | probe: buttons in the bar over an existing highlight                      | `Note \| Ask localmd \| Remove`; the hover note is suppressed while the bar is up                                                                                                                       |
| ✅  | a content-script change needs F5    | after reloading the extension, the old behaviour persisted in an open tab | the re-entry guard (F-57) makes re-injection a no-op, so a tab keeps the PREVIOUS script until the page reloads. Reloading the extension is not enough — this cost a round of "it is still wrong"       |
| ✅  | image zoom (localmd side)           | user-confirmed on a full-page screenshot                                  | fit on arrival, zoom to read; fit is allowed below the 10% manual floor because a 12000 px page fits at ~6%                                                                                             |
| ✅  | settings page opens                 | seen in the tab list at `chrome-extension://…/src/localmd-connect/options.html` | the manifest path is the only one that exists — `getURL('options.html')` was a URL that never existed and opened a blank tab with no error anywhere (F-62)                                        |
| ☐   | KB index revalidation               | delete a clipped note in localmd, then open the popup on that page        | fixed after the popup was seen claiming a page was saved at a deleted path (F-61). `list_saved_pages` / `sync_saved_pages` and the delete/rename hook are unit-tested only                              |
| ☐   | naming the KB / switching it        | popup's folder row; pick another folder                                   | `sync_kb_folders` + the `open-kb` notification are unit-tested on both sides; the round trip has not been watched                                                                                       |
| ☐   | annotations list + jump             | popup chip → a passage → the page scrolls to the mark                     | the in-page half was probed (focus request consumed, WAAPI flash); the list itself and the `?page=…#annotations` deep link have not been opened by hand                                                 |
| ☐   | a clip's images after the fix       | clip a picture-heavy page again                                           | `raw/images/` + encoded relative destinations are pinned by `clipWrite.test.ts`; no real clip has been made since                                                                                       |
| ☐   | popup / settings, eyeballed         | the redesigned popup and the two-pane settings page                       | the tools refuse `chrome-extension://` URLs, so these need a human. Both are covered by tests that LOAD THE REAL HTML AND RUN THE REAL SCRIPT (F-56's lesson), which is not the same as looking at them |

**The methodology that did the work, twice.** Both times the bug had survived a
round of reading the code, and both times one measurement ended it: the relay's
marker attribute (a string, `"undefined"`) and the swatch's bounding box
(`18x12`). The probe pattern is worth reusing — `preview_site_script
{dry_run_js}` runs in the USER_SCRIPT world, the page-tools shadow root is
`mode:'open'`, so a script can build a selection, raise the toolbar, measure any
element in it, click every control in turn and report. See findings F-58 and
F-63 for the two scripts.

### 7e. Translate / Explain on the selection bar — the reverse LLM channel (2026-09-04, dev build + daemon 9378)

The extension asking localmd instead of holding a key of its own
(docs/localmd-connect.md §14.4o), and the id-space bug that came with opening
the second direction ([F-64](./findings.md)). Same rig as §7d. Surface
unchanged: **55 tools** — a quick action is not a tool, it is a message from the
page's own bar.

Same reading rule as §7d: a number is something that was measured, ☐ is code
that is written and tested offline and that nobody has watched work.

| ☐   | item                                     | how                                                                                              | result                                                                                                                                                            |
| --- | ---------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ✅  | localmd answers `sampling/createMessage` | posted an extension-shaped frame into the dev app from the USER_SCRIPT world (`preview_site_script {dry_run_js}`) | `{"role":"assistant","content":{"type":"text","text":"The weather is very nice today."},"model":"deepseek-v4-flash","stopReason":"endTurn"}` — a real completion, in the MCP result shape |
| ✅  | an unsupported method fails loudly       | same probe, `method:"roots/list"`                                                                | `-32603 roots/list is not supported` — an error, not silence, so the popover can say something                                                                     |
| ✅  | the reply-echo bug is real               | watched both directions for our id on the PRE-FIX build                                          | the extension posted `-32600 not a valid JSON-RPC 2.0 request` back, stamped with our own id — the collision F-64 removes                                          |
| ✅  | a reply never resolves the wrong call    | unit (`tests/external-mcp-notify.test.ts`, `localmd/src/lib/connectRelay.test.ts`)                | server ids are strings; an incoming request with id 1 leaves a pending call with id 1 alone                                                                        |
| ✅  | the wake-and-retry                       | unit (`tests/localmd-ask-model.test.ts`)                                                          | no-client → open the app → ask again; a "no model configured" failure is NOT retried                                                                               |
| ✅  | the bar shows Translate / Explain        | user, real browser, after an extension reload **and a page refresh** (F-63: a reload does not replace a live content script) | works                                                                                                                                                             |
| ✅  | the answer popover                       | user, real browser                                                                               | works                                                                                                                                                             |
| ✅  | one build asks its OWN app               | unit (`tests/external-mcp-notify.test.ts`)                                                       | with the dev app and the published app both connected, the request goes to the dev one — recency does not decide it                                               |
| ✅  | dragging the popover                     | user, real browser: dragged it off the passage, clicked the article, then Esc                    | stays where it was put, survives the click, closes on Esc                                                                                                         |
| ✅  | the relay survives an extension reload   | `ping` posted into a localmd.app tab that had been open across the reload                        | answered — the service worker's re-injection works; what does NOT come back on its own is the app's MCP row ([F-65](./findings.md))                                |
| ✅  | a background tab heals without focus     | posted `{closed:true}` into the dev app (what a reload produces), then `{ready:true}`            | after closed: nothing sent; after ready: `initialize, notifications/initialized, tools/list, tools/call ×2` — no focus, no click, no reload                        |
| ✅  | the whole thing after a real reload      | user, real browser: reloaded the extension, refreshed a page, pressed Translate WITHOUT touching the localmd tab | works — the state F-65 was reported from                                                                                                                          |
| ☐   | the background wake, end to end          | close every localmd tab, then press Translate                                                    | —                                                                                                                                                                 |
| ☐   | no model configured                      | a localmd profile with no primary                                                                | the popover should read like advice, not like a stack trace                                                                                                       |

### 7f. Prompts + the settings page (2026-09-05, dev build + daemon 9378)

The toolbar's asks became the user's (docs/localmd-connect.md §14.4p). The
settings page was checked by SERVING IT: the built `dist-localmd-dev` bundle
over `localhost:8124` with a stubbed `chrome` global, opened through the daemon
and screenshotted. jsdom cannot answer a layout question — every box there is
the right size because no box has a size — and all three defects below were
found by looking.

| ☐   | item                                   | how                                                    | result                                                                                                                    |
| --- | -------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| ✅  | the settings page renders and drives    | served the real bundle with a stubbed chrome, screenshot | nav + pane centred as one block; the list, the editor and the help panel lay out as intended                                |
| ✅  | the "Answer in" field                   | same                                                     | was stretching to the full pane for a one-word value (`flex: 1 1 220px`) → capped at 260px                                  |
| ✅  | the quick-ask rows                      | same                                                     | the prompt preview was pushed against the buttons, a gulf from the name it belongs to → the PREVIEW takes the free space now |
| ✅  | the blacklist rows                      | same                                                     | rendering as bare text + a default browser button — class `.script`, which has no CSS anywhere on the page → `.item`         |
| ✅  | the editor and its help                 | clicked Edit through the daemon, screenshot              | two columns, the variables explained beside the box rather than behind a link                                              |
| ✅  | the colour picker + toolbar switch      | same                                                     | both settings existed in the model and nowhere in the UI; the picker shows the colours themselves                          |
| ✅  | the template rules                      | unit (`tests/selection-prompt.test.ts`)                  | append-in-triple-quotes when `${content}` is absent; `${input}` alias; lang filled before content, so a passage cannot inject |
| ✅  | the editor's behaviour                  | unit (`tests/localmd-options.test.ts`, jsdom)            | add / edit in place / delete / restore defaults / switch one off and keep it / half an entry refuses to save                 |
| ✅  | the toolbar itself                      | user, real browser, across the round                                             | wand + menu (Translate / Explain / Ask…), the two entries apart, icons only |
| ☐   | a custom prompt end to end              | write one in Settings, then use it on a page             | —                                                                                                                          |
| ☐   | the toolbar switch on a real page       | switch it off; select text; check highlights still come back | —                                                                                                                      |
| ✅  | the settings list follows a page        | user, real browser: highlighted while Settings was open                          | it appears without a reload, and a note being typed is not thrown away |
| ✅  | the quick-ask glyph                     | rendered the real UI_CSS + the real icon strings on a served page, at 1× and 3× | the wand-plus-crosses first attempt read as two plus signs at 16px → one four-point star            |
| ✅  | the swatches vs. the blacklist box      | same, with the box focused                                                       | the input's focus ring (2px, offset 2px) overlapped the colour circles → `.field + input` spacing   |
| ✅  | the sidebar marks                        | same                                                                             | localmd Connect's mark at the top, localmd's beside the app link                                    |
| ☐   | the open-ended ask on a page             | pick "Ask…", type a question, read the answer                                    | — needs a reload                                                                                    |
| ✅  | the scan overlay + the panel's quote    | rendered the real UI_CSS over a real paragraph, boxes built from `getClientRects` as the script builds them | one box per line of the passage, the sweep inside it, the quote line under the title in both states |
| ✅  | the language field says it has a list   | served page, screenshot                                                          | a bare datalist showed nothing until you typed → a caret that opens the picker                      |
| ☐   | the scan on a real page                 | run a prompt on a passage that wraps across lines                                | — needs a reload                                                                                    |
| ✅  | the language list                       | served page with a language already set, menu opened, screenshot                 | `<datalist>` gave two arrows and an EMPTY list (it filters by the typed value) → an own list that always shows all twelve and marks the current one |
| ✅  | the toolbar stays gone after a prompt   | drove the real content script through the daemon, sending the mouseup a real click also sends | `selAfterClick:live` → `barBack:true` — the bar re-raised itself on top of the answer ([F-66](./findings.md)); fixed by releasing the selection |
| ✅  | the open-ended prompt is not special     | same probe, "Ask…" path                                                          | `panel:true quote:true scan:1 barAfter:false` — the popover, the quote and the scan all appear, same as the saved ones                          |
| ✅  | the answer cache                        | unit (`tests/localmd-prompt-cache.test.ts`)                                      | keyed on the filled prompt; ten deep, oldest out; a re-answer moves rather than duplicates; a storage that throws is a miss, not a failure |
| ☐   | the mark stays after the answer          | run a prompt, read the answer, hover and click the quote                         | — needs a reload                                                                                                                          |
| ☐   | pin, by button and by drag               | pin the popover, click the page, then unpin                                      | —                                                                                                                                         |
| ☐   | a cached answer, and asking again        | run the same prompt on the same passage twice; then click "cached"               | —                                                                                                                                         |
| ✅  | the answer renders as Markdown          | unit (`tests/localmd-mini-markdown.test.ts`, jsdom) + the real CSS on a served page | bullets/bold/code render; `<img onerror>` never becomes an element; `2 * 3` and `a_variable_name` stay literal |
| ✅  | destroying highlights asks first        | unit (`tests/localmd-options.test.ts`, jsdom) + the dialog on a served page       | both removals ask in the page's own dialog; Cancel has focus; Escape and the backdrop cancel; the question names what is going |
| ☐   | Continue in localmd                      | run a prompt, press the bubble on the answer, read what localmd opens with        | — needs a reload (and localmd's `askDraft` change deployed for the answer half)                                |
| ✅  | the settings list follows the pages     | unit (`tests/localmd-options.test.ts`, jsdom, firing `storage.onChanged`)         | a mark made elsewhere appears; one made while a note is being typed waits for the editor to close; other keys are ignored |
