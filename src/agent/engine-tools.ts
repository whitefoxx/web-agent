/**
 * The model-facing tool catalog for the API engine — the JSON-schema definitions
 * for every "pseudo-tool" the engine INTERCEPTS (handles itself instead of
 * dispatching), the concurrency caps that bound parallel fan-out, the set of
 * perception primitives offered only in explore mode, and the two system-prompt
 * fragments (specialist capabilities + the explore-mode playbook).
 *
 * Pure data + string-builders, split out of api-engine.ts so the loop file isn't
 * dominated by ~400 lines of tool descriptions.
 */

import { getActiveExploreSession } from '../explore/session';
import type { AwaitResumeHint } from '../messages';

/** Cap images fed to the model per turn (vision tokens are expensive, and a
 * turn with several image-returning tools could otherwise balloon). */
export const MAX_VISION_IMAGES_PER_TURN = 8;

/** Max subagents to run CONCURRENTLY when the model fans out multiple
 * spawn_subagent calls in one turn (parallel-execution v1). Bounds API rate /
 * token blast; excess calls queue and run as slots free. */
export const SUBAGENT_PARALLEL_CAP = 5;

/** Max subagents to FAN OUT in a single turn (parallel-execution v2). Beyond
 * this we run the first N and tell the model to re-issue the rest next turn —
 * bounds the per-turn blast so one turn can't spawn dozens. */
export const SUBAGENT_FANOUT_MAX = 8;

/** Max plain READ adapter calls to run CONCURRENTLY when the model emits several
 * in one turn (parallel-execution v3 step 2). tool_calls in one assistant
 * message are independent by construction, so overlapping is safe; the
 * dispatcher's per-site tab pool bounds same-site browser concurrency. Writes /
 * intercepted tools stay on the sequential path. */
export const MAINLOOP_READ_PARALLEL_CAP = 5;

/** Model-driven vision: a pseudo-tool offered only to vision-capable profiles.
 * Tool results keep image URLs in their TEXT (as data); when the model decides
 * the task needs it to actually SEE an image, it calls this with the relevant
 * URLs. The engine intercepts the call (it doesn't go through the dispatcher),
 * validates the URLs, and injects them as a vision user message. This is the
 * "the LLM decides which images + intent" step, expressed as native function
 * calling instead of an intent-blind auto-scan. */
export const VIEW_IMAGE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'view_image',
    description:
      'Look at the actual content of one or more images (visual understanding). Call this **only when you need to analyze/understand the image content**: e.g. the user asks you to "look at what this picture is", or you need to answer based on what an image shows. Image addresses take three forms: ① a full http(s) URL; ② an image reference **[img_N]** appearing in tool-result text (screenshots and other base64 images show up in results this way — pass an id like `img_3` verbatim as an array element; **do not** hand-build a data: URL, and never pass the [image omitted] placeholder); ③ data:image/... base64. Note: if an image address is just data you need to pass along (e.g. the user asks you to post an image link into a comment, or save a link), **do not** call this tool — just use the URL as text. Do not guess an image\'s content from its URL; call this only when you genuinely need to see the image.',
    parameters: {
      type: 'object',
      properties: {
        images: {
          type: 'array',
          items: { type: 'string' },
          description:
            'List of images to view: http/https URLs, or an image reference id from a tool result (e.g. "img_3"), or data:image base64',
        },
        purpose: { type: 'string', description: 'Optional: why you want to see these images (for the record)' },
      },
      required: ['images'],
    },
  },
};

/** Image generation: offered when an `image` slot is configured. The engine
 * intercepts the call and routes it to that slot's model's /images/generations. */
export const GENERATE_IMAGE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'generate_image',
    description:
      'Generate an image from a text description. Call this when the user asks you to "draw / generate an image"; it returns the URL of the generated image. Once you have the result, show it to the user directly using markdown image syntax ![](imageURL) (it renders inline as an image) — do not just paste a plain-text link. **Do not** use view_image to look at an image you just generated yourself — that is a redundant extra request, unless the user explicitly asks you to inspect/analyze the image content.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Text description of the image content (be as specific as possible)' },
        size: { type: 'string', description: 'Optional: size, e.g. 1024x1024' },
      },
      required: ['prompt'],
    },
  },
};

/** Living todo/plan tool (Phase 1) — the model maintains a checklist for
 * multi-step tasks (TodoWrite semantics: pass the FULL step list each call).
 * Intercepted by the engine, never dispatched. */
export const UPDATE_PLAN_TOOL = {
  type: 'function' as const,
  function: {
    name: 'update_plan',
    description:
      'Maintain the current task\'s todo checklist. Strongly recommended for tasks of 3+ steps: list the steps first, then update as you progress. Rules: pass the [full] step list each call (not a delta); mark a step in_progress before starting it, and completed the moment it is done; mark deliberately-skipped steps skipped and failed attempts failed (write a one-line reason in activeForm for the latter two). At most one in_progress at any time, and be truthful — never mark an undone step completed. This keeps you from drifting on long tasks.',
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: 'The full step list, in execution order',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Short description of the step' },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed', 'skipped', 'failed'],
                description:
                  'Step status: pending not started / in_progress ongoing / completed done / skipped deliberately skipped / failed attempt failed',
              },
              activeForm: {
                type: 'string',
                description: 'Optional: present-continuous description (e.g. "Fetching the home page"), or a short reason when skipped/failed',
              },
            },
            required: ['title', 'status'],
          },
        },
      },
      required: ['steps'],
    },
  },
};

/** submit_plan (Phase 2 plan mode) — the model proposes a stepwise plan for the
 * user to approve before leaving the read-only planning phase. Intercepted. */
