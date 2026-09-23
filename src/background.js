// MV3 service worker: the only place that talks to the local judge server, plus
// the badge and the running total. The content script never needs to know where
// the server is or how a request is shaped.

import { checkServer, DEFAULT_MODEL, judgeBatch } from "./laya.js";
import { sponsorBlockSegments } from "./sponsorblock.js";

const DEFAULTS = {
  enabled: true,
  autoSkip: false,
  serverUrl: "http://127.0.0.1:8765/judge",
};

async function getSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
}

/** The health endpoint sits next to the judge endpoint on the same server. */
function healthUrlFor(serverUrl) {
  return String(serverUrl || DEFAULTS.serverUrl).replace(/\/judge\/?$/, "/health");
}

const badgeCounts = new Map(); // tabId -> reads skipped on the current page

async function setBadge(tabId, count) {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#e11d48" });
    await chrome.action.setBadgeText({ tabId, text: count > 0 ? String(count) : "" });
  } catch {
    // the tab may be gone
  }
}

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") {
    badgeCounts.delete(tabId);
    setBadge(tabId, 0);
  }
});
chrome.tabs.onRemoved.addListener((tabId) => badgeCounts.delete(tabId));

async function addToTotal(n) {
  const { totalSkipped = 0 } = await chrome.storage.local.get({ totalSkipped: 0 });
  await chrome.storage.local.set({ totalSkipped: totalSkipped + n });
  return totalSkipped + n;
}

const handlers = {
  /** One batch of questions to the local server; the content script does the decoding. */
  async judge(msg) {
    const { serverUrl } = await getSettings();
    const result = await judgeBatch({
      state: msg.state,
      candidates: msg.candidates,
      questions: msg.questions,
      model: msg.model ?? DEFAULT_MODEL,
      endpoint: serverUrl,
    });
    return result;
  },

  async testServer() {
    const { serverUrl } = await getSettings();
    return { server: await checkServer({ endpoint: healthUrlFor(serverUrl) }) };
  },

  async skipped(msg, sender) {
    const tabId = sender.tab?.id;
    if (tabId != null && msg.count > 0) {
      const next = (badgeCounts.get(tabId) ?? 0) + msg.count;
      badgeCounts.set(tabId, next);
      await setBadge(tabId, next);
    }
    const totalSkipped = msg.count > 0 ? await addToTotal(msg.count) : (await chrome.storage.local.get({ totalSkipped: 0 })).totalSkipped;
    return { ok: true, totalSkipped };
  },

  async sponsorblock(msg) {
    return { segments: await sponsorBlockSegments(msg.videoId) };
  },

  async stats() {
    const { totalSkipped = 0 } = await chrome.storage.local.get({ totalSkipped: 0 });
    return { totalSkipped };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) {
    sendResponse({ error: `Unknown message type: ${msg?.type}` });
    return false;
  }
  handler(msg, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: err?.message ?? String(err) }));
  return true; // keep the channel open for the async response
});
