// Where a read *is*: the one place that turns per-line verdicts into candidate
// runs.
//
// Both ways into the pipeline cross this module — the live loop that judges each
// line as it is spoken, and the batch pass behind the Analyze button — because a
// rule that only one of them applies is a rule the other one silently does
// without. The bridge below is exactly that kind of rule: it was added to the
// batch pass to recover a read whose middle names nothing, and the live loop,
// which is the one that actually skips, did not have it.
//
// Nothing here talks to the judge. `flags[i]` is what the caller knows about line
// `i`: `true`, `false`, or `null` for a line nobody has judged yet — and the
// difference between `false` and `null` matters, because a read may bridge a
// middle it has heard and found quiet, never one it has not heard.

import { groupRuns, medianLineMs } from "./transcript.js";

// How much of a read's middle may name nothing at all. A sponsor read is a
// lead-in, a pitch and an offer, and the pitch's middle ("I've been using it for
// about three months now, it goes on your mattress") carries no sales phrase —
// in the real transcripts under test that quiet pocket runs to eight lines, which
// at 7.6 s a line is a minute. So the budget is a minute, converted through the
// transcript's own line length and capped, and it is a rule of shape rather than
// a sampling artifact: the pockets are there whether the lines were judged
// densely or every other one.
export const BRIDGE_MS = 60000;
export const BRIDGE_MAX_LINES = 12;
export const BRIDGE_MIN_LINES = 3;

/** The bridge budget in lines, for this transcript. */
export function bridgeLinesFor(lines, { bridgeMs = BRIDGE_MS, maxLines = BRIDGE_MAX_LINES, minLines = BRIDGE_MIN_LINES } = {}) {
  const lineMs = Math.max(medianLineMs(lines), 1);
  return Math.max(minLines, Math.min(maxLines, Math.round(bridgeMs / lineMs)));
}

/**
 * Candidate runs: every stretch of yes-lines, with neighbouring stretches joined
 * across a middle that was judged and found quiet.
 *
 * Returns [{ from, to }] with inclusive 0-based indices, unfiltered by length:
 * how long a run has to be before it is worth a skip is a duration decision, and
 * it belongs to whoever owns the thresholds.
 */
export function deriveRuns(lines, flags, options = {}) {
  const bridge = bridgeLinesFor(lines, options);
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

/**
 * Drop runs too short to be worth a live skip, before the expensive edge walk.
 * `minRun` is in lines, because the caller knows its own line lengths; the
 * duration filters that decide a read's fate live with the refinement.
 */
export function longEnough(runs, minRun) {
  return runs.filter((run) => run.to - run.from + 1 >= minRun);
}
