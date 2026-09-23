// Live check: run the whole pipeline on the labelled fixture transcript against
// the local judge server, and print what it found next to what is true.
//
//   npm run live-check                        # against http://127.0.0.1:8765/judge
//   LAYA_ENDPOINT=http://127.0.0.1:8766/judge npm run live-check
//   node test/live-check.mjs --fake           # no server at all: the code heuristic answers
//
// Exits 1 if a labelled read is missed, if a read bleeds too far into the content
// after it, or if something that is not a read gets reported. While the server runs
// in heuristic mode (no checkpoint installed), the code heuristic answers instead,
// so a green run proves the plumbing and the arithmetic — not the model.

import { readFileSync } from "node:fs";

import { indexLines, msToLabel } from "../src/transcript.js";
import { detectSponsors, heuristicProbabilities, makeJudge } from "../src/sponsor.js";
import { checkServer, judgeBatch } from "../src/laya.js";

const DEFAULT_ENDPOINT = "http://127.0.0.1:8765/judge";

const fixtureJson = JSON.parse(readFileSync(new URL("./fixtures/demo-transcript.json", import.meta.url), "utf8"));
const fixture = { ...fixtureJson, lines: indexLines(fixtureJson.lines) };
const expected = fixture.expected;
const fake = process.argv.includes("--fake");
const endpoint = process.env.LAYA_ENDPOINT ?? DEFAULT_ENDPOINT;

const log = [];
let calls = 0;
let questions = 0;

const judge = fake
  ? async ({ cards }) => {
      calls++;
      questions += cards.length;
      return { probabilities: heuristicProbabilities(cards), model: "heuristic (--fake)", heuristic: true };
    }
  : makeJudge({
      video: fixture.video,
      transport: async ({ state, candidates, questions: batch }) => {
        calls++;
        questions += candidates.length;
        return judgeBatch({ state, candidates, questions: batch, endpoint });
      },
      log: (entry) => log.push(entry),
    });

const fmt = (ms) => msToLabel(ms);

console.log(`fixture: ${fixture.lines.length} lines, ${fixture.video.durationMs / 1000}s, ${expected.reads.length} labelled read(s)`);
if (!fake) {
  try {
    const health = await checkServer({ endpoint: endpoint.replace(/\/judge\/?$/, "/health") });
    console.log(`server: ${health.model}`);
    if (/heuristic/.test(String(health.model))) {
      console.log("note: no checkpoint is loaded on that server, so the code heuristic answers (the panel says so too)");
    }
  } catch (err) {
    console.log(`server: unreachable (${err.message}) — the pipeline falls back to the code heuristic`);
  }
}

const t0 = Date.now();
const result = await detectSponsors({ video: fixture.video, lines: fixture.lines, judge, log: (entry) => log.push(entry) });
const elapsed = Date.now() - t0;

console.log(`\nmodel: ${result.model ?? "heuristic (offline)"} | local calls: ${calls} | questions: ${questions} | ${elapsed} ms`);
console.log(`questions by kind: ${countKinds(log)}`);

console.log(`\nfound ${result.reads.length} read(s):`);
for (const read of result.reads) {
  console.log(`  ${fmt(read.startMs)} – ${fmt(read.endMs)}  ${(read.durationMs / 1000).toFixed(0)}s  P ${read.confidence.toFixed(2)}  L${read.startLine}–L${read.endLine}`);
}
console.log(`\nlabelled ${expected.reads.length} read(s):`);
for (const read of expected.reads) {
  console.log(`  ${fmt(read.startMs)} – ${fmt(read.endMs)}  ${(read.endMs - read.startMs) / 1000}s  ${read.label}`);
}

let failures = 0;

for (const want of expected.reads) {
  const match = result.reads.find(
    (read) => Math.abs(read.startMs - want.startMs) <= expected.startToleranceMs && Math.abs(read.endMs - want.endMs) <= expected.endToleranceMs,
  );
  if (!match) {
    const near = nearest(result.reads, want.startMs);
    console.log(`❌ missed ${want.label}: ${near ? `nearest start ${fmt(near.startMs)} (${((near.startMs - want.startMs) / 1000).toFixed(1)}s off)` : "nothing found at all"}`);
    failures++;
    continue;
  }
  const startOff = (match.startMs - want.startMs) / 1000;
  const endOff = (match.endMs - want.endMs) / 1000;
  const sign = (n) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}s`;
  console.log(`✅ ${want.label}: start ${sign(startOff)} (limit ±${expected.startToleranceMs / 1000}s), end ${sign(endOff)} (limit ±${expected.endToleranceMs / 1000}s)`);
  if (match.endMs - want.endMs > expected.maxBleedMs) {
    console.log(`   ❌ bleeds ${((match.endMs - want.endMs) / 1000).toFixed(1)}s into the content after it (limit ${expected.maxBleedMs / 1000}s)`);
    failures++;
  }
}

for (const read of result.reads) {
  const overlaps = expected.reads.some((want) => read.startMs < want.endMs && read.endMs > want.startMs);
  if (!overlaps) {
    console.log(`❌ reported a read where there is none: ${fmt(read.startMs)} – ${fmt(read.endMs)} (P ${read.confidence.toFixed(2)})`);
    failures++;
  }
}

const answered = log.filter((entry) => typeof entry.p === "number");
const yes = answered.filter((entry) => entry.verdict === "yes").length;
console.log(`\n${answered.length} questions answered, ${yes} yes; ${log.filter((e) => e.kind === "reject").length} candidate(s) dropped by the duration filters`);

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");

function nearest(reads, startMs) {
  let best = null;
  for (const read of reads) if (!best || Math.abs(read.startMs - startMs) < Math.abs(best.startMs - startMs)) best = read;
  return best;
}

function countKinds(entries) {
  const kinds = {};
  for (const entry of entries) if (entry.kind) kinds[entry.kind] = (kinds[entry.kind] ?? 0) + 1;
  return Object.entries(kinds).map(([kind, n]) => `${kind}:${n}`).join(" ") || "none";
}
