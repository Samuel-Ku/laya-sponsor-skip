// SponsorBlock's community labels.
//
// Only used to compare: the extension never trusts them and never skips from
// them, but "how did the local run do against the crowd" is the cheapest honest
// check on accuracy we have, and the eval script uses the same function.
// Pure fetch and pure arithmetic, so the service worker, the content script and
// Node can all call it.

export const SPONSORBLOCK_ENDPOINT = "https://sponsor.ajay.app";

export async function sponsorBlockSegments(
  videoId,
  { endpoint = SPONSORBLOCK_ENDPOINT, fetchImpl = globalThis.fetch, categories = ["sponsor"] } = {},
) {
  const url = `${endpoint}/api/skipSegments?videoID=${encodeURIComponent(videoId)}&categories=${encodeURIComponent(JSON.stringify(categories))}`;
  const res = await fetchImpl(url);
  if (res.status === 404) return []; // nobody labelled this video yet
  if (!res.ok) throw new Error(`SponsorBlock ${res.status}`);
  const data = await res.json();
  return (Array.isArray(data) ? data : []).map((entry) => ({
    startMs: Math.round((entry.segment?.[0] ?? 0) * 1000),
    endMs: Math.round((entry.segment?.[1] ?? 0) * 1000),
    category: entry.category,
    source: "sponsorblock",
  }));
}

// This module owns how two sets of timestamp ranges are compared, so the watch
// page's Compare with SponsorBlock button and the eval script cannot drift
// apart: both callers use these exact rules, neither keeps its own copy.

/**
 * Pair our reads one-to-one with their segments: each read takes the segment it
 * shares the most time with, and a segment already taken cannot be taken again
 * — one read matching two segments would count one finding twice. The eval's
 * scoring rule: a read paired with nothing is a false positive, a segment
 * nobody paired with is a miss.
 */
export function pairReads(mine, theirs) {
  const used = new Set();
  const pairs = mine.map((read) => {
    let best = null;
    for (const seg of theirs) {
      if (used.has(seg)) continue;
      const shared = Math.max(0, Math.min(read.endMs, seg.endMs) - Math.max(read.startMs, seg.startMs));
      if (shared > 0 && (!best || shared > best.shared)) best = { seg, shared };
    }
    if (best) used.add(best.seg);
    return { read, seg: best?.seg ?? null };
  });
  return { pairs, matched: used };
}

/**
 * How our reads line up with the community's: matched, ours alone, theirs alone.
 *
 * Containment (the default, the watch page's rule): a read caught a segment when
 * it covers it with `toleranceMs` of slack at each edge. Nothing is exclusive —
 * one read can cover two segments, two reads can cover one.
 *
 * `oneToOne` opts into the eval's stricter pairing (`pairReads` above), which
 * scores the same lists without letting one read take credit twice.
 */
export function compareReads(mine, theirs, { toleranceMs = 5000, oneToOne = false } = {}) {
  if (oneToOne) {
    const { pairs, matched } = pairReads(mine, theirs);
    return {
      total: theirs.length,
      matched: matched.size,
      extra: mine.length - matched.size,
      missed: theirs.length - matched.size,
      oursAlone: pairs.filter((p) => !p.seg).map((p) => p.read),
      theirsAlone: theirs.filter((t) => !matched.has(t)),
    };
  }
  const covers = (a, b) => a.startMs <= b.startMs + toleranceMs && a.endMs >= b.endMs - toleranceMs;
  const caught = theirs.filter((t) => mine.some((m) => covers(m, t)));
  const oursAlone = mine.filter((m) => !theirs.some((t) => covers(m, t)));
  const theirsAlone = theirs.filter((t) => !mine.some((m) => covers(m, t)));
  return {
    total: theirs.length,
    matched: caught.length,
    extra: oursAlone.length,
    missed: theirsAlone.length,
    oursAlone,
    theirsAlone,
  };
}
