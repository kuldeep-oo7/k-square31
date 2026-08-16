"use strict";

// Read-only reconnaissance of what GM exposes beyond the position book.
//
// The first version guessed filenames and navigated by changing the URL hash,
// which a single-page app ignores — it observed one endpoint and learned
// nothing. This version reads the app's own JavaScript instead: every endpoint
// the UI can call is named in its source, so the bundle is the index. The
// candidates are then probed with a session established the way the working
// portfolio reader establishes one.
//
// Every request is a read. Nothing is ordered, modified or cancelled.
//
//   GM_USERNAME=... GM_PASSWORD=... node scripts/gm-explore.js

const { chromium } = require("playwright");

const GM_ORIGIN = "https://gmglobal.org";
const ENDPOINT_PATTERN = /['"`]([^'"`\s]*\/?(?:ajaxfiles|datatables|api)\/[a-z0-9_-]+\.php)['"`]/gi;

// What a universe-wide carry calculation needs: a contract price for every
// tradable name, and the expiry it belongs to.
const INTERESTING = /(market|watch|script|scrip|symbol|ltp|rate|quote|expiry|master|trade|net_?position)/i;

function summarise(body) {
  const text = String(body || "");
  if (!text.trim()) return { kind: "empty", detail: "" };
  let parsed;
  try { parsed = JSON.parse(text); } catch {
    return { kind: "html", detail: text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) };
  }
  const rows = [parsed?.aaData, parsed?.data, parsed?.rows, parsed?.result].find(Array.isArray);
  if (rows) return { kind: "table", rows: rows.length, detail: JSON.stringify(rows[0]).slice(0, 300) };
  return { kind: "json", detail: JSON.stringify(parsed).slice(0, 240) };
}

async function signIn(page, username, password) {
  await page.goto(`${GM_ORIGIN}/#/Login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const login = await page.evaluate(async (credentials) => {
    const response = await fetch("/ajaxfiles/logincheck.php", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json;charset=UTF-8", "X-Requested-With": "XMLHttpRequest" },
      body: JSON.stringify(credentials)
    });
    return { ok: response.ok, data: await response.json().catch(() => ({})) };
  }, { username, password });
  if (!login.ok || String(login.data?.status || "").toLowerCase() !== "ok") throw new Error("GM rejected the credentials");
}

// A hash change does not reload a single-page app, so the portfolio route is
// opened the way the working reader opens it: a full navigation, then wait for
// the table the route builds.
async function openPortfolio(page) {
  await page.goto(`${GM_ORIGIN}/#/Portfolio`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector("#load_data", { timeout: 60_000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
}

async function endpointsFromBundle(page) {
  const scripts = await page.evaluate(() => [...document.querySelectorAll("script[src]")].map((node) => node.src));
  const found = new Set();
  for (const src of scripts) {
    if (!src.startsWith(GM_ORIGIN)) continue;
    const source = await page.evaluate(async (url) => {
      try { return await (await fetch(url, { credentials: "include" })).text(); } catch { return ""; }
    }, src);
    for (const match of source.matchAll(ENDPOINT_PATTERN)) {
      found.add(match[1].replace(/^\.?\//, "").replace(/^.*?(ajaxfiles|datatables|api)\//, "$1/"));
    }
  }
  return [...found].sort();
}

async function probe(page, path, body) {
  return page.evaluate(async ({ path, body }) => {
    try {
      const response = await fetch(`/${path}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest" },
        body
      });
      return { status: response.status, body: (await response.text()).slice(0, 6000) };
    } catch (error) {
      return { status: 0, body: String(error && error.message) };
    }
  }, { path, body });
}

async function run() {
  const username = String(process.env.GM_USERNAME || "");
  const password = String(process.env.GM_PASSWORD || "");
  if (!username || !password) throw new Error("GM_USERNAME and GM_PASSWORD are required");

  const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage", "--no-sandbox"] });
  const context = await browser.newContext({ locale: "en-IN", timezoneId: "Asia/Kolkata", viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();

  const observed = new Set();
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === GM_ORIGIN && /\.php$/.test(url.pathname)) observed.add(url.pathname.replace(/^\//, ""));
  });

  try {
    await signIn(page, username, password);
    await openPortfolio(page);
    console.log("Signed in and the portfolio route is up.\n");

    const declared = await endpointsFromBundle(page);
    console.log(`Endpoints named in the app's own JavaScript (${declared.length}):`);
    declared.forEach((path) => console.log(`  ${INTERESTING.test(path) ? "*" : " "} ${path}`));
    console.log("\nEndpoints the app actually called while loading:");
    [...observed].sort().forEach((path) => console.log(`    ${path}`));

    const candidates = declared.filter((path) => INTERESTING.test(path));
    console.log(`\nProbing ${candidates.length} candidates that could carry a contract price:\n`);
    for (const path of candidates) {
      // Two shapes: the DataTables form the position book uses, and an empty
      // JSON-ish body for the simpler ajax lookups.
      for (const body of ["iDisplayStart=0&iDisplayLength=5&sEcho=1", ""]) {
        const result = await probe(page, path, body);
        if (result.status !== 200) continue;
        const summary = summarise(result.body);
        if (summary.kind === "html" || summary.kind === "empty") continue;
        console.log(`  ${path} [${body ? "datatables" : "empty"}] -> ${summary.kind}${summary.rows !== undefined ? ` (${summary.rows} rows)` : ""}`);
        console.log(`      ${summary.detail}`);
        break;
      }
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

module.exports = { summarise };
