"use strict";
// Tests api/_lib/sb-strong-forward.js (studies/sb-strong-forward-2026-10-23) on a synthetic market, plus the registration hash.
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { RULE, forward, summarise, tCrit05 } = require("../api/_lib/sb-strong-forward");
const { preregSha } = require("./sb-strong-forward");
const { calculateNseFuturesCharges } = require("../api/_lib/shadow-broker");

// 1. the registration is the committed one
assert.strictEqual(preregSha(), fs.readFileSync(path.join(__dirname, "..", "studies", "sb-strong-forward-2026-10-23", "PREREGISTRATION.sha256"), "utf8").split(/\s+/)[0]);

// 2. one-sided 5% critical values: the next LOWER listed degrees of freedom
assert.strictEqual(tCrit05(13), 1.782); assert.strictEqual(tCrit05(12), 1.782); assert.strictEqual(tCrit05(200), 1.658); assert.strictEqual(tCrit05(0), null);

// 3. a synthetic market: 40 stocks, 320 sessions; on the signal day X falls 5% with OI +10% (strong), Y falls 2% with OI +4% (weak)
const sessions = []; for (let t = Date.parse("2025-08-01"); sessions.length < 320; t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) sessions.push(d.toISOString().slice(0, 10)); }
const sig = sessions.length - 3, entry = sig + 1;   // signal session (d-1) and entry session (d)
const stocks = Array.from({ length: 40 }, (_, k) => ({ sym: k === 0 ? "X" : k === 1 ? "Y" : `S${k}`, bars: sessions.map((d, i) => {
  let c = 100 + k; if (i === sig) c = k === 0 ? (100 + k) * 0.95 : k === 1 ? (100 + k) * 0.98 : c; if (i > sig) c = k === 0 ? (100 + k) * 0.95 : k === 1 ? (100 + k) * 0.98 : c;
  let o = c; if (i === entry) { o = c; c = k === 0 ? o * 0.98 : k === 1 ? o * 0.99 : o * 1.001; }
  return { d, o, h: Math.max(o, c), l: Math.min(o, c), c, val: 1e9 - k }; }) }));
const oi = new Map([["X", new Map(sessions.map((d, i) => [d, i >= sig ? 1.1e6 : 1e6]))], ["Y", new Map(sessions.map((d, i) => [d, i >= sig ? 1.04e6 : 1e6]))]]);
const res = forward({ sessions, stocks, oi, rule: { ...RULE, start: sessions[entry] } });
const done = res.trades.filter((t) => t.status === "DONE");
assert.deepStrictEqual(done.map((t) => t.symbol), ["X"], "only the strong signal is a trade");
const x = done[0], bx = stocks[0].bars[entry], q = Math.ceil(500000 / bx.o);
const net = -(bx.c / bx.o - 1) - (calculateNseFuturesCharges({ side: "SELL", price: bx.o, quantity: q, asOfDate: `${bx.d}T12:00:00Z` }).totalCharges + calculateNseFuturesCharges({ side: "BUY", price: bx.c, quantity: q, asOfDate: `${bx.d}T12:00:00Z` }).totalCharges) / (bx.o * q);
const B = stocks.reduce((a, s) => a + (s.bars[entry].c / s.bars[entry].o - 1), 0) / 40;
assert.ok(Math.abs(x.netPct - +(net * 100).toFixed(3)) < 1e-9, "net after charges");
assert.ok(Math.abs(x.excessPct - +((net + B) * 100).toFixed(3)) < 1e-9, "excess = net + the universe's open-to-close");
assert.strictEqual(x.rupees, Math.round(-20 * (bx.c - bx.o)));
assert.strictEqual(x.pricePct, -5); assert.strictEqual(x.oiPct, 10);
assert.strictEqual(res.pending.length, 0);

// 4. the next-session list: move the signal to the last session
const res2 = forward({ sessions: sessions.slice(0, entry), stocks: stocks.map((s) => ({ ...s, bars: s.bars.slice(0, entry) })), oi, rule: { ...RULE, start: sessions[entry - 1] } });
assert.deepStrictEqual(res2.pending.map((p) => p.symbol), ["X"], "the strong signal is listed for the next session; the weak one is not");

// 5. the verdict: COLLECTING under 100 trades or 3 months; then PASS / FAIL on the one-sided t
const mk = (n, f) => Array.from({ length: n }, (_, i) => { const d = new Date(Date.parse("2026-10-23") + Math.floor((i * 100) / n) * 864e5).toISOString().slice(0, 10); return { entryDate: d, netPct: f(i), excessPct: f(i), rupees: 0 }; });
assert.strictEqual(summarise(mk(99, (i) => 0.5 + (i % 2)), RULE).verdict, "COLLECTING");
assert.strictEqual(summarise(mk(120, (i) => 0.3 + (i % 3 ? 0.5 : -0.5)), RULE).verdict, "PASS");
assert.strictEqual(summarise(mk(120, (i) => (i % 2 ? 0.5 : -0.6)), RULE).verdict, "FAIL");
console.log("sb-strong-forward: all tests passed");

// 6. the TRACK box: verdict line visible, lists folded, nothing when the file is missing
const { sbStrongBox } = require("./publish-static-desk");
assert.strictEqual(sbStrongBox(null), "");
const doc = { start: "2026-10-23", dataThrough: "2026-10-23", preregistration: "studies/sb-strong-forward-2026-10-23/PREREGISTRATION.txt", rule: "r", backtest: "b",
  pending: [{ symbol: "SWIGGY", signalDate: "2026-10-23", pricePct: -5.48, oiPct: 12.66 }],
  trades: [{ symbol: "ABC", entryDate: "2026-10-23", netPct: 1.234, excessPct: -0.5, status: "DONE" }], summary: { finished: 1, meanNetPct: 1.234, meanExcessPct: -0.5, winPct: 100, t: null, verdict: "COLLECTING" } };
const h = sbStrongBox(doc);
assert.ok(h.includes("SHORT BUILD-UP, STRONG SIGNALS ONLY") && h.includes("COLLECTING") && h.includes("SWIGGY") && h.includes("&minus;5.48%") && h.includes("+12.66%"));
assert.ok(h.includes("+1.234%") && h.includes("&minus;0.5%") && h.includes("Next session: 1 strong signal"));
assert.ok(sbStrongBox({ ...doc, pending: [] }).includes("No strong signal for the next session."));
console.log("sb-strong box: all tests passed");
