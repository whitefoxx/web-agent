// ../browser-agent/opencli/clis/douban/photos.js
import { cli, Strategy } from "@jackwener/opencli/registry";

// ../browser-agent/opencli/clis/douban/utils.js
import { ArgumentError as ArgumentError2, CliError, EmptyResultError } from "@jackwener/opencli/errors";

// ../browser-agent/opencli/clis/_shared/common.js
import { ArgumentError } from "@jackwener/opencli/errors";
function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

// ../browser-agent/opencli/clis/douban/utils.js
var DOUBAN_PHOTO_PAGE_SIZE = 30;
var MAX_DOUBAN_PHOTOS = 500;
var clampPhotoLimit = (limit) => clamp(limit || 120, 1, MAX_DOUBAN_PHOTOS);
async function ensureDoubanReady(page) {
  const state = await page.evaluate(`
    (() => {
      const title = (document.title || '').trim();
      const href = (location.href || '').trim();
      const blocked = href.includes('sec.douban.com') || /\u767B\u5F55\u8DF3\u8F6C/.test(title) || /\u5F02\u5E38\u8BF7\u6C42/.test(document.body?.innerText || '');
      return { blocked, title, href };
    })()
  `);
  if (state?.blocked) {
    throw new CliError("AUTH_REQUIRED", "Douban requires a logged-in browser session before these commands can load data.", "Please sign in to douban.com in the browser that opencli reuses, then rerun the command.");
  }
}
function normalizeDoubanSubjectId(subjectId) {
  const normalized = String(subjectId || "").trim();
  if (!/^\d+$/.test(normalized)) {
    throw new ArgumentError2(`Invalid Douban subject ID: ${subjectId}`);
  }
  return normalized;
}
function resolveDoubanPhotoAssetUrl(candidates, baseUrl = "") {
  for (const candidate of candidates) {
    const normalized = String(candidate || "").trim();
    if (!normalized)
      continue;
    let resolved = normalized;
    try {
      resolved = baseUrl ? new URL(normalized, baseUrl).toString() : new URL(normalized).toString();
    } catch {
      resolved = normalized;
    }
    if (/^https?:\/\//i.test(resolved)) {
      return resolved;
    }
  }
  return "";
}
async function loadDoubanSubjectPhotos(page, subjectId, options = {}) {
  const normalizedId = normalizeDoubanSubjectId(subjectId);
  const type = String(options.type || "Rb").trim() || "Rb";
  const targetPhotoId = String(options.targetPhotoId || "").trim();
  const safeLimit = targetPhotoId ? Number.MAX_SAFE_INTEGER : clampPhotoLimit(Number(options.limit) || 120);
  const resolvePhotoAssetUrlSource = resolveDoubanPhotoAssetUrl.toString();
  const galleryUrl = `https://movie.douban.com/subject/${normalizedId}/photos?type=${encodeURIComponent(type)}`;
  await page.goto(galleryUrl);
  await page.wait(2);
  await ensureDoubanReady(page);
  const data = await page.evaluate(`
    (async () => {
      const subjectId = ${JSON.stringify(normalizedId)};
      const type = ${JSON.stringify(type)};
      const limit = ${safeLimit};
      const targetPhotoId = ${JSON.stringify(targetPhotoId)};
      const pageSize = ${DOUBAN_PHOTO_PAGE_SIZE};
      const resolveDoubanPhotoAssetUrl = ${resolvePhotoAssetUrlSource};

      const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
      const toAbsoluteUrl = (value) => {
        if (!value) return '';
        try {
          return new URL(value, location.origin).toString();
        } catch {
          return value;
        }
      };
      const promotePhotoUrl = (value) => {
        const absolute = toAbsoluteUrl(value);
        if (!absolute) return '';
        if (/^[a-z]+:/i.test(absolute) && !/^https?:/i.test(absolute)) return '';
        return absolute.replace(/\\/view\\/photo\\/[^/]+\\/public\\//, '/view/photo/l/public/');
      };
      const buildPageUrl = (start) => {
        const url = new URL(location.href);
        url.searchParams.set('type', type);
        if (start > 0) url.searchParams.set('start', String(start));
        else url.searchParams.delete('start');
        return url.toString();
      };
      const getTitle = (doc) => {
        const raw = normalize(doc.querySelector('#content h1')?.textContent)
          || normalize(doc.querySelector('title')?.textContent);
        return raw.replace(/\\s*\\(\u8C46\u74E3\\)\\s*$/, '');
      };
      const extractPhotos = (doc, pageNumber) => {
        const nodes = Array.from(doc.querySelectorAll('.poster-col3 li, .poster-col3l li, .article li'));
        const rows = [];
        for (const node of nodes) {
          const link = node.querySelector('a[href*="/photos/photo/"]');
          const img = node.querySelector('img');
          if (!link || !img) continue;

          const detailUrl = toAbsoluteUrl(link.getAttribute('href') || '');
          const photoId = detailUrl.match(/\\/photo\\/(\\d+)/)?.[1] || '';
          const thumbUrl = resolveDoubanPhotoAssetUrl([
            img.getAttribute('data-origin'),
            img.getAttribute('data-src'),
            img.getAttribute('src'),
          ], location.href);
          const imageUrl = promotePhotoUrl(thumbUrl);
          const title = normalize(link.getAttribute('title'))
            || normalize(img.getAttribute('alt'))
            || (photoId ? 'photo_' + photoId : 'photo_' + String(rows.length + 1));

          if (!detailUrl || !thumbUrl || !imageUrl) continue;

          rows.push({
            photoId,
            title,
            imageUrl,
            thumbUrl,
            detailUrl,
            page: pageNumber,
          });
        }
        return rows;
      };

      const subjectTitle = getTitle(document);
      const seen = new Set();
      const photos = [];

      for (let pageIndex = 0; photos.length < limit; pageIndex += 1) {
        let doc = document;
        if (pageIndex > 0) {
          const response = await fetch(buildPageUrl(pageIndex * pageSize), { credentials: 'include' });
          if (!response.ok) break;
          const html = await response.text();
          doc = new DOMParser().parseFromString(html, 'text/html');
        }

        const pagePhotos = extractPhotos(doc, pageIndex + 1);
        if (!pagePhotos.length) break;

        let appended = 0;
        let foundTarget = false;
        for (const photo of pagePhotos) {
          const key = photo.photoId || photo.detailUrl || photo.imageUrl;
          if (seen.has(key)) continue;
          seen.add(key);
          photos.push({
            index: photos.length + 1,
            ...photo,
          });
          appended += 1;
          if (targetPhotoId && photo.photoId === targetPhotoId) {
            foundTarget = true;
            break;
          }
          if (photos.length >= limit) break;
        }

        if (foundTarget || pagePhotos.length < pageSize || appended === 0) break;
      }

      return {
        subjectId,
        subjectTitle,
        type,
        photos,
      };
    })()
  `);
  const photos = Array.isArray(data?.photos) ? data.photos : [];
  if (!photos.length) {
    throw new EmptyResultError("douban photos", "No photos found. Try a different subject ID or a different --type value such as Rb.");
  }
  return {
    subjectId: normalizedId,
    subjectTitle: String(data?.subjectTitle || "").trim(),
    type,
    photos
  };
}

