// ../browser-agent/opencli/clis/youtube/transcript.js
import { cli, Strategy } from "@jackwener/opencli/registry";

// ../browser-agent/opencli/clis/youtube/utils.js
function parseVideoId(input) {
  if (!input.startsWith("http"))
    return input;
  try {
    const parsed = new URL(input);
    if (parsed.searchParams.has("v")) {
      return parsed.searchParams.get("v");
    }
    if (parsed.hostname === "youtu.be") {
      return parsed.pathname.slice(1).split("/")[0];
    }
    const pathMatch = parsed.pathname.match(/^\/(shorts|embed|live|v)\/([^/?]+)/);
    if (pathMatch)
      return pathMatch[2];
  } catch {
  }
  return input;
}
function extractJsonAssignmentFromHtml(html, keys) {
  const candidates = Array.isArray(keys) ? keys : [keys];
  for (const key of candidates) {
    const markers = [
      `var ${key} = `,
      `window["${key}"] = `,
      `window.${key} = `,
      `${key} = `
    ];
    for (const marker of markers) {
      const markerIndex = html.indexOf(marker);
      if (markerIndex === -1)
        continue;
      const jsonStart = html.indexOf("{", markerIndex + marker.length);
      if (jsonStart === -1)
        continue;
      let depth = 0;
      let inString = false;
      let escaping = false;
      for (let i = jsonStart; i < html.length; i += 1) {
        const ch = html[i];
        if (inString) {
          if (escaping) {
            escaping = false;
          } else if (ch === "\\") {
            escaping = true;
          } else if (ch === '"') {
            inString = false;
          }
          continue;
        }
        if (ch === '"') {
          inString = true;
          continue;
        }
        if (ch === "{") {
          depth += 1;
          continue;
        }
        if (ch === "}") {
          depth -= 1;
          if (depth === 0) {
            try {
              return JSON.parse(html.slice(jsonStart, i + 1));
            } catch {
              break;
            }
          }
        }
      }
    }
  }
  return null;
}

