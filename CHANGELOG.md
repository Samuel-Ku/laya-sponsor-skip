# Changelog

Notable changes. Versions are tagged `v*`; each tag's section below becomes the
GitHub Release notes automatically (`.github/workflows/release.yml`), so keep
one `## [ vX.Y.Z ] — title (date)` section per release.

## [Unreleased]

### Fixed

- **The live loop could not find the reads it was meant to skip.** A run is only
  long enough to skip once a lead-in pocket and an offer pocket are joined across
  the minute of pitch that names nothing, and that bridge lived in the batch pass
  only: on the six real fixtures the live path found **0 of 4** labelled segments
  while **Analyze captured** found 2. Both paths now derive their runs through
  `src/detector.js`, so the rule cannot be in one of them alone.
- Every line is judged, every other line no longer: sampling made the flag density
  — and therefore what the bridge had to be — depend on a `stride` setting. The
  same six videos score the same with every line judged, for about twice the local
  calls (255 rather than 133 for the batch pass).
- `maxReads` is now honoured by the live loop too, not only by the batch pass. The
  popup has claimed "at most 6 per video" since the first release.
- `pageOf(video)` threw when the caller had no page, which sent every verdict to
  the code heuristic while the run still reported the server's model name.

### Changed

- **One module owns read detection.** The verdict for every line, how far the
  transcript has been judged, the bridge, the edge walk and the duration filters all
  sit behind one interface in `src/detector.js` — `createDetector({ judge, settings })`
  with `observe(lines)`, `refine(run)` and `reset()` — and both paths cross it: the
  live loop as captions arrive, `detectSponsors()` over a whole transcript. The loop
  keeps what is its own: the player, the panel, and the decision to step over an open
  run. The duplicated verdict map and run grouping in `src/content.js` are gone, and
  so are the `refineCandidate`/`groupRuns` tests that measured internals. Driving the
  batch pass through the same interface costs it 12 more local calls across the six
  real videos (255 → 267, with the same 2990 questions and the same results).
- **One module owns the comparison with SponsorBlock.** `compareReads()` in
  `src/sponsorblock.js` returns the matched / ours-alone / theirs-alone split both
  callers want: the watch page's Compare button keeps the containment rule with 5 s
  of slack it always reported, and the eval scores through `pairReads()` — one read
  to one segment by the time they share — which it used to keep as a private copy.
  Same numbers on the six real videos as before (2/4, 0 false positives, controls
  clean); the rules just cannot drift apart any more.

- **One place owns the judge's address.** `LAYA_ENDPOINT` in `src/laya.js` is the only
  definition of `http://127.0.0.1:8765/judge` in the codebase; the service worker, the
  popup, both eval scripts and the harness pages import it, and `healthUrlFor()` derives
  the `/health` address the popup's Test button and the evals check. The popup's script is
  a module now so it can import the constant, and its input's placeholder is filled from
  it instead of a second copy in the HTML. `LAYA_ENDPOINT=...` still overrides it everywhere.

### Added

- **`npm run real-check`** — six real videos whose transcripts are the videos' own
  captions, scored against the `sponsor` segments SponsorBlock has for them, with two
  unlabelled videos kept as controls. It drives the live path and fails if the live
  path loses a labelled read the batch pass found. Results and method: README.

## [v0.1.0] — sponsor reads, skipped locally (2026-09-25)

First release. A Chrome extension (Manifest V3) that finds the sponsor reads
inside a YouTube video and jumps over them, with the semantic call made by a
small local model over `POST http://127.0.0.1:8765/judge`. No cloud, no key.

### Added

- **Caption capture** — reads the captions YouTube already renders in the page
  (turning them on if you let it) and merges cues into ~11-word numbered
  transcript lines. This sidesteps the timedtext pot-token wall entirely.
- **Sponsor-read pipeline** — one typed question per line to the local judge,
  runs grouped and edges refined with sharper questions, duration filters
  (reads shorter than 20 s dropped, longer than 3 min never skipped, at most 6
  per video). Code owns every timestamp; the model never writes a number.
- **Watch-page panel** — every read with range and confidence, Skip buttons,
  optional auto-skip (off by default), a log of every question with its
  probability and latency, **Paste transcript** for captionless videos, and
  **Compare with SponsorBlock**.
- **Honest fallback** — if the judge is down or running without the checkpoint,
  a phrase-based code heuristic answers, and every fallback verdict is labelled
  `heuristic` in the panel badge and log.

### Verified

- 20/20 unit tests; CI green on every push and PR.
- Full pipeline on the hand-labelled fixture: 2/2 reads found, starts within
  +7.0 s, ends within +7.0 s, no false positives.
- The shipping content script on a fake player passes all six live-path checks:
  no duplicate reads, no jump lands in content, no jump goes backwards.

### Install

1. Start the judge — the Laya server from the sibling ad-blocker project this
   was built next to (check it out as a folder named `laya-adblock`), or point
   the extension at any server answering the same `POST /judge` contract:
   ```bash
   cd laya-adblock
   npm run server                                    # with the MLX checkpoint
   # or: LAYA_HEURISTIC=1 python3 server/server.py   # no model, for trying it
   ```
2. Download **extension.zip** from this release and unzip it; then
   `chrome://extensions` → Developer mode → **Load unpacked** → the unzipped
   folder (or load the repo folder directly — there is no packed `.crx`, on
   purpose).
3. Extension icon → **Test** → expect `OK – model: …`.
4. Play a video with captions. The panel appears bottom-right; auto-skip is off
   by default, so nothing jumps until you press **Skip**.

### Limits

Captions only; the first seconds of a read are always heard in the live path;
ASR mangles brand names. The full list lives in the README.