// ../browser-agent/opencli/clis/douban/photos.js
cli({
  site: "douban",
  name: "photos",
  access: "read",
  description: "\u83B7\u53D6\u7535\u5F71\u6D77\u62A5/\u5267\u7167\u56FE\u7247\u5217\u8868",
  domain: "movie.douban.com",
  strategy: Strategy.COOKIE,
  args: [
    { name: "id", positional: true, required: true, help: "\u7535\u5F71 subject ID" },
    { name: "type", default: "Rb", help: "\u8C46\u74E3 photos \u7684 type \u53C2\u6570\uFF0C\u9ED8\u8BA4 Rb\uFF08\u6D77\u62A5\uFF09" },
    { name: "limit", type: "int", default: 120, help: "\u6700\u591A\u8FD4\u56DE\u591A\u5C11\u5F20\u56FE\u7247" }
  ],
  columns: ["index", "photo_id", "subject_id", "title", "image_url", "detail_url"],
  func: async (page, kwargs) => {
    const subjectId = normalizeDoubanSubjectId(String(kwargs.id || ""));
    const data = await loadDoubanSubjectPhotos(page, subjectId, {
      type: String(kwargs.type || "Rb"),
      limit: Number(kwargs.limit) || 120
    });
    return data.photos.map((photo) => ({
      subject_id: data.subjectId,
      subject_title: data.subjectTitle,
      type: data.type,
      index: photo.index,
      photo_id: photo.photoId,
      title: photo.title,
      image_url: photo.imageUrl,
      thumb_url: photo.thumbUrl,
      detail_url: photo.detailUrl,
      page: photo.page
    }));
  }
});
