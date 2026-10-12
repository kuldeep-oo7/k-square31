"use strict";
// Forward paper tests of the two near misses (studies/forward-v3-2026-10-04/PREREGISTRATION.txt):
//   CHEAPVOL  buy the ATM stock straddle when implied vol < 0.8x realised; sell 5 sessions later
//   INDREV    industry-adjusted 5-session reversal, long-short, every 5th session
// The logic is copied from studies/options-2026-10-04/study.js (O3, I2); a replay reproduces the study.
const { calculateNseFuturesCharges } = require("./shadow-broker");
const { roundTripCost } = require("./trade-costs");
const { isoWeek } = require("./springy-dip");

const START = "2026-10-05", RESET = 0.18, NOTIONAL = 500000;
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const fc = (side, p, q, d) => calculateNseFuturesCharges({ side, price: p, quantity: q, asOfDate: `${d}T12:00:00Z` }).totalCharges;
const futNet = (side, e, x, d, xd) => { const q = Math.ceil(NOTIONAL / e); const cross = (+xd.slice(0, 4) - +d.slice(0, 4)) * 12 + (+xd.slice(5, 7) - +d.slice(5, 7));
  return side * (x / e - 1) - (fc(side > 0 ? "BUY" : "SELL", e, q, d) + fc(side > 0 ? "SELL" : "BUY", x, q, xd) + cross * (fc("BUY", x, q, xd) + fc("SELL", x, q, xd))) / (e * q); };
const optUnitCost = (entry, exit) => { const q = Math.max(1, Math.round(100000 / entry)); const r = roundTripCost({ entryPremium: entry, exitPremium: Math.max(exit, 0.05), quantity: q }); return r ? r.totalCost / q : null; };

function context({ sessions, stocks }) {
  const S = sessions, sIndex = new Map(S.map((d, i) => [d, i]));
  const bySym = new Map(stocks.map((s) => [s.sym, s])); const idx = new Map(stocks.map((s) => [s.sym, new Map(s.bars.map((b, i) => [b.d, i]))]));
  const cutsOf = new Map(stocks.map((st) => { const b = st.bars, cut = [0]; for (let i = 1; i < b.length; i += 1) if (Math.abs(b[i].o / b[i - 1].c - 1) >= RESET) cut.push(i); return [st.sym, cut]; }));
  const firstOf = new Map(); for (const d of S) if (!firstOf.has(d.slice(0, 7))) firstOf.set(d.slice(0, 7), d);
  const uCache = new Map(); const uni = (m) => { if (uCache.has(m)) return uCache.get(m); const first = firstOf.get(m); if (!first) return new Set(); const ranked = [];
    for (const st of stocks) { let k = 0; while (k < st.bars.length && st.bars[k].d < first) k += 1; const lc = cutsOf.get(st.sym).filter((x) => x < k).pop() ?? 0; if (k - lc < 250) continue;
      const v = st.bars.slice(Math.max(lc, k - 60), k).map((b) => b.val).filter(Number.isFinite).sort((a, b) => a - b); if (v.length) ranked.push([st.sym, v[Math.floor(v.length / 2)]]); }
    ranked.sort((a, b) => b[1] - a[1]); const set = new Set(ranked.slice(0, 200).map((x) => x[0])); uCache.set(m, set); return set; };
  // h sessions from d clean? returns {st,i,complete}; complete=false when the data ends before d+h-1 (a still-open trade)
  const window = (sym, d, h) => { const st = bySym.get(sym), i = idx.get(sym)?.get(d); if (!st || i === undefined) return null; const end = Math.min(i + h - 1, st.bars.length - 1);
    for (let k = i; k <= end; k += 1) { if (sIndex.get(st.bars[k].d) !== sIndex.get(d) + (k - i)) return null; if (k > i && Math.abs(st.bars[k].o / st.bars[k - 1].c - 1) >= RESET) return null; }
    return { st, i, complete: i + h - 1 <= st.bars.length - 1 }; };
  return { S, sIndex, bySym, idx, uni, window };
}

