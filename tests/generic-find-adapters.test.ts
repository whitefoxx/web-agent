/**
 * find_adapters discovery (browseract-comparison ⑬ → v2, discovery-token audit
 * 2026-07-10): site aliases + CN↔EN task synonyms + UNSEGMENTED-Chinese vocab
 * extraction + weighted (site ≫ name ≫ desc) ranking. Pure scoring; node.
 */

import { describe, it, expect } from 'vitest';
import {
  extractTerms,
  scoreAdapter,
  rankAdapters,
  SITE_ALIASES,
} from '../src/tools/generic/find-adapters';

const score = (q: string, a: { site?: string; name?: string; description?: string }): number =>
  scoreAdapter(extractTerms(q, [a.site ?? '']), a);

const weiboComments = {
  site: 'weibo',
  name: 'comments',
  description: 'Get comments on a Weibo post',
  domain: 'weibo.com',
};
const weiboSearch = {
  site: 'weibo',
  name: 'search',
  description: 'Search weibo posts by keyword',
  domain: 'weibo.com',
};
const weiboLike = { site: 'weibo', name: 'like', description: 'Like a weibo post' };
const weiboHot = { site: 'weibo', name: 'hot', description: 'Weibo trending topics' };
const twitterSearch = {
  site: 'twitter',
  name: 'search',
  description: 'Search Twitter/X for tweets',
  domain: 'x.com',
};
const linkedinInbox = {
  site: 'linkedin',
  name: 'inbox',
  description: 'List LinkedIn messaging inbox conversations',
  domain: 'linkedin.com',
};
const zhihuHot = { site: 'zhihu', name: 'hot', description: '知乎热榜', domain: 'zhihu.com' };

describe('extractTerms (CJK vocab segmentation)', () => {
  it('segments an UNSEGMENTED Chinese query into site + task terms', () => {
    const terms = extractTerms('微博热搜', ['weibo']);
    expect(terms).toContain('微博');
    expect(terms).toContain('热搜');
  });

  it('segments a site token glued to a CN task word', () => {
    expect(extractTerms('zhihu热榜', ['zhihu'])).toEqual(expect.arrayContaining(['zhihu', '热榜']));
  });

  it('a URL in the query contributes its site label', () => {
    expect(extractTerms('看看 https://www.zhihu.com/hot 上有什么', ['zhihu'])).toContain('zhihu');
  });

  it('empty query → no terms', () => {
    expect(extractTerms('  ', ['weibo'])).toEqual([]);
  });
});

describe('scoreAdapter (weighted: site 3 > name 2 > desc 1)', () => {
  it('a Chinese site alias matches an ENGLISH-described adapter (was 0 before ⑬)', () => {
    expect(score('微博', weiboComments)).toBe(3);
    expect(score('领英', linkedinInbox)).toBe(3);
    expect(score('推特', twitterSearch)).toBe(3);
  });

  it('CN↔EN task synonym: 搜索 matches "search"; 评论 matches "comments"', () => {
    expect(score('搜索', twitterSearch)).toBeGreaterThan(0);
    expect(score('评论', weiboComments)).toBeGreaterThan(0);
    expect(score('私信', linkedinInbox)).toBeGreaterThan(0); // 私信→message ~ "messaging inbox"
  });

  it('UNSEGMENTED "微博热搜" scores site + task (the v1 zero-hit case)', () => {
    expect(score('微博热搜', weiboHot)).toBe(5); // 微博→site(3) + 热搜→hot name(2)
  });

  it('the explored namespace (my-zhihu) matches its base alias', () => {
    expect(score('知乎', { site: 'my-zhihu', name: 'hot', description: 'hot list' })).toBe(3);
  });

  it('English queries still work (no regression)', () => {
    expect(score('twitter search', twitterSearch)).toBe(5);
    expect(score('zhihu', zhihuHot)).toBe(3);
    expect(score('热榜', zhihuHot)).toBeGreaterThan(0);
  });

  it('unrelated query → 0', () => {
    expect(score('spotify playlist', weiboComments)).toBe(0);
  });
});

describe('rankAdapters', () => {
  const corpus = [weiboComments, weiboSearch, weiboLike, weiboHot, twitterSearch, linkedinInbox];

  it('「首页」ranks a timeline/feed adapter above site-wide search (s_mregtz8u)', () => {
    const timeline = {
      site: 'twitter',
      name: 'timeline',
      description: "Fetch the logged-in user's home timeline",
    };
    const ranked = rankAdapters('推特 首页', [...corpus, timeline]);
    const ids = ranked.map((r) => `${r.site}__${r.name}`);
    expect(ids[0]).toBe('twitter__timeline'); // site(3) + 首页→timeline name(2)
    expect(ids.indexOf('twitter__timeline')).toBeLessThan(ids.indexOf('twitter__search'));
  });

  it('site + task query ranks the right adapter first (site dominates)', () => {
    const ranked = rankAdapters('微博 搜索', corpus);
    expect(`${ranked[0].site}__${ranked[0].name}`).toBe('weibo__search');
    // Same-site but wrong task ranks below; other-site same-task ranks below too.
    const ids = ranked.map((r) => `${r.site}__${r.name}`);
    expect(ids.indexOf('weibo__search')).toBeLessThan(ids.indexOf('weibo__like'));
    expect(ids.indexOf('weibo__search')).toBeLessThan(ids.indexOf('twitter__search'));
  });

  it('flags siteHit so callers can require the strong signal', () => {
    const ranked = rankAdapters('微博热搜', corpus);
    expect(ranked[0].siteHit).toBe(true);
    const taskOnly = rankAdapters('搜索', corpus);
    expect(taskOnly.every((r) => !r.siteHit)).toBe(true);
  });

  it('task-only query still finds matches across sites', () => {
    const ranked = rankAdapters('search', corpus);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked.every((r) => r.score > 0)).toBe(true);
  });
});

describe('SITE_ALIASES (re-exported for compat)', () => {
  it('folds in the expected CN names', () => {
    expect(SITE_ALIASES.linkedin).toContain('领英');
    expect(SITE_ALIASES.weibo).toContain('微博');
  });
});
