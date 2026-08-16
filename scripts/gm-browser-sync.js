"use strict";

const crypto = require("node:crypto");
const { chromium } = require("playwright");
const bridge = require("../extensions/gm-k2-bridge/core.js");
const { publishSnapshot, requirePublishCredentials } = require("./gm-cloud-sync");

const GM_ORIGIN = "https://gmglobal.org";
const PORTFOLIO_URL = `${GM_ORIGIN}/#/Portfolio`;
const POSITION_ENDPOINT = /\/datatables\/position_book_list(?:_new|_forex)?\.php/i;

function numberFromText(value) {
  const parsed = Number(String(value ?? "").replace(/[₹,]/g, "").replace(/[^0-9.+-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

async function responsePayload(response) {
  try { return await response.json(); } catch { return null; }
}

function headerKey(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]+/g, "");
}

function mergeLiveTable(apiPositions, tableRows, headers) {
  const indexes = new Map(headers.map((header, index) => [headerKey(header), index]));
  const scriptIndex = indexes.get("SCRIPT");
  const netIndex = indexes.get("NETQ");
  const markIndex = indexes.get("ABP");
  const mtmIndex = indexes.get("MTM");
  if (![scriptIndex, netIndex, markIndex, mtmIndex].every(Number.isInteger)) throw new Error("GM live table headers are incomplete");
  const liveByContract = new Map();
  tableRows.forEach((row) => {
    const instrument = String(row[scriptIndex] || "").toUpperCase().match(/^(.+?)\s*(\d{2}[A-Z]{3}\d{4})$/);
    if (!instrument) return;
    const key = `${instrument[1].replace(/\s+/g, "").trim()}|${bridge.expiry(instrument[2])}`;
    liveByContract.set(key, {
      netCell: numberFromText(row[netIndex]),
      markCell: numberFromText(row[markIndex]),
      mtm: numberFromText(row[mtmIndex])
    });
  });
  return apiPositions.map((position) => {
    const live = liveByContract.get(`${position.symbol}|${position.expiry}`);
    if (!live || !Number.isFinite(live.mtm)) return position;
    const signedQuantity = position.position === "short" ? -position.quantity : position.quantity;
    // In GM's Client layout the live-price updater writes into the visual Net Q
    // cell. In Script-wise layout it writes into A/B P. Quantities always come
    // from the verified API payload, never from this dynamic visual cell.
    const markPrice = live.markCell > 0
      ? live.markCell
      : (live.netCell > 0 && Math.abs(live.netCell - signedQuantity) > .001 ? live.netCell : null);
    return {
      ...position,
      ...(markPrice > 0 ? { markPrice: Math.round(markPrice * 100) / 100 } : {}),
      mtm: Math.round(live.mtm * 100) / 100
    };
  });
}

async function fetchPortfolioWithBrowser(username, password) {
  const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage", "--no-sandbox"] });
  const context = await browser.newContext({ locale: "en-IN", timezoneId: "Asia/Kolkata", viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  try {
    await page.goto(`${GM_ORIGIN}/#/Login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const login = await page.evaluate(async ({ username, password }) => {
      const response = await fetch("/ajaxfiles/logincheck.php", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json;charset=UTF-8", "X-Requested-With": "XMLHttpRequest" },
        body: JSON.stringify({ username, password })
      });
      return { ok: response.ok, data: await response.json().catch(() => ({})) };
    }, { username, password });
    if (!login.ok || String(login.data?.status || "").toLowerCase() !== "ok") throw new Error("GM rejected the configured cloud credentials");

    await page.goto(PORTFOLIO_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector("#load_data", { timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(2_000);
    let payload = null;
    const responsePromise = page.waitForResponse(async (response) => {
      if (!POSITION_ENDPOINT.test(new URL(response.url()).pathname) || response.request().method() !== "POST") return false;
      const candidate = await responsePayload(response);
      const count = Number(candidate?.iTotalDisplayRecords ?? candidate?.iTotalRecords);
      const quantity = Number(candidate?.total_qty);
      if (!Array.isArray(candidate?.aaData) || !Number.isInteger(count) || !Number.isFinite(quantity)) return false;
      payload = candidate;
      return true;
    }, { timeout: 60_000 });
    // The UI interaction below can fail before this promise is awaited. Attach
    // an immediate rejection observer so browser cleanup cannot mask that error.
    responsePromise.catch(() => {});
    // The controls are rendered by the route after its first data call, so a
    // fixed pause races them: on a slow runner the click ran before the button
    // existed and all three attempts failed with "button is not available".
    // Waiting for the control itself removes the race rather than lengthening
    // the guess.
    await page.waitForFunction(() => {
      const compact = (value) => String(value || "").replace(/\s+/g, " ").trim().toUpperCase();
      return [...document.querySelectorAll("button,input[type=button],input[type=submit]")]
        .some((node) => compact(node.innerText || node.value) === "GET POSITION");
    }, null, { timeout: 60_000 });

    await page.evaluate(() => {
      const compact = (value) => String(value || "").replace(/\s+/g, " ").trim().toUpperCase();
      const choose = (wanted) => {
        const labels = [...document.querySelectorAll("label")];
        const label = labels.find((node) => compact(node.innerText) === wanted);
        const input = label?.querySelector("input") || (label?.htmlFor ? document.getElementById(label.htmlFor) : null);
        if (input && !input.checked) input.click();
      };
      choose("ALL");
      choose("SCRIPT WISE");
      const button = [...document.querySelectorAll("button,input[type=button],input[type=submit]")].find((node) => compact(node.innerText || node.value) === "GET POSITION");
      if (!button) throw new Error("GM Get Position button is not available");
      button.click();
    });
    await responsePromise;
    const recordCount = Number(payload?.iTotalDisplayRecords ?? payload?.iTotalRecords);
    const totalQuantity = Number(payload?.total_qty);
    if (!Array.isArray(payload?.aaData) || !Number.isInteger(recordCount) || !Number.isFinite(totalQuantity)) throw new Error("GM did not return a complete portfolio response");

    await page.evaluate(async (rows) => {
      const jq = window.jQuery;
      if (!jq?.fn?.DataTable?.isDataTable?.("#load_data")) throw new Error("GM portfolio table is not initialized");
      const table = jq("#load_data").DataTable();
      if (table.page.info().recordsDisplay > table.page.info().end) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 10_000);
          table.one("draw.dt", () => { clearTimeout(timer); resolve(); });
          table.page.len(-1).draw();
        });
      }
    });
    await page.waitForFunction((expected) => document.querySelectorAll("#load_data tbody tr").length >= expected, recordCount, { timeout: 60_000 });
    const apiPositions = bridge.normalizeRows(payload.aaData);
    const apiSignedQuantity = apiPositions.reduce((sum, item) => sum + (item.position === "short" ? -1 : 1) * item.quantity, 0);
    if (payload.aaData.length !== recordCount || Math.abs(apiSignedQuantity - totalQuantity) > .01) {
      throw new Error(`GM API integrity mismatch: report rows=${payload.aaData.length}/${recordCount}, open rows=${apiPositions.length}, quantity=${apiSignedQuantity}/${totalQuantity}`);
    }
    let positions = apiPositions;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const headers = await page.locator("#load_data thead th").evaluateAll((nodes) => nodes.map((node) => node.innerText.replace(/\s+/g, " ").trim() || "_"));
      const tableRows = await page.locator("#load_data tbody tr").evaluateAll((rows) => rows.map((row) => [...row.querySelectorAll("td")].map((cell) => cell.innerText.replace(/\s+/g, " ").trim())));
      positions = mergeLiveTable(apiPositions, tableRows, headers);
      if (positions.every((item) => Number(item.markPrice) > 0 && Number.isFinite(Number(item.mtm)))) break;
      await page.waitForTimeout(500);
    }
    if (positions.length !== apiPositions.length || positions.some((item) => !(Number(item.markPrice) > 0) || !Number.isFinite(Number(item.mtm)))) {
      throw new Error(`GM live-price integrity mismatch: open rows=${positions.length}/${apiPositions.length}`);
    }
    const totalMtm = positions.reduce((sum, item) => sum + Number(item.mtm), 0);
    return { positions, recordCount: positions.length, sourceRecordCount: recordCount, totalQuantity, totalMtm, endpoint: `${GM_ORIGIN}/datatables/position_book_list.php` };
  } finally {
    await browser.close();
  }
}

async function runBrowserOnce() {
  const username = String(process.env.GM_USERNAME || "");
  const password = String(process.env.GM_PASSWORD || "");
  const secret = String(process.env.K2_GM_CLOUD_SYNC_SECRET || "");
  if (!username || !password) throw new Error("GM_USERNAME and GM_PASSWORD cloud secrets are required");
  requirePublishCredentials(secret);
  let snapshot = null;
  let lastError = null;
  let integrityError = null;
  for (let attempt = 1; attempt <= 3 && !snapshot; attempt += 1) {
    try { snapshot = await fetchPortfolioWithBrowser(username, password); }
    catch (error) {
      lastError = error;
      if (String(error?.message || error).includes("GM completeness mismatch")) integrityError = error;
      if (attempt < 3) console.warn(`GM read attempt ${attempt} failed; retrying a fresh session.`);
    }
  }
  if (!snapshot) throw integrityError || lastError || new Error("GM portfolio could not be read");
  if (process.env.GM_CLOUD_DRY_RUN === "1") {
    console.log(`GM cloud-browser validation succeeded: ${snapshot.recordCount} positions, signed quantity ${snapshot.totalQuantity}, MTM ${snapshot.totalMtm.toFixed(2)}`);
    return snapshot;
  }
  const result = await publishSnapshot(snapshot.positions, secret, snapshot);
  console.log(`GM → K² browser sync succeeded: ${snapshot.recordCount} positions, signed quantity ${snapshot.totalQuantity}, MTM ${snapshot.totalMtm.toFixed(2)} at ${result.capturedAt} via ${result.via}`);
  return result;
}

if (require.main === module) runBrowserOnce().catch((error) => { console.error(`GM → K² browser sync failed: ${String(error?.message || error).slice(0, 1_500)}`); process.exitCode = 1; });

module.exports = { fetchPortfolioWithBrowser, runBrowserOnce };
