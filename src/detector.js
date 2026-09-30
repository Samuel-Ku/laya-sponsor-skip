// Where a read *is*: the one module that turns "is this line inside a sponsor
// read?" into reads with code-owned boundaries.
//
// Both ways into the pipeline cross this interface — the live loop that judges
// each line as it is spoken, and the batch pass behind the Analyze button —
// because a rule that only one of them applies is a rule the other one silently
// does without. The bridge below is exactly that kind of rule: it was added to the
// batch pass to recover a read whose middle names nothing, and the live loop,
// which is the one that actually skips, did not have it.
//
// The interface is three calls:
//
//   const detector = createDetector({ judge, settings, log });
//   const { closed, open, newest, judged } = await detector.observe(lines);
//   const read = await detector.refine(run);     // or null, if it fails a filter
//   detector.reset();                            // another video
//
// Everything else — the verdict for each line, how far the transcript has been
// judged, the bridge, the edge walk, the duration filters — is implementation.
// The caller owns the player and the panel: whether an open run is refined and
// whether the video should be stepped past belong to the loop, not here.

import { groupRuns, indexLines, medianLineMs, msToLabel } from "./transcript.js";
import { lineCard, questionsFor } from "./sponsor.js";
import { isHeuristic } from "./laya.js";

/** The knobs, all code-owned. The judge is never asked about any of them. */
export const DEFAULTS = {
  threshold: 0.7, // a line counts as inside a read above this
  cutThreshold: 0.8, // a boundary is only cut above this (upstream's phrase rule)
  minReadMs: 20000, // shorter than this is not worth a skip
  maxReadMs: 180000, // longer than this is not skipped at all
  maxReads: 6,
  stepMs: 10000, // live mode: jump size while a read is still being heard
  batchSize: 6, // questions per local call — checkpoints are 512/1024 tokens
  leadinLines: 15, // how far back the lead-in may reach
};

/**
 * The same numbers in the units the user-facing surfaces live in — seconds, as
 * the popup and the per-video settings store spell them — derived from
 * `DEFAULTS` above, never re-declared: the detector's millisecond constants are
 * the one definition, this is their user-facing shadow. Change a number up
 * there and the popup's defaults follow; a test pins the derivation.
 */
export const SETTINGS_DEFAULTS = {
  threshold: DEFAULTS.threshold,
  cutThreshold: DEFAULTS.cutThreshold,
  minReadSeconds: DEFAULTS.minReadMs / 1000,
  maxReadSeconds: DEFAULTS.maxReadMs / 1000,
  maxReads: DEFAULTS.maxReads,
  stepSeconds: DEFAULTS.stepMs / 1000,
};

// ---------- the shape of a read ----------

// How much of a read's middle may name nothing at all. A sponsor read is a
// lead-in, a pitch and an offer, and the pitch's middle ("I've been using it for
// about three months now, it goes on your mattress") carries no sales phrase — in
// the real transcripts under test that quiet pocket runs to eight lines, which at
// 7.6 s a line is a minute. So the budget is a minute, converted through the
// transcript's own line length and capped: a rule of shape, not of sampling.
export const BRIDGE_MS = 60000;
export const BRIDGE_MAX_LINES = 12;
export const BRIDGE_MIN_LINES = 3;

/** The bridge budget in lines, for this transcript. */
function bridgeLinesFor(lines, { bridgeMs = BRIDGE_MS, maxLines = BRIDGE_MAX_LINES, minLines = BRIDGE_MIN_LINES } = {}) {
  const lineMs = Math.max(medianLineMs(lines), 1);
  return Math.max(minLines, Math.min(maxLines, Math.round(bridgeMs / lineMs)));
}

/**
 * Candidate runs: every stretch of yes-lines, with neighbouring stretches joined
 * across a middle that was judged and found quiet.
 *
 * `flags[i]` is what the caller knows about line `i`: `true`, `false`, or `null`
 * for a line nobody has judged yet — and the difference matters, because a read
 * may bridge a middle it has heard and found quiet, never one it has not heard.
 * Returns [{ from, to }] with inclusive 0-based indices, unfiltered by length.
 */
function deriveRuns(lines, flags) {
  const bridge = bridgeLinesFor(lines);
  const runs = groupRuns(flags.map((flag) => flag === true), { minRun: 1 });

  const merged = [];
  for (const run of runs) {
    const prev = merged[merged.length - 1];
    const gap = prev ? run.from - prev.to - 1 : 0;
    const middleHeardQuiet = prev ? flags.slice(prev.to + 1, run.from).every((flag) => flag === false) : false;
    if (prev && gap <= bridge && middleHeardQuiet) prev.to = run.to;
    else merged.push({ ...run });
  }
  return merged;
}

/** Drop runs too short to be worth refining, before the expensive edge walk. */
function longEnough(runs, minRun) {
  return runs.filter((run) => run.to - run.from + 1 >= minRun);
}

// ---------- asking ----------

/**
 * Ask one question kind about a list of line indices, batched so each local call
 * stays inside the checkpoint's context. Returns Map(index -> probability).
 */
