"use strict";

const captureButton = document.getElementById("captureButton");
const readButton = document.getElementById("readButton");
const exportButton = document.getElementById("exportButton");
const clearButton = document.getElementById("clearButton");
const preview = document.getElementById("preview");
const status = document.getElementById("status");
let evidence = null;

function setStatus(message, tone = "") {
  status.textContent = message;
  status.className = tone;
}

function money(value) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number(value) || 0);
}

function parseResponse(capture) {
  try { return JSON.parse(capture?.responseText || ""); } catch { return null; }
}

function buildEvidence({ networkCaptures = [], tableCapture = null }) {
  const networkRows = networkCaptures.flatMap((capture) => K2_GM_BRIDGE.rowsFromPayload(parseResponse(capture)));
  const positions = K2_GM_BRIDGE.normalizeRows([...networkRows, ...(tableCapture?.rows || [])]);
  return {
    schema: "k2-gm-portfolio-evidence-v1",
    generatedAt: new Date().toISOString(),
    sourcePage: tableCapture?.page || "https://gmglobal.org/#/Portfolio",
    sourceEndpoints: [...new Set([...networkCaptures.map((capture) => capture.url), ...(tableCapture?.endpoints || [])])],
    normalizedPositions: positions,
    renderedTable: tableCapture,
    networkCaptures: networkCaptures.map((capture) => ({
      url: capture.url,
      method: capture.method,
      status: capture.status,
      contentType: capture.contentType,
      transport: capture.transport,
      capturedAt: capture.capturedAt,
      truncated: capture.truncated,
      response: parseResponse(capture) || capture.responseText
    }))
  };
}

function renderEvidence() {
  const positions = evidence?.normalizedPositions || [];
  const endpoint = evidence?.sourceEndpoints?.[0];
  preview.hidden = false;
  preview.innerHTML = `<p><b>${positions.length} normalized open futures</b><br>${evidence.networkCaptures.length} portfolio response${evidence.networkCaptures.length === 1 ? "" : "s"} captured · ${evidence.renderedTable?.rows?.length || 0} rendered rows.</p>${endpoint ? `<code>${endpoint}</code>` : "<code>No endpoint response captured yet—arm capture and reload GM.</code>"}${positions.map((item) => `<article><b>${item.symbol} · ${item.position.toUpperCase()} ${item.quantity}</b><strong>${money(item.price)}</strong><small>Bought ${item.buyQuantity} @ ${money(item.buyAverage)} · Sold ${item.sellQuantity} @ ${money(item.sellAverage)} · MTM ${money(item.mtm)}</small></article>`).join("")}`;
  exportButton.disabled = !positions.length && !evidence.networkCaptures.length;
}

async function activeGmTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https:\/\/gmglobal\.org\//i.test(tab.url || "")) throw new Error("Open the GM Global Portfolio tab first.");
  return tab;
}

async function readRenderedTable() {
  const tab = await activeGmTab();
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    func: async () => {
      const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
      const tableNode = document.querySelector("#load_data");
      if (!tableNode) throw new Error("GM Portfolio table is not visible. Open #/Portfolio and wait for it to load.");
      const jq = window.jQuery;
      let table = null;
      try { if (jq?.fn?.DataTable?.isDataTable?.("#load_data")) table = jq("#load_data").DataTable(); } catch { table = null; }
      if (table) {
        const info = table.page.info();
        if (info.recordsDisplay > info.end && info.recordsDisplay <= 5000) {
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, 6000);
            table.one("draw.dt", () => { clearTimeout(timer); resolve(); });
            table.page.len(-1).draw();
          });
          await wait(200);
        }
      }
      const headers = [...tableNode.querySelectorAll("thead th")].map((cell) => cell.innerText.replace(/\s+/g, " ").trim());
      const rows = [...tableNode.querySelectorAll("tbody tr")].map((row) => [...row.querySelectorAll("td")].map((cell) => cell.innerText.replace(/\s+/g, " ").trim()));
      const endpoints = performance.getEntriesByType("resource").map((entry) => entry.name)
        .filter((url) => /(?:position_book|position_report|portfolio)/i.test(url))
        .map((url) => { try { const parsed = new URL(url); return `${parsed.origin}${parsed.pathname}`; } catch { return url; } })
        .filter((url, index, values) => values.indexOf(url) === index);
      return { headers, rows, endpoints, capturedAt: new Date().toISOString(), page: location.href };
    }
  });
  return result;
}

async function refreshEvidence(tableCapture = null) {
  const stored = await chrome.storage.local.get(["networkCaptures", "tableCapture"]);
  if (tableCapture) await chrome.storage.local.set({ tableCapture });
  evidence = buildEvidence({ networkCaptures: stored.networkCaptures || [], tableCapture: tableCapture || stored.tableCapture || null });
  renderEvidence();
}

captureButton.addEventListener("click", async () => {
  captureButton.disabled = true;
  try {
    const tab = await activeGmTab();
    await chrome.storage.local.remove(["networkCaptures", "tableCapture"]);
    setStatus("Capture armed. GM is reloading; wait for the Portfolio table, then reopen this extension.", "good");
    await chrome.tabs.reload(tab.id, { bypassCache: true });
    window.close();
  } catch (error) {
    setStatus(error.message || "Could not reload GM.", "error");
    captureButton.disabled = false;
  }
});

readButton.addEventListener("click", async () => {
  readButton.disabled = true;
  setStatus("Reading the current GM table after its live updates…");
  try {
    const tableCapture = await readRenderedTable();
    await refreshEvidence(tableCapture);
    setStatus(`Extracted ${evidence.normalizedPositions.length} positions. Export the JSON and verify it before integration.`, "good");
  } catch (error) {
    setStatus(error.message || "Could not read the GM table.", "error");
  } finally {
    readButton.disabled = false;
  }
});

exportButton.addEventListener("click", () => {
  if (!evidence) return;
  const blob = new Blob([JSON.stringify(evidence, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `k2-gm-portfolio-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus("Evidence JSON exported with endpoint response, rendered table and normalized positions.", "good");
});

clearButton.addEventListener("click", async () => {
  await chrome.storage.local.clear();
  evidence = null;
  preview.hidden = true;
  exportButton.disabled = true;
  setStatus("Stored GM capture cleared.");
});

refreshEvidence().then(() => {
  if (evidence.networkCaptures.length) setStatus("A GM portfolio response is captured. Read the current table, then export JSON.", "good");
}).catch(() => {});
