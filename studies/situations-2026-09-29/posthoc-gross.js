"use strict";
// POST-HOC CHECK, NOT PART OF THE PRE-REGISTERED STUDY (run after RESULT.txt was read):
// how much of B-DAY's -0.08%/day is the futures charges? NIFTY open->close GROSS, and the
// charge per round trip by window.
const fs = require("node:fs");
const path = require("node:path");
const ROOT = path.resolve(__dirname, "..", "..");
const { calculateNseFuturesCharges } = require(path.join(ROOT, "api/_lib/shadow-broker"));
const { clusterRobustMean } = require(path.join(ROOT, "api/_lib/panel"));
const bars = JSON.parse(fs.readFileSync(path.join(ROOT, "research/gap-filter-2026-09-29/nifty-50-nse.json"), "utf8")).rows
  .map((r) => ({ date: r.date, open: Number(r.open), close: Number(r.close) })).filter((b) => b.open > 0 && b.close > 0);
const sessions = new Set(bars.map((b) => b.date));
const weekly = new Set(JSON.parse(fs.readFileSync(path.join(__dirname, "nifty-expiries-nse.json"), "utf8")).OPTIDX.filter((d) => sessions.has(d)));
const win = (d) => (d < "2024-09-19" ? "development" : d < "2025-09-18" ? "validation" : d <= "2026-09-15" ? "final" : null);
const rows = bars.slice(1).filter((b) => win(b.date)).map((b) => {
  const qty = Math.ceil(500000 / b.open);
  const cost = (calculateNseFuturesCharges({ side: "BUY", price: b.open, quantity: qty, asOfDate: `${b.date}T12:00:00Z` }).totalCharges
    + calculateNseFuturesCharges({ side: "SELL", price: b.close, quantity: qty, asOfDate: `${b.date}T12:00:00Z` }).totalCharges) / (b.open * qty);
  return { date: b.date, month: b.date.slice(0, 7), w: win(b.date), gross: b.close / b.open - 1, cost, expiry: weekly.has(b.date) };
});
const st = (xs, f) => { const r = clusterRobustMean(xs.map((x) => ({ value: f(x) * 100, cluster: x.month }))); return `${xs.length} days, mean ${r.meanPct >= 0 ? "+" : ""}${r.meanPct.toFixed(3)}%, t ${r.tStat.toFixed(2)}`; };
for (const w of ["development", "validation", "final"]) {
  const xs = rows.filter((x) => x.w === w);
  console.log(`${w.padEnd(12)} charges per round trip ${(100 * xs.reduce((a, x) => a + x.cost, 0) / xs.length).toFixed(3)}% | GROSS open->close ${st(xs, (x) => x.gross)}`);
}
console.log(`all days     GROSS open->close ${st(rows, (x) => x.gross)}   | NET ${st(rows, (x) => x.gross - x.cost)}`);
console.log(`expiry days  GROSS open->close ${st(rows.filter((x) => x.expiry), (x) => x.gross)}`);
console.log(`other days   GROSS open->close ${st(rows.filter((x) => !x.expiry), (x) => x.gross)}`);