async function judgeIndices(judge, lines, indices, kind, { log = () => {}, settings = {} } = {}) {
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
        kind, line: lines[slice[k]].index, at: msToLabel(lines[slice[k]].startMs),
        text: String(lines[slice[k]].text || "").replace(/\s+/g, " ").trim().slice(0, 70),
        p, verdict: p >= floor ? "yes" : "no", model: res.model, heuristic: res.heuristic, ms: Date.now() - t0,
      });
    });
  }
  return out;
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
async function refineRun({ lines, run, judge, settings = {}, log = () => {} }) {
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

// How many lines one call may judge. A tick must not sit on local calls while the
// captions run on, and the batch pass simply calls again until nothing is left.
export const MAX_NEW_LINES_PER_CALL = 40;


// How many quiet judged lines after a run mean the speaker has moved on.
const SETTLED_AFTER = 3;

/**
 * The detector. It holds the verdict for every line it has been shown, how far
 * into the transcript it has judged, and nothing else that outlives a video.
 */
export function createDetector({ judge, settings = {}, log = () => {} }) {
  const opts = { ...DEFAULTS, ...settings };
  const probabilities = new Map(); // line index -> P(inside a read)
  let lines = [];
  let judgedUpTo = 0;

  const verdicts = () =>
    lines.map((_, i) => {
      const p = probabilities.get(i);
      return p == null ? null : p >= opts.threshold;
    });

  const scoreOf = (run) => {
    let best = 0;
    for (let i = run.from; i <= run.to; i++) {
      const p = probabilities.get(i);
      if (p != null) best = Math.max(best, p);
    }
    return best;
  };

  async function judgeNewLines() {
    // Only the transcript's last line can still change after it was judged (it is
    // the one still being spoken into), so judging resumes there and never re-asks
    // about a line in the middle just because a batch happened to end on it.
    const from = Math.min(judgedUpTo, lines.length - 1);
    const upto = Math.min(lines.length - 1, from + MAX_NEW_LINES_PER_CALL - 1);
    const indices = [];
    for (let i = from; i <= upto; i++) indices.push(i);
    if (!indices.length) return;
    const probs = await judgeIndices(judge, lines, indices, "inside", { log, settings: opts });
    for (const [index, p] of probs) probabilities.set(index, p);
    judgedUpTo = Math.max(judgedUpTo, upto + 1);
  }

  return {
    /**
     * Judge whatever is new and say where the reads might be.
     *
     * `closed` are runs whose end is known (position order, each with the
     * strongest yes inside it as `score`); `open` is the tail run that has not
     * settled, so the speaker may still be inside it — the live loop decides what
     * to do about that. `newest` is the verdict on the last line judged, which is
     * what "am I still hearing a read" is asked with.
     */
    async observe(nextLines) {
      if (Array.isArray(nextLines)) lines = nextLines;
      if (lines.length > judgedUpTo - 1) await judgeNewLines();

      const scored = deriveRuns(lines, verdicts()).map((run) => ({ ...run, score: scoreOf(run) }));
      const tail = scored[scored.length - 1];
      const judgedTo = Math.min(judgedUpTo - 1, lines.length - 1);
      const open = tail && judgedTo - tail.to < SETTLED_AFTER ? tail : null;

      return {
        closed: open ? scored.slice(0, -1) : scored,
        open,
        newest: { index: judgedTo, p: judgedTo >= 0 ? (probabilities.get(judgedTo) ?? 0) : 0 },
        judged: Math.min(judgedUpTo, lines.length),
      };
    },

    /** Walk one candidate's edges. Returns a read, or null if it fails a filter. */
    async refine(run) {
      if (!run) return null;
      return refineRun({ lines, run, judge, settings: opts, log });
    },

    /** Forget everything: another video, a re-analyze, a pasted transcript. */
    reset() {
      probabilities.clear();
      lines = [];
      judgedUpTo = 0;
    },
  };
}

/**
 * The batch case of the same interface: the whole transcript at once, with the
 * candidates ranked by how sure the judge was — which the live path cannot do,
 * because it meets a run before it knows what comes after it.
 *
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

  const detector = createDetector({ judge, settings: opts, log: say });
  let observed = await detector.observe(lines);
  onProgress({ phase: "scan", done: observed.judged, total: lines.length });
  while (observed.judged < lines.length) {
    observed = await detector.observe(lines); // the per-call cap, drained
    onProgress({ phase: "scan", done: observed.judged, total: lines.length });
  }

  const lineMs = medianLineMs(lines);
  const minRun = Math.max(2, Math.min(4, Math.round(opts.minReadMs / lineMs)));
  // The shape rule already ran inside the detector; this is the length gate before
  // the expensive edge walk, and refinement applies the duration filters after it.
  const ranked = longEnough([...observed.closed, observed.open].filter(Boolean), minRun)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.maxReads);

  const reads = [];
  for (const run of ranked) {
    const read = await detector.refine(run);
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
  return { reads: merged, log: entries, model, judged: lines.length, heuristic: model ? isHeuristic(model) : false };
}
