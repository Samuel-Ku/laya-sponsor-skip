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
**Open run** — the run at the tail of the transcript that has not settled: fewer than
three quiet *judged* lines after it, so the speaker may still be inside it. A closed
run's end is known; an open one's is not, and only the live path ever sees one.

## The detector

**Detector** — `createDetector({ judge, settings, log })` in `src/detector.js`: it
holds the verdict for every line it has been shown, how far into the transcript it
has judged, and the shape rules. Its interface is `observe(lines)` →
`{ closed, open, newest, judged }`, `refine(run)` → a read or `null`, and `reset()`.
**Judged** — a line the detector has a verdict for. A line without one is `null`, not
`false`: nobody has asked about it, which is why it cannot be bridged across.
**Newest verdict** — the verdict on the last line judged, which is what "am I hearing
a read right now" is asked with when the loop decides whether to step forward.

## The two ways in

**Live path** — captions are read as they are spoken (`src/content.js`), lines are
judged as they appear, and reads are refined and stepped over while the video plays.
This is the path that does the skipping: it calls `observe()` on every tick and never
sees a run before it exists.
**Batch path** — the same detector over a whole transcript at once: the panel's
**Analyze captured** and **Paste transcript** buttons, the eval, the tests
(`detectSponsors()`). It can rank the runs by how sure the judge was before refining
them, which the live path cannot, because the live path meets a run before it knows
what comes after it. The eval fails if the live path loses a labelled read the batch
path found.

## Comparing with SponsorBlock

**Comparison** — `compareReads(mine, theirs)` in `src/sponsorblock.js`, the only
place that decides whether a read "matches" a community segment. Returns the
three-way split both callers report: matched, ours alone, theirs alone.
**Containment** — the watch page's rule: a read caught a segment when it covers it
with 5 s of slack at each edge. Nothing exclusive — one read may cover two
segments, two reads may cover one.
**Pairing** — the eval's rule (`pairReads`): each read takes the segment it shares
the most time with, each segment at most once. A read paired with nothing is a
false positive; a segment nobody paired with is a miss. Stricter than containment
exactly where one read spans two segments.

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
