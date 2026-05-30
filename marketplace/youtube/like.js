// ../browser-agent/opencli/clis/youtube/like.js
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
async function prepareYoutubeApiPage(page) {
  await page.goto("https://www.youtube.com", { waitUntil: "none" });
  await page.wait(2);
}
var SAPISID_HASH_FN = `
async function getSapisidHash(sapisid, origin) {
  if (!sapisid) return null;
  const time = Math.floor(Date.now() / 1000);
  const msgBuffer = new TextEncoder().encode(time + ' ' + sapisid + ' ' + origin);
  const hashBuffer = await crypto.subtle.digest('SHA-1', msgBuffer);
  const hashHex = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  return 'SAPISIDHASH ' + time + '_' + hashHex;
}
`;
async function readYoutubeSapisid(page) {
  const cookies = await page.getCookies({ url: "https://www.youtube.com" });
  return cookies.find((c) => c.name === "__Secure-3PAPISID")?.value || cookies.find((c) => c.name === "SAPISID")?.value || null;
}

// ../browser-agent/opencli/clis/youtube/like.js
import { CommandExecutionError, AuthRequiredError } from "@jackwener/opencli/errors";
cli({
  site: "youtube",
  name: "like",
  access: "write",
  description: "Like a YouTube video",
  domain: "www.youtube.com",
  strategy: Strategy.COOKIE,
  args: [
    { name: "url", required: true, positional: true, help: "YouTube video URL or video ID" }
  ],
  columns: ["status", "message"],
  func: async (page, kwargs) => {
    const videoId = parseVideoId(String(kwargs.url));
    await prepareYoutubeApiPage(page);
    const sapisid = await readYoutubeSapisid(page);
    if (!sapisid)
      throw new AuthRequiredError("www.youtube.com", "Not logged in (SAPISID cookie missing)");
    const result = await page.evaluate(`
      (async () => {
        ${SAPISID_HASH_FN}

        const cfg = window.ytcfg?.data_ || {};
        const apiKey = cfg.INNERTUBE_API_KEY;
        const context = cfg.INNERTUBE_CONTEXT;
        if (!apiKey || !context) return { error: 'config', message: 'YouTube config not found' };

        const authHash = await getSapisidHash(${JSON.stringify(sapisid)}, 'https://www.youtube.com');
        if (!authHash) return { error: 'auth', message: 'Not logged in (SAPISID cookie missing)' };

        const resp = await fetch('/youtubei/v1/like/like?key=' + apiKey + '&prettyPrint=false', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': authHash,
            'X-Origin': 'https://www.youtube.com',
          },
          body: JSON.stringify({ context, target: { videoId: ${JSON.stringify(videoId)} } }),
        });

        if (resp.status === 401 || resp.status === 403) return { error: 'auth', message: 'Not logged in' };
        if (!resp.ok) {
          const body = await resp.json().catch(() => ({}));
          const errStatus = body?.error?.status || '';
          if (errStatus === 'UNAUTHENTICATED') return { error: 'auth', message: 'Not logged in' };
          return { error: 'http', message: 'HTTP ' + resp.status + (errStatus ? ' ' + errStatus : '') };
        }
        return { ok: true };
      })()
    `);
    if (result?.error === "auth") {
      throw new AuthRequiredError("www.youtube.com");
    }
    if (result?.error) {
      throw new CommandExecutionError(result.message || "Failed to like video");
    }
    return [{ status: "success", message: "Liked: " + videoId }];
  }
});
