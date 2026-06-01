# Bilibili 适配器

B站(bilibili.com)的 15 个适配器,覆盖搜索、视频信息、字幕、AI 总结、评论、动态、收藏、历史、个人资料等。全部基于 B站**官方 Web API**(不是抓 DOM),稳定性高。

## 前置条件

- **登录**:绝大多数适配器走 `Strategy.COOKIE`,需要你在 Chrome 里**已登录 bilibili.com**(复用浏览器 cookie)。未登录时「我的」类(`me` / `history` / `favorite` / 不带 uid 的 `feed` / `comment`)会报需要登录。
- **userScripts 开关**:`func` 型适配器通过页内 userScripts 执行,首次使用需在扩展详情页打开「允许用户脚本」开关(Chrome 138+)。`pipeline` 型(只有 `hot`)不需要。
- **写操作确认**:`access: write` 的适配器(`comment` / `favorite`)在真正写入前会弹**二次确认**;`comment` 还额外要求显式 `execute: true` 才会发布。

## 调用方式

Agent 以工具名 **`bilibili__<name>`** 调用,参数即下表的 args。带 `(位置)` 的是位置参数(第一个/第二个直接给值),其余用 `--key value` 形式。你也可以直接用自然语言让 agent 去调,例如「搜索 B站 关于 Rust 的视频」「给我 BV1xx 的 AI 总结」。

## 适配器速查

| 适配器 | 权限 | 作用 | 关键参数 | 输出列 |
| --- | --- | --- | --- | --- |
| `search` | read | 搜视频或用户 | `query`(位置), `type=video\|user`, `limit` | rank, title, author, score, url |
| `video` | read | 单个视频的元信息 | `bvid`(位置) | field / value 表 |
| `summary` | read | 视频官方 **AI 总结**(分段大纲 + 时间戳) | `bvid`(位置) | time, content |
| `subtitle` | read | 视频字幕(逐句 + 时间) | `bvid`(位置), `lang` | index, from, to, content |
| `comments` | read | 视频评论(可读楼中楼) | `bvid`(位置), `parent`, `limit≤50` | rank, rpid, author, text, likes, replies, time |
| `comment` | **write** | 发评论 / 回复 | `bvid`(位置), `message`(位置), `parent`, `execute` | rpid, bvid, oid, message, url |
| `hot` | read | 全站热门视频 | `limit` | rank, title, author, play, danmaku, bvid, url |
| `ranking` | read | 排行榜 | `limit` | rank, title, author, score, url |
| `user-videos` | read | 指定用户的投稿视频 | `uid`(位置), `order=pubdate\|click\|stow`, `limit`, `page` | rank, title, plays, likes, date, url |
| `following` | read | 用户的关注列表 | `uid`(位置, 默认自己), `page`, `limit≤50` | mid, name, sign, following, fans |
| `feed` | read | 动态时间线 | `uid`(位置, 不传=关注时间线), `limit`, `pages` | rank, time, author, title, type, likes, url |
| `dynamic` | read | 用户动态 feed | `limit` | id, author, text, likes, url |
| `history` | read | 我的观看历史 | `limit` | rank, title, author, progress, url |
| `favorite` | **write** | 我的收藏夹 | `fid`(默认首个收藏夹), `limit`, `page` | rank, title, author, plays, url |
| `me` | read | 我的个人资料 | —(无参) | name, uid, level, coins, followers, following |

## 逐个说明

### 内容获取

**`bilibili__search`** — 搜视频或用户。
- `query`(必填,位置):关键词。
- `type`:`video`(默认)或 `user`。
- `limit`(默认 20)、`page`(默认 1)。
- 例:`bilibili__search query="幻兽帕鲁" limit=10`;搜用户:`type=user`。

**`bilibili__video`** — 单个视频的完整元信息(标题、UP 主、时长、播放/点赞/投币/收藏等),返回 `field`/`value` 两列表。
- `bvid`(必填,位置):BV ID 或 bilibili.com 视频 URL。

