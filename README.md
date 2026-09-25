# Laya Sponsor Skip ⏭️

[![test](https://github.com/Samuel-Ku/laya-sponsor-skip/actions/workflows/test.yml/badge.svg)](https://github.com/Samuel-Ku/laya-sponsor-skip/actions/workflows/test.yml)

Releases are tagged `v*`; each tag's section in [CHANGELOG.md](CHANGELOG.md) becomes the GitHub Release notes automatically, after the same checks pass — and every release carries a ready-to-unzip `extension.zip`.

A Chrome extension (Manifest V3) that finds the sponsor reads inside a YouTube video
and jumps over them. The semantic call — "is this spoken line part of a paid read?"
— is made by the same local typed-decision model the ad blocker uses, over
`POST http://127.0.0.1:8765/judge`. Everything else is plain code.

> **This is a fun side project, not SponsorBlock.** It will miss reads, it will
> occasionally jump past something that was not a read, and it only works on videos
> that have captions. If you want a real, community-maintained skipper, install
> SponsorBlock. If you want to watch a tiny local model read a transcript out loud,
> read on.

**Local only: no key, no cloud.** The judge is the server from the Laya ad-blocker
project this was built next to (`server/server.py`, started there with `npm run server`).
Check it out as a sibling folder named `laya-adblock` — the commands below use that path —
or point the extension at any server that answers the same `POST /judge` contract.
The extension talks to it and to nothing else. The transcript comes from the
video's own captions, which YouTube already renders in the page — no speech-to-text
service is involved. This project does not touch that server: it satisfies its
contract as it stands.

## The idea, taken from upstream

[trungdq88/youtube-sponsor-detection](https://github.com/trungdq88/youtube-sponsor-detection)
does this with Jev and, in its audio modes, Deepgram. The design worth copying is the
split: **code owns every timestamp, and the model only ever answers a typed question
about a line that already has one.**

```
captions ──▶ cues ──▶ numbered lines (L042| …) ──▶ questions to the local model
                                    │                        │
                                    │                  probabilities
                                    ▼                        ▼
                            code decides the read ──▶ the jump (video.currentTime)
```

So the model never writes a number. It is asked things like *"is the line in
`candidates[3]` spoken inside a sponsor read?"*, *"is this the first line of one?"*,
*"does this line still belong to the same read as the lines after it?"*, and the code
turns those answers into seconds, refuses runs that are too short or too long, and
does the seeking.

## How it works

1. **Capture (code)** – `src/content.js` reads the caption YouTube is showing right
   now (`.ytp-caption-segment`) together with `video.currentTime`, every 250 ms. If
   captions are off it turns them on (a setting; the panel says when it did). Live
   captions mean no network, no pot-token hassle, and no speech API — but it also
   means we only know what has already been said.
2. **Lines (code)** – cues are merged into transcript lines of ~11 words, breaking on
   pauses and sentence ends, each with a stable `L042` name and a start/end time
   (`src/transcript.js`).
3. **Judge (local Laya)** – one `noul` question per line, batched so that a local call
   stays inside the checkpoint's 1024-token context (6 questions of ~150 tokens each).
   Every request carries `state.page` (video title, channel) and one self-contained
   `candidates[i]` card per line (text plus the lines on either side), because that is
   all the server forwards to the model.
4. **Runs and boundaries (code)** – lines above `P ≥ 0.70` are grouped into runs; the
   edges are asked about with the sharper questions, the lead-in is walked back line by
   line, and a boundary is only cut above `P ≥ 0.80` (upstream's phrase rule). Reads
   shorter than 20 s are dropped, reads longer than 3 minutes are **not** skipped at
   all, at most 6 per video.
5. **Act (code)** – a read is skipped by setting `video.currentTime` to the first line
   that reads as content again. While a read is still open, the video steps forward by
   10 s at a time as long as the newest line still reads as a read — the same trade the
   upstream audio mode makes, and the same trade is why the first seconds of a read are
   always heard. A jump never goes backwards: a read that is already behind the
   playhead by the time it is confirmed is marked "behind us" in the panel instead of
   being skipped, and the same read is never refined twice (ticks are 2.5 s apart,
   refinements take several local calls).
6. **Fallback (code)** – if the server is down, or is running its DOM-ad heuristic
   stand-in, the extension answers with a small phrase-based heuristic of its own
   (`sponsored by`, `use my code`, `link in the description`, `before we get started`),
   and labels every verdict `heuristic` in the panel badge and the log. It is worse
   than the model and it is honest about it.

When in doubt the jump stops at the first line that reads as content again: landing a
second inside a read costs a second of the read, landing past it costs the video's own
content.

## Install

1. Start the local judge (in the ad blocker's folder, which owns port 8765):
   ```bash
   cd ../laya-adblock
   npm run server                 # needs the checkpoint, see below
   # or: LAYA_HEURISTIC=1 python3 server/server.py   (no model, for testing)
   ```
2. Open `chrome://extensions`, turn on **Developer mode**.
3. **Load unpacked** → pick this folder.
4. Click the extension's icon, hit **Test** (it should say `OK – model: …`).
5. Play a video. The panel appears bottom-right with every read it has found; auto-skip
   is off by default, so nothing jumps until you press Skip or turn it on.

### The checkpoint

The real judgments need the model installed in the sibling ad-blocker project:

```bash
cd ../laya-adblock
pip install -r requirements.txt      # laya-mlx (Apple Silicon, MLX)
npm run server                       # without LAYA_HEURISTIC
```

Until then the server reports `heuristic`, and the extension uses its own code
heuristic (the panel badge says `model: heuristic`), so the whole flow can be tried
today.

## Popup options

| Option | Effect |
| --- | --- |
| On / off | Pause the content script |
| Local judge server | URL of the local server (default `http://127.0.0.1:8765/judge`) |
| Read threshold | `P` above which a line counts as inside a read (0.30–0.95, default 0.70) |
| Boundary cut | `P` needed to move the start or end of a read (default 0.80) |
| auto-skip | Jump without asking, while a read is being heard (off by default) |
| captions on | Let the extension turn the video's captions on; they are the transcript |
| toast | Corner toast after each skip |
| min read / max skip / read limit / jump | The code-owned limits: shortest read worth skipping (20 s), longest read it will ever skip (180 s), at most 6 reads, and the live jump size (10 s) |

The read threshold is the gate for the live step (keep jumping while I hear a read) and
the boundary cut is the gate for moving a read's own edges: jumping while already inside
a read can only overshoot by one step, while starting to jump too early eats content.

## Panel

The panel on the watch page lists every read with its range, its line span and the
confidence the decisions were cut at, a **Skip** button per read (while a read is open
the button becomes "Skip 10 s"), a **Compare with SponsorBlock** button that reports
how the local run lines up with the community labels, and an expandable log of **every
question** with its probability and latency, so you can see why it cut where it did.
**Paste transcript** analyzes a transcript from the clipboard — with or without
timings, straight from YouTube's own transcript panel — for videos without captions.

## Testing without installing

```bash
# 1) unit tests: transcript plumbing, questions, the heuristic, the pipeline
npm test

# 2) the full pipeline on the labelled fixture, against the running judge
npm run live-check
node test/live-check.mjs --fake       # no server at all: code heuristic answers

# 3) the panel and the pipeline in a browser, with a fake video and Skip buttons
npm run serve          # then: http://localhost:8788/test/harness.html

# 4) the live path: the real content script on a fake player (stubbed chrome API)
#                        http://localhost:8788/test/live-harness.html
```

`test/live-harness.html` is the closest thing to loading the extension without
Chrome: the caption capture loop, the judging loop, the panel and the seek are the
shipping ones, and only YouTube, the clock and the extension APIs are fake. It
found two real bugs while it was being written — one read being refined and
skipped several times over because ticks overlapped, and a backwards jump when a
read was confirmed after the video had already passed it — and it now checks that
reads are not duplicated, that no jump lands in content, that no jump ever goes
backwards, and that captions get turned on. Its replay is compressed (500 ms per
transcript line, so a 5:50 video in ~25 s), which is harsher than watching at 1x:
every pipeline latency is worth ~14 s of video there.

`test/fixtures/demo-transcript.json` is a hand-written 5:50 transcript with two
labelled sponsor reads, a subscribe/merch/Patreon block right after the first read
(those are spelled out as *not* sponsors), and a line about "promo codes, free trials,
links in the description" that the code heuristic is allowed to get wrong but must not
turn into a read. `live-check` fails if a labelled read is missed, if a read bleeds more
than 8 s into the content after it, or if anything that is not a read gets reported.

With the server in heuristic mode (no checkpoint), the fixture scores **2/2 reads,
start +7.0 s / +0.0 s, end +0.0 s / +7.0 s, 13 local calls, 48 questions, 46 ms**.
With the real multilingual checkpoint the boundaries should tighten: the heuristic
cannot answer the "is the read over here?" question at all, so its ends can be a
line late, and its starts stop one line early.

## What leaves your browser

Per batch, one request to `127.0.0.1` containing the video's title, channel and id
and, for each line under judgment, its text (220 characters), its `L###` name and the
lines on either side (70 characters). Nothing else, and nothing to the internet —
except the optional **Compare with SponsorBlock** button, which asks
`sponsor.ajay.app` for the community labels of the video you are watching.

## Limits

- **Captions only.** A video with no caption track has no transcript, so nothing is
  detected; use **Paste transcript** for those. Auto-generated captions work and are
  usually the only ones on sponsor-heavy channels.
- **The first seconds of a read are always heard** in the live path, because the read
  has to start before it can be recognised. Later jumps are exact.
- **The end can stop one line early** when the judge is the code heuristic, and one
  line late while a read is still open (the 10 s step in live mode).
- **ASR mangles brand names**, so the questions describe a read by its shape — lead-in,
  pitch, offer — rather than by the sponsor's name.
- **A whole read is skipped or none of it is.** A read longer than 3 minutes is not
  skipped at all: skipping that much of a video on a probability is not worth the risk.
- The transcript only grows as the video plays. Watching a 20-minute video from the
  start means ~200 lines and ~35 local calls for real judgments (about one second of
  local compute in total) — but a video you open in the middle starts with an empty
  transcript, and only catches up from wherever you are.
- Nothing in YouTube's DOM is removed or restyled; the extension reads captions and
  sets `video.currentTime`. The panel can be closed per video.

## Attribution

The pipeline follows [youtube-sponsor-detection](https://github.com/trungdq88/youtube-sponsor-detection)
(the "code owns every timestamp" split, the sponsor-segment criteria, the phrase-level
cut rule, the discovery that a sponsor read is lead-in + pitch + offer). Local inference
runs through the same `laya-mlx` port the ad blocker uses; see that project's `NOTICE`.

## Contributing

Good first targets: better handling of videos without captions, a mode that pre-fetches
the whole transcript instead of reading captions live, a "why did it cut there" view
over the saved logs, and more phrasings for the code heuristic. Keep the split intact:
rules and thresholds in code, only the semantic judgment goes to the model.

## License

MIT, see `LICENSE`.
