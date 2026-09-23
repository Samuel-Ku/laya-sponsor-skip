// Transcript plumbing: raw caption cues -> numbered lines the model can cite.
//
// Division of labour, same as the local ad blocker: everything here is plain
// code. The model never writes a timestamp — it only answers yes/no about a line
// that already has one, so every second on the timeline is owned by this file.
//
// A "cue"  is { startMs, endMs, text }  — one caption as YouTube showed it.
// A "line" is { index, startMs, endMs, text } — a few cues merged into one
//           readable transcript line; `index` is 1-based and stable, and it is
//           what the model sees as `L042| ...`.

export const LINE_TARGET_WORDS = 11;
export const LINE_MAX_GAP_MS = 1500;
export const LINE_MAX_MS = 9000;
export const DEFAULT_WORDS_PER_SECOND = 2.6; // fallback timing for untimed pastes

export function words(text) {
  return String(text || "").trim().split(/\s+/).filter(Boolean).length;
}

/** 65432 -> "1:05" (or "1:02:03" past an hour). */
export function msToLabel(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** "1:05" / "1:02:03" -> milliseconds. */
export function labelToMs(label) {
  const parts = String(label || "").trim().split(":").map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0) * 1000;
}

/** The stable name of a line, as shown in the panel and quoted in questions. */
export function lineLabel(line) {
  return `L${String(line.index).padStart(3, "0")}`;
}

/**
 * Give every line its stable 1-based index. Saved transcripts and pasted text
 * may arrive without one; the model is asked about `L042`, so it always exists
 * by the time anything is judged.
 */
export function indexLines(lines) {
  return (lines || []).map((line, i) => (line.index === i + 1 ? line : { ...line, index: i + 1 }));
}

/**
 * Merge caption cues into transcript lines.
 * A line ends when it reaches ~`targetWords`, when the speaker pauses longer than
 * `maxGapMs`, when the line would run past `maxMs`, or at a sentence end.
 */
export function mergeCues(cues, { targetWords = LINE_TARGET_WORDS, maxGapMs = LINE_MAX_GAP_MS, maxMs = LINE_MAX_MS } = {}) {
  const sorted = [...(cues || [])]
    .filter((c) => c && Number.isFinite(c.startMs))
    .sort((a, b) => a.startMs - b.startMs);

  const lines = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const text = cur.parts.join(" ").replace(/\s+/g, " ").trim();
    if (text) lines.push({ index: lines.length + 1, startMs: cur.startMs, endMs: Math.max(cur.endMs, cur.startMs), text });
    cur = null;
  };

  for (const cue of sorted) {
    const text = String(cue.text || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const endMs = Number.isFinite(cue.endMs) ? cue.endMs : cue.startMs;
    if (!cur) {
      cur = { startMs: cue.startMs, endMs, parts: [text] };
      continue;
    }
    const gap = cue.startMs - cur.endMs;
    const count = words(cur.parts.join(" "));
    const duration = cue.startMs - cur.startMs;
    const lastChar = cur.parts[cur.parts.length - 1].slice(-1);
    const sentenceEnd = /[.!?]/.test(lastChar) && count >= 4;
    if (gap > maxGapMs || duration > maxMs || count >= targetWords || sentenceEnd) {
      flush();
      cur = { startMs: cue.startMs, endMs, parts: [text] };
    } else {
      cur.parts.push(text);
      cur.endMs = endMs;
    }
  }
  flush();
  return lines;
}

/** youtubei/json3 caption document -> cues (used by the transcript fetch scripts). */
export function parseJson3(doc, { offsetMs = 0 } = {}) {
  const cues = [];
  for (const event of doc?.events || []) {
    if (!event?.segs) continue;
    const text = event.segs.map((s) => s.utf8 || "").join("").replace(/\n/g, " ").trim();
    if (!text) continue;
    const startMs = (event.tStartMs || 0) + offsetMs;
    cues.push({ startMs, endMs: startMs + (event.dDurationMs || 0), text });
  }
  return cues;
}

/** WebVTT -> cues. Inline <00:00:01.000> timestamps and tags are stripped. */
export function parseVtt(text) {
  const cues = [];
  const blocks = String(text || "").replace(/\r/g, "").split(/\n{2,}/);
  for (const block of blocks) {
    const m = block.match(/(\d{1,2}:)?\d{2}:\d{2}[.,]\d{3}\s*-->\s*((\d{1,2}:)?\d{2}:\d{2}[.,]\d{3})/);
    if (!m) continue;
    const startMs = labelToMs(m[0].split("-->")[0].trim().replace(",", ".").split(".")[0]);
    const endMs = labelToMs(m[2].trim().replace(",", ".").split(".")[0]);
    const body = block.slice(block.indexOf(m[0]) + m[0].length)
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (body) cues.push({ startMs: startMs ?? 0, endMs: endMs ?? startMs, text: body });
  }
  return cues;
}

