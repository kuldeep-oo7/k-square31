"use strict";

// Records the exact shape of the requests GM's own UI makes.
//
// Probing the endpoints directly returns "Session Expired1" even on a session
// that reads the position book successfully, so the session cookie is not the
// whole story: these calls carry something else the guessed requests omit. The
// only reliable way to learn what is to let the app issue them and write down
// the method, headers and body verbatim.
//
// Navigation is by clicking the app's own menu, because a single-page app does
// not re-route on a URL hash change.
//
//   GM_USERNAME=... GM_PASSWORD=... node scripts/gm-capture.js

const { chromium } = require("playwright");

const GM_ORIGIN = "https://gmglobal.org";
const TARGETS = /(market|watch|script|scrip|expiry|position|trade)/i;

function trim(value, limit = 700) {
  const text = String(value || "");
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
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
    if (url.origin !== GM_ORIGIN || !/\.php$/.test(url.pathname)) return;
    if (!TARGETS.test(url.pathname)) return;
    captured.push({
      path: url.pathname,
      method: request.method(),
      headers: request.headers(),
      body: request.postData() || ""
    });
  });
  const answers = new Map();
  page.on("response", async (response) => {
    const url = new URL(response.url());
    if (url.origin !== GM_ORIGIN || !/\.php$/.test(url.pathname) || !TARGETS.test(url.pathname)) return;
    const text = await response.text().catch(() => "");
    if (text) answers.set(url.pathname, { status: response.status(), text: text.slice(0, 900) });
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
      return { ok: response.ok, data: await response.json().catch(() => ({})) };
    }, { username, password });
    if (!login.ok || String(login.data?.status || "").toLowerCase() !== "ok") throw new Error("GM rejected the credentials");
    console.log(`Signed in. Login payload keys: ${Object.keys(login.data || {}).join(", ")}\n`);

    await page.goto(`${GM_ORIGIN}/#/Portfolio`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector("#load_data", { timeout: 60_000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 25_000 }).catch(() => {});

    // Whatever the app stores client-side is what the guessed requests were
    // missing; the menu is also read from here rather than assumed.
    const clientState = await page.evaluate(() => ({
      local: Object.fromEntries(Object.entries(localStorage).map(([key, value]) => [key, String(value).slice(0, 120)])),
      session: Object.fromEntries(Object.entries(sessionStorage).map(([key, value]) => [key, String(value).slice(0, 120)])),
      links: [...document.querySelectorAll("a,button,li")]
        .map((node) => (node.innerText || "").replace(/\s+/g, " ").trim())
        .filter((text) => text && text.length < 40)
        .slice(0, 60)
    }));
    console.log("localStorage:", JSON.stringify(clientState.local));
    console.log("sessionStorage:", JSON.stringify(clientState.session));
    console.log("\nMenu text seen:", [...new Set(clientState.links)].join(" | "), "\n");

    for (const wanted of ["MARKET WATCH", "MARKETWATCH", "TRADE BOOK", "SCRIPT"]) {
      const clicked = await page.evaluate((label) => {
        const compact = (value) => String(value || "").replace(/\s+/g, " ").trim().toUpperCase();
        const node = [...document.querySelectorAll("a,button,li,span")].find((item) => compact(item.innerText) === label);
        if (!node) return false;
        node.click();
        return true;
      }, wanted);
      if (!clicked) continue;
      console.log(`Clicked "${wanted}"`);
      await page.waitForTimeout(4_000);
    }

    console.log(`\nCaptured ${captured.length} requests the app made itself:\n`);
    const seen = new Set();
    for (const request of captured) {
      if (seen.has(request.path)) continue;
      seen.add(request.path);
      console.log(`${request.method} ${request.path}`);
      const interesting = Object.entries(request.headers)
        .filter(([name]) => /token|auth|csrf|requested|content-type|x-/i.test(name));
      console.log(`  headers: ${JSON.stringify(Object.fromEntries(interesting))}`);
      console.log(`  body: ${trim(request.body)}`);
      const answer = answers.get(request.path);
      if (answer) console.log(`  -> ${answer.status}: ${trim(answer.text, 400)}`);
      console.log();
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
