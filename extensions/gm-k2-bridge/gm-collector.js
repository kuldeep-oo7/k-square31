"use strict";

window.addEventListener("message", async (event) => {
  if (event.source !== window || event.origin !== location.origin) return;
  const message = event.data;
  if (message?.source !== "k2-gm-extractor" || message.type !== "portfolio-response") return;
  const capture = message.payload;
  if (!capture || !/^https:\/\/gmglobal\.org\//i.test(capture.url || "")) return;
  const { networkCaptures = [] } = await chrome.storage.local.get("networkCaptures");
  const next = [capture, ...networkCaptures.filter((item) => !(item.url === capture.url && item.responseText === capture.responseText))].slice(0, 8);
  await chrome.storage.local.set({ networkCaptures: next, lastNetworkCaptureAt: capture.capturedAt });
  try { await chrome.runtime.sendMessage({ type: "portfolio-capture", capture }); } catch { /* background may be restarting */ }
});
