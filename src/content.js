// The watch-page side of the extension.
//
// How a read gets skipped, in one pass:
//   code captures the video's own captions as they are spoken (no network, no
//   speech API) -> code merges them into numbered transcript lines -> the local
//   Laya judge answers "is this line inside a sponsor read?" for the new lines ->
//   code groups the yeses into a run, asks the edges where the read starts and
//   ends, and owns the seconds it jumps to.
//
// The trade of reading captions live is the same one the upstream project makes
// in its audio mode: the first seconds of a read have already been heard before
// the read is confirmed. Everything after that is a jump that code decided.

import { mergeCues, msToLabel, parsePastedTranscript } from "./transcript.js";
import { DEFAULTS as SPONSOR_DEFAULTS, detectSponsors, judgeIndices, makeJudge, refineCandidate } from "./sponsor.js";
import { createPanel, showToast } from "./panel.js";
import * as yt from "./youtube.js";

const DEFAULTS = {
  enabled: true,
  autoSkip: false,
  threshold: SPONSOR_DEFAULTS.threshold,
  cutThreshold: SPONSOR_DEFAULTS.cutThreshold,
  minReadSeconds: SPONSOR_DEFAULTS.minReadMs / 1000,
  maxReadSeconds: SPONSOR_DEFAULTS.maxReadMs / 1000,
  maxReads: SPONSOR_DEFAULTS.maxReads,
  stepSeconds: SPONSOR_DEFAULTS.stepMs / 1000,
  enableCaptions: true,
  toast: true,
};

const CAPTURE_MS = 250;
const TICK_MS = 2500;
// Local decisions are ~10 ms each, so a tick can afford to judge every new line and
// stay close behind the captions. Judging lazily made a partially judged read look
// like a whole one, and the refinement then locked the narrow version in.
const MAX_NEW_LINES_PER_TICK = 40;
const LOG_LIMIT = 400;

const state = {
  settings: { ...DEFAULTS },
  videoId: null,
  cues: [],
  lines: [],
  flags: new Map(), // line index (0-based) -> P(inside a read)
  judgedUpTo: 0,
  openRead: null,
  reads: [],
  log: [],
  model: null,
  heuristic: false,
  source: "live",
  captionsWeTurnedOn: false,
  panelHiddenFor: null,
  busy: false,
  refining: new Set(), // runs being refined right now, so overlapping ticks cannot double-add one
  lastError: null,
  skippedHere: 0,
  totalSkipped: 0,
  lastCaptionText: "",
};

const panel = createPanel({
  onSkip: (read) => skipNow(read),
  onAutoSkip: (on) => {
    state.settings.autoSkip = on;
    chrome.storage.sync.set({ autoSkip: on });
    pushLog({ kind: "auto-skip", verdict: on ? "on" : "off" });
  },
  onAnalyze: () => analyzeAll("manual"),
  onPaste: (text) => usePastedTranscript(text),
  onReanalyze: () => reanalyze(),
  onCompare: () => compareWithSponsorBlock(),
  onClear: () => {
    state.log = [];
    state.reads = [];
    state.openRead = null;
    render();
  },
  onClose: () => {
    state.panelHiddenFor = state.videoId;
    panel.hide();
  },
});

function pushLog(entry) {
  state.log.push({ at: Date.now(), ...entry });
  if (state.log.length > LOG_LIMIT) state.log.splice(0, state.log.length - LOG_LIMIT);
  if (entry.message && entry.kind?.startsWith("judge")) state.lastError = entry.message;
  if (entry.model) {
    state.model = entry.model;
    state.heuristic = /heuristic/.test(entry.model);
  }
}

function settingsForPipeline() {
  return {
    threshold: state.settings.threshold,
    cutThreshold: state.settings.cutThreshold,
    minReadMs: state.settings.minReadSeconds * 1000,
    maxReadMs: state.settings.maxReadSeconds * 1000,
    maxReads: state.settings.maxReads,
    stepMs: state.settings.stepSeconds * 1000,
  };
}

