const DEFAULTS = {
  enabled: true,
  autoSkip: false,
  threshold: 0.7,
  cutThreshold: 0.8,
  minReadSeconds: 20,
  maxReadSeconds: 180,
  maxReads: 6,
  stepSeconds: 10,
  enableCaptions: true,
  toast: true,
  serverUrl: "http://127.0.0.1:8765/judge",
};

const $ = (id) => document.getElementById(id);

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function loadStats() {
  const { totalSkipped = 0 } = await chrome.storage.local.get({ totalSkipped: 0 });
  $("statTotal").textContent = totalSkipped;
  const tab = await activeTab();
  if (!tab?.id) return;
  try {
    const s = await chrome.tabs.sendMessage(tab.id, { type: "getStats" });
    $("statPage").textContent = s?.skippedHere ?? 0;
    $("pageStatus").textContent = s?.lines ? `${s.reads} read(s) · ${s.lines} lines · ${s.model ?? "model ?"}` : "";
    $("pageStatus").className = "hint";
    if (s?.lastError) {
      $("serverStatus").textContent = `Judge: ${s.lastError}`;
      $("serverStatus").className = "hint error";
    }
  } catch {
    $("pageStatus").textContent = "Not a YouTube watch page.";
  }
}

async function init() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  $("enabled").checked = s.enabled;
  $("serverUrl").value = s.serverUrl;
  $("autoSkip").checked = s.autoSkip;
  $("enableCaptions").checked = s.enableCaptions;
  $("toast").checked = s.toast;
  $("threshold").value = s.threshold;
  $("thresholdValue").textContent = Number(s.threshold).toFixed(2);
  $("cutThreshold").value = s.cutThreshold;
  $("cutValue").textContent = Number(s.cutThreshold).toFixed(2);
  $("minReadSeconds").value = s.minReadSeconds;
  $("maxReadSeconds").value = s.maxReadSeconds;
  $("maxReads").value = s.maxReads;
  $("stepSeconds").value = s.stepSeconds;
  await loadStats();
}

const save = (patch) => chrome.storage.sync.set(patch);

$("enabled").addEventListener("change", (e) => save({ enabled: e.target.checked }));
$("autoSkip").addEventListener("change", (e) => save({ autoSkip: e.target.checked }));
$("enableCaptions").addEventListener("change", (e) => save({ enableCaptions: e.target.checked }));
$("toast").addEventListener("change", (e) => save({ toast: e.target.checked }));

$("threshold").addEventListener("input", (e) => {
  $("thresholdValue").textContent = Number(e.target.value).toFixed(2);
});
$("threshold").addEventListener("change", (e) => save({ threshold: Number(e.target.value) }));
$("cutThreshold").addEventListener("input", (e) => {
  $("cutValue").textContent = Number(e.target.value).toFixed(2);
});
$("cutThreshold").addEventListener("change", (e) => save({ cutThreshold: Number(e.target.value) }));

for (const [id, key] of [
  ["minReadSeconds", "minReadSeconds"],
  ["maxReadSeconds", "maxReadSeconds"],
  ["maxReads", "maxReads"],
  ["stepSeconds", "stepSeconds"],
]) {
  $(id).addEventListener("change", (e) => {
    const value = Number(e.target.value);
    if (Number.isFinite(value)) save({ [key]: value });
  });
}

let urlTimer = null;
$("serverUrl").addEventListener("input", (e) => {
  clearTimeout(urlTimer);
  const serverUrl = e.target.value.trim();
  urlTimer = setTimeout(() => save({ serverUrl }), 300);
});

$("testServer").addEventListener("click", async () => {
  $("serverStatus").textContent = "Checking…";
  $("serverStatus").className = "hint";
  const res = await chrome.runtime.sendMessage({ type: "testServer" });
  if (res?.error) {
    $("serverStatus").textContent = `Error: ${res.error} — is the judge server running?`;
    $("serverStatus").className = "hint error";
  } else {
    const info = res?.server ?? {};
    $("serverStatus").textContent = `OK – model: ${info.model ?? "local"} (${info.latencyMs ?? "?"} ms)`;
    $("serverStatus").className = "hint ok";
  }
});

$("reanalyze").addEventListener("click", async () => {
  const tab = await activeTab();
  if (!tab?.id) return;
  const res = await chrome.tabs.sendMessage(tab.id, { type: "reanalyze" }).catch((err) => ({ error: String(err) }));
  $("pageStatus").textContent = res?.error ? `Error: ${res.error}` : "Re-analyzing…";
  setTimeout(loadStats, 2500);
});

init();