export const SUBMIT_PLAN_TOOL = {
  type: 'function' as const,
  function: {
    name: 'submit_plan',
    description:
      'Submit a stepwise execution plan (plan mode). goal is a one-sentence objective; steps are ordered steps (one sentence each, specific and actionable, with write operations listed explicitly as steps). After submitting, the plan is shown to the user to confirm/modify, and execution only begins once they confirm.',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'One-sentence objective' },
        steps: {
          type: 'array',
          description: 'The ordered step list',
          items: { type: 'string' },
        },
      },
      required: ['goal', 'steps'],
    },
  },
};

/** spawn_subagent (Phase 4) — delegate a bounded subtask to an isolated-context
 * sub-agent and get back only its text digest, so bulky intermediate data never
 * enters the main conversation. Read-only, no nesting. MULTIPLE spawn_subagent
 * calls in one turn run in PARALLEL (parallel-execution v1). Intercepted. */
export const SUBAGENT_TOOL = {
  type: 'function' as const,
  function: {
    name: 'spawn_subagent',
    description:
      'Hand a [bounded subtask] (e.g. "fetch and compare these 20 notes") to an isolated-context sub-agent and get back only its text conclusion. Good for subtasks that produce a lot of intermediate data — this keeps the main conversation from being blown up by raw data. The sub-agent is read-only and cannot spawn further sub-agents. [Parallel] For steps in your plan that are independent of each other, issue multiple spawn_subagent calls in one turn and they run in parallel (up to 5 at once); only split steps across turns when they have ordering dependencies.',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'The specific subtask for the sub-agent (must be self-contained — it cannot see the main conversation history)',
        },
        allowed_tools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional: restrict the sub-agent to only these tools (full names, e.g. xiaohongshu__feed)',
        },
      },
      required: ['task'],
    },
  },
};

/** await_user_action (③ human handoff-resume) — proactively pause and ask the
 * user to do a step in the browser only a human can (login / captcha / a
 * judgment call), then resume. Reuses the H9 takeover UI + pause/resume.
 * Intercepted in api-engine (needs the session ctx). */
export const AWAIT_USER_ACTION_TOOL = {
  type: 'function' as const,
  function: {
    name: 'await_user_action',
    description:
      'Ask the user to personally perform a step in the browser that you cannot / should not do for them, then continue (human handoff-resume). Use for: ① login walls / captchas / 2FA (you cannot log in or pass a captcha for the user); ② a step that needs the user\'s judgment or authorization (pick a shipping address, confirm a sensitive item); ③ a stuck point only a real person can move past. When called, the system brings that tab to the foreground, pops a prompt telling the user what you need, and **pauses** until they finish and click "I\'m done" to continue (or click "Skip"). **Do not use it for things you can do yourself**; objective must be specific and user-facing. This beats "pretending it is done" or "giving up" — hand control back to the user, then resume.',
    parameters: {
      type: 'object',
      properties: {
        objective: {
          type: 'string',
          description:
            'What the user should do (specific, user-facing, e.g. "Please log in to your 小红书 account on the open page" / "Please complete the slider captcha on the page")',
        },
        tab_id: {
          type: 'number',
          description: 'The tab to bring to the foreground for the user to act on (usually the stuck one, from open_url); omit to not switch',
        },
        wait_for_selector: {
          type: 'string',
          description:
            'Optional: a CSS selector; the system polls that tab and, when it appears, automatically decides the user is done and resumes without them clicking "I\'m done" (the user can still click/skip manually). Use for elements that only appear after a successful login/verification (e.g. a logged-in avatar, a feed container, a checkout button). Requires tab_id.',
        },
        wait_until: {
          type: 'string',
          enum: ['appear', 'disappear'],
          description:
            'Direction of the wait_for_selector check: appear=done when it appears (default, e.g. the avatar shows after login); disappear=done when it disappears (e.g. a login dialog / captcha box goes away).',
        },
      },
      required: ['objective'],
    },
  },
};

/** Parse `await_user_action` args once, so the TWO api-engine tool loops (the
 * pre-pass and the main loop) stay in lockstep — the original ③ bug was exactly
 * a divergence between them. Returns the objective, the tab to focus, and an
 * optional ③b auto-resume hint. */
export function parseAwaitUserAction(args: Record<string, unknown>): {
  objective: string;
  tabId?: number;
  resume?: AwaitResumeHint;
} {
  const objective = typeof args.objective === 'string' ? args.objective.trim() : '';
  const tabId = typeof args.tab_id === 'number' ? args.tab_id : undefined;
  const selector = typeof args.wait_for_selector === 'string' ? args.wait_for_selector.trim() : '';
  const until: AwaitResumeHint['until'] = args.wait_until === 'disappear' ? 'disappear' : 'appear';
  // Auto-resume needs a tab to poll; drop the hint if the agent gave no tab_id.
  const resume =
    selector && typeof tabId === 'number'
      ? ({ selector, until } satisfies AwaitResumeHint)
      : undefined;
  return { objective, ...(tabId !== undefined ? { tabId } : {}), ...(resume ? { resume } : {}) };
}

/** note_adapter_experience (⑩ per-adapter experience notes) — record a note keyed
 * by an adapter's site/name (site revamp / anti-bot / a strategy that stopped
 * working), surfaced back when that adapter next fails. Only on a SURPRISE, not
 * normal runs. Intercepted; writes to the adapter-health store. */
export const NOTE_ADAPTER_TOOL = {
  type: 'function' as const,
  function: {
    name: 'note_adapter_experience',
    description:
      'Record an "experience note" for a specific **site adapter** (stored keyed by its site/name), **only when something unexpected happens**: a site revamp broke it, anti-scraping got tougher, a strategy stopped working, or you found the key to getting it working again. Next time that adapter fails, these notes are surfaced automatically to help you/the user debug. **Do not record normal-run details** (which keywords you used, how many rows came back — none of that). Pass the adapter\'s full tool name in tool (e.g. zhihu__search), and a one-sentence conclusion in note.',
    parameters: {
      type: 'object',
      properties: {
        tool: {
          type: 'string',
          description: 'The full tool name of the site adapter (e.g. zhihu__search / xiaohongshu__feed)',
        },
        note: {
          type: 'string',
          description: 'A one-sentence lesson (e.g. "2026-07 the site moved the endpoint to /api/v2, old path 404s")',
        },
      },
      required: ['tool', 'note'],
    },
  },
};

