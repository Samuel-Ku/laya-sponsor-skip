// Unit tests for the pure parts: transcript plumbing, question building, the
// code heuristic and the pipeline running against a stubbed judge.
//   npm test

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { formatLines, groupRuns, indexLines, labelToMs, lineLabel, mergeCues, msToLabel, parseJson3, parsePastedTranscript, parseVtt } from "../src/transcript.js";
import { CRITERIA, DEFAULTS, detectSponsors, heuristicProbabilities, lineCard, pageOf, questionsFor, refineCandidate } from "../src/sponsor.js";
import { MAX_CANDIDATES_PER_REQUEST, buildRequest, isHeuristic, parseResponse } from "../src/laya.js";

const fixtureJson = JSON.parse(readFileSync(new URL("./fixtures/demo-transcript.json", import.meta.url), "utf8"));
const fixture = { ...fixtureJson, lines: indexLines(fixtureJson.lines) };

/** A judge that answers exactly like the stubbed local server would. */
const stubJudge = (probsFor) => async ({ cards, questions }) => {
  assert.equal(cards.length, questions.length);
  return { probabilities: probsFor(cards), model: "stub", heuristic: false };
};

const heuristicJudge = async ({ cards }) => ({ probabilities: heuristicProbabilities(cards), model: "heuristic", heuristic: true });

test("mergeCues: merges short cues, breaks on pauses and sentence ends", () => {
  const cues = [
    { startMs: 0, endMs: 900, text: "hello there" },
    { startMs: 1000, endMs: 1900, text: "this is a test" },
    { startMs: 20000, endMs: 20500, text: "a new thought after a long pause." },
    { startMs: 21000, endMs: 21500, text: "This one is done now." },
    { startMs: 22000, endMs: 22500, text: "And the next line." },
  ];
  const lines = mergeCues(cues);
  assert.deepEqual(
    lines.map((l) => [l.startMs, l.text]),
    [
      [0, "hello there this is a test"], // short gap, no sentence end: merged
      [20000, "a new thought after a long pause."], // 18 s gap
      [21000, "This one is done now."], // the line before ended a sentence
      [22000, "And the next line."],
    ],
  );
  assert.deepEqual(lines.map(lineLabel), ["L001", "L002", "L003", "L004"]);
});

test("mergeCues: splits once a line reaches the word target", () => {
  const words = Array.from({ length: 26 }, (_, i) => `w${i}`);
  const cues = words.map((w, i) => ({ startMs: i * 500, endMs: i * 500 + 400, text: w }));
  const lines = mergeCues(cues, { targetWords: 6 });
  assert.ok(lines.length >= 4);
  for (const line of lines.slice(0, -1)) assert.ok(line.text.split(" ").length <= 12);
});

test("time labels round-trip", () => {
  assert.equal(msToLabel(0), "0:00");
  assert.equal(msToLabel(65000), "1:05");
  assert.equal(msToLabel(3833000), "1:03:53");
  assert.equal(labelToMs("1:05"), 65000);
  assert.equal(labelToMs("1:03:53"), 3833000);
});

test("groupRuns: finds runs of at least minRun", () => {
  assert.deepEqual(groupRuns([false, true, true, false, true], { minRun: 2 }), [{ from: 1, to: 2 }]);
  assert.deepEqual(groupRuns([true, true, false], { minRun: 2 }), [{ from: 0, to: 1 }]);
  assert.deepEqual(groupRuns([true, false, true, true, true], { minRun: 2 }), [{ from: 2, to: 4 }]);
});

test("parseJson3 and parseVtt produce cues", () => {
  const json3 = { events: [{ tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: "hello " }, { utf8: "world" }] }, { tStartMs: 4000, segs: [{ utf8: "\n" }] }] };
  assert.deepEqual(parseJson3(json3), [{ startMs: 1000, endMs: 3000, text: "hello world" }]);
  const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<v Speaker>hello <c>there</c>\n\n00:00:04.000 --> 00:00:05.500\ntwo\n";
  assert.deepEqual(parseVtt(vtt), [
    { startMs: 1000, endMs: 3000, text: "hello there" },
    { startMs: 4000, endMs: 5000, text: "two" },
  ]);
});

