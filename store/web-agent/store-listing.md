# Web Agent — Chrome Web Store listing copy

> **Not submitted yet.** This extension has never been on the store. The two
> agent-free shells built from the same base have been (WebCLI, localmd Connect
> — their copy lives in the `web-tools` repo). Treat everything here as a first
> submission: it needs the full privacy form, not an update form.

## Store name (≤45 chars)

Web Agent - AI That Uses Your Browser

> This must match `manifest.json`'s `name`, which the store displays. 36 chars.
> An ASCII hyphen, not an en-dash.
>
> The name doubles as the **tab-group title**: `controlled-tabs.ts` cuts at the
> first dash, so tabs the agent opens are grouped under "Web Agent". Keep that
> as the leading token — changing it orphans existing groups.

## Summary (single line, ≤132 chars)

An AI agent in your side panel that drives your real, signed-in Chrome — reads pages, clicks, fills forms, learns new sites.

## Description

> **Do not list site names here, or in the screenshots.** A sibling extension's
> first submission was rejected for keyword spam over exactly that: one sentence
> naming fourteen sites. This one still carries a per-site catalog in the code,
> which makes the temptation worse and the rejection likelier — and the catalog
> is not a selling point here anyway (see the pillar it was demoted out of). Describe capability by
> category; let nothing in the copy or the images read as a list of third-party
> brands.

Web Agent puts an AI agent in your browser's side panel and gives it hands.

Ask for something in plain language and it works the page the way you would —
opens tabs, reads them, clicks, fills forms, scrolls, screenshots, and comes back
with an answer. Because it drives **your** Chrome, it is already signed in
wherever you are. No cookie pasting, no second browser, no scraper to maintain,
and none of the bot walls that stop a headless one.

You bring the model. Point it at any OpenAI-compatible endpoint and paste your
own key; it is stored on your machine and used from your machine. There is no
account here and no server of ours in the path.

**50+ browser tools.** The primitives an agent actually needs: open a URL and
read it as clean text or Markdown, list what is clickable, click, type, fill a
whole form in one call, press keys, scroll, screenshot, upload a file, manage
tabs, search the web, and fetch any URL with your own cookies — past the CORS
wall that stops an ordinary web page calling most APIs.

**It can learn a site nobody wrote support for.** Reconnaissance tools answer
"where does this value actually come from" — the page's structured data, its
accessibility tree, the requests it makes — and it can run JavaScript in the
page's own origin. Watch it work an unfamiliar site out in one session, then
have it save what it learned as a reusable tool, so the second time is instant
and deterministic instead of another round of guessing.

A small number of pre-written site tools can also be installed on demand, each
verified against a published checksum before it runs. They are a convenience,
not the plan: a hand-maintained list of sites is the part nobody can keep from
rotting, and capability here is meant to come from the primitives above plus
what the agent works out with you.

**Work that runs without you.** Save a prompt as a reusable workflow, or schedule
one to run on its own and notify you when it is done. The agent keeps a memory of
what you have told it, so you are not re-explaining your setup every session.

**And persistent page fixes.** Site scripts let you fix a page once and keep it
fixed: hide the ad rails and the clutter, restyle a site you read daily, or run a
small script on pages you choose, on every visit until you remove it.

━━━ WHAT YOU CAN DO ━━━

• Ask a question that needs three signed-in sites and get one answer back
• Research, compare and summarize without opening the tabs yourself
• Fill in long forms and drive multi-step flows while you watch
• Read any article as clean Markdown, or pull JSON and RSS with your session
• Teach it a site it has never seen, and keep what it learned
• Schedule a task and get a notification when it finishes
• Strip the noise from a site you read daily, permanently

━━━ YOU DECIDE, ALWAYS ━━━