/** update_memory (long-term memory) — the user's memory is ONE markdown document
 * (its current text is injected into your context as "About the user (long-term
 * memory)"). This tool replaces that whole document. Intercepted; the new text is
 * recalled on future runs. */
export const UPDATE_MEMORY_TOOL = {
  type: 'function' as const,
  function: {
    name: 'update_memory',
    description:
      'Update the user\'s [long-term memory] (a markdown document kept across sessions and injected into your context at the start of every conversation). Call this when the user asks you to "remember / update / forget" a long-term fact or preference about themselves. The memory is [a single document, not a list of items] — so pass the [full integrated new version]: starting from the existing memory you have already seen (see "About the user (long-term memory)" in the system prompt), fold in the new information, keep still-valid old content, drop what is outdated/overturned, and deduplicate for concision. Only record what is genuinely useful long-term; do not record one-off task details.',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The [full] updated memory document (markdown); it overwrites the old memory entirely',
        },
      },
      required: ['content'],
    },
  },
};

/** use_skill (progressive disclosure) — the available skills' name+description
 * are advertised in the system prompt; this tool loads ONE skill's full body on
 * demand. Intercepted: returns the skill markdown (embedded ⟦tool:..⟧ references
 * left as guidance). */
export const USE_SKILL_TOOL = {
  type: 'function' as const,
  function: {
    name: 'use_skill',
    description:
      'Load and follow the full instructions of a [skill] (the "Available skills" section in the system prompt lists each skill\'s name + purpose). When a skill is relevant to the current task, call this and treat the skill body as an operating guide to follow — the body may spell out which tools/adapters/workflows to call and in what order. Load one at a time; use the skill name given in "Available skills" for name.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Name of the skill to load' } },
      required: ['name'],
    },
  },
};

/** create_skill — author/overwrite a single-file markdown skill (Claude-Code
 * style). Intercepted; upsert by name. The body may embed ⟦tool:toolId⟧ to point
 * at specific generic tools / adapters / workflows. */
export const CREATE_SKILL_TOOL = {
  type: 'function' as const,
  function: {
    name: 'create_skill',
    description:
      'Create / update a [skill] — a reusable single-file markdown operating guide (like a Claude Code skill). When to use: the user wants to lock in "how to handle a certain kind of task" so you can auto-load it on demand later (see use_skill). Difference from a [workflow]: a workflow is a prompt recipe inserted into the input box and triggered by the user; a skill is an instruction sheet that you (the agent) [proactively] load and follow when you judge it relevant from its description. The body may embed ⟦tool:toolId⟧ to specify which generic tool / site adapter / workflow to use. Calling again with the same name = overwrite update.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name (short, recognizable; same name overwrites)' },
        description: {
          type: 'string',
          description: 'A one-sentence description of when to use this skill and what it does (shown to you to decide whether to load it)',
        },
        body: { type: 'string', description: 'The skill body (markdown); may embed ⟦tool:toolId⟧ to reference tools/adapters/workflows' },
      },
      required: ['name', 'description', 'body'],
    },
  },
};

/** notes (notebook) — user-curated markdown notes. Intercepted; UNLIKE remember,
 * notes are NEVER injected into context — strictly read/written on the user's
 * explicit ask. */
export const NOTES_TOOL = {
  type: 'function' as const,
  function: {
    name: 'notes',
    description:
      'Read/write the user\'s [notebook] (markdown notes). Unlike long-term memory (remember): notes are **not** injected into context, and you should only call this [when the user explicitly asks] to record/search/read/edit/delete a note — do not write notes on your own initiative. action: create (new; needs content, optional title) / list (list titles) / search (find by keyword; needs query) / get (read full text; needs id) / update (edit; needs id plus title/content) / delete (needs id).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'create | list | search | get | update | delete' },
        title: { type: 'string', description: 'Note title (optional for create/update; taken from the first body line when omitted)' },
        content: { type: 'string', description: 'Note body, markdown (required for create; optional for update)' },
        id: { type: 'string', description: 'Note id, from list/search (required for get/update/delete)' },
        query: { type: 'string', description: 'Search keyword (required for search)' },
      },
      required: ['action'],
    },
  },
};

/** synthesize_adapter (Explore v2) — the agent, after making ONE operation work
 * on the site and confirming where its data comes from, asks the system to turn
 * the trace-so-far into a deterministic, zero-LLM adapter. Intercepted: the SW
 * synthesizes from the trace slice, surfaces it on the Explore-results card
 * (streaming status), session-registers + smoke-tests it, and returns the outcome
 * so the agent can repair-and-retry or move to the next operation. Explore mode only. */
export const SYNTHESIZE_ADAPTER_TOOL = {
  type: 'function' as const,
  function: {
    name: 'synthesize_adapter',
    description:
      '[Explore mode only] Synthesize [one operation you just fully got working] on the page into a deterministic, zero-LLM adapter (tool). When to call: after you have used find_structured_data / find_in_network / read_network / get_html to confirm which endpoint / embedded data or which selectors the operation\'s data comes from, and have gotten it working by hand. The system auto-synthesizes the source from this, shows it on the "Explore results" card, and auto-runs it; the run result is returned to you — if it passes you can go on to explore the next related operation (a passing tool can be reused directly, no need to redo it); if it fails, fix per the error and [call this tool again with the same name] to produce a revised version. Use a short lowercase+underscore name for the operation (e.g. hot / note_comments / search).',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'The command name of this operation (lowercase+underscore, e.g. note_comments); reuse the same name for revisions',
        },
        notes: {
          type: 'string',
          description:
            'Optional: key hints for the synthesizer, e.g. "data comes from GET /api/v3/feed", "the list-item selector is .note-item", "needs to scroll to load first"',
        },
      },
      required: ['name'],
    },
  },
};

