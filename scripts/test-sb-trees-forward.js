"use strict";
// Tests api/_lib/sb-trees-forward.js and the TRACK box (studies/sb-trees-forward-2026-10-23) on synthetic data.
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const L = require("../api/_lib/sb-trees-forward");
const { shaOf } = require("./sb-trees-forward");
const { sbTreesBox } = require("./publish-static-desk");
const { calculateNseFuturesCharges } = require("../api/_lib/shadow-broker");

// 1. the registration is the committed one; FIT.txt names the model's sha256
assert.strictEqual(shaOf("PREREGISTRATION.txt"), fs.readFileSync(path.join(__dirname, "..", "studies", "sb-trees-forward-2026-10-23", "PREREGISTRATION.sha256"), "utf8").split(/\s+/)[0]);
assert.match(fs.readFileSync(path.join(__dirname, "..", "studies", "sb-trees-forward-2026-10-23", "FIT.txt"), "utf8"), /sha256 [0-9a-f]{64}/);

// 2. a synthetic market: 40 stocks, 320 sessions; X and Y are short build-up signals for the last-but-one session
const sessions = []; for (let t = Date.parse("2025-08-01"); sessions.length < 320; t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) sessions.push(d.toISOString().slice(0, 10)); }
const sig = sessions.length - 3, entry = sig + 1, D = sessions[entry], D1 = sessions[sig];
const stocks = Array.from({ length: 40 }, (_, k) => ({ sym: k === 0 ? "X" : k === 1 ? "Y" : `S${k}`, bars: sessions.map((d, i) => {
  let c = 100 + k; if (i >= sig) c = k === 0 ? (100 + k) * 0.95 : k === 1 ? (100 + k) * 0.98 : c; let o = c; if (i === entry) { c = k === 0 ? o * 0.98 : k === 1 ? o * 0.99 : o * 1.001; }
  return { d, o, h: Math.max(o, c), l: Math.min(o, c), c, v: 1000 + k, val: 1e9 - k }; }) }));
const P = { sessions, stocks, oi: new Map([["X", new Map(sessions.map((d, i) => [d, i >= sig ? 1.1e6 : 1e6]))], ["Y", new Map(sessions.map((d, i) => [d, i >= sig ? 1.04e6 : 1e6]))]]),
  fnear: new Map(stocks.map((s) => [s.sym, new Map([[D, { e: "2099-01-01", o: s.bars[entry].o * 0.998, c: s.bars[entry].c * 1.001 }]])])), futNear: new Map(), expiries: new Map([[D1, [sessions[entry + 1]]]]),
  fut: new Map(), idx: new Map([[D1, { o: 100, c: 101 }], [D, { o: 100.5, c: 102 }]]) };
const r = L.rows(P, { ...L.RULE, start: D }); const done = r.rows.filter((x) => x.status === "DONE");
assert.deepStrictEqual(done.map((x) => x.symbol).sort(), ["X", "Y"], "every short build-up trade is decided, strong or not");
const fx = P.fnear.get("X").get(D), q = Math.ceil(500000 / fx.o), ch = (side, p) => calculateNseFuturesCharges({ side, price: p, quantity: q, asOfDate: `${D}T12:00:00Z` }).totalCharges;
const netX = -(fx.c / fx.o - 1) - (ch("SELL", fx.o) + ch("BUY", fx.c)) / (fx.o * q), B = stocks.reduce((a, s) => a + (P.fnear.get(s.sym).get(D).c / P.fnear.get(s.sym).get(D).o - 1), 0) / 40;
const x = done.find((y) => y.symbol === "X"); assert.ok(Math.abs(x.net - netX) < 1e-12 && Math.abs(x.excess - (netX + B)) < 1e-12, "futures net and excess");
assert.ok(Math.abs(x.features.GAP - 0) < 1e-12 && Math.abs(x.features.NGAP - (100.5 / 101 - 1)) < 1e-12 && x.features.TOEXP === 1 && x.features.NSIG === 2, "09:15 features");
const csv = L.toCsv(r.rows).trim().split("\n"); assert.strictEqual(csv.length, 3); assert.strictEqual(csv[0], "id," + L.FEATS.join(","));
const noFut = L.rows({ ...P, fnear: new Map() }, { ...L.RULE, start: D }); assert.ok(noFut.rows.every((y) => y.status === "NO FUTURES PRICE"));

// 3. the verdict: the weekly spread of futures excess, TAKE minus SKIP
assert.strictEqual(L.tCrit05(13), 1.782); assert.strictEqual(L.tCrit05(0), null);
const mk = (n, f) => Array.from({ length: n }, (_, i) => ({ entryDate: new Date(Date.parse("2026-10-23") + Math.floor((i * 100) / n) * 864e5).toISOString().slice(0, 10), take: i % 2 === 0, net: f(i), excess: f(i), rupees: 10 }));
assert.strictEqual(L.summary(mk(99, () => 0.01)).verdict, "COLLECTING");
assert.strictEqual(L.summary(mk(140, (i) => (i % 2 === 0 ? 0.004 : -0.001) + (i % 7) * 0.0001)).verdict, "PASS");
assert.strictEqual(L.summary(mk(140, (i) => (i % 2 === 0 ? -0.004 : 0.001) + (i % 7) * 0.0001)).verdict, "FAIL");
const s = L.summary(mk(140, (i) => (i % 2 === 0 ? 0.004 : -0.001))); assert.strictEqual(s.taken, 70); assert.strictEqual(s.takeRupees, 700);

// 4. the TRACK box
assert.strictEqual(sbTreesBox(null), "");
const doc = { start: "2026-10-23", dataThrough: "2026-10-23", preregistration: "p", fit: "f", rule: "r", backtest: "b",
  trades: [{ symbol: "ABC", entryDate: "2026-10-23", decision: "TAKE", netPct: 0.512, excessPct: -0.1, status: "DONE" }, { symbol: "DEF", entryDate: "2026-10-23", decision: "SKIP", netPct: -0.2, excessPct: 0.3, status: "DONE" }],
  summary: { counted: 2, taken: 1, takeNetPct: 0.512, allNetPct: 0.156, spreadPct: null, t: null, verdict: "COLLECTING" } };
const h = sbTreesBox(doc);
assert.ok(h.includes("THE TREES MODEL") && h.includes("COLLECTING") && h.includes("<b>TAKE</b>") && h.includes("skip") && h.includes("+0.512%") && h.includes("&minus;0.2%") && h.includes("Latest decisions"));
assert.ok(sbTreesBox({ ...doc, trades: [] }).includes("First decisions after the next close."));
console.log("sb-trees-forward: all tests passed");
