"use strict";
// DESCRIPTIVE, POST-HOC (after the 09:15 lab's result; not a test): does "skip SB names that open below yesterday's close"
// hold when the trade is priced on FUTURES (near-month open -> close of d) instead of the share? NSE 2020-12 .. 2026-10-01.
const fs = require("node:fs"), path = require("node:path");
const R = "C:/Users/kulde/Downloads/pivot31/research";
const { loadCm } = require("C:/Users/kulde/Downloads/pivot31/scripts/springy-dip-forward");
const ofw = require("C:/Users/kulde/Downloads/pivot31/api/_lib/oi-flow-forward");
const { calculateNseFuturesCharges } = require("C:/Users/kulde/Downloads/pivot31/api/_lib/shadow-broker");
const data = loadCm(path.join(R, "rising-stocks-2026-10-02", "nse-data", "cm")); const futDir = path.join(R, "orderflow-2026-10-03", "nse-fo", "fut");
const oi = new Map(), fut = new Map();   // fut: d -> Map(sym -> {o, c, pc of the same contract})
let prev = new Map();
for (const f of fs.readdirSync(futDir).filter((x) => x.endsWith(".json")).sort()) { const d = f.slice(0, 10); const near = new Map(), byKey = new Map();
  for (const r of JSON.parse(fs.readFileSync(path.join(futDir, f), "utf8"))) { if (r[1] !== "STK") continue; if (!oi.has(r[0])) oi.set(r[0], new Map()); const m = oi.get(r[0]); m.set(d, (m.get(d) || 0) + (+r[8] || 0));
    byKey.set(`${r[0]}|${r[2]}`, +r[6]); if (r[2] >= d && r[3] > 0 && r[6] > 0 && (!near.has(r[0]) || r[2] < near.get(r[0]).e)) near.set(r[0], { e: r[2], o: +r[3], c: +r[6] }); }
  const day = new Map(); for (const [s, v] of near) day.set(s, { ...v, pc: prev.get(`${s}|${v.e}`) || null }); fut.set(d, day); prev = byKey; }
const res = ofw.forward({ sessions: data.sessions, stocks: data.stocks, oi, rule: { ...ofw.RULE, start: "2020-12-01" } });
const bars = new Map(data.stocks.map((s) => [s.sym, new Map(s.bars.map((b) => [b.d, b]))])); const sIdx = new Map(data.sessions.map((d, i) => [d, i]));
const ch = (side, p, q, d) => calculateNseFuturesCharges({ side, price: p, quantity: q, asOfDate: `${d}T12:00:00Z` }).totalCharges;
const net = (o, c, d) => { const q = Math.ceil(500000 / o); return -(c / o - 1) - (ch("SELL", o, q, d) + ch("BUY", c, q, d)) / (o * q); };
const groups = { cashUp: [], cashDown: [], futUp: [], futDown: [] }; let n = 0, miss = 0;
for (const t of res.SB.trades) { if (t.status !== "DONE") continue; const d = t.entryDate, d1 = data.sessions[sIdx.get(d) - 1]; const b = bars.get(t.symbol).get(d), p1 = bars.get(t.symbol).get(d1); const fu = fut.get(d) && fut.get(d).get(t.symbol);
  if (!b || !p1 || !fu || !fu.pc) { miss += 1; continue; } n += 1; const cashGap = b.o / p1.c - 1, futGap = fu.o / fu.pc - 1;
  const cashNet = net(b.o, b.c, d), futNet = net(fu.o, fu.c, d);
  groups[cashGap >= 0 ? "cashUp" : "cashDown"].push({ cashNet, futNet }); groups[futGap >= 0 ? "futUp" : "futDown"].push({ cashNet, futNet }); }
const st = (xs, k) => { const v = xs.map((x) => x[k]); const m = v.reduce((a, x) => a + x, 0) / v.length; const sd = Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / (v.length - 1)); return `${(m * 100).toFixed(3)}% (t ${(m / (sd / Math.sqrt(v.length))).toFixed(2)}, n ${v.length})`; };
console.log(`SB trades 2020-12 .. ${data.sessions.at(-1)}: ${n} with futures prices, ${miss} without`);
console.log(` split by the SHARE's gap at the open:   no gap down -> share ${st(groups.cashUp, "cashNet")}, FUTURES ${st(groups.cashUp, "futNet")}`);
console.log(`                                          gap down    -> share ${st(groups.cashDown, "cashNet")}, FUTURES ${st(groups.cashDown, "futNet")}`);
console.log(` split by the FUTURE's own gap:           no gap down -> FUTURES ${st(groups.futUp, "futNet")}; gap down -> FUTURES ${st(groups.futDown, "futNet")}`);
// per year: share-priced vs futures-priced SB, and where the difference comes from (the open or the close)
const yr = new Map(); const bump = (k, f, v) => { if (!yr.has(k)) yr.set(k, { s: [], f: [], eo: [], ec: [] }); yr.get(k)[f].push(v); };
for (const t of res.SB.trades) { if (t.status !== "DONE") continue; const d = t.entryDate, d1 = data.sessions[sIdx.get(d) - 1]; const b = bars.get(t.symbol).get(d), p1 = bars.get(t.symbol).get(d1); const fu = fut.get(d) && fut.get(d).get(t.symbol);
  if (!b || !p1 || !fu || !fu.pc) continue; const y = d.slice(0, 4); bump(y, "s", net(b.o, b.c, d)); bump(y, "f", net(fu.o, fu.c, d));
  const basisC = fu.c / b.c; bump(y, "eo", fu.o / (b.o * basisC) - 1); bump(y, "ec", 0); }
const m = (v) => v.reduce((a, x) => a + x, 0) / v.length, tt = (v) => { const mu = m(v), sd = Math.sqrt(v.reduce((a, x) => a + (x - mu) ** 2, 0) / (v.length - 1)); return mu / (sd / Math.sqrt(v.length)); };
console.log("year | trades | share-priced net | futures-priced net | futures open vs share open (after the day's closing basis)");
for (const [y, v] of [...yr].sort()) console.log(` ${y} | ${String(v.s.length).padStart(5)} | ${(m(v.s) * 100).toFixed(3)}% (t ${tt(v.s).toFixed(2)}) | ${(m(v.f) * 100).toFixed(3)}% (t ${tt(v.f).toFixed(2)}) | ${(m(v.eo) * 100).toFixed(3)}%`);
const all = { s: [], f: [], eo: [] }; for (const v of yr.values()) { all.s.push(...v.s); all.f.push(...v.f); all.eo.push(...v.eo); }
console.log(` ALL  | ${all.s.length} | ${(m(all.s) * 100).toFixed(3)}% (t ${tt(all.s).toFixed(2)}) | ${(m(all.f) * 100).toFixed(3)}% (t ${tt(all.f).toFixed(2)}) | ${(m(all.eo) * 100).toFixed(3)}%`);
