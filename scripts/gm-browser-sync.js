"use strict";

const crypto = require("node:crypto");
const { chromium } = require("playwright");
const bridge = require("../extensions/gm-k2-bridge/core.js");
const { fingerprint, uploadToK2 } = require("./gm-cloud-sync");

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

    let payload = null;
    let networkResponseUrl = "";
    let resolvePayload;
    const payloadPromise = new Promise((resolve) => { resolvePayload = resolve; });
    const capturePortfolioResponse = async (response) => {
      if (!POSITION_ENDPOINT.test(new URL(response.url()).pathname) || response.request().method() !== "POST") return false;
      const candidate = await responsePayload(response);
      const candidateCount = Number(candidate?.iTotalDisplayRecords ?? candidate?.iTotalRecords);
      const candidateQuantity = Number(candidate?.total_qty);
      if (!Array.isArray(candidate?.aaData) || !Number.isInteger(candidateCount) || !Number.isFinite(candidateQuantity)) return false;
      if (payload) return true;
      payload = candidate;
      networkResponseUrl = response.url();
      resolvePayload(candidate);
      return true;
    };
    page.on("response", capturePortfolioResponse);
    await page.goto(PORTFOLIO_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector("#load_data", { timeout: 60_000 });
    await page.evaluate(() => {
      const button = [...document.querySelectorAll("button,input[type=button],input[type=submit]")].find((node) => String(node.innerText || node.value || "").replace(/\s+/g, " ").trim().toUpperCase() === "GET POSITION");
      if (!button) throw new Error("GM Get Position button is not available");
      button.click();
    });
    await Promise.race([payloadPromise, page.waitForTimeout(60_000).then(() => { throw new Error("GM complete portfolio response timed out"); })]);
    page.off("response", capturePortfolioResponse);
    const recordCount = Number(payload?.iTotalDisplayRecords ?? payload?.iTotalRecords);
    const totalQuantity = Number(payload?.total_qty);
    if (!Array.isArray(payload?.aaData) || !Number.isInteger(recordCount) || !Number.isFinite(totalQuantity)) throw new Error("GM did not return a complete portfolio response");

    await page.evaluate(async () => {
      const jq = window.jQuery;
      if (!jq?.fn?.DataTable?.isDataTable?.("#load_data")) return;
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
    let positions = [];
    let tableRows = [];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      tableRows = await page.locator("#load_data tbody tr").evaluateAll((rows) => rows.map((row) => [...row.querySelectorAll("td")].map((cell) => cell.innerText.replace(/\s+/g, " ").trim())));
      positions = bridge.normalizeRows(tableRows);
      if (positions.length === recordCount && positions.every((item) => Number(item.markPrice) > 0 && Number.isFinite(Number(item.mtm)))) break;
      await page.waitForTimeout(500);
    }
    const signedQuantity = positions.reduce((sum, item) => sum + (item.position === "short" ? -1 : 1) * item.quantity, 0);
    const totalMtm = positions.reduce((sum, item) => sum + Number(item.mtm || 0), 0);
    if (positions.length !== recordCount || Math.abs(signedQuantity - totalQuantity) > .01) {
      const apiPositions = bridge.normalizeRows(payload.aaData);
      const apiSignedQuantity = apiPositions.reduce((sum, item) => sum + (item.position === "short" ? -1 : 1) * item.quantity, 0);
      const shapeCounts = tableRows.reduce((counts, row) => { const key = String(row.length); counts[key] = (counts[key] || 0) + 1; return counts; }, {});
      const unusual = positions.filter((item) => !Number.isInteger(item.quantity) || item.quantity > 10_000).map((item) => `${item.symbol}:${item.quantity}`).slice(0, 5);
      const headers = await page.locator("#load_data thead th").evaluateAll((nodes) => nodes.map((node) => node.innerText.replace(/\s+/g, " ").trim() || "_")).catch(() => []);
      const sample = (tableRows[0] || []).map((value, index) => `${index}:${String(value).replace(/KGK[^|]*/gi, "[account]").slice(0, 40)}`).join("|");
      throw new Error(`GM completeness mismatch: DOM rows=${positions.length}/${recordCount}, DOM quantity=${signedQuantity}/${totalQuantity}, API open rows=${apiPositions.length}, API quantity=${apiSignedQuantity}, cell shapes=${JSON.stringify(shapeCounts)}, unusual=${unusual.join(",") || "none"}, headers=${headers.join("|")}, sample=${sample}`);
    }
    return { positions, recordCount, totalQuantity, totalMtm, endpoint: networkResponseUrl };
  } finally {
    await browser.close();
  }
}

async function runBrowserOnce() {
  const username = String(process.env.GM_USERNAME || "");
  const password = String(process.env.GM_PASSWORD || "");
  const secret = String(process.env.K2_GM_CLOUD_SYNC_SECRET || "");
  if (!username || !password) throw new Error("GM_USERNAME and GM_PASSWORD cloud secrets are required");
  if (secret.length < 32) throw new Error("K2_GM_CLOUD_SYNC_SECRET must contain at least 32 characters");
  let snapshot = null;
  let lastError = null;
  for (let attempt = 1; attempt <= 3 && !snapshot; attempt += 1) {
    try { snapshot = await fetchPortfolioWithBrowser(username, password); }
    catch (error) { lastError = error; if (attempt < 3) console.warn(`GM read attempt ${attempt} failed; retrying a fresh session.`); }
  }
  if (!snapshot) throw lastError || new Error("GM portfolio could not be read");
  if (process.env.GM_CLOUD_DRY_RUN === "1") {
    console.log(`GM cloud-browser validation succeeded: ${snapshot.recordCount} positions, signed quantity ${snapshot.totalQuantity}, MTM ${snapshot.totalMtm.toFixed(2)}`);
    return snapshot;
  }
  const result = await uploadToK2(snapshot.positions, secret, snapshot);
  console.log(`GM → K² browser sync succeeded: ${snapshot.recordCount} positions, signed quantity ${snapshot.totalQuantity}, MTM ${snapshot.totalMtm.toFixed(2)} at ${result.capturedAt}`);
  return result;
}

if (require.main === module) runBrowserOnce().catch((error) => { console.error(`GM → K² browser sync failed: ${String(error?.message || error).slice(0, 1_500)}`); process.exitCode = 1; });

module.exports = { fetchPortfolioWithBrowser, runBrowserOnce };
