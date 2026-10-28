"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { pathToFileURL } = require("node:url");
const { createDesk } = require("./server");
const { main } = require("./run");
const { levels } = require("./engine");
const ROOT = path.resolve(__dirname, ".."), OUT = path.join(ROOT, ".private/fresh-desk/audit");
(async () => {
  fs.mkdirSync(OUT, { recursive: true }); await main(["--demo"]);
  let browser, app; const checks = [];
  for (const channel of ["chrome", "msedge", null]) { try { browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) }); break; } catch { /* try an installed browser */ } }
  if (!browser) throw Error("BROWSER_UNAVAILABLE");
  try {
    for (const [device, viewport] of [["phone", { width: 360, height: 780 }], ["laptop", { width: 1536, height: 864 }]]) {
      const dataDir = fs.mkdtempSync(path.join(ROOT, ".private/fresh-browser-" + device + "-"));
      app = await createDesk({ source: "demo", port: 0, dataDir, autoRefresh: false });
      const context = await browser.newContext({ viewport, isMobile: device === "phone", hasTouch: device === "phone" }), page = await context.newPage(), errors = [];
      page.on("pageerror", (e) => errors.push(e.message)); await page.goto(app.url);
      assert.match(await page.locator(".demo").innerText(), /synthetic prices/); assert.equal(await page.locator(".plan").count(), 8);
      for (const name of ["plans", "market", "playbook", "paper"]) {
        await page.locator(`[data-tab='${name}']`).click(); await page.evaluate(() => window.scrollTo(0, 0));
        assert.equal(await page.locator("#" + name).isVisible(), true);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, device + ": " + name + " overflows");
        await page.screenshot({ path: path.join(OUT, `${device}-${name}-top.png`) });
        await page.evaluate(() => window.scrollTo(0, Math.min(document.body.scrollHeight - innerHeight, 900))); await page.screenshot({ path: path.join(OUT, `${device}-${name}-scrolled.png`) });
        checks.push(`${device}: ${name} top and scrolled, no horizontal overflow`);
      }
      await page.locator("[data-tab=plans]").click();
      for (const side of ["BUY", "SELL"]) {
        await page.locator(`[data-filter='${side}']`).click(); assert.equal(await page.locator(`.lane[data-side='${side}']`).isVisible(), true);
        assert.equal(await page.locator(`.lane[data-side='${side === "BUY" ? "SELL" : "BUY"}']`).isVisible(), false);
        const card = page.locator(`.plan[data-side='${side}']`).first(), p = JSON.parse(await card.getAttribute("data-plan"));
        await card.locator(".fill-details summary").click(); const fill = card.locator(".fill"), output = card.locator("output"), actual = (p.entry + p.stop) / 2;
        const expected = levels({ ...p, entry: actual }); await fill.fill(String(actual));
        assert.ok((await output.innerText()).includes(expected.goalTarget.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })));
        await fill.fill(String(p.stop)); assert.match(await output.innerText(), /risk limit/); assert.equal(await card.locator(".record").isDisabled(), true);
        await fill.fill(""); assert.match(await output.innerText(), /fill and quantity/); await fill.fill(String(p.entry));
        await card.evaluate((el) => el.scrollIntoView({ block: "start" })); await page.screenshot({ path: path.join(OUT, `${device}-${side.toLowerCase()}-calculator.png`) });
        checks.push(`${device}: ${side} structural target, 3% fill reference and risk rejection`);
      }
      await page.locator("[data-filter=ALL]").click(); await page.locator("#family").selectOption("RANGE_BOUNCE"); assert.equal(await page.locator(".plan:visible").count(), 2);
      await page.locator("#family").selectOption("ALL"); await page.locator("#search").fill("TREND-PULLBACK"); assert.equal(await page.locator(".plan:visible").count(), 2); await page.locator("#search").fill("");
      await page.locator("#chart-type").click(); assert.equal(await page.locator(".plan").first().locator(".line-plot").isVisible(), true); await page.locator("#chart-type").click();
      checks.push(`${device}: family/symbol filters and actual-price line chart`);
      const first = page.locator(".plan[data-side=BUY]").first(); await first.locator(".record").click(); await page.waitForLoadState("load");
      await page.locator("[data-tab=paper]").click(); await page.locator(".paper-trade").waitFor(); const trade = page.locator(".paper-trade").first();
      await trade.locator(".exit-price").fill("101.7"); await trade.locator(".close-trade").click();
      await page.waitForFunction(() => document.querySelector(".paper-trade")?.innerText.includes("CLOSED")); assert.match(await page.locator(".paper-trade").innerText(), /net unknown/);
      await page.screenshot({ path: path.join(OUT, `${device}-paper-closed.png`) }); checks.push(`${device}: browser entry → persisted paper trade → manual exit, unknown net preserved`);
      assert.deepEqual(errors, []);
      // Static export uses copied assets and works without a server.
      const staticPage = await context.newPage(); await staticPage.goto(pathToFileURL(path.join(ROOT, ".private/fresh-desk/demo/index.html")).href);
      await staticPage.locator("[data-tab=playbook]").click(); assert.equal(await staticPage.locator(".playbook:visible").count(), 4); checks.push(`${device}: offline static export`);
      const htmlFile = path.join(ROOT, ".private/fresh-desk/demo/expired-test.html"), html = fs.readFileSync(path.join(ROOT, ".private/fresh-desk/demo/index.html"), "utf8").replace('"demo":true', '"demo":false'); fs.writeFileSync(htmlFile, html);
      const stale = await context.newPage(); await stale.addInitScript(() => { Date.now = () => Date.parse("2026-10-28T15:00:00+05:30"); });
      await stale.goto(pathToFileURL(htmlFile).href); assert.equal(await stale.locator(".plan.expired").count(), 8); checks.push(`${device}: all stale references expire`);
      await context.close(); await app.close(); app = null;
    }
    fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify({ status: "PASS_LOCAL_SYNTHETIC_HTTP_AND_STATIC", checks }, null, 2));
    console.log(`Workbench browser audit: ${checks.length} checks passed; all four workspaces photographed on phone and laptop, including paper entry/exit flow.`);
  } finally { if (app) await app.close(); await browser.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
