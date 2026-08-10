"use strict";

importScripts("core.js");

const GM_PORTFOLIO_URL = "https://gmglobal.org/#/Portfolio";
const K2_SYNC_URL = "https://k-square31.vercel.app/api/gm-sync";
const DEFAULT_INTERVAL_MINUTES = 30;
const captureWaiters = new Map();
let runningSync = null;

function message(error) {
  return String(error?.message || error || "Unknown synchronization error").slice(0, 240);
}

async function settings() {
  const stored = await chrome.storage.local.get(["autoSync", "intervalMinutes", "deviceToken"]);
  return {
    autoSync: stored.autoSync !== false,
    intervalMinutes: [30, 60].includes(Number(stored.intervalMinutes)) ? Number(stored.intervalMinutes) : DEFAULT_INTERVAL_MINUTES,
    deviceToken: String(stored.deviceToken || "")
  };
}

async function recordStatus(status) {
  const value = { ...status, at: new Date().toISOString() };
  await chrome.storage.local.set({ lastSync: value });
  try { await chrome.runtime.sendMessage({ type: "sync-status", status: value }); } catch { /* popup is usually closed */ }
  return value;
}

async function configureAlarm() {
  const config = await settings();
  await chrome.alarms.clear("k2-gm-portfolio-sync");
  if (config.autoSync) {
    chrome.alarms.create("k2-gm-portfolio-sync", {
      delayInMinutes: config.deviceToken ? 0.5 : config.intervalMinutes,
      periodInMinutes: config.intervalMinutes
    });
  }
}

function parseCapture(capture) {
  let payload;
  try { payload = JSON.parse(capture?.responseText || ""); } catch { payload = null; }
  const rows = K2_GM_BRIDGE.rowsFromPayload(payload);
  return K2_GM_BRIDGE.normalizeRows([...rows, ...(capture?.tableRows || [])]);
}

async function holdingsFingerprint(positions) {
  const canonical = positions.map((item) => ({
    symbol: item.symbol,
    position: item.position,
    expiry: item.expiry,
    quantity: item.quantity,
    price: item.price,
    buyQuantity: item.buyQuantity || 0,
    buyAverage: item.buyAverage || 0,
    sellQuantity: item.sellQuantity || 0,
    sellAverage: item.sellAverage || 0
  })).sort((left, right) => `${left.symbol}|${left.expiry}|${left.position}`.localeCompare(`${right.symbol}|${right.expiry}|${right.position}`));
  const bytes = new TextEncoder().encode(JSON.stringify(canonical));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function uploadCapture(capture, reason) {
  const config = await settings();
  if (!config.deviceToken) throw new Error("Connect the extension to the Kamlesh K² account once.");
  const positions = parseCapture(capture);
  if (!capture.tableFound) throw new Error("GM Portfolio did not render. Sign in to GM and confirm that Portfolio is visible.");
  const snapshotId = await holdingsFingerprint(positions);
  const response = await fetch(K2_SYNC_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.deviceToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      action: "sync-broker-portfolio",
      snapshotId,
      capturedAt: capture.capturedAt || new Date().toISOString(),
      sourceEndpoint: capture.url,
      reason,
      positions
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `K² sync returned HTTP ${response.status}`);
  await recordStatus({ ok: true, count: positions.length, snapshotId, updatedAt: result.updatedAt, reason });
  return result;
}

function waitForCapture(tabId, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      captureWaiters.delete(tabId);
      reject(new Error("GM did not return the portfolio within 45 seconds. Sign in to GM again."));
    }, timeoutMs);
    captureWaiters.set(tabId, {
      resolve(capture) {
        clearTimeout(timer);
        captureWaiters.delete(tabId);
        resolve(capture);
      }
    });
  });
}

async function readRenderedTable(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async () => {
      const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
      for (let attempt = 0; attempt < 20 && !document.querySelector("#load_data tbody tr"); attempt += 1) await wait(250);
      const tableNode = document.querySelector("#load_data");
      if (!tableNode) return { found: false, rows: [] };
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
          await wait(250);
        }
      }
      return { found: true, rows: [...tableNode.querySelectorAll("tbody tr")].map((row) => [...row.querySelectorAll("td")].map((cell) => cell.innerText.replace(/\s+/g, " ").trim())) };
    }
  });
  return result?.found ? result : { found: false, rows: [] };
}

