// ../browser-agent/opencli/clis/youtube/playlist.js
import { cli, Strategy } from "@jackwener/opencli/registry";

// ../browser-agent/opencli/clis/youtube/utils.js
async function prepareYoutubeApiPage(page) {
  await page.goto("https://www.youtube.com", { waitUntil: "none" });
  await page.wait(2);
}
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

// ../browser-agent/opencli/clis/youtube/playlist.js
import { CommandExecutionError, EmptyResultError } from "@jackwener/opencli/errors";
function parsePlaylistId(input) {
  if (!input.startsWith("http"))
    return input;
  try {
    const url = new URL(input);
    return url.searchParams.get("list") || input;
  } catch {
    return input;
  }
}
cli({
  site: "youtube",
  name: "playlist",
  access: "read",
  description: "Get YouTube playlist info and video list",
  domain: "www.youtube.com",
  strategy: Strategy.COOKIE,
  args: [
    { name: "id", required: true, positional: true, help: "Playlist URL or playlist ID (PLxxxxxx)" },
    { name: "limit", type: "int", default: 50, help: "Max videos to return (default 50, max 200)" }
  ],
  columns: ["rank", "title", "channel", "duration", "views", "published", "url"],
  func: async (page, kwargs) => {
    const playlistId = parsePlaylistId(String(kwargs.id));
    const limit = Math.min(kwargs.limit || 50, 200);
    await prepareYoutubeApiPage(page);
    const data = await page.evaluate(`
      (async () => {
        const cfg = window.ytcfg?.data_ || {};
        const apiKey = cfg.INNERTUBE_API_KEY;
        const context = cfg.INNERTUBE_CONTEXT;
        if (!apiKey || !context) return { error: 'YouTube config not found' };

        const browseId = 'VL' + ${JSON.stringify(playlistId)};
        const limit = ${limit};

        ${FETCH_BROWSE_FN}

        const data = await fetchBrowse(apiKey, { context, browseId });
        if (data.error) return data;

        const header = data.header?.pageHeaderRenderer;
        const title = header?.pageTitle || '';
        const metaRows = header?.content?.pageHeaderViewModel?.metadata?.contentMetadataViewModel?.metadataRows || [];
        const stats = metaRows.flatMap(r => (r.metadataParts || []).map(p => p.text?.content || '').filter(Boolean));

        const sidebarItems = data.sidebar?.playlistSidebarRenderer?.items || [];
        const secondaryInfo = sidebarItems.find(i => i.playlistSidebarSecondaryInfoRenderer)?.playlistSidebarSecondaryInfoRenderer;
        const channelName = secondaryInfo?.videoOwner?.videoOwnerRenderer?.title?.runs?.[0]?.text || '';

        const tabs = data.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
        let listContents = tabs[0]?.tabRenderer?.content?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents?.[0]?.playlistVideoListRenderer?.contents || [];

        const extractVideos = ${extractPlaylistVideos.toString()};

        let videos = extractVideos(listContents);

        let contItem = listContents[listContents.length - 1];
        while (videos.length < limit && contItem?.continuationItemRenderer) {
          const token = contItem.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
          if (!token) break;
          const contData = await fetchBrowse(apiKey, { context, continuation: token });
          if (contData.error) break;
          const newItems = contData.onResponseReceivedActions?.[0]?.appendContinuationItemsAction?.continuationItems || [];
          if (!newItems.length) break;
          videos = videos.concat(extractVideos(newItems));
          contItem = newItems[newItems.length - 1];
        }

        return { title, channelName, stats, videos: videos.slice(0, limit) };
      })()
    `);
    if (!data || typeof data !== "object") {
      throw new CommandExecutionError("Failed to fetch playlist data");
    }
    if (data.error) {
      throw new CommandExecutionError(String(data.error));
    }
    if (!data.videos?.length) {
      throw new EmptyResultError("youtube playlist");
    }
    const statsStr = (data.stats || []).join(" | ");
    process.stderr.write(`${data.title}  [${data.channelName}]  ${statsStr}
`);
    return data.videos;
  }
});
