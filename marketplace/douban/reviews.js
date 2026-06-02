// ../browser-agent/opencli/clis/douban/reviews.js
import { cli, Strategy } from "@jackwener/opencli/registry";

// ../browser-agent/opencli/clis/douban/utils.js
import { ArgumentError, CliError, EmptyResultError } from "@jackwener/opencli/errors";
// ../browser-agent/opencli/clis/_shared/common.js

// ../browser-agent/opencli/clis/douban/utils.js
async function getSelfUid(page) {
  await page.goto("https://movie.douban.com/mine");
  await page.wait({ time: 2 });
  const uid = await page.evaluate(`
    (() => {
      // 方案1: 尝试从全局变量获取
      if (window.__DATA__ && window.__DATA__.uid) {
        return window.__DATA__.uid;
      }
      
      // 方案2: 从导航栏用户链接获取
      const navUserLink = document.querySelector('.nav-user-account a');
      if (navUserLink) {
        const href = navUserLink.href || '';
        const match = href.match(/people\\/([^/]+)/);
        if (match) return match[1];
      }
      
      // 方案3: 从页面中的个人主页链接获取
      const profileLink = document.querySelector('a[href*="/people/"]');
      if (profileLink) {
        const href = profileLink.getAttribute('href') || profileLink.href || '';
        const match = href.match(/people\\/([^/]+)/);
        if (match) return match[1];
      }
      
      // 方案4: 从头部用户名区域获取
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
  description: "导出个人影评",
  domain: "movie.douban.com",
  strategy: Strategy.COOKIE,
  args: [
    { name: "limit", type: "int", default: 20, help: "导出数量" },
    { name: "uid", help: "用户ID，不填则使用当前登录账号" },
    { name: "full", type: "bool", default: false, help: "获取完整影评内容" }
  ],
  columns: ["movieTitle", "title", "myRating", "votes", "content", "url"],
  func: async (page, kwargs) => {
    const { limit = 20, uid: providedUid, full = false } = kwargs;
    // Trampoline idempotency: page.goto re-executes this func from the top after
    // each navigate+reinject. getSelfUid() goto /mine then fetchReviews goto
    // /people/<uid>/reviews ping-pongs forever unless a replay landing on the
    // reviews list skips the leading /mine navigation. See adapter-hot-plug.md §10.21.
    const curUrl = await page.getCurrentUrl().catch(() => "");
    const onReviewsList = /\/people\/[^/?#]+\/reviews(?:[?#]|$)/.test(curUrl);
    const onReviewDetail = /\/(?:review\/\d+|people\/[^/?#]+\/reviews\/\d+)/.test(curUrl);
    if (full && onReviewDetail && !onReviewsList) {
      // full=true adds a per-review goto to a distinct review-detail page; a
      // replay sitting there must NOT bounce back into the /mine→list cycle.
      // Degrade gracefully so the caller's fallback runs instead of scraping
      // the wrong page or ping-ponging.
      return [];
    }
    let uid = providedUid;
    if (!uid) {
      const listMatch = curUrl.match(/\/people\/([^/?#]+)\/reviews(?:[?#]|$)/);
      uid = listMatch ? listMatch[1] : await getSelfUid(page);
    }
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
