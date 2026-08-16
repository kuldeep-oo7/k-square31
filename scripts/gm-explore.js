"use strict";

// Read-only reconnaissance of what GM exposes beyond the position book.
//
// The desk trades futures, so the futures price is the one number no public feed
// gives for free: Yahoo serves spot, and NSE's own API is behind Akamai. GM has
// the real contract prices, so if it also serves a market watch or a scrip
// master, carry (futures against spot) becomes computable for the whole universe
// rather than only for names already held.
//
// Every request here is a GET or an empty POST against endpoints the site's own
// UI calls. Nothing is ordered, modified or cancelled.
//
//   GM_USERNAME=... GM_PASSWORD=... node scripts/gm-explore.js

const { chromium } = require("playwright");

const GM_ORIGIN = "https://gmglobal.org";

// Named after the position book that is known to exist, on the assumption the
// site follows one convention for its other tables and lookups.
const CANDIDATES = [
  ["datatables", "market_watch_list.php"],
  ["datatables", "trade_book_list.php"],
  ["datatables", "order_book_list.php"],
  ["datatables", "script_list.php"],
  ["datatables", "scrip_list.php"],
  ["datatables", "symbol_list.php"],
  ["datatables", "ledger_list.php"],
  ["datatables", "bill_list.php"],
  ["datatables", "position_book_list_new.php"],
  ["ajaxfiles", "get_script.php"],
  ["ajaxfiles", "get_scripts.php"],
  ["ajaxfiles", "get_script_list.php"],
  ["ajaxfiles", "get_market_watch.php"],
  ["ajaxfiles", "getmarketwatch.php"],
  ["ajaxfiles", "get_expiry.php"],
  ["ajaxfiles", "get_expiry_date.php"],
  ["ajaxfiles", "view_market_watch.php"],
  ["ajaxfiles", "get_ltp.php"],
  ["ajaxfiles", "getltp.php"],
  ["ajaxfiles", "get_rate.php"]
];

function summarise(body) {
  const text = String(body || "");
  if (!text.trim()) return { kind: "empty", detail: "" };
  let parsed;
  try { parsed = JSON.parse(text); } catch {
    const stripped = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    return { kind: "html", detail: stripped.slice(0, 90) };
  }
  const rows = [parsed?.aaData, parsed?.data, parsed?.rows].find(Array.isArray);
  if (rows) {
    return { kind: "table", detail: `${rows.length} rows; first: ${JSON.stringify(rows[0]).slice(0, 200)}` };
  }
  return { kind: "json", detail: JSON.stringify(parsed).slice(0, 200) };
}

async function run() {
  const username = String(process.env.GM_USERNAME || "");
  const password = String(process.env.GM_PASSWORD || "");
  if (!username || !password) throw new Error("GM_USERNAME and GM_PASSWORD are required");

  const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage", "--no-sandbox"] });
  const context = await browser.newContext({ locale: "en-IN", timezoneId: "Asia/Kolkata" });
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
    if (!login.ok || String(login.data?.status || "").toLowerCase() !== "ok") throw new Error("GM rejected the credentials");
    console.log("Signed in. Probing endpoints.\n");

    // Anything the app itself requests while the market watch renders is a far
    // better lead than a guessed filename.
    const observed = new Set();
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.origin === GM_ORIGIN && /\.php$/.test(url.pathname)) observed.add(`${request.method()} ${url.pathname}`);
    });

    for (const route of ["#/Dashboard", "#/MarketWatch", "#/Portfolio", "#/TradeBook", "#/Reports"]) {
      await page.goto(`${GM_ORIGIN}/${route}`, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
      await page.waitForTimeout(2_500);
    }

    console.log("Endpoints the site itself called:");
    [...observed].sort().forEach((entry) => console.log(`  ${entry}`));
    console.log();

    console.log("Guessed endpoints that answered:");
    for (const [folder, file] of CANDIDATES) {
      const result = await page.evaluate(async ({ folder, file }) => {
        try {
          const response = await fetch(`/${folder}/${file}`, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest" },
            body: "iDisplayStart=0&iDisplayLength=5"
          });
          return { status: response.status, body: (await response.text()).slice(0, 4000) };
        } catch (error) {
          return { status: 0, body: String(error && error.message) };
        }
      }, { folder, file });
      if (result.status !== 200) continue;
      const summary = summarise(result.body);
      if (summary.kind === "html" || summary.kind === "empty") continue;
      console.log(`  /${folder}/${file} -> ${summary.kind}: ${summary.detail}`);
    }
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error(`GM exploration failed: ${String(error?.message || error).slice(0, 300)}`);
    process.exitCode = 1;
  });
}

module.exports = { CANDIDATES, summarise };