/** The judge goes through the service worker, which owns where the server is. */
function makeTransport() {
  return async ({ state: judgeState, candidates, questions }) => {
    const res = await chrome.runtime.sendMessage({ type: "judge", state: judgeState, candidates, questions });
    if (!res) throw new Error("The service worker did not answer — is the extension reloaded?");
    return res;
  };
}

function currentJudge() {
  return makeJudge({ video: yt.videoMeta(), transport: makeTransport(), log: pushLog });
}

// ---------- capture ----------

/** Read the caption that is on screen right now and keep it as a cue. */
function captureCaption() {
  if (!state.settings.enabled || state.source === "paste") return;
  if (state.settings.enableCaptions && !yt.captionsEnabled() && !state.captionsWeTurnedOn) {
    state.captionsWeTurnedOn = yt.enableCaptions();
    if (state.captionsWeTurnedOn) pushLog({ kind: "captions", verdict: "turned the video's captions on" });
  }
  const now = yt.currentTimeMs();
  const text = yt.captionText();
  if (!text) {
    state.lastCaptionText = "";
    return;
  }
  const last = state.cues[state.cues.length - 1];
  if (text === state.lastCaptionText && last) {
    if (now > last.startMs) last.endMs = now; // the same caption is still up
    return;
  }
  if (last && now < last.startMs) return; // a seek backwards: keep the old cue
  state.cues.push({ startMs: now, endMs: now, text });
  state.lastCaptionText = text;
}

// ---------- judging ----------

async function judgeNewLines(lines) {
  const from = Math.max(0, state.judgedUpTo - 1); // the tail line keeps growing
  const upto = Math.min(lines.length - 1, from + MAX_NEW_LINES_PER_TICK);
  const indices = [];
  for (let i = from; i <= upto; i++) indices.push(i);
  if (!indices.length) return;
  const probs = await judgeIndices(currentJudge(), lines, indices, "inside", { log: pushLog, settings: settingsForPipeline() });
  for (const [index, p] of probs) state.flags.set(index, p);
  state.judgedUpTo = Math.max(state.judgedUpTo, upto + 1);
}

function flagsArray(lines) {
  return lines.map((_, i) => (state.flags.get(i) ?? 0) >= state.settings.threshold);
}

/**
 * Every run of yeses, plus the one at the tail of the transcript if it is still
 * open — we may be inside it right now, which is the live counterpart of the
 * audio modes upstream: the end is not known until the speaker is done.
 */
function runs(lines) {
  const flags = flagsArray(lines);
  const found = [];
  let start = -1;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] && start < 0) start = i;
    if ((!flags[i] || i === flags.length - 1) && start >= 0) {
      found.push({ from: start, to: flags[i] ? i : i - 1 });
      start = -1;
    }
  }

  state.openRead = null;
  const closedRuns = found.slice();
  const tail = found[found.length - 1];
  if (tail) {
    // "Settled" means three quiet lines that have actually been judged — otherwise a
    // run that is still growing looks finished simply because nobody asked yet.
    const judgedTo = Math.min(state.judgedUpTo - 1, lines.length - 1);
    const settled = judgedTo - tail.to >= 3;
    if (!settled && yt.isPlaying()) {
      closedRuns.pop();
      state.openRead = {
        key: `open-${tail.from}`,
        open: true,
        startMs: lines[tail.from].startMs,
        startLine: lines[tail.from].index,
        endLine: lines[tail.to].index,
        confidence: Math.max(0, ...[...state.flags.entries()].filter(([i]) => i >= tail.from && i <= tail.to).map(([, p]) => p)),
        run: tail,
      };
    }
  }
  return closedRuns;
}

function overlaps(a, b) {
  const shared = Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs);
  const shorter = Math.min(a.endMs - a.startMs, b.endMs - b.startMs);
  return shared > 0 && shared >= shorter * 0.5;
}