/** enter_explore_mode — offered OUTSIDE explore mode: the agent's escape hatch
 * when the user's ask clearly needs exploration (modify / re-synthesize / heal
 * a site adapter, or probe a site's data source) but the run didn't start in
 * /explore. Intercepted → the driver pops a confirm card (auto mode skips it),
 * starts/resumes the explore session mid-run, and flips the run to explore —
 * instead of the agent apologizing "synthesize_adapter is only available in
 * explore mode". See docs/llm-explore.md. */
export const ENTER_EXPLORE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'enter_explore_mode',
    description:
      'Request to switch the current session into [Explore mode] (the system pops a confirm dialog for the user\'s consent; once approved it starts recording page actions + network traffic and unlocks explore tools like synthesize_adapter / list_network / eval_js). When to call: the user wants to modify/regenerate/repair a site adapter, or explore a site\'s data source or build a new tool for a site, and you are not currently in explore mode — [do not] answer "can\'t do it" or make the user type /explore themselves; call this tool directly to request the switch.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description:
            'A one-sentence, user-facing note: why explore mode is needed (shown in the confirm dialog, e.g. "re-synthesize the deepseek conversation-search adapter")',
        },
      },
      required: ['reason'],
    },
  },
};

/** note_finding (Explore v2) — record ONE reusable fact about the site (an
 * endpoint, selector, step, login state, …), persisted to site memory so a
 * later explore of the same site builds on it instead of re-deriving. Worth
 * recording even when the current adapter didn't fully work yet. Intercepted;
 * explore mode only. */
export const NOTE_FINDING_TOOL = {
  type: 'function' as const,
  function: {
    name: 'note_finding',
    description:
      '[Explore mode only] Record one [reusable finding] about this site — worth recording even if the current operation is not fully working yet. It is persisted and automatically provided to you next time you explore this site, saving you from redoing it. Good things to record: what data an endpoint returns, a list/button selector, that you must scroll/log in first, that a step is working, etc. One at a time, short and specific.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description:
            'One short, specific finding (e.g. "hot-list data comes from GET /api/v3/feed/hot, returns JSON", "expand-comments button selector .CommentList .Button--expand")',
        },
        kind: {
          type: 'string',
          enum: ['endpoint', 'selector', 'step', 'fact', 'login', 'adapter'],
          description:
            'Type: endpoint / selector / step / fact (general fact) / login (logged-in session) / adapter (already a tool)',
        },
      },
      required: ['text'],
    },
  },
};

export const LOAD_ADAPTER_TOOL = {
  type: 'function' as const,
  function: {
    name: 'load_adapter',
    description:
      '[Load] a marketplace adapter into this session (loaded on demand, not persisted; gone when the SW restarts); afterward you can call <site>__<name> directly, and it returns its parameter schema. Use find_adapters to find a candidate, then load it with this (**adapters need no installation**; for the next task just find_adapters + load_adapter once again — it costs no standing tokens). Loading itself needs no user confirmation (the source is sha256-verified and evaluated in a sandbox); if the adapter is a write operation (post/comment etc.), the user is only asked to confirm at execution time.',
    parameters: {
      type: 'object',
      properties: {
        site: { type: 'string', description: 'The adapter\'s site (returned by find_adapters)' },
        name: { type: 'string', description: 'The adapter\'s name (returned by find_adapters)' },
      },
      required: ['site', 'name'],
    },
  },
};

/** create_workflow (workflow) — save a reusable PROMPT RECIPE: natural-language
 * instructions describing a whole multi-step flow (which tools/adapters to call,
 * what in / what out, how to post-process). Unlike a rigid pipeline it gives the
 * LLM full latitude at run time and the user edits it as plain text. Stored in
 * the shortcut store (kind 'prompt'); intercepted in api-engine; non-explore. */
export const CREATE_WORKFLOW_TOOL = {
  type: 'function' as const,
  function: {
    name: 'create_workflow',
    description:
      'Save a [reusable flow] as a [workflow] (the user views / edits / runs / references it on the "Workflows" page, or invokes it with / in the input box). A workflow is a [prompt recipe]: describe the whole flow in natural language — what to do in order, which tools/adapters to call, what goes in, what comes out, how to process and organize the result. At run time you (the LLM) execute this text with full latitude — more flexible than a rigid fixed pipeline, and the user edits the flow just by editing this text. When to use: the user says "save this set of operations / this flow as a workflow / record it as a common flow", or asks you to modify an existing workflow. **To pin a specific tool/adapter in the recipe, embed a ⟦tool:toolId⟧ token** (both generic tools and site adapters work, e.g. ⟦tool:generic__get_page_text⟧, ⟦tool:hackernews__top⟧); if you\'re unsure of the exact id, describe it in natural language and pick the tool at run time. **Calling again with the same label = overwrite update to that workflow** (for edits).',
    parameters: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Workflow name (short; for display + the user to find it via /)' },
        text: {
          type: 'string',
          description:
            'The workflow\'s prompt recipe: describe the whole flow in natural language (steps, which tools/adapters to call, inputs/outputs, how to organize the result); may embed ⟦tool:toolId⟧ tokens to pin specific tools',
        },
      },
      required: ['label', 'text'],
    },
  },
};

/** create_site_script (persistent site script / ad-blocking) — register a
 * PERSISTENT per-site rule that hides elements on every visit. MVP = cosmetic hide
 * only (safe, reversible, visible under the side panel's "Site scripts").
 * Intercepted; explore mode excluded. */
