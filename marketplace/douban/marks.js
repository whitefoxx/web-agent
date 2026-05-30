// ../browser-agent/opencli/clis/douban/marks.js
import { cli, Strategy } from "@jackwener/opencli/registry";

// ../browser-agent/opencli/clis/douban/utils.js
import { ArgumentError as ArgumentError2, CliError, EmptyResultError } from "@jackwener/opencli/errors";

// ../browser-agent/opencli/clis/_shared/common.js
import { ArgumentError } from "@jackwener/opencli/errors";

// ../browser-agent/opencli/clis/douban/utils.js
async function getSelfUid(page) {
  await page.goto("https://movie.douban.com/mine");
  await page.wait({ time: 2 });
  const uid = await page.evaluate(`
    (() => {
      // \u65B9\u68481: \u5C1D\u8BD5\u4ECE\u5168\u5C40\u53D8\u91CF\u83B7\u53D6
      if (window.__DATA__ && window.__DATA__.uid) {
        return window.__DATA__.uid;
      }
      
      // \u65B9\u68482: \u4ECE\u5BFC\u822A\u680F\u7528\u6237\u94FE\u63A5\u83B7\u53D6
      const navUserLink = document.querySelector('.nav-user-account a');
      if (navUserLink) {
        const href = navUserLink.href || '';
        const match = href.match(/people\\/([^/]+)/);
        if (match) return match[1];
      }
      
      // \u65B9\u68483: \u4ECE\u9875\u9762\u4E2D\u7684\u4E2A\u4EBA\u4E3B\u9875\u94FE\u63A5\u83B7\u53D6
      const profileLink = document.querySelector('a[href*="/people/"]');
      if (profileLink) {
        const href = profileLink.getAttribute('href') || profileLink.href || '';
        const match = href.match(/people\\/([^/]+)/);
        if (match) return match[1];
      }
      
      // \u65B9\u68484: \u4ECE\u5934\u90E8\u7528\u6237\u540D\u533A\u57DF\u83B7\u53D6
      const userLink = document.querySelector('.global-nav-items a[href*="/people/"]');
      if (userLink) {
        const href = userLink.getAttribute('href') || userLink.href || '';
        const match = href.match(/people\\/([^/]+)/);
        if (match) return match[1];
      }
      
      return '';
    })()
  `);
  if (!uid) {
    throw new Error("Not logged in to Douban. Please login in Chrome first.");
  }
  return uid;
}

// ../browser-agent/opencli/clis/douban/marks.js
cli({
  site: "douban",
  name: "marks",
  access: "read",
  description: "\u5BFC\u51FA\u4E2A\u4EBA\u89C2\u5F71\u6807\u8BB0",
  domain: "movie.douban.com",
  strategy: Strategy.COOKIE,
  args: [
    {
      name: "status",
      default: "collect",
      choices: ["collect", "wish", "do", "all"],
      help: "\u6807\u8BB0\u7C7B\u578B: collect(\u770B\u8FC7), wish(\u60F3\u770B), do(\u5728\u770B), all(\u5168\u90E8)"
    },
    { name: "limit", type: "int", default: 50, help: "\u5BFC\u51FA\u6570\u91CF\uFF0C 0 \u8868\u793A\u5168\u90E8" },
    { name: "uid", help: "\u7528\u6237ID\uFF0C\u4E0D\u586B\u5219\u4F7F\u7528\u5F53\u524D\u767B\u5F55\u8D26\u53F7" }
  ],
  columns: ["title", "year", "myRating", "myStatus", "myDate", "myComment", "url"],
  func: async (page, kwargs) => {
    const { status = "collect", limit = 50, uid: providedUid } = kwargs;
    const uid = providedUid || await getSelfUid(page);
    const statuses = status === "all" ? ["collect", "wish", "do"] : [status];
    const allMarks = [];
    for (const s of statuses) {
      const remaining = limit > 0 ? limit - allMarks.length : 0;
      if (limit > 0 && remaining <= 0)
        break;
      const marks = await fetchMarks(page, uid, s, remaining);
      allMarks.push(...marks);
    }
    return allMarks.slice(0, limit > 0 ? limit : void 0);
  }
});
async function fetchMarks(page, uid, status, limit) {
  const marks = [];
  let offset = 0;
  const pageSize = 15;
  while (true) {
    const url = `https://movie.douban.com/people/${uid}/${status}?start=${offset}&sort=time&rating=all&filter=all&mode=grid`;
    await page.goto(url);
    await page.wait({ time: 2 });
    const pageMarks = await page.evaluate(`
      () => {
        const results = [];
        
        const items = document.querySelectorAll('.item');
        
        items.forEach(item => {
          const titleLink = item.querySelector('.info a[href*="/subject/"]');
          if (!titleLink) return;
          
          const titleEl = titleLink.querySelector('em');
          const titleText = titleEl?.textContent?.trim() || titleLink.textContent?.trim() || '';
          const title = titleText.split('/')[0].trim();
          const href = titleLink.href || '';
          
          const idMatch = href.match(/subject\\/(\\d+)/);
          const movieId = idMatch ? idMatch[1] : '';
          
          if (!movieId || !title) return;
          
          const ratingSpan = item.querySelector('span[class*="rating"]');
          let myRating = null;
          if (ratingSpan) {
            const cls = ratingSpan.className || '';
            const ratingMatch = cls.match(/rating(\\d)-t/);
            if (ratingMatch) {
              myRating = parseInt(ratingMatch[1], 10) * 2;
            }
          }
          
          const dateSpan = item.querySelector('.date');
          const myDate = dateSpan?.textContent?.trim() || '';
          
          const commentSpan = item.querySelector('.comment');
          const myComment = commentSpan?.textContent?.trim() || '';
          
          const introSpan = item.querySelector('.intro');
          let year = '';
          if (introSpan) {
            const introText = introSpan.textContent || '';
            const yearMatch = introText.match(/(\\d{4})/);
            year = yearMatch ? yearMatch[1] : '';
          }
          
          results.push({
            movieId,
            title,
            year,
            myRating,
            myStatus: '${status}',
            myComment,
            myDate,
            url: href || 'https://movie.douban.com/subject/' + movieId
          });
        });
        
        return results;
      }
    `);
    if (!pageMarks || pageMarks.length === 0)
      break;
    marks.push(...pageMarks);
    if (pageMarks.length < pageSize)
      break;
    if (limit > 0 && marks.length >= limit)
      break;
    offset += pageSize;
    await new Promise((resolve) => setTimeout(resolve, 1e3));
  }
  return marks;
}
