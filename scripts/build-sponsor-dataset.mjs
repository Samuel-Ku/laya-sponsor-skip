#!/usr/bin/env node
// Build the minimal fine-tune dataset for the judge, from the labelled fixtures.
//
//   node scripts/build-sponsor-dataset.mjs            # writes training/*.jsonl + prints stats
//   node scripts/build-sponsor-dataset.mjs --probe 5  # + sends 5 records per split to the judge on 8766
//
// Each record is exactly what one judge call consumes on this repo's seam — one
// candidate card (as `lineCard` renders it), one typed noul question (instructions +
// criteria, as `questionsFor` writes them), the same `page` the pipeline sends —
// plus the label and how it was derived:
//
//   {"split","videoId","task","label","p_target","card","question","page","meta"}
//
// Labels come from the fixtures' own ground truth: SponsorBlock segments for the
// real videos, the hand-labelled `expected.reads` for the demo fixture. `inside`
// labels are exact (the line's midpoint inside a segment). `start` labels carry a
// ±1-line slack band, expressed as p_target in [0, 1] rather than a hard 0/1, so a
// near-miss boundary line trains as a soft yes. Nothing here decides what the model
// is; it only records the question/label pairs the pipeline already asks.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { indexLines } from "../src/transcript.js";
import { lineCard, pageOf, questionsFor } from "../src/sponsor.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "training");
const probe = Number(process.argv[process.argv.indexOf("--probe") + 1] ?? 0) || 0;

const REAL = ["CLkMCNkwCjI", "brqtaTjBkB0", "cBpGq-vDr2Y", "aircAruvnKk", "JwAfHEHQKto", "rS7scGrFsRo"];
// Split by whole fixtures: no video contributes to both sides, so a transcript
// that shares its speaker and sponsor style cannot leak from train into val. The
// two holdouts are the hard shapes: MKBHD's unnamed-ad read and 3b1b's wordless outro.
const VAL_VIDEOS = new Set(["cBpGq-vDr2Y", "aircAruvnKk"]);
const boundaryTarget = (distance) => (distance === 0 ? 1 : distance === 1 ? 0.6 : 0);

const records = [];
const push = ({ videoId, page, lines, i, task, label, p_target, meta }) => {
  const [{ instructions, criteria }] = questionsFor(task, 1);
  records.push({
    split: VAL_VIDEOS.has(videoId) ? "val" : "train",
    videoId,
    task,
    label,
    p_target,
    card: lineCard(lines, i),
    question: { type: "noul", instructions, criteria },
    page,
    meta,
  });
};

// Real videos: SponsorBlock `sponsor` segments are the ground truth, the same way
// the eval scores them. A line is inside when its midpoint falls in a segment.
for (const id of REAL) {
  const fixtureJson = JSON.parse(readFileSync(join(root, `test/fixtures/real/${id}.json`), "utf8"));
  const lines = indexLines(fixtureJson.lines);
  const page = pageOf(fixtureJson.video);
  const segs = fixtureJson.sponsorblock ?? [];
  const mid = (l) => (l.startMs + l.endMs) / 2;
  const segAt = (l) => segs.find((s) => mid(l) >= s.startMs && mid(l) < s.endMs);
  const segFirst = segs.map((s) => lines.findIndex((l) => mid(l) >= s.startMs && mid(l) < s.endMs)).filter((k) => k >= 0);

  for (let i = 0; i < lines.length; i++) {
    const inside = !!segAt(lines[i]);
    const distStart = segFirst.length ? Math.min(...segFirst.map((k) => Math.abs(i - k))) : Infinity;
    push({ videoId: id, page, lines, i, task: "inside", label: inside ? 1 : 0, p_target: inside ? 1 : 0, meta: { segment: segAt(lines[i]) ?? null } });
    push({ videoId: id, page, lines, i, task: "start", label: distStart === 0 ? 1 : 0, p_target: boundaryTarget(distStart), meta: { distanceToSegmentStart: Number.isFinite(distStart) ? distStart : null } });
  }
}

// Demo fixture: two hand-labelled reads with their own names.
{
  const demo = JSON.parse(readFileSync(join(root, "test/fixtures/demo-transcript.json"), "utf8"));
  const lines = indexLines(demo.lines);
  const page = pageOf(demo.video);
  const reads = demo.expected.reads;
  const mid = (l) => (l.startMs + l.endMs) / 2;
  const readAt = (l) => reads.find((r) => mid(l) >= r.startMs && mid(l) < r.endMs);
  const readFirst = reads.map((r) => lines.findIndex((l) => mid(l) >= r.startMs && mid(l) < r.endMs)).filter((k) => k >= 0);
  for (let i = 0; i < lines.length; i++) {
    const inside = !!readAt(lines[i]);
    const distStart = readFirst.length ? Math.min(...readFirst.map((k) => Math.abs(i - k))) : Infinity;
    push({ videoId: "demo", page, lines, i, task: "inside", label: inside ? 1 : 0, p_target: inside ? 1 : 0, meta: { read: readAt(lines[i])?.label ?? null } });
    push({ videoId: "demo", page, lines, i, task: "start", label: distStart === 0 ? 1 : 0, p_target: boundaryTarget(distStart), meta: { distanceToReadStart: Number.isFinite(distStart) ? distStart : null } });
  }
}

mkdirSync(outDir, { recursive: true });
const write = (name, rows) => writeFileSync(join(outDir, name), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
const train = records.filter((r) => r.split === "train");
const val = records.filter((r) => r.split === "val");
write("train.jsonl", train);
write("val.jsonl", val);

const stats = (rows) => {
  const by = {};
  for (const r of rows) {
    by[r.task] ??= { yes: 0, no: 0 };
    by[r.task][r.label ? "yes" : "no"]++;
  }
  return by;
};
console.log(`train: ${train.length} records (videos: ${[...new Set(train.map((r) => r.videoId))].join(", ")})`);
console.log(JSON.stringify(stats(train), null, 2));
console.log(`val: ${val.length} records (videos: ${[...new Set(val.map((r) => r.videoId))].join(", ")})`);
console.log(JSON.stringify(stats(val), null, 2));

if (probe > 0) {
  const { judgeBatch } = await import("../src/laya.js");
  const ENDPOINT = process.env.LAYA_ENDPOINT ?? "http://127.0.0.1:8766/judge";
  for (const [name, rows] of [["train", train], ["val", val]]) {
    const slice = rows.slice(0, probe);
    console.log(`\nprobe ${name} (${slice.length} records -> ${ENDPOINT}):`);
    const r = await judgeBatch({
      state: { page: slice[0].page },
      candidates: slice.map((row) => row.card),
      questions: slice.map((row) => row.question),
      endpoint: ENDPOINT,
    });
    slice.forEach((row, i) =>
      console.log(`  judge ${r.probabilities[i].toFixed(2)} | p_target ${row.p_target} | label ${row.label}  [${row.task}] ${row.card.text.slice(0, 60)}`),
    );
  }
}
