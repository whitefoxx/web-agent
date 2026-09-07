# Site probes — reaching common sites to find BASE-capability gaps

This project does **not** ship or maintain per-site skills. Sites change
constantly; keeping a catalog of site extractors in sync is a maintenance
nightmare, and it is not our job — a user drives *their own* agent to work out a
site's specifics live, saves what works into *their own* skills directory, and
has that agent re-derive it when the site changes. What the project maintains is
the **base capabilities** (the generic tools + `eval_js` + the recon primitives +
the `click` write-guard) and a **small number of hints** (the `reach-a-site`
skill's one-liners).

This file is the other half of that bargain: a curated set of **probes** — real
tasks against common sites — run periodically to answer one question: *is the
base still good enough for an agent to reach these sites live?* Each probe
records the route that works, which base capability it exercises, and when it was
last confirmed on a real machine.

**How to read a failure.** A probe breaking is a signal to triage, not a bug to
patch by hand:

- **Site changed** (selectors moved, an endpoint shape shifted) → NOT our
  problem to fix here. Note it, update the recipe if you like, move on. Under our
  doctrine the user's own agent handles this class for their saved skills.
- **Base capability is missing/weak** (the primitive an agent would reach for
  cannot do the job — a recon tool can't see a structure, `eval_js` can't express
  the request, the write-guard over/under-fires) → THIS is a finding. Log it in
  `findings.md`, and it becomes base work.

The recipes below were verified on a real machine on the date shown. They are
kept compact — the point is the ROUTE and the base capability, not a maintained
extractor. They started life as pre-written skills in `web-tools-skills`; that
was the wrong shape (official per-site maintenance) and they were folded here.

## How to run

Drive the base tools against each site (via a shell over the WebCLI/localmd
Connect bridge, or by asking a KB agent that has the browser tools). Confirm the
route still yields real data, tick the result, and triage any failure per above.

## Probes

Legend: ✅ base sufficient · ❌ base gap (→ finding) · 🌐 site changed (recipe
stale, base fine) · 🔒 needs login · ⏭️ skipped

| Site | Task | Base capability exercised | Last verified | Result |
|---|---|---|---|---|
| YouTube | video transcript | `click` + `eval_js` (drive a rendered panel) | 2026-09-06 | ✅ |
| X / Twitter | a thread; own bookmarks | `eval_js` (authed same-origin GraphQL) | 2026-09-05 | ✅ |
| Reddit | thread + comments; search | `fetch_url` (hidden `.json`, cookies) | 2026-09-05 | ✅ |
| Zhihu | search; read an answer | `fetch_url` (hidden `api/v4` JSON + markdown fallback) | 2026-09-05 | ✅ |
| Bilibili | video subtitles | `fetch_url` (a 3-call authed JSON chain) | 2026-09-05 | ✅ |
| Claude.ai | list + read own chats | `fetch_url` (authed JSON, cookies) | 2026-09-05 | ✅ |
| ChatGPT | list + read own chats | `fetch_url` (authed JSON + a session bearer token) | 2026-09-05 | ✅ |
| Gemini | list + read own chats | `eval_js` (read a virtualized DOM) | 2026-09-05 | ✅ |

### YouTube — transcript · `click` + `eval_js`

The caption API is behind a proof-of-origin (`pot`) wall and captions are
service-worker-fetched, so neither `fetch_url` nor tab-level network capture sees
them. Route: open the watch page **active**, `click` "…more" → "Show transcript",
then `eval_js` the transcript panel rows — `ytd-transcript-segment-renderer`
(classic) or `transcript-segment-view-model` (newer `…modern_transcript…` panel).
Base capability: can the agent drive a rendered UI panel and read it. Verified:
21 rows off a 2:41 video (2026-09-06).

### X / Twitter — thread + bookmarks · authed `eval_js`

No open API; the web GraphQL works from an x.com tab with the user's `ct0` cookie
plus the public web bearer. `eval_js` a synchronous XHR: `TweetDetail`
(`variables.focalTweetId`) reads a thread, `Bookmarks` reads bookmarks (page with
the cursor), then reduce to rows **in the page**. Query ids rotate — pull the
current ones from a community config or the page's own client-web bundles. Base
capability: an authed same-origin request whose header comes from a cookie,
reduced in-page. Verified: `Bookmarks` 7 tweets, `TweetDetail` 30 (2026-09-05).

### Reddit — thread / search / listing · `fetch_url`

Append `.json` to almost any URL (`?raw_json=1` for unescaped text); cookies via
`fetch_url` reach private-subscribed content. Thread =
`/r/<SUB>/comments/<ID>.json`; search = `/search.json?q=`; listing =
`/r/<SUB>/hot.json`. Comments recurse via `data.replies`; `more` kinds hold the
collapsed tail. Base capability: a hidden-JSON endpoint over cookie-authed
`fetch_url`. Verified: a thread (post + 4 comments) + search (2026-09-05).

### Zhihu — search / answer / article · `fetch_url`

`api/v4/search_v3?t=general&q=` (search); `api/v4/answers/<id>?include=…content…`
and `api/v4/questions/<id>/answers` (content is HTML — strip tags). The article
API 403s — read `zhuanlan.zhihu.com/p/<id>` as markdown instead. `include` needs
the bracketed `data[*].content,voteup_count,author`, URL-encoded. Base
capability: hidden JSON + a markdown-render fallback when one endpoint is walled.
Verified: search → 5 results → one answer read back (2026-09-05).

### Bilibili — subtitles · `fetch_url` chain

Three cookie-authed calls, no tab: `bvid` from the URL →
`x/web-interface/view?bvid=` for `cid` + title → `x/player/wbi/v2?bvid=&cid=` for
`data.subtitle.subtitles[]` (the `wbi` field needs no signature) → fetch the
chosen `subtitle_url` (prefix `https:`) for `body:[{from,to,content}]`. Empty list
= no subtitles (don't invent). Base capability: chaining several authed JSON calls
where each feeds the next. Verified: `BV1GJ411x7h7` → 47 lines (2026-09-05). If a
future change rejects the unsigned `wbi` call, the `w_rid`/`wts` signature can be
computed in `eval_js` on a bilibili tab — a base-gap signal if it becomes needed.

### Claude.ai — own conversations · `fetch_url`

Cookie-authed JSON, no tab: `/api/organizations` → `[0].uuid` (personal org) →
`…/chat_conversations?limit=` (list) →
`…/chat_conversations/<id>?tree=True&rendering_mode=messages` (full;
`chat_messages[]` with `sender` human/assistant + `content[].text`). Base
capability: an authed JSON API reached purely by cookies. Verified: 3 chats → one
read back, 8 messages (2026-09-05).

### ChatGPT — own conversations · `fetch_url` + token

Like Claude.ai but with a short-lived bearer the session mints:
`/api/auth/session` → `accessToken` → `backend-api/conversations?…` (list) →
`backend-api/conversation/<id>` (a `mapping` tree; collect nodes with non-empty
`content.parts`, order by `create_time`). **The access token is a credential —
`Authorization` header only, NEVER written to the KB or a reply.** Base
capability: an authed JSON API needing a header token pulled from another call,
plus credential hygiene. Verified: token → 3 chats → one read back, 12 messages
(2026-09-05).

### Gemini — own conversations · `eval_js`

No API here: open `gemini.google.com/app` **active**, let it render, then
`eval_js` the sidebar links (`a[href*="/app/"]`) to list, navigate the SPA to one,
scroll the history container up to force virtualized turns in, and read
`user-query` / `model-response` custom elements (strip the "You said" / "Gemini
said" a11y prefixes). Base capability: reading a lazily-rendered, virtualized DOM
in an active tab. Verified: 5 chats → one read back with turns (2026-09-05).
