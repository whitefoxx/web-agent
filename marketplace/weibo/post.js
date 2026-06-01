// ../browser-agent/opencli/clis/weibo/post.js
import { cli, Strategy } from "@jackwener/opencli/registry";
import { AuthRequiredError, CommandExecutionError } from "@jackwener/opencli/errors";
// ../browser-agent/opencli/clis/weibo/utils.js

function unwrapEvaluateResult(payload) {
  if (payload && !Array.isArray(payload) && typeof payload === "object" && "session" in payload && "data" in payload) {
    return payload.data;
  }
  return payload;
}
function requireObjectEvaluateResult(payload, label) {
  if (!payload || Array.isArray(payload) || typeof payload !== "object") {
    throw new CommandExecutionError(`${label} returned malformed extraction payload`);
  }
  return payload;
}

// ../browser-agent/opencli/clis/weibo/post.js
cli({
  site: "weibo",
  name: "post",
  access: "read",
  description: "Get a single Weibo post",
  domain: "weibo.com",
  strategy: Strategy.COOKIE,
  args: [
    { name: "id", required: true, positional: true, help: "Post ID (numeric idstr or mblogid from URL)" }
  ],
  columns: ["field", "value"],
  func: async (page, kwargs) => {
    await page.goto("https://weibo.com");
    await page.wait(2);
    const id = String(kwargs.id);
    const data = requireObjectEvaluateResult(unwrapEvaluateResult(await page.evaluate(`
      (async () => {
        const id = ${JSON.stringify(id)};
        const strip = (html) => (html || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();

        const resp = await fetch('/ajax/statuses/show?id=' + encodeURIComponent(id), {credentials: 'include'});
        if (!resp.ok) return {error: 'HTTP ' + resp.status};
        const s = await resp.json();
        if (!s.ok && !s.idstr) return {error: 'Post not found'};

        // Fetch long text if needed
        let fullText = s.text_raw || strip(s.text || '');
        if (s.isLongText || s.is_long_text) {
          try {
            const ltResp = await fetch('/ajax/statuses/longtext?id=' + s.idstr, {credentials: 'include'});
            if (ltResp.ok) {
              const lt = await ltResp.json();
              if (lt.data?.longTextContent) fullText = strip(lt.data.longTextContent);
            }
          } catch {}
        }

        const u = s.user || {};

        // Resolve image URLs. Weibo gives pic_ids (ordered) + pic_infos
        // (pic_id -> size variants). Pick the truest original available,
        // degrading gracefully. pic_infos/pic_ids can live on the long-text
        // object instead of the top level, so check both.
        const pickPic = (info) => {
          if (!info || typeof info !== 'object') return '';
          const v = info.largest || info.original || info.mw2000 || info.large || info.bmiddle || info.thumbnail;
          return (v && v.url) || '';
        };
        const collectPics = (obj) => {
          if (!obj || typeof obj !== 'object') return [];
          const infos = obj.pic_infos || (obj.longText && obj.longText.pic_infos) || {};
          const ids = obj.pic_ids || (obj.longText && obj.longText.pic_ids) || Object.keys(infos);
          return (Array.isArray(ids) ? ids : []).map((pid) => pickPic(infos[pid])).filter(Boolean);
        };
        const picUrls = collectPics(s);

        const result = {
          id: s.idstr || String(s.id),
          mblogid: s.mblogid,
          author: u.screen_name || '',
          text: fullText,
          created_at: s.created_at,
          source: strip(s.source || ''),
          reposts: s.reposts_count || 0,
          comments: s.comments_count || 0,
          likes: s.attitudes_count || 0,
          pic_count: s.pic_num || picUrls.length || 0,
          url: 'https://weibo.com/' + (u.id || '') + '/' + (s.mblogid || ''),
        };
        if (picUrls.length) result.pics = picUrls;

        if (s.retweeted_status) {
          const rt = s.retweeted_status;
          result.retweeted_from = (rt.user?.screen_name || '[deleted]');
          result.retweeted_text = rt.text_raw || strip(rt.text || '');
          const rtPics = collectPics(rt);
          if (rtPics.length) result.retweeted_pics = rtPics;
        }

        return result;
      })()
    `)), "weibo post");
    if (data.error)
      throw new CommandExecutionError(String(data.error));
    return Object.entries(data).map(([field, value]) => ({
      field,
      // Keep arrays (pics / retweeted_pics) as real arrays so they serialize to
      // the LLM as a JSON array, not a comma-joined string. Scalars stay strings
      // for the field/value table.
      value: Array.isArray(value) ? value : String(value)
    }));
  }
});
