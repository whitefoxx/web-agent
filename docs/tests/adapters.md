# Adapter test checklist — 288 of 294 marketplace adapters

> Generated from `marketplace/index.json`. One row per adapter. Work through it per the
> tiers + policy in [README.md](./README.md). Mark **结果**: ✅ pass · ❌ fail (→ log in
> [findings.md](./findings.md)) · ⏭️ skip (say why) · 🔒 blocked (needs login). Leave ☐ until run.

**Legend:** acc = 🟢read (safe) / 🔴WRITE (side effects — see README write policy). type = func (page+CDP) / pipeline (some are tab-less HTTP).

## Progress

- Listed here: **288** adapters · 224 read · 64 write · across 27 sites _(marketplace/index.json now has **294**; this checklist trails by 6 — a pre-existing drift, unrelated to the 2026-07-10 xhs ports)_
- Public (no-login) sites: ['arxiv', 'bluesky', 'devto', 'hackernews', 'lobsters', 'stackoverflow', 'wikipedia']
- ✅ passed: 175 / 288 · ❌ failed: 0 · ⚠️ recheck: 22 · 🔒 blocked(需登录): 4 · ⏭️ skipped(写/暂缓): 52 · 🔧 pending-verify: 0 · ☐ 未跑: 35 _(含 2026-07-10 从 xhs-operator 移植的 download/feed/notifications + comment-create,§10.43,离线注册过、真机待验)_ _(weread:cookie 版 5✅ / 4⚠️——私有 i.weread API 鉴权过不去(Cookie 头被丢→-2010;带 cred 又 -2012 会话过期),改用 weread-official;**weread-official 8/8 ✅**(凭据 vault,bridge 实测)——见 findings + docs/adapter-secrets.md)_

### arxiv (4: 4🟢 / 0🔴) — A · public, no login

