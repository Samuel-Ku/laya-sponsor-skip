// Manifest V3 content scripts are classic scripts, so this file only exists to
// pull the real module in. Everything else lives in ES modules, which means the
// same files run in the page, in the service worker and under `node --test`.
import(chrome.runtime.getURL("src/content.js")).catch((err) => {
  console.warn("[lss] could not start:", err);
});
