"use strict";
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { document_ } = require("./build-portal");
const { fixturePlan } = require("./test-portal-integrity");
const { universe } = require("../api/_lib/universe");

async function run() {
  const browser = await chromium.launch({ headless: true, ...(process.platform === "win32" ? { channel: "msedge" } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const published = fs.readFileSync(path.resolve(__dirname, "../site/index.html"), "utf8");
    const fixture = document_(fixturePlan(), null, { builtAt: "BROWSER TEST" }, null, { stocks: universe() });
    await page.route("http://127.0.0.1/**", (route) => route.fulfill({ contentType: "text/html", body: route.request().url().includes("fixture") ? fixture : published }));
    await page.goto("http://127.0.0.1/portal");
    assert.equal(await page.locator("#research-rows tr").count(), 502);
    assert.equal(await page.locator("#plan-stale").count(), 1);
    await page.locator("#research-search").fill("RELIANCE");
    assert.ok(await page.locator("#research-rows tr:visible").count() > 0);
    assert.ok(await page.locator("#research-rows tr:visible").count() < 502);
    await page.locator("#research-search").fill("");
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: path.resolve(__dirname, "../site/portal-desktop-preview.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => scrollTo(0, 0));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.resolve(__dirname, "../site/portal-mobile-preview.png") });
    await page.goto("http://127.0.0.1/fixture");
    await page.locator("#calc-symbol").selectOption("UI_TEST:short");
    await page.locator("#calc-price").fill("101");
    assert.equal(await page.locator("#calc-target").textContent(), "+2.97%");
    await page.locator('[data-filter="short"]').click();
    assert.equal(await page.locator("#plan-rows tr:visible").count(), 1);
    await page.locator("#calc-price").fill("");
    assert.equal(await page.locator("#calc-target").textContent(), "—");
    assert.deepEqual(errors, []);
    console.log("Browser QA passed: desktop/mobile, 502-name search, stale-plan lock, short filter, direction-correct calculator, cleared-input reset, no browser errors.");
  } finally { await browser.close(); }
}
run().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
