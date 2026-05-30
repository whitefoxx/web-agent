// ../browser-agent/opencli/clis/douban/reviews.js
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

// ../browser-agent/opencli/clis/douban/reviews.js
cli({
  site: "douban",
  name: "reviews",
  access: "read",
  description: "\u5BFC\u51FA\u4E2A\u4EBA\u5F71\u8BC4",
  domain: "movie.douban.com",
  strategy: Strategy.COOKIE,
  args: [
    { name: "limit", type: "int", default: 20, help: "\u5BFC\u51FA\u6570\u91CF" },
    { name: "uid", help: "\u7528\u6237ID\uFF0C\u4E0D\u586B\u5219\u4F7F\u7528\u5F53\u524D\u767B\u5F55\u8D26\u53F7" },
    { name: "full", type: "bool", default: false, help: "\u83B7\u53D6\u5B8C\u6574\u5F71\u8BC4\u5185\u5BB9" }
  ],
  columns: ["movieTitle", "title", "myRating", "votes", "content", "url"],
  func: async (page, kwargs) => {
    const { limit = 20, uid: providedUid, full = false } = kwargs;
    const uid = providedUid || await getSelfUid(page);
    const reviews = await fetchReviews(page, uid, limit, full);
    return reviews;
  }
});
async function fetchReviews(page, uid, limit, full) {
  const reviews = [];
  let start = 0;
  const pageSize = 20;
  while (true) {
    const url = `https://movie.douban.com/people/${uid}/reviews?start=${start}&sort=time`;
    await page.goto(url);
    await page.wait({ time: 1 });
    const data = await page.evaluate(`
      () => {
        const reviews = [];
        
        document.querySelectorAll('.tlst').forEach(el => {
          const movieLinkEl = el.querySelector('.ilst a');
          const reviewTitleEl = el.querySelector('.nlst a[title]');
          const ratingEl = el.querySelector('.clst span[class*="allstar"]');
          const contentEl = el.querySelector('.review-short span');
          const votesEl = el.querySelector('.review-short .pl span');
          
          const movieHref = movieLinkEl?.href || '';
          const movieId = movieHref.match(/subject\\/(\\d+)/)?.[1] || '';
          const movieTitle = movieLinkEl?.getAttribute('title') || movieLinkEl?.textContent?.trim() || '';
          
          const reviewHref = reviewTitleEl?.href || '';
          const reviewId = reviewHref.match(/reviews\\/(\\d+)/)?.[1] || '';
          const title = reviewTitleEl?.textContent?.trim() || '';
          
          let myRating = 0;
          if (ratingEl) {
            const cls = ratingEl.className || '';
            const ratingMatch = cls.match(/allstar(\\d)0/);
            if (ratingMatch) {
              myRating = parseInt(ratingMatch[1], 10) * 2;
            }
          }
          
          const votesText = votesEl?.textContent || '';
          const votesMatch = votesText.match(/(\\d+)/);
          const votes = votesMatch ? parseInt(votesMatch[1], 10) : 0;
          
          reviews.push({
            reviewId,
            movieId,
            movieTitle,
            title,
            content: contentEl?.textContent?.trim() || '',
            myRating,
            createdAt: '',
            votes,
            url: reviewHref,
          });
        });
        
        return reviews;
      }
    `);
    reviews.push(...data);
    if (data.length < pageSize)
      break;
    if (limit > 0 && reviews.length >= limit)
      break;
    start += pageSize;
  }
  const result = reviews.slice(0, limit > 0 ? limit : void 0);
  if (full && result.length > 0) {
    for (const review of result) {
      if (review.url) {
        const fullContent = await fetchFullReview(page, review.url);
        review.content = fullContent;
      }
    }
  }
  return result;
}
async function fetchFullReview(page, reviewUrl) {
  await page.goto(reviewUrl);
  await page.wait({ time: 1 });
  const content = await page.evaluate(`
    () => {
      const contentEl = document.querySelector('.review-content');
      return contentEl?.textContent?.trim() || '';
    }
  `);
  return content;
}
