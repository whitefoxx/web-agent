// ../browser-agent/opencli/clis/xiaoe/catalog.js
import { cli as cli2, Strategy as Strategy2 } from "@jackwener/opencli/registry";
import { CommandExecutionError as CommandExecutionError2, EmptyResultError as EmptyResultError2 } from "@jackwener/opencli/errors";

// ../browser-agent/opencli/clis/xiaoe/content.js
import { cli, Strategy } from "@jackwener/opencli/registry";
import { ArgumentError, CommandExecutionError, EmptyResultError } from "@jackwener/opencli/errors";
var CONTENT_SELECTORS = [
  ".rich-text-wrap",
  ".content-wrap",
  ".article-content",
  ".text-content",
  ".course-detail",
  ".detail-content",
  '[class*="richtext"]',
  '[class*="rich-text"]',
  ".ql-editor"
];
var CONTENT_MIN_LENGTH = 50;
function pickContentText(doc, selectors, minLength = CONTENT_MIN_LENGTH) {
  for (const sel of selectors) {
    const el = doc.querySelector(sel);
    if (!el) continue;
    const text = (el.innerText || el.textContent || "").trim();
    if (text.length > minLength) return text;
  }
  const fallback = doc.querySelector("main") || doc.querySelector("#app") || doc.body;
  if (!fallback) return "";
  return (fallback.innerText || fallback.textContent || "").trim();
}
function countXiaoeImages(doc) {
  let count = 0;
  const imgs = doc.querySelectorAll("img");
  for (let i = 0; i < imgs.length; i += 1) {
    const src = imgs[i].getAttribute("src") || imgs[i].src || "";
    if (!src) continue;
    if (src.startsWith("data:")) continue;
    if (!src.includes("xiaoe")) continue;
    count += 1;
  }
  return count;
}
function requireXiaoePageUrl(value, commandName) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    throw new ArgumentError("url is required (positional)");
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ArgumentError(
      `invalid xiaoe URL: ${raw}`,
      `Example: opencli xiaoe ${commandName} https://appxxxx.h5.xet.citv.cn/p/course/ecourse/v_xxxxx`
    );
  }
  if (parsed.protocol !== "https:") {
    throw new ArgumentError(
      `xiaoe URL must use https (got ${parsed.protocol.replace(":", "")})`,
      `Example: opencli xiaoe ${commandName} https://appxxxx.h5.xet.citv.cn/p/course/ecourse/v_xxxxx`
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== "h5.xet.citv.cn" && !host.endsWith(".h5.xet.citv.cn")) {
    throw new ArgumentError(
      `url must be on h5.xet.citv.cn or a shop subdomain (got ${parsed.hostname})`,
      `Example: opencli xiaoe ${commandName} https://appxxxx.h5.xet.citv.cn/p/course/ecourse/v_xxxxx`
    );
  }
  return parsed.toString();
}
function buildContentScript() {
  return `
(() => {
  ${pickContentText.toString()}
  ${countXiaoeImages.toString()}
  const selectors = ${JSON.stringify(CONTENT_SELECTORS)};
  const title = document.title || '';
  const content = pickContentText(document, selectors, ${JSON.stringify(CONTENT_MIN_LENGTH)});
  const imageCount = countXiaoeImages(document);
  return [{
    title,
    content,
    content_length: content.length,
    image_count: imageCount,
  }];
})()
`;
}
async function getXiaoeContent(page, args) {
  const url = requireXiaoePageUrl(args.url, "content");
  let rows;
  try {
    await page.goto(url, { waitUntil: "load", settleMs: 6e3 });
    rows = await page.evaluate(buildContentScript());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CommandExecutionError(
      `Failed to extract xiaoe content: ${message}`,
      "page may not have rendered or auth may be required"
    );
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new EmptyResultError(
      "xiaoe/content",
      "No rows returned from page evaluator (page structure may have changed)"
    );
  }
  const row = rows[0];
  if (!row || typeof row.content !== "string" || row.content.length === 0) {
    throw new EmptyResultError(
      "xiaoe/content",
      "No article content extracted \u2014 login session may have expired or the page renders an empty shell"
    );
  }
  return rows;
}
var contentCommand = cli({
  site: "xiaoe",
  name: "content",
  access: "read",
  description: "\u63D0\u53D6\u5C0F\u9E45\u901A\u56FE\u6587\u9875\u9762\u5185\u5BB9\u4E3A\u6587\u672C",
  domain: "h5.xet.citv.cn",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "url", required: true, positional: true, help: "\u9875\u9762 URL" }
  ],
  columns: ["title", "content", "content_length", "image_count"],
  func: getXiaoeContent
});