• **Anything that writes stops and asks.** Posting, sending, commenting,
following, deleting, downloading — the agent has to raise a confirmation in the
side panel showing exactly what it is about to do, and a prompt left unanswered
counts as no
• Write tools are hidden from the model's first look at the toolbox, so it has
to go looking before it can even ask
• **No credentials are stored.** It reuses the session you already have. Your
API key lives in local extension storage and clearing settings clears it
• Every installed site tool is checksum-verified before it runs, and you can
uninstall any of them
• Every site script is listed where you can pause or delete it
• Nothing is sent to any server of ours — there is no server. Your model
provider sees what you send it, and nobody else does

━━━ BEFORE YOU INSTALL ━━━

• **You need your own API key** for an OpenAI-compatible model provider. The
extension has no model of its own and no free tier — it is the hands, you bring
the brain.
• **Chrome 138+**, and site scripts need Chrome's **"Allow user scripts"**
switch on this extension's details page. It is one click, and everything else
works without it.
• It uses Chrome's debugger interface to drive pages reliably, so Chrome shows a
"being debugged" bar on tabs it is working on. It detaches when the task ends.

━━━ GET STARTED ━━━

1. Install Web Agent and open the side panel from the toolbar.
2. Menu → LLM backend: pick a provider, paste your key, choose a model.
3. Ask it for something. Turn on "Allow user scripts" when you want persistent
   page fixes.

Source, docs and issues: https://github.com/whitefoxx/web-agent

## Dashboard fields — the Privacy form, ready to paste

**Category:** Productivity (secondary: Developer Tools)

Three things differ from the two lean shells' forms, and they are the ones to
get right: this shell requests **`sidePanel`**, **`offscreen`**, **`alarms`** and
**`notifications`**, which they do not all request; and — unlike both of them —
**remote code is answered YES**, because the site-tool catalog is fetched at
runtime. Do not copy their answer here.

### Single purpose description

> Web Agent is an AI assistant that operates the user's own browser on their
> behalf. From a side panel, the user asks for something in natural language;
> the extension sends that request to an OpenAI-compatible model endpoint the
> user configured with their own API key, and carries out the browser actions
> the model chooses — open a URL, read and extract page content, click, type,
> scroll, take screenshots, manage tabs — reporting the result back in the
> panel. Any action that would change something on a website requires an
> explicit confirmation from the user first. The extension has no model of its
> own and no backend service.

### Permission justifications

**sidePanel**

> The extension's entire user interface is a side panel: the conversation with
> the agent, the record of the tools it ran, the confirmation prompts for write
> actions, and the settings. There is no other window or page.

**debugger**

> This is the core automation engine. The extension uses the Chrome DevTools
> Protocol (chrome.debugger) to drive the tabs a task targets — navigating,
> reading the DOM and accessibility tree, dispatching clicks and keystrokes, and
> capturing screenshots. It attaches only to tabs involved in the task the user
> asked for, and detaches when that task ends.

**tabs**

> Used to open, query, switch and close tabs while carrying out a task (open a
> URL, list open tabs, close a tab it opened). Used only to perform the actions
> the user's request requires.

**tabGroups**

> When a task needs several tabs, the extension groups them under "Web Agent" so
> they stay separate from the user's own tabs and are easy to close afterwards.
> Used only for tabs the extension itself creates.

**scripting**

> Used to read and act on pages. The extension injects its own bundled scripts
> to read page structure (links, buttons, inputs, text) and perform the requested
> interactions (click, type, select, scroll). Injection happens only into tabs
> involved in the user's task.

**userScripts**

> Two features use Chrome's isolated USER_SCRIPT world. Site scripts are page
> rules the user approved — hide these elements, apply this CSS, run this small
> script — listed in the UI where they can be paused or deleted. Site tools
> installed from the catalog run there too, because they are not bundled with the
> extension and must not run with its privileges. Chrome gates this API behind a
> switch the user turns on themselves, so nothing runs until they do.

**offscreen**

> Some installed site tools are evaluated in a sandboxed offscreen document
> rather than in the extension's own context, so their source cannot reach
> extension APIs. The document is created only while such a tool is being
> prepared and closed afterwards.

**storage**