test("parsePastedTranscript: inline timestamps keep the pasted line structure", () => {
  const parsed = parsePastedTranscript("0:00 first line\n0:07 second line\n1:02 third line");
  assert.equal(parsed.timed, true);
  assert.deepEqual(parsed.warnings, []);
  assert.deepEqual(parsed.lines.map((l) => [l.startMs, l.index, l.text]), [[0, 1, "first line"], [7000, 2, "second line"], [62000, 3, "third line"]]);
  assert.ok(parsed.lines[2].endMs > 62000, "the last line's end is estimated from its words");
});

test("parsePastedTranscript: timestamps on their own line (the transcript panel's copy)", () => {
  const parsed = parsePastedTranscript("0:00\nfirst line\n0:07\nsecond line");
  assert.equal(parsed.timed, true);
  assert.deepEqual(parsed.lines.map((l) => [l.startMs, l.text]), [[0, "first line"], [7000, "second line"]]);
});

test("parsePastedTranscript: no timings at all is flagged and estimated", () => {
  const parsed = parsePastedTranscript("one two three four five six seven eight nine ten eleven twelve\nand a second paragraph that keeps going");
  assert.equal(parsed.timed, false);
  assert.match(parsed.warnings[0], /estimated/);
  assert.equal(parsed.lines[0].startMs, 0);
  assert.ok(parsed.lines[0].endMs > 0);
});

test("formatLines quotes lines the way the questions do", () => {
  const lines = mergeCues([{ startMs: 0, endMs: 1000, text: "hello" }]);
  assert.equal(formatLines(lines), "L001| hello");
});

test("questions are noul questions about the right candidate, one kind each", () => {
  for (const kind of ["inside", "start", "leadin", "end"]) {
    const [q] = questionsFor(kind, 1);
    assert.match(q.instructions, /`candidates\[0\]`/);
    assert.equal(q.criteria.true, CRITERIA.true);
    assert.ok(q.instructions.length > 20);
  }
  assert.equal(questionsFor("inside", 4).length, 4);
  assert.throws(() => questionsFor("nonsense", 1));
});

test("lineCard carries the line, its time and a little context", () => {
  const card = lineCard(fixture.lines, 9);
  assert.equal(card.line, "L010");
  assert.equal(card.at, "1:03");
  assert.match(card.text, /sponsored by Brewmaster/);
  assert.match(card.before, /L009/);
  assert.match(card.after, /L011/);
  assert.equal(lineCard(fixture.lines, 10).before.includes("undefined"), false);
});

test("pageOf only sends what the model needs", () => {
  const page = pageOf({ videoId: "abc", title: "t".repeat(300), channel: "c", durationMs: 65000, secret: "no" });
  assert.deepEqual(Object.keys(page), ["host", "title", "channel", "videoId", "duration"]);
  assert.equal(page.title.length, 120);
  assert.equal(page.duration, "1:05");
});

test("buildRequest satisfies the server contract: ad_i keys, one per candidate, max 30", () => {
  const cards = [lineCard(fixture.lines, 0), lineCard(fixture.lines, 1)];
  const payload = buildRequest({ state: { page: pageOf(fixture.video) }, candidates: cards, questions: questionsFor("inside", 2) });
  assert.deepEqual(Object.keys(payload.questions), ["ad_0", "ad_1"]);
  assert.equal(payload.questions.ad_0.type, "noul");
  assert.throws(() => buildRequest({ state: {}, candidates: [], questions: [] }));
  assert.throws(() => buildRequest({ state: {}, candidates: cards, questions: questionsFor("inside", 1) }));
  const many = Array.from({ length: MAX_CANDIDATES_PER_REQUEST + 1 }, (_, i) => lineCard(fixture.lines, i % fixture.lines.length));
  assert.throws(() => buildRequest({ state: {}, candidates: many, questions: questionsFor("inside", many.length) }));
});

test("parseResponse reads probabilities and refuses to guess", () => {
  const body = { model: "local", answers: { ad_0: { type: "noul", noul: 0.91 }, ad_1: { type: "noul", noul: 0.02 } } };
  assert.deepEqual(parseResponse(body, 2).probabilities, [0.91, 0.02]);
  assert.throws(() => parseResponse({ answers: { ad_0: { type: "choice" } } }, 1));
  assert.throws(() => parseResponse({ answers: {} }, 2));
  assert.equal(isHeuristic("heuristic"), true);
  assert.equal(isHeuristic("heuristic (load failed: x)"), true);
  assert.equal(isHeuristic("aac6fef/laya-multilingual-mlx"), false);
});

