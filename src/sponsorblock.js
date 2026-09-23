// SponsorBlock's community labels.
//
// Only used to compare: the extension never trusts them and never skips from
// them, but "how did the local run do against the crowd" is the cheapest honest
// check on accuracy we have, and the eval script uses the same function.
// Pure fetch, so both the service worker and Node can call it.

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

/** How our reads line up with the community's: matched, ours alone, theirs alone. */
export function compareReads(mine, theirs, toleranceMs = 5000) {
  const matches = (a, b) => a.startMs <= b.startMs + toleranceMs && a.endMs >= b.endMs - toleranceMs;
  const caught = theirs.filter((t) => mine.some((m) => matches(m, t)));
  const oursAlone = mine.filter((m) => !theirs.some((t) => matches(m, t)));
  const theirsAlone = theirs.filter((t) => !mine.some((m) => matches(m, t)));
  return {
    total: theirs.length,
    matched: caught.length,
    extra: oursAlone.length,
    missed: theirsAlone.length,
    oursAlone,
    theirsAlone,
  };
}