// ../browser-agent/opencli/clis/xiaoe/catalog.js
function typeLabel(t) {
  const map = { 1: "\u56FE\u6587", 2: "\u76F4\u64AD", 3: "\u97F3\u9891", 4: "\u89C6\u9891", 6: "\u4E13\u680F", 8: "\u5927\u4E13\u680F" };
  return map[Number(t)] || String(t || "");
}
function buildItemUrl(item, origin) {
  const u = item.jump_url || item.h5_url || item.url || "";
  if (!u) return "";
  return u.startsWith("http") ? u : origin + u;
}
function chapterUrlPath(chType) {
  const map = { 1: "/v1/course/text/", 2: "/v2/course/alive/", 3: "/v1/course/audio/", 4: "/v1/course/video/" };
  return map[Number(chType)];
}
function buildCatalogScript() {
  return `(async () => {
  ${typeLabel.toString()}
  ${buildItemUrl.toString()}
  ${chapterUrlPath.toString()}
  var el = document.querySelector('#app');
  var store = (el && el.__vue__) ? el.__vue__.$store : null;
  if (!store) return [];
  var coreInfo = store.state.coreInfo || {};
  var resourceType = coreInfo.resource_type || 0;
  var origin = window.location.origin;
  var courseName = coreInfo.resource_name || '';

  function clickTab(name) {
    var tabs = document.querySelectorAll('span, div');
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].children.length === 0 && tabs[i].textContent.trim() === name) {
        tabs[i].click(); return;
      }
    }
  }

  clickTab('\u76EE\u5F55');
  await new Promise(function(r) { setTimeout(r, 2000); });

  function getScrollTargets() {
    return document.querySelectorAll('.scroll-view, .list-wrap, .scroller, #app');
  }
  function getMaxScrollHeight(scrollers) {
    var maxHeight = document.body.scrollHeight;
    for (var i = 0; i < scrollers.length; i++) {
      if (scrollers[i].scrollHeight > maxHeight) maxHeight = scrollers[i].scrollHeight;
    }
    return maxHeight;
  }

  // \u6A21\u62DF\u6EDA\u52A8\u4EE5\u5B9E\u73B0\u52A8\u6001\u52A0\u8F7D
  var prevMaxScrollHeight = 0;
  for (var sc = 0; sc < 20; sc++) {
    window.scrollTo(0, 999999);
    var scrollers = getScrollTargets();
    for(var si = 0; si < scrollers.length; si++) {
      if(scrollers[si].scrollHeight > scrollers[si].clientHeight) scrollers[si].scrollTop = scrollers[si].scrollHeight;
    }
    await new Promise(function(r) { setTimeout(r, 800); });

    // \u70B9\u51FB\u53EF\u80FD\u5B58\u5728\u7684\u4E0B\u62C9/\u52A0\u8F7D\u66F4\u591A
    var moreTabs = document.querySelectorAll('span, div, p');
    for (var bi = 0; bi < moreTabs.length; bi++) {
      var t = moreTabs[bi].textContent.trim();
      if ((t === '\u70B9\u51FB\u52A0\u8F7D\u66F4\u591A' || t === '\u5C55\u5F00\u66F4\u591A' || t === '\u52A0\u8F7D\u66F4\u591A') && moreTabs[bi].clientHeight > 0) {
        try { moreTabs[bi].click(); } catch(e){}
      }
    }

    var maxScrollHeight = getMaxScrollHeight(getScrollTargets());
    if (sc > 3 && maxScrollHeight === prevMaxScrollHeight) break;
    prevMaxScrollHeight = maxScrollHeight;
  }
  await new Promise(function(r) { setTimeout(r, 1000); });

  // ===== \u4E13\u680F / \u5927\u4E13\u680F =====
  if (resourceType === 6 || resourceType === 8) {
    await new Promise(function(r) { setTimeout(r, 1000); });
    var listData = [];
    var walkList = function(vm, depth) {
      if (!vm || depth > 6 || listData.length > 0) return;
      var d = vm.$data || {};
      var keys = ['columnList', 'SingleItemList', 'chapterChildren'];
      for (var ki = 0; ki < keys.length; ki++) {
        var arr = d[keys[ki]];
        if (arr && Array.isArray(arr) && arr.length > 0 && arr[0].resource_id) {
          for (var j = 0; j < arr.length; j++) {
            var item = arr[j];
            if (!item.resource_id || !/^[pvlai]_/.test(item.resource_id)) continue;
            listData.push({
              ch: 1,
              chapter: courseName,
              no: j + 1,
              title: item.resource_title || item.title || item.chapter_title || '',
              type: typeLabel(item.resource_type || item.chapter_type),
              resource_id: item.resource_id,
              url: buildItemUrl(item, origin),
              status: item.finished_state === 1 ? '\u5DF2\u5B8C\u6210' : (item.resource_count ? item.resource_count + '\u8282' : ''),
            });
          }
          return;
        }
      }
      if (vm.$children) {
        for (var c = 0; c < vm.$children.length; c++) walkList(vm.$children[c], depth + 1);
      }
    };
    walkList(el.__vue__, 0);
    return listData;
  }

  // ===== \u666E\u901A\u8BFE\u7A0B =====
  var chapters = document.querySelectorAll('.chapter_box');
  for (var ci = 0; ci < chapters.length; ci++) {
    var vue = chapters[ci].__vue__;
    if (vue && typeof vue.getSecitonList === 'function' && (!vue.isShowSecitonsList || !vue.chapterChildren.length)) {
      if (vue.isShowSecitonsList) vue.isShowSecitonsList = false;
      try { vue.getSecitonList(); } catch(e) {}
      await new Promise(function(r) { setTimeout(r, 1500); });
    }
  }
  await new Promise(function(r) { setTimeout(r, 3000); });

  var result = [];
  chapters = document.querySelectorAll('.chapter_box');
  for (var cj = 0; cj < chapters.length; cj++) {
    var v = chapters[cj].__vue__;
    if (!v) continue;
    var chTitle = (v.chapterItem && v.chapterItem.chapter_title) || '';
    var children = v.chapterChildren || [];
    for (var ck = 0; ck < children.length; ck++) {
      var child = children[ck];
      var resId = child.resource_id || child.chapter_id || '';
      var chType = child.chapter_type || child.resource_type || 0;
      var urlPath = chapterUrlPath(chType);
      result.push({
        ch: cj + 1,
        chapter: chTitle,
        no: ck + 1,
        title: child.chapter_title || child.resource_title || '',
        type: typeLabel(chType),
        resource_id: resId,
        url: urlPath ? origin + urlPath + resId + '?type=2' : '',
        status: child.is_finish === 1 ? '\u5DF2\u5B8C\u6210' : (child.learn_progress > 0 ? child.learn_progress + '%' : '\u672A\u5B66'),
      });
    }
  }
  return result;
})()`;
}
async function getXiaoeCatalog(page, args) {
  const url = requireXiaoePageUrl(args.url, "catalog");
  let rows;
  try {
    await page.goto(url, { waitUntil: "load", settleMs: 8e3 });
    rows = await page.evaluate(buildCatalogScript());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CommandExecutionError2(
      `Failed to read xiaoe catalog: ${message}`,
      "page may not have rendered or auth may be required"
    );
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new EmptyResultError2(
      "xiaoe/catalog",
      "No catalog rows extracted \u2014 the URL may not be a course page or the login session has expired"
    );
  }
  return rows;
}
var catalogCommand = cli2({
  site: "xiaoe",
  name: "catalog",
  access: "read",
  description: "\u5C0F\u9E45\u901A\u8BFE\u7A0B\u76EE\u5F55\uFF08\u652F\u6301\u666E\u901A\u8BFE\u7A0B\u3001\u4E13\u680F\u3001\u5927\u4E13\u680F\uFF09",
  domain: "h5.xet.citv.cn",
  strategy: Strategy2.COOKIE,
  browser: true,
  args: [
    { name: "url", required: true, positional: true, help: "\u8BFE\u7A0B\u9875\u9762 URL" }
  ],
  columns: ["ch", "chapter", "no", "title", "type", "resource_id", "url", "status"],
  func: getXiaoeCatalog
});
var __test__ = {
  buildCatalogScript
};
export {
  __test__,
  buildCatalogScript,
  buildItemUrl,
  catalogCommand,
  chapterUrlPath,
  typeLabel
};