async function updateReads(lines) {
  const closed = runs(lines);
  for (const run of closed) {
    const run_ = { startMs: lines[run.from].startMs, endMs: lines[run.to].endMs };
    const key = `L${lines[run.from].index}`;
    // The same read must not be refined (or skipped) twice: ticks are 2.5 s apart
    // while a refinement takes several local calls, and the run can be re-derived
    // with slightly different edges on the next tick.
    if (state.refining.has(key) || state.reads.some((read) => overlaps(read, run_))) continue;
    state.refining.add(key);
    try {
      const read = await refineCandidate({ lines, run, judge: currentJudge(), settings: settingsForPipeline(), log: pushLog });
      if (read) {
        state.reads.push(read);
        state.reads.sort((a, b) => a.startMs - b.startMs);
        if (state.settings.toast) showToast(`⏭️ Sponsor read at ${msToLabel(read.startMs)} – ${msToLabel(read.endMs)} (P ${read.confidence.toFixed(2)})`);
        if (state.settings.autoSkip) await skipRead(read);
      }
    } finally {
      state.refining.delete(key);
    }
  }
  await maybeStepWhileInside(lines);
}

/**
 * The live counterpart of the audio modes upstream: while the newest line still
 * reads as sponsor, step over the read. Only ever forward, only while the line
 * just heard says yes, and never past `maxReadSeconds`.
 */
async function maybeStepWhileInside(lines) {
  const open = state.openRead;
  if (!open) return;
  const elapsed = yt.currentTimeMs() - open.startMs;
  if (elapsed > state.settings.maxReadSeconds * 1000) {
    pushLog({ kind: "open-read", verdict: "too long, stopped stepping", ms: Math.round(elapsed) });
    state.openRead = null;
    return;
  }
  const tailIndex = Math.max(0, Math.min(state.judgedUpTo, lines.length) - 1);
  const tailP = state.flags.get(tailIndex) ?? 0;
  // The read gate, not the boundary gate: stepping only ever moves forward, and the
  // worst case is overshooting the read's end by one step. Starting to jump early is
  // the dangerous direction, and that one stays at cutThreshold.
  if (tailP < state.settings.threshold) return;
  if (!state.settings.autoSkip) return;
  if (!yt.isPlaying()) return;
  const target = yt.currentTimeMs() + state.settings.stepSeconds * 1000;
  if (target >= state.settings.maxReadSeconds * 1000 + open.startMs) return;
  yt.seekToMs(target);
  pushLog({ kind: "step", at: msToLabel(target), p: tailP, verdict: "jumped over the read by ear" });
}

/** Skip a read whose end we know. Never seeks backwards: a read we are already past is done. */
async function skipRead(read, { notify = true } = {}) {
  if (read.skipped) return;
  const target = Math.min(read.endMs + 300, read.startMs + state.settings.maxReadSeconds * 1000);
  if (target <= yt.currentTimeMs() + 500) {
    read.past = true; // honest in the panel: it was not skipped, we are already past it
    pushLog({ kind: "skip", at: msToLabel(target), verdict: "already behind us — nothing to jump over" });
    return;
  }
  yt.seekToMs(target);
  read.skipped = true;
  if (notify && state.settings.toast) showToast(`⏭️ Skipped ${Math.round((target - read.startMs) / 1000)} s of sponsor read`);
  pushLog({ kind: "skip", at: msToLabel(target), verdict: `skipped to ${msToLabel(target)}` });
  await countSkip(1);
}

function skipNow(read) {
  if (read.open) {
    const target = yt.currentTimeMs() + state.settings.stepSeconds * 1000;
    yt.seekToMs(target);
    pushLog({ kind: "step", at: msToLabel(target), verdict: "manual jump over the open read" });
    return;
  }
  skipRead(read);
}

async function countSkip(count) {
  if (!count) return;
  state.skippedHere += count;
  const res = await chrome.runtime.sendMessage({ type: "skipped", count }).catch(() => null);
  if (res?.totalSkipped != null) state.totalSkipped = res.totalSkipped;
}