// ../browser-agent/opencli/clis/youtube/transcript-group.js
var SENTENCE_END = /[.!?\u3002\uFF01\uFF1F\uFF0E]["'\u2019\u201D)]*\s*$/;
var QUESTION_END = /[?\uFF1F]["'\u2019\u201D)]*\s*$/;
var TRANSCRIPT_GROUP_GAP_SECONDS = 20;
var TURN_MERGE_MAX_WORDS = 80;
var TURN_MERGE_MAX_SPAN_SECONDS = 45;
var SHORT_UTTERANCE_MAX_WORDS = 3;
var FIRST_GROUP_MERGE_MIN_WORDS = 8;
function countWords(text) {
  return text.split(/\s+/).filter(Boolean).length;
}
function groupTranscriptSegments(segments) {
  if (segments.length === 0)
    return [];
  const hasSpeakerMarkers = segments.some((s) => /^>>/.test(s.text));
  return hasSpeakerMarkers ? groupBySpeaker(segments) : groupBySentence(segments);
}
function formatGroupedTranscript(segments, chapters = []) {
  const sortedChapters = [...chapters].sort((a, b) => a.start - b.start);
  let chapterIdx = 0;
  const rows = [];
  const textParts = [];
  for (const segment of segments) {
    while (chapterIdx < sortedChapters.length && sortedChapters[chapterIdx].start <= segment.start) {
      const title = sortedChapters[chapterIdx].title;
      rows.push({ timestamp: fmtTime(sortedChapters[chapterIdx].start), speaker: "", text: `[Chapter] ${title}` });
      if (textParts.length > 0)
        textParts.push("");
      textParts.push(`### ${title}`);
      textParts.push("");
      chapterIdx++;
    }
    const timestamp = fmtTime(segment.start);
    const speaker = segment.speaker !== void 0 ? `Speaker ${segment.speaker + 1}` : "";
    rows.push({ timestamp, speaker, text: segment.text });
    if (segment.speakerChange && textParts.length > 0) {
      textParts.push("");
    }
    textParts.push(`${timestamp} ${segment.text}`);
  }
  return { rows, plainText: textParts.join("\n") };
}
function fmtTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor(sec % 3600 / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}
var MAX_GROUP_SPAN_SECONDS = 30;
function groupBySentence(segments) {
  const groups = [];
  let buffer = "";
  let bufferStart = 0;
  let lastStart = 0;
  const flush = () => {
    if (buffer.trim()) {
      groups.push({ start: bufferStart, text: buffer.trim(), speakerChange: false });
      buffer = "";
    }
  };
  for (const seg of segments) {
    if (buffer && seg.start - lastStart > TRANSCRIPT_GROUP_GAP_SECONDS) {
      flush();
    }
    if (buffer && seg.start - bufferStart > MAX_GROUP_SPAN_SECONDS) {
      flush();
    }
    if (!buffer)
      bufferStart = seg.start;
    buffer += (buffer ? " " : "") + seg.text;
    lastStart = seg.start;
    if (SENTENCE_END.test(seg.text))
      flush();
  }
  flush();
  return groups;
}
function groupBySpeaker(segments) {
  const turns = [];
  let currentTurn = null;
  let speakerIndex = -1;
  let prevSegText = "";
  for (const seg of segments) {
    const isSpeakerChange = /^>>/.test(seg.text);
    const cleanText = seg.text.replace(/^>>\s*/, "").replace(/^-\s+/, "");
    const prevEndsWithComma = /,\s*$/.test(prevSegText);
    const prevEndedSentence = (SENTENCE_END.test(prevSegText) || !prevSegText) && !prevEndsWithComma;
    const isRealSpeakerChange = isSpeakerChange && prevEndedSentence;
    if (isRealSpeakerChange) {
      if (currentTurn)
        turns.push(currentTurn);
      speakerIndex = (speakerIndex + 1) % 2;
      currentTurn = {
        start: seg.start,
        segments: [{ start: seg.start, text: cleanText }],
        speakerChange: true,
        speaker: speakerIndex
      };
    } else {
      if (!currentTurn) {
        currentTurn = { start: seg.start, segments: [], speakerChange: false };
      }
      currentTurn.segments.push({ start: seg.start, text: cleanText });
    }
    prevSegText = cleanText;
  }
  if (currentTurn)
    turns.push(currentTurn);
  splitAffirmativeTurns(turns);
  const groups = [];
  for (const turn of turns) {
    const sentenceGroups = turn.speaker === void 0 ? groupBySentence(turn.segments) : mergeSentenceGroupsWithinTurn(groupBySentence(turn.segments));
    for (let i = 0; i < sentenceGroups.length; i++) {
      groups.push({
        ...sentenceGroups[i],
        speakerChange: i === 0 && turn.speakerChange,
        speaker: turn.speaker
      });
    }
  }
  return groups;
}
function splitAffirmativeTurns(turns) {
  const affirmativePattern = /^(mhm|yeah|yes|yep|right|okay|ok|absolutely|sure|exactly|uh-huh|mm-hmm)[.!,]?\s+/i;
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (turn.speaker === void 0 || turn.segments.length === 0)
      continue;
    const firstSeg = turn.segments[0];
    const match = affirmativePattern.exec(firstSeg.text);
    if (!match)
      continue;
    if (/,\s*$/.test(match[0]))
      continue;
    const remainder = firstSeg.text.slice(match[0].length).trim();
    const restSegments = turn.segments.slice(1);
    const restWords = countWords(remainder) + restSegments.reduce((sum, s) => sum + countWords(s.text), 0);
    if (restWords < 30)
      continue;
    const affirmativeText = match[0].trimEnd();
    const newRestSegments = remainder ? [{ start: firstSeg.start, text: remainder }, ...restSegments] : restSegments;
    turns.splice(i, 1, {
      start: turn.start,
      segments: [{ start: firstSeg.start, text: affirmativeText }],
      speakerChange: turn.speakerChange,
      speaker: turn.speaker
    }, {
      start: newRestSegments[0].start,
      segments: newRestSegments,
      speakerChange: true,
      speaker: turn.speaker === 0 ? 1 : 0
    });
    i++;
  }
}
function mergeSentenceGroupsWithinTurn(groups) {
  if (groups.length <= 1)
    return groups;
  const merged = [];
  let current = { ...groups[0] };
  let currentIsFirstInTurn = true;
  for (let i = 1; i < groups.length; i++) {
    const next = groups[i];
    if (shouldMergeSentenceGroups(current, next, currentIsFirstInTurn)) {
      current.text = `${current.text} ${next.text}`;
      continue;
    }
    merged.push(current);
    current = { ...next };
    currentIsFirstInTurn = false;
  }
  merged.push(current);
  return merged;
}
function shouldMergeSentenceGroups(current, next, currentIsFirstInTurn) {
  const currentWords = countWords(current.text);
  const nextWords = countWords(next.text);
  if (isShortStandaloneUtterance(current.text, currentWords) || isShortStandaloneUtterance(next.text, nextWords))
    return false;
  if (currentIsFirstInTurn && currentWords < FIRST_GROUP_MERGE_MIN_WORDS)
    return false;
  if (QUESTION_END.test(current.text) || QUESTION_END.test(next.text))
    return false;
  if (currentWords + nextWords > TURN_MERGE_MAX_WORDS)
    return false;
  if (next.start - current.start > TURN_MERGE_MAX_SPAN_SECONDS)
    return false;
  return true;
}
function isShortStandaloneUtterance(text, words) {
  const w = words ?? countWords(text);
  return w > 0 && w <= SHORT_UTTERANCE_MAX_WORDS && SENTENCE_END.test(text);
}

// ../browser-agent/opencli/clis/youtube/transcript.js
import { CommandExecutionError, EmptyResultError } from "@jackwener/opencli/errors";
function unwrapBrowserResult(value) {
  if (value && typeof value === "object" && "session" in value && "data" in value) {
    return value.data;
  }
  return value;
}
function normalizeSegmentsPayload(value, source, { allowNull = false } = {}) {
  const payload = unwrapBrowserResult(value);
  if (payload == null && allowNull)
    return null;
  if (Array.isArray(payload))
    return payload;
  if (payload && typeof payload === "object" && payload.error) {
    throw new CommandExecutionError(String(payload.error));
  }
  throw new CommandExecutionError(`Malformed ${source} payload`);
}
function parseJson3Segments(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new CommandExecutionError(`Malformed json3 timedtext response: ${err?.message || err}`);
  }
  if (!Array.isArray(data?.events)) {
    throw new CommandExecutionError("Malformed json3 timedtext response: missing events array");
  }
  const rows = [];
  for (const event of data.events) {
    const startMs = Number(event?.tStartMs || 0);
    const durMs = Number(event?.dDurationMs || 0);
    const segs = Array.isArray(event?.segs) ? event.segs : [];
    const line = segs.map((seg) => seg?.utf8 || "").join("").replace(/\s+/g, " ").trim();
    if (!line)
      continue;
    rows.push({
      start: startMs / 1e3,
      end: (startMs + durMs) / 1e3,
      text: line
    });
  }
  return rows;
}
function timedtextUrlMatchesVideo(url, videoId) {
  if (!videoId)
    return true;
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("v") === videoId;
  } catch {
    return false;
  }
}
function extractSegmentsFromNetworkCapture(entries, lang, videoId) {
  const payload = unwrapBrowserResult(entries);
  if (!Array.isArray(payload) || payload.length === 0)
    return { segments: [] };
  const wanted = String(lang || "").toLowerCase();
  const wantedBase = wanted.split("-")[0];
  const timedtext = payload.filter((entry) => {
    const url = String(entry?.url || "");
    if (!url.includes("/api/timedtext"))
      return false;
    if (!url.includes("fmt=json3") || !url.includes("pot="))
      return false;
    if (!timedtextUrlMatchesVideo(url, videoId))
      return false;
    if (!wanted)
      return true;
    try {
      const u = new URL(url);
      const got = String(u.searchParams.get("lang") || "").toLowerCase();
      const gotBase = got.split("-")[0];
      return got === wanted || gotBase === wantedBase || wantedBase === got;
    } catch {
      return false;
    }
  }).reverse();
  let malformed = "";
  for (const entry of timedtext) {
    const body = typeof entry?.responsePreview === "string" ? entry.responsePreview : "";
    if (!body)
      continue;
    try {
      const parsed = parseJson3Segments(body);
      if (parsed.length > 0)
        return { segments: parsed };
    } catch (err) {
      malformed = err?.message || String(err);
    }
  }
  return malformed ? { error: malformed } : { segments: [] };
}
cli({
  site: "youtube",
  name: "transcript",
  access: "read",
  description: "Get YouTube video transcript/subtitles",
  domain: "www.youtube.com",
  strategy: Strategy.COOKIE,
  args: [
    { name: "url", required: true, positional: true, help: "YouTube video URL or video ID" },
    { name: "lang", required: false, help: "Language code (e.g. en, zh-Hans). Omit to auto-select" },
    { name: "mode", required: false, default: "grouped", help: "Output mode: grouped (readable paragraphs) or raw (every segment)" }
  ],
  // columns intentionally omitted — raw and grouped modes return different schemas,
  // so we let the renderer auto-detect columns from the data keys.
  func: async (page, kwargs) => {
    const videoId = parseVideoId(kwargs.url);
    const lang = kwargs.lang || "";
    const mode = kwargs.mode || "grouped";
    const watchUrl = "https://www.youtube.com/watch?v=" + encodeURIComponent(videoId);
    const canCapture = typeof page.startNetworkCapture === "function" && typeof page.readNetworkCapture === "function";
    // Navigate to THIS video's watch page so the player-capture path can run —
    // the player itself fetches the timedtext URL WITH a valid pot token, which
    // we hook; that's the only reliable pot-free capture (the bare baseUrl is
    // pot-locked → empty, and get_transcript 400s "Precondition check failed").
    //
    // Trampoline idempotency: page.goto re-executes this func from the top after
    // navigation. The check below skips the goto once we're already on this
    // video's watch page (the replay), so there is exactly ONE navigation and no
    // ping-pong. The old `onHomepage` guard couldn't tell "freshly opened on the
    // homepage" (dispatcher opens youtube.com) from "trampolined back", so it
    // skipped the INITIAL nav too → the func sat on the homepage with no player.
    // The homepage-degrade path (prepareYoutubeApiPage's goto) is gone; the fetch
    // fallbacks below work from any youtube.com origin. See §10.21 / §10.27.
    const curUrl = await page.getCurrentUrl().catch(() => "");
    const onThisWatch = /[?&]v=/.test(curUrl) && curUrl.indexOf(videoId) >= 0;
    if (!onThisWatch) {
      if (canCapture) {
        try {
          await page.startNetworkCapture("/api/timedtext");
        } catch {
        }
      }
      await page.goto(watchUrl, { waitUntil: "none" });
      await page.wait(3);
    }
    // 1) Fast, pot-free path FIRST: InnerTube get_transcript — exactly what the
    //    YouTube UI's "Show transcript" panel calls (no playback, no pot token,
    //    ~2 requests, returns instantly). Only when this misses do we fall back
    //    to the slower player-capture / network / watch-HTML paths below. The
    //    earlier version ran this LAST with a hand-rolled minimal client context,
    //    which made /next omit the transcript panel → it always missed → every
    //    request paid the 25s player poll then died on the pot-locked baseUrl.
    //    See adapter-hot-plug.md §10.25.
    let segments = null;
    try {
      const direct = unwrapBrowserResult(
        await page.evaluate(`
          (async () => {
            const videoId = ${JSON.stringify(videoId)};
            const cfg = window.ytcfg?.data_ || {};
            const apiKey = cfg.INNERTUBE_API_KEY;
            if (!apiKey) return null;
            // Use the page's REAL InnerTube context (client name/version,
            // visitorData, hl/gl). A minimal hand-rolled context makes /next drop
            // the transcript engagement panel — the root cause of the miss.
            const context = cfg.INNERTUBE_CONTEXT
              || { client: { clientName: 'WEB', clientVersion: cfg.INNERTUBE_CLIENT_VERSION || '2.20240101.00.00' } };
            async function api(ep, body) {
              const resp = await fetch('/youtubei/v1/' + ep + '?key=' + apiKey + '&prettyPrint=false', {
                method: 'POST', credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ context, ...body }),
              });
              if (!resp.ok) return null;
              return resp.json();
            }
            function findParams(obj) {
              if (!obj || typeof obj !== 'object') return null;
              const ep = obj.getTranscriptEndpoint;
              if (ep && typeof ep.params === 'string') return ep.params;
              for (const k in obj) { const r = findParams(obj[k]); if (r) return r; }
              return null;
            }
            function collectSegs(obj, out) {
              if (!obj || typeof obj !== 'object') return;
              const r = obj.transcriptSegmentRenderer;
              if (r) {
                const runs = Array.isArray(r.snippet?.runs) ? r.snippet.runs : [];
                const text = runs.map(x => x?.text || '').join('').replace(/\\s+/g, ' ').trim();
                const start = Number(r.startMs || 0) / 1000;
                const end = Number(r.endMs || 0) / 1000;
                if (text) out.push({ start, end, text });
                return;
              }
              for (const k in obj) collectSegs(obj[k], out);
            }
            // Params: FETCH the watch HTML and read the transcript panel's params
            // out of its ytInitialData. This is the only source that reliably has
            // the panel regardless of what page the tab is currently on — the
            // adapter often runs while the tab sits on the bare youtube.com
            // homepage (reused tab), whose ytInitialData / homepage-context /next
            // do NOT carry our video's transcript panel. Same-origin credentialed
            // fetch works from any youtube page. See adapter-hot-plug.md §10.26.
            const extractJsonAssignmentFromHtml = ${extractJsonAssignmentFromHtml.toString()};
            let params = null;
            try {
              const wr = await fetch('/watch?v=' + encodeURIComponent(videoId), { credentials: 'include' });
              if (wr.ok) {
                const initial = extractJsonAssignmentFromHtml(await wr.text(), 'ytInitialData');
                if (initial) params = findParams(initial);
              }
            } catch {}
            if (!params) {
              const next = await api('next', { videoId });
              if (next) params = findParams(next);
            }
            if (!params) return null;
            const data = await api('get_transcript', { params });
            if (!data) return null; // 400 "Precondition check failed" on some videos → player path takes over
            const out = [];
            collectSegs(data, out);
            return out.length ? out : null;
          })()
        `),
      );
      if (Array.isArray(direct) && direct.length > 0) segments = direct;
    } catch {
      // fall through to the player-capture / watch-HTML paths
    }

    // 2) Player-capture fallback (honors lang precisely; needs the video to play).
    const playerResult = segments
      ? null
      : await page.evaluate(`
      (async () => {
        const langPref = ${JSON.stringify(lang)};
        // Scope all timedtext URL matching to the current video. YouTube is an
        // SPA, so watch→watch navigations preserve performance.getEntriesByType
        // entries from prior videos. Without this check a stale same-language
        // URL can be picked up by the polling loop before the current video's
        // fetch hook fires, leaking the predecessor's captions.
        const targetVideoId = ${JSON.stringify(videoId)};
        const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

        function textFromJson3Event(event) {
          if (!Array.isArray(event?.segs)) return '';
          return event.segs.map(seg => seg?.utf8 || '').join('').replace(/\\s+/g, ' ').trim();
        }

        function parseJson3(text) {
          let data;
          try {
            data = JSON.parse(text);
          } catch (err) {
            return { error: 'Malformed json3 timedtext response: ' + (err?.message || String(err)) };
          }
          if (!Array.isArray(data.events)) {
            return { error: 'Malformed json3 timedtext response: missing events array' };
          }
          const rows = [];
          for (const event of data.events) {
            const startMs = Number(event.tStartMs || 0);
            const durMs = Number(event.dDurationMs || 0);
            const text = textFromJson3Event(event);
            if (!text) continue;
            rows.push({
              start: startMs / 1000,
              end: (startMs + durMs) / 1000,
              text,
            });
          }
          return { rows };
        }

        function timedtextUrlMatchesVideo(url) {
          try {
            const parsed = new URL(url, location.origin);
            return parsed.searchParams.get('v') === targetVideoId;
          } catch {
            return false;
          }
        }

        function captionTrackToPlayerTrack(track) {
          if (!track?.languageCode) return null;
          const name = track.name?.simpleText
            || (Array.isArray(track.name?.runs) ? track.name.runs.map(run => run?.text || '').join('') : '')
            || track.languageCode;
          return {
            displayName: name,
            id: null,
            is_default: false,
            is_servable: false,
            is_translateable: !!track.isTranslatable,
            kind: track.kind || '',
            languageCode: track.languageCode,
            languageName: name,
            name: '',
            vss_id: track.vssId || ((track.kind === 'asr' ? 'a.' : '.') + track.languageCode),
          };
        }

        function getTrackCandidates(player) {
          const tracklist = player?.getOption?.('captions', 'tracklist');
          if (Array.isArray(tracklist) && tracklist.length > 0) return tracklist;
          const captionTracks = player?.getPlayerResponse?.()
            ?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
          if (!Array.isArray(captionTracks)) return [];
          return captionTracks.map(captionTrackToPlayerTrack).filter(Boolean);
        }

        function pickTrack(tracklist) {
          if (!Array.isArray(tracklist) || tracklist.length === 0) return null;
          if (langPref) {
            // Prefer a MANUAL (non-asr) track in the requested language: the asr
            // track's only directly-fetchable URL is the pot-locked baseUrl, which
            // returns an empty body. If the requested language is absent entirely,
            // fall through to the auto-select order so passing lang never does
            // worse than omitting it. See adapter-hot-plug.md §10.23.
            return tracklist.find(t => t.languageCode === langPref && t.kind !== 'asr')
              || tracklist.find(t => t.languageCode?.startsWith(langPref) && t.kind !== 'asr')
              || tracklist.find(t => t.languageCode === langPref)
              || tracklist.find(t => t.languageCode?.startsWith(langPref))
              || tracklist.find(t => t.languageCode === 'en' && t.kind !== 'asr')
              || tracklist.find(t => t.kind !== 'asr')
              || tracklist[0];
          }
          return tracklist.find(t => t.languageCode === 'en' && t.kind !== 'asr')
            || tracklist.find(t => t.languageCode === 'en')
            || tracklist.find(t => t.kind !== 'asr')
            || tracklist[0];
        }

        function findTimedtextUrl(track) {
          const urls = performance.getEntriesByType('resource')
            .map(entry => entry.name)
            .filter(url => url.includes('/api/timedtext')
                        && url.includes('fmt=json3')
                        && url.includes('pot=')
                        && timedtextUrlMatchesVideo(url));
          if (!urls.length) return '';
          if (track?.languageCode) {
            const wanted = String(track.languageCode || '').toLowerCase();
            const wantedBase = wanted.split('-')[0];
            const match = [...urls].reverse().find((rawUrl) => {
              try {
                const u = new URL(rawUrl, location.origin);
                const got = String(u.searchParams.get('lang') || '').toLowerCase();
                const gotBase = got.split('-')[0];
                return got === wanted || gotBase === wantedBase || wantedBase === got;
              } catch {
                return false;
              }
            });
            if (match) return match;
          }
          return urls[urls.length - 1];
        }

        function isJson3TimedtextUrl(url, track) {
          if (!url || !url.includes('/api/timedtext')) return false;
          if (!url.includes('fmt=json3')) return false;
          if (!url.includes('pot=')) return false;
          if (!timedtextUrlMatchesVideo(url)) return false;
          if (!track?.languageCode) return true;
          try {
            const u = new URL(url, location.origin);
            const got = String(u.searchParams.get('lang') || '').toLowerCase();
            const wanted = String(track.languageCode || '').toLowerCase();
            const gotBase = got.split('-')[0];
            const wantedBase = wanted.split('-')[0];
            return got === wanted || gotBase === wantedBase || wantedBase === got;
          } catch {
            return false;
          }
        }

        const player = document.getElementById('movie_player');
        if (!player?.getOption || !player?.setOption) {
          return null;
        }

        let track = null;
        for (let i = 0; i < 20; i++) {
          track = pickTrack(getTrackCandidates(player));
          if (track) break;
          await sleep(500);
        }
        if (!track) return null;

        const originalFetch = globalThis.fetch;
        const boundOriginalFetch = originalFetch?.bind(globalThis);
        const OriginalXHR = globalThis.XMLHttpRequest;
        let capturedJson3Text = '';
        try {
          if (boundOriginalFetch) {
            globalThis.fetch = async (...args) => {
              const response = await boundOriginalFetch(...args);
              try {
                const req = args[0];
                const reqUrl = typeof req === 'string' ? req : req?.url || '';
                if (isJson3TimedtextUrl(reqUrl, track) && response?.ok) {
                  const text = await response.clone().text();
                  if (text && !capturedJson3Text) {
                    capturedJson3Text = text;
                  }
                }
              } catch {}
              return response;
            };
          }
          if (OriginalXHR) {
            globalThis.XMLHttpRequest = class TimedtextCaptureXHR extends OriginalXHR {
              open(method, url, ...rest) {
                this.__opencliTimedtextUrl = typeof url === 'string' ? url : '';
                return super.open(method, url, ...rest);
              }
              send(...args) {
                this.addEventListener('load', () => {
                  try {
                    const url = this.__opencliTimedtextUrl || this.responseURL || '';
                    if (!isJson3TimedtextUrl(url, track)) return;
                    if (this.status < 200 || this.status >= 300) return;
                    const text = typeof this.responseText === 'string' ? this.responseText : '';
                    if (text && !capturedJson3Text) {
                      capturedJson3Text = text;
                    }
                  } catch {}
                });
                return super.send(...args);
              }
            };
          }

          // Do not clear resource timings: some videos emit a valid timedtext URL
          // before our polling loop starts; keeping existing entries avoids misses.
          try { player.loadModule?.('captions'); } catch {}
          await sleep(500);
          try { player.setOption('captions', 'track', track); } catch {}
          try { player.playVideo?.(); } catch {}

          for (let i = 0; i < 30; i++) {
            await sleep(500);
            if (capturedJson3Text) {
              const parsed = parseJson3(capturedJson3Text);
              if (parsed.error) return { error: parsed.error };
              if (parsed.rows.length > 0) return parsed.rows;
            }
            const url = findTimedtextUrl(track);
            if (!url) continue;
            const resp = await fetch(url, { credentials: 'include' });
            if (!resp.ok) continue;
            const text = await resp.text();
            if (!text) continue;
            const parsed = parseJson3(text);
            if (parsed.error) return { error: parsed.error };
            if (parsed.rows.length > 0) return parsed.rows;
          }

          return null;
        } finally {
          try { player?.pauseVideo?.(); } catch {}
          if (originalFetch) globalThis.fetch = originalFetch;
          if (OriginalXHR) globalThis.XMLHttpRequest = OriginalXHR;
        }
      })()
    `);
    if (!segments) {
      segments = normalizeSegmentsPayload(playerResult, "player caption extraction", { allowNull: true });
    }
    if (!segments && canCapture) {
      try {
        const captured = extractSegmentsFromNetworkCapture(await page.readNetworkCapture(), lang, videoId);
        if (captured.error) {
          throw new CommandExecutionError(captured.error);
        }
        if (captured.segments.length > 0) {
          segments = captured.segments;
        }
      } catch (err) {
        if (err instanceof CommandExecutionError)
          throw err;
      }
    }
    // No prepareYoutubeApiPage(page) here: it used to goto(youtube.com homepage),
    // which fought the watch goto above into a trampoline ping-pong (§10.21). The
    // watch-HTML fetch below is same-origin from wherever we already are.
    const captionData = segments ? null : unwrapBrowserResult(await page.evaluate(`
      (async () => {
        const extractJsonAssignmentFromHtml = ${extractJsonAssignmentFromHtml.toString()};

        const watchResp = await fetch('/watch?v=' + encodeURIComponent(${JSON.stringify(videoId)}), {
          credentials: 'include',
        });
        if (!watchResp.ok) return { error: 'Watch HTML returned HTTP ' + watchResp.status };

        const html = await watchResp.text();
        const player = extractJsonAssignmentFromHtml(html, 'ytInitialPlayerResponse');
        if (!player) return { error: 'ytInitialPlayerResponse not found in watch HTML' };

        const renderer = player.captions?.playerCaptionsTracklistRenderer;
        if (!renderer?.captionTracks?.length) {
          return { error: 'No captions available for this video' };
        }

        const tracks = renderer.captionTracks;
        const available = tracks.map(t => t.languageCode + (t.kind === 'asr' ? ' (auto)' : ''));

        const langPref = ${JSON.stringify(lang)};
        let track = null;
        if (langPref) {
          // Prefer a manual (non-asr) track in the requested language; see pickTrack.
          track = tracks.find(t => t.languageCode === langPref && t.kind !== 'asr')
            || tracks.find(t => t.languageCode.startsWith(langPref) && t.kind !== 'asr')
            || tracks.find(t => t.languageCode === langPref)
            || tracks.find(t => t.languageCode.startsWith(langPref));
        }
        if (!track) {
          track = tracks.find(t => t.kind !== 'asr') || tracks[0];
        }

        return {
          captionUrl: track.baseUrl,
          language: track.languageCode,
          kind: track.kind || 'manual',
          available,
          requestedLang: langPref || null,
          langMatched: !!(langPref && track.languageCode === langPref),
          langPrefixMatched: !!(langPref && track.languageCode !== langPref && track.languageCode.startsWith(langPref))
        };
      })()
    `));
    if (!segments && (!captionData || typeof captionData !== "object" || Array.isArray(captionData))) {
      throw new CommandExecutionError(`Failed to get caption info: ${typeof captionData === "string" ? captionData : "malformed response"}`);
    }
    if (captionData?.error) {
      const msg = `${captionData.error}${captionData.available ? " (available: " + captionData.available.join(", ") + ")" : ""}`;
      if (captionData.error === "No captions available for this video") {
        throw new EmptyResultError("youtube transcript", "该视频没有字幕（作者未开启 + 无自动字幕）。");
      }
      throw new CommandExecutionError(msg);
    }
    if (!segments && typeof captionData?.captionUrl !== "string") {
      throw new CommandExecutionError("Malformed caption info payload");
    }
    if (captionData?.requestedLang && !captionData.langMatched && !captionData.langPrefixMatched) {
      console.error(`Warning: --lang "${captionData.requestedLang}" not found. Using "${captionData.language}" instead. Available: ${captionData.available.join(", ")}`);
    }
    if (!segments) {
      const originalCaptionUrl = captionData.captionUrl;
      let captionUrl = originalCaptionUrl;
      if (!/[&?]fmt=/.test(originalCaptionUrl)) {
        captionUrl = originalCaptionUrl + (originalCaptionUrl.includes("?") ? "&" : "?") + "fmt=srv3";
      }
      segments = normalizeSegmentsPayload(await page.evaluate(`
      (async () => {
        async function fetchCaptionXml(url) {
          const resp = await fetch(url);
          if (!resp.ok) return { error: 'Caption URL returned HTTP ' + resp.status };
          return { xml: await resp.text() || '' };
        }

        const primaryUrl = ${JSON.stringify(captionUrl)};
        const originalUrl = ${JSON.stringify(originalCaptionUrl)};
        let result = await fetchCaptionXml(primaryUrl);
        if (result.error) return result;

        // If srv3 format returned an empty successful body, retry with the
        // original URL. Do not hide HTTP/non-OK failures behind fallback.
        if (!result.xml.length && originalUrl !== primaryUrl) {
          result = await fetchCaptionXml(originalUrl);
          if (result.error) {
            return result;
          }
        }
        const xml = result.xml;

        if (!xml.length) {
          return { error: 'Caption URL returned empty response' };
        }

        function getAttr(tag, name) {
          const needle = name + '="';
          const idx = tag.indexOf(needle);
          if (idx === -1) return '';
          const valStart = idx + needle.length;
          const valEnd = tag.indexOf('"', valStart);
          if (valEnd === -1) return '';
          return tag.substring(valStart, valEnd);
        }

        function decodeEntities(s) {
          return s
            .replaceAll('&amp;', '&')
            .replaceAll('&lt;', '<')
            .replaceAll('&gt;', '>')
            .replaceAll('&quot;', '"')
            .replaceAll('&#39;', "'");
        }

        const isFormat3 = xml.includes('<p t="');
        const marker = isFormat3 ? '<p ' : '<text ';
        const endMarker = isFormat3 ? '</p>' : '</text>';
        const results = [];
        let pos = 0;

        while (true) {
          const tagStart = xml.indexOf(marker, pos);
          if (tagStart === -1) break;
          let contentStart = xml.indexOf('>', tagStart);
          if (contentStart === -1) break;
          contentStart += 1;
          const tagEnd = xml.indexOf(endMarker, contentStart);
          if (tagEnd === -1) break;

          const attrStr = xml.substring(tagStart + marker.length, contentStart - 1);
          const content = xml.substring(contentStart, tagEnd);

          let startSec, durSec;
          if (isFormat3) {
            startSec = (parseFloat(getAttr(attrStr, 't')) || 0) / 1000;
            durSec = (parseFloat(getAttr(attrStr, 'd')) || 0) / 1000;
          } else {
            startSec = parseFloat(getAttr(attrStr, 'start')) || 0;
            durSec = parseFloat(getAttr(attrStr, 'dur')) || 0;
          }

          // Strip inner tags (e.g. <s> in srv3 format) and decode entities
          const text = decodeEntities(content.replace(/<[^>]+>/g, '')).split('\\\\n').join(' ').trim();
          if (text) {
            results.push({ start: startSec, end: startSec + durSec, text });
          }

          pos = tagEnd + endMarker.length;
        }

        if (results.length === 0) {
          return { error: 'Parsed 0 segments from caption XML' };
        }

        return results;
      })()
    `), "caption XML extraction");
    }
    if (segments.length === 0) {
      throw new EmptyResultError("youtube transcript");
    }
    let chapters = [];
    if (mode === "grouped") {
      try {
        const chapterData = unwrapBrowserResult(await page.evaluate(`
          (async () => {
            const cfg = window.ytcfg?.data_ || {};
            const apiKey = cfg.INNERTUBE_API_KEY;
            if (!apiKey) return [];

            const resp = await fetch('/youtubei/v1/next?key=' + apiKey + '&prettyPrint=false', {
              method: 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                context: { client: { clientName: 'WEB', clientVersion: '2.20240101.00.00' } },
                videoId: ${JSON.stringify(videoId)}
              })
            });
            if (!resp.ok) return [];
            const data = await resp.json();

            const chapters = [];

            // Try chapterRenderer from player bar
            const panels = data.playerOverlays?.playerOverlayRenderer
              ?.decoratedPlayerBarRenderer?.decoratedPlayerBarRenderer
              ?.playerBar?.multiMarkersPlayerBarRenderer?.markersMap;

            if (Array.isArray(panels)) {
              for (const panel of panels) {
                const markers = panel.value?.chapters;
                if (!Array.isArray(markers)) continue;
                for (const marker of markers) {
                  const ch = marker.chapterRenderer;
                  if (!ch) continue;
                  const title = ch.title?.simpleText || '';
                  const startMs = ch.timeRangeStartMillis;
                  if (title && typeof startMs === 'number') {
                    chapters.push({ title, start: startMs / 1000 });
                  }
                }
              }
            }
            if (chapters.length > 0) return chapters;

            // Fallback: macroMarkersListItemRenderer from engagement panels
            const engPanels = data.engagementPanels;
            if (!Array.isArray(engPanels)) return [];
            for (const ep of engPanels) {
              const content = ep.engagementPanelSectionListRenderer?.content;
              const items = content?.macroMarkersListRenderer?.contents;
              if (!Array.isArray(items)) continue;
              for (const item of items) {
                const renderer = item.macroMarkersListItemRenderer;
                if (!renderer) continue;
                const t = renderer.title?.simpleText || '';
                const ts = renderer.timeDescription?.simpleText || '';
                if (!t || !ts) continue;
                const parts = ts.split(':').map(Number);
                let secs = null;
                if (parts.length === 3 && parts.every(n => !isNaN(n))) secs = parts[0]*3600 + parts[1]*60 + parts[2];
                else if (parts.length === 2 && parts.every(n => !isNaN(n))) secs = parts[0]*60 + parts[1];
                if (secs !== null) chapters.push({ title: t, start: secs });
              }
            }
            return chapters;
          })()
        `));
        if (Array.isArray(chapterData)) {
          chapters = chapterData;
        }
      } catch {
      }
    }
    if (mode === "raw") {
      return segments.map((seg, i) => ({
        index: i + 1,
        start: Number(seg.start).toFixed(2) + "s",
        end: Number(seg.end).toFixed(2) + "s",
        text: seg.text
      }));
    }
    const grouped = groupTranscriptSegments(segments.map((s) => ({ start: s.start, text: s.text })));
    const { rows } = formatGroupedTranscript(grouped, chapters);
    return rows;
  }
});
