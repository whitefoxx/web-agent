// ../browser-agent/opencli/clis/youtube/watch-later.js
import { cli, Strategy } from "@jackwener/opencli/registry";

// ../browser-agent/opencli/clis/youtube/utils.js
var FETCH_BROWSE_FN = `
async function fetchBrowse(apiKey, body) {
  const resp = await fetch('/youtubei/v1/browse?key=' + apiKey + '&prettyPrint=false', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) return { error: 'InnerTube browse API returned HTTP ' + resp.status };
  return resp.json();
}
`;
function extractPlaylistVideos(items) {
  return items.filter((i) => i.playlistVideoRenderer).map((i) => {
    const v = i.playlistVideoRenderer;
    const infoRuns = v.videoInfo?.runs || [];
    return {
      rank: parseInt(v.index?.simpleText || "0", 10),
      title: v.title?.runs?.[0]?.text || "",
      channel: v.shortBylineText?.runs?.[0]?.text || "",
      duration: v.lengthText?.simpleText || "",
      views: infoRuns[0]?.text || "",
      published: infoRuns[2]?.text || "",
      url: "https://www.youtube.com/watch?v=" + v.videoId
    };
  });
}

// ../browser-agent/opencli/clis/youtube/watch-later.js
import { CommandExecutionError, EmptyResultError } from "@jackwener/opencli/errors";
cli({
  site: "youtube",
  name: "watch-later",
  access: "read",
  description: "Get your YouTube Watch Later queue",
  domain: "www.youtube.com",
  strategy: Strategy.COOKIE,
  args: [
    { name: "limit", type: "int", default: 50, help: "Max videos to return (default 50, max 200)" }
  ],
  columns: ["rank", "title", "channel", "duration", "views", "published", "url"],
  func: async (page, kwargs) => {
    const limit = Math.min(kwargs.limit || 50, 200);
    await page.goto("https://www.youtube.com/playlist?list=WL");
    await page.wait(3);
    const data = await page.evaluate(`
      (async () => {
        const d = window.ytInitialData;
        if (!d) return { error: 'YouTube data not found — are you logged in?' };

        const limit = ${limit};
        const cfg = window.ytcfg?.data_ || {};
        const apiKey = cfg.INNERTUBE_API_KEY;
        const context = cfg.INNERTUBE_CONTEXT;

        const header = d.header?.playlistHeaderRenderer;
        const title = header?.title?.simpleText || 'Watch Later';
        const stats = (header?.stats || [])
          .map(s => s.runs?.map(r => r.text)?.join('') || s.simpleText || '')
          .filter(Boolean);

        const tabs = d.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
        let listContents = tabs[0]?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents?.[0]?.playlistVideoListRenderer?.contents || [];

        ${FETCH_BROWSE_FN}

        const extractVideos = ${extractPlaylistVideos.toString()};

        let videos = extractVideos(listContents);

        let contItem = listContents[listContents.length - 1];
        while (videos.length < limit && contItem?.continuationItemRenderer && apiKey && context) {
          const token = contItem.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
          if (!token) break;
          const contData = await fetchBrowse(apiKey, { context, continuation: token });
          if (contData.error) break;
          const newItems = contData.onResponseReceivedActions?.[0]?.appendContinuationItemsAction?.continuationItems || [];
          if (!newItems.length) break;
          videos = videos.concat(extractVideos(newItems));
          contItem = newItems[newItems.length - 1];
        }

        return { title, stats, videos: videos.slice(0, limit) };
      })()
    `);
    if (!data || typeof data !== "object") {
      throw new CommandExecutionError("Failed to fetch Watch Later — make sure you are logged into YouTube");
    }
    if (data.error) {
      throw new CommandExecutionError(String(data.error));
    }
    if (!data.videos?.length) {
      throw new EmptyResultError("youtube watch-later");
    }
    const statsStr = (data.stats || []).join(" | ");
    process.stderr.write(`${data.title}  ${statsStr}
`);
    return data.videos;
  }
});