// sopt: { get(d) -> rows [sym, exp, K, typ, close, settle, oi, vol] }
function cheapVol({ sessions, stocks, sopt, start = START, ctx = context({ sessions, stocks }) }) {
  const { S, bySym, idx, uni, window } = ctx;
  const closeOf = (sym, d) => { const i = idx.get(sym)?.get(d); return i === undefined ? null : bySym.get(sym).bars[i].c; };
  const realised = (sym, d) => { const w = idx.get(sym)?.get(d); if (w === undefined || w < 21) return null; const b = bySym.get(sym).bars; const r = [];
    for (let k = w - 19; k <= w; k += 1) { if (Math.abs(b[k].o / b[k - 1].c - 1) >= RESET) return null; r.push(Math.log(b[k].c / b[k - 1].c)); } const m = r.reduce((a, x) => a + x, 0) / r.length; return Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / r.length * 252); };
  const dayIdx = new Map(); const opt = (d) => { if (dayIdx.has(d)) return dayIdx.get(d); if (dayIdx.size > 20) dayIdx.delete(dayIdx.keys().next().value); const rows = sopt.get(d) || []; const m = new Map(), by = new Map();
    for (const r of rows) { m.set(`${r[0]}|${r[1]}|${r[2]}|${r[3]}`, r); if (!by.has(r[0])) by.set(r[0], []); by.get(r[0]).push(r); } const o = { m, by }; dayIdx.set(d, o); return o; };
  const price = (d, sym, E, K, typ) => { const r = opt(d).m.get(`${sym}|${E}|${K}|${typ}`); return r && r[4] > 0 ? r[4] : null; };
  const trades = []; const last = new Map();
  for (let i = 0; i < S.length; i += 1) { const d = S[i]; if (d < start) continue;
    for (const sym of uni(d.slice(0, 7))) { if ((last.get(sym) ?? -99) > i - 5) continue; const w = window(sym, d, 6); if (!w) continue;
      const rows = opt(d).by.get(sym); const s = closeOf(sym, d); if (!rows || !(s > 0)) continue;
      const E = [...new Set(rows.map((r) => r[1]))].filter((e) => days(d, e) >= 8).sort()[0]; if (!E) continue;
      const ks = [...new Set(rows.filter((r) => r[1] === E).map((r) => r[2]))]; if (!ks.length) continue; const K = ks.reduce((a, b) => (Math.abs(b - s) < Math.abs(a - s) ? b : a));
      const ce = price(d, sym, E, K, "CE"), pe = price(d, sym, E, K, "PE"), rv = realised(sym, d); if (!ce || !pe || !rv) continue;
      const iv = (ce + pe) / (0.8 * s * Math.sqrt(days(d, E) / 365)); if (!(iv < 0.8 * rv)) continue;
      const base = { symbol: sym, entryDate: d, expiry: E, strike: K, entry: +(ce + pe).toFixed(2), ivPct: +(iv * 100).toFixed(1), rvPct: +(rv * 100).toFixed(1) };
      if (!w.complete || !S[i + 5]) { trades.push({ ...base, status: "OPEN" }); last.set(sym, i); continue; }
      const x = S[i + 5]; const ce2 = price(x, sym, E, K, "CE"), pe2 = price(x, sym, E, K, "PE"); if (!ce2 || !pe2) continue;
      const c = optUnitCost(ce, ce2), p = optUnitCost(pe, pe2); if (c === null || p === null) continue;
      trades.push({ ...base, exitDate: x, exit: +(ce2 + pe2).toFixed(2), netPct: +(((ce2 + pe2 - ce - pe - c - p) / (ce + pe)) * 100).toFixed(3), status: "DONE" }); last.set(sym, i); } }
  trades.sort((a, b) => (a.entryDate < b.entryDate ? 1 : -1));
  return { trades, summary: summarise(trades.filter((t) => t.status === "DONE").map((t) => ({ key: isoWeek(t.entryDate), v: t.netPct, d: t.entryDate })), 100, true, start) };
}

