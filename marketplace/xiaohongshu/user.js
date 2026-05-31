// ../browser-agent/opencli/clis/xiaohongshu/user.js
import { cli, Strategy } from "@jackwener/opencli/registry";
import { CommandExecutionError, EmptyResultError } from "@jackwener/opencli/errors";

// ../browser-agent/opencli/clis/xiaohongshu/user-helpers.js
function toCleanString(value) {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}
function normalizeXhsUserId(input) {
  const trimmed = toCleanString(input);
  const withoutQuery = trimmed.replace(/[?#].*$/, "");
  const matched = withoutQuery.match(/\/user\/profile\/([a-zA-Z0-9]+)/);
  if (matched?.[1])
    return matched[1];
  return withoutQuery.replace(/\/+$/, "").split("/").pop() ?? withoutQuery;
}
function flattenXhsNoteGroups(noteGroups) {
  if (!Array.isArray(noteGroups))
    return [];
  const notes = [];
  for (const group of noteGroups) {
    if (!group)
      continue;
    if (Array.isArray(group)) {
      for (const item of group) {
        if (item)
          notes.push(item);
      }
      continue;
    }
    notes.push(group);
  }
  return notes;
}
function buildXhsNoteUrl(userId, noteId, xsecToken, webHost = "www.xiaohongshu.com") {
  const cleanUserId = toCleanString(userId);
  const cleanNoteId = toCleanString(noteId);
  if (!cleanUserId || !cleanNoteId)
    return "";
  const url = new URL(`https://${webHost}/user/profile/${cleanUserId}/${cleanNoteId}`);
  const cleanToken = toCleanString(xsecToken);
  if (cleanToken) {
    url.searchParams.set("xsec_token", cleanToken);
    url.searchParams.set("xsec_source", "pc_user");
  }
  return url.toString();
}
function extractXhsUserNotes(snapshot, fallbackUserId, webHost = "www.xiaohongshu.com") {
  const notes = flattenXhsNoteGroups(snapshot.noteGroups);
  const rows = [];
  const seen = /* @__PURE__ */ new Set();
  for (const entry of notes) {
    const noteCard = entry?.noteCard ?? entry?.note_card ?? entry;
    if (!noteCard || typeof noteCard !== "object")
      continue;
    const noteId = toCleanString(noteCard.noteId ?? noteCard.note_id ?? entry?.noteId ?? entry?.note_id ?? entry?.id);
    if (!noteId || seen.has(noteId))
      continue;
    seen.add(noteId);
    const userId = toCleanString(noteCard.user?.userId ?? noteCard.user?.user_id ?? fallbackUserId);
    const xsecToken = toCleanString(entry?.xsecToken ?? entry?.xsec_token ?? noteCard.xsecToken ?? noteCard.xsec_token);
    const likes = toCleanString(noteCard.interactInfo?.likedCount ?? noteCard.interact_info?.liked_count ?? 0) || "0";
    const cover = toCleanString(noteCard.cover?.urlDefault ?? noteCard.cover?.urlPre ?? noteCard.cover?.url ?? "");
    rows.push({
      id: noteId,
      title: toCleanString(noteCard.displayTitle ?? noteCard.display_title ?? noteCard.title),
      type: toCleanString(noteCard.type),
      likes,
      cover,
      url: buildXhsNoteUrl(userId || fallbackUserId, noteId, xsecToken, webHost)
    });
  }
  return rows;
}

// ../browser-agent/opencli/clis/xiaohongshu/user.js
var USER_SNAPSHOT_JS = `
    (() => {
      const safeClone = (value) => {
        try {
          return JSON.parse(JSON.stringify(value ?? null));
        } catch {
          return null;
        }
      };

      const userStore = window.__INITIAL_STATE__?.user;
      const hasUserStore = Boolean(userStore && typeof userStore === 'object');
      const rawNotes = hasUserStore ? (userStore.notes?._value || userStore.notes) : undefined;
      const rawPageData = hasUserStore ? (userStore.userPageData?._value || userStore.userPageData) : undefined;
      return {
        noteGroups: safeClone(rawNotes || []),
        pageData: safeClone(rawPageData || {}),
        storePresent: hasUserStore,
        notesPresent: Array.isArray(rawNotes),
        pageDataPresent: Boolean(rawPageData && typeof rawPageData === 'object' && Object.keys(rawPageData).length > 0),
      };
    })()
  `;
async function readUserSnapshot(page) {
  return await page.evaluate(USER_SNAPSHOT_JS);
}
function assertReadableUserSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new CommandExecutionError("Malformed Xiaohongshu user snapshot");
  }
  if (snapshot.storePresent !== true) {
    throw new CommandExecutionError("Malformed Xiaohongshu user snapshot: user store was not found");
  }
  if (snapshot.notesPresent !== true || !Array.isArray(snapshot.noteGroups)) {
    throw new CommandExecutionError("Malformed Xiaohongshu user snapshot: notes array was not found");
  }
}
var command = cli({
  site: "xiaohongshu",
  name: "user",
  access: "read",
  description: "Get public notes from a Xiaohongshu user profile",
  domain: "www.xiaohongshu.com",
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    { name: "id", type: "string", required: true, positional: true, help: "User id or profile URL" },
    { name: "limit", type: "int", default: 15, help: "Number of notes to return" }
  ],
  columns: ["id", "title", "type", "likes", "url"],
  func: async (page, kwargs) => {
    const userId = normalizeXhsUserId(String(kwargs.id));
    const limit = Math.max(1, Number(kwargs.limit ?? 15));
    await page.goto(`https://www.xiaohongshu.com/user/profile/${userId}`);
    let snapshot = await readUserSnapshot(page);
    assertReadableUserSnapshot(snapshot);
    let results = extractXhsUserNotes(snapshot ?? {}, userId);
    let previousCount = results.length;
    for (let i = 0; results.length < limit && i < 4; i += 1) {
      await page.autoScroll({ times: 1, delayMs: 1500 });
      await page.wait(1);
      snapshot = await readUserSnapshot(page);
      assertReadableUserSnapshot(snapshot);
      const nextResults = extractXhsUserNotes(snapshot ?? {}, userId);
      if (nextResults.length <= previousCount)
        break;
      results = nextResults;
      previousCount = nextResults.length;
    }
    if (results.length === 0) {
      throw new EmptyResultError("xiaohongshu user", "该用户没有公开笔记（可能销号 / 私密 / 全部删除）。");
    }
    return results.slice(0, limit);
  }
});
export {
  USER_SNAPSHOT_JS,
  assertReadableUserSnapshot,
  command
};
