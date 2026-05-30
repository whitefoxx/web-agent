// ../browser-agent/opencli/clis/youtube/video.js
import { cli, Strategy } from "@jackwener/opencli/registry";

// ../browser-agent/opencli/clis/youtube/utils.js
function parseVideoId(input) {
  if (!input.startsWith("http"))
    return input;
  try {
    const parsed = new URL(input);
    if (parsed.searchParams.has("v")) {
      return parsed.searchParams.get("v");
    }
    if (parsed.hostname === "youtu.be") {
      return parsed.pathname.slice(1).split("/")[0];
    }
    const pathMatch = parsed.pathname.match(/^\/(shorts|embed|live|v)\/([^/?]+)/);
    if (pathMatch)
      return pathMatch[2];
  } catch {
  }
  return input;
}
function extractJsonAssignmentFromHtml(html, keys) {
  const candidates = Array.isArray(keys) ? keys : [keys];
  for (const key of candidates) {
    const markers = [
      `var ${key} = `,
      `window["${key}"] = `,
      `window.${key} = `,
      `${key} = `
    ];
    for (const marker of markers) {
      const markerIndex = html.indexOf(marker);
      if (markerIndex === -1)
        continue;
      const jsonStart = html.indexOf("{", markerIndex + marker.length);
      if (jsonStart === -1)
        continue;
      let depth = 0;
      let inString = false;
      let escaping = false;
      for (let i = jsonStart; i < html.length; i += 1) {
        const ch = html[i];
        if (inString) {
          if (escaping) {
            escaping = false;
          } else if (ch === "\\") {
            escaping = true;
          } else if (ch === '"') {
            inString = false;
          }
          continue;
        }
        if (ch === '"') {
          inString = true;
          continue;
        }
        if (ch === "{") {
          depth += 1;
          continue;
        }
        if (ch === "}") {
          depth -= 1;
          if (depth === 0) {
            try {
              return JSON.parse(html.slice(jsonStart, i + 1));
            } catch {
              break;
            }
          }
        }
      }
    }
  }
  return null;
}
async function prepareYoutubeApiPage(page) {
  await page.goto("https://www.youtube.com", { waitUntil: "none" });
  await page.wait(2);
}

// ../browser-agent/opencli/clis/youtube/video.js
import { CommandExecutionError } from "@jackwener/opencli/errors";
cli({
  site: "youtube",
  name: "video",
  access: "read",
  description: "Get YouTube video metadata (title, views, description, etc.)",
  domain: "www.youtube.com",
  strategy: Strategy.COOKIE,
  args: [
    { name: "url", required: true, positional: true, help: "YouTube video URL or video ID" }
  ],
  columns: ["field", "value"],
  func: async (page, kwargs) => {
    const videoId = parseVideoId(kwargs.url);
    await prepareYoutubeApiPage(page);
    const data = await page.evaluate(`
      (async () => {
        const extractJsonAssignmentFromHtml = ${extractJsonAssignmentFromHtml.toString()};

        const watchResp = await fetch('/watch?v=' + encodeURIComponent(${JSON.stringify(videoId)}), {
          credentials: 'include',
        });
        if (!watchResp.ok) return { error: 'Watch HTML returned HTTP ' + watchResp.status };

        const html = await watchResp.text();
        const player = extractJsonAssignmentFromHtml(html, 'ytInitialPlayerResponse');
        const yt = extractJsonAssignmentFromHtml(html, 'ytInitialData');
        if (!player) return { error: 'ytInitialPlayerResponse not found in watch HTML' };

        const details = player.videoDetails || {};
        const microformat = player.microformat?.playerMicroformatRenderer || {};
        const contents = yt?.contents?.twoColumnWatchNextResults?.results?.results?.contents || [];

        // Try to get full description from watch bootstrap data
        let fullDescription = details.shortDescription || '';
        try {
          if (contents) {
            for (const c of contents) {
              const desc = c.videoSecondaryInfoRenderer?.attributedDescription?.content;
              if (desc) { fullDescription = desc; break; }
            }
          }
        } catch {}

        // Get like count if available
        let likes = '';
        try {
          if (contents) {
            for (const c of contents) {
              const buttons = c.videoPrimaryInfoRenderer?.videoActions
                ?.menuRenderer?.topLevelButtons;
              if (buttons) {
                for (const b of buttons) {
                  const toggle = b.segmentedLikeDislikeButtonViewModel
                    ?.likeButtonViewModel?.likeButtonViewModel?.toggleButtonViewModel
                    ?.toggleButtonViewModel?.defaultButtonViewModel?.buttonViewModel;
                  if (toggle?.title) { likes = toggle.title; break; }
                }
              }
            }
          }
        } catch {}

        // Get publish date
        const publishDate = microformat.publishDate
          || microformat.uploadDate
          || details.publishDate || '';

        // Get category
        const category = microformat.category || '';

        // Get channel subscriber count if available
        let subscribers = '';
        try {
          if (contents) {
            for (const c of contents) {
              const owner = c.videoSecondaryInfoRenderer?.owner
                ?.videoOwnerRenderer?.subscriberCountText?.simpleText;
              if (owner) { subscribers = owner; break; }
            }
          }
        } catch {}

        return {
          title: details.title || '',
          channel: details.author || '',
          channelId: details.channelId || '',
          videoId: details.videoId || '',
          views: details.viewCount || '',
          likes,
          subscribers,
          duration: details.lengthSeconds ? details.lengthSeconds + 's' : '',
          publishDate,
          category,
          description: fullDescription,
          keywords: (details.keywords || []).join(', '),
          isLive: details.isLiveContent || false,
          thumbnail: details.thumbnail?.thumbnails?.slice(-1)?.[0]?.url || '',
        };
      })()
    `);
    if (!data || typeof data !== "object")
      throw new CommandExecutionError("Failed to extract video metadata from page");
    if (data.error)
      throw new CommandExecutionError(data.error);
    return Object.entries(data).map(([field, value]) => ({
      field,
      value: String(value)
    }));
  }
});
