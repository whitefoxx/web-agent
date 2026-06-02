// ../browser-agent/opencli/clis/xiaohongshu/creator-notes-summary.js
import { Strategy, cli } from "@jackwener/opencli/registry";
import { CommandExecutionError, EmptyResultError } from "@jackwener/opencli/errors";
// ../browser-agent/opencli/clis/xiaohongshu/creator-notes.js

var DATE_LINE_RE = /^发布于 (\d{4}年\d{2}月\d{2}日 \d{2}:\d{2})$/;
var METRIC_LINE_RE = /^\d+$/;
var VISIBILITY_LINE_RE = /可见$/;
var NOTE_ANALYZE_API_PATH = "/api/galaxy/creator/datacenter/note/analyze/list";
var NOTE_ANALYZE_PAGE_SIZE = 10;
var CAPTURE_POLL_ATTEMPTS = 20;
var CAPTURE_POLL_INTERVAL_S = 0.5;
var NOTE_DETAIL_PAGE_URL = "https://creator.xiaohongshu.com/statistics/note-detail";
var NOTE_ID_HTML_RE = /&quot;noteId&quot;:&quot;([0-9a-f]{24})&quot;/g;
function buildNoteDetailUrl(noteId) {
  return noteId ? `${NOTE_DETAIL_PAGE_URL}?noteId=${encodeURIComponent(noteId)}` : "";
}
function formatPostTime(ts) {
  if (!ts)
    return "";
  const date = new Date(ts + 8 * 36e5);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}年${pad(date.getUTCMonth() + 1)}月${pad(date.getUTCDate())}日 ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}
