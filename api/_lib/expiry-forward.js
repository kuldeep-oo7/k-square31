"use strict";
// EXPIRY-DAY NIFTY OPTION SELLING, FORWARD PAPER TEST (studies/expiry-selling-forward-2026-10-21/PREREGISTRATION.txt).
// The rules of studies/expiry-selling-2026-10-20 (branch claude/expiry-selling-2026-10-20; all four members PASSED on
// 351 expiries, 2020-2026), copied unchanged and proven the same by scripts/expiry-forward-replay.js:
//   X1 ATM straddle, held; X2 ATM straddle, 2x stop per leg; X3 1% strangle, held; X4 1% strangle, 2x stop per leg.
// Each leg is sold at its OPEN on the expiry session, strikes nearest NIFTY's open (NSE ind_close_all), and bought back at
// intrinsic against the final settlement (the median settle of that day's expiring rows) -- or at 2x its entry if the
// day's high reached it. Costs: api/_lib/trade-costs.js for 75 units (as registered) plus 1 point a leg.
const { roundTripCost } = require("./trade-costs");

const START = "2026-10-27", QTY = 75, SLIP = 1, PRIMARY = "X2", NEED = 52, T_ONE_SIDED = 1.68;
const MEMBERS = { X1: "ATM straddle, held", X2: "ATM straddle, 2x stop per leg", X3: "1% strangle, held", X4: "1% strangle, 2x stop per leg" };

// One short leg: sold at its open; bought back at 2x if the day's high reached it (stop members), else settled at
// intrinsic. Costs: the desk's option model with the SELL at the entry premium (STT on the sale), plus slippage.
function leg(row, S, stop, costs) {
  const [, K, typ, open, high] = row; if (!(open > 0)) return null;
  const intrinsic = typ === "CE" ? Math.max(0, S - K) : Math.max(0, K - S);
  const stopped = stop && high >= 2 * open; const exit = stopped ? 2 * open : intrinsic;
  let cost = 0; if (costs) { const r = roundTripCost({ entryPremium: Math.max(exit, 0.05), exitPremium: open, quantity: QTY }); if (!r) return null; cost = r.totalCost / QTY + SLIP; }
  return { pnl: open - exit - cost, stopped };
}
const nearest = (rows, typ, target) => { const c = rows.filter((r) => r[2] === typ); if (!c.length) return null;
  return c.reduce((best, r) => { const d = Math.abs(r[1] - target), b = Math.abs(best[1] - target); return d < b || (d === b && Math.abs(r[1] - target) === b && (typ === "CE" ? r[1] > best[1] : r[1] < best[1])) ? r : best; }); };

// days: [{date, open (NIFTY), settle (NIFTY final settlement), rows: [[exp, K, typ, open, high, low, close, settle, oi, n]]}]
function run(days, costs = true) {
  const out = { X1: [], X2: [], X3: [], X4: [] }; let skipped = 0;
  for (const d of days) {
    const rows = d.rows.filter((r) => r[0] === d.date); if (!rows.length) continue;
    if (!(d.open > 0) || !(d.settle > 0)) { skipped += 1; continue; }
    const atmC = nearest(rows, "CE", d.open), atmP = nearest(rows, "PE", d.open), oC = nearest(rows, "CE", d.open * 1.01), oP = nearest(rows, "PE", d.open * 0.99);
    for (const [k, c, p, stop] of [["X1", atmC, atmP, false], ["X2", atmC, atmP, true], ["X3", oC, oP, false], ["X4", oC, oP, true]]) {
      if (!c || !p) { skipped += 1; continue; }
      const a = leg(c, d.settle, stop, costs), b = leg(p, d.settle, stop, costs); if (!a || !b) { skipped += 1; continue; }
      out[k].push({ date: d.date, pct: ((a.pnl + b.pnl) / d.open) * 100, points: a.pnl + b.pnl, stops: (a.stopped ? 1 : 0) + (b.stopped ? 1 : 0),
        call: c[1], put: p[1], credit: c[3] + p[3] });
    }
  }
  return { out, skipped };
}

// One expiry session from a day's file of NIFTY option rows (scripts/nse-nifty-option-days.js) and NIFTY's open
function expiryDay(file, niftyOpen) {
  const exp = (file.rows || []).filter((r) => r[0] === file.date); if (!exp.length) return null;
  const st = exp.map((r) => r[7]).filter((v) => v > 0).sort((x, y) => x - y);
  return { date: file.date, open: niftyOpen ?? null, settle: st.length ? st[Math.floor(st.length / 2)] : null, rows: exp, lot: file.lot ?? null };
}

// The forward verdict (registration section 5): X2's per-expiry net returns; after NEED expiries, CONFIRMED if the mean is
// above 0 and t (one-sided) >= 1.68, else NOT CONFIRMED. Every member reports the same figures.
function summary(list) {
  const n = list.length; if (!n) return { expiries: 0, verdict: "COLLECTING" };
  const v = list.map((t) => t.pct); const m = v.reduce((a, x) => a + x, 0) / n;
  const sd = n > 1 ? Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / (n - 1)) : null; const t = sd > 0 ? m / (sd / Math.sqrt(n)) : null;
  const pts = list.reduce((a, x) => a + x.points, 0);
  return { expiries: n, meanPct: +m.toFixed(4), meanPoints: +(pts / n).toFixed(2), totalPoints: +pts.toFixed(2), won: Math.round((100 * list.filter((x) => x.pct > 0).length) / n),
    worstPoints: +Math.min(...list.map((x) => x.points)).toFixed(2), t: t === null ? null : +t.toFixed(2),
    verdict: n < NEED ? "COLLECTING" : m > 0 && t >= T_ONE_SIDED ? "CONFIRMED" : "NOT CONFIRMED" };
}
module.exports = { START, QTY, SLIP, PRIMARY, NEED, T_ONE_SIDED, MEMBERS, leg, nearest, run, expiryDay, summary };