const TIMED_TWO_LINE = /^\s*[\[(]?((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)[\])]?\s*$/;

/**
 * Parse a transcript the user pasted (the web app's escape hatch, and the only
 * way to analyze a video whose captions we cannot read).
 *
 * Handles three shapes:
 *   "0:13 sponsor name"                — timestamp in front of the text
 *   "0:13\nsponsor name"               — timestamp on its own line
 *   "sponsor name..."                  — no timings at all
 * The last shape gets estimated timings from the words-per-second rate and is
 * flagged, because estimated boundaries are only ever a hint.
 */
export function parsePastedTranscript(text, { wordsPerSecond = DEFAULT_WORDS_PER_SECOND } = {}) {
  const raw = String(text || "").replace(/\r/g, "");
  if (!raw.trim()) return { cues: [], lines: [], timed: false, warnings: ["Nothing to parse."] };
  if (raw.includes("-->")) {
    const cues = parseVtt(raw);
    return { cues, lines: mergeCues(cues), timed: true, warnings: [] };
  }
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const cues = [];
  const warnings = [];
  let pendingTs = null;
  for (const line of lines) {
    const only = line.match(TIMED_TWO_LINE);
    if (only) {
      pendingTs = labelToMs(only[1].replace(",", ".").split(".")[0]);
      continue;
    }
    const inline = line.match(/^\s*[\[(]?((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)[\])]?[\s\-–:]+(.+)$/);
    let startMs = null;
    let body = line;
    if (inline) {
      startMs = labelToMs(inline[1].replace(",", ".").split(".")[0]);
      body = inline[2].trim();
    } else if (pendingTs != null) {
      startMs = pendingTs;
      pendingTs = null;
    }
    if (!body) continue;
    cues.push({ startMs, endMs: null, text: body });
  }

  const timed = cues.length > 0 && cues.every((c) => c.startMs != null);
  if (!timed && cues.length) {
    warnings.push("No timings in the pasted transcript — boundaries are estimated from the reading speed.");
    let t = 0;
    for (const cue of cues) {
      cue.startMs = t;
      cue.endMs = t + (words(cue.text) / wordsPerSecond) * 1000;
      t = cue.endMs;
    }
    // Without timings the text is the only structure, so it is merged into lines
    // the way live captions are.
    return { cues, lines: mergeCues(cues), timed: false, warnings };
  }

  // With timings, each entry stays its own line: that is the line structure the
  // user pasted (usually straight from YouTube's transcript panel), and it is
  // finer than anything we would invent by merging.
  for (let i = 0; i < cues.length; i++) {
    const next = cues[i + 1]?.startMs;
    cues[i].endMs = next != null && next > cues[i].startMs ? next : cues[i].startMs + (words(cues[i].text) / wordsPerSecond) * 1000;
  }
  const outLines = cues.map((cue, i) => ({ index: i + 1, startMs: cue.startMs, endMs: cue.endMs, text: cue.text }));
  return { cues, lines: outLines, timed: true, warnings };
}

/**
 * Contiguous runs of `true` in `flags`, at least `minRun` long.
 * Returns [{ from, to }] with inclusive 0-based indices.
 */
export function groupRuns(flags, { minRun = 2 } = {}) {
  const runs = [];
  let start = -1;
  flags.forEach((flag, i) => {
    if (flag && start < 0) start = i;
    if ((!flag || i === flags.length - 1) && start >= 0) {
      const end = flag ? i : i - 1;
      if (end - start + 1 >= minRun) runs.push({ from: start, to: end });
      start = -1;
    }
  });
  return runs;
}

/** Average line length in ms — used to turn "at least N seconds" into "at least N lines". */
export function medianLineMs(lines) {
  const durations = lines.map((l) => l.endMs - l.startMs).filter((d) => d > 0).sort((a, b) => a - b);
  if (!durations.length) return 4000;
  return durations[Math.floor(durations.length / 2)];
}

/** "L042| text" — how a line is quoted inside questions and debug output. */
export function formatLines(lines) {
  return lines.map((l) => `${lineLabel(l)}| ${l.text}`).join("\n");
}
