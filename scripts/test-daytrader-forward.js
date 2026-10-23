"use strict";
// Tests api/_lib/daytrader-forward.js and its TRACK box (studies/daytrader-forward-2026-10-26) on synthetic data.
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const L = require("../api/_lib/daytrader-forward");
const { shaOf } = require("./daytrader-forward");
const { daytraderBox } = require("./publish-static-desk");
const { calculateNseFuturesCharges } = require("../api/_lib/shadow-broker");

// 1. the registration is the committed one
assert.strictEqual(shaOf("PREREGISTRATION.txt"), fs.readFileSync(path.join(__dirname, "..", "studies", "daytrader-forward-2026-10-26", "PREREGISTRATION.sha256"), "utf8").split(/\s+/)[0]);

// 2. a day's book: 60 names, k = 6; the highest probabilities are bought, the lowest sold
const rows = Array.from({ length: 60 }, (_, k) => ({ id: `2026-10-26|S${k}`, date: "2026-10-26", symbol: `S${k}`, fo: 100, fc: 100 * (1 + (k - 30) / 1000) }));
const prob = new Map(rows.map((r, k) => [r.id, k / 100]));
const [b] = L.books(rows, prob); const q = Math.ceil(500000 / 100), ch = (side, p) => calculateNseFuturesCharges({ side, price: p, quantity: q, asOfDate: "2026-10-26T12:00:00Z" }).totalCharges;
const leg = (side, c) => side * (c / 100 - 1) - (ch(side > 0 ? "BUY" : "SELL", 100) + ch(side > 0 ? "SELL" : "BUY", c)) / (100 * q);
const longs = rows.slice(-6), shorts = rows.slice(0, 6), mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const want = +((((mean(longs.map((r) => leg(1, r.fc))) + mean(shorts.map((r) => leg(-1, r.fc)))) / 2) * 100).toFixed(3));
assert.strictEqual(b.k, 6); assert.strictEqual(b.bookPct, want); assert.deepStrictEqual(b.top3Long, ["S59", "S58", "S57"]); assert.deepStrictEqual(b.top3Short, ["S0", "S1", "S2"]);
assert.strictEqual(L.books(rows.slice(0, 49), prob).length, 0, "under 50 names: no book");

// 3. the verdict: COLLECTING under 60 sessions or 3 months; then the one-sided t of the weekly means
const days = (n, f) => Array.from({ length: n }, (_, i) => { const d = new Date(Date.parse("2026-10-26") + Math.floor(i * 1.45) * 864e5); return { date: d.toISOString().slice(0, 10), bookPct: f(i), longExcessPct: 0, shortExcessPct: 0, top3Pct: 0 }; });
assert.strictEqual(L.summary(days(59, () => 0.1)).verdict, "COLLECTING");
assert.strictEqual(L.summary(days(70, (i) => 0.05 + (i % 3 - 1) * 0.02)).verdict, "PASS");
assert.strictEqual(L.summary(days(70, (i) => -0.05 + (i % 3 - 1) * 0.02)).verdict, "FAIL");

// 4. the TRACK box
assert.strictEqual(daytraderBox(null), "");
const doc = { start: "2026-10-26", dataThrough: "2026-10-26", preregistration: "p", fit: "f", rule: "r", backtest: "b",
  days: [{ date: "2026-10-26", bookPct: 0.12, top3Pct: -0.4, top3Long: ["AAA", "BBB", "CCC"], top3Short: ["XXX", "YYY", "ZZZ"] }], summary: { sessions: 1, bookPct: 0.12, wonPct: 100, t: null, top3Pct: -0.4, verdict: "COLLECTING" } };
const h = daytraderBox(doc);
assert.ok(h.includes("AI DAY-TRADER") && h.includes("COLLECTING") && h.includes("+0.12%") && h.includes("&minus;0.4%") && h.includes("AAA, BBB, CCC") && h.includes("Latest days") && h.includes("faded"));
assert.ok(daytraderBox({ ...doc, days: [] }).includes("First book after the close of 2026-10-26."));
console.log("daytrader-forward: all tests passed");