export const CREATE_SITE_SCRIPT_TOOL = {
  type: 'function' as const,
  function: {
    name: 'create_site_script',
    description:
      'Create a [persistent script] for a site that takes effect automatically on every visit — **hide elements** (ad/noise removal), **inject CSS** (restyle / dark mode / reflow), or **inject JS** (handle dynamic / lazy-loaded ads, e.g. MutationObserver). When to use: the user says "block ads on site X / hide Y / dark mode / remove the recommendations panel / auto-translate on every open…". First, on the page, use get_html / get_interactives to find **robust selectors** (prefer role/aria/semantic/data-*/text; avoid random hash classes; use preview_site_script to see the effect first). matches must point at a **specific site** (e.g. https://*.zhihu.com/*); site-wide wildcards are not allowed. Calling again with the same label = overwrite update. Rules can be viewed/disabled/deleted under the side panel\'s "Site scripts"; cosmetic (does not block network requests). Requires chrome\'s "Allow user scripts" toggle. **Note: rules with css or js pop a confirm to the user first; hide_selectors-only rules do not. Don\'t use js for what you can do with hide_selectors.** **With js: dry-run to verify before committing (important, don\'t blind-test).** After opening the target page, use `preview_site_script` with `js` to **run the script once in the same world** and see its console/errors/return value — during development have the js `return` key quantities (each selector\'s hit count, `location.pathname/href/search`, the boolean of each if-guard) so you can pinpoint "which guard/selector is wrong" in one shot. **Don\'t blind-test via "create_site_script → refresh → wait for selector → screenshot"** (slow, and you can\'t see the script\'s internal return/errors). **Don\'t write a silent `if(!x) return`** — during development first `return` the actual value of x to verify; for anything decided by URL, first confirm `location.pathname` (e.g. the item page is `/item`) rather than `location.search` (`?id=...`, which has no path). Verify DOM logic/selectors/guards with a dry-run before create_site_script (the dry-run has no __webLLM; think through the LLM step separately). If the script needs to call AI on the page (e.g. paragraph-by-paragraph translation/summary/rewrite), set llm_access to true: the js can then use `__webLLM.call(prompt, {system, json}) → Promise<string>` (rate-limited 30/5min, 300/day, prompt ≤6000 chars; merge multiple text chunks into one call, don\'t call per-chunk). **For structured output you MUST pass {json:true}** — the bridge strips code blocks / extra text and validates on the server side, and the return value is directly JSON.parse-able; don\'t write your own JSON tolerance in the page.',
    parameters: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Rule name, e.g. "知乎 ad-blocking" (same label overwrites)' },
        matches: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Match patterns pointing at a specific site, e.g. ["https://*.zhihu.com/*"]; <all_urls> / wildcard hosts are forbidden',
        },
        hide_selectors: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of CSS selectors for elements to hide (persistently hidden via display:none). Preferred and safest',
        },
        css: {
          type: 'string',
          description:
            'Optional: raw CSS to inject (restyle / dark mode / reflow, e.g. `html{filter:invert(1)}`). Pops a confirm',
        },
        js: {
          type: 'string',
          description:
            'Optional: raw JS to inject (handle dynamic ads, e.g. a MutationObserver that keeps removing them; or, with llm_access, do in-page AI). High-risk, pops a confirm; if hide_selectors/css can do it, don\'t use this',
        },
        llm_access: {
          type: 'boolean',
          description:
            'Optional: allow this script\'s js to call the extension\'s LLM (injects the __webLLM.call API). Set true only when the script genuinely needs in-page AI (translation/summary/rewrite); it is written into the confirm dialog',
        },
        run_at: {
          type: 'string',
          enum: ['document_start', 'document_end', 'document_idle'],
          description:
            'Optional injection timing. Defaults: pure css/hide → document_start (avoids flicker); with js → document_idle (DOM ready). If the js needs to **read the DOM immediately** (querySelector etc.), don\'t use document_start — the body isn\'t parsed yet, so you read nothing; to intervene earlier use a MutationObserver + document_start',
        },
      },
      required: ['matches'],
    },
  },
};

export const LIST_SITE_SCRIPTS_TOOL = {
  type: 'function' as const,
  function: {
    name: 'list_site_scripts',
    description:
      'List the persistent site scripts already created (ad-blocking / enhancement rules): id, name, matched sites, number of hidden selectors, and whether enabled.',
    parameters: { type: 'object', properties: {} },
  },
};

export const DELETE_SITE_SCRIPT_TOOL = {
  type: 'function' as const,
  function: {
    name: 'delete_site_script',
    description: 'Delete a persistent site script (by id; use list_site_scripts to get the id first) and unregister its persistent injection.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The id of the site script to delete' } },
      required: ['id'],
    },
  },
};

/** preview_site_script (v1.1 WYSIWYG + v1.2 JS dry-run) — temporarily inject a
 * rule's hide/CSS into an open tab (non-persistent) for the user to eyeball, AND
 * run a candidate `js` once (same USER_SCRIPT world) returning its console /
 * error / return value so the agent debugs the JS logic BEFORE committing.
 * Intercepted; non-explore. */
export const PREVIEW_SITE_SCRIPT_TOOL = {
  type: 'function' as const,
  function: {
    name: 'preview_site_script',
    description:
      '**Temporarily run** a site script on a tab of an [already-open target site] (non-persistent; gone on refresh), to verify it before committing with create_site_script. Three uses (combinable): ① `hide_selectors`/`css` — actually hide, to preview the ad-block effect, returning the number of matched elements (0 = no match); ② `highlight:true` — outline matched elements in red (without hiding), to confirm the selection scope first; ③ **`js` — run your script JS once in the [same USER_SCRIPT world]**, returning its **console output + thrown errors (with line numbers) + top-level return value** — this is **the right way to debug injected JS**: stop blind-testing via "create_site_script → refresh → wait for selector → screenshot" (slow, and you can\'t see inside the script). **During development, strongly prefer having the dry-run\'s js `return` key quantities** (e.g. each selector\'s hit count, `location.pathname/href/search`, the boolean of each if-guard) so you can see which guard/selector is wrong in one shot. Note: the dry-run has **no `__webLLM`** (verify the DOM logic/selectors/URL guards first; think through the LLM-call step separately); requires chrome\'s "Allow user scripts" toggle.',
    parameters: {
      type: 'object',
      properties: {
        tab_id: { type: 'number', description: 'The tab id of the already-open target site' },
        hide_selectors: {
          type: 'array',
          items: { type: 'string' },
          description: 'CSS selectors to preview hiding/highlighting',
        },
        css: { type: 'string', description: 'Optional: raw CSS to preview (ignored in highlight mode)' },
        highlight: {
          type: 'boolean',
          description: 'true = outline matched elements in red (without hiding), to confirm the selection scope; default false = actually hide',
        },
        js: {
          type: 'string',
          description:
            'Optional: the script JS to dry-run (runs once in the USER_SCRIPT world, returning its console/thrown-errors/return-value). During development, have it `return` selector hit counts, the real location values, each guard\'s boolean, etc. to localize the problem',
        },
      },
      required: ['tab_id'],
    },
  },
};