async function waitForTabComplete(tabId, timeoutMs = 30000) {
  const current = await chrome.tabs.get(tabId);
  if (current.status === "complete") return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("GM Portfolio did not finish loading."));
    }, timeoutMs);
    const listener = (updatedId, info) => {
      if (updatedId !== tabId || info.status !== "complete") return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function requestPositionReport(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      const button = [...document.querySelectorAll("button,input[type=button],input[type=submit]")].find((node) => {
        const label = String(node.innerText || node.value || "").replace(/\s+/g, " ").trim().toUpperCase();
        return label === "GET POSITION";
      });
      if (!button || button.disabled) return false;
      button.click();
      return true;
    }
  });
  return Boolean(result);
}

async function captureFreshPortfolio() {
  const gmTabs = await chrome.tabs.query({ url: "https://gmglobal.org/*" });
  let tab = gmTabs.find((candidate) => /#\/Portfolio(?:$|[/?])/i.test(candidate.url || ""));
  let temporary = false;
  if (!tab) {
    tab = await chrome.tabs.create({ url: GM_PORTFOLIO_URL, active: false });
    temporary = true;
  }
  try {
    await waitForTabComplete(tab.id);
    await requestPositionReport(tab.id);
    await new Promise((resolve) => setTimeout(resolve, 2200));
    const table = await readRenderedTable(tab.id);
    return {
      url: "https://gmglobal.org/datatables/position_book_list.php",
      method: "RENDERED TABLE",
      capturedAt: new Date().toISOString(),
      tableRows: table.rows,
      tableFound: table.found
    };
  } finally {
    if (temporary) {
      captureWaiters.delete(tab.id);
      try { await chrome.tabs.remove(tab.id); } catch { /* tab may have been closed by the user */ }
    }
  }
}

async function performSync(reason = "scheduled") {
  if (runningSync) return runningSync;
  runningSync = (async () => {
    const config = await settings();
    if (!config.autoSync && reason === "scheduled") return null;
    if (!config.deviceToken) {
      await recordStatus({ ok: false, needsPairing: true, error: "Connect K² once to enable automatic sync.", reason });
      return null;
    }
    await recordStatus({ ok: null, syncing: true, reason });
    try {
      const capture = await captureFreshPortfolio();
      return await uploadCapture(capture, reason);
    } catch (error) {
      await recordStatus({ ok: false, error: message(error), reason });
      throw error;
    }
  })().finally(() => { runningSync = null; });
  return runningSync;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(["autoSync", "intervalMinutes"]).then((stored) => chrome.storage.local.set({
    autoSync: stored.autoSync !== false,
    intervalMinutes: [30, 60].includes(Number(stored.intervalMinutes)) ? Number(stored.intervalMinutes) : DEFAULT_INTERVAL_MINUTES
  })).then(configureAlarm);
});

chrome.runtime.onStartup.addListener(() => configureAlarm().then(() => performSync("browser-start")).catch(() => {}));

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "k2-gm-portfolio-sync") performSync("scheduled").catch(() => {});
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.type === "portfolio-capture") {
    const waiter = captureWaiters.get(sender.tab?.id);
    if (waiter) waiter.resolve(request.capture);
    return false;
  }
  if (request?.type === "configure-sync") {
    configureAlarm().then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: message(error) }));
    return true;
  }
  if (request?.type === "sync-now") {
    performSync("manual-test").then((result) => sendResponse({ ok: true, result })).catch((error) => sendResponse({ ok: false, error: message(error) }));
    return true;
  }
  if (request?.type === "sync-settings") {
    settings().then((result) => sendResponse({ ok: true, settings: result })).catch((error) => sendResponse({ ok: false, error: message(error) }));
    return true;
  }
  return false;
});

configureAlarm().catch(() => {});