test("the code heuristic flags the reads and not the merch", () => {
  const sponsor = heuristicProbabilities([{ text: "Today's video is sponsored by Brewmaster." }])[0];
  const offer = heuristicProbabilities([{ text: "Head to brewmaster dot com slash laya and use my code LAYA20." }])[0];
  const merch = heuristicProbabilities([{ text: "There is also a merch store now, and channel memberships." }])[0];
  const subscribe = heuristicProbabilities([{ text: "If you enjoy this, subscribe and hit the bell." }])[0];
  const content = heuristicProbabilities([{ text: "Code owns the timestamps, and the model answers yes or no." }])[0];
  const trap = heuristicProbabilities([{ text: "Promo codes, free trials, links in the description." }])[0];
  assert.ok(sponsor > DEFAULTS.threshold, "sponsor line");
  assert.ok(offer > DEFAULTS.threshold, "offer line");
  assert.ok(merch < DEFAULTS.threshold, "merch is not a sponsor read");
  assert.ok(subscribe < DEFAULTS.threshold, "subscribe is not a sponsor read");
  assert.ok(content < DEFAULTS.threshold, "content line");
  assert.ok(trap < DEFAULTS.threshold, "an offer phrase alone is not enough");
});

test("detectSponsors finds both reads with a stubbed judge that answers from the fixture", async () => {
  // A stub that knows the fixture labels: it stands in for the model so the
  // pipeline's own arithmetic (passes, runs, boundaries, filters) is what is tested.
  const [first, second] = fixture.expected.reads;
  const startOf = (card) => fixture.lines[Number(card.line.slice(1)) - 1].startMs;
  const judge = stubJudge((cards) =>
    cards.map((card) => {
      const t = startOf(card);
      return fixture.expected.reads.some((r) => t >= r.startMs && t < r.endMs) ? 0.95 : 0.05;
    }),
  );
  const result = await detectSponsors({ video: fixture.video, lines: fixture.lines, judge, settings: { stride: 1 } });
  assert.equal(result.reads.length, 2);
  assert.equal(result.reads[0].startMs, first.startMs);
  assert.equal(result.reads[0].endMs, first.endMs);
  assert.equal(result.reads[1].startMs, second.startMs);
  assert.ok(result.reads[1].endMs >= second.endMs && result.reads[1].endMs <= second.endMs + 7000);
  assert.ok(result.log.length > 0);
});

test("detectSponsors returns nothing for a transcript without reads", async () => {
  const judge = stubJudge((cards) => cards.map(() => 0.05));
  const result = await detectSponsors({ video: fixture.video, lines: fixture.lines, judge });
  assert.deepEqual(result.reads, []);
});

test("refineCandidate rejects a read that is too long to skip safely", async () => {
  const judge = stubJudge((cards) => cards.map(() => 0.95));
  const read = await refineCandidate({ lines: fixture.lines, run: { from: 0, to: 49 }, judge, settings: { maxReadMs: 60000 } });
  assert.equal(read, null);
});

test("refineCandidate rejects a read that is too short to bother", async () => {
  const judge = stubJudge((cards) => cards.map(() => 0.95));
  const read = await refineCandidate({ lines: fixture.lines, run: { from: 10, to: 11 }, judge, settings: { minReadMs: 120000 } });
  assert.equal(read, null);
});

test("the pipeline falls back to the code heuristic when the judge does", async () => {
  const result = await detectSponsors({ video: fixture.video, lines: fixture.lines, judge: heuristicJudge });
  assert.equal(result.reads.length, 2);
  for (const [i, expected] of fixture.expected.reads.entries()) {
    assert.ok(Math.abs(result.reads[i].startMs - expected.startMs) <= fixture.expected.startToleranceMs);
    assert.ok(Math.abs(result.reads[i].endMs - expected.endMs) <= fixture.expected.endToleranceMs);
  }
});
