"use strict";

// Records the exact shape of the requests GM's own UI makes, then probes the
// price endpoints with what the login handed back.
//
// Two things the earlier passes got wrong. The menu item is "Watchlist", not
// "Market Watch", so nothing was ever clicked. And the login response carries an
// auth_key alongside the session cookie — the position book happens to accept
// the cookie alone, which is why it worked while every other endpoint answered
// "Session Expired1".
//
//   GM_USERNAME=... GM_PASSWORD=... node scripts/gm-capture.js

const { chromium } = require("playwright");

const { assertReadOnly, safeToProbe } = require("../api/_lib/gm-readonly");

const GM_ORIGIN = "https://gmglobal.org";
const TARGETS = /(market|watch|script|scrip|expiry|position|trade|ltp|rate)/i;
const MENU = ["Watchlist", "Trades", "Portfolio/Position"];

// Endpoints most likely to carry a contract price for the whole tradable list.
const PRICE_ENDPOINTS = [
  "ajaxfiles/market_watch_list.php",
  "ajaxfiles/get_market_watch_filter.php",
  "ajaxfiles/get_market_lists.php",
  "ajaxfiles/get_market_script_list_for_place.php",
  "ajaxfiles/fetch_expiry_list.php",
  "ajaxfiles/get_script_name_search.php",
  "ajaxfiles/get_market_type.php"
];

const trim = (value, limit = 600) => {
  const text = String(value || "");
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
};

function summarise(text) {
  try {
    const parsed = JSON.parse(text);
    const rows = [parsed?.aaData, parsed?.data, parsed?.rows, parsed?.result].find(Array.isArray);
    if (rows) return `table, ${rows.length} rows | first: ${trim(JSON.stringify(rows[0]), 320)}`;
    return `json | ${trim(JSON.stringify(parsed), 320)}`;
  } catch {
    return `non-json | ${trim(text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(), 160)}`;
  }
}

async function run() {
  const username = String(process.env.GM_USERNAME || "");
  const password = String(process.env.GM_PASSWORD || "");
  if (!username || !password) throw new Error("GM_USERNAME and GM_PASSWORD are required");

  const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage", "--no-sandbox"] });
  const context = await browser.newContext({ locale: "en-IN", timezoneId: "Asia/Kolkata", viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();

  const captured = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === GM_ORIGIN && /\.php$/.test(url.pathname) && TARGETS.test(url.pathname)) {
      captured.push({ path: url.pathname, method: request.method(), body: request.postData() || "" });
    }
  });
  const answers = new Map();
  page.on("response", async (response) => {
    const url = new URL(response.url());
    if (url.origin !== GM_ORIGIN || !/\.php$/.test(url.pathname) || !TARGETS.test(url.pathname)) return;
    const text = await response.text().catch(() => "");
    if (text) answers.set(url.pathname, text.slice(0, 1200));
  });

  try {
    await page.goto(`${GM_ORIGIN}/#/Login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const login = await page.evaluate(async (credentials) => {
      const response = await fetch("/ajaxfiles/logincheck.php", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json;charset=UTF-8", "X-Requested-With": "XMLHttpRequest" },
        body: JSON.stringify(credentials)
      });
      return await response.json().catch(() => ({}));
    }, { username, password });
    if (String(login?.status || "").toLowerCase() !== "ok") throw new Error("GM rejected the credentials");

    const identity = {
      auth_key: login.auth_key,
      user_id: login.user_id,
      login_id: login.login_id,
      login_string: login.login_string,
      server_code: login.server_code,
      user_type: login.user_type
    };
    console.log("Identity handed back by login:");
    Object.entries(identity).forEach(([key, value]) => {
      const shown = key === "auth_key" || key === "login_string" ? `${String(value).slice(0, 8)}… (${String(value).length} chars)` : value;
      console.log(`  ${key}: ${shown}`);
    });
    console.log(`  market_types: ${trim(JSON.stringify(login.market_types), 200)}\n`);

    await page.goto(`${GM_ORIGIN}/#/Portfolio`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector("#load_data", { timeout: 60_000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 25_000 }).catch(() => {});

    for (const label of MENU) {
      const clicked = await page.evaluate((wanted) => {
        const compact = (value) => String(value || "").replace(/\s+/g, " ").trim().toUpperCase();
        const node = [...document.querySelectorAll("a,button,li,span,div")]
          .filter((item) => item.children.length === 0)
          .find((item) => compact(item.innerText) === compact(wanted));
        if (!node) return false;
        node.click();
        return true;
      }, label);
      console.log(clicked ? `Clicked "${label}"` : `Could not find "${label}"`);
      if (clicked) await page.waitForTimeout(5_000);
    }

    console.log(`\nRequests the app made itself (${captured.length}):\n`);
    const seen = new Set();
    for (const request of captured) {
      if (seen.has(request.path)) continue;
      seen.add(request.path);
      console.log(`${request.method} ${request.path}`);
      console.log(`  body: ${trim(request.body)}`);
      if (answers.has(request.path)) console.log(`  -> ${summarise(answers.get(request.path))}`);
      console.log();
    }

    console.log("Probing price endpoints with the login identity attached:\n");
    // The guard drops anything whose name indicates it writes, before a request
    // is made. Reading is the entire remit here.
    for (const path of PRICE_ENDPOINTS.filter(safeToProbe)) {
      assertReadOnly(path);
      const result = await page.evaluate(async ({ path, identity }) => {
        const form = new URLSearchParams({
          ...Object.fromEntries(Object.entries(identity).filter(([, value]) => value !== undefined && value !== null)),
          iDisplayStart: "0", iDisplayLength: "10", sEcho: "1", market_type_id: "", script_id: "", expiry_date: ""
        });
        try {
          const response = await fetch(`/${path}`, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest" },
            body: form
          });
          return { status: response.status, text: (await response.text()).slice(0, 2500) };
        } catch (error) {
          return { status: 0, text: String(error && error.message) };
        }
      }, { path, identity });
      console.log(`  ${path} [${result.status}] ${summarise(result.text)}`);
    }
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error(`GM capture failed: ${String(error?.message || error).slice(0, 300)}`);
    process.exitCode = 1;
  });
}

module.exports = { run };