// ---------- full analysis (analyze button, paste, cached reads) ----------

async function analyzeAll(reason) {
  const lines = state.lines.length ? state.lines : mergeCues(state.cues);
  state.lines = lines;
  if (lines.length < 2) {
    panel.setError("Not enough transcript yet — play the video with captions on, or paste a transcript.");
    return;
  }
  if (state.busy) {
    panel.setError("Still working on the last batch — try again in a moment.");
    return;
  }
  panel.setError("");
  state.busy = true;
  try {
    const result = await detectSponsors({
      video: yt.videoMeta(),
      lines,
      judge: currentJudge(),
      settings: settingsForPipeline(),
      log: pushLog,
    });
    state.reads = result.reads;
    state.model = result.model ?? state.model;
    state.heuristic = !!result.heuristic;
    state.openRead = null;
    cacheReads();
    pushLog({ kind: "analyze", verdict: `${reason}: ${result.reads.length} read(s) over ${lines.length} lines` });
    if (state.settings.toast) {
      showToast(result.reads.length ? `⏭️ ${result.reads.length} sponsor read(s) found` : "✅ No sponsor read found");
    }
  } catch (err) {
    state.lastError = err?.message ?? String(err);
    pushLog({ kind: "analyze-error", message: state.lastError, verdict: "failed" });
  } finally {
    state.busy = false;
    render();
  }
}

function usePastedTranscript(text) {
  const parsed = parsePastedTranscript(text);
  if (!parsed.lines.length) {
    panel.setError("Could not read that transcript.");
    return;
  }
  state.source = "paste";
  state.cues = parsed.cues;
  state.lines = parsed.lines;
  state.flags = new Map();
  state.judgedUpTo = 0;
  state.reads = [];
  state.openRead = null;
  for (const warning of parsed.warnings) pushLog({ kind: "paste", verdict: warning });
  panel.setError(parsed.timed ? "" : "Pasted transcript has no timings — boundaries are estimated, so auto-skip stays off.");
  if (!parsed.timed) state.settings.autoSkip = false;
  render();
  analyzeAll("pasted transcript");
}

async function compareWithSponsorBlock() {
  const videoId = state.videoId;
  if (!videoId) return;
  try {
    const res = await chrome.runtime.sendMessage({ type: "sponsorblock", videoId });
    if (res?.error) throw new Error(res.error);
    const theirs = res.segments ?? [];
    if (!theirs.length) {
      pushLog({ kind: "sponsorblock", verdict: "no community labels for this video" });
      showToast("SponsorBlock has no labels for this video");
      return;
    }
    const mine = state.reads;
    const caught = theirs.filter((seg) => mine.some((r) => r.startMs <= seg.startMs + 5000 && r.endMs >= seg.endMs - 5000));
    const extra = mine.filter((r) => !theirs.some((seg) => r.startMs <= seg.startMs + 5000 && r.endMs >= seg.endMs - 5000));
    pushLog({
      kind: "sponsorblock",
      verdict: `${caught.length}/${theirs.length} community reads found, ${extra.length} read(s) of ours they do not have`,
    });
    showToast(`SponsorBlock: ${caught.length}/${theirs.length} match, ${extra.length} extra of ours`);
  } catch (err) {
    pushLog({ kind: "sponsorblock-error", message: err?.message ?? String(err), verdict: "failed" });
    showToast("SponsorBlock lookup failed");
  }
}

// ---------- per-video cache ----------

async function loadCached(videoId) {
  const key = `video:${videoId}`;
  const stored = await chrome.storage.local.get(key).catch(() => ({}));
  const entry = stored?.[key];
  if (!entry || entry.videoId !== videoId) return;
  state.reads = entry.reads ?? [];
  state.model = entry.model ?? state.model;
  pushLog({ kind: "cache", verdict: `${state.reads.length} read(s) from the last run on this video` });
  render();
}

