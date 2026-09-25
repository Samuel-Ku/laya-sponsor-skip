# Contributing

Fun-size project, small rules.

## The one rule

**Code owns every timestamp, and the model only judges.**

Every second in this extension — where a read starts, where it ends, how far the
live jump goes — is computed in code from transcript lines that already carry
times. The model is asked only typed yes/no questions about a line that already
has one (*is this line inside a sponsor read?*, *is this the first line of one?*),
and it never writes a number. That split is why the whole pipeline can be tested
offline by swapping the judge for the code heuristic, and why a bad model answer
can cost a line but never corrupt the clock.

Practically:

- Thresholds, durations, limits live in code (`DEFAULTS` in `src/sponsor.js`) and
  stay configurable — they do not move into prompts.
- Prompt text may only describe *what counts* as a sponsor read; it may not ask
  the model to return times, indices, or counts.
- New behaviour should be expressible as more questions of the same shape, or as
  more code around the answers — not as free-form model output.
- The judge contract (`src/laya.js`) satisfies the server as it stands; the
  server in the sibling ad-blocker project is never modified from here.

If a change cannot fit inside that rule, say so in the PR description — it will
be discussed, not silently rejected.

## Where changes belong

| Change | File |
| --- | --- |
| Judge request/response, retry, health | `src/laya.js` |
| Cue merging, line numbering, parsers | `src/transcript.js` |
| Questions, run/boundary logic, pipeline, heuristic | `src/sponsor.js` |
| Caption capture, seek, player access | `src/youtube.js` |
| Panel UI, log, paste transcript | `src/panel.js` |
| Live loop, settings, auto-skip | `src/content.js` |

## Before you open a PR

```bash
npm run check                  # unit tests + full pipeline on the fixture (heuristic answers)
```

(The one command runs `npm test` and `node test/live-check.mjs --fake`; CI runs
the same thing.)

With the judge running (heuristic mode is fine): `npm run live-check` must stay
at 2/2 labelled reads with no false positives. For UI changes,
`npm run serve` → `test/harness.html` (panel) and `test/live-harness.html`
(the shipping content script on a fake player — its six checks must pass).

Keep PRs one idea each. If you touched `src/sponsor.js`, expect the first
question in review to be "which of these steps is code and which is the model?".

## Bug reports that get fixed fast

The panel's expandable log is the single most useful attachment: every question
with its probability and latency. A bug report that says "missed the read at
12:30" plus the log lines around 12:00–13:00 is usually fixable in one sitting.