> Stores only the extension's own data locally: the user's model settings and API
> key, their conversations, the site tools they installed, the site scripts they
> approved, saved workflows and schedules, and the notes the agent keeps for
> continuity. None of it is transmitted to the developer — there is no server to
> transmit it to.

**cookies**

> The extension automates the user's own logged-in session. This permission lets
> the automation layer read the active tab's cookies so requests it makes on the
> user's behalf stay inside that existing session. Cookies are never collected or
> sent to the developer or any third party.

**downloads**

> Automated navigation can trigger a file download. This permission lets the
> extension manage download behaviour during a task so a prompt does not stall
> it. The extension does not initiate downloads on its own.

**alarms**

> Used for scheduled tasks: a user can save a request to run later or on a
> repeating schedule, and an alarm wakes the extension at that time. Also used to
> keep a long-running task alive across service-worker restarts.

**notifications**

> When a task the user scheduled finishes while they are not watching the panel,
> the extension posts a notification so they know the result is ready. Only the
> user's own tasks produce notifications.

**Host permission (`<all_urls>`)**

> The user decides which website the agent should work with, so the target can be
> any site. Broad host access is required to open, read and interact with
> whatever page the user directs it to, and to apply the page rules they
> approved. The extension touches a site only when the user's request involves
> it; it does not run in the background across sites.

### Remote code — **YES**

> The extension can fetch site-tool modules at runtime from a public GitHub
> repository (`whitefoxx/web-agent-marketplace`) when the user chooses to install
> one, so that the catalog can be corrected without shipping an extension update.
> Each module's SHA-256 is published in the catalog index and verified against the
> downloaded bytes before the module is registered — a mismatch is refused. Users
> can use the extension fully without installing any of them.
>
> Note the difference from this project's other two extensions, which answer NO:
> they do not ship the catalog at all. Do not copy their answer onto this form.
>
> JavaScript the agent writes and runs in a page comes from the model the user
> configured, at the user's request, and is subject to the same confirmation
> rules — the user instructing their own browser, not code fetched from a server.

### Data usage

Tick **Website content**, **Authentication information** and **Personal
communications** only if a reviewer insists on the last two — the defensible
answer is **Website content** alone, plus **User activity** is NOT applicable.
Read this before ticking anything:

- **Website content** — yes. The extension reads page text, structure and
  screenshots and sends them to the model endpoint the user configured, because
  that is the only way an agent can act on a page. Disclose this plainly.
- The extension does not collect credentials. It reuses an existing session and
  never reads or stores passwords. The user's API key is a setting, stored
  locally, and is sent only to the endpoint the user chose.
- It does not log user activity, track browsing, or build a profile. It performs
  actions; it does not record the user's.

All three certifications apply: no selling or transferring user data, no use
unrelated to the single purpose, no creditworthiness or lending use.

### Privacy policy URL

Required for this permission set. It must state, at minimum: page content the
agent reads is sent to the model provider the user configured and to nobody
else; the extension transmits nothing to the developer; conversations, settings,
the API key, installed site tools and site scripts are stored locally in the
browser.

## Assets

`images/` (generated — see `render.mjs`, rasterize with `raster.mjs`):

| File                          | Use                                                              |
| ----------------------------- | ---------------------------------------------------------------- |
| `screenshot-1-hero.jpg`       | 1280×800 — what it is, in one line                               |
| `screenshot-2-how.jpg`        | 1280×800 — you ask → it plans → it drives your Chrome → it answers |
| `screenshot-3-tools.jpg`      | 1280×800 — the toolbelt                                          |
| `screenshot-4-learn.jpg`      | 1280×800 — reaching a site nobody wrote support for              |
| `screenshot-5-start.jpg`      | 1280×800 — bring your own key, three steps                       |
| `promo-small-440x280.jpg`     | small promo tile                                                 |
| `promo-marquee-1400x560.jpg`  | marquee tile                                                     |

**Look at every image before uploading.** A sibling shell once shipped a tile
with a chip flush against a brace. And re-read the no-site-names rule above:
the images are metadata too.
