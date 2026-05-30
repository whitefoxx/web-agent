// ../browser-agent/opencli/clis/weibo/feed.js
import { cli, Strategy } from "@jackwener/opencli/registry";

// ../browser-agent/opencli/clis/weibo/utils.js
import { AuthRequiredError, CommandExecutionError } from "@jackwener/opencli/errors";
function unwrapEvaluateResult(payload) {
  if (payload && !Array.isArray(payload) && typeof payload === "object" && "session" in payload && "data" in payload) {
    return payload.data;
  }
  return payload;
}
function requireArrayEvaluateResult(payload, label) {
  if (!Array.isArray(payload)) {
    if (payload && typeof payload === "object" && "error" in payload) {
      throw new CommandExecutionError(`${label}: ${String(payload.error)}`);
    }
    throw new CommandExecutionError(`${label} returned malformed extraction payload`);
  }
  return payload;
}
async function getSelfUid(page) {
  const uid = unwrapEvaluateResult(await page.evaluate(`
    (() => {
      const app = document.querySelector('#app')?.__vue_app__;
      const store = app?.config?.globalProperties?.$store;
      const uid = store?.state?.config?.config?.uid;
      if (uid) return String(uid);
      return null;
    })()
  `));
  if (uid)
    return uid;
  const config = unwrapEvaluateResult(await page.evaluate(`
    (async () => {
      const resp = await fetch('/ajax/config/get_config', {credentials: 'include'});
      if (!resp.ok) return null;
      const data = await resp.json();
      return data.ok && data.data?.uid ? String(data.data.uid) : null;
    })()
  `));
  if (config)
    return config;
  throw new AuthRequiredError("weibo.com");
}

// ../browser-agent/opencli/clis/weibo/feed.js
var TIMELINE_ENDPOINTS = {
  "for-you": "unreadfriendstimeline",
  following: "friendstimeline"
};
cli({
  site: "weibo",
  name: "feed",
  access: "read",
  description: "Fetch Weibo timeline (for-you or following)",
  domain: "weibo.com",
  strategy: Strategy.COOKIE,
  args: [
    {
      name: "type",
      default: "for-you",
      choices: ["for-you", "following"],
      help: "Timeline type: for-you (algorithmic) or following (chronological)"
    },
    { name: "limit", type: "int", default: 15, help: "Number of posts (max 50)" }
  ],
  columns: ["id", "author", "text", "reposts", "comments", "likes", "time", "url"],
  func: async (page, kwargs) => {
    const count = Math.min(kwargs.limit || 15, 50);
    const timelineType = kwargs.type === "following" ? "following" : "for-you";
    const endpoint = TIMELINE_ENDPOINTS[timelineType];
    await page.goto("https://weibo.com");
    await page.wait(2);
    const uid = await getSelfUid(page);
    const data = requireArrayEvaluateResult(unwrapEvaluateResult(await page.evaluate(`
      (async () => {
        const uid = ${JSON.stringify(uid)};
        const count = ${count};
        const endpoint = ${JSON.stringify(endpoint)};
        const listId = '10001' + uid;
        const strip = (html) => (html || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();

        const resp = await fetch('/ajax/feed/' + endpoint + '?list_id=' + listId + '&refresh=4&since_id=0&count=' + count, { credentials: 'include' });
        if (!resp.ok) return { error: 'HTTP ' + resp.status };
        const data = await resp.json();
        if (!data.ok) return { error: 'API error: ' + (data.msg || 'unknown') };

        return (data.statuses || []).slice(0, count).map(s => {
          const u = s.user || {};
          const item = {
            id: s.mblogid || s.idstr || String(s.id || ''),
            author: u.screen_name || '',
            text: (s.text_raw || strip(s.text || '')).substring(0, 200),
            reposts: s.reposts_count || 0,
            comments: s.comments_count || 0,
            likes: s.attitudes_count || 0,
            time: s.created_at || '',
            url: 'https://weibo.com/' + (u.id || '') + '/' + (s.mblogid || ''),
          };
          if (s.retweeted_status) {
            const rt = s.retweeted_status;
            item.retweeted = (rt.user?.screen_name || '[deleted]') + ': ' + (rt.text_raw || strip(rt.text || '')).substring(0, 100);
          }
          return item;
        });
      })()
    `)), "weibo feed");
    return data;
  }
});
