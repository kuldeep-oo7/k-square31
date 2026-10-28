"use strict";
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");
const { plan } = require("../api/_lib/gm-weekly-goal");
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, ".private", "gm-weekly", "browser-audit");

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  let browser;
  for (const channel of ["chrome", "msedge", null]) {
    try { browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) }); break; } catch { /* try the installed browser */ }
  }
  if (!browser) throw new Error("No supported browser could launch; visual audit incomplete.");
  const url = process.env.K2_GM_AUDIT_URL || pathToFileURL(path.join(ROOT, ".private/gm-weekly/preview/index.html")).href;
  const checks = [];
  try {
    for (const device of [{ name: "phone", viewport: { width: 360, height: 780 }, isMobile: true }, { name: "laptop", viewport: { width: 1536, height: 864 }, isMobile: false }]) {
      const context = await browser.newContext({ viewport: device.viewport, isMobile: device.isMobile, hasTouch: device.isMobile });
      const page = await context.newPage();
      if (url.startsWith("file:")) await page.route(/^https?:/, (route) => route.abort());
      await page.goto(url, { waitUntil: "load" });
      for (const [id, name] of [["v-fut", "futures"], ["v-ce", "calls"], ["v-pe", "puts"], ["v-trk", "track"]]) {
        await page.locator(`label[for='${id}']`).click();
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: path.join(OUT, `${device.name}-${name}-top.png`) });
        await page.evaluate(() => window.scrollTo(0, Math.min(document.body.scrollHeight - innerHeight, 800)));
        await page.screenshot({ path: path.join(OUT, `${device.name}-${name}-scrolled.png`) });
        checks.push(`${device.name}: ${name} opens and screenshots captured`);
      }
      await page.locator("label[for='v-fut']").click();
      const panel = page.locator("#gm-weekly-panel"); assert.equal(await panel.isVisible(), true);
      assert.match(await panel.innerText(), /UNVALIDATED PAPER RESEARCH/);
      assert.match(await panel.innerText(), /3% TRADE PLAN/);
      assert.match(await panel.innerText(), /including the same day/);
      const bounds = await panel.boundingBox(); assert.ok(bounds.width <= device.viewport.width, "panel must fit the phone");
      if ((await panel.locator(".gm-card").count()) > 0) {
        const card = panel.locator(".gm-card").first();
        await card.locator("summary").click();
        const input = card.locator("input"), output = card.locator("output");
        const p = JSON.parse(await card.getAttribute("data-gm-plan"));
        const changedEntry = (p.entryPrice + p.stopPrice) / 2;
        const expectedTarget = plan({ ...p, entryPrice: changedEntry }).targetPrice.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        await input.fill(String(changedEntry)); assert.ok((await output.innerText()).includes(expectedTarget));
        await input.fill(String(p.stopPrice)); assert.match(await output.innerText(), /outside.*risk/i);
        await input.fill(""); assert.match(await output.innerText(), /Enter your actual fill/);
        await input.fill(String(p.entryPrice)); assert.ok((await output.innerText()).includes(plan(p).targetPrice.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })));
        await card.scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(OUT, `${device.name}-gm-entry-calculator.png`) });
        checks.push(`${device.name}: long target, blank input and risk rejection verified in browser`);
      }
      await context.close();
    }
    const result = { url, at: new Date().toISOString(), checks, status: "PASS_LOCAL_SYNTHETIC_PREVIEW" };
    fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 2));
    console.log(`Browser audit passed: ${checks.length} checks; phone and laptop screenshots in .private/gm-weekly/browser-audit.`);
  } finally { await browser.close(); }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
