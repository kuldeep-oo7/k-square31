"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { createDesk } = require("./server");
(async () => {
  const dataDir = fs.mkdtempSync(path.join(__dirname, "../.private/fresh-http-test-"));
  let app, checks = 0;
  try {
    app = await createDesk({ source: "demo", port: 0, dataDir, autoRefresh: false });
    const page = await (await fetch(app.url)).text(), match = page.match(/<script id="bootstrap" type="application\/json">([^<]+)<\/script>/), config = JSON.parse(match[1]);
    assert.ok(config.csrf); checks++;
    const post = (route, data, headers = {}) => fetch(app.url + route, { method: "POST", headers: { "Content-Type": "application/json", "X-Fresh-CSRF": config.csrf, ...headers }, body: JSON.stringify(data) });
    assert.equal((await fetch(app.url + "/api/paper", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 403); checks++;
    assert.equal((await post("/api/refresh", { source: "demo" }, { Origin: "https://example.invalid" })).status, 403); checks++;
    const snapshot = await (await fetch(app.url + "/api/snapshot")).json(); assert.equal(snapshot.results.length, 8); assert.equal(snapshot.demo, true); checks++;
    const plan = snapshot.results[0].plans[0], payload = { planId: plan.id, fill: plan.entry, quantity: 20 };
    const duplicate = await Promise.all([post("/api/paper", payload), post("/api/paper", payload)]); assert.deepEqual(duplicate.map((r) => r.status).sort(), [201, 400]); checks++;
    const bookPath = path.join(dataDir, "paper-demo.json"), book = JSON.parse(fs.readFileSync(bookPath)); assert.equal(book.length, 1); assert.equal(book[0].stop, plan.stop); checks++;
    const close = await post("/api/paper/close", { id: book[0].id, price: plan.target, costs: null }); assert.equal(close.status, 200);
    const closed = JSON.parse(fs.readFileSync(bookPath))[0]; assert.equal(closed.status, "CLOSED"); assert.equal(closed.exit.net, null); checks++;
    assert.equal((await post("/api/paper/close", { id: book[0].id, price: 1 })).status, 400); checks++;
    assert.equal((await post("/api/paper", { ...payload, planId: "invented" })).status, 400); checks++;
    assert.equal((await post("/api/import", { inputs: [{ symbol: "BAD", bars: null }] })).status, 400); checks++;
    assert.equal((await post("/api/import", { inputs: [], demo: true, state: "LIVE", tradingSession: true })).status, 200);
    const imported = await (await fetch(app.url + "/api/snapshot")).json(); assert.equal(imported.demo, false); assert.equal(imported.source, "import"); assert.equal(imported.state, "IMPORTED_RESEARCH"); checks++;
    assert.ok(!fs.existsSync(path.join(dataDir, "paper-live.json"))); checks++;
    assert.equal((await fetch(app.url + "/.private/brokers.json")).status, 404); checks++;
    assert.ok((await fetch(app.url)).headers.get("content-security-policy").includes("connect-src 'self'")); checks++;
    console.log(`Fresh HTTP app: ${checks} checks passed; CSRF, paper persistence/idempotence, imports, source separation and private-file protection.`);
  } finally { if (app) await app.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
