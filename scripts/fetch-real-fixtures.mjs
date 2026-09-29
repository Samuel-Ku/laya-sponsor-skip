// Build real-video fixtures: a transcript fetched from YouTube's own caption
// system, plus the SponsorBlock community segments as ground truth.
//
//   node scripts/fetch-real-fixtures.mjs                 # the default list
//   node scripts/fetch-real-fixtures.mjs VIDEO_ID ...    # any video
//
// The player query goes through the ANDROID innertube client, whose timedtext
// responses are not gated behind the pot token the web player now requires.
// Everything is plain code: cues are merged into lines by the same
// mergeCues() the extension runs on, and the model never sees this script.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { mergeCues } from "../src/transcript.js";

// 3Blue1Brown (mid-roll educational sponsor), two phone reviews (early and
// late reads), one long-term review — plus two controls with no labelled
// sponsor segments at all.
export const DEFAULT_VIDEOS = [
  { id: "aircAruvnKk", note: "educational, mid-roll read" },
  { id: "CLkMCNkwCjI", note: "review, early read" },
  { id: "cBpGq-vDr2Y", note: "review, late read" },
  { id: "brqtaTjBkB0", note: "long-term review" },
  { id: "rS7scGrFsRo", note: "control: no sponsor segments" },
  { id: "LPzhNScuGjs", note: "control: no sponsor segments" },
];

const UA = "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip";

const PLAYER_URL = "https://www.youtube.com/youtubei/v1/player";

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function fetchPlayer(videoId) {
  const data = await postJson(PLAYER_URL, {
    context: { client: { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 30, hl: "en" } },
    videoId,
  });
  const status = data?.playabilityStatus?.status;
  if (status !== "OK") throw new Error(`playability ${status}`);
  const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const track = tracks.find((t) => t.languageCode === "en" && t.kind !== "asr") ?? tracks.find((t) => t.languageCode?.startsWith("en"));
  if (!track) throw new Error("no English caption track");
  return {
    player: data,
    track,
    kind: track.kind === "asr" ? "asr" : "manual",
  };
}

async function fetchCues(track) {
  const res = await fetch(`${track.baseUrl}&fmt=json3`, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`timedtext -> HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const head = buf.subarray(0, 5).toString();
  if (head === "<?xml" || head === "<tran" || head === "<time") return xmlCues(buf.toString("utf8"));
  const json = JSON.parse(buf.toString("utf8"));
  return (json.events ?? [])
    .filter((e) => e.segs && Number.isFinite(e.tStartMs))
    .map((e) => ({
      startMs: e.tStartMs,
      endMs: e.tStartMs + (e.dDurationMs ?? 4000),
      text: e.segs.map((s) => s.utf8 ?? "").join("").replace(/\s+/g, " ").trim(),
    }))
    .filter((c) => c.text);
}

function xmlCues(xml) {
  const cues = [];
  const re = /<p\s+t="(\d+)"(?:\s+d="(\d+)")?[^>]*>([\s\S]*?)<\/p>/g;
  for (const [, t, d, body] of xml.matchAll(re)) {
    const text = body
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    cues.push({ startMs: Number(t), endMs: Number(t) + Number(d || 4000), text });
  }
  return cues;
}

async function fetchSponsorSegments(videoId) {
  const res = await fetch(`https://sponsor.ajay.app/api/skipSegments?videoID=${videoId}`);
  if (!res.ok) return []; // "Not Found" — no labelled segments, e.g. the controls
  const all = await res.json();
  return all
    .filter((s) => s.actionType === "skip" && s.category === "sponsor")
    .map((s) => ({ startMs: Math.round(s.segment[0] * 1000), endMs: Math.round(s.segment[1] * 1000), category: s.category, votes: s.votes }))
    .filter((s) => s.endMs > s.startMs);
}

const videos = process.argv.length > 2
  ? process.argv.slice(2).map((id) => ({ id, note: "cli" }))
  : DEFAULT_VIDEOS;

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "real");
mkdirSync(outDir, { recursive: true });

for (const { id, note } of videos) {
  try {
    const { player, track, kind } = await fetchPlayer(id);
    const details = player.videoDetails ?? {};
    const cues = await fetchCues(track);
    const segments = await fetchSponsorSegments(id);
    const fixture = {
      video: {
        videoId: id,
        title: details.title ?? id,
        channel: details.author ?? "",
        durationMs: Number(details.lengthSeconds ?? 0) * 1000,
      },
      track: { languageCode: track.languageCode, kind },
      sponsorblock: segments,
      note,
      lines: mergeCues(cues),
    };
    const file = join(outDir, `${id}.json`);
    writeFileSync(file, JSON.stringify(fixture, null, 2) + "\n");
    console.log(`${id}: ${fixture.lines.length} lines, ${fixture.video.title.slice(0, 50)} — ${segments.length} SB segment(s) -> ${file}`);
  } catch (err) {
    console.log(`${id}: FAILED — ${err.message}`);
    process.exitCode = 1;
  }
}
