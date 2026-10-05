"use strict";
// Forward paper tests of the protocol-v2 survivors (studies/forward-v2-2026-10-04/PREREGISTRATION.txt):
//   STRANGLE  short NIFTY 2% strangle to weekly expiry (option selling; information only)
//   MA150A/B  short a stock crossing below its 150-day average, scored against the market
const { calculateNseFuturesCharges } = require("./shadow-broker");
const { roundTripCost } = require("./trade-costs");
const { isoWeek } = require("./springy-dip");

const START = "2026-10-05";
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const futCharge = (side, p, q, d) => calculateNseFuturesCharges({ side, price: p, quantity: q, asOfDate: `${d}T12:00:00Z` }).totalCharges;
const optCost = (entry, exit) => { const r = roundTripCost({ entryPremium: entry, exitPremium: Math.max(exit, 0.05), quantity: 75 }); return r ? r.totalCost / 75 : null; };

// niftyClose: Map(d -> close); opt: Map(d -> {idx:{NIFTY:[[exp,K,typ,close,settle,oi]]}}); sessions sorted
function strangle({ sessions, niftyClose, opt, start = START }) {
  const expiries = [...new Set([...opt.values()].flatMap((o) => (o.idx?.NIFTY || []).map((r) => r[0])))].sort();
  const trades = [], pending = [];
  let prevE = "0000";
  for (const E of expiries) {
    const d = sessions.find((x) => x > prevE && days(x, E) >= 4 && days(x, E) <= 10 && opt.get(x)?.idx?.NIFTY?.length && niftyClose.has(x)); prevE = E;
    if (!d || d < start) continue;
    const S = niftyClose.get(d); const rows = opt.get(d).idx.NIFTY.filter((r) => r[0] === E && r[3] > 0);
    const near = (typ, t) => { const ks = [...new Set(rows.filter((r) => r[2] === typ).map((r) => r[1]))]; return ks.length ? ks.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a)) : null; };
    const kc = near("CE", S * 1.02), kp = near("PE", S * 0.98); if (kc === null || kp === null) continue;
    const pc = rows.find((r) => r[1] === kc && r[2] === "CE")[3], pp = rows.find((r) => r[1] === kp && r[2] === "PE")[3];
    const base = { entryDate: d, expiry: E, nifty: S, callStrike: kc, putStrike: kp, premium: +(pc + pp).toFixed(2) };
    if (!niftyClose.has(E)) { trades.push({ ...base, status: E > sessions[sessions.length - 1] ? "OPEN" : "WAITING FOR EXPIRY CLOSE" }); continue; }
    const SE = niftyClose.get(E); const pay = Math.max(SE - kc, 0) + Math.max(kp - SE, 0);
    const c1 = optCost(pc, Math.max(SE - kc, 0)), c2 = optCost(pp, Math.max(kp - SE, 0)); if (c1 === null || c2 === null) continue;
    trades.push({ ...base, expiryClose: SE, payout: +pay.toFixed(2), netPct: +(((pc + pp - pay - c1 - c2) / S) * 100).toFixed(3), status: "DONE" });
  }
  return { trades: trades.reverse(), pending, summary: summarise(trades.filter((t) => t.status === "DONE"), "netPct", 26) };
}

