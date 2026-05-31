// ../browser-agent/opencli/clis/youtube/subscribe.js
import { cli, Strategy } from "@jackwener/opencli/registry";

// ../browser-agent/opencli/clis/youtube/utils.js
async function prepareYoutubeApiPage(page) {
  await page.goto("https://www.youtube.com", { waitUntil: "none" });
  await page.wait(2);
}
var RESOLVE_CHANNEL_HANDLE_FN = `
async function resolveChannelHandle(input, apiKey, context) {
  if (!input.startsWith('@')) return input;
  const resp = await fetch('/youtubei/v1/navigation/resolve_url?key=' + apiKey + '&prettyPrint=false', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ context, url: 'https://www.youtube.com/' + input }),
  });
  if (!resp.ok) return input;
  const data = await resp.json().catch(() => ({}));
  return data.endpoint?.browseEndpoint?.browseId || input;
}
`;
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

// ../browser-agent/opencli/clis/youtube/subscribe.js
import { CommandExecutionError, AuthRequiredError } from "@jackwener/opencli/errors";
cli({
  site: "youtube",
  name: "subscribe",
  access: "write",
  description: "Subscribe to a YouTube channel",
  domain: "www.youtube.com",
  strategy: Strategy.COOKIE,
  args: [
    { name: "channel", required: true, positional: true, help: "Channel ID (UCxxxx) or handle (@name)" }
  ],
  columns: ["status", "message"],
  func: async (page, kwargs) => {
    const channelInput = String(kwargs.channel);
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

        ${RESOLVE_CHANNEL_HANDLE_FN}

        let channelId = ${JSON.stringify(channelInput)};
        channelId = await resolveChannelHandle(channelId, apiKey, context);

        if (!channelId.startsWith('UC')) {
          return { error: 'arg', message: 'Could not resolve channel ID from: ' + ${JSON.stringify(channelInput)} };
        }

        const resp = await fetch('/youtubei/v1/subscription/subscribe?key=' + apiKey + '&prettyPrint=false', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': authHash,
            'X-Origin': 'https://www.youtube.com',
          },
          body: JSON.stringify({ context, channelIds: [channelId] }),
        });

        if (resp.status === 401 || resp.status === 403) return { error: 'auth', message: 'Not logged in' };
        if (!resp.ok) {
          const body = await resp.json().catch(() => ({}));
          const errStatus = body?.error?.status || '';
          if (errStatus === 'UNAUTHENTICATED') return { error: 'auth', message: 'Not logged in' };
          return { error: 'http', message: 'HTTP ' + resp.status + (errStatus ? ' ' + errStatus : '') };
        }
        return { ok: true, channelId };
      })()
    `);
    if (result?.error === "auth") {
      throw new AuthRequiredError("www.youtube.com");
    }
    if (result?.error) {
      throw new CommandExecutionError(result.message || "Failed to subscribe");
    }
    return [{ status: "success", message: "Subscribed to: " + (result.channelId || channelInput) }];
  }
});
