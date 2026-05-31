// ../browser-agent/opencli/clis/linkedin/profile-analytics.js
import { cli, Strategy } from "@jackwener/opencli/registry";
import { ArgumentError, AuthRequiredError, CommandExecutionError, EmptyResultError } from "@jackwener/opencli/errors";
// ../browser-agent/opencli/clis/linkedin/shared.js

var LINKEDIN_DOMAIN = "www.linkedin.com";
function unwrapEvaluateResult(payload) {
  if (payload && typeof payload === "object" && "data" in payload && "session" in payload) return payload.data;
  return payload;
}
function normalizeWhitespace(value) {
  return String(value ?? "").replace(/[\u00a0\u202f]+/g, " ").replace(/\s+/g, " ").trim();
}
function assertSafeLinkedinUrl(value, label, fallbackPath = "/") {
  const raw = normalizeWhitespace(value || `https://www.linkedin.com${fallbackPath}`);
  let parsed;
  try {
    parsed = new URL(raw, "https://www.linkedin.com");
  } catch {
    throw new ArgumentError(`${label} must be a LinkedIn URL`);
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) {
    throw new ArgumentError(`${label} must be an https LinkedIn URL without credentials or port`);
  }
  if (host !== "linkedin.com" && host !== "www.linkedin.com") {
    throw new ArgumentError(`${label} must point to linkedin.com`);
  }
  return parsed.toString();
}
function buildAuthProbeScript() {
  return String.raw`(() => {
    const text = [
      window.location.href || '',
      document.title || '',
      document.body ? (document.body.innerText || '').slice(0, 4000) : '',
    ].join('\n');
    return /linkedin\.com\/(?:login|checkpoint|authwall|uas)/i.test(text)
      || /\b(sign in|log in|join linkedin|captcha|verification required)\b/i.test(text)
      || /(请登录|登录领英|安全验证)/.test(text);
  })()`;
}
async function assertLinkedInAuthenticated(page, context) {
  const authRequired = unwrapEvaluateResult(await page.evaluate(buildAuthProbeScript()));
  if (authRequired) {
    throw new AuthRequiredError(LINKEDIN_DOMAIN, `${context} requires an active signed-in LinkedIn browser session.`);
  }
}

// ../browser-agent/opencli/clis/linkedin/profile-analytics.js
function normalizeProfileAnalyticsUrl(value) {
  const url = assertSafeLinkedinUrl(value || "https://www.linkedin.com/in/me/", "profile-url", "/in/me/");
  const parsed = new URL(url);
  if (!/^\/in\/[^/?#]+\/?$/.test(parsed.pathname)) {
    throw new CommandExecutionError("LinkedIn profile-analytics requires a /in/<handle>/ profile URL");
  }
  return parsed.toString();
}
function parseMetric(value) {
  const raw = normalizeWhitespace(value).toLowerCase().replace(/,/g, "");
  const match = raw.match(/(\d+(?:\.\d+)?)(k|m)?/i);
  if (!match) return "";
  const base = Number(match[1]);
  if (match[2]?.toLowerCase() === "k") return String(Math.round(base * 1e3));
  if (match[2]?.toLowerCase() === "m") return String(Math.round(base * 1e6));
  return String(Math.round(base));
}
function firstMetric(text, patterns) {
  for (const pattern of patterns) {
    const match = normalizeWhitespace(text).match(pattern);
    if (match) return parseMetric(match[1]);
  }
  return "";
}
function parseDashboardMetrics(text) {
  const normalized = normalizeWhitespace(text);
  return {
    profile_views: firstMetric(normalized, [/(\d[\d,.]*\s*(?:k|m)?)\s+profile views?/i, /profile views?\s+(\d[\d,.]*\s*(?:k|m)?)/i]),
    post_impressions: firstMetric(normalized, [/(\d[\d,.]*\s*(?:k|m)?)\s+post impressions?/i, /post impressions?\s+(\d[\d,.]*\s*(?:k|m)?)/i]),
    search_appearances: firstMetric(normalized, [/(\d[\d,.]*\s*(?:k|m)?)\s+search appearances?/i, /search appearances?\s+(\d[\d,.]*\s*(?:k|m)?)/i]),
    followers: firstMetric(normalized, [/(\d[\d,.]*\s*(?:k|m)?)\s+followers?/i]),
    connections: firstMetric(normalized, [/(\d[\d,.]*\s*(?:k|m)?)\s+connections?/i])
  };
}
function buildProfileAnalyticsScript() {
  return String.raw`(() => {
    const clean = (s) => String(s || '').replace(/[\u00a0\u202f]+/g, ' ').replace(/\s+/g, ' ').trim();
    const text = clean(document.body?.innerText || document.body?.textContent || '');
    const matches = [
      ...text.matchAll(/\d[\d,.]*\s*(?:k|m)?\s+(?:profile views?|post impressions?|search appearances?|followers?|connections?)/gi),
    ].map((match) => clean(match[0]));
    return {
      profile_url: window.location.href,
      raw_analytics: matches.join(' | '),
    };
  })()`;
}
function normalizeAnalytics(row) {
  if (!row || typeof row !== "object") {
    throw new CommandExecutionError("LinkedIn profile-analytics returned malformed extraction payload");
  }
  const metrics = parseDashboardMetrics(row.raw_analytics);
  if (!Object.values(metrics).some(Boolean)) {
    throw new EmptyResultError("linkedin profile-analytics", "No visible LinkedIn profile analytics counters were found.");
  }
  return {
    profile_url: normalizeWhitespace(row.profile_url),
    ...metrics,
    raw_analytics: normalizeWhitespace(row.raw_analytics)
  };
}
cli({
  site: "linkedin",
  name: "profile-analytics",
  access: "read",
  description: "Read visible LinkedIn profile dashboard metrics such as profile views, post impressions, and search appearances",
  domain: "www.linkedin.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "profile-url", type: "string", required: false, help: "LinkedIn /in/<handle>/ profile URL. Defaults to /in/me/." }
  ],
  columns: ["profile_url", "profile_views", "post_impressions", "search_appearances", "followers", "connections", "raw_analytics"],
  func: async (page, args) => {
    if (!page) throw new CommandExecutionError("Browser session required for linkedin profile-analytics");
    await page.goto(normalizeProfileAnalyticsUrl(args["profile-url"]));
    await page.wait(5);
    await assertLinkedInAuthenticated(page, "LinkedIn profile-analytics");
    const row = unwrapEvaluateResult(await page.evaluate(buildProfileAnalyticsScript()));
    return [normalizeAnalytics(row)];
  }
});
var __test__ = {
  normalizeProfileAnalyticsUrl,
  parseMetric,
  parseDashboardMetrics,
  normalizeAnalytics
};
export {
  __test__
};
