"use strict";
// Forward paper test of S2 "borrowing surge" (studies/forward-v4-2026-10-12/PREREGISTRATION.txt):
//   SLB outstanding on d >= 2x its average over the previous 20 available files (>= 10) and >= 100,000 shares
//   -> short the stock at the open of the 2nd session after d, cover at the close 5 sessions later,
//   scored in excess of the equal-weighted universe. The logic is copied from the atlas study.js (S2);
//   scripts/forward-v4-replay.js runs it over the backtest window and must reproduce the study.
const { context, summarise } = require("./forward-v3");
const { isoWeek } = require("./springy-dip");
const { calculateNseFuturesCharges } = require("./shadow-broker");

const START = "2026-10-13", NOTIONAL = 500000, H = 5;
const fc = (side, p, q, d) => calculateNseFuturesCharges({ side, price: p, quantity: q, asOfDate: `${d}T12:00:00Z` }).totalCharges;
const futNet = (side, e, x, d, xd) => { const q = Math.ceil(NOTIONAL / e); const cross = (+xd.slice(0, 4) - +d.slice(0, 4)) * 12 + (+xd.slice(5, 7) - +d.slice(5, 7));
  return side * (x / e - 1) - (fc(side > 0 ? "BUY" : "SELL", e, q, d) + fc(side > 0 ? "SELL" : "BUY", x, q, xd) + cross * (fc("BUY", x, q, xd) + fc("SELL", x, q, xd))) / (e * q); };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

// slb: Map(d -> Map(sym -> outstanding qty summed over series)). futSyms: Set of symbols with NSE stock futures (labels only).
function borrowingSurge({ sessions, stocks, slb, start = START, ctx = context({ sessions, stocks }), futSyms = null }) {
  const S = ctx.S, sIdx = ctx.sIndex, side = -1;
  const bCache = new Map();
  const B = (e, h) => { const key = `${e}|${h}`; if (bCache.has(key)) return bCache.get(key); const xs = [];
    for (const sym of ctx.uni(e.slice(0, 7))) { const w = ctx.window(sym, e, h); if (!w || !w.complete) continue; const b = w.st.bars; xs.push(b[w.i + h - 1].c / b[w.i].o - 1); }
    const v = xs.length >= 20 ? mean(xs) : null; bCache.set(key, v); return v; };
  const busy = new Map(); const trades = []; const pending = [];
  const label = (sym) => (futSyms ? futSyms.has(sym) : null);
  const signal = (sym, d, x, q) => { const i = sIdx.get(d); if (i === undefined) return;
    const e = S[i + 2];
    if (!e) { if (!ctx.uni(d.slice(0, 7)).has(sym) || (busy.has(sym) && busy.get(sym) >= d)) return; pending.push({ symbol: sym, signalDate: d, ratio: +x.toFixed(2), outstanding: q, entry: `the open of the 2nd NSE session after ${d}`, hasFutures: label(sym) }); busy.set(sym, "9999-12-31"); return; }
    if (!ctx.uni(e.slice(0, 7)).has(sym)) return; if (busy.has(sym) && busy.get(sym) >= e) return;
    const w = ctx.window(sym, e, H); if (!w) return; const b = w.st.bars;
    if (!w.complete) { busy.set(sym, "9999-12-31"); if (e >= start) trades.push({ symbol: sym, signalDate: d, entryDate: e, entry: b[w.i].o, ratio: +x.toFixed(2), outstanding: q, hasFutures: label(sym), status: "OPEN" }); return; }
    const xb = b[w.i + H - 1]; busy.set(sym, xb.d);
    const b0 = B(e, H); if (b0 === null) return;
    const raw = futNet(side, b[w.i].o, xb.c, e, xb.d);
    if (e >= start) trades.push({ symbol: sym, signalDate: d, entryDate: e, exitDate: xb.d, entry: b[w.i].o, exit: xb.c, ratio: +x.toFixed(2), outstanding: q, hasFutures: label(sym),
      rawPct: +(raw * 100).toFixed(3), marketPct: +(b0 * 100).toFixed(3), netPct: +((raw - side * b0) * 100).toFixed(3), netExact: (raw - side * b0) * 100, status: "DONE" }); };
  const hist = new Map();
  for (const d of [...slb.keys()].sort()) { const m = slb.get(d);
    for (const [sym, q] of m) { const h = hist.get(sym) || []; const past = h.slice(-20);
      if (past.length >= 10 && sIdx.has(d)) { const avg = mean(past); if (avg > 0 && q / avg >= 2 && q >= 100000) signal(sym, d, q / avg, q); }
      h.push(q); hist.set(sym, h); } }
  // a still-open trade blocks later signals on that name until it is finished (as the backtest's busy rule)
  trades.sort((a, b) => (a.entryDate < b.entryDate ? 1 : a.entryDate > b.entryDate ? -1 : a.symbol < b.symbol ? -1 : 1));
  const done = trades.filter((t) => t.status === "DONE");
  return { trades, pending, summary: summarise(done.map((t) => ({ key: isoWeek(t.entryDate), v: t.netPct, d: t.entryDate })), 100, true, start) };
}

// slb_openpos csv text -> Map(sym -> qty summed over series)  (columns: Sr no, Security, Series, Outstanding Quantity)
function parseSlb(text) { const m = new Map();
  for (const line of String(text).split(/\r?\n/).slice(1)) { const r = line.split(","); const sym = (r[1] || "").trim(); if (!sym) continue; m.set(sym, (m.get(sym) || 0) + (+r[3] || 0)); }
  return m; }

module.exports = { START, borrowingSurge, parseSlb };
