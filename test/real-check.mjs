// Run the sponsor-read pipeline on real transcripts and score it against the
// SponsorBlock community segments that ship inside each fixture.
//
//   npm run real-check                    # against the running judge on 8765
//   node test/real-check.mjs --fake       # no server: the code heuristic answers
//   LAYA_ENDPOINT=http://127.0.0.1:8766/judge npm run real-check
//
// The judge is whatever the local server reports — with the heuristic
// stand-in, this measures the code heuristic; with the checkpoint loaded, the
// model. Per video the check reports precision/recall-style agreement with the
// community labels and, for the controls, that nothing was reported at all.
//
// It drives the LIVE path — lines judged as they arrive, the detector deciding
// which runs are reads — because that is the path that does the skipping. The
// batch pass behind the Analyze button runs the same detector, and the two are
// compared at the end: a rule that lives in only one of them is the bug this
// comparison exists to catch.
//
// A judge that fails mid-run is a hard failure: `makeJudge` falls back to the
// code heuristic, and a fallback silently scored as a model result would be
// worse than a red run.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { indexLines, msToLabel } from "../src/transcript.js";
import { createDetector, DEFAULTS, detectSponsors } from "../src/detector.js";
import { heuristicProbabilities, makeJudge } from "../src/sponsor.js";
import { pairReads } from "../src/sponsorblock.js";
import { checkServer, healthUrlFor, judgeBatch, LAYA_ENDPOINT } from "../src/laya.js";

const DEFAULT_ENDPOINT = LAYA_ENDPOINT; // the address lives in laya.js
const endpoint = process.env.LAYA_ENDPOINT ?? DEFAULT_ENDPOINT;
const fake = process.argv.includes("--fake");

const realDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "real");
const files = readdirSync(realDir).filter((f) => f.endsWith(".json")).sort();

const log = [];
let calls = 0;
let questions = 0;

// One judge per video, so the checkpoint sees the real page metadata (title,
// channel, duration) instead of an anonymous transcript. `--fake` answers from
// the code heuristic, which is what CI and an offline machine can run.
const judgeFor = (video) =>
  fake
    ? async ({ cards }) => {
        calls++;
        questions += cards.length;
        return { probabilities: heuristicProbabilities(cards), model: "heuristic (--fake)", heuristic: true };
      }
    : makeJudge({
        video,
        transport: async ({ state, candidates, questions: batch }) => {
          calls++;
          questions += candidates.length;
          return judgeBatch({ state, candidates, questions: batch, endpoint });
        },
        log: (entry) => log.push(entry),
      });

/** Two ranges of seconds as the pipeline means it: half the shorter one is enough. */
const overlaps = (a, b) => {
  const shared = Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs);
  return shared > 0 && shared >= Math.min(a.endMs - a.startMs, b.endMs - b.startMs) * 0.5;
};

/**
 * Drive the pipeline the way the watch page does: captions arrive in order, and
 * the same detector the loop uses judges the new lines, decides which runs are
 * reads and walks their edges. The open run is left alone — the video is playing,
 * so its end is not known yet — and every rule the loop applies to a run it has
 * already seen is applied here too.
 */
async function driveLive({ lines, judge, settings = {}, log = () => {} }) {
  const opts = { ...DEFAULTS, ...settings };
  const detector = createDetector({ judge, settings: opts, log });
  const WINDOW = 8; // lines per tick, about what the caption loop sees in 20 s
  const attempted = new Set();
  const reads = [];

  for (let upto = 0; upto < lines.length; upto += WINDOW) {
    const seen = lines.slice(0, Math.min(upto + 1, lines.length));
    const { closed } = await detector.observe(seen);
    for (const run of closed) {
      if (reads.length >= opts.maxReads) break; // the code-owned cap applies here too
      const key = `${run.from}-${run.to}`;
      if (attempted.has(key)) continue; // already refined at these exact edges
      attempted.add(key);
      const asMs = { startMs: lines[run.from].startMs, endMs: lines[run.to].endMs };
      if (reads.some((read) => overlaps(read, asMs))) continue;
      const read = await detector.refine(run);
      if (read) reads.push(read);
    }
  }
  reads.sort((a, b) => a.startMs - b.startMs);
  return reads;
}

