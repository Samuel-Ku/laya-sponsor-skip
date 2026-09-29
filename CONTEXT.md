# Context

The domain, in the words the code uses. Short on purpose: these are the terms a
change has to fit into, and the words a review of this repo should use.

## The transcript

**Cue** — one caption as YouTube rendered it: `{ startMs, endMs, text }`.
**Line** — a few cues merged into one readable stretch of speech (~11 words) with a
stable name (`L042`). The judge only ever sees lines, never cues.

## What is being found

**Read** — a sponsor read: paid promotion inside the video's own audio, in the shape
lead-in + pitch + offer. Code owns every second of a read; the judge only answers
typed questions about a line that already has a timestamp.
**Run** — a candidate: a stretch of lines that answered yes, before the edges have
been walked. A run is not a read — refinement may widen it, cut it down or reject it.
**Bridge** — the rule that lets a run span a middle that names nothing (a minute at
most, `BRIDGE_MS` in `src/detector.js`). A read's pitch often names nothing at all,
so without the bridge a lead-in pocket and an offer pocket stay two runs and neither
is long enough to be worth a skip.
**Heard quiet vs unjudged** — `false` is the judge saying "not a read" about a line;
`null` is nobody having asked. A bridge may cross the first, never the second.
**Open read** — the run at the tail of the transcript that has not settled: fewer
than three quiet *judged* lines after it, so the speaker may still be inside it.
Only the live path has one.

## The two ways in

**Live path** — captions are read as they are spoken (`src/content.js`), lines are
judged as they appear, and reads are refined and stepped over while the video plays.
This is the path that does the skipping.
**Batch path** — the same detector over a whole transcript at once: the panel's
**Analyze captured** and **Paste transcript** buttons, the eval, the tests
(`detectSponsors()`).
They cross the same seam — `deriveRuns()` in `src/detector.js` — and the eval fails
if the live path loses a labelled read the batch path found.

## The judge

**Judge** — whatever answers a typed `noul` question about one line card: "is this
line inside a sponsor read?", "is this the first line of one?", "does this line still
belong to the read after it?" In the extension it is the local server behind
`POST /judge` (`src/laya.js`); everywhere it is injected as `judge({ cards, questions })`.
**Code heuristic** — the stand-in that answers from a phrase dictionary when the
server is down or running without a checkpoint. It is what the tests and `--fake`
runs measure, and every verdict it gives is labelled `heuristic`.
**Panel** — the watch-page UI: the reads with their ranges, the log of every question
with its probability and latency, and the confidence the boundaries were cut at.