function parseCreatorNotesText(bodyText) {
  const lines = bodyText.split("\n").map((line) => line.trim()).filter(Boolean);
  const results = [];
  const seen = /* @__PURE__ */ new Set();
  for (let i = 0; i < lines.length; i++) {
    const dateMatch = lines[i].match(DATE_LINE_RE);
    if (!dateMatch)
      continue;
    let titleIndex = i - 1;
    while (titleIndex >= 0 && VISIBILITY_LINE_RE.test(lines[titleIndex]))
      titleIndex--;
    if (titleIndex < 0)
      continue;
    const title = lines[titleIndex];
    const metrics = [];
    let cursor = i + 1;
    while (cursor < lines.length && METRIC_LINE_RE.test(lines[cursor]) && metrics.length < 5) {
      metrics.push(parseInt(lines[cursor], 10));
      cursor++;
    }
    if (metrics.length < 4)
      continue;
    const key = `${title}@@${dateMatch[1]}`;
    if (seen.has(key))
      continue;
    seen.add(key);
    results.push({
      id: "",
      title,
      date: dateMatch[1],
      views: metrics[0] ?? 0,
      likes: metrics[2] ?? 0,
      collects: metrics[3] ?? 0,
      comments: metrics[1] ?? 0,
      url: ""
    });
    i = cursor - 1;
  }
  return results;
}
function parseCreatorNoteIdsFromHtml(bodyHtml) {
  const ids = [];
  const seen = /* @__PURE__ */ new Set();
  for (const match of bodyHtml.matchAll(NOTE_ID_HTML_RE)) {
    const id = match[1];
    if (!id || seen.has(id))
      continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}
function mapDomCards(cards) {
  return cards.map((card) => ({
    id: card.id,
    title: card.title,
    date: card.date,
    views: card.metrics[0] ?? 0,
    likes: card.metrics[2] ?? 0,
    collects: card.metrics[3] ?? 0,
    comments: card.metrics[1] ?? 0,
    url: buildNoteDetailUrl(card.id)
  }));
}
function mapAnalyzeItems(items) {
  return (items ?? []).map((item) => ({
    id: item.id ?? "",
    title: item.title ?? "",
    date: formatPostTime(item.post_time),
    views: item.read_count ?? 0,
    likes: item.like_count ?? 0,
    collects: item.fav_count ?? 0,
    comments: item.comment_count ?? 0,
    url: buildNoteDetailUrl(item.id)
  }));
}
function unwrapEvaluateResult(payload) {
  if (payload && typeof payload === "object" && !Array.isArray(payload) && "session" in payload && "data" in payload) {
    return payload.data;
  }
  return payload;
}
async function installXhsFetchCaptureHook(page) {
  await page.evaluate(`(() => {
    window.__xhsCapture = {};
    if (window.__xhsCaptureInstalled) return;
    window.__xhsCaptureInstalled = true;
    const origFetch = window.fetch;
    window.fetch = async function(...args) {
      const resp = await origFetch.apply(this, args);
      try {
        const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
        if (url.includes('/api/galaxy/')) {
          resp.clone().text().then((body) => {
            try { window.__xhsCapture[url] = { status: resp.status, ok: resp.ok, body }; } catch (_) {}
          }).catch(() => {});
        }
      } catch (_) {}
      return resp;
    };
    const OrigXHR = window.XMLHttpRequest;
    function HookedXHR() {
      const xhr = new OrigXHR();
      const origOpen = xhr.open;
      let capturedUrl = '';
      xhr.open = function(method, url, ...rest) {
        capturedUrl = url;
        return origOpen.call(this, method, url, ...rest);
      };
      xhr.addEventListener('load', () => {
        try {
          if (capturedUrl.includes('/api/galaxy/')) {
            window.__xhsCapture[capturedUrl] = { status: xhr.status, ok: xhr.status >= 200 && xhr.status < 300, body: xhr.responseText };
          }
        } catch (_) {}
      });
      return xhr;
    }
    HookedXHR.prototype = OrigXHR.prototype;
    for (const key of ['UNSENT', 'OPENED', 'HEADERS_RECEIVED', 'LOADING', 'DONE']) {
      if (key in OrigXHR) HookedXHR[key] = OrigXHR[key];
    }
    window.XMLHttpRequest = HookedXHR;
  })()`);
}
function parseCaptureMapPayload(raw) {
  const payload = unwrapEvaluateResult(raw);
  if (typeof payload === "string") {
    try {
      return JSON.parse(payload);
    } catch {
      return {};
    }
  }
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return payload;
  }
  return {};
}
function getAnalyzeListPageNumber(url) {
  try {
    const parsed = new URL(url, "https://creator.xiaohongshu.com");
    const pageNum2 = Number.parseInt(parsed.searchParams.get("page_num") || "", 10);
    if (Number.isFinite(pageNum2) && pageNum2 > 0)
      return pageNum2;
  } catch {
  }
  const match = String(url || "").match(/[?&]page_num=(\d+)/);
  const pageNum = Number.parseInt(match?.[1] || "", 10);
  return Number.isFinite(pageNum) && pageNum > 0 ? pageNum : Number.MAX_SAFE_INTEGER;
}
function harvestAnalyzeListCaptures(captureMap) {
  const items = [];
  const seen = /* @__PURE__ */ new Set();
  let total = 0;
  const entries = Object.entries(captureMap).filter(([url]) => url.includes("/note/analyze/list")).sort(([a], [b]) => getAnalyzeListPageNumber(a) - getAnalyzeListPageNumber(b));
  for (const [url, capture] of entries) {
    if (!capture?.ok) continue;
    try {
      const json = JSON.parse(capture.body);
      const data = json?.data ?? {};
      if (typeof data.total === "number" && data.total > total) total = data.total;
      for (const note of data.note_infos ?? []) {
        if (!note?.id || seen.has(note.id)) continue;
        seen.add(note.id);
        items.push(note);
      }
    } catch {
    }
  }
  return { items, total };
}
function isAnalyzeCaptureComplete(items, total, limit) {
  if (total <= 0)
    return true;
  return items.length >= Math.min(total, limit);
}
async function pollCaptureMap(page) {
  let captureMap = {};
  for (let i = 0; i < CAPTURE_POLL_ATTEMPTS; i++) {
    await page.wait(CAPTURE_POLL_INTERVAL_S);
    const raw = await page.evaluate("JSON.stringify(window.__xhsCapture || {})");
    captureMap = parseCaptureMapPayload(raw);
    if (Object.keys(captureMap).some((url) => url.includes("/note/analyze/list"))) break;
  }
  return captureMap;
}
async function fetchNoteManagerTitleMap(page, neededCount) {
  const map = /* @__PURE__ */ new Map();
  const scrapeCards = async () => {
    const cards = unwrapEvaluateResult(await page.evaluate(`() => {
      const noteIdRe = /"noteId":"([0-9a-f]{24})"/;
      return Array.from(document.querySelectorAll('div.note[data-impression], div.note')).map((card) => {
        const impression = card.getAttribute('data-impression') || '';
        const id = impression.match(noteIdRe)?.[1] || '';
        const title = (card.querySelector('.title, .raw')?.innerText || '').trim();
        return { id, title };
      }).filter((entry) => entry.id && entry.title);
    }`));
    for (const card of Array.isArray(cards) ? cards : []) {
      if (!map.has(card.id)) map.set(card.id, card.title);
    }
  };
  const scrollInnerListToBottom = async () => {
    return unwrapEvaluateResult(await page.evaluate(`(() => {
      const firstCard = document.querySelector('div.note[data-impression]');
      let el = firstCard && firstCard.parentElement;
      while (el) {
        const s = window.getComputedStyle(el);
        if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 10) {
          el.scrollTop = el.scrollHeight;
          return true;
        }
        el = el.parentElement;
      }
      return false;
    })()`));
  };
  try {
    await page.goto("https://creator.xiaohongshu.com/new/note-manager");
    for (let i = 0; i < 12; i++) {
      await page.wait(1);
      await scrapeCards();
      if (map.size >= neededCount) return map;
      await scrollInnerListToBottom();
    }
    return map;
  } catch {
    return map;
  }
}
async function fetchCreatorNotesByCapture(page, limit) {
  await page.goto("https://creator.xiaohongshu.com/statistics");
  await installXhsFetchCaptureHook(page);
  await page.evaluate(`(() => {
    history.pushState({}, '', '/statistics/data-analysis?source=official');
    window.dispatchEvent(new PopStateEvent('popstate'));
  })()`);
  let captureMap = await pollCaptureMap(page);
  let { items, total } = harvestAnalyzeListCaptures(captureMap);
  if (items.length === 0) return [];
  const totalPages = total > 0 ? Math.ceil(total / NOTE_ANALYZE_PAGE_SIZE) : 1;
  const neededPages = Math.min(totalPages, Math.ceil(limit / NOTE_ANALYZE_PAGE_SIZE));
  for (let pageNum = 2; pageNum <= neededPages && items.length < limit; pageNum++) {
    const clicked = unwrapEvaluateResult(await page.evaluate(`(() => {
      const target = String(${pageNum});
      // .d-pagination-page renders the page number doubled (a visible span +
      // an accessibility span), so textContent for page 2 reads "22". Match
      // both the raw digit and the doubled form to tolerate either render.
      const btns = Array.from(document.querySelectorAll('.d-pagination-page'));
      const match = btns.find((btn) => {
        const text = (btn.textContent || '').trim();
        return text === target || text === target + target;
      });
      if (match) { match.click(); return true; }
      return false;
    })()`));
    if (!clicked) break;
    const before = items.length;
    let advanced = false;
    for (let attempt = 0; attempt < CAPTURE_POLL_ATTEMPTS; attempt++) {
      await page.wait(CAPTURE_POLL_INTERVAL_S);
      const raw = await page.evaluate("JSON.stringify(window.__xhsCapture || {})");
      captureMap = parseCaptureMapPayload(raw);
      const harvested = harvestAnalyzeListCaptures(captureMap);
      if (harvested.items.length > before) {
        items = harvested.items;
        total = Math.max(total, harvested.total);
        advanced = true;
        break;
      }
    }
    if (!advanced) break;
  }
  if (!isAnalyzeCaptureComplete(items, total, limit)) {
    throw new CommandExecutionError(`xiaohongshu creator-notes: captured ${items.length} of ${Math.min(total, limit)} expected analyze rows; refusing partial results`);
  }
  const notes = mapAnalyzeItems(items).slice(0, limit);
  const missingTitles = notes.filter((note) => !note.title).length;
  if (missingTitles > 0) {
    const titleMap = await fetchNoteManagerTitleMap(page, notes.length);
    for (const note of notes) {
      if (!note.title && note.id && titleMap.has(note.id)) {
        note.title = titleMap.get(note.id);
      }
    }
  }
  return notes;
}
async function fetchCreatorNotesByApi(page, limit) {
  const pageSize = Math.min(Math.max(limit, 10), 20);
  const maxPages = Math.max(1, Math.ceil(limit / pageSize));
  const notes = [];
  await page.goto(`https://creator.xiaohongshu.com/statistics/data-analysis?type=0&page_size=${pageSize}&page_num=1`);
  for (let pageNum = 1; pageNum <= maxPages && notes.length < limit; pageNum++) {
    const apiPath = `${NOTE_ANALYZE_API_PATH}?type=0&page_size=${pageSize}&page_num=${pageNum}`;
    const fetched = await page.evaluate(`
      async () => {
        try {
          const resp = await fetch(${JSON.stringify(apiPath)}, { credentials: 'include' });
          if (!resp.ok) return { error: 'HTTP ' + resp.status };
          return await resp.json();
        } catch (e) {
          return { error: e?.message ?? String(e) };
        }
      }
    `);
    let items = fetched?.data?.note_infos ?? [];
    if (!items.length) {
      await page.installInterceptor(NOTE_ANALYZE_API_PATH);
      await page.evaluate(`
        async () => {
          try {
            await fetch(${JSON.stringify(apiPath)}, { credentials: 'include' });
          } catch {}
          return true;
        }
      `);
      await page.wait(1);
      const intercepted = await page.getInterceptedRequests();
      const data = intercepted.find((entry) => Array.isArray(entry?.data?.note_infos));
      items = data?.data?.note_infos ?? [];
    }
    if (!items.length)
      break;
    notes.push(...mapAnalyzeItems(items));
    if (items.length < pageSize)
      break;
  }
  return notes.slice(0, limit);
}
async function fetchCreatorNotes(page, limit) {
  let notes = [];
  // Trampoline idempotency: page.goto re-executes the whole func from the top
  // after reinjection, so the leading capture (/statistics) + API
  // (/statistics/data-analysis) fallbacks would ping-pong against the final
  // DOM-scrape goto to /new/note-manager. Once a replay already sits on
  // /new/note-manager those leading fallbacks yield empty notes anyway, so skip
  // straight to the DOM-scrape block below. See adapter-hot-plug.md §10.21.
  const currentUrl = await page.getCurrentUrl().catch(() => "");
  if (!/\/new\/note-manager/.test(currentUrl)) {
    try {
      notes = await fetchCreatorNotesByCapture(page, limit);
    } catch (error) {
      if (error instanceof CommandExecutionError) throw error;
    }
    if (notes.length === 0) {
      notes = await fetchCreatorNotesByApi(page, limit);
    }
  }
  if (notes.length === 0) {
    await page.goto("https://creator.xiaohongshu.com/new/note-manager");
    const maxPageDowns = Math.max(0, Math.ceil(limit / 10) + 1);
    for (let i = 0; i <= maxPageDowns; i++) {
      const domCards = await page.evaluate(`() => {
        const noteIdRe = /"noteId":"([0-9a-f]{24})"/;
        return Array.from(document.querySelectorAll('div.note[data-impression], div.note')).map((card) => {
          const impression = card.getAttribute('data-impression') || '';
          const id = impression.match(noteIdRe)?.[1] || '';
          const title = (card.querySelector('.title, .raw')?.innerText || '').trim();
          const dateText = (card.querySelector('.time_status, .time')?.innerText || '').trim();
          const date = dateText.replace(/^发布于\\s*/, '');
          const metrics = Array.from(card.querySelectorAll('.icon_list .icon'))
            .map((el) => parseInt((el.innerText || '').trim(), 10))
            .filter((value) => Number.isFinite(value));
          return { id, title, date, metrics };
        });
      }`);
      const parsedDomNotes = mapDomCards(Array.isArray(domCards) ? domCards : []).filter((note) => note.title && note.date);
      if (parsedDomNotes.length > 0) {
        notes = parsedDomNotes;
      }
      if (notes.length >= limit || notes.length > 0 && i === 0)
        break;
      const body = await page.evaluate("() => ({ text: document.body.innerText, html: document.body.innerHTML })");
      const bodyText = typeof body?.text === "string" ? body.text : "";
      const bodyHtml = typeof body?.html === "string" ? body.html : "";
      const parsedNotes = parseCreatorNotesText(bodyText);
      const noteIds = parseCreatorNoteIdsFromHtml(bodyHtml);
      notes = parsedNotes.map((note, index) => {
        const id = noteIds[index] ?? "";
        return {
          ...note,
          id,
          url: buildNoteDetailUrl(id)
        };
      });
      if (notes.length >= limit || i === maxPageDowns)
        break;
      await page.pressKey("PageDown");
      await page.wait(1);
    }
  }
  return notes.slice(0, limit);
}
cli({
  site: "xiaohongshu",
  name: "creator-notes",
  access: "read",
  description: "小红书创作者笔记列表 + 每篇数据 (标题/日期/观看/点赞/收藏/评论)",
  domain: "creator.xiaohongshu.com",
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    { name: "limit", type: "int", default: 20, help: "Number of notes to return" }
  ],
  columns: ["rank", "id", "title", "date", "views", "likes", "collects", "comments", "url"],
  func: async (page, kwargs) => {
    const limit = kwargs.limit || 20;
    const notes = await fetchCreatorNotes(page, limit);
    if (!Array.isArray(notes) || notes.length === 0) {
      throw new EmptyResultError("xiaohongshu creator-notes", "No notes found. Ensure you are logged into creator.xiaohongshu.com and the account has published notes.");
    }
    return notes.slice(0, limit).map((n, i) => ({
      rank: i + 1,
      id: n.id,
      title: n.title,
      date: n.date,
      views: n.views,
      likes: n.likes,
      collects: n.collects,
      comments: n.comments,
      url: n.url
    }));
  }
});

