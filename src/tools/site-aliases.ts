/**
 * site → extra match terms (its Chinese name, common abbreviations), shared by
 * adapter discovery (find_adapters scoring) and tool-catalog narrowing
 * (agent/tool-select) — the central fix for "Chinese task text never matches an
 * English site token". Kept high-precision: CN names don't collide with English
 * substrings; ambiguous short latin (x / so / ig / hn) is deliberately omitted.
 */
export const SITE_ALIASES: Record<string, string[]> = {
  weibo: ['微博', '新浪微博'],
  xiaohongshu: ['小红书', 'xhs', 'rednote', '小红书笔记'],
  bilibili: ['哔哩哔哩', 'b站', '叔叔'],
  zhihu: ['知乎'],
  douyin: ['抖音'],
  douban: ['豆瓣'],
  weread: ['微信读书', '微读'],
  'weread-official': ['微信读书', '微读'],
  twitter: ['推特', 'tweet', '推文'],
  instagram: ['照片墙', 'insta'],
  linkedin: ['领英'],
  reddit: ['红迪'],
  youtube: ['油管'],
  tiktok: ['抖音国际版'],
  hackernews: ['hacker news', '黑客新闻'],
  lobsters: ['lobste.rs'],
  stackoverflow: ['stack overflow', '栈溢出', '堆栈溢出'],
  wikipedia: ['维基百科', '维基'],
  arxiv: ['论文', '预印本'],
  chatgpt: ['openai'],
  claude: ['anthropic'],
  gemini: ['谷歌gemini'],
  jimeng: ['即梦'],
  notebooklm: ['notebook lm'],
  producthunt: ['product hunt'],
  devto: ['dev.to', 'dev community'],
  bluesky: ['蓝天', 'bsky'],
  v2ex: [],
};