| ☐   | adapter  | acc    | type | 说明                                           | 结果                      |
| --- | -------- | ------ | ---- | ---------------------------------------------- | ------------------------- |
| ✅  | `author` | 🟢read | func | List arXiv papers by a given author (newest fi | Bengio                    |
| ✅  | `paper`  | 🟢read | func | Get arXiv paper details by ID                  | Attention Is All You Need |
| ✅  | `recent` | 🟢read | func | List recent arXiv submissions in a category    | cs.AI                     |
| ✅  | `search` | 🟢read | func | Search arXiv papers                            | F-5修复后通(diffusion)    |

### bluesky (9: 9🟢 / 0🔴) — A · public, no login

`public.api.bsky.app`

| ☐   | adapter         | acc    | type     | 说明                                        | 结果                 |
| --- | --------------- | ------ | -------- | ------------------------------------------- | -------------------- |
| ✅  | `feeds`         | 🟢read | pipeline | Popular Bluesky feed generators             | list17               |
| ✅  | `followers`     | 🟢read | pipeline | List followers of a Bluesky user            | list10               |
| ✅  | `following`     | 🟢read | pipeline | List accounts a Bluesky user is following   | list6                |
| ✅  | `profile`       | 🟢read | pipeline | Get Bluesky user profile info               | F-11复测通(bsky.app) |
| ✅  | `search`        | 🟢read | pipeline | Search Bluesky users                        | users                |
| ✅  | `starter-packs` | 🟢read | pipeline | Get starter packs created by a Bluesky user | list10               |
| ✅  | `thread`        | 🟢read | pipeline | Get a Bluesky post thread with replies      | 线程ok               |
| ✅  | `trending`      | 🟢read | pipeline | Trending topics on Bluesky                  | list10               |
| ✅  | `user`          | 🟢read | pipeline | Get recent posts from a Bluesky user        | posts20              |

### devto (3: 3🟢 / 0🔴) — A · public, no login

`dev.to`

| ☐   | adapter | acc    | type     | 说明                                        | 结果 |
| --- | ------- | ------ | -------- | ------------------------------------------- | ---- |
| ✅  | `tag`   | 🟢read | pipeline | Latest DEV.to articles for a specific tag   | 20   |
| ✅  | `top`   | 🟢read | pipeline | Top DEV.to articles of the day              | 20   |
| ✅  | `user`  | 🟢read | pipeline | Recent DEV.to articles from a specific user | 20   |

### hackernews (9: 9🟢 / 0🔴) — A · public, no login

`news.ycombinator.com`

| ☐   | adapter  | acc    | type     | 说明                                          | 结果                          |
| --- | -------- | ------ | -------- | --------------------------------------------- | ----------------------------- |
| ✅  | `ask`    | 🟢read | pipeline | Hacker News Ask HN posts                      | 20                            |
| ✅  | `best`   | 🟢read | pipeline | Hacker News best stories                      | 20                            |
| ✅  | `jobs`   | 🟢read | pipeline | Hacker News job postings                      | 20                            |
| ✅  | `new`    | 🟢read | pipeline | Hacker News newest stories                    | 20                            |
| ✅  | `read`   | 🟢read | func     | Read a Hacker News story and its comment tree | F-4修复后通(71条)             |
| ✅  | `search` | 🟢read | pipeline | Search Hacker News stories                    | F-6后query真生效(Algolia搜索) |
| ✅  | `show`   | 🟢read | pipeline | Hacker News Show HN posts                     | 20                            |
| ✅  | `top`    | 🟢read | pipeline | Hacker News top stories                       | 3                             |
| ✅  | `user`   | 🟢read | pipeline | Hacker News user profile                      | F-11复测通(pg profile)        |

### lobsters (6: 6🟢 / 0🔴) — A · public, no login

`lobste.rs`

| ☐   | adapter  | acc    | type     | 说明                                           | 结果        |
| --- | -------- | ------ | -------- | ---------------------------------------------- | ----------- |
| ✅  | `active` | 🟢read | pipeline | Lobste.rs most active discussions              | 20          |
| ✅  | `domain` | 🟢read | func     | Lobste.rs stories submitted from a specific do | F-4修复后通 |
| ✅  | `hot`    | 🟢read | pipeline | Lobste.rs hottest stories                      | 20          |
| ✅  | `newest` | 🟢read | pipeline | Lobste.rs newest stories                       | 20          |
| ✅  | `read`   | 🟢read | func     | Read a Lobste.rs story and its comment tree    | F-4修复后通 |
| ✅  | `tag`    | 🟢read | pipeline | Lobste.rs stories by tag                       | 20          |

### stackoverflow (4: 4🟢 / 0🔴) — A · public, no login

`stackoverflow.com`

| ☐   | adapter      | acc    | type     | 说明                                           | 结果 |
| --- | ------------ | ------ | -------- | ---------------------------------------------- | ---- |
| ✅  | `bounties`   | 🟢read | pipeline | Active bounties on Stack Overflow              | 3    |
| ✅  | `hot`        | 🟢read | pipeline | Hot Stack Overflow questions                   | 10   |
| ✅  | `search`     | 🟢read | pipeline | Search Stack Overflow questions                | 10   |
| ✅  | `unanswered` | 🟢read | pipeline | Top voted unanswered questions on Stack Overfl | 10   |

### wikipedia (5: 5🟢 / 0🔴) — A · public, no login

`wikipedia.org`

| ☐   | adapter    | acc    | type | 说明                                           | 结果                               |
| --- | ---------- | ------ | ---- | ---------------------------------------------- | ---------------------------------- |
| ✅  | `page`     | 🟢read | func | Full plain-text extract of a Wikipedia article | full extract                       |
| ✅  | `random`   | 🟢read | func | Get a random Wikipedia article                 | ok                                 |
| ✅  | `search`   | 🟢read | func | Search Wikipedia articles                      | F-5修复后通                        |
| ✅  | `summary`  | 🟢read | func | Get Wikipedia article summary                  | REST summary                       |
| ✅  | `trending` | 🟢read | func | Most-read Wikipedia articles (yesterday)       | most-read 可用(早先空是 load 竞态) |

### bilibili (15: 13🟢 / 2🔴) — B/C · needs login (reads may be public)

`www.bilibili.com`

| ☐   | adapter       | acc     | type     | 说明                                                                              | 结果                              |
| --- | ------------- | ------- | -------- | --------------------------------------------------------------------------------- | --------------------------------- |
| ✅  | `comments`    | 🟢read  | func     | 获取 B站视频评论（官方 API；用 --parent <rpid> 读取某条评论下的「楼中             | 5                                 |
| ✅  | `dynamic`     | 🟢read  | func     | Get Bilibili user dynamic feed                                                    | 动态5                             |
| ✅  | `feed`        | 🟢read  | func     | 动态时间线（不传 uid 查关注时间线，传 uid 查指定用户动态）                        | 动态时间线                        |
| ✅  | `following`   | 🟢read  | func     | 获取 Bilibili 用户的关注列表                                                      | 关注列表5                         |
| ✅  | `history`     | 🟢read  | func     | 我的观看历史                                                                      | 观看历史5                         |
| ✅  | `hot`         | 🟢read  | pipeline | B站热门视频                                                                       | 20                                |
| ✅  | `me`          | 🟢read  | func     | My Bilibili profile info                                                          | uid/level/coins/followers(已登录) |
| ✅  | `ranking`     | 🟢read  | func     | Get Bilibili video ranking board                                                  | F-13修复后通(默认limit=20)        |
| ✅  | `search`      | 🟢read  | func     | Search Bilibili videos or users                                                   | 20                                |
| ✅  | `subtitle`    | 🟢read  | func     | 获取 Bilibili 视频的字幕                                                          | 1152行字幕                        |
| ✅  | `summary`     | 🟢read  | func     | 获取 B站视频的官方 AI 总结（视频页「AI总结」同款，含分段大纲与时间戳）            | AI总结21段                        |
| ✅  | `user-videos` | 🟢read  | func     | 查看指定用户的投稿视频                                                            | 创作者投稿5(我uid空=正常)         |
| ✅  | `video`       | 🟢read  | func     | Get Bilibili video metadata (title, author, du                                    | 17字段                            |
| ⏭️  | `comment`     | 🔴WRITE | func     | 在 B站视频下发表评论或回复（官方 API，需登录；消息里的 @用户 会被解析为真实提及） | write — opt-in(发评论)            |
| ⏭️  | `favorite`    | 🔴WRITE | func     | 我的收藏夹                                                                        | write — opt-in                    |

### chatgpt (7: 5🟢 / 2🔴) — B/C · needs login (reads may be public)

| ☐   | adapter   | acc     | type | 说明                                           | 结果                                                     |
| --- | --------- | ------- | ---- | ---------------------------------------------- | -------------------------------------------------------- |
| ⚠️  | `detail`  | 🟢read  | func | Open a ChatGPT web conversation by ID and read | 本次 history 空→无 conv id 可测(已登录)                  |
| ✅  | `history` | 🟢read  | func | List visible ChatGPT web conversation history  | adopt路径3.6s/5会话(冷开45s已调,需无chatgpt-tab才能净测) |
| ✅  | `new`     | 🟢read  | func | Start a new ChatGPT web conversation           | "New chat started"(已登录)                               |
| ⚠️  | `read`    | 🟢read  | func | Read messages in the current ChatGPT web conve | 新会话空→EmptyResult;需有消息的会话复核                  |
| ✅  | `status`  | 🟢read  | func | Check ChatGPT web page availability and login  | adopt路径1.5s/Login:Yes                                  |
| ☐   | `ask`     | 🔴WRITE | func | Send a prompt to ChatGPT web and wait for the  |                                                          |
| ☐   | `send`    | 🔴WRITE | func | Send a prompt to ChatGPT web without waiting f |                                                          |

### claude (7: 5🟢 / 2🔴) — B/C · needs login (reads may be public)

| ☐   | adapter   | acc     | type | 说明                                           | 结果                                          |
| --- | --------- | ------- | ---- | ---------------------------------------------- | --------------------------------------------- |
| ⚠️  | `detail`  | 🟢read  | func | Open a Claude conversation by ID and read its  | EmptyResult(read 同会话有内容→提取/时序;复核) |
| ✅  | `history` | 🟢read  | func | List conversation history from Claude /recents | 复测通(已登录;返回会话列表)                   |
| ✅  | `new`     | 🟢read  | func | Start a new conversation in Claude             | New chat started(已登录)                      |
| ✅  | `read`    | 🟢read  | func | Read the current Claude conversation           | 读到当前会话消息(已登录)                      |
| ✅  | `status`  | 🟢read  | func | Check Claude page availability and login state | Connected/Login:Yes                           |
| ☐   | `ask`     | 🔴WRITE | func | Send a prompt to Claude and get the response   |                                               |
| ☐   | `send`    | 🔴WRITE | func | Send a prompt to Claude without waiting for th |                                               |

### douban (8: 8🟢 / 0🔴) — B/C · needs login (reads may be public)

`book.douban.com`

| ☐   | adapter     | acc    | type     | 说明                      | 结果                                                |
| --- | ----------- | ------ | -------- | ------------------------- | --------------------------------------------------- |
| ✅  | `book-hot`  | 🟢read | func     | 豆瓣图书热门榜单          | 20                                                  |
| ✅  | `marks`     | 🟢read | func     | 导出个人观影标记          | F-15修复(in-page fetch);ahbei验证解析,本号空=无标记 |
| ✅  | `movie-hot` | 🟢read | func     | 豆瓣电影热门榜单          | 10                                                  |
| ✅  | `photos`    | 🟢read | func     | 获取电影海报/剧照图片列表 | 剧照5                                               |
| ✅  | `reviews`   | 🟢read | func     | 导出个人影评              | ahbei验证解析;本号空=无影评                         |
| ✅  | `search`    | 🟢read | func     | 搜索豆瓣电影、图书或音乐  | 需显式 type(默认空);type:movie OK                   |
| ✅  | `subject`   | 🟢read | func     | 获取豆瓣条目详情          | F-9复测通(肖申克 rating9.7)                         |
| ✅  | `top250`    | 🟢read | pipeline | 豆瓣电影 Top250           | 250                                                 |

### douyin (11: 9🟢 / 2🔴) — B/C · needs login (reads may be public)

`creator.douyin.com`

| ☐   | adapter       | acc     | type | 说明                                                             | 结果                                                |
| --- | ------------- | ------- | ---- | ---------------------------------------------------------------- | --------------------------------------------------- |
| ✅  | `activities`  | 🟢read  | func | 官方活动列表                                                     | 复测通(已登录;活动列表)                             |
| ✅  | `collections` | 🟢read  | func | 合集列表                                                         | 空(已登录无合集)                                    |
| ⚠️  | `drafts`      | 🟢read  | func | 获取草稿列表                                                     | API error 1 "Url doesn't match"(已登录;疑 endpoint) |
| ⚠️  | `hashtag`     | 🟢read  | func | 话题搜索 / AI推荐 / 热点词                                       | API error -2(已登录;同 location;疑权限/endpoint)    |
| ⚠️  | `location`    | 🟢read  | func | 地理位置 POI 搜索                                                | API error -2(query=咖啡;已登录;疑权限/endpoint)     |
| ✅  | `profile`     | 🟢read  | func | 获取账号信息                                                     | 复测通(abiao uid97576179379)                        |
| ⚠️  | `stats`       | 🟢read  | func | 作品数据分析                                                     | 需 aweme_id(本号 0 作品→无 id)                      |
| ⚠️  | `user-videos` | 🟢read  | func | 获取指定用户的视频列表（含下载地址和热门评论）                   | 需 sec_uid(目标用户;未提供)                         |
| ✅  | `videos`      | 🟢read  | func | 获取作品列表                                                     | 空(已登录无作品)                                    |
| ☐   | `delete`      | 🔴WRITE | func | 删除作品（优先使用创作者后台作品管理；找不到时回退到旧删除接口） |                                                     |
| ☐   | `update`      | 🔴WRITE | func | 更新视频信息                                                     |                                                     |

### gemini (4: 2🟢 / 2🔴) — B/C · needs login (reads may be public)

| ☐   | adapter                | acc     | type | 说明                                           | 结果                                                                                                       |
| --- | ---------------------- | ------- | ---- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| ✅  | `deep-research-result` | 🟢read  | func | Export Deep Research report URL from a Gemini  | F-21 复测✅:无 page.tabs 崩溃、clean 跑完;本号最新会话无已导出 Deep Research→友好提示(happy-path 需真报告) |
| ✅  | `new`                  | 🟢read  | func | Start a new conversation in Gemini web chat    | "Clicked New chat"(已登录)                                                                                 |
| ☐   | `ask`                  | 🔴WRITE | func | Send a prompt to Gemini and return only the as |                                                                                                            |
| ☐   | `deep-research`        | 🔴WRITE | func | Start a Gemini Deep Research run and confirm i |                                                                                                            |

### instagram (16: 7🟢 / 9🔴) — B/C · needs login (reads may be public)

`www.instagram.com`

| ☐   | adapter             | acc     | type     | 说明                                           | 结果                                  |
| --- | ------------------- | ------- | -------- | ---------------------------------------------- | ------------------------------------- |
| ✅  | `explore`           | 🟢read  | pipeline | Instagram explore/discover trending posts      | 复测通(已登录;返回空 list)            |
| ✅  | `followers`         | 🟢read  | pipeline | List followers of an Instagram user            | 复测通(natgeo 粉丝;首测 401=冷开假阴) |
| ✅  | `following`         | 🟢read  | pipeline | List accounts an Instagram user is following   | 复测通(natgeo 关注)                   |
| ✅  | `profile`           | 🟢read  | pipeline | Get Instagram user profile info                | 公开主页免登录可用(685M followers)    |
| ✅  | `saved`             | 🟢read  | pipeline | Get your saved Instagram posts (optionally fro | 空(已登录无收藏)                      |
| ✅  | `search`            | 🟢read  | pipeline | Search Instagram users                         | 复测通(travel;首测登录墙=冷开假阴)    |
| ✅  | `user`              | 🟢read  | pipeline | Get recent posts from an Instagram user        | natgeo 公开帖子                       |
| ☐   | `collection-create` | 🔴WRITE | pipeline | Create a new Instagram saved-posts collection  |                                       |
| ☐   | `collection-delete` | 🔴WRITE | pipeline | Delete an Instagram saved-posts collection (fo |                                       |
| ☐   | `comment`           | 🔴WRITE | pipeline | Comment on an Instagram post                   |                                       |
| ☐   | `follow`            | 🔴WRITE | pipeline | Follow an Instagram user                       |                                       |
| ☐   | `like`              | 🔴WRITE | pipeline | Like an Instagram post                         |                                       |
| ☐   | `save`              | 🔴WRITE | pipeline | Save (bookmark) an Instagram post              |                                       |
| ☐   | `unfollow`          | 🔴WRITE | pipeline | Unfollow an Instagram user                     |                                       |
| ☐   | `unlike`            | 🔴WRITE | pipeline | Unlike an Instagram post                       |                                       |
| ☐   | `unsave`            | 🔴WRITE | pipeline | Unsave (remove bookmark) an Instagram post     |                                       |

### jimeng (4: 2🟢 / 2🔴) — B/C · needs login (reads may be public)

`jimeng.jianying.com`

| ☐   | adapter      | acc     | type     | 说明                                 | 结果                      |
| --- | ------------ | ------- | -------- | ------------------------------------ | ------------------------- |
| ✅  | `history`    | 🟢read  | pipeline | 即梦AI 查看最近生成的作品            | 空(已登录,无作品)         |
| ✅  | `workspaces` | 🟢read  | pipeline | 即梦AI 查看所有工作区（会话窗口）    | default workspace(已登录) |
| ☐   | `generate`   | 🔴WRITE | pipeline | 即梦AI 文生图 — 输入 prompt 生成图片 |                           |
| ☐   | `new`        | 🔴WRITE | pipeline | 即梦AI 新建会话（workspace）         |                           |

### linkedin (20: 18🟢 / 2🔴) — B/C · needs login (reads may be public)

`www.linkedin.com`

| ☐   | adapter              | acc     | type | 说明                                           | 结果                      |
| --- | -------------------- | ------- | ---- | ---------------------------------------------- | ------------------------- |
| ⏭️  | `(unnamed)`          | 🟢read  | func | List LinkedIn messaging inbox conversations an | 用户要求暂缓测试 linkedin |
| ⏭️  | `job-detail`         | 🟢read  | func |                                                | 用户要求暂缓测试 linkedin |
| ⏭️  | `jobs-preferences`   | 🟢read  | func | Read visible LinkedIn Jobs preferences and ale | 用户要求暂缓测试 linkedin |
| ⏭️  | `people-search`      | 🟢read  | func | Search standard LinkedIn (not Sales Navigator) | 用户要求暂缓测试 linkedin |
| ⏭️  | `post-analytics`     | 🟢read  | func | Summarize raw visible LinkedIn post counters w | 用户要求暂缓测试 linkedin |
| ⏭️  | `posts`              | 🟢read  | func | Export visible posts from a LinkedIn profile a | 用户要求暂缓测试 linkedin |
| ⏭️  | `profile-analytics`  | 🟢read  | func | Read visible LinkedIn profile dashboard metric | 用户要求暂缓测试 linkedin |
| ⏭️  | `profile-experience` | 🟢read  | func | Read visible LinkedIn profile experience entri | 用户要求暂缓测试 linkedin |
| ⏭️  | `profile-projects`   | 🟢read  | func | Read visible LinkedIn profile projects with de | 用户要求暂缓测试 linkedin |
| ⏭️  | `profile-read`       | 🟢read  | func | Read visible LinkedIn profile sections: headli | 用户要求暂缓测试 linkedin |
| ⏭️  | `salesnav-inbox`     | 🟢read  | func | List LinkedIn Sales Navigator message conversa | 用户要求暂缓测试 linkedin |
| ⏭️  | `salesnav-search`    | 🟢read  | func | Search LinkedIn Sales Navigator for people lea | 用户要求暂缓测试 linkedin |
| ⏭️  | `salesnav-thread`    | 🟢read  | func | List LinkedIn Sales Navigator message conversa | 用户要求暂缓测试 linkedin |
| ⏭️  | `search`             | 🟢read  | func |                                                | 用户要求暂缓测试 linkedin |
| ⏭️  | `sent-invitations`   | 🟢read  | func | List pending LinkedIn sent invitations for CRM | 用户要求暂缓测试 linkedin |
| ⏭️  | `services-read`      | 🟢read  | func | Read LinkedIn Services page details including  | 用户要求暂缓测试 linkedin |
| ⏭️  | `thread-snapshot`    | 🟢read  | func | Load a LinkedIn messaging thread, scroll for a | 用户要求暂缓测试 linkedin |
| ⏭️  | `timeline`           | 🟢read  | func | Read LinkedIn home timeline posts              | 用户要求暂缓测试 linkedin |
| ⏭️  | `connect`            | 🔴WRITE | func | Fail-closed LinkedIn connection request sender | 用户要求暂缓测试 linkedin |
| ⏭️  | `salesnav-message`   | 🔴WRITE | func | Send or dry-run a LinkedIn Sales Navigator InM | 用户要求暂缓测试 linkedin |

### notebooklm (17: 13🟢 / 4🔴) — B/C · needs login (reads may be public)

| ☐   | adapter           | acc     | type | 说明                                           | 结果                                   |
| --- | ----------------- | ------- | ---- | ---------------------------------------------- | -------------------------------------- |
| 🔒  | `current`         | 🟢read  | func | Show metadata for the currently opened Noteboo | 需先 notebooklm open <id>(会话前置)    |
| ✅  | `get`             | 🟢read  | func | Get rich metadata for the currently opened Not | open后通(IEP SMART goals)              |
| 🔒  | `history`         | 🟢read  | func | List NotebookLM conversation history threads i | 需先 open notebook                     |
| ✅  | `list`            | 🟢read  | func | List NotebookLM notebooks via in-page batchexe | F-19附带修好(process不再崩)            |
| ⚠️  | `note-list`       | 🟢read  | func | List saved notes from the Studio panel of the  | 本本无 Studio 笔记→空;换有笔记的本复核 |
| ⚠️  | `notes-get`       | 🟢read  | func | Get one note from the current NotebookLM noteb | 无 note id 可测(note-list 空)          |
| ✅  | `open`            | 🟢read  | func | Open one NotebookLM notebook in the adapter se | 通(arg=notebook;开 IEP SMART goals)    |
| ✅  | `source-fulltext` | 🟢read  | func | Get the extracted fulltext for one source in t | open后通                               |
| ✅  | `source-get`      | 🟢read  | func | Get one source from the currently opened Noteb | open后通                               |
| ✅  | `source-guide`    | 🟢read  | func | Get the guide summary and keywords for one sou | open后通                               |
| ✅  | `source-list`     | 🟢read  | func | List sources for the currently opened Notebook | open后通                               |
| ✅  | `status`          | 🟢read  | func | Check NotebookLM page availability and login s | Connected/login OK                     |
| ✅  | `summary`         | 🟢read  | func | Get the summary block from the currently opene | open后通                               |
| ☐   | `create`          | 🔴WRITE | func | Create a new NotebookLM notebook with the give |                                        |
| ☐   | `generate-audio`  | 🔴WRITE | func | Trigger an Audio Overview (Deep Dive podcast)  |                                        |
| ☐   | `generate-slides` | 🔴WRITE | func | Trigger a Slide Deck (AI presentation) generat |                                        |
| ☐   | `write-note`      | 🔴WRITE | func | Create a Studio note in an existing NotebookLM |                                        |

### reddit (20: 15🟢 / 5🔴) — B/C · needs login (reads may be public)

`reddit.com`

| ☐   | adapter          | acc     | type     | 说明                                           | 结果                                   |
| --- | ---------------- | ------- | -------- | ---------------------------------------------- | -------------------------------------- |
| ✅  | `frontpage`      | 🟢read  | pipeline | Reddit Frontpage / r/all                       | 15                                     |
| ✅  | `home`           | 🟢read  | func     | Reddit personalized home feed (Best, requires  | 首页5                                  |
| ✅  | `hot`            | 🟢read  | pipeline | Reddit 热门帖子                                | 20(r/programming)                      |
| ✅  | `popular`        | 🟢read  | pipeline | Reddit Popular posts (/r/popular)              | 20                                     |
| ✅  | `read`           | 🟢read  | func     | Read a Reddit post and its comments            | 15评论                                 |
| ✅  | `saved`          | 🟢read  | func     | Browse your saved Reddit posts                 | 收藏3                                  |
| ✅  | `search`         | 🟢read  | pipeline | Search Reddit Posts                            | 15                                     |
| ✅  | `subreddit`      | 🟢read  | pipeline | Get posts from a specific Subreddit            | 15                                     |
| ✅  | `subreddit-info` | 🟢read  | func     | Show metadata for a Reddit subreddit (subscrib | r/programming 9字段                    |
| ✅  | `subscribed`     | 🟢read  | func     | List subreddits you are subscribed to          | F-20修复后通(endpoint+跳过profile sub) |
| ✅  | `upvoted`        | 🟢read  | func     | Browse your upvoted Reddit posts               | 点赞5                                  |
| ✅  | `user`           | 🟢read  | pipeline | View a Reddit user profile                     | u/spez                                 |
| ✅  | `user-comments`  | 🟢read  | pipeline |                                                | 5                                      |
| ✅  | `user-posts`     | 🟢read  | pipeline |                                                | spez AMA 5                             |
| ✅  | `whoami`         | 🟢read  | func     | Show the currently logged-in Reddit user       | u/redditscrat(已登录)                  |
| ☐   | `comment`        | 🔴WRITE | func     | Post a comment on a Reddit post                |                                        |
| ☐   | `reply`          | 🔴WRITE | func     | Reply to a Reddit comment                      |                                        |
| ☐   | `save`           | 🔴WRITE | func     | Save or unsave a Reddit post                   |                                        |
| ☐   | `subscribe`      | 🔴WRITE | func     | Subscribe or unsubscribe to a subreddit        |                                        |
| ☐   | `upvote`         | 🔴WRITE | func     | Upvote or downvote a Reddit post               |                                        |

### tiktok (6: 2🟢 / 4🔴) — B/C · needs login (reads may be public)

`www.tiktok.com`

| ☐   | adapter   | acc     | type     | 说明                                 | 结果                            |
| --- | --------- | ------- | -------- | ------------------------------------ | ------------------------------- |
| ⚠️  | `profile` | 🟢read  | pipeline | Get TikTok user profile info         | 同左                            |
| ⚠️  | `search`  | 🟢read  | pipeline | Search TikTok videos                 | page内fetch失败,疑似需登录/风控 |
| ☐   | `like`    | 🔴WRITE | pipeline | Like a TikTok video                  |                                 |
| ☐   | `save`    | 🔴WRITE | pipeline | Add a TikTok video to Favorites      |                                 |
| ☐   | `unlike`  | 🔴WRITE | pipeline | Unlike a TikTok video                |                                 |
| ☐   | `unsave`  | 🔴WRITE | pipeline | Remove a TikTok video from Favorites |                                 |

### twitter (34: 19🟢 / 15🔴) — B/C · needs login (reads may be public)

`x.com`

| ☐   | adapter            | acc     | type | 说明                                           | 结果                                  |
| --- | ------------------ | ------- | ---- | ---------------------------------------------- | ------------------------------------- |
| ⚠️  | `article`          | 🟢read  | func | Fetch a Twitter Article (long-form content) an | 对非Article正确报错;需Article推文验证 |
| 🔒  | `bookmark-folder`  | 🟢read  | func |                                                | 需folder-id(folders先修)              |
| ⚠️  | `bookmark-folders` | 🟢read  | func | List your Twitter/X bookmark folders (the user | HTTP404(queryId过期/无文件夹)         |
| ✅  | `bookmarks`        | 🟢read  | func | Fetch your Twitter/X bookmarks (the logged-in  | 书签5                                 |
| ⚠️  | `device-follow`    | 🟢read  | func |                                                | EmptyResult(我无device-follow=正常)   |
| ✅  | `followers`        | 🟢read  | func | Get accounts following a Twitter/X user (defau | 粉丝5                                 |
| ✅  | `following`        | 🟢read  | func | Get accounts a Twitter/X user is following (de | F-18修复后通(string-form evaluate)    |
| ✅  | `likes`            | 🟢read  | func | Fetch liked tweets of a Twitter user (defaults | 点赞5                                 |
| ⏭️  | `list-add`         | 🟢read  | func | Get Twitter/X lists for the logged-in user (ow | write(F-16已更正access);opt-in        |
| ⏭️  | `list-remove`      | 🟢read  | func | Get Twitter/X lists for the logged-in user (ow | write(F-16已更正access);opt-in        |
| ⚠️  | `list-tweets`      | 🟢read  | func | Fetch tweets from a Twitter/X list timeline    | 空(我的list成员0=正常)                |
| ✅  | `lists`            | 🟢read  | func | Get Twitter/X lists for the logged-in user (ow | 我的列表4(ideas)                      |
| ✅  | `notifications`    | 🟢read  | func | Get your Twitter/X notifications (the logged-i | F-17修复后通(waitForCapture)          |
| ✅  | `profile`          | 🟢read  | func | Fetch a Twitter user profile — bio, stats, etc | elonmusk                              |
| ✅  | `search`           | 🟢read  | func | Search Twitter/X for tweets, with optional --f | 5                                     |
| ✅  | `thread`           | 🟢read  | func | Get a tweet thread (original + all replies)    | 线程ok                                |
| ✅  | `timeline`         | 🟢read  | func | Fetch the logged-in user\                      | home for-you 5                        |
| ✅  | `trending`         | 🟢read  | func | Twitter/X trending topics                      | 9(已登录X)                            |
| ✅  | `tweets`           | 🟢read  | func |                                                | 我的推文(@foxxcyb)                    |
| ⏭️  | `accept`           | 🔴WRITE | func | Auto-accept DM requests containing specific ke | write — opt-in                        |
| ⏭️  | `block`            | 🔴WRITE | func | Block a Twitter user                           | write — opt-in                        |
| ⏭️  | `bookmark`         | 🔴WRITE | func | Bookmark a tweet                               | write — opt-in                        |
| ⏭️  | `delete`           | 🔴WRITE | func | Delete a specific tweet by URL                 | write — opt-in                        |
| ⏭️  | `follow`           | 🔴WRITE | func | Follow a Twitter user                          | write — opt-in                        |
| ⏭️  | `hide-reply`       | 🔴WRITE | func | Hide a reply on your tweet (useful for hiding  | write — opt-in                        |
| ⏭️  | `like`             | 🔴WRITE | func | Like a specific tweet                          | write — opt-in                        |
| ⏭️  | `list-create`      | 🔴WRITE | func | Create a new Twitter/X list (returns the new l | write — opt-in                        |
| ⏭️  | `reply-dm`         | 🔴WRITE | func | Send a message to recent DM conversations      | write — opt-in                        |
| ⏭️  | `retweet`          | 🔴WRITE | func | Retweet a specific tweet                       | write — opt-in                        |
| ⏭️  | `unblock`          | 🔴WRITE | func | Unblock a Twitter user                         | write — opt-in                        |
| ⏭️  | `unbookmark`       | 🔴WRITE | func | Remove a tweet from bookmarks                  | write — opt-in                        |
| ⏭️  | `unfollow`         | 🔴WRITE | func | Unfollow a Twitter user                        | write — opt-in                        |
| ⏭️  | `unlike`           | 🔴WRITE | func | Remove a like from a specific tweet            | write — opt-in                        |
| ⏭️  | `unretweet`        | 🔴WRITE | func | Undo a retweet on a specific tweet             | write — opt-in                        |

### v2ex (11: 10🟢 / 1🔴) — B/C · needs login (reads may be public)

`www.v2ex.com`

| ☐   | adapter         | acc     | type     | 说明                              | 结果                   |
| --- | --------------- | ------- | -------- | --------------------------------- | ---------------------- |
| ✅  | `hot`           | 🟢read  | pipeline | V2EX 热门话题                     | 10                     |
| ✅  | `latest`        | 🟢read  | pipeline | V2EX 最新话题                     | 20                     |
| ✅  | `me`            | 🟢read  | func     | V2EX 获取个人资料 (余额/未读提醒) | id7368(已登录)         |
| ✅  | `member`        | 🟢read  | pipeline | V2EX 用户资料                     | F-6修复后通            |
| ✅  | `node`          | 🟢read  | pipeline | V2EX 节点话题列表                 | F-6修复后通            |
| ✅  | `nodes`         | 🟢read  | pipeline | V2EX 所有节点列表                 | 30                     |
| ✅  | `notifications` | 🟢read  | func     | V2EX 获取提醒 (回复/由于)         | 空=0未读(与me一致)     |
| ✅  | `replies`       | 🟢read  | pipeline | V2EX 主题回复列表                 | F-6修复后通            |
| ✅  | `topic`         | 🟢read  | pipeline | V2EX 主题详情和回复               | F-6修复后通            |
| ✅  | `user`          | 🟢read  | pipeline | V2EX 用户发帖列表                 | F-6修复后通            |
| ⏭️  | `daily`         | 🔴WRITE | func     | V2EX 每日签到并领取铜币           | 签到=写操作,明天opt-in |

### weibo (10: 9🟢 / 1🔴) — B/C · needs login (reads may be public)

`weibo.com`

| ☐   | adapter      | acc     | type | 说明                                           | 结果                          |
| --- | ------------ | ------- | ---- | ---------------------------------------------- | ----------------------------- |
| ✅  | `comments`   | 🟢read  | func | Get comments on a Weibo post                   | 评论20                        |
| ✅  | `favorites`  | 🟢read  | func | 我的微博收藏列表                               | 我的收藏                      |
| ✅  | `feed`       | 🟢read  | func | Fetch Weibo timeline (for-you or following)    | 时间线5                       |
| ✅  | `hot`        | 🟢read  | func | 微博热搜                                       | 10                            |
| ✅  | `me`         | 🟢read  | func | My Weibo profile info                          | 我的资料(已登录)              |
| ✅  | `post`       | 🟢read  | func | Get a single Weibo post                        | 帖子详情12字段                |
| ✅  | `search`     | 🟢read  | func | 搜索微博                                       | 5                             |
| ✅  | `user`       | 🟢read  | func | Get Weibo user profile                         | 用户资料(uid)                 |
| ✅  | `user-posts` | 🟢read  | func | List Weibo posts from a user, optionally filte | 用户微博5                     |
| ⏭️  | `delete`     | 🔴WRITE | func | Delete one of my Weibo posts by id             | write — opt-in(删微博!破坏性) |

### weread (9: 9🟢 / 0🔴) — B/C · needs login (reads may be public)

`weread.qq.com`

| ☐   | adapter       | acc    | type | 说明                                           | 结果                                                              |
| --- | ------------- | ------ | ---- | ---------------------------------------------- | ----------------------------------------------------------------- |
| ✅  | `ai-outline`  | 🟢read | func | Get AI-generated outline for a book            | 复测通(已登录;三体 AI 大纲)                                       |
| ⚠️  | `book`        | 🟢read | func | View book details on WeRead                    | i.weread 私有API:Cookie头被浏览器丢弃→-2010;带cred又-2012会话过期。改用 weread-official(findings) |
| ✅  | `book-search` | 🟢read | func | Search within a WeRead book after resolving it | 复测通(三体/黑暗森林 20 matches)                                  |
| ⚠️  | `highlights`  | 🟢read | func | List your highlights (underlines) in a book    | 同 book:私有API鉴权过不去(-2010/-2012)。改用 weread-official__notes |
| ⚠️  | `notebooks`   | 🟢read | func | List books that have highlights or notes       | 同 book:私有API鉴权过不去。改用 weread-official__notes              |
| ⚠️  | `notes`       | 🟢read | func | List your notes (thoughts) on a book           | 同 book:私有API鉴权过不去。改用 weread-official__notes              |
| ✅  | `ranking`     | 🟢read | func | WeRead book rankings by category               | 复测通(已登录;榜单 三体全集)                                      |
| ✅  | `search`      | 🟢read | func | Search books on WeRead                         | 复测通(三体)                                                      |
| ✅  | `shelf`       | 🟢read | func | List books on your WeRead bookshelf            | 复测通(已登录;书架列表)                                           |

### weread-official (8: 8🟢 / 0🔴) — B/C · needs login (reads may be public)

`weread.qq.com`

| ☐   | adapter     | acc    | type | 说明                                           | 结果                                              |
| --- | ----------- | ------ | ---- | ---------------------------------------------- | ------------------------------------------------- |
| ✅  | `book`      | 🟢read | func | Show WeRead book metadata, chapters, and readi | vault 跑通(三体 129 行;取代 cookie book)          |
| ✅  | `discover`  | 🟢read | func | Personalized or similar-book recommendations f | vault 跑通(12 行)                                  |
| ✅  | `list-apis` | 🟢read | func | List every api_name supported by the WeRead ag | vault 跑通(18 个 api_name)                         |
| ✅  | `notes`     | 🟢read | func | List notebooks overview or merged highlights+t | vault 跑通(20 行;取代 cookie notebooks/highlights/notes) |
| ✅  | `readdata`  | 🟢read | func | Reading statistics: time, streak, preferences, | vault 跑通(30 行阅读统计)                          |
| ✅  | `review`    | 🟢read | func | Browse public reviews of a WeRead book         | vault 跑通(三体 20 条书评)                         |
| ✅  | `search`    | 🟢read | func | Search WeRead store via the official agent gat | vault 跑通(三体;key 已打码)                        |
| ✅  | `shelf`     | 🟢read | func | Sync your WeRead shelf (books + albums + artic | vault 跑通(书架 131 行;取代 cookie shelf)         |

### xiaohongshu (14: 12🟢 / 2🔴) — B/C · needs login (reads may be public)

`www.xiaohongshu.com`

| ☐   | adapter                 | acc     | type | 说明                                                                          | 结果                                   |
| --- | ----------------------- | ------- | ---- | ----------------------------------------------------------------------------- | -------------------------------------- |
| ✅  | `comments`              | 🟢read  | func | 获取小红书笔记评论（支持楼中楼子回复）                                        | 需完整签名URL;F-14                     |
| 🔒  | `creator-note-detail`   | 🟢read  | func | 小红书单篇笔记详情页数据 (笔记信息 + 核心/互动数据 + 观看来源 + 观众画像 + 趋 | 需创作者笔记id(creator-notes 先修)     |
| ⚠️  | `creator-notes`         | 🟢read  | func | 小红书创作者笔记列表 + 每篇数据 (标题/日期/观看/点赞/收藏/评论)               | navigate-reinject 超5轮(§10.21族?)待查 |
| ⚠️  | `creator-notes-summary` | 🟢read  | func | 小红书创作者笔记列表 + 每篇数据 (标题/日期/观看/点赞/收藏/评论)               | 未测(同 creator-notes 族,疑同问题)     |
| ✅  | `creator-profile`       | 🟢read  | func | 小红书创作者账号信息 (粉丝/关注/获赞/成长等级)                                | 创作者资料(已登录)                     |
| ✅  | `creator-stats`         | 🟢read  | func | 小红书创作者数据总览 (观看/点赞/收藏/评论/分享/涨粉，含每日趋势)              | 创作者数据总览                         |
| ☐   | `download`              | 🟢read  | func | 下载小红书笔记图片/视频到 Downloads (chrome.downloads + 浏览器 cookie)        | 移植自 operator(§10.43);离线注册✅,真机待验 |
| ☐   | `feed`                  | 🟢read  | func | 小红书首页推荐 Feed (DOM scrape from /explore)                                | 移植自 operator(§10.43);离线注册✅,真机待验 |
| ✅  | `note`                  | 🟢read  | func | 获取小红书笔记正文和互动数据                                                  | 需完整签名URL(非裸id);F-14             |
| ☐   | `notifications`         | 🟢read  | func | 小红书通知列表 (v0 仅 mentions;DOM scrape from /notification)                 | 移植自 operator(§10.43);离线注册✅,真机待验 |
| ✅  | `search`                | 🟢read  | func | 搜索小红书笔记                                                                | 5(已登录)                              |
| ✅  | `user`                  | 🟢read  | func | Get public notes from a Xiaohongshu user profi                                | 用户笔记5                              |
| ⏭️  | `comment-create`        | 🔴WRITE | func | 在小红书笔记下写评论/回复 (按评论 ID;默认只写不发,send 才发,replies 批量)     | 移植自 operator(§10.43);write opt-in,真机待验 |
| ⏭️  | `delete-note`           | 🔴WRITE | func | 删除小红书已发布笔记 (creator center UI automation)                           | write — opt-in(删除!破坏性)            |

### youtube (14: 10🟢 / 4🔴) — B/C · needs login (reads may be public)

`www.youtube.com`

| ☐   | adapter         | acc     | type | 说明                                           | 结果                                                                       |
| --- | --------------- | ------- | ---- | ---------------------------------------------- | -------------------------------------------------------------------------- |
| ✅  | `channel`       | 🟢read  | func | Get YouTube channel info and recent videos     | 频道13字段(MrBeast)                                                        |
| ✅  | `comments`      | 🟢read  | func | Get YouTube video comments                     | 5                                                                          |
| ✅  | `feed`          | 🟢read  | func | Get YouTube homepage recommended videos        | 首页feed5(已登录)                                                          |
| ✅  | `history`       | 🟢read  | func | Get YouTube watch history                      | 观看历史4                                                                  |
| ✅  | `playlist`      | 🟢read  | func | Get YouTube playlist info and video list       | F-19后通(MrBeast上传)                                                      |
| ✅  | `search`        | 🟢read  | func | Search YouTube videos                          | 18(首次 tab-load 超时,复跑通)                                              |
| ✅  | `subscriptions` | 🟢read  | func | List subscribed YouTube channels               | 订阅5(@claude…)                                                            |
| ✅  | `transcript`    | 🟢read  | func | Get YouTube video transcript/subtitles         | F-26 复测✅:transcript 13.6k 字(3B1B)、~55s(goto 超时即放行,不再 30s 硬挂) |
| ✅  | `video`         | 🟢read  | func | Get YouTube video metadata (title, views, desc | 14字段                                                                     |
| ✅  | `watch-later`   | 🟢read  | func | Get your YouTube Watch Later queue             | F-19后通(Karpathy)                                                         |
| ⏭️  | `like`          | 🔴WRITE | func | Like a YouTube video                           | write — opt-in                                                             |
| ⏭️  | `subscribe`     | 🔴WRITE | func | Subscribe to a YouTube channel                 | write — opt-in                                                             |
| ⏭️  | `unlike`        | 🔴WRITE | func | Remove like from a YouTube video               | write — opt-in                                                             |
| ⏭️  | `unsubscribe`   | 🔴WRITE | func | Unsubscribe from a YouTube channel             | write — opt-in                                                             |

### zhihu (13: 8🟢 / 5🔴) — B/C · needs login (reads may be public)

`www.zhihu.com`

| ☐   | adapter           | acc     | type     | 说明                                           | 结果                            |
| --- | ----------------- | ------- | -------- | ---------------------------------------------- | ------------------------------- |
| ✅  | `answer-comments` | 🟢read  | func     | 知乎回答评论列表                               | list, 楼中楼ok                  |
| ✅  | `answer-detail`   | 🟢read  | func     | 知乎单个回答完整内容（按 answer ID 获取）      | 完整正文                        |
| ✅  | `collection`      | 🟢read  | func     | 知乎收藏夹内容列表（需要登录）                 | 收藏夹内容ok                    |
| ✅  | `collections`     | 🟢read  | func     | 知乎收藏夹列表（需要登录）                     | 我的收藏 40项(已登录)           |
| ✅  | `hot`             | 🟢read  | pipeline | 知乎热榜                                       | 20                              |
| ✅  | `question`        | 🟢read  | func     | 知乎问题详情和回答                             | 5                               |
| ✅  | `recommend`       | 🟢read  | func     | 知乎首页推荐                                   | 20(已登录)                      |
| ✅  | `search`          | 🟢read  | func     | 知乎搜索                                       | F-1修复后稳定(机器学习)         |
| ⏭️  | `answer`          | 🔴WRITE | func     | Answer a Zhihu question                        | write — opt-in(发答案=可见内容) |
| ⏭️  | `comment`         | 🔴WRITE | func     | Create a top-level comment on a Zhihu answer o | write — opt-in(发评论=可见内容) |
| ⏭️  | `favorite`        | 🔴WRITE | func     | Favorite a Zhihu answer or article into a spec | write — opt-in(可逆)            |
| ⏭️  | `follow`          | 🔴WRITE | func     | Follow a Zhihu user or question                | write — opt-in(可逆)            |
| ⏭️  | `like`            | 🔴WRITE | func     | Like a Zhihu answer or article                 | write — opt-in(可逆)            |
