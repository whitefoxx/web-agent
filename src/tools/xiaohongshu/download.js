/**
 * Hand-ported from opencli/clis/xiaohongshu/download.js.
 *
 * The upstream version uses Node-only opencli helpers (formatCookieHeader,
 * downloadMedia) to stream URLs via fetch + filesystem writes. In the
 * extension we can't touch the filesystem directly, but `chrome.downloads`
 * gives us nearly equivalent behavior — including using Chrome's own
 * cookie store so authenticated CDN assets work without us shipping
 * cookies in headers.
 *
 * Difference from upstream: the `output` arg (filesystem path) becomes
 * `subdir` (a path under the user's Downloads folder), because Chrome
 * extensions can't choose an arbitrary location on disk.
 *
 * NOT byte-identical with opencli upstream.
 */

import { cli, Strategy } from '../../runtime/registry.js';
import { CliError } from '../../runtime/errors.js';
import { buildNoteUrl, parseNoteId } from './note-helpers.js';

const EXTRACT_MEDIA_JS = `
  (() => {
    const bodyText = document.body?.innerText || '';
    const result = {
      pageUrl: location.href,
      securityBlock:
        /安全限制|访问链接异常/.test(bodyText) ||
        /website-login\\/error|error_code=300017|error_code=300031/.test(location.href),
      title: '',
      author: '',
      media: [],
    };
    const seenMedia = new Set();
    const pushMedia = (type, url) => {
      if (!url) return;
      const key = type + ':' + url;
      if (seenMedia.has(key)) return;
      seenMedia.add(key);
      result.media.push({ type, url });
    };

    result.title = (document.querySelector('.title, #detail-title, .note-content .title')?.textContent || 'untitled').trim();
    result.author = (document.querySelector('.username, .author-name, .name')?.textContent || 'unknown').trim();

    const imageSelectors = [
      '.swiper-slide img',
      '.carousel-image img',
      '.note-slider img',
      '.note-image img',
      '.image-wrapper img',
      '#noteContainer .media-container img[src*="xhscdn"]',
      'img[src*="ci.xiaohongshu.com"]',
    ];
    const imageUrls = new Set();
    for (const selector of imageSelectors) {
      document.querySelectorAll(selector).forEach((img) => {
        let src = img.src || img.getAttribute('data-src') || '';
        if (src && (src.includes('xhscdn') || src.includes('xiaohongshu'))) {
          src = src.split('?')[0];
          src = src.replace(/\\/imageView\\d+\\/\\d+\\/w\\/\\d+/, '');
          imageUrls.add(src);
        }
      });
    }

    // Video: prefer __INITIAL_STATE__ over blob: URLs
    try {
      const state = window.__INITIAL_STATE__;
      if (state) {
        const noteData = state.note?.noteDetailMap || state.note?.note || {};
        for (const key of Object.keys(noteData)) {
          const note = noteData[key]?.note || noteData[key];
          const video = note?.video;
          if (video) {
            const vUrl = video.url || video.originVideoKey || video.consumer?.originVideoKey;
            if (vUrl) {
              const fullUrl = vUrl.startsWith('http') ? vUrl : 'https://sns-video-bd.xhscdn.com/' + vUrl;
              pushMedia('video', fullUrl);
            }
            const streams = video.media?.stream?.h264 || [];
            for (const stream of streams) {
              if (stream.masterUrl) pushMedia('video', stream.masterUrl);
            }
          }
        }
      }
    } catch (e) {}

    // Fallback: scrape inline script JSON for .mp4 URLs
    if (result.media.filter((m) => m.type === 'video').length === 0) {
      try {
        const scripts = document.querySelectorAll('script');
        for (const s of scripts) {
          const text = s.textContent || '';
          const m =
            text.match(/https?:\\/\\/sns-video[^"'\\s]+\\.mp4[^"'\\s]*/g) ||
            text.match(/https?:\\/\\/[^"'\\s]*xhscdn[^"'\\s]*\\.mp4[^"'\\s]*/g);
          if (m) m.forEach((url) => pushMedia('video', url.replace(/\\\\u002F/g, '/')));
        }
      } catch (e) {}
    }

    // Last resort: DOM <video> elements (skip blob: URLs)
    if (result.media.filter((m) => m.type === 'video').length === 0) {
      ['video source', 'video[src]', '.player video', '.video-player video'].forEach((sel) => {
        document.querySelectorAll(sel).forEach((v) => {
          const src = v.src || v.getAttribute('src') || '';
          if (src && !src.startsWith('blob:')) pushMedia('video', src);
        });
      });
    }

    imageUrls.forEach((url) => pushMedia('image', url));
    return result;
  })()
`;

function sanitizeForPath(s) {
  return (s || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80);
}

function humanBytes(b) {
  if (!b) return '-';
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
  return `${(b / 1024 / 1024).toFixed(2)}MB`;
}

function extFromUrl(url, type) {
  const m = url.match(/\.(jpg|jpeg|png|webp|gif|mp4|mov|webm)(?:\?|#|$)/i);
  if (m) return m[1].toLowerCase();
  return type === 'video' ? 'mp4' : 'jpg';
}

cli({
  site: 'xiaohongshu',
  name: 'download',
  access: 'read',
  description:
    '下载小红书笔记中的图片和视频到本地 Downloads 文件夹（chrome.downloads，使用浏览器自带的 cookie）',
  domain: 'www.xiaohongshu.com',
  strategy: Strategy.COOKIE,
  args: [
    {
      name: 'note-id',
      positional: true,
      required: true,
      help: 'Full Xiaohongshu note URL with xsec_token, or xhslink short link',
    },
    {
      name: 'subdir',
      default: 'xiaohongshu',
      help: 'Subdirectory under Downloads/ where files will be saved',
    },
  ],
  columns: ['index', 'type', 'status', 'size', 'filename'],
  func: async (page, kwargs) => {
    const rawInput = String(kwargs['note-id']);
    const subdir = sanitizeForPath(String(kwargs.subdir || 'xiaohongshu'));
    const noteId = parseNoteId(rawInput);

    await page.goto(
      buildNoteUrl(rawInput, { allowShortLink: true, commandName: 'xiaohongshu download' }),
    );
    await page.wait({ time: 1 + Math.random() * 2 });

    const data = await page.evaluate(EXTRACT_MEDIA_JS);

    if (data?.securityBlock) {
      throw new CliError(
        'SECURITY_BLOCK',
        'Xiaohongshu security block: the note detail page was blocked by risk control.',
        /^https?:\/\//.test(rawInput)
          ? 'The page may be temporarily restricted. Try again later or from a different session.'
          : 'Try using a full URL from search results (with xsec_token) instead of a bare note ID.',
      );
    }
    if (!data || !data.media || data.media.length === 0) {
      return [{ index: 0, type: '-', status: 'failed', size: 'No media found', filename: '' }];
    }

    const results = [];
    for (let i = 0; i < data.media.length; i++) {
      const item = data.media[i];
      const ext = extFromUrl(item.url, item.type);
      const filename = `${subdir}/${noteId}/${String(i + 1).padStart(2, '0')}-${item.type}.${ext}`;
      try {
        const r = await page.downloadFile({
          url: item.url,
          filename,
          conflictAction: 'uniquify',
        });
        results.push({
          index: i + 1,
          type: item.type,
          status: r.ok ? 'done' : 'failed',
          size: humanBytes(r.bytes),
          filename: r.filename,
        });
      } catch (e) {
        results.push({
          index: i + 1,
          type: item.type,
          status: 'error',
          size: '-',
          filename: e?.message ?? String(e),
        });
      }
    }
    return results;
  },
});
