// The panel on the watch page, and the toast after a skip.
//
// Shared with test/harness.html on purpose: the harness builds the same UI from
// the same module, so the layout is exercised without installing anything.
// Everything is created with DOM calls (never innerHTML), and every node carries
// `data-lss` so our own UI can never be mistaken for page content.

import { msToLabel } from "./transcript.js";

const STYLE_ID = "lss-style";

const CSS = `
#lss-panel, .lss-toast {
  font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: #e2e8f0;
}
#lss-panel {
  position: fixed; right: 18px; bottom: 18px; z-index: 2147483646; width: 306px;
  background: #0f172a; border: 1px solid #1e293b; border-radius: 12px;
  box-shadow: 0 12px 32px rgba(2, 6, 23, .5); overflow: hidden;
}
#lss-panel header { display: flex; align-items: center; gap: 8px; padding: 9px 11px; background: #111827; border-bottom: 1px solid #1e293b; }
#lss-panel header h2 { margin: 0; font-size: 13px; font-weight: 650; flex: 1; }
#lss-panel .lss-badge { font-size: 10.5px; padding: 2px 6px; border-radius: 999px; background: #1e293b; color: #94a3b8; }
#lss-panel .lss-badge.lss-heuristic { background: #3f2d0b; color: #fbbf24; }
#lss-panel .lss-badge.lss-live { background: #052e2b; color: #2dd4bf; }
#lss-panel .lss-x { background: none; border: 0; color: #94a3b8; cursor: pointer; font-size: 15px; line-height: 1; padding: 2px 4px; }
#lss-panel .lss-x:hover { color: #f8fafc; }
#lss-panel .lss-body { padding: 10px 11px; display: flex; flex-direction: column; gap: 9px; max-height: 60vh; overflow: auto; }
#lss-panel .lss-row { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
#lss-panel .lss-muted { color: #94a3b8; font-size: 11.5px; }
#lss-panel .lss-reads { display: flex; flex-direction: column; gap: 6px; }
#lss-panel .lss-read { display: flex; align-items: center; gap: 8px; background: #111c33; border: 1px solid #1e293b; border-radius: 8px; padding: 7px 8px; }
#lss-panel .lss-read.lss-open { border-color: #7f1d1d; background: #1f1420; }
#lss-panel .lss-times { flex: 1; font-variant-numeric: tabular-nums; }
#lss-panel .lss-times b { font-weight: 600; }
#lss-panel .lss-p { color: #f472b6; font-size: 11.5px; font-variant-numeric: tabular-nums; }
#lss-panel button { font: inherit; padding: 4px 9px; border-radius: 7px; border: 1px solid #334155; background: #1e293b; color: #e2e8f0; cursor: pointer; }
#lss-panel button:hover { background: #273449; }
#lss-panel button.lss-primary { background: #e11d48; border-color: #e11d48; color: #fff; font-weight: 600; }
#lss-panel button.lss-primary:hover { background: #be123c; }
#lss-panel button[disabled] { opacity: .5; cursor: default; }
#lss-panel details { border-top: 1px solid #1e293b; padding-top: 8px; }
#lss-panel summary { cursor: pointer; color: #94a3b8; font-size: 11.5px; }
#lss-panel .lss-log { margin-top: 6px; display: flex; flex-direction: column; gap: 2px; max-height: 168px; overflow: auto; font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: #94a3b8; }
#lss-panel .lss-log .lss-yes { color: #34d399; }
#lss-panel .lss-log .lss-no { color: #64748b; }
#lss-panel .lss-log .lss-warn { color: #fbbf24; }
#lss-panel .lss-err { color: #fca5a5; font-size: 11.5px; }
.lss-toast {
  position: fixed; right: 18px; bottom: 18px; z-index: 2147483647; max-width: 320px;
  background: #0f172a; color: #f8fafc; padding: 9px 13px; border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, .35); transition: opacity .3s; opacity: 0; pointer-events: none;
}
.lss-toast.lss-show { opacity: 1; }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.documentElement.appendChild(style);
}

export function showToast(text) {
  ensureStyle();
  let host = document.querySelector(".lss-toast");
  if (!host) {
    host = document.createElement("div");
    host.className = "lss-toast";
    host.setAttribute("data-lss", "");
    document.documentElement.appendChild(host);
  }
  host.textContent = text;
  host.classList.add("lss-show");
  clearTimeout(host._t);
  host._t = setTimeout(() => host.classList.remove("lss-show"), 2400);
}

function button(label, onClick, className) {
  const b = document.createElement("button");
  b.textContent = label;
  if (className) b.className = className;
  b.addEventListener("click", onClick);
  return b;
}

function badge(text, className) {
  const span = document.createElement("span");
  span.className = `lss-badge${className ? ` ${className}` : ""}`;
  span.textContent = text;
  return span;
}

/**
 * handlers: { onSkip(read), onAutoSkip(bool), onAnalyze(), onPaste(text),
 *             onReanalyze(), onCompare(), onClose() }
 */
export function createPanel(handlers = {}) {
  ensureStyle();
  const root = document.createElement("div");
  root.id = "lss-panel";
  root.setAttribute("data-lss", "");

  const header = document.createElement("header");
  const title = document.createElement("h2");
  title.textContent = "⏭️ Laya Sponsor Skip";
  const modelBadge = badge("model: ?");
  const close = document.createElement("button");
  close.className = "lss-x";
  close.title = "Hide until the next video";
  close.textContent = "×";
  close.addEventListener("click", () => handlers.onClose?.());
  header.append(title, modelBadge, close);
  root.appendChild(header);

  const body = document.createElement("div");
  body.className = "lss-body";
  root.appendChild(body);

  const statusLine = document.createElement("div");
  statusLine.className = "lss-muted";
  body.appendChild(statusLine);

  const controls = document.createElement("div");
  controls.className = "lss-row";
  const autoLabel = document.createElement("label");
  autoLabel.className = "lss-row";
  const autoToggle = document.createElement("input");
  autoToggle.type = "checkbox";
  autoToggle.addEventListener("change", () => handlers.onAutoSkip?.(autoToggle.checked));
  const autoText = document.createElement("span");
  autoText.className = "lss-muted";
  autoText.textContent = "auto-skip while I hear a read";
  autoLabel.append(autoToggle, autoText);
  controls.appendChild(autoLabel);
  body.appendChild(controls);

  const readsBox = document.createElement("div");
  readsBox.className = "lss-reads";
  body.appendChild(readsBox);

  const empty = document.createElement("div");
  empty.className = "lss-muted";
  empty.textContent = "Nothing yet — play the video with captions on, or paste a transcript.";
  body.appendChild(empty);

  const actions = document.createElement("div");
  actions.className = "lss-row";
  const analyze = button("Analyze captured", () => handlers.onAnalyze?.(), "lss-primary");
  const paste = button("Paste transcript", () => {
    const text = prompt("Paste a transcript (with or without timestamps):");
    if (text && text.trim()) handlers.onPaste?.(text);
  });
  const reanalyze = button("Re-analyze", () => handlers.onReanalyze?.());
  const compare = button("Compare with SponsorBlock", () => handlers.onCompare?.());
  const clear = button("Clear", () => handlers.onClear?.());
  actions.append(analyze, paste, reanalyze, compare, clear);
  body.appendChild(actions);

  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "Every decision";
  const logBox = document.createElement("div");
  logBox.className = "lss-log";
  details.append(summary, logBox);
  body.appendChild(details);

  const errorLine = document.createElement("div");
  errorLine.className = "lss-err";
  body.appendChild(errorLine);

  document.documentElement.appendChild(root);

  let lastLog = "";

  function renderLog(entries, model) {
    const shown = entries.slice(-60);
    const key = `${shown.length}:${shown[shown.length - 1]?.p ?? ""}:${model ?? ""}`;
    if (key === lastLog) return;
    lastLog = key;
    logBox.replaceChildren();
    for (const entry of shown) {
      const row = document.createElement("div");
      const verdict = document.createElement("span");
      if (entry.verdict === "yes") verdict.className = "lss-yes";
      else if (entry.verdict === "no") verdict.className = "lss-no";
      else verdict.className = "lss-warn";
      const where = entry.at ? `${entry.kind} ${entry.line != null ? `L${String(entry.line).padStart(3, "0")}` : ""} ${entry.at}` : entry.kind;
      const p = typeof entry.p === "number" ? ` p=${entry.p.toFixed(3)}` : "";
      const extra = entry.verdict && typeof entry.p !== "number" ? ` ${entry.verdict}` : "";
      const ms = entry.ms ? ` ${entry.ms}ms` : "";
      verdict.textContent = `${where}${p}${extra}${ms}`;
      row.appendChild(verdict);
      logBox.appendChild(row);
    }
  }

  function renderReads(reads) {
    readsBox.replaceChildren();
    for (const read of reads) {
      const row = document.createElement("div");
      row.className = `lss-read${read.open ? " lss-open" : ""}`;
      const times = document.createElement("div");
      times.className = "lss-times";
      const strong = document.createElement("b");
      strong.textContent = read.open ? `${msToLabel(read.startMs)} – …` : `${msToLabel(read.startMs)} – ${msToLabel(read.endMs)}`;
      const meta = document.createElement("div");
      meta.className = "lss-muted";
      const seconds = Math.round((read.open ? read.elapsedMs ?? 0 : read.durationMs ?? 0) / 1000);
      const status = read.skipped ? " · skipped" : read.past ? " · behind us" : "";
      meta.textContent = `${seconds}s${read.startLine ? ` · L${String(read.startLine).padStart(3, "0")}–L${String(read.endLine ?? read.startLine).padStart(3, "0")}` : ""}${status}`;
      times.append(strong, meta);
      const p = document.createElement("span");
      p.className = "lss-p";
      p.textContent = `P ${(read.confidence ?? 0).toFixed(2)}`;
      const skip = button(read.open ? "Skip 10 s" : "Skip", () => handlers.onSkip?.(read), read.open ? "" : "lss-primary");
      skip.disabled = !!(read.skipped || read.past);
      row.append(times, p, skip);
      readsBox.appendChild(row);
    }
  }

  let visible = true;
  return {
    el: root,
    isVisible: () => visible,
    show() {
      visible = true;
      root.style.display = "";
    },
    hide() {
      visible = false;
      root.style.display = "none";
    },
    destroy() {
      root.remove();
      document.getElementById(STYLE_ID)?.remove();
    },
    setError(message) {
      errorLine.textContent = message || "";
    },
    render(state = {}) {
      const { model, heuristic, source, capturedLines, capturedMs, reads = [], log = [], settings = {}, skippedTotal, stats } = state;
      modelBadge.textContent = `model: ${model ?? "…"}`;
      modelBadge.className = `lss-badge${heuristic ? " lss-heuristic" : ""}`;
      const sourceLabel = !source ? "live captions" : source === "live" ? "live captions" : source;
      const parts = [];
      parts.push(`${sourceLabel}: ${capturedLines ?? 0} lines / ${msToLabel(capturedMs ?? 0)}`);
      if (stats) parts.push(`skipped: ${stats.skippedHere ?? 0} here, ${skippedTotal ?? stats.skippedTotal ?? 0} total`);
      statusLine.textContent = parts.join(" · ");
      autoToggle.checked = !!settings.autoSkip;
      autoText.textContent = `auto-skip while I hear a read (jump ${Math.round((settings.stepMs ?? 10000) / 1000)} s)`;
      renderReads(reads);
      empty.style.display = reads.length ? "none" : "";
      renderLog(log, model);
    },
  };
}
