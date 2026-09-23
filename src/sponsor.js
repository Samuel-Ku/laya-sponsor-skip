// The sponsor-read pipeline.
//
// Code owns every timestamp and every threshold; the model only answers typed
// noul questions about a line that already has one. That is the same split the
// upstream project uses with Jev, and it is why this file can be tested offline:
// swap the judge for the code heuristic and the whole thing still runs.
//
// Shape of one pass: sample lines, ask "is this line inside a sponsor read?",
// group the yeses into candidate runs, then walk the edges and the lead-in with
// sharper questions, and finally read the seconds off the lines.

import { groupRuns, indexLines, lineLabel, medianLineMs, msToLabel } from "./transcript.js";
import { isHeuristic } from "./laya.js";

export const DEFAULTS = {
  threshold: 0.7, // a line counts as inside a read above this
  cutThreshold: 0.8, // a boundary is only cut above this (upstream's phrase rule)
  minReadMs: 20000, // shorter than this is not worth a skip
  maxReadMs: 180000, // longer than this is not skipped at all
  maxReads: 6,
  stepMs: 10000, // live mode: jump size while a read is still being heard
  batchSize: 6, // questions per local call — checkpoints are 512/1024 tokens
  stride: 2, // pass-1 sampling: every second line
  leadinLines: 15, // how far back the lead-in may reach
};

const TEXT_LIMIT = 220;
const CONTEXT_LIMIT = 70;

// The same definition of a sponsor read the upstream pipeline carries in every
// question: a lead-in that exists only to arrive at the sponsor, the pitch, the
// offer — and, spelled out, what does not count.
export const CRITERIA = {
  true:
    "A sponsor read: paid promotion inside the video's own audio. It starts at the lead-in " +
    "(a story, a \"quick word\", or a sentence whose only purpose is to arrive at the sponsor), " +
    "continues through the pitch (what the product is, why the speaker uses it) and the offer " +
    "(a discount code, a link, a free trial, \"link in the description\").",
  false:
    "Everything else: the video's actual subject, the speaker's own opinions and stories, " +
    "\"like and subscribe\", the notification bell, comments, the speaker's own merch store, " +
    "channel memberships and Patreon, teasers for the speaker's other videos, and any read " +
    "that only mentions a name without promoting it.",
};

const READING =
  "`page` describes the video. Each entry of `candidates` is one transcript line of that video, " +
  "with the lines just before and after it for context. Lines are quoted as `line` (for example " +
  "`L042`); times are only for the reader.";