function cacheReads() {
  if (!state.videoId || !state.reads.length) return;
  chrome.storage.local.set({
    [`video:${state.videoId}`]: { videoId: state.videoId, reads: state.reads, model: state.model, savedAt: Date.now() },
  }).catch(() => {});
}

async function reanalyze() {
  state.flags = new Map();
  state.judgedUpTo = 0;
  state.reads = [];
  state.openRead = null;
  state.log = [];
  if (state.videoId) await chrome.storage.local.remove(`video:${state.videoId}`).catch(() => {});
  await analyzeAll("re-analyze");
}

// ---------- the loop ----------

function render() {
  const lines = state.lines;
  const renders = [...state.reads];
  if (state.openRead) renders.push({ ...state.openRead, elapsedMs: yt.currentTimeMs() - state.openRead.startMs });
  renders.sort((a, b) => a.startMs - b.startMs);
  panel.render({
    model: state.model,
    heuristic: state.heuristic,
    source: state.source,
    capturedLines: lines.length,
    capturedMs: lines.length ? lines[lines.length - 1].endMs : 0,
    reads: renders,
    log: state.log,
    settings: { ...state.settings, stepMs: state.settings.stepSeconds * 1000 },
    skippedTotal: state.totalSkipped,
    stats: { skippedHere: state.skippedHere, skippedTotal: state.totalSkipped },
  });
  panel.setError(state.lastError ? `Local judge: ${state.lastError}` : "");
}

async function tick() {
  if (state.busy) return; // one pass at a time: judging and refining both await the local model
  if (!state.settings.enabled || state.source === "paste") return;
  state.lines = mergeCues(state.cues);
  if (state.lines.length === 0) return;
  state.busy = true;
  try {
    if (state.lines.length > state.judgedUpTo + 1) await judgeNewLines(state.lines);
    await updateReads(state.lines);
    if (state.reads.length && render._saved !== JSON.stringify(state.reads.map((r) => [r.startMs, r.endMs, r.skipped]))) {
      render._saved = JSON.stringify(state.reads.map((r) => [r.startMs, r.endMs, r.skipped]));
      cacheReads();
    }
  } catch (err) {
    state.lastError = err?.message ?? String(err);
    pushLog({ kind: "loop-error", message: state.lastError, verdict: "failed" });
  } finally {
    state.busy = false;
  }
  render();
}

function resetForVideo() {
  const videoId = yt.parseVideoId();
  if (videoId === state.videoId) return;
  state.videoId = videoId;
  state.cues = [];
  state.lines = [];
  state.flags = new Map();
  state.judgedUpTo = 0;
  state.openRead = null;
  state.reads = [];
  state.log = [];
  state.model = null;
  state.heuristic = false;
  state.source = "live";
  state.skippedHere = 0;
  state.captionsWeTurnedOn = false;
  state.lastCaptionText = "";
  panel.setError("");
  if (state.panelHiddenFor !== videoId) panel.show();
  if (videoId) loadCached(videoId);
  render();
}

(async () => {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  state.settings = { ...DEFAULTS, ...stored };
  const totals = await chrome.storage.local.get({ totalSkipped: 0 });
  state.totalSkipped = totals.totalSkipped ?? 0;
  if (!yt.isWatchPage()) return;
  resetForVideo();
  setInterval(captureCaption, CAPTURE_MS);
  setInterval(tick, TICK_MS);
  yt.onNavigate(() => resetForVideo());
})();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  for (const [key, { newValue }] of Object.entries(changes)) {
    if (key in DEFAULTS) state.settings[key] = newValue;
  }
  render();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "getStats") {
    sendResponse({
      reads: state.reads.length,
      open: !!state.openRead,
      skippedHere: state.skippedHere,
      lines: state.lines.length,
      model: state.model,
      lastError: state.lastError,
    });
  } else if (msg?.type === "reanalyze") {
    reanalyze().then(() => sendResponse({ ok: true }), (err) => sendResponse({ error: String(err) }));
    return true;
  }
  return false;
});
