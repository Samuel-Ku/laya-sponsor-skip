// Unit tests for the pure parts: transcript plumbing, question building, the
// code heuristic, the SponsorBlock comparison and the pipeline running against a
// stubbed judge.
//   npm test

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { formatLines, indexLines, labelToMs, lineLabel, mergeCues, msToLabel, parseJson3, parsePastedTranscript, parseVtt } from "../src/transcript.js";
import { createDetector, DEFAULTS, detectSponsors } from "../src/detector.js";
import { CRITERIA, heuristicProbabilities, lineCard, makeJudge, pageOf, questionsFor } from "../src/sponsor.js";
import { compareReads, pairReads } from "../src/sponsorblock.js";
import { MAX_CANDIDATES_PER_REQUEST, buildRequest, healthUrlFor, isHeuristic, LAYA_ENDPOINT, LAYA_HEALTH_ENDPOINT, parseResponse } from "../src/laya.js";

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

/** A transcript of `count` six-second lines, so the bridge budget is 10 lines. */
const flatLines = (count) => Array.from({ length: count }, (_, i) => ({ index: i + 1, startMs: i * 6000, endMs: i * 6000 + 6000, text: `line ${i + 1}` }));

/** A judge that answers yes for the lines it was given, as `L003` or an index. */
const judgeFrom = (yesFor) => {
  const line = (card) => Number(String(card.line).slice(1)) - 1;
  const mine = (card) => (typeof yesFor === "function" ? yesFor(line(card), card) : yesFor.has(card.line));
  return async ({ cards }) => ({ probabilities: cards.map((card) => (mine(card) ? 0.95 : 0.05)), model: "stub", heuristic: false });
};

const shapeOf = (observed) => [...observed.closed, ...(observed.open ? [observed.open] : [])].map((run) => [run.from, run.to]);

test("the detector bridges a read's quiet middle, and only a bridgeable one", async () => {
  const lines = flatLines(40);
  // The lead-in and the offer, eight lines of pitch in between that names nothing:
  // the shape of the Surfshark read in the real fixtures, and the reason the live
  // loop used to find nothing at all.
  const bridged = await createDetector({ judge: judgeFrom(new Set(["L003", "L004", "L013", "L014"])) }).observe(lines);
  assert.deepEqual(shapeOf(bridged), [[2, 13]]);
  assert.equal(bridged.closed[0].score, 0.95);
  // The same pocket eighteen lines later is past the budget: two candidates, not one.
  const apart = await createDetector({ judge: judgeFrom(new Set(["L003", "L004", "L023", "L024"])) }).observe(lines);
  assert.deepEqual(shapeOf(apart), [
    [2, 3],
    [22, 23],
  ]);
});

test("the detector waits for the lines it has not judged yet", async () => {
  const lines = flatLines(60);
  // One tick may judge a bounded number of lines, so the tail of a long video is
  // unjudged until the next tick — and a read may only bridge a middle it has
  // heard and found quiet, never one nobody has asked about.
  const detector = createDetector({ judge: judgeFrom(new Set(["L035", "L036", "L044", "L045"])) });
  const first = await detector.observe(lines);
  assert.equal(first.judged, 40);
  assert.deepEqual(shapeOf(first), [[34, 35]]); // the offer pocket has not been heard yet
  const rest = await detector.observe(lines);
  assert.equal(rest.judged, 60);
  assert.deepEqual(shapeOf(rest), [[34, 44]]); // now it has, and the middle was quiet
});

test("the detector calls a growing tail open and closes it when the speaker moves on", async () => {
  const lines = flatLines(30);
  const judge = judgeFrom(new Set(["L011", "L012"]));
  const detector = createDetector({ judge });
  const early = await detector.observe(lines.slice(0, 14)); // two lines after the pocket: still growing
  assert.equal(early.open.from, 10);
  assert.equal(early.closed.length, 0);
  assert.equal(early.newest.index, 13);
  const later = await detector.observe(lines);
  assert.equal(later.open, null);
  assert.deepEqual(shapeOf(later), [[10, 11]]);
});

test("the duration filters reject a read too short to bother and one too long to skip", async () => {
  const short = flatLines(20);
  const shortDetector = createDetector({ judge: judgeFrom(new Set(["L005", "L006"])) });
  const shortObserved = await shortDetector.observe(short);
  assert.equal(await shortDetector.refine(shortObserved.closed[0]), null); // 12 s

  const long = flatLines(70);
  const longDetector = createDetector({ judge: judgeFrom((index) => index <= 55) }); // 56 lines, then quiet
  await longDetector.observe(long); // the per-call cap, drained
  const longObserved = await longDetector.observe(long);
  assert.equal(longObserved.open, null);
  assert.equal(await longDetector.refine(longObserved.closed[0]), null); // 336 s
});

