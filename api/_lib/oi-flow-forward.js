"use strict";
// Two open-interest patterns as forward paper tests (studies/oi-flow-forward-2026-10-04/PREREGISTRATION.txt):
//   LU  long-unwinding BOUNCE: price down AND open interest down on a moving day -> long, open(d) to close(d+9)
//   SB  short build-up:        price down AND open interest up   on a moving day -> short, open(d) to close(d)
// Definitions are those of research/orderflow-2026-10-03 (cut-offs frozen from its development window).
const { calculateNseFuturesCharges } = require("./shadow-broker");
const { isoWeek } = require("./springy-dip");

const RULE = { start: "2026-10-05", rCut: 0.015580871386411843, oiCut: 0.030380434782608656, universe: 200, valueWindow: 60, minBars: 66, reset: 0.18, notional: 500000,
  rules: { LU: { side: 1, hold: 10 }, SB: { side: -1, hold: 1 } } };
const charge = (side, price, qty, date) => calculateNseFuturesCharges({ side, price, quantity: qty, asOfDate: `${date}T12:00:00Z` }).totalCharges;

// sessions: sorted ISO; stocks: [{sym, bars:[{d,o,h,l,c,val}]}]; oi: Map(sym -> Map(d -> total OI across expiries))
function forward({ sessions, stocks, oi, rule = RULE }) {
  const sIndex = new Map(sessions.map((d, i) => [d, i]));
  const firstOfMonth = new Map(); for (const d of sessions) if (!firstOfMonth.has(d.slice(0, 7))) firstOfMonth.set(d.slice(0, 7), d);
  const uCache = new Map();
  const universe = (month) => { if (uCache.has(month)) return uCache.get(month); const first = firstOfMonth.get(month); const ranked = [];
    for (const st of stocks) { let k = 0; while (k < st.bars.length && st.bars[k].d < first) k += 1; if (k < rule.minBars) continue;
      const v = st.bars.slice(k - rule.valueWindow, k).map((b) => b.val).filter(Number.isFinite).sort((a, b) => a - b); if (v.length) ranked.push([st.sym, v[Math.floor(v.length / 2)]]); }
    ranked.sort((a, b) => b[1] - a[1]); const set = new Set(ranked.slice(0, rule.universe).map((x) => x[0])); uCache.set(month, set); return set; };
  const lastSession = sessions[sessions.length - 1];
  const out = { LU: { pending: [], trades: [] }, SB: { pending: [], trades: [] } };
  for (const st of stocks) {
    const o = oi.get(st.sym); if (!o) continue; const b = st.bars;
    const isReset = (i) => i > 0 && Math.abs(b[i].o / b[i - 1].c - 1) >= rule.reset;
    for (let i = 2; i <= b.length; i += 1) {
      const d = i < b.length ? b[i].d : null; const p1 = b[i - 1], p2 = b[i - 2];
      if (d && d < rule.start) continue;
      if (!d && p1.d !== lastSession) continue;
      const entryIdx = d ? sIndex.get(d) : sessions.length;
      if (sIndex.get(p1.d) !== entryIdx - 1 || sIndex.get(p2.d) !== entryIdx - 2) continue;
      if (isReset(i - 1) || isReset(i - 2)) continue;
      const month = (d || lastSession).slice(0, 7); if (!firstOfMonth.has(month) || !universe(month).has(st.sym)) continue;
      const o1 = o.get(p1.d), o2 = o.get(p2.d); if (!(o1 > 0 && o2 > 0)) continue;
      const R = p1.c / p2.c - 1, OI = o1 / o2 - 1;
      if (Math.abs(R) < rule.rCut || Math.abs(OI) < rule.oiCut || R >= 0) continue;
      const name = OI < 0 ? "LU" : "SB"; const { side, hold } = rule.rules[name];
      const base = { symbol: st.sym, signalDate: p1.d, pricePct: +(R * 100).toFixed(2), oiPct: +(OI * 100).toFixed(2) };
      if (!d) { out[name].pending.push({ ...base, status: "SIGNAL" }); continue; }
      const j = i + hold - 1; const entry = b[i].o;
      if (j >= b.length) { out[name].trades.push({ ...base, entryDate: d, entry, status: "OPEN" }); continue; }
      let voided = false; for (let k = i; k <= j; k += 1) if (isReset(k)) voided = true;
      if (voided) { out[name].trades.push({ ...base, entryDate: d, entry, status: "VOID (corporate action)" }); continue; }
      const exit = b[j].c, exitDate = b[j].d, qty = Math.ceil(rule.notional / entry);
      const rolls = new Set(b.slice(i, j + 1).map((x) => x.d.slice(0, 7))).size - 1;
      const cost = (charge(side > 0 ? "BUY" : "SELL", entry, qty, d) + charge(side > 0 ? "SELL" : "BUY", exit, qty, exitDate) + rolls * (charge("BUY", exit, qty, exitDate) + charge("SELL", exit, qty, exitDate))) / (entry * qty);
      out[name].trades.push({ ...base, entryDate: d, entry, exitDate, exit, netPct: +((side * (exit / entry - 1) - cost) * 100).toFixed(3), status: "DONE" });
    }
  }
  for (const k of Object.keys(out)) { out[k].trades.sort((a, b) => (a.entryDate < b.entryDate ? 1 : -1)); out[k].summary = summarise(out[k].trades.filter((t) => t.status === "DONE"), rule); }
  return { lastSession, ...out };
}
function tCrit025(df) { const t = { 1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228, 12: 2.179, 15: 2.131, 20: 2.086, 30: 2.042, 60: 2.0 };
  for (const k of Object.keys(t).map(Number).sort((a, b) => a - b)) if (df <= k) return t[k]; return 1.96; }
function summarise(done, rule) {
  const n = done.length; if (!n) return { finished: 0, verdict: "COLLECTING" };
  const mean = done.reduce((a, t) => a + t.netPct, 0) / n; const byWeek = new Map(); for (const t of done) { const w = isoWeek(t.entryDate); byWeek.set(w, (byWeek.get(w) || 0) + (t.netPct - mean)); }
  const G = byWeek.size; const s = [...byWeek.values()].reduce((a, x) => a + x * x, 0); const se = G > 1 ? Math.sqrt((G / (G - 1)) * s) / n : null; const t = se ? mean / se : null;
  const months = (Date.parse(done.map((x) => x.entryDate).sort().pop()) - Date.parse(rule.start)) / (30.44 * 864e5);
  const verdict = !(n >= 100 && months >= 3) ? "COLLECTING" : mean > 0 && t !== null && t >= tCrit025(G - 1) ? "PASS" : "FAIL";
  return { finished: n, meanNetPct: +mean.toFixed(3), winPct: +((100 * done.filter((x) => x.netPct > 0).length) / n).toFixed(1), weeks: G, t: t === null ? null : +t.toFixed(2), verdict };
}
module.exports = { RULE, forward };
