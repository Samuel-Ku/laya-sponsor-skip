# Judge experiments — can the real checkpoint beat 0/4?

Recorded 2026-09-30. The question: the strict eval scores `aac6fef/laya-multilingual-mlx`
at **0/4 segments, 9 false positives** (see the README's real-videos table), while the
code heuristic holds **2/4 with 0**. Is that the question's wording, the pipeline's
batching, or the checkpoint? Short answer: the checkpoint — but the experiments below
found *how* it fails, and that is worth more than the number.

Setup: the judge served locally on `127.0.0.1:8766` (mps, ~2.3 s per call), probes over
`CLkMCNkwCjI` (Surfshark read, SponsorBlock 2:42–4:09) and `brqtaTjBkB0` (Drop read,
6:16–6:54). Every probe ran the same `POST /judge` contract the pipeline uses, with the
real page metadata.

## What was tried

**Four question formulations over the same 28-line window** (current instruction +
current criteria; current instruction + short criteria; a rewritten "paid promotion in
this video's audio" phrasing; the checkpoint's own web-ad vocabulary):

- Shortening or rewriting the criteria changed *nothing useful* — the short-criteria
  variant returned **the same value (0.82) for every line in the window**, inside the
  read and outside it.
- The web-ad vocabulary moved values but not toward this task: it is a different
  question, not a better one (its 0.55–0.61 pocket after the read was luck, not
  separation; elsewhere it still put the whole read above the content).

**Batch composition** — the finding that explains everything else. The judge is
deterministic for a given request, but the answer for a line is a function of the
**batch it travels in**, not of the line:

| the same pitch line judged… | probability |
| --- | --- |
| alone (batch of 1) | 0.756 |
| with 2 other lines | 0.671 |
| in a window batch of 6 | 0.85 |
| in a mixed batch with 10 content lines | **0.194** |

A pure batch of read lines scores **0.83–0.96 while every content line in the same
window scheme scores 0.13–0.53 (0 of 12 above threshold)**; singles over the same
window separate too (inside median 0.82 vs outside 0.71), but noisily: individual
content lines reach 0.87, individual read lines fall to 0.34–0.40. Mixed batches —
which is what the real pipeline always sends — average everything toward the middle:
that is the flat 0.66–0.75 band the strict eval sees across whole transcripts.

**Through the real pipeline** (`detectSponsors`, the shipped detector): the batch pass
over `CLkMCNkwCjI` misses the Surfshark read and reports only the intro (0:00–0:24,
P 0.92). `batchSize: 1` — singles through the real detector — does not rescue it: 2
reads, both false (0:00–0:30, 7:10–9:06); the inside signal survives but the edge
questions, thresholds and refinement now interact with per-line noise, and the run
still does not form.

**Per-read shape** (`brqtaTjBkB0`, singles): the Drop read's body — an unnamed ad
narrated like B-roll copy — scores **0.34–0.66 line by line**; only the lead-in phrase
("a quick word from today's video sponsor") fires (0.86). A checkpoint whose yeses do
not cover a read's body cannot find these reads at any threshold.

## Conclusions

1. **The wording is not the lever.** Three rewrites of the question did not separate
   read from content; one moved all lines to a constant. The questions already encode
   the task; the checkpoint does not answer them differentially.
2. **The mechanism is batch-averaging.** Verdicts are computed in a way that mixes
   candidates within a request. Pure batches look brilliant (0.85 vs 0.13!), mixed
   batches look blind — and transcripts are always mixed. Any future work that depends
   on this judge must probe batch composition first; per-line truth does not exist for
   it.
3. **No cheap pipeline knob fixes it — and purity is not the missing ingredient.**
   `batchSize: 1` changes which mixture the model sees, not whether it separates; the
   full detector still returns 0/1 with fresh FPs. The decisive probe: grant every
   local call *oracle purity* — split each request into read/content sub-batches by
   the SponsorBlock ground truth, across every question kind the detector sends — and
   run the real batch pass on two fixtures. **The strict numbers do not move:**

   | fixture | base | oracle-pure | two-round (no oracle) |
   | --- | --- | --- | --- |
   | `CLkMCNkwCjI` (Surfshark 2:42–4:09) | 0/1, 1 FP (intro 0:00–0:24 P0.92) | **0/1, the same 1 FP** | 0/1, 0 FP |
   | `brqtaTjBkB0` (Drop 6:16–6:54) | 0/1, 0 FP | **0/1, 0 FP** | 0/1, **3 FP** (two at P1.00) |

   Two things follow. First, the lab effect (0.85 vs 0.13) does not survive contact
   with the detector: a run is assembled by the edge questions and the thresholds, and
   the *inside* signal — even granted perfect purity — is not what stops it. Second,
   the intro false read survives oracle purity with the identical P0.92: its confidence
   is minted in refinement, not in the inside calls, so no inside-side fix can remove
   it. Re-sorting a batch by its own first-round scores (the realizable "two-round"
   variant) is no better and sometimes worse. The remaining suspects are the edge
   questions' behaviour and the read body's inside signal on unnamed ads (0.34–0.66 at
   singles, above); both are checkpoint properties, not knobs.
4. **The 0/4 is the checkpoint, honestly measured.** What is missing is a model whose
   *inside* probability covers a read's body (the Drop read is the hard case: an ad
   with no sponsor name in it) and whose outside probability stays down *in mixed
   batches*. A fine-tune on spoken sponsor reads — even a few hundred labelled lines —
   would likely clear the heuristic's 2/4 bar; nothing less invasive did.

Probe scripts live in `/tmp/judge-experiments.mjs`, `/tmp/judge-batch-effect.mjs`,
`/tmp/judge-singles-sweep.mjs`, `/tmp/judge-singles-brqta.mjs`,
`/tmp/judge-batch6-sweep.mjs`, `/tmp/judge-batchsize1-clk.mjs`,
`/tmp/judge-pure-batches.mjs` (session-scratch; copy them here before rebooting if
they matter).