/** create_schedule (scheduled task / H3) — schedule a saved workflow (by name →
 * its prompt text is resolved at run time) OR an inline prompt to run headless on a
 * cadence (chrome.alarms). Every run is a full agent session; this is the
 * agent-facing surface. Intercepted in api-engine (needs SW-side saveSchedule +
 * chrome.alarms); non-explore. */
export const CREATE_SCHEDULE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'create_schedule',
    description:
      'Create / update a [scheduled task] — have something run automatically and unattended in the background at set times (the user views / runs manually / toggles / deletes it on the "Scheduled tasks" page; each run sends a notification and stores its result in the session history). Every run is a full agent session (can call any tool/adapter, reason, organize, and produce a summary). **Pick one of two things to run**: ① `shortcut_name` = the name of a [saved workflow] (i.e. a prompt recipe; must already exist; the scheduled run executes its current content, so editing the workflow later edits the task) — good for locking in a flow with create_workflow first, then scheduling; ② `prompt` = a directly-written task instruction (each run is like the user opening a new conversation and sending this line); the prompt can also embed ⟦tool:toolId⟧ to pin the tools/adapters to use. **Typical chaining**: first `create_workflow` to save "fetch X and summarize" as a workflow, then `create_schedule{shortcut_name}` to run it on a daily schedule. **Calling again with the same label = overwrite update**. ⚠️ Background runs are rejected when they hit a write operation (post/like etc.) while the panel is closed — design scheduled tasks to be read-only / reporting-oriented.',
    parameters: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Scheduled-task name (shown to the user; same label overwrites)' },
        cadence: {
          type: 'object',
          description:
            'Run frequency. kind determines the other fields: interval=every minutes minutes (needs minutes≥1); daily=every day at hour:minute (needs hour 0–23, minute defaults to 0); weekly=on certain days at hour:minute (needs a days array + hour); monthly=on day of each month at hour:minute (needs day 1–31 + hour, 31≈end of month); once=run once at a set time (needs at)',
          properties: {
            kind: {
              type: 'string',
              enum: ['interval', 'daily', 'weekly', 'monthly', 'once'],
              description: 'Frequency type',
            },
            minutes: { type: 'number', description: 'interval: interval in minutes (≥1)' },
            hour: { type: 'number', description: 'daily/weekly/monthly: hour (0–23)' },
            minute: { type: 'number', description: 'daily/weekly/monthly: minute (0–59, default 0)' },
            days: {
              type: 'array',
              items: { type: 'number' },
              description: 'weekly: days of week, 0=Sunday…6=Saturday, e.g. [1,3,5]',
            },
            day: { type: 'number', description: 'monthly: day of the month (1–31)' },
            at: {
              type: 'string',
              description: 'once: run time — ISO string (e.g. "2026-07-10T09:00") or epoch millis; must be in the future',
            },
          },
          required: ['kind'],
        },
        shortcut_name: {
          type: 'string',
          description: 'Name of the [saved workflow] to run on schedule (one of this or prompt; must already exist)',
        },
        prompt: {
          type: 'string',
          description:
            'The task instruction to run on schedule (one of this or shortcut_name); may embed ⟦tool:toolId⟧ to pin the tools/adapters to use',
        },
        note: { type: 'string', description: 'Optional: a note shown beneath the task' },
      },
      required: ['label', 'cadence'],
    },
  },
};

/** Perception primitives surfaced to the model ONLY in explore mode — the ones
 * that genuinely need the explore session (its CDP attachment / network capture
 * / trace). Tool names are `${site}__${name}`.
 *
 * Deliberately NOT here (promoted to normal mode, audit 2026-07-02): get_html /
 * query_dom / get_dom_outline / wait_for_selector — plain chrome.scripting
 * probes that work on any tab_id; adapter-less driving needs them too (they
 * self-require tab_id when no explore session is active). */
export const EXPLORE_ONLY_TOOLS = new Set([
  'generic__list_network',
  'generic__read_network',
  'generic__list_trace',
  'generic__eval_js',
  'generic__find_in_network',
  'generic__find_in_dom',
  'generic__find_structured_data',
  'generic__get_a11y_tree',
  'generic__capture_submission',
]);

/** Build the system-prompt note listing the specialist capabilities configured
 * in this setup, so the orchestrator knows what it can delegate — and can tell
 * the user when a needed capability isn't configured. */