**`bilibili__summary`** — 视频页「AI 总结」同款:整体摘要 + 分段大纲(每段带时间戳)。
- `bvid`(必填,位置)。
- 注意:仅当该视频**已生成**官方 AI 总结时才有内容,否则返回「无总结」。

**`bilibili__subtitle`** — 拉视频字幕,逐句带起止时间。
- `bvid`(必填,位置);`lang`:字幕语言码(如 `zh-CN`、`ai-zh`),不传取第一条。
- 番剧(PGC)也支持(走 view API 取 cid,不依赖页面结构)。
- 无字幕 / 被登录墙挡住会分别给出「无字幕」「需登录」的明确错误。

### 评论

**`bilibili__comments`**(读) — 获取视频评论。
- `bvid`(必填,位置);`limit`(默认 20,**上限 50**)。
- `parent=<rpid>`:读某条评论下的**楼中楼**回复,而不是顶层评论。

**`bilibili__comment`**(写) — 发表评论或回复。**需登录 + 二次确认 + `execute=true`**。
- `bvid`(必填,位置)、`message`(必填,位置):评论内容。
- 消息里的 `@用户名` 会被自动解析成**真实提及**(查到对应 mid);查不到的 @ 保留为纯文本,不阻断发送。
- `parent=<rpid>`:在某条评论下回复(楼中楼);省略则发顶层评论。
- `execute=true`:**必须显式带上才会真的发布**;不带只会拒绝并提示。
- 例:`bilibili__comment bvid=BV1xx message="@AI视频小助理 总结一下" execute=true`

### 榜单 / 发现

- **`bilibili__hot`**(pipeline,免 userScripts):全站热门视频,`limit`。
- **`bilibili__ranking`**:排行榜,`limit`。

### 用户维度

- **`bilibili__user-videos`**:某用户的投稿,`uid`(位置,**支持 UID 或用户名**)、`order`(`pubdate` 时间 / `click` 播放 / `stow` 收藏)、`limit`、`page`。
- **`bilibili__following`**:某用户的关注列表,`uid`(默认自己)、`page`、`limit`(≤50)。
- **`bilibili__feed`**:动态时间线;**不传 `uid` = 我的关注时间线**,传 `uid` = 指定用户动态;`limit`、`pages`。
- **`bilibili__dynamic`**:用户动态 feed,`limit`。

### 我的(需登录)

- **`bilibili__me`**:我的资料(等级、硬币、粉丝、关注数),无参。
- **`bilibili__history`**:观看历史,`limit`。
- **`bilibili__favorite`**:我的收藏夹,`fid`(默认首个收藏夹)、`limit`、`page`。

## 通用说明 / 已知限制

- **BV ID / URL**:接受 `bvid` 的适配器都支持纯 BV 号(`BV1xx411c7mD`)和 `bilibili.com/video/...` 完整 URL(含 query 参数会自动剥离)。
- **b23.tv 短链暂不支持**:短链解析依赖 `node:https` 重定向,在扩展运行时里跑不通(详见 `docs/adapter-hot-plug.md` §10.13)。请直接用 BV 号或完整 URL。
- **WBI 签名**:部分接口(搜索、收藏、AI 总结等)需要 WBI 签名,内部已用纯 JS MD5 实现(SubtleCrypto 不支持 MD5),无需关心。
- **维护**:这些 `.js` 是手动维护的权威源(非每次从 opencli 重新生成)。改任意一个都要同步 `../index.json` 里对应条目的 `sha256`,否则装不上。详见 `docs/adapter-hot-plug.md`。
- **测试**:全部 15 个适配器有移植自 opencli 的单测,见 `tests/adapters/bilibili/`(63 个用例),mock 接缝说明见 `tests/adapters/_helpers/bilibili-page.ts`。
