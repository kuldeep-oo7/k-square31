"use strict";

/**
 * LOOK AT THE PAGE THE WAY THE USER DOES, AFTER EVERY PUSH.
 *
 *   node scripts/shoot-live-page.js ["2026-09-27 20:36"] [out-dir]
 *
 * Opens the public page in a real browser (Edge through Playwright), waits until
 * it serves the expected build, and photographs every tab -- the top and two
 * screens further down -- plus the footer. It also reads the visible text for
 * things that must never be on a money page. The screenshots are then READ by
 * eye before a change is reported done (the user's rule, 2026-09-27: every
 * visual defect so far was found in the user's screenshot, not by the checks
 * behind the page).
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const URL_BASE = "https://kuldeep-oo7.github.io/k2-desk/";
const expect = process.argv[2] || null;
const OUT = process.argv[3] || path.join(os.tmpdir(), "k2-live-shots", new Date().toISOString().replace(/[:.]/g, "-"));

(async () => {
  const { chromium } = require("playwright");
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true, ...(process.platform === "win32" ? { channel: "msedge" } : {}) });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  let stamp = "";
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    await page.goto(`${URL_BASE}?shot=${Date.now()}`, { waitUntil: "load" });
    stamp = await page.$eval("body", (b) => (b.innerText.match(/Built [^\n·]{0,24}IST/) || [""])[0]).catch(() => "");
    if (!expect || stamp.includes(expect)) break;
    if (attempt === 30) { console.log(`NOT SERVED YET: wanted "${expect}", the page says "${stamp}"`); await browser.close(); process.exit(2); }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  console.log(`page: ${stamp}`);

  const problems = [];
  const shots = [];
  const shoot = async (name) => { const file = path.join(OUT, `${name}.png`); await page.screenshot({ path: file }); shots.push(file); };
  const tabs = await page.$$eval("label[for^='v-']", (ls) => ls.map((l) => ({ id: l.getAttribute("for"), text: l.innerText.replace(/\s+/g, " ").trim() })));
  console.log("tabs: " + tabs.map((t) => t.text).join(" | "));

  await shoot("0-header");
  for (const tab of tabs) {
    await page.click(`label[for='${tab.id}']`);
    await page.evaluate(() => window.scrollTo(0, 0));
    const name = tab.text.split(" ")[0].toLowerCase();
    const top = await page.$eval(`label[for='${tab.id}']`, (l) => l.getBoundingClientRect().top + window.scrollY - 10);
    await page.evaluate((y) => window.scrollTo(0, y), top);
    await shoot(`${name}-1-top`);
    for (const step of [2, 3]) { await page.evaluate(() => window.scrollBy(0, 900)); await shoot(`${name}-${step}-down`); }

    // What must never be visible on a money page.
    const text = await page.$eval("body", (b) => b.innerText);
    for (const [label, re] of [["undefined", /\bundefined\b/], ["NaN", /\bNaN\b/], ["null", /\bnull\b/], ["Infinity", /\bInfinity\b/],
      ["[object Object]", /\[object Object\]/], ["a minus after the rupee sign (₹-)", /₹-\d/]]) {
      if (re.test(text)) problems.push(`${tab.text}: "${label}" is visible`);
    }
    const wrapped = await page.$$eval("code", (cs) => cs.filter((c) => c.offsetParent && c.getClientRects().length > 1).map((c) => c.innerText));
    if (wrapped.length) problems.push(`${tab.text}: ${wrapped.length} broker symbol(s) broken across lines, e.g. ${wrapped[0]}`);
  }
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await shoot("9-footer");
  await browser.close();

  console.log(`screenshots (${shots.length}) in ${OUT}`);
  for (const s of shots) console.log("  " + s);
  console.log(problems.length ? "TEXT PROBLEMS:\n  " + [...new Set(problems)].join("\n  ") : "text scan: nothing that must never be visible");
  console.log("Now READ the screenshots -- this script does not replace looking.");
  process.exit(0);
})().catch((error) => { console.error("could not photograph the page:", error.message); process.exit(1); });