export function specialistSystemNote(caps: {
  vision: boolean;
  /** Vision slot IS the primary (multimodal main) → screenshots auto-attach.
   * false with vision=true = SEPARATE vision model → screenshots surface as
   * [img_N] references that must go through view_image (§10.25). */
  visionInline?: boolean;
  image: boolean;
}): string {
  const lines: string[] = [];
  if (caps.vision)
    lines.push(
      '- Visual understanding (view_image): call when you need to analyze/understand image content, passing an http(s) image URL or an image reference [img_N] from a tool result. Call only when you genuinely need to see the image; if an image address is just data to pass along (e.g. a link in a comment), do not call it.',
    );
  if (caps.image) lines.push('- Image generation (generate_image): call when the user asks to draw/generate an image; it returns an image URL.');
  const header = '\n\n## Specialist capabilities (multi-model collaboration)';
  // Screenshot guidance hinges on vision: without a vision model the result
  // can't be interpreted, so steer to text extraction instead of wasting it.
  // With a SEPARATE vision model screenshots are NOT auto-shown — the [img_N]
  // reference through view_image is the only path (§10.25).
  const shotNote = !caps.vision
    ? '⚠️ No visual-understanding model is configured: **do not** use generic__screenshot to "see" the page (no model can interpret the image, so a screenshot is wasted). Use tools that read the page text/HTML (e.g. get_page_text) to get content; if the task genuinely must rely on seeing an image, stop first and prompt the user to configure a visual-understanding model under "Model roles", then continue.'
    : caps.visionInline
      ? 'The result of screenshot tools (generic__screenshot) is automatically presented as an image; no view_image needed.'
      : 'The result of screenshot tools (generic__screenshot) shows up in text as an image reference [img_N] — to "see" a screenshot, pass that id to view_image (e.g. images:["img_3"]); **do not** treat placeholders like [image omitted] or a hand-built data: URL as an image address.';
  if (lines.length === 0) {
    return `${header}\nNo specialist-capability model is currently configured (visual understanding / image generation etc.). If the task needs these, tell the user to assign a model for the relevant capability under "Settings → Model roles".\n${shotNote}`;
  }
  return (
    `${header}\nYou can call the following specialist capabilities (they are tools that route to specially-configured models):\n${lines.join('\n')}\n` +
    'Other capabilities (e.g. audio / video generation) are not currently configured — if the task needs them, tell the user to add the corresponding model under "Settings → Model roles".\n' +
    shotNote
  );
}

/** The explore-mode playbook injected into the system prompt — the data-source
 * stability ladder, virtual-list handling, "tune the extraction with eval_js
 * before synthesizing", and the truthful-wrap-up rules. Reads the active explore
 * session for the dedicated tab id. Only used when ctx.mode === 'explore'. */
