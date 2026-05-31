// ../browser-agent/opencli/clis/linkedin/salesnav-thread.js
import { Strategy, cli } from "@jackwener/opencli/registry";
import { ArgumentError, AuthRequiredError, CommandExecutionError, EmptyResultError } from "@jackwener/opencli/errors";
// ../browser-agent/opencli/clis/linkedin/salesnav-inbox.js

var LINKEDIN_DOMAIN = "www.linkedin.com";
var SALES_INBOX_URL = "https://www.linkedin.com/sales/inbox/";
var THREADS_BASE = "https://www.linkedin.com/sales-api/salesApiMessagingThreads";
var PAGE_SIZE = 20;
var DEFAULT_LIMIT = 40;
var MAX_LIMIT = 500;
var THREAD_DECORATION = "(id,restrictions,archived,unreadMessageCount,nextPageStartsAt,totalMessageCount,messages*(id,type,contentFlag,deliveredAt,lastEditedAt,subject,body,footerText,blockCopy,attachments,author,systemMessageContent),participants*~fs_salesProfile(entityUrn,firstName,lastName,fullName,degree,profilePictureDisplayImage,objectUrn,inmailRestriction))";
function normalizeWhitespace(value) {
  return String(value ?? "").replace(/[\u00a0\u202f]/g, " ").replace(/\s+/g, " ").trim();
}
function parseLimit(value, defaultValue = DEFAULT_LIMIT) {
  if (value === void 0 || value === null || value === "") return defaultValue;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new ArgumentError(`--limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return limit;
}
function unwrapEvaluateResult(payload) {
  if (payload && typeof payload === "object" && "data" in payload && "session" in payload) return payload.data;
  return payload;
}
function encodeRestliDecoration(value) {
  return encodeURIComponent(value).replace(/\(/g, "%28").replace(/\)/g, "%29");
}
function salesnavThreadUrl(threadId) {
  return threadId ? `https://www.linkedin.com/sales/inbox/${encodeURIComponent(threadId)}` : "";
}
function threadListUrl({ count = PAGE_SIZE, pageStartsAt = "" } = {}) {
  let url = `${THREADS_BASE}?decoration=${encodeRestliDecoration(THREAD_DECORATION)}&count=${count}&filter=INBOX&q=filter`;
  if (pageStartsAt) url += `&pageStartsAt=${encodeURIComponent(pageStartsAt)}`;
  return url;
}
function getThreadParticipants(thread) {
  const resolution = thread?.participantsResolutionResults || {};
  const participants = Array.isArray(thread?.participants) ? thread.participants : Object.keys(resolution);
  return participants.map((urn) => resolution[urn] || { entityUrn: urn }).filter(Boolean);
}
function isSelfParticipant(profile) {
  const degree = String(profile?.degree ?? "").trim();
  return degree === "0";
}
function otherParticipantName(thread) {
  const participants = getThreadParticipants(thread);
  const other = participants.find((p) => !isSelfParticipant(p)) || participants[0];
  return normalizeWhitespace(other?.fullName || [other?.firstName, other?.lastName].filter(Boolean).join(" "));
}
function parseSalesnavThreads(json) {
  if (!json || typeof json !== "object" || !Array.isArray(json.elements)) {
    throw new CommandExecutionError("Sales Navigator messaging threads API returned malformed payload");
  }
  return json.elements.map((thread) => {
    if (!thread || typeof thread !== "object") {
      throw new CommandExecutionError("Sales Navigator messaging threads API returned malformed thread row");
    }
    const messages = Array.isArray(thread?.messages) ? thread.messages : [];
    const lastMessage = messages[0] || {};
    const deliveredAt = Number(lastMessage.deliveredAt || thread?.nextPageStartsAt || 0);
    const threadId = normalizeWhitespace(thread?.id || "");
    if (!threadId) {
      throw new CommandExecutionError("Sales Navigator messaging thread row missing id");
    }
    return {
      thread_id: threadId,
      thread_url: salesnavThreadUrl(threadId),
      person_name: otherParticipantName(thread),
      last_message_snippet: normalizeWhitespace(lastMessage.body || lastMessage.subject || "").slice(0, 300),
      last_activity_time: deliveredAt ? new Date(deliveredAt).toISOString() : "",
      unread: Number(thread?.unreadMessageCount || 0) > 0,
      unread_count: Number(thread?.unreadMessageCount || 0),
      total_message_count: Number(thread?.totalMessageCount || messages.length || 0),
      archived: Boolean(thread?.archived),
      next_page_starts_at: normalizeWhitespace(thread?.nextPageStartsAt || ""),
      participants: getThreadParticipants(thread).map((p) => ({
        name: normalizeWhitespace(p.fullName || [p.firstName, p.lastName].filter(Boolean).join(" ")),
        entity_urn: normalizeWhitespace(p.entityUrn || ""),
        object_urn: normalizeWhitespace(p.objectUrn || ""),
        degree: normalizeWhitespace(p.degree ?? "")
      }))
    };
  });
}
function fetchJsonScript(url, csrf) {
  return String.raw`(async () => {
    try {
      const res = await fetch(${JSON.stringify(url)}, {
        credentials: 'include',
        headers: {
          'csrf-token': ${JSON.stringify(csrf)},
          'x-restli-protocol-version': '2.0.0',
          accept: 'application/json',
        },
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
      if (res.status === 401 || res.status === 403) return { authRequired: true, status: res.status, text };
      if (!res.ok) return { error: 'HTTP ' + res.status, status: res.status, text, json };
      return { status: res.status, json };
    } catch (e) {
      return { error: 'fetch failed: ' + ((e && e.message) || String(e)) };
    }
  })()`;
}
async function getCsrf(page) {
  const cookies = await page.getCookies({ url: "https://www.linkedin.com" });
  const jsession = cookies.find((c) => c.name === "JSESSIONID")?.value;
  if (!jsession) throw new AuthRequiredError(LINKEDIN_DOMAIN, "LinkedIn JSESSIONID cookie not found. Please sign in to LinkedIn.");
  return jsession.replace(/^\"|\"$/g, "");
}
async function fetchSalesnavJson(page, csrf, url, label) {
  const result = unwrapEvaluateResult(await page.evaluate(fetchJsonScript(url, csrf)));
  if (result?.authRequired) throw new AuthRequiredError(LINKEDIN_DOMAIN, `${label} authentication failed (HTTP ${result.status || "auth_required"}).`);
  if (result?.error || !result?.json) throw new CommandExecutionError(`${label} returned an unexpected response`, `${result?.error || "no_json"}
${normalizeWhitespace(result?.text || "").slice(0, 500)}`);
  return result.json;
}
async function fetchInboxRows(page, { limit = DEFAULT_LIMIT, maxPages = 30 } = {}) {
  const csrf = await getCsrf(page);
  const rows = [];
  const seen = /* @__PURE__ */ new Set();
  let pageStartsAt = "";
  let pagesFetched = 0;
  let hasMorePages = false;
  while (rows.length < limit && pagesFetched < maxPages) {
    const json = await fetchSalesnavJson(page, csrf, threadListUrl({ count: PAGE_SIZE, pageStartsAt }), "Sales Navigator messaging threads API");
    pagesFetched += 1;
    const pageRows = parseSalesnavThreads(json);
    if (pageRows.length === 0) break;
    for (const row of pageRows) {
      if (seen.has(row.thread_id)) continue;
      seen.add(row.thread_id);
      rows.push(row);
      if (rows.length >= limit) break;
    }
    const last = pageRows[pageRows.length - 1];
    const next = last?.next_page_starts_at;
    hasMorePages = Boolean(next);
    if (!next) break;
    if (next === pageStartsAt) {
      throw new CommandExecutionError("Sales Navigator messaging threads API returned the same cursor twice");
    }
    pageStartsAt = next;
  }
  if (rows.length < limit && hasMorePages && pagesFetched >= maxPages) {
    throw new CommandExecutionError(`Sales Navigator messaging threads API reached the ${maxPages}-page safety cap before collecting ${limit} conversations`);
  }
  return rows.slice(0, limit).map((row, index) => ({ ...row, rank: index + 1 }));
}
cli({
  site: "linkedin",
  name: "salesnav-inbox",
  access: "read",
  description: "List LinkedIn Sales Navigator message conversations with API pagination",
  domain: LINKEDIN_DOMAIN,
  strategy: Strategy.UI,
  browser: true,
  args: [
    { name: "limit", type: "number", default: DEFAULT_LIMIT, help: "Maximum conversations to return (1-500)" },
    { name: "max-pages", type: "number", default: 30, help: "Maximum Sales Navigator API pages to fetch" },
    { name: "unread-only", type: "bool", default: false, help: "Return only unread conversations" }
  ],
  columns: ["rank", "thread_id", "thread_url", "person_name", "last_message_snippet", "last_activity_time", "unread", "unread_count", "total_message_count", "archived", "participants", "next_page_starts_at"],
  func: async (page, args) => {
    if (!page) throw new CommandExecutionError("Browser session required for linkedin salesnav-inbox");
    const limit = parseLimit(args.limit);
    const maxPages = parseLimit(args["max-pages"], 30);
    await page.goto(SALES_INBOX_URL);
    await page.wait(4);
    let rows = await fetchInboxRows(page, { limit, maxPages });
    if (args["unread-only"]) rows = rows.filter((row) => row.unread);
    if (rows.length === 0) {
      if (args["unread-only"]) return [];
      throw new EmptyResultError("linkedin salesnav-inbox", "No Sales Navigator conversations were found.");
    }
    return rows.slice(0, limit).map((row, index) => ({ ...row, rank: index + 1 }));
  }
});

// ../browser-agent/opencli/clis/linkedin/salesnav-thread.js
var LINKEDIN_DOMAIN2 = "www.linkedin.com";
var SALES_INBOX_URL2 = "https://www.linkedin.com/sales/inbox/";
var DEFAULT_MESSAGE_LIMIT = 200;
var THREAD_PAGE_SIZE = 20;
function isLinkedInHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "linkedin.com" || host.endsWith(".linkedin.com");
}
function parseSalesProfileUrn(value) {
  const raw = normalizeWhitespace(value);
  const match = raw.match(/^urn:li:fs_salesProfile:\(([^,()]+),([^,()]+),([^,()]+)\)$/);
  if (!match) return "";
  const parts = [match[1], match[2], match[3]].map((part) => normalizeWhitespace(part).toLowerCase());
  if (parts.some((part) => !part || part === "undefined" || part === "null" || part === "not_available")) return "";
  return raw;
}
function parseThreadInput(value) {
  const raw = normalizeWhitespace(value);
  if (!raw) return ["empty", ""];
  if (/^2-[A-Za-z0-9+/=_-]+$/.test(raw)) return ["thread_id", raw];
  if (/^urn:li:fs_salesProfile:\(/.test(raw)) {
    const urn = parseSalesProfileUrn(raw);
    if (!urn) throw new ArgumentError("Sales Navigator recipient urn must be urn:li:fs_salesProfile:(profileId,authType,authToken)");
    return ["recipient_urn", urn];
  }
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.port || !isLinkedInHost(url.hostname)) return ["name", raw.toLowerCase()];
    const inboxMatch = url.pathname.match(/^\/sales\/inbox\/([^/]+)\/?$/i);
    if (inboxMatch) return ["thread_id", decodeURIComponent(inboxMatch[1])];
    const leadMatch = url.pathname.match(/^\/sales\/lead\/([^,/]+),([^,/]+),([^/]+)\/?$/i);
    if (leadMatch) {
      const urn = `urn:li:fs_salesProfile:(${decodeURIComponent(leadMatch[1])},${decodeURIComponent(leadMatch[2])},${decodeURIComponent(leadMatch[3])})`;
      if (!parseSalesProfileUrn(urn)) {
        throw new ArgumentError("Sales Navigator lead URL must contain resolved profileId, authType, and authToken");
      }
      return ["recipient_urn", urn];
    }
  } catch (err) {
    if (err instanceof ArgumentError) throw err;
  }
  return ["name", raw.toLowerCase()];
}
function salesnavThreadUrl2(threadId) {
  return threadId ? `https://www.linkedin.com/sales/inbox/${encodeURIComponent(threadId)}` : "";
}
function threadApiUrl(threadId, messageCount) {
  return `${THREADS_BASE}/${encodeURIComponent(threadId)}?decoration=${encodeRestliDecoration(THREAD_DECORATION)}&count=1&messageCount=${messageCount}`;
}
function participantName(profile) {
  return normalizeWhitespace(profile?.fullName || [profile?.firstName, profile?.lastName].filter(Boolean).join(" "));
}
function participantIndex(thread) {
  const resolution = thread?.participantsResolutionResults || {};
  const participants = Array.isArray(thread?.participants) ? thread.participants : Object.keys(resolution);
  const byUrn = /* @__PURE__ */ new Map();
  for (const urn of participants) {
    const profile = resolution[urn] || { entityUrn: urn };
    byUrn.set(urn, profile);
  }
  return byUrn;
}
function parseSalesnavThreadMessages(thread) {
  if (!thread || typeof thread !== "object") {
    throw new CommandExecutionError("Sales Navigator messaging thread API returned malformed payload");
  }
  const threadId = normalizeWhitespace(thread?.id || "");
  if (!threadId) {
    throw new CommandExecutionError("Sales Navigator messaging thread API returned a thread without id");
  }
  if (!Array.isArray(thread?.messages)) {
    throw new CommandExecutionError("Sales Navigator messaging thread API returned malformed messages");
  }
  const byUrn = participantIndex(thread);
  const messages = thread.messages;
  const rows = messages.map((message) => {
    if (!message || typeof message !== "object") {
      throw new CommandExecutionError("Sales Navigator messaging thread API returned malformed message row");
    }
    const deliveredAt = Number(message?.deliveredAt || 0);
    const senderProfile = byUrn.get(message?.author);
    return {
      message_id: normalizeWhitespace(message?.id || ""),
      thread_id: threadId,
      sender: participantName(senderProfile) || normalizeWhitespace(message?.author || ""),
      sender_urn: normalizeWhitespace(message?.author || ""),
      text: normalizeWhitespace(message?.body || message?.systemMessageContent || ""),
      subject: normalizeWhitespace(message?.subject || ""),
      timestamp: deliveredAt ? new Date(deliveredAt).toISOString() : "",
      delivered_at: deliveredAt || "",
      type: normalizeWhitespace(message?.type || "")
    };
  }).filter((row) => row.text || row.subject || row.message_id);
  rows.sort((a, b) => Number(a.delivered_at || 0) - Number(b.delivered_at || 0));
  return rows.map((row, index) => ({ index, ...row }));
}
function threadMatchesInput(row, parsed) {
  if (!row || !parsed) return false;
  const [kind, criterion] = parsed;
  if (kind === "thread_id") return row.thread_id === criterion;
  if (kind === "recipient_urn") {
    return (row.participants || []).some((p) => normalizeWhitespace(p.entity_urn) === criterion);
  }
  if (kind === "name") {
    const needle = normalizeWhitespace(criterion).toLowerCase();
    if (!needle) return false;
    if (normalizeWhitespace(row.person_name).toLowerCase() === needle) return true;
    return (row.participants || []).some((p) => normalizeWhitespace(p.name).toLowerCase() === needle);
  }
  return false;
}
async function resolveThreadId(page, input, { maxPages = 30 } = {}) {
  const parsed = parseThreadInput(input);
  if (parsed[0] === "empty") throw new ArgumentError("thread or recipient is required");
  if (parsed[0] === "thread_id") return parsed[1];
  const inboxRows = await fetchInboxRows(page, { limit: 500, maxPages });
  const match = inboxRows.find((row) => threadMatchesInput(row, parsed));
  if (!match) {
    throw new EmptyResultError("linkedin salesnav-thread", `No Sales Navigator thread matched ${input}`);
  }
  return match.thread_id;
}
async function fetchThreadWithPagination(page, csrf, threadId, limit = DEFAULT_MESSAGE_LIMIT) {
  let requested = THREAD_PAGE_SIZE;
  if (limit < requested) requested = limit;
  let thread = null;
  for (let attempts = 0; attempts < 30; attempts += 1) {
    thread = await fetchSalesnavJson(page, csrf, threadApiUrl(threadId, requested), "Sales Navigator messaging thread API");
    const total2 = Number(thread?.totalMessageCount || 0);
    const have2 = Array.isArray(thread?.messages) ? thread.messages.length : 0;
    if (have2 >= limit || total2 && have2 >= total2 || requested >= limit) break;
    let nextRequested = requested + THREAD_PAGE_SIZE;
    if (total2 && total2 > nextRequested) nextRequested = total2;
    if (nextRequested > limit) nextRequested = limit;
    requested = nextRequested;
  }
  const total = Number(thread?.totalMessageCount || 0);
  const have = Array.isArray(thread?.messages) ? thread.messages.length : 0;
  if (total && have < total && have < limit) {
    throw new CommandExecutionError(`Sales Navigator messaging thread API returned partial history (${have}/${total})`);
  }
  return thread;
}
cli({
  site: "linkedin",
  name: "salesnav-thread",
  access: "read",
  description: "Return full Sales Navigator message history for a thread id, Sales Navigator inbox URL, lead URL, recipient urn, or exact recipient name",
  domain: LINKEDIN_DOMAIN2,
  strategy: Strategy.UI,
  browser: true,
  args: [
    { name: "thread-or-recipient", type: "string", required: true, positional: true, help: "Sales Navigator inbox URL/thread id, Sales Navigator lead URL, recipient urn, or exact participant name" },
    { name: "limit", type: "number", default: DEFAULT_MESSAGE_LIMIT, help: "Maximum messages to return (1-500)" },
    { name: "max-pages", type: "number", default: 30, help: "Maximum inbox pages to scan when resolving a recipient" }
  ],
  columns: ["index", "thread_id", "thread_url", "sender", "text", "timestamp", "subject", "message_id", "sender_urn", "delivered_at", "type", "total_message_count"],
  func: async (page, args) => {
    if (!page) throw new CommandExecutionError("Browser session required for linkedin salesnav-thread");
    const input = normalizeWhitespace(args["thread-or-recipient"]);
    if (!input) throw new ArgumentError("thread-or-recipient is required");
    const limit = parseLimit(args.limit, DEFAULT_MESSAGE_LIMIT);
    const maxPages = parseLimit(args["max-pages"], 30);
    await page.goto(SALES_INBOX_URL2);
    await page.wait(4);
    const threadId = await resolveThreadId(page, input, { maxPages });
    const csrf = await getCsrf(page);
    const thread = await fetchThreadWithPagination(page, csrf, threadId, limit);
    const messages = parseSalesnavThreadMessages(thread).slice(0, limit);
    if (messages.length === 0) throw new EmptyResultError("linkedin salesnav-thread", `No messages found for ${threadId}`);
    return messages.map((message) => ({
      ...message,
      thread_url: salesnavThreadUrl2(threadId),
      total_message_count: Number(thread?.totalMessageCount || messages.length)
    }));
  }
});
var __test__ = {
  parseThreadInput,
  threadApiUrl,
  participantIndex,
  parseSalesnavThreadMessages,
  threadMatchesInput,
  salesnavThreadUrl: salesnavThreadUrl2
};
export {
  __test__
};
