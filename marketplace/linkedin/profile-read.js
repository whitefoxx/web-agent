// ../browser-agent/opencli/clis/linkedin/profile-read.js
import { cli, Strategy } from "@jackwener/opencli/registry";
import { CommandExecutionError as CommandExecutionError2 } from "@jackwener/opencli/errors";

// ../browser-agent/opencli/clis/linkedin/shared.js
import { ArgumentError, AuthRequiredError, CommandExecutionError } from "@jackwener/opencli/errors";
var LINKEDIN_DOMAIN = "www.linkedin.com";
function unwrapEvaluateResult(payload) {
  if (payload && typeof payload === "object" && "data" in payload && "session" in payload) return payload.data;
  return payload;
}
function normalizeWhitespace(value) {
  return String(value ?? "").replace(/[\u00a0\u202f]+/g, " ").replace(/\s+/g, " ").trim();
}
function compactRepeatedText(value) {
  const text = normalizeWhitespace(value);
  if (!text) return "";
  if (text.length % 2 === 0) {
    const half = text.length / 2;
    const left = text.slice(0, half);
    if (left === text.slice(half)) return left;
  }
  const words = text.split(" ");
  if (words.length % 2 === 0) {
    const half = words.length / 2;
    const left = words.slice(0, half).join(" ");
    if (left === words.slice(half).join(" ")) return left;
  }
  return text;
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

// ../browser-agent/opencli/clis/linkedin/profile-read.js
function normalizeProfileReadUrl(value) {
  const url = assertSafeLinkedinUrl(value || "https://www.linkedin.com/in/me/", "profile-url", "/in/me/");
  const parsed = new URL(url);
  if (!/^\/in\/[^/?#]+\/?$/.test(parsed.pathname)) {
    throw new CommandExecutionError2("LinkedIn profile-read requires a /in/<handle>/ profile URL");
  }
  return parsed.toString();
}
function buildProfileExtractionScript() {
  return String.raw`(() => {
    const clean = (s) => String(s || '').replace(/[\u00a0\u202f]+/g, ' ').replace(/\s+/g, ' ').trim();
    const compact = (s) => {
      const text = clean(s);
      if (!text) return '';
      if (text.length % 2 === 0 && text.slice(0, text.length / 2) === text.slice(text.length / 2)) {
        return text.slice(0, text.length / 2);
      }
      return text;
    };
    const readSection = (headingPattern) => {
      const headings = Array.from(document.querySelectorAll('section h2, section h3, h2, h3'));
      const heading = headings.find((el) => headingPattern.test(clean(el.innerText || el.textContent || '')));
      const section = heading?.closest('section');
      if (!section) return '';
      const text = clean(section.innerText || section.textContent || '');
      return clean(text.replace(headingPattern, '').replace(/\bShow all.*$/i, '').replace(/\bSee more.*$/i, ''));
    };
    const nameHeading = document.querySelector('main h1, main h2');
    const intro = nameHeading?.closest('section') || document.querySelector('main section') || document.body;
    const lines = (intro.innerText || intro.textContent || '').split(/\n+/).map(clean).filter(Boolean);
    const name = compact(clean(nameHeading?.innerText || nameHeading?.textContent || lines[0] || ''));
    const skipIntro = (line) => !line
      || line === name
      || /^(1st|2nd|3rd|contact info|message|more|follow|connect|open to|add section|enhance profile|resources|self employed)$/i.test(line)
      || /^\d[\d,]*\s+(followers|connections)/i.test(line)
      || line === '·';
    const headline = compact(lines.find((line) => !skipIntro(line) && line.length > 20) || '');
    const locationText = lines.find((line) => /(area|india|jaipur|bangalore|bengaluru|delhi|mumbai|hyderabad|pune)/i.test(line) && line.length < 120) || '';
    const about = readSection(/^About$/i);
    const experience = readSection(/^Experience$/i);
    const education = readSection(/^Education$/i);
    const featured = readSection(/^Featured$/i);
    const services = readSection(/^Services$/i) || readSection(/^Providing services$/i);
    return {
      profile_url: window.location.href,
      name,
      headline,
      location: locationText,
      about,
      experience,
      education,
      services,
      featured,
    };
  })()`;
}
function buildAboutEditExtractionScript() {
  return String.raw`(() => {
    const clean = (s) => String(s || '').replace(/[\u00a0\u202f]+/g, ' ').replace(/\s+/g, ' ').trim();
    const dialog = document.querySelector('dialog') || document;
    const editor = dialog.querySelector('[contenteditable="true"]');
    const about = Array.from(editor?.querySelectorAll('p') || [])
      .map((p) => clean(p.innerText || p.textContent || ''))
      .join('\n')
      .trim();
    const about_skills = Array.from(dialog.querySelectorAll('[role="listitem"][aria-label]'))
      .map((el) => clean(el.getAttribute('aria-label') || ''))
      .filter(Boolean);
    const about_character_count = Array.from(dialog.querySelectorAll('span, p'))
      .map((el) => clean(el.innerText || el.textContent || ''))
      .find((text) => /^\d[\d,]*\/2,600$/.test(text)) || '';
    return { about, about_skills, about_character_count };
  })()`;
}
function normalizeProfile(row) {
  if (!row || typeof row !== "object") {
    throw new CommandExecutionError2("LinkedIn profile-read returned malformed extraction payload");
  }
  const name = compactRepeatedText(row.name);
  if (!name) throw new CommandExecutionError2("LinkedIn profile-read could not find a profile name");
  return {
    profile_url: normalizeWhitespace(row.profile_url),
    name,
    headline: compactRepeatedText(row.headline),
    location: normalizeWhitespace(row.location),
    about: normalizeWhitespace(row.about),
    about_character_count: normalizeWhitespace(row.about_character_count),
    about_skills: Array.isArray(row.about_skills) ? row.about_skills.map(normalizeWhitespace).filter(Boolean).join("; ") : "",
    experience: normalizeWhitespace(row.experience),
    education: normalizeWhitespace(row.education),
    services: normalizeWhitespace(row.services),
    featured: normalizeWhitespace(row.featured)
  };
}
cli({
  site: "linkedin",
  name: "profile-read",
  access: "read",
  description: "Read visible LinkedIn profile sections: headline, About, experience, education, services, and featured sections",
  domain: "www.linkedin.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "profile-url", type: "string", required: false, help: "LinkedIn /in/<handle>/ profile URL. Defaults to /in/me/." }
  ],
  columns: ["profile_url", "name", "headline", "location", "about", "about_character_count", "about_skills", "experience", "education", "services", "featured"],
  func: async (page, args) => {
    if (!page) throw new CommandExecutionError2("Browser session required for linkedin profile-read");
    const profileUrl = normalizeProfileReadUrl(args["profile-url"]);
    const shouldReadEditor = !normalizeWhitespace(args["profile-url"]);
    await page.goto(profileUrl);
    await page.wait(5);
    await assertLinkedInAuthenticated(page, "LinkedIn profile-read");
    await page.autoScroll({ times: 4, delayMs: 700 });
    await page.wait(1);
    const row = unwrapEvaluateResult(await page.evaluate(buildProfileExtractionScript()));
    let aboutEdit = {};
    if (shouldReadEditor) {
      const currentProfileUrl = normalizeWhitespace(row?.profile_url) || profileUrl;
      const profilePath = new URL(currentProfileUrl).pathname.replace(/\/?$/, "/");
      const aboutEditUrl = new URL(`${profilePath}edit/forms/summary/new/`, "https://www.linkedin.com").toString();
      await page.goto(aboutEditUrl);
      await page.wait(4);
      await assertLinkedInAuthenticated(page, "LinkedIn profile-read about editor");
      aboutEdit = unwrapEvaluateResult(await page.evaluate(buildAboutEditExtractionScript()));
    }
    return [normalizeProfile({ ...row, ...aboutEdit })];
  }
});
var __test__ = {
  normalizeProfileReadUrl,
  normalizeProfile
};
export {
  __test__
};