// ../browser-agent/opencli/clis/xiaohongshu/creator-note-detail.js

var NOTE_DETAIL_DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
var NOTE_DETAIL_METRICS = [
  { label: "曝光数", section: "基础数据" },
  { label: "观看数", section: "基础数据" },
  { label: "封面点击率", section: "基础数据" },
  { label: "平均观看时长", section: "基础数据" },
  { label: "涨粉数", section: "基础数据" },
  { label: "点赞数", section: "互动数据" },
  { label: "评论数", section: "互动数据" },
  { label: "收藏数", section: "互动数据" },
  { label: "分享数", section: "互动数据" }
];
var NOTE_DETAIL_METRIC_LABELS = new Set(NOTE_DETAIL_METRICS.map((metric) => metric.label));
var NOTE_DETAIL_SECTIONS = new Set(NOTE_DETAIL_METRICS.map((metric) => metric.section));
var NOTE_DETAIL_NOISE_LINES = /* @__PURE__ */ new Set([
  "切换笔记",
  "笔记诊断",
  "核心数据",
  "观看来源",
  "观众画像",
  "提升建议",
  "基础数据",
  "互动数据",
  "导出数据",
  "实时",
  "按小时",
  "按天"
]);
function findNoteTitle(lines) {
  const detailIndex = lines.indexOf("笔记数据详情");
  if (detailIndex < 0)
    return "";
  for (let i = detailIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.startsWith("#") || NOTE_DETAIL_DATETIME_RE.test(line))
      continue;
    if (NOTE_DETAIL_NOISE_LINES.has(line))
      continue;
    return line;
  }
  return "";
}
function findMetricValue(lines, startIndex) {
  let value = "";
  let extra = "";
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line)
      continue;
    if (NOTE_DETAIL_METRIC_LABELS.has(line))
      break;
    if (NOTE_DETAIL_NOISE_LINES.has(line) || line.startsWith("数据更新至") || line.startsWith("部分数据统计中"))
      continue;
    if (!value) {
      value = line;
      continue;
    }
    if (!extra && line.startsWith("粉丝")) {
      extra = line;
      break;
    }
    if (line === "0" || /^\d/.test(line) || line.endsWith("%") || line.endsWith("秒")) {
      break;
    }
  }
  return { value, extra };
}
function findPublishedAt(text) {
  const match = text.match(/\b\d{4}-\d{2}-\d{2} \d{2}:\d{2}\b/);
  return match?.[0] ?? "";
}
function parseCreatorNoteDetailText(bodyText, noteId) {
  const lines = bodyText.split("\n").map((line) => line.trim()).filter(Boolean);
  const title = findNoteTitle(lines);
  const publishedAt = lines.find((line) => NOTE_DETAIL_DATETIME_RE.test(line)) ?? "";
  const rows = [
    { section: "笔记信息", metric: "note_id", value: noteId, extra: "" },
    { section: "笔记信息", metric: "title", value: title, extra: "" },
    { section: "笔记信息", metric: "published_at", value: publishedAt, extra: "" }
  ];
  for (const metric of NOTE_DETAIL_METRICS) {
    const index = lines.indexOf(metric.label);
    if (index < 0)
      continue;
    const { value, extra } = findMetricValue(lines, index);
    rows.push({
      section: metric.section,
      metric: metric.label,
      value,
      extra
    });
  }
  return rows;
}
function parseCreatorNoteDetailDomData(dom, noteId) {
  if (!dom)
    return [];
  const title = typeof dom.title === "string" ? dom.title.trim() : "";
  const infoText = typeof dom.infoText === "string" ? dom.infoText : "";
  const sections = Array.isArray(dom.sections) ? dom.sections : [];
  const rows = [
    { section: "笔记信息", metric: "note_id", value: noteId, extra: "" },
    { section: "笔记信息", metric: "title", value: title, extra: "" },
    { section: "笔记信息", metric: "published_at", value: findPublishedAt(infoText), extra: "" }
  ];
  for (const section of sections) {
    if (!NOTE_DETAIL_SECTIONS.has(section.title))
      continue;
    for (const metric of section.metrics) {
      if (!NOTE_DETAIL_METRIC_LABELS.has(metric.label))
        continue;
      rows.push({
        section: section.title,
        metric: metric.label,
        value: metric.value,
        extra: metric.extra
      });
    }
  }
  const hasMetric = rows.some((row) => row.section !== "笔记信息" && row.value);
  return hasMetric ? rows : [];
}
function toPercentString(value) {
  return value == null ? "" : `${value}%`;
}
function appendAudienceSourceRows(rows, payload) {
  const sourceItems = payload?.audienceSource?.source ?? [];
  for (const item of sourceItems) {
    if (!item.title)
      continue;
    const extras = [];
    if (item.info?.imp_count != null)
      extras.push(`曝光 ${item.info.imp_count}`);
    if (item.info?.view_count != null)
      extras.push(`观看 ${item.info.view_count}`);
    if (item.info?.interaction_count != null)
      extras.push(`互动 ${item.info.interaction_count}`);
    rows.push({
      section: "观看来源",
      metric: item.title,
      value: toPercentString(item.value_with_double),
      extra: extras.join(" · ")
    });
  }
  return rows;
}
function appendAudiencePortraitGroup(rows, groupLabel, items) {
  for (const item of items ?? []) {
    if (!item.title)
      continue;
    rows.push({
      section: "观众画像",
      metric: `${groupLabel}/${item.title}`,
      value: toPercentString(item.value),
      extra: ""
    });
  }
  return rows;
}
function appendAudienceRows(rows, payload) {
  appendAudienceSourceRows(rows, payload);
  appendAudiencePortraitGroup(rows, "性别", payload?.audienceSourceDetail?.gender);
  appendAudiencePortraitGroup(rows, "年龄", payload?.audienceSourceDetail?.age);
  appendAudiencePortraitGroup(rows, "城市", payload?.audienceSourceDetail?.city);
  appendAudiencePortraitGroup(rows, "兴趣", payload?.audienceSourceDetail?.interest);
  return rows;
}
function formatTrendTimestamp(ts, granularity) {
  if (!ts)
    return "";
  const CST_OFFSET_MS = 8 * 60 * 60 * 1e3;
  const cstDate = new Date(ts + CST_OFFSET_MS);
  const pad = (value) => String(value).padStart(2, "0");
  if (granularity === "hour") {
    return `${pad(cstDate.getUTCMonth() + 1)}-${pad(cstDate.getUTCDate())} ${pad(cstDate.getUTCHours())}:00`;
  }
  return `${cstDate.getUTCFullYear()}-${pad(cstDate.getUTCMonth() + 1)}-${pad(cstDate.getUTCDate())}`;
}
function formatTrendSeries(points, granularity) {
  if (!points?.length)
    return "";
  return points.map((point) => {
    const label = formatTrendTimestamp(point.date, granularity);
    const value = point.count_with_double ?? point.count;
    return label && value != null ? `${label}=${value}` : "";
  }).filter(Boolean).join(" | ");
}
var TREND_SERIES_CONFIG = [
  { key: "imp_list", label: "曝光数" },
  { key: "view_list", label: "观看数" },
  { key: "view_time_list", label: "平均观看时长" },
  { key: "like_list", label: "点赞数" },
  { key: "comment_list", label: "评论数" },
  { key: "collect_list", label: "收藏数" },
  { key: "share_list", label: "分享数" },
  { key: "rise_fans_list", label: "涨粉数" }
];
function appendTrendRows(rows, payload) {
  if (payload?.audienceTrend?.no_data_tip_msg) {
    rows.push({
      section: "趋势说明",
      metric: "观众趋势",
      value: payload.audienceTrend.no_data ? "暂不可用" : "可用",
      extra: payload.audienceTrend.no_data_tip_msg
    });
  }
  const buckets = [
    { label: "按小时", granularity: "hour", data: payload?.noteBase?.hour },
    { label: "按天", granularity: "day", data: payload?.noteBase?.day }
  ];
  for (const bucket of buckets) {
    for (const series of TREND_SERIES_CONFIG) {
      const points = bucket.data?.[series.key];
      const formatted = formatTrendSeries(points, bucket.granularity);
      if (!formatted)
        continue;
      rows.push({
        section: "趋势数据",
        metric: `${bucket.label}/${series.label}`,
        value: `${points.length} points`,
        extra: formatted
      });
    }
  }
  return rows;
}
var DETAIL_API_ENDPOINTS = [
  { suffix: "/api/galaxy/creator/datacenter/note/base", key: "noteBase" },
  { suffix: "/api/galaxy/creator/datacenter/note/analyze/audience/trend", key: "audienceTrend" },
  { suffix: "/api/galaxy/creator/datacenter/note/audience/source/detail", key: "audienceSourceDetail" },
  { suffix: "/api/galaxy/creator/datacenter/note/audience/source", key: "audienceSource" }
];
var CAPTURE_POLL_ATTEMPTS2 = 20;
var CAPTURE_POLL_INTERVAL_S2 = 0.5;
function detailApiEndpointForUrl(url) {
  if (!url)
    return null;
  try {
    const parsed = new URL(String(url), "https://creator.xiaohongshu.com");
    return DETAIL_API_ENDPOINTS.find((endpoint) => parsed.pathname === endpoint.suffix) ?? null;
  } catch {
    return null;
  }
}
function findCapturedUrl(captureMap, suffix) {
  return Object.keys(captureMap).find((url) => detailApiEndpointForUrl(url)?.suffix === suffix);
}
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function assertOptionalArray(payload, key, suffix) {
  if (key in payload && !Array.isArray(payload[key])) {
    throw new CommandExecutionError(`xiaohongshu creator-note-detail: signed API ${suffix} returned malformed ${key}`);
  }
}
function assertOptionalPlainObject(payload, key, suffix) {
  if (key in payload && !isPlainObject(payload[key])) {
    throw new CommandExecutionError(`xiaohongshu creator-note-detail: signed API ${suffix} returned malformed ${key}`);
  }
}
function validateCapturedPayload(payload, endpoint) {
  const suffix = endpoint.suffix;
  if (!isPlainObject(payload)) {
    throw new CommandExecutionError(`xiaohongshu creator-note-detail: signed API ${suffix} returned a malformed payload`);
  }
  if (endpoint.key === "noteBase") {
    assertOptionalPlainObject(payload, "hour", suffix);
    assertOptionalPlainObject(payload, "day", suffix);
  }
  if (endpoint.key === "audienceSource") {
    assertOptionalArray(payload, "source", suffix);
  }
  if (endpoint.key === "audienceSourceDetail") {
    for (const key of ["gender", "age", "city", "interest"]) {
      assertOptionalArray(payload, key, suffix);
    }
  }
  return payload;
}
function parseCapturedJson(capture, endpoint) {
  const suffix = endpoint.suffix;
  if (!capture || typeof capture !== "object") {
    throw new CommandExecutionError(`xiaohongshu creator-note-detail: malformed capture for ${suffix}`);
  }
  if (capture.ok !== true) {
    throw new CommandExecutionError(`xiaohongshu creator-note-detail: signed API ${suffix} returned HTTP ${capture.status ?? "non-2xx"}`);
  }
  if (typeof capture.body !== "string") {
    throw new CommandExecutionError(`xiaohongshu creator-note-detail: signed API ${suffix} returned a non-text body`);
  }
  try {
    const envelope = JSON.parse(capture.body);
    const payload = isPlainObject(envelope) && Object.hasOwn(envelope, "data") ? envelope.data : envelope;
    return validateCapturedPayload(payload, endpoint);
  } catch {
    throw new CommandExecutionError(`xiaohongshu creator-note-detail: signed API ${suffix} returned invalid JSON or payload shape`);
  }
}
async function installXhsFetchCaptureHook2(page) {
  await page.evaluate(`(() => {
    const targetPaths = ${JSON.stringify(DETAIL_API_ENDPOINTS.map((endpoint) => endpoint.suffix))};
    const shouldCapture = (url) => {
      try {
        return targetPaths.includes(new URL(String(url), window.location.origin).pathname);
      } catch (_) {
        return false;
      }
    };
    // Reset the buffer every call so stale captures from a previous run on
    // the same tab cannot leak into the current navigation's harvest.
    window.__xhsCapture = {};
    if (window.__xhsCaptureInstalled) return;
    window.__xhsCaptureInstalled = true;
    const origFetch = window.fetch;
    window.fetch = async function(...args) {
      const resp = await origFetch.apply(this, args);
      try {
        const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
        if (shouldCapture(url)) {
          resp.clone().text().then((body) => {
            try { window.__xhsCapture[url] = { status: resp.status, ok: resp.ok, body }; } catch (_) {}
          }).catch(() => {});
        }
      } catch (_) {}
      return resp;
    };
    const OrigXHR = window.XMLHttpRequest;
    function HookedXHR() {
      const xhr = new OrigXHR();
      const origOpen = xhr.open;
      let capturedUrl = '';
      xhr.open = function(method, url, ...rest) {
        capturedUrl = url;
        return origOpen.call(this, method, url, ...rest);
      };
      xhr.addEventListener('load', () => {
        try {
          if (shouldCapture(capturedUrl)) {
            window.__xhsCapture[capturedUrl] = { status: xhr.status, ok: xhr.status >= 200 && xhr.status < 300, body: xhr.responseText };
          }
        } catch (_) {}
      });
      return xhr;
    }
    HookedXHR.prototype = OrigXHR.prototype;
    // Preserve readyState constants (UNSENT / OPENED / HEADERS_RECEIVED / LOADING / DONE)
    // since dashboard code may read XMLHttpRequest.DONE etc against the constructor.
    for (const key of ['UNSENT', 'OPENED', 'HEADERS_RECEIVED', 'LOADING', 'DONE']) {
      if (key in OrigXHR) HookedXHR[key] = OrigXHR[key];
    }
    window.XMLHttpRequest = HookedXHR;
  })()`);
}
async function captureNoteDetailPayload(page, noteId) {
  await installXhsFetchCaptureHook2(page);
  await page.evaluate(`(() => {
    const target = '/statistics/note-detail?noteId=' + ${JSON.stringify(noteId)};
    history.pushState({}, '', target);
    window.dispatchEvent(new PopStateEvent('popstate'));
  })()`);
  const wantedSuffixes = DETAIL_API_ENDPOINTS.map((endpoint) => endpoint.suffix);
  let captureMap = {};
  for (let i = 0; i < CAPTURE_POLL_ATTEMPTS2; i++) {
    await page.wait(CAPTURE_POLL_INTERVAL_S2);
    let raw;
    try {
      raw = await page.evaluate("JSON.stringify(window.__xhsCapture || {})");
      captureMap = typeof raw === "string" ? JSON.parse(raw) : {};
    } catch {
      throw new CommandExecutionError("xiaohongshu creator-note-detail: failed to read signed datacenter/note capture buffer");
    }
    if (!captureMap || typeof captureMap !== "object" || Array.isArray(captureMap)) {
      throw new CommandExecutionError("xiaohongshu creator-note-detail: malformed signed datacenter/note capture buffer");
    }
    const captured = wantedSuffixes.filter((suffix) => findCapturedUrl(captureMap, suffix));
    if (captured.length === wantedSuffixes.length)
      break;
  }
  const payload = {};
  for (const endpoint of DETAIL_API_ENDPOINTS) {
    const matchUrl = findCapturedUrl(captureMap, endpoint.suffix);
    if (!matchUrl)
      continue;
    payload[endpoint.key] = parseCapturedJson(captureMap[matchUrl], endpoint);
  }
  return Object.keys(payload).length > 0 ? payload : null;
}
async function captureNoteDetailDomData(page) {
  const result = await page.evaluate(`() => {
    const norm = (value) => (value || '').trim();
    const sections = Array.from(document.querySelectorAll('.shell-container')).map((container) => {
      const containerText = norm(container.innerText);
      const title = containerText.startsWith('互动数据')
        ? '互动数据'
        : containerText.includes('基础数据')
          ? '基础数据'
          : '';
      const metrics = Array.from(container.querySelectorAll('.block-container.block')).map((block) => ({
        label: norm(block.querySelector('.des')?.innerText),
        value: norm(block.querySelector('.content')?.innerText),
        extra: norm(block.querySelector('.text-with-fans')?.innerText),
      })).filter((metric) => metric.label && metric.value);
      return { title, metrics };
    }).filter((section) => section.title && section.metrics.length > 0);

    return {
      title: norm(document.querySelector('.note-title')?.innerText),
      infoText: norm(document.querySelector('.note-info-content')?.innerText),
      sections,
    };
  }`);
  if (!result || typeof result !== "object")
    return null;
  return result;
}
async function fetchCreatorNoteDetailRows(page, noteId) {
  await page.goto("https://creator.xiaohongshu.com/statistics");
  const apiPayload = await captureNoteDetailPayload(page, noteId);
  const domData = await captureNoteDetailDomData(page).catch(() => null);
  let rows = parseCreatorNoteDetailDomData(domData, noteId);
  if (rows.length === 0) {
    const bodyText = await page.evaluate("() => document.body.innerText");
    rows = parseCreatorNoteDetailText(typeof bodyText === "string" ? bodyText : "", noteId);
  }
  appendTrendRows(rows, apiPayload ?? void 0);
  appendAudienceRows(rows, apiPayload ?? void 0);
  return rows;
}
cli({
  site: "xiaohongshu",
  name: "creator-note-detail",
  access: "read",
  description: "小红书单篇笔记详情页数据 (笔记信息 + 核心/互动数据 + 观看来源 + 观众画像 + 趋势数据)",
  domain: "creator.xiaohongshu.com",
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    { name: "note-id", positional: true, type: "string", required: true, help: "Note ID (from creator-notes or note-detail page URL)" }
  ],
  columns: ["section", "metric", "value", "extra"],
  func: async (page, kwargs) => {
    const noteId = kwargs["note-id"];
    const rows = await fetchCreatorNoteDetailRows(page, noteId);
    const hasCoreMetric = rows.some((row) => row.section !== "笔记信息" && row.value);
    if (!hasCoreMetric) {
      throw new EmptyResultError("xiaohongshu creator-note-detail", "No note detail data found. Check note_id and login status for creator.xiaohongshu.com.");
    }
    return rows;
  }
});