// industry: { SYM: "Industry" }
function indRev({ sessions, stocks, industry, start = START, ctx = context({ sessions, stocks }) }) {
  const { S, sIndex, bySym, idx, uni, window } = ctx;
  const recsFor = (i) => { const d = S[i]; const recs = [];
    for (const sym of uni(d.slice(0, 7))) { const ind = industry[sym]; if (!ind) continue; const st = bySym.get(sym), j = idx.get(sym).get(d); if (j === undefined) continue; const w = window(sym, d, 5); if (!w || j < 6 || sIndex.get(st.bars[j - 6].d) !== i - 6) continue;
      let clean = true; for (let k = j - 5; k < j; k += 1) if (Math.abs(st.bars[k].o / st.bars[k - 1].c - 1) >= RESET) clean = false; if (!clean) continue;
      recs.push({ sym, ind, r5: st.bars[j - 1].c / st.bars[j - 6].c - 1, w, j }); }
    const byInd = new Map(); for (const r of recs) { if (!byInd.has(r.ind)) byInd.set(r.ind, []); byInd.get(r.ind).push(r); }
    return recs.filter((r) => byInd.get(r.ind).length >= 3).map((r) => { const g = byInd.get(r.ind); return { ...r, a: r.r5 - g.reduce((x, y) => x + y.r5, 0) / g.length }; }).sort((a, b) => a.a - b.a); };
  const rebalances = [];
  for (let i = 6; i < S.length; i += 1) { if (i % 5 !== 0 || S[i] < start) continue; const adj = recsFor(i); if (adj.length < 30) continue; const k = Math.floor(adj.length * 0.1);
    const L = adj.slice(0, k), Sh = adj.slice(-k); const d = S[i]; const done = L.every((x) => x.w.complete) && Sh.every((x) => x.w.complete);
    const base = { date: d, long: L.map((x) => x.sym), short: Sh.map((x) => x.sym) };
    if (!done || !S[i + 4]) { rebalances.push({ ...base, status: "OPEN" }); continue; }
    const net = (x, side) => futNet(side, x.w.st.bars[x.j].o, x.w.st.bars[x.j + 4].c, d, x.w.st.bars[x.j + 4].d);
    const ln = L.reduce((a, x) => a + net(x, 1), 0) / L.length, sn = Sh.reduce((a, x) => a + net(x, -1), 0) / Sh.length;
    rebalances.push({ ...base, longPct: +(ln * 100).toFixed(3), shortPct: +(sn * 100).toFixed(3), netPct: +(((ln + sn) / 2) * 100).toFixed(3), status: "DONE" }); }
  // the next session is a rebalance when its index is divisible by 5: show what it would trade (from closes up to the last session)
  let pending = null; const nextIdx = S.length; if (nextIdx % 5 === 0) {
    const adjNext = (() => { const recs = []; for (const sym of uni(S[S.length - 1].slice(0, 7))) { const ind = industry[sym]; if (!ind) continue; const st = bySym.get(sym); const j = st.bars.length; if (st.bars[j - 1]?.d !== S[S.length - 1] || j < 6) continue;
        let clean = true; for (let k = j - 5; k < j; k += 1) if (Math.abs(st.bars[k].o / st.bars[k - 1].c - 1) >= RESET) clean = false; if (!clean || sIndex.get(st.bars[j - 6].d) !== nextIdx - 6) continue; recs.push({ sym, ind, r5: st.bars[j - 1].c / st.bars[j - 6].c - 1 }); }
      const byInd = new Map(); for (const r of recs) { if (!byInd.has(r.ind)) byInd.set(r.ind, []); byInd.get(r.ind).push(r); }
      return recs.filter((r) => byInd.get(r.ind).length >= 3).map((r) => { const g = byInd.get(r.ind); return { ...r, a: r.r5 - g.reduce((x, y) => x + y.r5, 0) / g.length }; }).sort((a, b) => a.a - b.a); })();
    if (adjNext.length >= 30) { const k = Math.floor(adjNext.length * 0.1); pending = { long: adjNext.slice(0, k).map((x) => x.sym), short: adjNext.slice(-k).map((x) => x.sym) }; } }
  const sessionsToNext = (5 - (nextIdx % 5)) % 5;
  rebalances.sort((a, b) => (a.date < b.date ? 1 : -1));
  return { rebalances, pending, sessionsToNext, summary: summarise(rebalances.filter((r) => r.status === "DONE").map((r) => ({ key: r.date, v: r.netPct, d: r.date })), 26, false, start) };
}

function tCrit025(df) { const t = { 1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228, 12: 2.179, 15: 2.131, 20: 2.086, 30: 2.042, 60: 2.0 };
  for (const k of Object.keys(t).map(Number).sort((a, b) => a - b)) if (df <= k) return t[k]; return 1.96; }
// obs: [{ key (cluster), v (%), d (date) }]
function summarise(obs, minN, needMonths, start) {
  const n = obs.length; if (!n) return { finished: 0, verdict: "COLLECTING" };
  const mean = obs.reduce((a, o) => a + o.v, 0) / n; const byK = new Map(); for (const o of obs) byK.set(o.key, (byK.get(o.key) || 0) + (o.v - mean));
  const G = byK.size; const s = [...byK.values()].reduce((a, x) => a + x * x, 0); const se = G > 1 ? Math.sqrt((G / (G - 1)) * s) / n : null; const t = se ? mean / se : null;
  const months = (Date.parse(obs.map((o) => o.d).sort().pop()) - Date.parse(start)) / (30.44 * 864e5);
  const ready = n >= minN && (!needMonths || months >= 3);
  return { finished: n, meanPct: +mean.toFixed(3), winPct: +((100 * obs.filter((o) => o.v > 0).length) / n).toFixed(1), worstPct: +Math.min(...obs.map((o) => o.v)).toFixed(3), t: t === null ? null : +t.toFixed(2),
    verdict: !ready ? "COLLECTING" : mean > 0 && t !== null && t >= tCrit025(G - 1) ? "PASS" : "FAIL" };
}
module.exports = { START, context, cheapVol, indRev, summarise };
