"use strict";
// The forward paper test of STRONG short build-up signals (studies/sb-strong-forward-2026-10-23/PREREGISTRATION.txt):
// the night lab's member S7. A short build-up signal exactly as oi-flow-forward.js, and on the raw values the share fell
// at least 3% and its futures OI rose at least 6% -> short at NSE's open of d, cover at the close of d. Judged on EXCESS =
// net + the universe's equal-weighted open-to-close return on d (the night lab's universe and benchmark).
const { calculateNseFuturesCharges } = require("./shadow-broker");
const { isoWeek } = require("./springy-dip");
const ofw = require("./oi-flow-forward");

const RULE = { start: "2026-10-23", rMax: -0.03, oiMin: 0.06, notional: 500000, reset: 0.18, universe: 200, valueWindow: 60, cleanBars: 250,
  minNames: 30, units: 20, minTrades: 100, minMonths: 3 };
const charge = (side, price, qty, date) => calculateNseFuturesCharges({ side, price, quantity: qty, asOfDate: `${date}T12:00:00Z` }).totalCharges;

// The night lab's monthly universe (studies/night-lab-2026-10-23/run.js context()): the top 200 by the median traded value
// of the last 60 bars before the month's first session, with >= 250 bars after the last reset. Built only for the months asked.
function universeFor(sessions, stocks, rule) {
  const firstOf = new Map(); for (const d of sessions) if (!firstOf.has(d.slice(0, 7))) firstOf.set(d.slice(0, 7), d);
  const resets = new Map(stocks.map((st) => [st.sym, st.bars.map((b, k) => (k > 0 && Math.abs(b.o / st.bars[k - 1].c - 1) >= rule.reset ? k : -1)).filter((k) => k > 0)]));
  const cache = new Map();
  return (month) => { if (cache.has(month)) return cache.get(month); const first = firstOf.get(month); const ranked = [];
    if (first) for (const st of stocks) { const b = st.bars; let lo = 0, hi = b.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (b[mid].d < first) lo = mid + 1; else hi = mid; }
      const k = lo; const rs = resets.get(st.sym).filter((x) => x < k); const lc = rs.length ? rs[rs.length - 1] : 0; if (k - lc < rule.cleanBars) continue;
      const v = b.slice(k - rule.valueWindow, k).map((x) => x.val).filter((x) => x > 0).sort((a, c) => a - c); if (v.length) ranked.push([st.sym, v[Math.floor(v.length / 2)]]); }
    ranked.sort((a, c) => c[1] - a[1]); const out = ranked.slice(0, rule.universe).map((x) => x[0]); cache.set(month, out); return out; };
}

function forward({ sessions, stocks, oi, rule = RULE }) {
  const sb = ofw.forward({ sessions, stocks, oi, rule: { ...ofw.RULE, start: rule.start } });
  const sIdx = new Map(sessions.map((d, i) => [d, i])); const bars = new Map(stocks.map((st) => [st.sym, new Map(st.bars.map((b) => [b.d, b]))]));
  const uni = universeFor(sessions, stocks, rule);
  const strength = (sym, d1) => { const d2 = sessions[sIdx.get(d1) - 1]; const m = bars.get(sym), o = oi.get(sym); const p1 = m && m.get(d1), p2 = m && m.get(d2);
    const R = p1 && p2 ? p1.c / p2.c - 1 : null; const OI = o && o.get(d1) > 0 && o.get(d2) > 0 ? o.get(d1) / o.get(d2) - 1 : null;
    return { R, OI, strong: R !== null && OI !== null && R <= rule.rMax && OI >= rule.oiMin }; };
  const bench = (d) => { const xs = []; for (const sym of uni(d.slice(0, 7))) { const b = bars.get(sym).get(d); if (b) xs.push(b.c / b.o - 1); } return xs.length >= rule.minNames ? xs.reduce((a, x) => a + x, 0) / xs.length : null; };
  const pct = (x, k = 2) => +(x * 100).toFixed(k);
  const pending = sb.SB.pending.map((p) => ({ ...p, ...strength(p.symbol, p.signalDate) })).filter((p) => p.strong).map(({ symbol, signalDate, R, OI }) => ({ symbol, signalDate, pricePct: pct(R), oiPct: pct(OI) }));
  const trades = sb.SB.trades.filter((t) => t.entryDate >= rule.start).map((t) => ({ t, s: strength(t.symbol, t.signalDate) })).filter((x) => x.s.strong).map(({ t, s }) => {
    const base = { symbol: t.symbol, signalDate: t.signalDate, entryDate: t.entryDate, pricePct: pct(s.R), oiPct: pct(s.OI) };
    if (t.status !== "DONE") return { ...base, status: t.status };
    const qty = Math.ceil(rule.notional / t.entry); const net = -(t.exit / t.entry - 1) - (charge("SELL", t.entry, qty, t.entryDate) + charge("BUY", t.exit, qty, t.exitDate)) / (t.entry * qty);
    const B = bench(t.entryDate); if (B === null) return { ...base, entry: t.entry, exit: t.exit, status: "NOT COUNTED (universe under 30 names)" };
    return { ...base, entry: t.entry, exit: t.exit, netPct: pct(net, 3), excessPct: pct(net + B, 3), rupees: Math.round(-rule.units * (t.exit - t.entry)), status: "DONE" }; });
  return { lastSession: sb.lastSession, pending, trades, summary: summarise(trades.filter((t) => t.status === "DONE"), rule) };
}

// One-sided 5% critical values of Student's t; the next LOWER listed degrees of freedom when the exact one is not listed.
const T05 = [[1, 6.314], [2, 2.920], [3, 2.353], [4, 2.132], [5, 2.015], [6, 1.943], [7, 1.895], [8, 1.860], [9, 1.833], [10, 1.812], [12, 1.782], [15, 1.753], [20, 1.725],
  [30, 1.697], [60, 1.671], [120, 1.658]];
const tCrit05 = (df) => { let v = null; for (const [k, c] of T05) if (df >= k) v = c; return v; };
function summarise(done, rule) {
  const n = done.length; if (!n) return { finished: 0, verdict: "COLLECTING" };
  const mean = done.reduce((a, t) => a + t.excessPct, 0) / n; const byWeek = new Map(); for (const t of done) { const w = isoWeek(t.entryDate); byWeek.set(w, (byWeek.get(w) || 0) + (t.excessPct - mean)); }
  const G = byWeek.size, s = [...byWeek.values()].reduce((a, x) => a + x * x, 0), se = G > 1 ? Math.sqrt((G / (G - 1)) * s) / n : null, t = se ? mean / se : null;
  const months = (Date.parse(done.map((x) => x.entryDate).sort().pop()) - Date.parse(rule.start)) / (30.44 * 864e5); const crit = tCrit05(G - 1);
  const verdict = !(n >= rule.minTrades && months >= rule.minMonths) ? "COLLECTING" : mean > 0 && t !== null && crit !== null && t >= crit ? "PASS" : "FAIL";
  const r3 = (x) => +x.toFixed(3);
  return { finished: n, meanExcessPct: r3(mean), meanNetPct: r3(done.reduce((a, x) => a + x.netPct, 0) / n), winPct: +((100 * done.filter((x) => x.netPct > 0).length) / n).toFixed(1),
    worstNetPct: Math.min(...done.map((x) => x.netPct)), rupees: done.reduce((a, x) => a + x.rupees, 0), weeks: G, t: t === null ? null : +t.toFixed(2), verdict };
}
module.exports = { RULE, forward, summarise, tCrit05 };
