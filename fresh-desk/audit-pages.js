"use strict";
const fs = require("node:fs"), path = require("node:path"), http = require("node:http"), assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { buildSite } = require("./build-pages"), { verify } = require("./verify-pages");
const ROOT = path.resolve(__dirname, ".."), OUT = path.join(ROOT, ".private/fresh-desk/pages-audit");
(async () => {
  const output = buildSite({ nse: { inputs: [], state: "MARKET_CLOSED" }, cryptoData: { inputs: [], state: "DATA_UNAVAILABLE", errors: ["PUBLIC_MARKET_DATA_UNAVAILABLE"] } });
  fs.mkdirSync(OUT, { recursive: true });
  const files = new Map();
  for (const folder of ["", "crypto/", "demo/"]) for (const name of ["index.html", "version.json", "app.js", "app.css", "core.js", "hosted.js"]) files.set("/fresh/" + folder + name, path.join(output, folder, name));
  const server = http.createServer((req, res) => {
    let route = new URL(req.url, "http://localhost").pathname; if (route.endsWith("/")) route += "index.html";
    const file = files.get(route); if (!file) { res.writeHead(404).end(); return; }
    res.setHeader("Content-Type", file.endsWith(".css") ? "text/css" : file.endsWith(".js") ? "text/javascript" : file.endsWith(".json") ? "application/json" : "text/html");
    res.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/fresh/`, checks = []; let browser;
  try {
    await verify({ base, root: output, attempts: 1 }); checks.push("served HTML, version and four assets match for all three routes");
    await assert.rejects(verify({ base, root: output, attempts: 1, fetchImpl: async () => ({ ok: true, text: async () => '{"revision":"old"}' }) }), /OLD_VERSION/); checks.push("served check rejects an old deployed revision");
    for (const channel of ["chrome", "msedge", null]) { try { browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) }); break; } catch { /* installed browser */ } }
    if (!browser) throw Error("BROWSER_UNAVAILABLE");
    for (const [device, viewport] of [["phone", { width: 360, height: 780 }], ["laptop", { width: 1536, height: 864 }]]) {
      const context = await browser.newContext({ viewport, acceptDownloads: true }), page = await context.newPage(), errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(base); assert.match(await page.locator("#state").innerText(), /market closed/i); assert.equal(await page.locator(".plan").count(), 0);
      await page.screenshot({ path: path.join(OUT, device + "-nse.png") }); checks.push(device + ": closed market shows no invented entry");
      await page.goto(base + "crypto/"); assert.match(await page.locator("#state").innerText(), /data unavailable/i); assert.equal(await page.locator(".plan").count(), 0); checks.push(device + ": crypto unavailable stays separate from demo");
      await page.screenshot({ path: path.join(OUT, device + "-crypto.png") });
      await page.goto(base + "demo/"); assert.equal(await page.locator(".plan").count(), 8); assert.match(await page.locator(".demo").innerText(), /synthetic/);
      for (const name of ["plans", "market", "playbook", "paper"]) {
        await page.locator(`[data-tab=${name}]`).click(); await page.evaluate(() => scrollTo(0, 0));
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.screenshot({ path: path.join(OUT, `${device}-${name}.png`) });
        await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.screenshot({ path: path.join(OUT, `${device}-${name}-bottom.png`) });
        checks.push(device + ": hosted " + name + " fits");
      }
      await page.locator("[data-tab=plans]").click();
      await page.locator("#chart-type").click(); assert.equal(await page.locator(".plan").first().locator(".line-plot").isVisible(), true); checks.push(device + ": line chart works without an API server");
      const buy = page.locator(".plan[data-side=BUY]").first(); await buy.locator(".fill-details").evaluate((el) => el.open = true);
      await buy.locator(".record").click(); await page.waitForFunction(() => !!document.querySelector(".paper-trade"));
      assert.equal(await page.locator(".paper-trade").count(), 1); await page.reload(); assert.equal(await page.locator(".paper-trade").count(), 1);
      const trade = page.locator(".paper-trade"); await trade.locator(".exit-price").fill("101.7"); await trade.locator(".close-trade").click();
      await page.waitForFunction(() => document.querySelector(".paper-trade")?.innerText.includes("CLOSED")); assert.match(await trade.innerText(), /net unknown/);
      checks.push(device + ": local paper fill survives reload and manual exit preserves unknown costs");
      await page.screenshot({ path: path.join(OUT, device + "-paper-closed.png") });
      const downloadEvent = page.waitForEvent("download"); await page.locator("#export-paper").click(); const download = await downloadEvent;
      const json = JSON.parse(fs.readFileSync(await download.path(), "utf8")); assert.equal(json[0].status, "CLOSED"); checks.push(device + ": paper record backup downloads");
      await page.goto(base); await page.locator("[data-tab=paper]").click(); assert.equal(await page.locator(".paper-trade").count(), 0); checks.push(device + ": demo records never enter live book");
      await page.evaluate(() => localStorage.setItem("fresh-paper-v2-live", '{"damaged":true}')); await page.reload();
      assert.match(await page.locator("#job").innerText(), /damaged/); assert.equal(await page.evaluate(() => localStorage.getItem("fresh-paper-v2-live")), '{"damaged":true}'); checks.push(device + ": damaged storage preserved and recording disabled");
      assert.deepEqual(errors, []); await context.close();
    }
    fs.writeFileSync(path.join(OUT, "result.json"), JSON.stringify({ status: "PASS_LOCAL_PAGES_HOSTING", checks }, null, 2));
    console.log(`Pages hosting audit: ${checks.length} checks passed. Screenshots are private; no public deployment has been made.`);
  } finally { if (browser) await browser.close(); await new Promise((resolve) => server.close(resolve)); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