export function exploreModeNote(): string {
  const tabId = getActiveExploreSession()?.tabId;
  const tab = tabId === undefined ? 'the Explore tab' : `the tab tabId=${tabId}`;
  return `\n\n## Explore mode — the only deliverable is "a working adapter"
You are "exploring" a site: perform the operation the user wants **by hand** on the real page (the system records the whole thing: actions + network + DOM), confirm where the data comes from, then call synthesize_adapter to turn it into a **deterministic, zero-LLM** tool. After that the tool can be reused directly, with no more exploring. It is like writing code: probe first, then produce, then verify, then fix.

- An initial **plan** has been created for you (see the plan card); update it with update_plan as you go (mark steps done, add new operations), and always drive around the plan.
- Operate only on ${tab}: open_url to navigate (it reuses that tab), and set tab_id to that tab for click / type_into / get_interactives etc.
- **Probe the data path first (search from most to least stable; stop once you find it)**: ① **find_structured_data** first scans the page's ready-made data sources (JSON-LD / framework-embedded state / feeds / **IndexedDB / localStorage**) — many SPAs (chat, editors, boards) cache the **full data in IndexedDB**, which is more complete and stable than the DOM (unaffected by virtual lists); if it hits, read it out with eval_js — the most stable and cheapest; ② **endpoints** — when you see a value on the page, use **find_in_network** to trace back which endpoint it came from, or list_network to find the endpoint returning the JSON business data (often with paging params), then **read_network** to see the full response body; ③ **DOM (fallback)** — **get_a11y_tree** for the semantic structure (role+name, class-independent, most stable) / **get_dom_outline** for the layout → **query_dom** to verify a selector is right; **when you see a concrete value (title/author/number), use find_in_dom to trace back its stable selector + whether it's inside a list row** (don't guess a class yourself); for content that only appears after lazy-loading/clicking, use **wait_for_selector** to wait for it.
  - **Virtual list / infinite scroll**: if the container carries \`data-virtual-list\` / \`role=feed\`, or the list items carry an incrementing key/index while the DOM holds only the small visible slice (the whole page renders just a few items), **don't grab only the currently-visible items** — prefer going back to ① and finding the IndexedDB/endpoint (usually holds the full data); when you can only go through the DOM, **collect while scrolling** (loop scroll_page → dedupe by a stable key and accumulate until no new items appear), and such multi-step collection is usually synthesized as a **func** adapter (do the scroll+collect loop inside page.evaluate).
  Actually **get this one operation working** (really search / paginate / expand) so the data really appears. (Only when the data lives solely in a canvas/video/image and can be gotten from neither DOM nor network should you fall back to screenshot + visual understanding; don't screenshot for routine scraping.)
- **Prefer stable data sources/selectors (very important — don't let the tool break the moment the site is revamped)**: if you can go through an endpoint (a JSON endpoint found via list_network/find_in_network) or page-embedded JSON (\`__NEXT_DATA__\`/\`<script type=json>\`, readable via eval_js as \`window.__NEXT_DATA__\`), **don't scrape the DOM** — those don't break with a style revamp. When you must scrape the DOM, **never use classes that look random/compiled** (e.g. \`.YzCcne\`, \`.tF2Cxc\`); use data-testid / aria / role / semantic tags / a stable href shape / text anchoring, etc. (verify the stable pick with query_dom / get_a11y_tree). Two more shortcuts: some platforms return JSON directly if you **append \`.json\` or \`?format=json\` to the same URL** (reddit / discourse / mediawiki / drupal — try a fetch inside eval_js); for **"latest N items"-type tasks**, prefer an RSS/Atom feed found via find_structured_data (most stable).
- **Before producing, tune the extraction code with eval_js (crucial!)**: eval_js and the synthesized adapter are the **same execution channel** — write and **get the complete extraction snippet working** inside it (returning the final array of objects, with all fields), iterating until the result is correct. The **\`__loc\`** robust-locator helper is already injected in the page (\`__loc.byRole/byText/units/first/field\`, equivalent to getByRole/getByText) — prefer it for the extraction over random classes. Then call **synthesize_adapter** (with a short command name), writing the **working extraction code verbatim into notes** — the synthesizer adopts it directly, usually right the first time. The system auto-synthesizes + runs it, and hands you back the **actual returned data**.
- **Check the result (crucial!)**: synthesize_adapter hands you the adapter's **actual run output** — you **must check it item by item against the user's task to confirm it really captured everything, correctly**. A "passing" run only means it runs and is non-empty; it **never means it is correct** (e.g. the task wants the AI-overview body + reference links, but the result has only ordinary search results → it's not done right). If content is missing / captured wrong, fix it (add selectors / change strategy) and **re-run synthesize_adapter with the same name** (like fixing a bug), until the result truly matches the task — only then is this operation complete.
- **Failure discipline (save roundtrips, don't spin in place)**: if a method **fails deterministically** (a clear error, a selector that definitely doesn't exist), **don't keep retrying with different params** — go back to the goal and switch to the **next method** down the stability ladder (endpoint → embedded JSON/IndexedDB → DOM); retry once only on a **transient** failure (timeout / not finished loading). Probing framework internal state (\`window.__vue_app__\` / React fiber) — **give up after one failure** and move to DOM/endpoint. **Every browser roundtrip should yield an information gain**: to check multiple candidate selectors, **test them all in one eval_js** (return each one's hit count + first-element summary + whether it's unique), don't try them one by one; if a response is large, first take count/total/one sample inside the page, don't pull the whole thing back.
- **Record the method for controls, not fixed values**: for a dropdown/radio/filter (sort, category, time range…), find out its **source of legal values** (endpoint > the page's \`<select>\`/radio DOM > a fixed enum) and write it into that parameter's help at synthesis time; if there's cascading (B only appears after picking A), record the dependency chain. Persist it with note_finding.
- **Work out the "control → endpoint param" mapping in one shot**: to figure out which input/dropdown maps to which endpoint param, don't change them one at a time — use get_interactives to list all controls, and in one eval_js fill each with a **unique value** (put \`1001\` in a keyword field, \`1002\` in the next…, pick a **non-default** dropdown option), trigger one search, then look at the request with **find_in_network / read_network**, and read off every "control → param name" at a glance from the unique values; on many sites the **URL or Referer query string already contains the full mapping**, so look there first — it's cheapest. Work out all params in one roundtrip.
- **Verify paging for list tasks**: when the capability is "fetch N list items" and it supports paging, after synthesis **verify paging actually works** (fetch page 2 and compare with page 1: different, has new data, terminates), don't call it done after only verifying page 1.
- **Self-check as a "cold reader" before delivery**: once synthesize passes, review it as **a tool someone else wrote** — look only at its args/description/run output and ask "without the exploration process, could I call this correctly from just these? Does the return cover every item the task requires?". Every "done / captured" conclusion **must** be backed by actual tool output or content you read yourself — **not by impression** (same principle as an honest wrap-up: keep evidence, don't rely on gut).
- **Write tasks (like/favorite/follow/post/delete etc.) — the goal is to synthesize an adapter that "can perform the write later", NOT to run the write now**. Two evidence-gathering routes; prefer whichever gets you the real request structure:
  - **A (recommended) capture_submission — do it for real, safely**: first \`capture_submission action:"arm"\`, then **actually** fill the form + click submit (click / type_into / press_key) — the write request (POST/PUT/DELETE / form submit / GraphQL mutation) is **intercepted, recorded, and neutralized (not sent to the server, zero side effect)**, while read requests pass through normally; when done, \`capture_submission action:"disarm"\` to retrieve the neutralized request structure (endpoint / method / body fields, with cookie/auth headers redacted). This synthesizes most accurately — the request was genuinely produced, not guessed.
  - **B (fallback) observe and infer**: when capture doesn't apply (e.g. the write doesn't go through XHR/Fetch/a form), use get_interactives / get_html to look at the trigger point (form action / method, where the CSRF token comes from) + read_network to see the shape of a similar write request the site has **already made**, and **infer** the endpoint shape from that to synthesize.
  - **Discipline**: unless \`capture_submission arm\` has interception on, **do not use eval_js to actually submit a write request (allow_write), and do not click the button that truly performs the write** — that is an un-neutralized real side effect. eval_js rejects write requests by default (deliberately). A synthesized write adapter's status is "untested" and it is not auto-run — that's correct; verification is left to the user calling it in the conversation, going through the write-confirm.
- **Persist findings**: record reusable information (what an endpoint returns, a selector, needs login, a step that's working) with **note_finding** — the next explore of this site picks it up automatically, saving a redo.
- You can do multiple related operations at once (one synthesize_adapter each); when the user wants other operations on the same site, **call and reuse the already-passing tools directly, don't re-explore**.
- **Honest wrap-up**: the summary you give the user **may only describe what the adapter actually returned** (per the run result). **Never** write up content you saw on the page but that isn't actually in the adapter's result as "extracted / done" — that's faking success. If you didn't capture it, say so honestly. **Extra for write tasks**: if any real write side effect occurred during exploration (even an accidental click / submission), you must tell the user **explicitly and honestly** in the wrap-up (e.g. "during exploration I actually starred X; if you want to undo it, please do so manually"); never soft-pedal it as an "explanation of the execution flow".
- **Stay on goal**: for requests unrelated to "producing a working adapter", explain politely and refocus on the goal. When stuck on a **login/captcha**, use **await_user_action** to ask the user to take over (it automatically brings that tab to the foreground + pauses, and you resume after they click "I'm done") — better than giving up or faking completion; if you lack information, stop and ask. Don't blind-test or fake completion.`;
}
