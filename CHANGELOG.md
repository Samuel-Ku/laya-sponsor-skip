# Changelog

Notable changes. Versions are tagged `v*`; each tag's section below becomes the
GitHub Release notes automatically (`.github/workflows/release.yml`), so keep
one `## [ vX.Y.Z ] — title (date)` section per release.

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

### Limits

Captions only; the first seconds of a read are always heard in the live path;
ASR mangles brand names. The full list lives in the README.