// ../browser-agent/opencli/clis/xiaohongshu/creator-notes-summary.js
function findDetailValue(rows, metric) {
  return rows.find((row) => row.metric === metric)?.value ?? "";
}
function findTopBySectionPrefix(rows, section, prefix) {
  const matches = rows.filter((row) => row.section === section && row.metric.startsWith(prefix) && row.value);
  if (matches.length === 0)
    return { label: "", value: "" };
  const sorted = [...matches].sort((a, b) => parseFloat(b.value) - parseFloat(a.value));
  const top = sorted[0];
  return {
    label: top.metric.slice(prefix.length),
    value: top.value
  };
}
function summarizeCreatorNote(note, rows, rank) {
  const topSource = findTopBySectionPrefix(rows, "观看来源", "");
  const topInterest = findTopBySectionPrefix(rows, "观众画像", "兴趣/");
  return {
    rank,
    id: note.id,
    title: note.title,
    published_at: findDetailValue(rows, "published_at") || note.date,
    views: findDetailValue(rows, "观看数") || String(note.views),
    likes: findDetailValue(rows, "点赞数") || String(note.likes),
    collects: findDetailValue(rows, "收藏数") || String(note.collects),
    comments: findDetailValue(rows, "评论数") || String(note.comments),
    shares: findDetailValue(rows, "分享数"),
    avg_view_time: findDetailValue(rows, "平均观看时长"),
    rise_fans: findDetailValue(rows, "涨粉数"),
    top_source: topSource.label,
    top_source_pct: topSource.value,
    top_interest: topInterest.label,
    top_interest_pct: topInterest.value,
    url: note.url
  };
}
cli({
  site: "xiaohongshu",
  name: "creator-notes-summary",
  access: "read",
  description: "小红书最近笔记批量摘要 (列表 + 单篇关键数据汇总)",
  domain: "creator.xiaohongshu.com",
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    { name: "limit", type: "int", default: 3, help: "Number of recent notes to summarize" },
    { name: "timeout", type: "int", required: false, default: 180, help: "Max seconds for the overall command (default: 180)" }
  ],
  columns: ["rank", "id", "title", "views", "likes", "collects", "comments", "shares", "avg_view_time", "rise_fans", "top_source", "top_interest", "url"],
  func: async (page, kwargs) => {
    const limit = kwargs.limit || 3;
    const notes = await fetchCreatorNotes(page, limit);
    if (!notes.length) {
      throw new EmptyResultError("xiaohongshu creator-notes-summary", "No notes found. Ensure you are logged into creator.xiaohongshu.com and the account has published notes.");
    }
    const results = [];
    for (const [index, note] of notes.entries()) {
      if (index > 0) {
        await page.wait({ time: 1 + Math.random() * 2 });
      }
      if (!note.id) {
        results.push({
          rank: index + 1,
          id: note.id,
          title: note.title,
          published_at: note.date,
          views: String(note.views),
          likes: String(note.likes),
          collects: String(note.collects),
          comments: String(note.comments),
          shares: "",
          avg_view_time: "",
          rise_fans: "",
          top_source: "",
          top_source_pct: "",
          top_interest: "",
          top_interest_pct: "",
          url: note.url
        });
        continue;
      }
      const detailRows = await fetchCreatorNoteDetailRows(page, note.id);
      results.push(summarizeCreatorNote(note, detailRows, index + 1));
    }
    return results;
  }
});
export {
  summarizeCreatorNote
};