test("the detector gives the same answer fed in portions as in one pass", async () => {
  const lines = fixture.lines;
  const inside = (index) => {
    const at = lines[index].startMs;
    return fixture.expected.reads.some((read) => at >= read.startMs && at < read.endMs);
  };
  const onePass = await createDetector({ judge: judgeFrom(inside) }).observe(lines);

  const detector = createDetector({ judge: judgeFrom(inside) });
  let portions = null;
  for (let n = 5; n < lines.length; n += 5) portions = await detector.observe(lines.slice(0, n));
  portions = await detector.observe(lines);

  assert.deepEqual(shapeOf(portions), shapeOf(onePass));
  assert.equal(portions.closed.length, 2); // both labelled reads
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
  const result = await detectSponsors({ video: fixture.video, lines: fixture.lines, judge });
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

test("the pipeline falls back to the code heuristic when the judge does", async () => {
  const result = await detectSponsors({ video: fixture.video, lines: fixture.lines, judge: heuristicJudge });
  assert.equal(result.reads.length, 2);
  for (const [i, expected] of fixture.expected.reads.entries()) {
    assert.ok(Math.abs(result.reads[i].startMs - expected.startMs) <= fixture.expected.startToleranceMs);
    assert.ok(Math.abs(result.reads[i].endMs - expected.endMs) <= fixture.expected.endToleranceMs);
  }
});

test("compareReads: containment with slack — the watch page's rule", () => {
  const seg = { startMs: 100_000, endMs: 160_000 };
  assert.equal(compareReads([{ startMs: 100_000, endMs: 160_000 }], [seg]).matched, 1);
  // within the 5 s slack at each edge
  assert.equal(compareReads([{ startMs: 103_000, endMs: 158_000 }], [seg]).matched, 1);
  // 8 s late at the start: outside the slack, so a miss and an extra of ours
  const late = compareReads([{ startMs: 108_000, endMs: 160_000 }], [seg]);
  assert.equal(late.matched, 0);
  assert.equal(late.extra, 1);
  assert.equal(late.missed, 1);
  // nothing is exclusive: one read covering two segments counts both,
  // and two reads over one segment leave nothing missed or extra
  const wide = { startMs: 90_000, endMs: 210_000 };
  const two = [seg, { startMs: 170_000, endMs: 200_000 }];
  assert.deepEqual(compareReads([wide], two), { total: 2, matched: 2, extra: 0, missed: 0, oursAlone: [], theirsAlone: [] });
  const split = compareReads([{ startMs: 95_000, endMs: 205_000 }, { startMs: 98_000, endMs: 162_000 }], [seg]);
  assert.equal(split.matched, 1);
  assert.equal(split.extra, 0);
  assert.equal(split.missed, 0);
});

test("compareReads: oneToOne pairs each read with at most one segment — the eval's rule", () => {
  const seg = { startMs: 100_000, endMs: 160_000 };
  const other = { startMs: 170_000, endMs: 200_000 };
  // the containment rule and the pairing rule disagree exactly where one read
  // spans two segments: containment credits both, pairing makes the second a miss
  const wide = { startMs: 90_000, endMs: 210_000 };
  const paired = compareReads([wide], [seg, other], { oneToOne: true });
  assert.equal(paired.matched, 1); // the wider share wins: 60 s over seg, 30 s over other
  assert.equal(paired.extra, 0);
  assert.equal(paired.missed, 1);
  assert.deepEqual(paired.theirsAlone, [other]);
  // a read that arrives after the segment was taken is paired with nothing
  const crowded = compareReads([{ startMs: 95_000, endMs: 165_000 }, { startMs: 100_000, endMs: 160_000 }], [seg], { oneToOne: true });
  assert.equal(crowded.matched, 1);
  assert.equal(crowded.extra, 1);
  assert.deepEqual(crowded.oursAlone, [{ startMs: 100_000, endMs: 160_000 }]);
});

test("pairReads: shared time picks the partner, ties keep the first segment", () => {
  const read = { startMs: 0, endMs: 100_000 };
  const first = { startMs: 0, endMs: 60_000 };
  const second = { startMs: 40_000, endMs: 100_000 };
  const { pairs, matched } = pairReads([read], [first, second]);
  assert.equal(pairs[0].seg, first); // 60 s shared, both — first wins, deterministically
  assert.equal(matched.size, 1);
  assert.deepEqual(pairReads([], []).pairs, []);
});

test("one place owns the judge address and the /health that sits beside it", () => {
  // Every caller — background, popup, the eval scripts, the harness pages —
  // imports these; the URL appears in exactly one definition.
  assert.equal(LAYA_ENDPOINT, "http://127.0.0.1:8765/judge");
  assert.equal(LAYA_HEALTH_ENDPOINT, healthUrlFor(LAYA_ENDPOINT));
  assert.equal(healthUrlFor("http://127.0.0.1:9000/judge"), "http://127.0.0.1:9000/health");
  assert.equal(healthUrlFor("http://127.0.0.1:9000/judge/"), "http://127.0.0.1:9000/health");
  assert.equal(healthUrlFor("http://127.0.0.1:9000"), "http://127.0.0.1:9000");
  assert.equal(healthUrlFor("http://127.0.0.1:9000/other/"), "http://127.0.0.1:9000/other/");
});

test("a missing video page never costs a judge call", async () => {
  // The eval harness runs the pipeline with no live page, and a page that threw
  // before the transport was reached used to turn every verdict into the code
  // heuristic while the run still reported the server's model name.
  let calls = 0;
  let sent = null;
  const judge = makeJudge({
    video: null,
    transport: async ({ state, candidates }) => {
      calls++;
      sent = state.page;
      return { probabilities: candidates.map((_, i) => (i % 2 ? 0.1 : 0.9)), model: "stub" };
    },
  });
  const answers = await judge({ cards: [{ text: "a" }, { text: "b" }], questions: [] });
  assert.equal(calls, 1);
  assert.equal(answers.heuristic, false);
  assert.deepEqual(answers.probabilities, [0.9, 0.1]);
  assert.equal(sent.host, "youtube.com");
  assert.equal(pageOf(null).title, "");
});
