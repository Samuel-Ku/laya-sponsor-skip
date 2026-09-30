# training/ — the minimal fine-tune dataset for the judge

Built by `node scripts/build-sponsor-dataset.mjs` from the labelled fixtures — the
same question/label pairs the pipeline already asks, in the exact shape one judge
call consumes (`{ card, question, page }`, `question.type === "noul"`).

## What a record is

```json
{
  "split": "train",            // train | val (split by whole fixtures)
  "videoId": "CLkMCNkwCjI",
  "task": "inside",            // inside | start — the detector's per-line questions
  "label": 0,                  // hard 0/1 for metrics
  "p_target": 0,               // soft target: 1, 0.6 (±1-line boundary slack), or 0
  "card":   { "line": "L042", "at": "3:48", "text": "…", "before": "…", "after": "…" },
  "question": { "type": "noul", "instructions": "…", "criteria": { "true": "…", "false": "…" } },
  "page":    { "host": "youtube.com", "title": "…", "channel": "…", "videoId": "…", "duration": "9:04" },
  "meta":    { "segment": { "startMs": 161948, "endMs": 249086, "category": "sponsor" } }
}
```

## Labels

- **Real videos** — SponsorBlock `sponsor` segments (the eval's ground truth).
  `inside` = the line's midpoint falls inside a segment. `start` = distance to the
  nearest segment's first line, ±1 line of slack as `p_target` 1 / 0.6 / 0.
- **Demo fixture** — the hand-labelled `expected.reads`, same rules.

## Splits and sizes (as built)

| | records | inside yes/no | start yes/no |
| --- | --- | --- | --- |
| **train** (`CLkMCNkwCjI`, `brqtaTjBkB0`, `JwAfHEHQKto`, `rS7scGrFsRo`, demo) | 1738 | 40 / 829 | 4 / 865 |
| **val** (`cBpGq-vDr2Y`, `aircAruvnKk`) | 1290 | 18 / 627 | 1 / 644 |

The imbalance is the task's real shape — a read is minutes out of an hour — and the
val split deliberately holds out the two hard shapes: MKBHD's unnamed-ad read and
3b1b's wordless outro. Rebuild after changing fixtures or questions; the JSONL is
derived data and stays out of git.

## Using it

```bash
node scripts/build-sponsor-dataset.mjs            # rebuild training/train.jsonl + val.jsonl
node scripts/build-sponsor-dataset.mjs --probe 6  # + send 6 records per split to the judge (LAYA_ENDPOINT or :8766)
```

The honest target to measure a fine-tune against is the README's real-videos table:
the code stand-in holds **2/4 with 0 false positives**; the current checkpoint scores
**0/4 with 9** (mechanism and dead ends: `EXPERIMENTS.md`). Train on `train.jsonl`,
watch val loss on the `inside` task, then judge the eval — `npm run real-check` with
the fine-tuned checkpoint serving — not the dataset itself.