let model = "unknown";
let strict = true; // a real model is judged hard: any miss or FP fails the run
if (fake) {
  model = "heuristic (--fake)";
  strict = false;
} else {
  try {
    const health = await checkServer({ endpoint: healthUrlFor(endpoint) });
    model = health.model;
    strict = !/heuristic/i.test(String(model));
  } catch {
    model = "unreachable (offline heuristic answers)";
    strict = false;
  }
}

const rows = [];
let hardFailures = 0;
let missedJudgable = 0;
let liveCalls = 0;
let batchCalls = 0;
const fallbacks = [];
const divergences = [];

for (const file of files) {
  const fixtureJson = JSON.parse(readFileSync(join(realDir, file), "utf8"));
  const fixture = { ...fixtureJson, lines: indexLines(fixtureJson.lines) };
  const truth = fixture.sponsorblock ?? [];

  const judge = judgeFor(fixture.video);
  const beforeBatch = calls;
  const batch = await detectSponsors({ video: fixture.video, lines: fixture.lines, judge, log: (e) => log.push(e) });
  batchCalls += calls - beforeBatch;
  const beforeLive = calls;
  const reads = await driveLive({ lines: fixture.lines, judge, log: (e) => log.push(e) });
  liveCalls += calls - beforeLive;

  // A judge that quietly fell back to the code heuristic would make this run
  // measure the wrong thing, so it is a hard failure, not a footnote. In
  // `--fake` mode the heuristic IS the judge, so its own entries are expected.
  const fell = fake ? [] : batch.log.filter((e) => e.kind === "judge-error" || e.kind === "judge-heuristic");
  if (fell.length) {
    fallbacks.push({ file, entry: fell[0], count: fell.length });
    hardFailures++;
  }

  // The live path is what gets scored. Where the two paths differ is not a failure
  // by itself — the batch ranks every run by confidence and takes the top ones,
  // while the live path takes reads as they arrive and the cap can stop it early —
  // but the live path may not know LESS: a labelled read the batch pass found and
  // the live path misses is the bug this comparison exists to catch.
  // The scoring rule — one read to one segment, by the time they share — lives in
  // src/sponsorblock.js, next to the containment rule the watch page's Compare
  // button uses: the two callers of that module cannot drift apart.
  const { pairs, matched } = pairReads(reads, truth);
  const batchOnTruth = pairReads(batch.reads, truth).matched;
  const lostToLive = truth.filter((seg) => batchOnTruth.has(seg) && !matched.has(seg));
  if (lostToLive.length) hardFailures++;
  const both = pairReads(batch.reads, reads);
  const onlyBatch = both.pairs.filter((p) => !p.seg).length;
  const onlyLive = reads.length - both.matched.size;
  if (onlyBatch || onlyLive) divergences.push({ file, onlyBatch, onlyLive });

  // Best 1:1 match per reported read by overlap; a read matching nothing counts
  // as a false positive, a segment matching nothing as a miss.
  const matches = pairs;
  const hits = matches.filter((m) => m.seg);
  const missed = truth.filter((s) => !matched.has(s));
  const fps = matches.filter((m) => !m.seg);
  const perVideo = { hits: hits.length, missed: missed.length, falsePositives: fps.length };

  // With the real checkpoint loaded (strict), every miss and every FP fails the
  // run. With the heuristic answering, misses of segments that DO have words to
  // judge are still counted, but they exit-fail only in strict mode: the phrase
  // dictionary is a documented limit of the stand-in, and the README says so.
  if (fps.length || (strict && missed.length)) hardFailures++;

  rows.push({ fixture, truth, perVideo, matches, missed, fps });
  console.log(`\n=== ${fixture.video.videoId} — ${fixture.video.title}`);
  console.log(`    ${fixture.lines.length} lines (${fixture.track?.kind ?? "?"} captions), ${msToLabel(fixture.video.durationMs)} long, ${truth.length} SponsorBlock segment(s)`);
  if (onlyBatch || onlyLive) {
    console.log(`    ℹ️  selection differs from the batch pass: ${onlyBatch} read(s) only there, ${onlyLive} only in the live path`);
  }
  for (const seg of lostToLive) {
    console.log(`    ‼️  the batch pass found ${msToLabel(seg.startMs)}–${msToLabel(seg.endMs)} but the live path did not`);
  }
  for (const m of matches) {
    if (!m.seg) {
      console.log(`    ❌ reported ${msToLabel(m.read.startMs)}–${msToLabel(m.read.endMs)} (P ${m.read.confidence.toFixed(2)}) where the community labels nothing`);
    } else {
      const dStart = (m.read.startMs - m.seg.startMs) / 1000;
      const dEnd = (m.read.endMs - m.seg.endMs) / 1000;
      const sign = (n) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}s`;
      console.log(`    ✅ ${msToLabel(m.seg.startMs)}–${msToLabel(m.seg.endMs)} -> read ${msToLabel(m.read.startMs)}–${msToLabel(m.read.endMs)} | start ${sign(dStart)}, end ${sign(dEnd)}, P ${m.read.confidence.toFixed(2)}`);
    }
  }
  for (const s of missed) {
    const covered = fixture.lines.some((l) => l.startMs < s.endMs && l.endMs > s.startMs);
    if (!covered) {
      console.log(`    ⚠️  skipped SponsorBlock segment ${msToLabel(s.startMs)}–${msToLabel(s.endMs)} — outside caption coverage (no words to judge)`);
    } else {
      console.log(`    ❌ missed SponsorBlock segment ${msToLabel(s.startMs)}–${msToLabel(s.endMs)}`);
      missedJudgable++;
    }
  }
}

console.log(`\nmodel: ${model} | local calls: ${liveCalls} live, ${batchCalls} batch | questions: ${questions}`);
if (fallbacks.length) {
  console.log(`⚠️  ${fallbacks.length} video(s) were answered by the code heuristic, not the judge:`);
  for (const f of fallbacks) {
    console.log(`   ${f.file}: ${f.entry.kind} — ${f.entry.message ?? f.entry.model} (${f.count} call(s))`);
  }
} else if (liveCalls === 0) {
  console.log("⚠️  the judge was never called — the numbers below are the code heuristic, not the model");
}
const totalHits = rows.reduce((a, r) => a + r.perVideo.hits, 0);
const totalTruth = rows.reduce((a, r) => a + r.truth.length, 0);
const totalFp = rows.reduce((a, r) => a + r.perVideo.falsePositives, 0);
console.log(`sponsor segments: ${totalHits}/${totalTruth} found, ${totalFp} false positive(s) across ${rows.length} video(s)`);
for (const r of rows) {
  const v = r.perVideo;
  console.log(`  ${r.fixture.video.videoId}: ${v.hits}/${r.truth.length} found, ${v.falsePositives} FP`);
}

if (divergences.length) {
  const total = divergences.reduce((a, d) => a + d.onlyBatch + d.onlyLive, 0);
  console.log(`note: on ${divergences.length} video(s) the batch selection differs from the live one (${total} read(s) in total) — both run the same detector, the batch just ranks runs by confidence first`);
}

const controls = rows.filter((r) => r.truth.length === 0);
if (controls.length) {
  const bad = controls.filter((r) => r.perVideo.falsePositives > 0);
  console.log(`controls: ${controls.length - bad.length}/${controls.length} clean`);
  if (bad.length) hardFailures++;
}

if (hardFailures || (strict && missedJudgable)) {
  console.log(`\n${Math.max(hardFailures, missedJudgable)} check(s) failed`);
  process.exit(1);
}
console.log(strict
  ? "\nstrict run: no misses and no false positives against the SponsorBlock labels"
  : `\nheuristic run: no false positives, controls clean; ${missedJudgable} miss(es) are the documented phrase-dictionary limit — the real model is judged strict`);
