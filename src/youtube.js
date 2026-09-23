// Everything that touches the YouTube page itself.
//
// A content script lives in its own JavaScript world: it can read the DOM and
// click things, but it cannot call the player's own methods (`getPlayerResponse`
// and friends live in the page's world). So nothing here goes through the player
// object — we work with the <video> element, the caption elements YouTube has
// already rendered, and plain DOM clicks. That keeps the extension on the safe
// side of the page: it never patches anything, it only reads and seeks.

export const WATCH_RE = /^\/(watch|shorts|live|embed)\b/;

/**
 * The video id from a watch URL, or null.
 *
 * The path forms are unambiguous, and the manifest already scopes the content
 * script to youtube.com, so the host is only checked where it is part of the
 * address (youtu.be). That also lets the harness drive the script on a local page.
 */
export function parseVideoId(url = location.href) {
  try {
    const u = new URL(url, location.origin);
    if (u.hostname === "youtu.be") return u.pathname.slice(1).split("/")[0] || null;
    if (u.pathname === "/watch") return u.searchParams.get("v");
    const m = u.pathname.match(/^\/(shorts|live|embed)\/([\w-]{6,})/);
    return m ? m[2] : null;
  } catch {
    return null;
  }
}

export function isWatchPage(url = location.href) {
  const id = parseVideoId(url);
  if (!id) return false;
  try {
    return WATCH_RE.test(new URL(url, location.origin).pathname);
  } catch {
    return false;
  }
}

export function videoEl() {
  return document.querySelector("video.html5-main-video") || document.querySelector("video");
}

export function currentTimeMs() {
  const v = videoEl();
  return v && Number.isFinite(v.currentTime) ? Math.round(v.currentTime * 1000) : 0;
}

export function durationMs() {
  const v = videoEl();
  return v && Number.isFinite(v.duration) ? Math.round(v.duration * 1000) : 0;
}

export function isPlaying() {
  const v = videoEl();
  return !!v && !v.paused && !v.ended;
}

/** Seek. Code owns the target; the caller decides whether it is safe. */
export function seekToMs(ms) {
  const v = videoEl();
  if (!v || !Number.isFinite(ms)) return false;
  const max = Number.isFinite(v.duration) && v.duration > 0 ? v.duration - 0.5 : Infinity;
  v.currentTime = Math.max(0, Math.min(ms / 1000, max));
  return true;
}

export function captionsEnabled() {
  const button = document.querySelector(".ytp-subtitles-button");
  if (button) return button.getAttribute("aria-pressed") === "true";
  return !!document.querySelector(".ytp-caption-segment");
}

/** Turn the video's own captions on, which is where our transcript comes from. */
export function enableCaptions() {
  if (captionsEnabled()) return false;
  const button = document.querySelector(".ytp-subtitles-button");
  if (!button) return false;
  button.click();
  return true;
}

/** The caption line that is on screen right now (empty while nobody speaks). */
export function captionText() {
  const segments = document.querySelectorAll(".ytp-caption-window-container .ytp-caption-segment");
  if (!segments.length) return "";
  return [...segments].map((el) => el.textContent || "").join(" ").replace(/\s+/g, " ").trim();
}

export function videoMeta() {
  const title =
    document.querySelector("h1.ytd-watch-metadata yt-formatted-string")?.textContent?.trim() ||
    document.querySelector('meta[name="title"]')?.getAttribute("content")?.trim() ||
    document.title.replace(/\s*-\s*YouTube\s*$/, "").trim();
  const channel =
    document.querySelector("ytd-channel-name a")?.textContent?.trim() ||
    document.querySelector('link[itemprop="name"]')?.getAttribute("content")?.trim() ||
    document.querySelector('meta[itemprop="author"]')?.getAttribute("content")?.trim() ||
    "";
  return { videoId: parseVideoId(), title, channel, durationMs: durationMs() };
}

/** Fire `cb` whenever YouTube swaps in another video (it is a SPA). */
export function onNavigate(cb) {
  let last = location.href;
  const handler = () => {
    if (location.href === last) return;
    last = location.href;
    cb();
  };
  document.addEventListener("yt-navigate-finish", handler);
  document.addEventListener("yt-page-data-updated", handler);
  const timer = setInterval(handler, 1000);
  return () => {
    document.removeEventListener("yt-navigate-finish", handler);
    document.removeEventListener("yt-page-data-updated", handler);
    clearInterval(timer);
  };
}
