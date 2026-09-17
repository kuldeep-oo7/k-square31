"use strict";
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { document_ } = require("./build-portal");
async function run() {
  const browser = await chromium.launch({ headless: true, ...(process.platform === "win32" ? { channel: "msedge" } : {}) });
  try {
    const page = await browser.newPage(), errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.setContent(document_({},null,{builtAt:"TEST"},null,{}));
    assert.match(await page.locator("#monitor-status").innerText(),/NOT CONNECTED/);
    assert.equal(await page.locator(".copy-btn").count(),0);
    let stale = false;
    await page.route("https://monitor.example/alerts", route => route.fulfill({
      status:200,contentType:"application/json",headers:{"Access-Control-Allow-Origin":"*"},body:JSON.stringify({
        state:stale?"FEED_STALE":"OBSERVING_RESEARCH_ONLY", generatedAt:new Date().toISOString(), latestVerifiedQuoteReceivedAt:new Date().toISOString(),
        observedInstruments:2,feedIssue:null, alerts:[{symbol:"<script>bad()</script>",kind:"PRIOR_HIGH_BREAKOUT",eventAt:new Date().toISOString(),explanation:"Fixture only",actionable:false}]
      })
    }));
    await page.setContent(document_({},null,{builtAt:"TEST",monitorUrl:"https://monitor.example"},null,{}));
    await page.waitForFunction(()=>document.getElementById("monitor-status").textContent.includes("MONITOR CONNECTED"));
    assert.match(await page.locator("#continuous-alerts").innerText(),/Fixture only/);
    assert.equal(await page.locator("#continuous-alerts script").count(),0,"untrusted headlines/symbols are text, not executable HTML");
    stale=true;
    await page.waitForFunction(()=>document.getElementById("monitor-status").textContent.includes("MONITOR UNAVAILABLE"),{},{timeout:12000});
    assert.equal(await page.locator("#continuous-alerts").innerText(),"");
    assert.deepEqual(errors,[]);
    await page.setViewportSize({width:390,height:844});
    assert.ok(await page.locator("#recommendation-desk").isVisible());
    console.log("Browser audit passed: disconnected/connected/stale monitor, immediate alert rendering, no fake order copy, injection-safe text, no JS errors, mobile visibility.");
  } finally { await browser.close(); }
}
if(require.main===module)run().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={run};
