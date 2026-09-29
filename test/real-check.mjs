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
// A judge that fails mid-run is a hard failure: `makeJudge` falls back to the
// code heuristic, and a fallback silently scored as a model result would be
// worse than a red run.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { indexLines, msToLabel } from "../src/transcript.js";
import { detectSponsors, heuristicProbabilities, makeJudge } from "../src/sponsor.js";
import { checkServer, judgeBatch } from "../src/laya.js";

const DEFAULT_ENDPOINT = "http://127.0.0.1:8765/judge";
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

let model = "unknown";
let strict = true; // a real model is judged hard: any miss or FP fails the run
if (fake) {
  model = "heuristic (--fake)";
  strict = false;
} else {
  try {
    const health = await checkServer({ endpoint: endpoint.replace(/\/judge\/?$/, "/health") });
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
const fallbacks = [];

for (const file of files) {
  const fixtureJson = JSON.parse(readFileSync(join(realDir, file), "utf8"));
  const fixture = { ...fixtureJson, lines: indexLines(fixtureJson.lines) };
  const truth = fixture.sponsorblock ?? [];

  const result = await detectSponsors({ video: fixture.video, lines: fixture.lines, judge: judgeFor(fixture.video), log: (e) => log.push(e) });

  // A judge that quietly fell back to the code heuristic would make this run
  // measure the wrong thing, so it is a hard failure, not a footnote. In
  // `--fake` mode the heuristic IS the judge, so its own entries are expected.
  const fell = fake ? [] : result.log.filter((e) => e.kind === "judge-error" || e.kind === "judge-heuristic");
  if (fell.length) {
    fallbacks.push({ file, entry: fell[0], count: fell.length });
    hardFailures++;
  }

  // Best 1:1 match per reported read by overlap; a read matching nothing counts
  // as a false positive, a segment matching nothing as a miss.
  const matches = [];
  const usedSegs = new Set();
  for (const read of result.reads) {
    let best = null;
    for (const seg of truth) {
      if (usedSegs.has(seg)) continue;
      const overlap = Math.max(0, Math.min(read.endMs, seg.endMs) - Math.max(read.startMs, seg.startMs));
      if (overlap > 0 && (!best || overlap > best.overlap)) best = { seg, overlap };
    }
    if (best) {
      usedSegs.add(best.seg);
      matches.push({ read, seg: best.seg });
    } else {
      matches.push({ read, seg: null });
    }
  }

  const hits = matches.filter((m) => m.seg);
  const missed = truth.filter((s) => !usedSegs.has(s));
  const fps = matches.filter((m) => !m.seg);
  const perVideo = { hits: hits.length, missed: missed.length, falsePositives: fps.length };

  // With the real checkpoint loaded (strict), every miss and every FP fails the
  // run. With the heuristic answering, misses of segments that DO have words to
  // judge are still counted, but they exit-fail only in strict mode: the phrase
  // dictionary is a documented limit of the stand-in, and the README says so.
  if (fps.length || (strict && missed.length)) hardFailures++;

  rows.push({ fixture, truth, result, perVideo, matches, missed, fps });
  console.log(`\n=== ${fixture.video.videoId} — ${fixture.video.title}`);
  console.log(`    ${fixture.lines.length} lines (${fixture.track?.kind ?? "?"} captions), ${msToLabel(fixture.video.durationMs)} long, ${truth.length} SponsorBlock segment(s)`);
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

console.log(`\nmodel: ${model} | local calls: ${calls} | questions: ${questions}`);
if (fallbacks.length) {
  console.log(`⚠️  ${fallbacks.length} video(s) were answered by the code heuristic, not the judge:`);
  for (const f of fallbacks) {
    console.log(`   ${f.file}: ${f.entry.kind} — ${f.entry.message ?? f.entry.model} (${f.count} call(s))`);
  }
} else if (calls === 0) {
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