// stocks: [{sym, bars:[{d,o,h,l,c,val}]}]
function maCross({ sessions, stocks, start = START }) {
  const RESET = 0.18; const sIndex = new Map(sessions.map((d, i) => [d, i]));
  const sma = (c, i, n) => { if (i < n - 1) return null; let s = 0; for (let k = i - n + 1; k <= i; k += 1) s += c[k]; return s / n; };
  const cutsOf = new Map(stocks.map((st) => { const b = st.bars, cut = [0]; for (let i = 1; i < b.length; i += 1) if (Math.abs(b[i].o / b[i - 1].c - 1) >= RESET) cut.push(i); return [st.sym, cut]; }));
  const firstOf = new Map(); for (const d of sessions) if (!firstOf.has(d.slice(0, 7))) firstOf.set(d.slice(0, 7), d);
  const uCache = new Map(); const universe = (m) => { if (uCache.has(m)) return uCache.get(m); const first = firstOf.get(m); const ranked = [];
    for (const st of stocks) { let k = 0; while (k < st.bars.length && st.bars[k].d < first) k += 1; const lc = cutsOf.get(st.sym).filter((x) => x < k).pop() ?? 0; if (k - lc < 250) continue;
      const v = st.bars.slice(Math.max(lc, k - 60), k).map((b) => b.val).filter(Number.isFinite).sort((a, b) => a - b); if (v.length) ranked.push([st.sym, v[Math.floor(v.length / 2)]]); }
    ranked.sort((a, b) => b[1] - a[1]); const set = ranked.slice(0, 200).map((x) => x[0]); uCache.set(m, set); return set; };
  const bySym = new Map(stocks.map((s) => [s.sym, s])); const idx = new Map(stocks.map((s) => [s.sym, new Map(s.bars.map((b, i) => [b.d, i]))]));
  const bench = (d) => { const xs = []; for (const sym of universe(d.slice(0, 7))) { const st = bySym.get(sym), i = idx.get(sym).get(d); if (i === undefined || i + 9 >= st.bars.length) continue;
      let ok = true; for (let k = i; k <= i + 9; k += 1) { if (sIndex.get(st.bars[k].d) !== sIndex.get(d) + (k - i)) ok = false; if (k > i && Math.abs(st.bars[k].o / st.bars[k - 1].c - 1) >= RESET) ok = false; } if (ok) xs.push(st.bars[i + 9].c / st.bars[i].o - 1); }
    return xs.length >= 50 ? xs.reduce((a, b) => a + b, 0) / xs.length : null; };
  const out = { A: { trades: [], pending: [] }, B: { trades: [], pending: [] } }; const last = sessions[sessions.length - 1];
  for (const st of stocks) { const b = st.bars; const c = b.map((x) => x.c); const cuts = cutsOf.get(st.sym);
    for (let i = 2; i <= b.length; i += 1) { const d = i < b.length ? b[i].d : null; if (d && d < start) continue; if (!d && b[i - 1].d !== last) continue;
      const lc = cuts.filter((x) => x <= i - 1).pop() ?? 0; if (i - lc < 250) continue;
      const entryIdx = d ? sIndex.get(d) : sessions.length; if (sIndex.get(b[i - 1].d) !== entryIdx - 1) continue;
      const month = (d || last).slice(0, 7); if (!firstOf.has(month) || !universe(month).includes(st.sym)) continue;
      const p1 = i - 1, p2 = i - 2; const s150a = sma(c, p2, 150), s150b = sma(c, p1, 150), s5a = sma(c, p2, 5), s5b = sma(c, p1, 5);
      const fired = { A: c[p2] >= s150a && c[p1] < s150b, B: s5a >= s150a && s5b < s150b };
      for (const k of ["A", "B"]) { if (!fired[k]) continue; const base = { symbol: st.sym, signalDate: b[p1].d };
        if (!d) { out[k].pending.push({ ...base, status: "SIGNAL" }); continue; }
        const j = i + 9; if (j >= b.length) { out[k].trades.push({ ...base, entryDate: d, entry: b[i].o, status: "OPEN" }); continue; }
        let voided = false; for (let q = i; q <= j; q += 1) if (Math.abs(b[q].o / b[q - 1].c - 1) >= RESET) voided = true;
        if (voided) { out[k].trades.push({ ...base, entryDate: d, status: "VOID (corporate action)" }); continue; }
        const e = b[i].o, x = b[j].c, q = Math.ceil(500000 / e); const rolls = new Set(b.slice(i, j + 1).map((y) => y.d.slice(0, 7))).size - 1;
        const cost = (futCharge("SELL", e, q, d) + futCharge("BUY", x, q, b[j].d) + rolls * (futCharge("BUY", x, q, b[j].d) + futCharge("SELL", x, q, b[j].d))) / (e * q);
        const net = 1 - x / e - cost, bm = bench(d);
        out[k].trades.push({ ...base, entryDate: d, entry: e, exitDate: b[j].d, exit: x, netPct: +(net * 100).toFixed(3), excessPct: bm === null ? null : +((net + bm) * 100).toFixed(3), status: bm === null ? "NO BENCHMARK" : "DONE" }); } } }
  for (const k of ["A", "B"]) { out[k].trades.sort((a, b) => (a.entryDate < b.entryDate ? 1 : -1)); out[k].summary = summarise(out[k].trades.filter((t) => t.status === "DONE"), "excessPct", 100, true); }
  return out;
}

function tCrit(df) { // one-sided 1.67% (5%/3)
  const t = { 1: 19.08, 2: 5.34, 3: 3.64, 4: 3.03, 5: 2.73, 6: 2.56, 7: 2.45, 8: 2.37, 9: 2.32, 10: 2.27, 12: 2.21, 15: 2.15, 20: 2.09, 30: 2.04, 60: 1.99 };
  for (const k of Object.keys(t).map(Number).sort((a, b) => a - b)) if (df <= k) return t[k]; return 2.13; }
function summarise(done, field, minTrades, needMonths = false) {
  const n = done.length; if (!n) return { finished: 0, verdict: "COLLECTING" };
  const mean = done.reduce((a, t) => a + t[field], 0) / n; const byW = new Map(); for (const t of done) { const w = isoWeek(t.entryDate); byW.set(w, (byW.get(w) || 0) + (t[field] - mean)); }
  const G = byW.size; const s = [...byW.values()].reduce((a, x) => a + x * x, 0); const se = G > 1 ? Math.sqrt((G / (G - 1)) * s) / n : null; const t = se ? mean / se : null;
  const months = (Date.parse(done.map((x) => x.entryDate).sort().pop()) - Date.parse(START)) / (30.44 * 864e5);
  const ready = n >= minTrades && (!needMonths || months >= 3);
  return { finished: n, meanPct: +mean.toFixed(3), winPct: +((100 * done.filter((x) => x[field] > 0).length) / n).toFixed(1), worstPct: +Math.min(...done.map((x) => x[field])).toFixed(3), t: t === null ? null : +t.toFixed(2),
    verdict: !ready ? "COLLECTING" : mean > 0 && t !== null && t >= tCrit(G - 1) ? "PASS" : "FAIL" };
}
module.exports = { START, strangle, maCross };
