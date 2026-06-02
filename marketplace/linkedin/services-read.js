// ../browser-agent/opencli/clis/linkedin/services-read.js
import { cli, Strategy } from "@jackwener/opencli/registry";
import { ArgumentError, AuthRequiredError, CommandExecutionError, EmptyResultError } from "@jackwener/opencli/errors";
// ../browser-agent/opencli/clis/linkedin/shared.js

var LINKEDIN_DOMAIN = "www.linkedin.com";
function unwrapEvaluateResult(payload) {
  if (payload && typeof payload === "object" && "data" in payload && "session" in payload) return payload.data;
  return payload;
}

// Cross-navigation scratchpad (hot-plug trampoline). Installed func adapters run
// in-page and are re-executed from the top after every page.goto, so local vars
// don't survive a navigation. This func reads the services page, then navigates
// to the edit and media pages and reads them too — to carry the earlier snapshots
// across each reinject we stash them in the tab's sessionStorage (same-origin,
// survives same-site navigations) and recover them on the final (media) page.
// See docs/adapter-hot-plug.md §10.22. Scripts are guarded so a page that blocks
// storage degrades to a clear error rather than throwing.
function buildScratchSetScript(key, jsonValue) {
  return `(() => { try { sessionStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(jsonValue)}); return true; } catch (e) { return false; } })()`;
}
function buildScratchGetScript(key) {
  return `(() => { try { return sessionStorage.getItem(${JSON.stringify(key)}); } catch (e) { return null; } })()`;
}
function buildScratchClearScript(key) {
  return `(() => { try { sessionStorage.removeItem(${JSON.stringify(key)}); return true; } catch (e) { return false; } })()`;
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

// ../browser-agent/opencli/clis/linkedin/services-read.js
function normalizeProfileUrl(value) {
  const url = assertSafeLinkedinUrl(value || "https://www.linkedin.com/in/me/", "profile-url", "/in/me/");
  const parsed = new URL(url);
  if (!/^\/in\/[^/?#]+\/?$/.test(parsed.pathname)) {
    throw new CommandExecutionError("LinkedIn services-read requires a /in/<handle>/ profile URL");
  }
  return parsed.toString();
}
function normalizeServicesUrl(value) {
  const url = assertSafeLinkedinUrl(value, "services-url", "/services/page/");
  const parsed = new URL(url);
  if (!/^\/services\/page\/[^/?#]+\/?$/.test(parsed.pathname)) {
    throw new CommandExecutionError("LinkedIn services-read requires a /services/page/<id>/ URL");
  }
  return parsed.toString();
}
function buildFindServicesUrlScript() {
  return String.raw`(() => {
    const link = Array.from(document.querySelectorAll('a[href*="/services/page/"]'))
      .map((a) => a.href || '')
      .find(Boolean);
    return { services_url: link || '' };
  })()`;
}
function buildServicesPageScript() {
  return String.raw`(() => {
    const clean = (s) => String(s || '').replace(/[\u00a0\u202f]+/g, ' ').replace(/\s+/g, ' ').trim();
    const lines = (document.body?.innerText || '').split(/\n+/).map(clean).filter(Boolean);
    const unique = (items) => Array.from(new Set(items.filter(Boolean)));
    const collectAfter = (label, stops) => {
      const index = lines.findIndex((line) => line === label);
      if (index < 0) return [];
      const out = [];
      for (let i = index + 1; i < lines.length; i++) {
        if (stops.includes(lines[i])) break;
        if (lines[i] !== label) out.push(lines[i]);
      }
      return unique(out);
    };
    return {
      service_url: location.href,
      page_title: clean(document.querySelector('main h1, h1')?.innerText || document.title || ''),
      overview: collectAfter('Overview', ['Availability', 'Pricing', 'Services provided', 'Media', 'Reviews']).join('\n'),
      availability: collectAfter('Availability', ['Pricing', 'Services provided', 'Media', 'Reviews']).join('; '),
      pricing: collectAfter('Pricing', ['Services provided', 'Media', 'Reviews']).join('; '),
      services_provided: collectAfter('Services provided', ['Media', 'Reviews', 'Pricing', 'Availability', 'Overview']),
    };
  })()`;
}
function buildMediaPageScript() {
  return String.raw`(() => {
    const clean = (s) => String(s || '').replace(/[\u00a0\u202f]+/g, ' ').replace(/\s+/g, ' ').trim();
    const lines = (document.body?.innerText || '').split(/\n+/).map(clean).filter(Boolean);
    const start = lines.findIndex((line) => line === 'Add media');
    const end = lines.findIndex((line, index) => index > start && line === 'Done');
    const media_lines = start >= 0 && end > start ? lines.slice(start + 1, end) : [];
    return { media_lines };
  })()`;
}
function buildServicesEditScript() {
  return String.raw`(() => {
    const clean = (s) => String(s || '').replace(/[\u00a0\u202f]+/g, ' ').replace(/\s+/g, ' ').trim();
    const dialog = document.querySelector('dialog') || document;
    const overview = dialog.querySelector('textarea')?.value || '';
    const checked = Array.from(dialog.querySelectorAll('[role="checkbox"], [role="switch"], input[type="checkbox"]'))
      .map((el) => ({
        label: clean(el.getAttribute('aria-label') || el.innerText || el.closest('div')?.innerText || el.parentElement?.innerText || ''),
        checked: el.getAttribute('aria-checked') === 'true' || el.checked === true,
      }));
    const radios = Array.from(dialog.querySelectorAll('[role="radio"], input[type="radio"]'))
      .map((el) => ({
        label: clean(el.getAttribute('aria-label') || el.innerText || el.closest('div')?.innerText || el.parentElement?.innerText || ''),
        checked: el.getAttribute('aria-checked') === 'true' || el.checked === true,
      }));
    return {
      overview,
      work_locations: checked.filter((item) => item.checked && !/message|linkedin members|reviews?/i.test(item.label)).map((item) => item.label),
      messages: checked.find((item) => /message|open profile/i.test(item.label))?.checked ? 'on' : 'off',
      reviews_visibility: checked.find((item) => /all linkedin members/i.test(item.label))?.checked ? 'on' : 'off',
      pricing: radios.find((item) => item.checked)?.label || '',
    };
  })()`;
}
function pairsToMedia(items) {
  const lines = Array.isArray(items) ? items.map(normalizeWhitespace).filter(Boolean) : [];
  const pairs = [];
  for (let i = 0; i < lines.length; i += 2) {
    const title = lines[i] || "";
    const description = lines[i + 1] || "";
    if (title) pairs.push(description ? `${title} — ${description}` : title);
  }
  return pairs;
}
function normalizeServices(row) {
  if (!row || typeof row !== "object") {
    throw new CommandExecutionError("LinkedIn services-read returned malformed extraction payload");
  }
  const services = Array.isArray(row.services_provided) ? row.services_provided.map(normalizeWhitespace).filter(Boolean) : [];
  const mediaItems = pairsToMedia(row.media_lines);
  const publicMedia = [];
  const serviceUrl = normalizeWhitespace(row.service_url);
  const pageTitle = normalizeWhitespace(row.page_title);
  const overview = normalizeWhitespace(row.overview);
  const availability = normalizeWhitespace(row.availability);
  if (!serviceUrl || !pageTitle && !overview && services.length === 0) {
    throw new CommandExecutionError("LinkedIn services-read could not find stable Services page content");
  }
  return {
    service_url: serviceUrl,
    page_title: pageTitle,
    overview,
    availability,
    work_locations: Array.isArray(row.work_locations) ? row.work_locations.map((item) => {
      const text = normalizeWhitespace(item);
      const words = text.split(" ");
      if (words.length % 2 === 0) {
        const half = words.length / 2;
        const left = words.slice(0, half).join(" ");
        if (left === words.slice(half).join(" ")) return left;
      }
      return text;
    }).filter(Boolean).join("; ") : "",
    pricing: normalizeWhitespace(row.pricing).replace(/^Pricing,\s*Select one option,\s*/i, "").replace(/,\s*required$/i, ""),
    services_provided: services.join("; "),
    services_count: String(services.length),
    media: (mediaItems.length > 0 ? mediaItems : publicMedia).join("\n"),
    media_count: String(mediaItems.length || publicMedia.length),
    messages: normalizeWhitespace(row.messages),
    reviews_visibility: normalizeWhitespace(row.reviews_visibility)
  };
}
var SCRATCH_KEY = "__webchat_linkedin_services_read__";
function deriveEditUrl(servicesUrl) {
  const url = new URL(servicesUrl);
  url.pathname = url.pathname.replace(/\/(?:edit|media)\/?$/, "/").replace(/\/?$/, "/edit/");
  return url.toString();
}
function deriveMediaUrl(servicesUrl) {
  const url = new URL(servicesUrl);
  url.pathname = url.pathname.replace(/\/(?:edit|media)\/?$/, "/").replace(/\/?$/, "/media/");
  return url.toString();
}
function isServicesEditUrl(url) {
  return /\/services\/page\/[^/?#]+\/edit(?:\/|\?|#|$)/.test(url);
}
function isServicesMediaUrl(url) {
  return /\/services\/page\/[^/?#]+\/media(?:\/|\?|#|$)/.test(url);
}
function isServicesPageUrl(url) {
  return /\/services\/page\/[^/?#]+(?:\/|\?|#|$)/.test(url) && !isServicesEditUrl(url) && !isServicesMediaUrl(url);
}
async function readScratch(page) {
  const raw = unwrapEvaluateResult(await page.evaluate(buildScratchGetScript(SCRATCH_KEY)));
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
async function mergeScratch(page, patch) {
  const current = await readScratch(page);
  const next = { ...current, ...patch };
  await page.evaluate(buildScratchSetScript(SCRATCH_KEY, JSON.stringify(next)));
}
cli({
  site: "linkedin",
  name: "services-read",
  access: "read",
  description: "Read LinkedIn Services page details including services, overview, availability, pricing, and media titles/descriptions",
  domain: "www.linkedin.com",
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: "profile-url", type: "string", required: false, help: "LinkedIn /in/<handle>/ profile URL. Defaults to /in/me/." },
    { name: "services-url", type: "string", required: false, help: "LinkedIn /services/page/<id>/ URL. If omitted, it is discovered from the profile." }
  ],
  columns: ["service_url", "page_title", "overview", "availability", "work_locations", "pricing", "services_provided", "services_count", "media", "media_count", "messages", "reviews_visibility"],
  func: async (page, args) => {
    if (!page) throw new CommandExecutionError("Browser session required for linkedin services-read");
    let servicesUrl = normalizeWhitespace(args["services-url"]);
    const shouldReadOwnerEdit = !servicesUrl && !normalizeWhitespace(args["profile-url"]);
    if (!shouldReadOwnerEdit) {
      // Non-interleaved paths: the only merged scrape is the Services page, so a
      // single URL guard keeps the replay (which already landed on the Services
      // page) from bouncing back to re-discover/re-navigate. No sessionStorage
      // state machine is needed because nothing earlier feeds into the result.
      const here = await page.getCurrentUrl().catch(() => "");
      if (!isServicesPageUrl(here)) {
        if (servicesUrl) {
          servicesUrl = normalizeServicesUrl(servicesUrl);
        } else {
          await page.goto(normalizeProfileUrl(args["profile-url"]));
          await page.wait(5);
          await assertLinkedInAuthenticated(page, "LinkedIn services-read profile");
          const found = unwrapEvaluateResult(await page.evaluate(buildFindServicesUrlScript()));
          servicesUrl = normalizeWhitespace(found?.services_url);
          if (!servicesUrl) throw new EmptyResultError("linkedin services-read", "No LinkedIn Services page link was found on the profile.");
          servicesUrl = normalizeServicesUrl(servicesUrl);
        }
        await page.goto(servicesUrl);
      }
      await page.wait(5);
      await assertLinkedInAuthenticated(page, "LinkedIn services-read");
      const services2 = unwrapEvaluateResult(await page.evaluate(buildServicesPageScript()));
      return [normalizeServices({ ...services2 })];
    }
    // Owner-edit path: interleaved 4-stage state machine. We scrape the Services,
    // edit, and media pages — each into the merged result — but every page.goto
    // reinjects and re-runs this func from the top, losing locals. Stash each
    // earlier snapshot in the tab's sessionStorage (same-origin, survives the
    // navigations) and reconstruct the merge on the final (media) page. The
    // current-URL guards make each replay resume at its own stage instead of
    // ping-ponging back to the profile/services pages. See §10.22.
    const here = await page.getCurrentUrl().catch(() => "");
    if (isServicesMediaUrl(here)) {
      // Final stage: scrape media, recover the stashed Services + edit snapshots.
      await page.wait(4);
      await assertLinkedInAuthenticated(page, "LinkedIn services-read media");
      const media = unwrapEvaluateResult(await page.evaluate(buildMediaPageScript()));
      const stash = await readScratch(page);
      await page.evaluate(buildScratchClearScript(SCRATCH_KEY));
      if (!stash.services || !stash.edit) {
        throw new CommandExecutionError("LinkedIn services-read lost its Services/edit snapshot across the media navigation (sessionStorage unavailable?).");
      }
      return [normalizeServices({ ...stash.services, ...stash.edit, ...media })];
    }
    if (isServicesEditUrl(here)) {
      // Stage 3: scrape the owner edit dialog, stash it, then go to the media page.
      await page.wait(4);
      await assertLinkedInAuthenticated(page, "LinkedIn services-read edit");
      const edit = unwrapEvaluateResult(await page.evaluate(buildServicesEditScript()));
      await mergeScratch(page, { edit });
      await page.goto(deriveMediaUrl(here));
      await page.wait(4);
      await assertLinkedInAuthenticated(page, "LinkedIn services-read media");
      const media = unwrapEvaluateResult(await page.evaluate(buildMediaPageScript()));
      const stash = await readScratch(page);
      await page.evaluate(buildScratchClearScript(SCRATCH_KEY));
      if (!stash.services || !stash.edit) {
        throw new CommandExecutionError("LinkedIn services-read lost its Services/edit snapshot across the media navigation (sessionStorage unavailable?).");
      }
      return [normalizeServices({ ...stash.services, ...stash.edit, ...media })];
    }
    if (!isServicesPageUrl(here)) {
      // Stage 1 (discover): find the Services page link on the profile, stash the
      // discovered URL (it is computed before navigation), then go to it.
      await page.goto(normalizeProfileUrl(args["profile-url"]));
      await page.wait(5);
      await assertLinkedInAuthenticated(page, "LinkedIn services-read profile");
      const found = unwrapEvaluateResult(await page.evaluate(buildFindServicesUrlScript()));
      servicesUrl = normalizeWhitespace(found?.services_url);
      if (!servicesUrl) throw new EmptyResultError("linkedin services-read", "No LinkedIn Services page link was found on the profile.");
      servicesUrl = normalizeServicesUrl(servicesUrl);
      await mergeScratch(page, { servicesUrl });
      await page.goto(servicesUrl);
    }
    // Stage 2 (Services page): scrape it, stash the snapshot + URL, go to edit.
    await page.wait(5);
    await assertLinkedInAuthenticated(page, "LinkedIn services-read");
    const services = unwrapEvaluateResult(await page.evaluate(buildServicesPageScript()));
    const hereServices = await page.getCurrentUrl().catch(() => "");
    const stashUrl = (await readScratch(page)).servicesUrl;
    const baseServicesUrl = stashUrl || (isServicesPageUrl(hereServices) ? hereServices : "");
    if (!baseServicesUrl) {
      // Cannot derive the /edit/ and /media/ URLs without the Services page URL.
      // This only happens when the discovered URL did not survive the navigation
      // (sessionStorage unavailable) and the live URL is also unavailable — fail
      // closed with a clear error rather than letting deriveEditUrl throw on `new URL("")`.
      throw new CommandExecutionError("LinkedIn services-read lost its Services page URL across the edit navigation (sessionStorage unavailable?).");
    }
    await mergeScratch(page, { services, servicesUrl: baseServicesUrl });
    await page.goto(deriveEditUrl(baseServicesUrl));
    // Stage 3 (edit page): scrape the owner edit dialog, stash it, go to media.
    await page.wait(4);
    await assertLinkedInAuthenticated(page, "LinkedIn services-read edit");
    const edit = unwrapEvaluateResult(await page.evaluate(buildServicesEditScript()));
    await mergeScratch(page, { edit });
    await page.goto(deriveMediaUrl(baseServicesUrl));
    // Stage 4 (media page, final): scrape it, recover the merged stash, return.
    await page.wait(4);
    await assertLinkedInAuthenticated(page, "LinkedIn services-read media");
    const media = unwrapEvaluateResult(await page.evaluate(buildMediaPageScript()));
    const stash = await readScratch(page);
    await page.evaluate(buildScratchClearScript(SCRATCH_KEY));
    if (!stash.services || !stash.edit) {
      throw new CommandExecutionError("LinkedIn services-read lost its Services/edit snapshot across the media navigation (sessionStorage unavailable?).");
    }
    return [normalizeServices({ ...stash.services, ...stash.edit, ...media })];
  }
});
var __test__ = {
  normalizeProfileUrl,
  normalizeServicesUrl,
  pairsToMedia,
  normalizeServices
};
export {
  __test__
};