export function questionsFor(kind, count) {
  const ask = {
    inside: (k) =>
      `Is the transcript line in \`candidates[${k}]\` spoken inside a sponsor read of this video?`,
    start: (k) =>
      `Is the transcript line in \`candidates[${k}]\` the first line of a sponsor read — the moment its lead-in begins?`,
    leadin: (k) =>
      `Does the transcript line in \`candidates[${k}]\` still belong to the same sponsor read as the lines that follow it, as part of its lead-in?`,
    end: (k) =>
      `Is the sponsor read already over at the transcript line in \`candidates[${k}]\` — the speaker back on the video's own subject?`,
  }[kind];
  if (!ask) throw new Error(`questionsFor: unknown kind ${kind}`);
  return Array.from({ length: count }, (_, k) => ({ instructions: `${ask(k)} ${READING}`, criteria: CRITERIA }));
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const cut = (text, limit) => {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.length > limit ? `${t.slice(0, limit - 1)}…` : t;
};

/** One transcript line, described compactly for the model. */
export function lineCard(lines, index, { radius = 1, textLimit = TEXT_LIMIT, contextLimit = CONTEXT_LIMIT } = {}) {
  const line = lines[index];
  const before = [];
  for (let i = Math.max(0, index - radius); i < index; i++) before.push(`${lineLabel(lines[i])}: ${cut(lines[i].text, contextLimit)}`);
  const after = [];
  for (let i = index + 1; i <= Math.min(lines.length - 1, index + radius); i++) after.push(`${lineLabel(lines[i])}: ${cut(lines[i].text, contextLimit)}`);
  return {
    line: lineLabel(line),
    at: msToLabel(line.startMs),
    text: cut(line.text, textLimit),
    before: before.length ? before.join(" | ") : undefined,
    after: after.length ? after.join(" | ") : undefined,
  };
}

/** What the model is allowed to see about the video itself. */
export function pageOf(video = {}) {
  return {
    host: "youtube.com",
    title: cut(video.title || "", 120),
    channel: cut(video.channel || "", 60),
    videoId: video.videoId,
    duration: video.durationMs ? msToLabel(video.durationMs) : undefined,
  };
}

/**
 * Wrap a transport (direct fetch, or a message to the service worker) into the
 * judge the pipeline talks to. If the local server is down — or is running its
 * DOM-ad heuristic stand-in, whose vocabulary is about page elements and not
 * about speech — the code heuristic answers instead, and says so.
 */
export function makeJudge({ video, transport, log = () => {} }) {
  return async function judge({ cards, questions }) {
    let res;
    try {
      res = await transport({ state: { page: pageOf(video) }, candidates: cards, questions });
      if (res?.error) throw new Error(res.error);
    } catch (err) {
      log({ kind: "judge-error", message: err?.message ?? String(err), verdict: "heuristic" });
      return { probabilities: heuristicProbabilities(cards), model: "heuristic (offline)", heuristic: true };
    }
    if (isHeuristic(res?.model) || !Array.isArray(res?.probabilities) || res.probabilities.length !== cards.length) {
      log({ kind: "judge-heuristic", model: res?.model, verdict: "heuristic" });
      return { probabilities: heuristicProbabilities(cards), model: res?.model ?? "heuristic", heuristic: true };
    }
    return { probabilities: res.probabilities, model: res.model, heuristic: false };
  };
}

// ---------- the code-side stand-in ----------

// Phrasings that only exist to sell something, phrasings that usually introduce
// a read, and — from the upstream criteria — the things that are not sponsors.
const HEURISTIC = {
  // Phrases that only ever introduce or close a paid read.
  hard:
    /(this (video|episode|show|stream|segment|portion|part)( of the video)? is (sponsored|brought to you|presented) by|sponsored by|brought to you by|sponsor of (this|today'?s) (video|episode)|thank(s| you) to [\w\s'&.-]{2,40} for sponsoring|sponsoring (this|today'?s) (video|episode)|link (is )?in the (description|bio|show notes)|use (my|our|the) code|\bcode [A-Z0-9]{1,11}\d[A-Z0-9]{0,4}\b|head to [\w-]+ ?(dot|\.) ?(com|io|net|co|org|gg)|go to [\w-]+ ?(dot|\.) ?(com|io|net|co|org|gg)|sign ?up (today|now|with)|first \d{1,3} (people|users|subscribers|listeners))/i,
  // Marketing-shaped phrases: a hint of a read, not proof of one.
  soft:
    /(before we (get started|begin|dive in|jump in)|quick (word|break|message|note)|let me tell you about|we'?re back|now,? back to|support(ed)? (for|by)|our partners?|a word from|(our|the|their) sponsor\b|promo ?code|discount code|coupon|(ten|fifteen|twenty|twenty-five|thirty|forty|fifty) percent off|\d{1,2}% off|save \d{1,2}%|free (trial|month|shipping|version))/i,
  // Spelled out in the criteria: these are not sponsor reads.
  notSponsor:
    /(like and subscribe|hit the (bell|like)|leave a (comment|like)|comment below|subscribe to (my|the)? ?channel|patreon|join this channel|merch (store|shop|link|line)|membership)/i,
};

const NOT_SPONSOR_SCORE = 0.07;
// A neighbour that looks like a read is a hint at a discount — a read is a run of
// lines, and the pitch lines in the middle name nothing — but the line's own
// words always win, so a subscribe line never gets pulled into a read.
const CONTEXT_WEIGHT = 0.8;

function scoreText(text) {
  const t = String(text || "");
  if (!t.trim()) return 0.1;
  if (HEURISTIC.hard.test(t)) return HEURISTIC.notSponsor.test(t) ? 0.85 : 0.9;
  if (HEURISTIC.notSponsor.test(t)) return NOT_SPONSOR_SCORE;
  return HEURISTIC.soft.test(t) ? 0.6 : 0.1;
}

/**
 * Score lines from their own words, plus their neighbours at a discount.
 *
 * Deliberately simple, visible and batch-independent: the answer for a line never
 * depends on how many other lines travelled in the same local call. This only
 * exists so the extension is useful before the checkpoint is installed, and it is
 * always labelled `heuristic` wherever a verdict is shown.
 */
export function heuristicProbabilities(cards) {
  return cards.map((card) => {
    const own = scoreText(card?.text);
    if (own === NOT_SPONSOR_SCORE) return own; // spelled out as not a sponsor: no hint overrides that
    const around = scoreText(`${card?.before || ""} ${card?.after || ""}`);
    return clamp(Number(Math.max(own, around * CONTEXT_WEIGHT).toFixed(3)), 0.01, 0.98);
  });
}

// ---------- passes ----------

/**
 * Ask one question kind about a list of line indices, batched so each local call
 * stays inside the checkpoint's context. Returns Map(index -> probability).
 */
export async function judgeIndices(judge, lines, indices, kind, { log = () => {}, settings = {} } = {}) {
  const { batchSize, threshold, cutThreshold } = { ...DEFAULTS, ...settings };
  const floor = kind === "inside" ? threshold : cutThreshold;
  const out = new Map();
  for (let i = 0; i < indices.length; i += batchSize) {
    const slice = indices.slice(i, i + batchSize);
    const cards = slice.map((index) => lineCard(lines, index));
    const t0 = Date.now();
    const res = await judge({ cards, questions: questionsFor(kind, cards.length) });
    res.probabilities.forEach((p, k) => {
      out.set(slice[k], p);
      log({
        kind, line: lines[slice[k]].index, at: msToLabel(lines[slice[k]].startMs), text: cut(lines[slice[k]].text, 70),
        p, verdict: p >= floor ? "yes" : "no", model: res.model, heuristic: res.heuristic, ms: Date.now() - t0,
      });
    });
  }
  return out;
}

function flagsFromRuns(lines, sampled, threshold) {
  const sampledIndices = [...sampled.keys()].sort((a, b) => a - b);
  const flags = lines.map(() => false);
  for (let i = 0; i < lines.length; i++) {
    let nearest = null;
    for (const idx of sampledIndices) {
      if (nearest === null || Math.abs(idx - i) < Math.abs(nearest - i)) nearest = idx;
    }
    flags[i] = nearest !== null && sampled.get(nearest) >= threshold;
  }
  return flags;
}

/**
 * Turn one candidate run into a read with code-owned boundaries.
 *
 * The edges are asked about explicitly ("is this the first line?", "is the read
 * over here?"), then the lead-in is walked back line by line, because the part
 * before the sponsor's name is still a read. Returns null when the read fails a
 * code-owned filter — too short to bother, or too long to skip without risking
 * the video's own content.
 */
export async function refineCandidate({ lines, run, judge, settings = {}, log = () => {} }) {
  const opts = { ...DEFAULTS, ...settings };
  const startCandidates = [];
  for (let i = Math.max(0, run.from - 2); i <= Math.min(lines.length - 1, run.from + 1); i++) startCandidates.push(i);
  const endCandidates = [];
  for (let i = Math.max(0, run.to - 1); i <= Math.min(lines.length - 1, run.to + 2); i++) endCandidates.push(i);

  const startProbs = await judgeIndices(judge, lines, startCandidates, "start", { log, settings: opts });
  const insideEdges = await judgeIndices(judge, lines, endCandidates, "inside", { log, settings: opts });

  const confidentStarts = startCandidates.filter((i) => (startProbs.get(i) ?? 0) >= opts.cutThreshold);
  let startIdx = confidentStarts.length ? Math.min(...confidentStarts) : run.from;

  const insideAtEdge = endCandidates.filter((i) => (insideEdges.get(i) ?? 0) >= opts.threshold);
  const endIdx = (insideAtEdge.length ? Math.max(...insideAtEdge) : run.to) + 1; // first line that is content again

  // When in doubt, stop at the first line that reads as content again rather than
  // cut further: landing a second inside the read costs a second of the read,
  // landing past it costs the video's own content. So the "is the read over
  // here?" answer is logged, not acted on — in live mode the open read is what
  // continues the jump if the read turns out to run longer.
  const endAsk = Math.min(endIdx, lines.length - 1);
  const endProbs = await judgeIndices(judge, lines, [endAsk], "end", { log, settings: opts });
  const endCertainty = endProbs.get(endAsk) ?? 0;
  if (endCertainty < opts.cutThreshold) {
    log({
      kind: "end-unclear", line: lines[endAsk].index, at: msToLabel(lines[endAsk].startMs), p: endCertainty,
      verdict: "end not confirmed — may stop a line early",
    });
  }

  // Trace back to the lead-in: a read starts where the story that exists only to
  // arrive at the sponsor starts.
  let back = 0;
  while (back < opts.leadinLines && startIdx > 0) {
    const range = [];
    for (let i = Math.max(0, startIdx - 2); i < startIdx; i++) range.push(i);
    if (!range.length) break;
    const leadProbs = await judgeIndices(judge, lines, range, "leadin", { log, settings: opts });
    const confident = range.filter((i) => (leadProbs.get(i) ?? 0) >= opts.cutThreshold);
    if (!confident.length) break;
    startIdx = Math.min(...confident);
    back += range.length;
  }

  const startMs = lines[startIdx].startMs;
  const lastLine = lines[Math.min(endIdx, lines.length) - 1];
  const endMs = endIdx < lines.length ? lines[endIdx].startMs : lastLine.endMs;
  const durationMs = endMs - startMs;
  const confidence = Math.min(
    ...[...startProbs.values()].filter((p) => p >= opts.cutThreshold),
    ...[...insideEdges.values()].filter((p) => p >= opts.threshold),
    1,
  );

  if (durationMs < opts.minReadMs) {
    log({ kind: "reject", line: lines[startIdx].index, at: msToLabel(startMs), verdict: "too short", ms: Math.round(durationMs) });
    return null;
  }
  if (durationMs > opts.maxReadMs) {
    log({ kind: "reject", line: lines[startIdx].index, at: msToLabel(startMs), verdict: "too long to skip safely", ms: Math.round(durationMs) });
    return null;
  }
  return {
    startMs,
    endMs,
    startLine: lines[startIdx].index,
    endLine: lastLine.index,
    durationMs,
    confidence,
    source: "transcript",
  };
}

/**
 * Find the sponsor reads of a transcript.
 * Returns { reads, log, model, judged, heuristic }.
 *   reads: [{ startMs, endMs, startLine, endLine, confidence, source }]
 */
export async function detectSponsors({ video, lines, judge, settings = {}, log = () => {}, onProgress = () => {} }) {
  const opts = { ...DEFAULTS, ...settings };
  const entries = [];
  const say = (entry) => {
    entries.push(entry);
    log(entry);
  };

  if (!Array.isArray(lines) || lines.length < 2) {
    return { reads: [], log: entries, model: null, judged: 0, heuristic: false };
  }
  lines = indexLines(lines); // saved transcripts may arrive without their indices

  // Pass 1 — sample the transcript and ask where the reads are.
  const indices = [];
  for (let i = 0; i < lines.length; i += opts.stride) indices.push(i);
  if (indices[indices.length - 1] !== lines.length - 1) indices.push(lines.length - 1);

  onProgress({ phase: "scan", done: 0, total: indices.length });
  const sampled = await judgeIndices(judge, lines, indices, "inside", { log: say, settings: opts });
  onProgress({ phase: "scan", done: indices.length, total: indices.length });

  const flags = flagsFromRuns(lines, sampled, opts.threshold);
  const lineMs = medianLineMs(lines);
  const minRun = Math.max(2, Math.min(4, Math.round(opts.minReadMs / lineMs)));
  let runs = groupRuns(flags, { minRun });

  // Pass 2 — walk the edges of the most likely runs.
  const scored = runs
    .map((run) => {
      let best = 0;
      for (let i = run.from; i <= run.to; i++) {
        const p = sampled.get(i);
        if (p != null) best = Math.max(best, p);
      }
      return { run, score: best };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.maxReads)
    .map((s) => s.run);

  const reads = [];
  for (const run of scored) {
    const read = await refineCandidate({ lines, run, judge, settings: opts, log: say });
    if (read) reads.push(read);
  }

  reads.sort((a, b) => a.startMs - b.startMs);
  const merged = [];
  for (const read of reads) {
    const last = merged[merged.length - 1];
    if (last && read.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, read.endMs);
      last.endLine = Math.max(last.endLine, read.endLine);
      last.durationMs = last.endMs - last.startMs;
      last.confidence = Math.max(last.confidence, read.confidence);
    } else {
      merged.push({ ...read });
    }
  }

  const model = [...entries].reverse().find((e) => e.model)?.model ?? null;
  return { reads: merged, log: entries, model, judged: indices.length, heuristic: model ? isHeuristic(model) : false };
}
