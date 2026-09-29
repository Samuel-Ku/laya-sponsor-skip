// The judge seam: what a sponsor read is, how one line is put to the judge, and
// what the model is allowed to see at all.
//
// Code owns every timestamp and every threshold; the judge only answers typed noul
// questions about a line that already has one. That is the same split the upstream
// project uses with Jev, and it is why the whole pipeline runs offline: swap the
// judge for the code heuristic below and nothing else changes.
//
// The other half of the pipeline is ./detector.js, which turns those answers into
// reads with boundaries. This file knows how to ask; that one knows where a read
// is. Nothing here may import it — the detector is the caller.

import { lineLabel, msToLabel } from "./transcript.js";
import { isHeuristic } from "./laya.js";

const TEXT_LIMIT = 220;
const CONTEXT_LIMIT = 70;

// The same definition of a sponsor read the upstream pipeline carries in every
// question: a lead-in that exists only to arrive at the sponsor, the pitch, the
// offer — and, spelled out, what does not count.
export const CRITERIA = {
  true:
    "A sponsor read: paid promotion inside the video's own audio. It starts at the lead-in " +
    "(a story, a \"quick word\", or a sentence whose only purpose is to arrive at the sponsor), " +
    "continues through the pitch (what the product is, why the speaker uses it) and the offer " +
    "(a discount code, a link, a free trial, \"link in the description\").",
  false:
    "Everything else: the video's actual subject, the speaker's own opinions and stories, " +
    "\"like and subscribe\", the notification bell, comments, the speaker's own merch store, " +
    "channel memberships and Patreon, teasers for the speaker's other videos, and any read " +
    "that only mentions a name without promoting it.",
};

const READING =
  "`page` describes the video. Each entry of `candidates` is one transcript line of that video, " +
  "with the lines just before and after it for context. Lines are quoted as `line` (for example " +
  "`L042`); times are only for the reader.";

