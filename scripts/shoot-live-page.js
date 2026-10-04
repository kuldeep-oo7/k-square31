"use strict";

/**
 * LOOK AT THE PAGE THE WAY THE USER DOES, AFTER EVERY PUSH.
 *
 *   node scripts/shoot-live-page.js ["2026-09-27 20:36"] [out-dir]
 *
 * Opens the public page in a real browser (Edge through Playwright), waits until
 * it serves the expected build, and photographs every tab -- the top and further
 * down -- on the two screens the user has:
 *   phone   Samsung Galaxy M32 (6.4", 1080x2400): a 412x915 page at 2.625x.
 *           This is the MAIN screen (the user, 27 Sep: "I will mostly use it on
 *           the Samsung M32 phone").
 *   laptop  1920x1080 at Windows' 125% scaling: a 1536x864 page. At a plain
 *           1920 the TRACK table fitted; on the user's screen it scrolled
 *           sideways and hid the money column.
 * It also reads the visible text for what must never be on a money page, and
 * measures anything wider than the screen. The screenshots are then READ by eye
 * before a change is reported done (the user's rule, 27 Sep 2026).
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// K2_SHOOT_URL points it at a page rendered locally, to look before pushing.
const URL_BASE = process.env.K2_SHOOT_URL || "https://kuldeep-oo7.github.io/k2-desk/";
const expect = process.argv[2] || null;
// THE USER'S FOLDER OF PHOTOS (29 Sep 2026): "whenever you push it to github you
// need to open the chrome, take screenshots and save it date wise on that folder,
// same when I say audit and simulations, so I can see it". Every run lands in
//   C:\Users\kulde\Downloads\K2-screenshots\<IST date>\<IST time>-<label>\
// with a README.txt of what was photographed and what the checks found. A third
// argument that is a path overrides it; any other third argument is the label.
const istNow = new Date(Date.now() + 330 * 60_000).toISOString();
const arg3 = process.argv[3] || "";
const SHOTS_ROOT = process.env.K2_SHOTS_ROOT || path.join(os.homedir(), "Downloads", "K2-screenshots");
const OUT = /[\\/:]/.test(arg3) ? arg3
  : path.join(SHOTS_ROOT, istNow.slice(0, 10), `${istNow.slice(11, 16).replace(":", "")}-${(arg3 || "check").replace(/[^A-Za-z0-9_-]+/g, "-")}`);
const DEVICES = [
  { name: "phone", viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, scrolls: 4 },
  { name: "laptop", viewport: { width: 1536, height: 864 }, deviceScaleFactor: 1.25, isMobile: false, hasTouch: false, scrolls: 2 }
];

(async () => {
  const { chromium } = require("playwright");
  fs.mkdirSync(OUT, { recursive: true });
  // Chrome, as the user asked; Edge if Chrome is not there.
  let browser = null, browserName = "chrome";
  try { browser = await chromium.launch({ headless: true, channel: "chrome" }); }
  catch { browserName = "msedge"; browser = await chromium.launch({ headless: true, ...(process.platform === "win32" ? { channel: "msedge" } : {}) }); }
  const problems = [];
  const shots = [];
  const rowOffsets = [];
  let stamp = "";
  for (const device of DEVICES) {
    const context = await browser.newContext({ viewport: device.viewport, deviceScaleFactor: device.deviceScaleFactor, isMobile: device.isMobile, hasTouch: device.hasTouch });
    const page = await context.newPage();
    for (let attempt = 1; attempt <= 30; attempt += 1) {
      await page.goto(`${URL_BASE}?shot=${Date.now()}`, { waitUntil: "load" });
      stamp = await page.$eval("body", (b) => (b.innerText.match(/Built [^\n·]{0,24}IST/) || [""])[0]).catch(() => "");
      if (!expect || stamp.includes(expect)) break;
      if (attempt === 30) { console.log(`NOT SERVED YET: wanted "${expect}", the page says "${stamp}"`); await browser.close(); process.exit(2); }
      await new Promise((r) => setTimeout(r, 10_000));
    }
    const shoot = async (name) => { const file = path.join(OUT, `${device.name}-${name}.png`); await page.screenshot({ path: file }); shots.push(file); };
    const tabs = await page.$$eval("label[for^='v-']", (ls) => ls.map((l) => ({ id: l.getAttribute("for"), text: l.innerText.replace(/\s+/g, " ").trim() })));
    if (device.name === DEVICES[0].name) console.log(`page: ${stamp}\ntabs: ${tabs.map((t) => t.text).join(" | ")}`);
    await shoot("0-header");
    for (const tab of tabs) {
      await page.click(`label[for='${tab.id}']`);
      const name = tab.text.split(" ")[0].toLowerCase();
      const top = await page.$eval(`label[for='${tab.id}']`, (l) => l.getBoundingClientRect().top + window.scrollY - 10);
      await page.evaluate((y) => window.scrollTo(0, y), top);
      await shoot(`${name}-1-top`);
      // WHERE THE FIRST ROW STARTS: how far a reader scrolls, from the tab
      // buttons, before the first contract. On the phone this is the number the
      // folded notes exist to shrink (the user, 27 Sep: rows first).
      const firstRow = await page.evaluate((id) => {
        const pane = [...document.querySelectorAll("section.pane")].find((p) => getComputedStyle(p).display !== "none");
        const row = pane && pane.querySelector("tbody tr");
        const tabs = document.querySelector(`label[for='${id}']`);
        if (!row || !tabs) return null;
        return Math.round(row.getBoundingClientRect().top - tabs.getBoundingClientRect().bottom);
      }, tab.id);
      if (firstRow !== null) rowOffsets.push(`${device.name} ${tab.text}: first row ${firstRow}px under the tabs (${(firstRow / device.viewport.height).toFixed(2)} screens)`);
      for (let step = 2; step <= device.scrolls + 1; step += 1) {
        await page.evaluate((h) => window.scrollBy(0, h - 120), device.viewport.height);
        await shoot(`${name}-${step}-down`);
      }
      // THE FORWARD PAPER-TEST BOXES sit several screens down TRACK, past the scroll shots above
      // (4 Oct 2026): photograph each from its top, at most two screens a box, so a session without
      // the laptop can read them too.
      if (name === "track") {
        // the tab bar stays pinned at the top while scrolled: start each box just under it
        const bar = await page.evaluate(() => Math.max(0, ...[...document.querySelectorAll("label[for^='v-']")].map((l) => l.getBoundingClientRect().bottom)));
        const tops = await page.evaluate((bar) => [...document.querySelectorAll("div.note")]
          .filter((n) => n.offsetParent !== null && /PAPER TEST/.test((n.querySelector("b") || {}).textContent || ""))
          .map((n) => ({ top: Math.round(n.getBoundingClientRect().top + window.scrollY - bar - 10), h: n.offsetHeight })), bar);
        for (const [k, b] of tops.entries()) {
          await page.evaluate((y) => window.scrollTo(0, y), b.top);
          await shoot(`${name}-paper-${k + 1}a`);
          if (b.h > device.viewport.height - 20) { await page.evaluate((h) => window.scrollBy(0, h - 120), device.viewport.height); await shoot(`${name}-paper-${k + 1}b`); }
        }
      }
      const where = `${device.name} ${tab.text}`;
      // Folded notes are not in innerText while closed: open every one for the
      // check, then put them back as they were.
      const text = await page.evaluate(() => {
        const closed = [...document.querySelectorAll("details:not([open])")];
        closed.forEach((d) => { d.open = true; });
        const t = document.body.innerText;
        closed.forEach((d) => { d.open = false; });
        return t;
      });
      for (const [label, re] of [["undefined", /\bundefined\b/], ["NaN", /\bNaN\b/], ["null", /\bnull\b/], ["Infinity", /\bInfinity\b/],
        ["[object Object]", /\[object Object\]/], ["a minus after the rupee sign (₹-)", /₹-\d/]]) {
        if (re.test(text)) problems.push(`${where}: "${label}" is visible`);
      }
      // Anything wider than the screen hides what is to its right.
      const pageWide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (pageWide > 2) problems.push(`${where}: the whole page scrolls sideways by ${pageWide}px`);
      const wide = await page.$$eval(".wrap", (ws) => ws.filter((w) => w.offsetParent && w.scrollWidth > w.clientWidth + 2)
        .map((w) => `${w.scrollWidth - w.clientWidth}px too wide`));
      if (wide.length) problems.push(`${where}: ${wide.length} table(s) scroll sideways (${wide.join(", ")}) -- columns are hidden`);
      const wrapped = await page.$$eval("code", (cs) => cs.filter((c) => c.offsetParent && c.getClientRects().length > 1).map((c) => c.innerText));
      if (wrapped.length) problems.push(`${where}: ${wrapped.length} broker symbol(s) broken across lines, e.g. ${wrapped[0]}`);
    }
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await shoot("9-footer");
    // One fold opened, to see what a tap shows.
    const opened = await page.evaluate(() => {
      document.querySelector("label[for='v-fut']")?.click();
      const d = [...document.querySelectorAll("section.pane-fut details.fold")].find((x) => !x.open);
      if (!d) return false;
      d.open = true;
      window.scrollTo(0, d.getBoundingClientRect().top + window.scrollY - 60);
      return true;
    });
    if (opened) await shoot("8-fold-open");
    await context.close();
  }
  await browser.close();

  console.log(rowOffsets.join("\n"));
  console.log(`screenshots (${shots.length}) in ${OUT}`);
  fs.writeFileSync(path.join(OUT, "README.txt"), [
    `K2 desk, photographed ${istNow.slice(0, 16).replace("T", " ")} IST in ${browserName}`,
    `page: ${URL_BASE}`,
    `build on the page: ${stamp || "(stamp not read)"}${expect ? `  (waited for "${expect}")` : ""}`,
    "",
    "where the first row starts, per tab:", ...rowOffsets.map((x) => "  " + x),
    "",
    problems.length ? "PROBLEMS:" : "checks: nothing that must never be visible, nothing wider than the screen",
    ...[...new Set(problems)].map((x) => "  " + x),
    "",
    `files (${shots.length}):`, ...shots.map((s) => "  " + path.basename(s))
  ].join("\r\n") + "\r\n");
  for (const s of shots) console.log("  " + s);
  console.log(problems.length ? "PROBLEMS:\n  " + [...new Set(problems)].join("\n  ") : "checks: nothing that must never be visible, nothing wider than the screen");
  console.log("Now READ the screenshots -- phone first. This script does not replace looking.");
  process.exit(0);
})().catch((error) => { console.error("could not photograph the page:", error.message); process.exit(1); });
