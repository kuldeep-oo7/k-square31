"use strict";

const captureButton = document.getElementById("captureButton");
const readButton = document.getElementById("readButton");
const exportButton = document.getElementById("exportButton");
const clearButton = document.getElementById("clearButton");
const preview = document.getElementById("preview");
const status = document.getElementById("status");
const pairButton = document.getElementById("pairButton");
const syncNowButton = document.getElementById("syncNowButton");
const autoSync = document.getElementById("autoSync");
const intervalMinutes = document.getElementById("intervalMinutes");
const pairState = document.getElementById("pairState");
const lastSync = document.getElementById("lastSync");
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

function syncTime(value) {
  const date = new Date(value || "");
  return Number.isFinite(date.getTime()) ? date.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "Not synchronized yet";
}

function renderLastSync(value) {
  lastSync.className = value?.ok === true ? "good" : value?.ok === false ? "error" : "";
  if (value?.syncing) lastSync.textContent = "Synchronizing GM → K² now…";
  else if (value?.ok) lastSync.textContent = `Last success: ${syncTime(value.at)} · ${value.count} open positions`;
  else if (value?.error) lastSync.textContent = `Last attempt: ${syncTime(value.at)} · ${value.error}`;
  else lastSync.textContent = "Not synchronized yet.";
}

async function refreshSyncControls() {
  const stored = await chrome.storage.local.get(["deviceToken", "autoSync", "intervalMinutes", "lastSync"]);
  const paired = Boolean(stored.deviceToken);
  pairState.textContent = paired
    ? "Connected securely to the Kamlesh K² account. Portfolio snapshots now upload automatically."
    : "Connect the Kamlesh K² account once. No repeated JSON exports are needed.";
  pairButton.textContent = paired ? "Reconnect K²" : "Connect K² once";
  syncNowButton.disabled = !paired;
  autoSync.checked = stored.autoSync !== false;
  intervalMinutes.value = String([30, 60].includes(Number(stored.intervalMinutes)) ? Number(stored.intervalMinutes) : 30);
  renderLastSync(stored.lastSync);
}

async function waitForTab(tabId) {
  const current = await chrome.tabs.get(tabId);
  if (current.status === "complete") return current;
  return new Promise((resolve) => {
    const listener = (updatedId, info, tab) => {
      if (updatedId === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(tab);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function k2Tab() {
  const tabs = await chrome.tabs.query({ url: "https://k-square31.vercel.app/*" });
  if (tabs[0]) return tabs[0];
  return chrome.tabs.create({ url: "https://k-square31.vercel.app", active: false });
}

async function issueDeviceToken(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async () => {
      try {
        const authResponse = await fetch("/api/auth", { credentials: "same-origin", cache: "no-store" });
        const session = await authResponse.json().catch(() => ({}));
        if (!authResponse.ok || !session.authenticated) return { ok: false, error: "Sign in to the Kamlesh K² account in this tab, then press Connect again." };
        const response = await fetch("/api/gm-sync", {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "Content-Type": "application/json", "X-K2-CSRF": session.csrf },
          body: JSON.stringify({ action: "issue-device-token" })
        });
        const data = await response.json().catch(() => ({}));
        return response.ok ? { ok: true, token: data.token, username: data.username } : { ok: false, error: data.error || `K² returned HTTP ${response.status}` };
      } catch (error) {
        return { ok: false, error: String(error?.message || error) };
      }
    }
  });
  return result;
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
  await chrome.storage.local.remove(["networkCaptures", "tableCapture", "lastNetworkCaptureAt"]);
  evidence = null;
  preview.hidden = true;
  exportButton.disabled = true;
  setStatus("Stored GM capture cleared.");
});

pairButton.addEventListener("click", async () => {
  pairButton.disabled = true;
  setStatus("Connecting through your signed-in K² tab…");
  try {
    const tab = await k2Tab();
    await waitForTab(tab.id);
    const result = await issueDeviceToken(tab.id);
    if (!result?.ok || !result.token) {
      await chrome.tabs.update(tab.id, { active: true });
      throw new Error(result?.error || "K² pairing failed.");
    }
    await chrome.storage.local.set({ deviceToken: result.token, autoSync: true, intervalMinutes: Number(intervalMinutes.value) || 30 });
    await chrome.runtime.sendMessage({ type: "configure-sync" });
    await refreshSyncControls();
    setStatus("Connected. The first automatic portfolio sync is starting now.", "good");
    chrome.runtime.sendMessage({ type: "sync-now" }).catch(() => {});
  } catch (error) {
    setStatus(error.message || "Could not connect K².", "error");
  } finally {
    pairButton.disabled = false;
  }
});

syncNowButton.addEventListener("click", async () => {
  syncNowButton.disabled = true;
  renderLastSync({ syncing: true });
  setStatus("GM is opening in an inactive tab. This can take up to 45 seconds.");
  try {
    const result = await chrome.runtime.sendMessage({ type: "sync-now" });
    if (!result?.ok) throw new Error(result?.error || "Automatic sync failed.");
    await refreshSyncControls();
    setStatus("GM portfolio synchronized with K².", "good");
  } catch (error) {
    setStatus(error.message || "Automatic sync failed.", "error");
    await refreshSyncControls();
  } finally {
    const stored = await chrome.storage.local.get("deviceToken");
    syncNowButton.disabled = !stored.deviceToken;
  }
});

async function saveSchedule() {
  await chrome.storage.local.set({ autoSync: autoSync.checked, intervalMinutes: Number(intervalMinutes.value) || 30 });
  await chrome.runtime.sendMessage({ type: "configure-sync" });
  setStatus(autoSync.checked ? `Automatic sync set to every ${intervalMinutes.value} minutes.` : "Automatic sync paused.", "good");
}

autoSync.addEventListener("change", saveSchedule);
intervalMinutes.addEventListener("change", saveSchedule);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.lastSync) renderLastSync(changes.lastSync.newValue);
});

Promise.all([refreshEvidence(), refreshSyncControls()]).then(() => {
  if (evidence.networkCaptures.length) setStatus("A GM portfolio response is captured. Read the current table, then export JSON.", "good");
}).catch(() => {});