/** The typed questions the detector asks, one per line it sends. */
export function questionsFor(kind, count) {
  const ask = {
    inside: (k) =>
      `Is the transcript line in \`candidates[${k}]\` spoken inside a sponsor read of this video?`,
    start: (k) =>
      `Is the transcript line in \`candidates[${k}]\` the first line of a sponsor read — the moment its lead-in begins?`,
    leadin: (k) =>
      `Does the transcript line in \`candidates[${k}]\` still belong to the same sponsor read as the lines that follow it, as part of its lead-in?`,
    end: (k) =>
      `Is the sponsor read already over at the transcript line in \`candidates[${k}]\` — the speaker back on the video's own subject?`,
  }[kind];
  if (!ask) throw new Error(`questionsFor: unknown kind ${kind}`);
  return Array.from({ length: count }, (_, k) => ({ instructions: `${ask(k)} ${READING}`, criteria: CRITERIA }));
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const cut = (text, limit) => {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.length > limit ? `${t.slice(0, limit - 1)}…` : t;
};

/** One transcript line, described compactly for the model. */
export function lineCard(lines, index, { radius = 1, textLimit = TEXT_LIMIT, contextLimit = CONTEXT_LIMIT } = {}) {
  const line = lines[index];
  const before = [];
  for (let i = Math.max(0, index - radius); i < index; i++) before.push(`${lineLabel(lines[i])}: ${cut(lines[i].text, contextLimit)}`);
  const after = [];
  for (let i = index + 1; i <= Math.min(lines.length - 1, index + radius); i++) after.push(`${lineLabel(lines[i])}: ${cut(lines[i].text, contextLimit)}`);
  return {
    line: lineLabel(line),
    at: msToLabel(line.startMs),
    text: cut(line.text, textLimit),
    before: before.length ? before.join(" | ") : undefined,
    after: after.length ? after.join(" | ") : undefined,
  };
}

/** What the model is allowed to see about the video itself. */
export function pageOf(video) {
  // Callers may legitimately have no metadata yet (the eval harness runs the
  // pipeline without a live page), and a missing page must not be the reason a
  // judge call never happens.
  const v = video ?? {};
  return {
    host: "youtube.com",
    title: cut(v.title || "", 120),
    channel: cut(v.channel || "", 60),
    videoId: v.videoId,
    duration: v.durationMs ? msToLabel(v.durationMs) : undefined,
  };
}

/**
 * Wrap a transport (direct fetch, or a message to the service worker) into the
 * judge the pipeline talks to. If the local server is down — or is running its
 * DOM-ad heuristic stand-in, whose vocabulary is about page elements and not
 * about speech — the code heuristic answers instead, and says so.
 */
export function makeJudge({ video, transport, log = () => {} }) {
  return async function judge({ cards, questions }) {
    let res;
    try {
      res = await transport({ state: { page: pageOf(video) }, candidates: cards, questions });
      if (res?.error) throw new Error(res.error);
    } catch (err) {
      log({ kind: "judge-error", message: err?.message ?? String(err), verdict: "heuristic" });
      return heuristicAnswer(cards, { model: "heuristic (offline)" });
    }
    if (isHeuristic(res?.model) || !Array.isArray(res?.probabilities) || res.probabilities.length !== cards.length) {
      log({ kind: "judge-heuristic", model: res?.model, verdict: "heuristic" });
      return heuristicAnswer(cards, { model: res?.model ?? HEURISTIC_MODEL });
    }
    return { probabilities: res.probabilities, model: res.model, heuristic: false };
  };
}

// ---------- the code-side stand-in: the heuristic as an adapter on this seam ----------

/** The model name the code heuristic answers under when nothing else applies. */
export const HEURISTIC_MODEL = "heuristic";

/**
 * The heuristic dressed as a judge's answer: the exact shape every caller of the
 * judge seam consumes (`{ probabilities, model, heuristic }`). One adapter instead
 * of every caller wrapping the heuristic by hand — that used to live in five
 * places, with three spellings of the model name.
 */
export function heuristicAnswer(cards, { model = HEURISTIC_MODEL } = {}) {
  return { probabilities: heuristicProbabilities(cards), model, heuristic: true };
}

// Phrasings that only exist to sell something, phrasings that usually introduce
// a read, and — from the upstream criteria — the things that are not sponsors.
const HEURISTIC = {
  // Phrases that only ever introduce or close a paid read.
  hard:
    /(this (video|episode|show|stream|segment|portion|part)( of the video)? is (sponsored|brought to you|presented) by|sponsored by|brought to you by|sponsor of (this|today'?s) (video|episode)|(our|the|this|today'?s) (video|episode)('s)? sponsor\b|\b(today'?s|this) sponsor\b|a (great|longtime|long-time) sponsor\b|thank(s| you) to [\w\s'&.-]{2,40} for sponsoring|sponsoring (this|today'?s) (video|episode)|link (is )?(in|down below in) the (description|bio|show notes)|(leave|drop) a link (to|in|down|below)|check (it|this) out (down )?below|link (is )?down below|use (my|our|the )?code|\bcode [A-Z0-9]{1,11}\d[A-Z0-9]{0,4}\b|\$\d{1,4}(\.\d+)? off|head to [\w-]+ ?(dot|\.) ?(com|io|net|co|org|gg)|go to [\w-]+ ?(dot|\.) ?(com|io|net|co|org|gg)|sign ?up (today|now|with)|first \d{1,3} (people|users|subscribers|listeners))/i,
  // Marketing-shaped phrases: a hint of a read, not proof of one.
  soft:
    /(before we (get started|begin|dive in|jump in)|quick (word|break|message|note)|let me tell you about|we'?re back|now,? back to|support(ed)? (for|by)|our partners?|a word from|(our|the|their) sponsor\b|promo ?code|discount code|coupon|(ten|fifteen|twenty|twenty-five|thirty|forty|fifty) percent off|\d{1,2}% off|save \d{1,2}%|free (trial|month|shipping|version)|\b[\w-]+\.(com|io|net|co|org)\b)/i,
  // Spelled out in the criteria: these are not sponsor reads.
  notSponsor:
    /(like and subscribe|hit the (bell|like)|leave a (comment|like)|comment below|subscribe to (my|the)? ?channel|patreon|join this channel|merch (store|shop|link|line)|membership)/i,
};

const NOT_SPONSOR_SCORE = 0.07;
// A neighbour that looks like a read is a hint at a discount — a read is a run of
// lines, and the pitch lines in the middle name nothing — but the line's own
// words always win, so a subscribe line never gets pulled into a read. The hint
// is asymmetric on purpose, and the directions matter: `after` is the text of the
// NEXT line, so a high weight there grows a read backwards out of its offer (the
// approach to a seed line is still the read), while `before` — the previous
// line's text — stays half-weight, because what follows a finished offer is
// usually the video's own content again.
const CONTEXT_WEIGHT = 0.5;
const CONTEXT_WEIGHT_AFTER = 0.8;

function scoreText(text) {
  const t = String(text || "");
  if (!t.trim()) return 0.1;
  if (HEURISTIC.hard.test(t)) return HEURISTIC.notSponsor.test(t) ? 0.85 : 0.9;
  if (HEURISTIC.notSponsor.test(t)) return NOT_SPONSOR_SCORE;
  return HEURISTIC.soft.test(t) ? 0.6 : 0.1;
}

/**
 * Score lines from their own words, plus their neighbours at a discount.
 *
 * Deliberately simple, visible and batch-independent: the answer for a line never
 * depends on how many other lines travelled in the same local call. This only
 * exists so the extension is useful before the checkpoint is installed, and it is
 * always labelled `heuristic` wherever a verdict is shown.
 */
export function heuristicProbabilities(cards) {
  return cards.map((card) => {
    const own = scoreText(card?.text);
    if (own === NOT_SPONSOR_SCORE) return own; // spelled out as not a sponsor: no hint overrides that
    const before = scoreText(card?.before || "");
    const after = scoreText(card?.after || "");
    const hinted = Math.max(own, before * CONTEXT_WEIGHT, after * CONTEXT_WEIGHT_AFTER);
    return clamp(Number(hinted.toFixed(3)), 0.01, 0.98);
  });
}
