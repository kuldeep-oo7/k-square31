"use strict";
// The forward paper test of the trees model picking short build-up trades, priced on futures
// (studies/sb-trees-forward-2026-10-23/PREREGISTRATION.txt; the futures lab's member U5). This module builds each SB trade's
// 17 features (copied unchanged from studies/futures-lab-2026-10-23/run.js, which copies the 09:15 lab's) and its futures
// price and excess; the model's TAKE/SKIP comes from scripts/sb-trees-predict.py; summary() scores the weekly spread.
const fs = require("node:fs");
const path = require("node:path");
const { calculateNseFuturesCharges } = require("./shadow-broker");
const { isoWeek } = require("./springy-dip");
const ofw = require("./oi-flow-forward");

const RULE = { start: "2026-10-23", notional: 500000, reset: 0.18, units: 20, minNames: 30, minTrades: 100, minMonths: 3, minWeeks: 10 };
const FEATS = ["R", "OI", "GAP", "NGAP", "NRET", "VOLR", "TREND", "VOL20", "BASIS", "NSIG", "DOW", "TOEXP", "LOGP", "LOGV", "OIREL", "PREV", "R2"];
const charge = (side, price, qty, d) => calculateNseFuturesCharges({ side, price, quantity: qty, asOfDate: `${d}T12:00:00Z` }).totalCharges;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

// ---------- NSE's files (as the futures lab reads them) ----------
const jsonDays = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort() : []);
function readFut(dir, P) {   // stock OI, each stock's near-month future (open, close), near closes, expiries, NIFTY's near future
  for (const f of jsonDays(dir)) { const d = f.slice(0, 10); const byExp = new Map(), exps = new Set(), near = new Map();
    for (const r of JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))) {
      if (r[1] === "STK") { if (!P.oi.has(r[0])) P.oi.set(r[0], new Map()); const m = P.oi.get(r[0]); m.set(d, (m.get(d) || 0) + (+r[8] || 0));
        if (r[2] >= d) { exps.add(r[2]); const o = Number(r[3]), c = Number(r[6]); if (o > 0 && c > 0 && (!near.has(r[0]) || r[2] < near.get(r[0]).e)) near.set(r[0], { e: r[2], o, c }); } }
      else if (r[1] === "IDX" && r[0] === "NIFTY" && r[2] >= d && r[6] > 0) byExp.set(r[2], { o: +r[3], c: +r[6] }); }
    for (const [sym, v] of near) { if (!P.fnear.has(sym)) P.fnear.set(sym, new Map()); P.fnear.get(sym).set(d, v); if (!P.futNear.has(sym)) P.futNear.set(sym, new Map()); P.futNear.get(sym).set(d, v.c); }
    P.expiries.set(d, [...exps].sort());
    const k = [...byExp.keys()].sort()[0];
    if (k) P.fut.set(d, { o: byExp.get(k).o, c: byExp.get(k).c, pc: P.lastFut ? (P.lastFut.byExp.get(k) || {}).c ?? null : null, pd: P.lastFut ? P.lastFut.d : null });
    P.lastFut = { d, byExp }; }
}
function readIdx(dir, P) { for (const f of jsonDays(dir)) { const v = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))["Nifty 50"]; if (Array.isArray(v) && v[3] > 0) P.idx.set(f.slice(0, 10), { o: v[0] > 0 ? v[0] : null, c: v[3] }); } }

// ---------- context, NIFTY, features (copied unchanged from the futures lab) ----------
function context(P) {
  const S = P.sessions, sIdx = new Map(S.map((d, i) => [d, i])), bar = new Map();
  for (const st of P.stocks) { const m = new Map(); for (const b of st.bars) m.set(sIdx.get(b.d), b); bar.set(st.sym, m); }
  const nifty = new Map(); S.forEach((d, i) => { const ix = P.idx.get(d), fu = P.fut.get(d); if (ix || fu) nifty.set(i, { idx: ix || null, fut: fu || null }); });
  const firstOf = new Map(); S.forEach((d, i) => { if (!firstOf.has(d.slice(0, 7))) firstOf.set(d.slice(0, 7), i); });
  const months = [...firstOf.keys()], ranked = new Map(months.map((m) => [m, []]));
  for (const st of P.stocks) { const b = st.bars; let k = 0, lc = 0;
    for (const m of months) { const fd = S[firstOf.get(m)]; while (k < b.length && b[k].d < fd) { if (k > 0 && Math.abs(b[k].o / b[k - 1].c - 1) >= RULE.reset) lc = k; k += 1; }
      if (k - lc < 250) continue; const v = b.slice(k - 60, k).map((x) => x.val).filter((x) => x > 0).sort((a, c) => a - c); if (v.length) ranked.get(m).push([st.sym, v[Math.floor(v.length / 2)]]); } }
  const uni = new Map(); for (const [m, r] of ranked) { r.sort((a, c) => c[1] - a[1]); uni.set(m, r.slice(0, 200).map((x) => x[0])); }
  return { S, sIdx, bar, nifty, uni, bf: new Map() };
}
function niftyMove(C, i) { const a = C.nifty.get(i - 1), b = C.nifty.get(i); if (!b) return null;
  if (a && a.idx && b.idx) return b.idx.c / a.idx.c - 1; if (b.fut && b.fut.pc > 0 && b.fut.pd === C.S[i - 1]) return b.fut.c / b.fut.pc - 1; return null; }
function niftyGap(C, i) { const a = C.nifty.get(i - 1), b = C.nifty.get(i); if (!b) return null;
  if (a && a.idx && b.idx && b.idx.o > 0) return b.idx.o / a.idx.c - 1; if (b.fut && b.fut.o > 0 && b.fut.pc > 0 && b.fut.pd === C.S[i - 1]) return b.fut.o / b.fut.pc - 1; return null; }
function futBench(P, C, i) { if (C.bf.has(i)) return C.bf.get(i); const xs = [];
  for (const sym of C.uni.get(C.S[i].slice(0, 7)) || []) { const f = P.fnear.get(sym) && P.fnear.get(sym).get(C.S[i]); if (f) xs.push(f.c / f.o - 1); }
  const v = xs.length >= RULE.minNames ? mean(xs) : null; C.bf.set(i, v); return v; }
const windowVals = (m, lo, hi, f) => { const out = []; for (let k = lo; k <= hi; k += 1) { const b = m.get(k); if (b) out.push(f(b, k)); } return out; };
function features(C, P, sig, t) {
  const i = t.i, d = C.S[i], d1 = C.S[i - 1], m = C.bar.get(t.sym), b = m.get(i), p1 = m.get(i - 1), p2 = m.get(i - 2), p3 = m.get(i - 3), o = P.oi.get(t.sym);
  const vols = windowVals(m, i - 21, i - 2, (x) => x.v), closes = windowVals(m, i - 20, i - 1, (x) => x.c);
  const rets = []; for (let k = i - 20; k <= i - 1; k += 1) { const a = m.get(k - 1), z = m.get(k); if (a && z) rets.push(z.c / a.c - 1); }
  const ois = []; if (o) for (let k = i - 20; k <= i - 1; k += 1) { const v = o.get(C.S[k]); if (v > 0) ois.push(v); }
  const fn = P.futNear.get(t.sym), fcl = fn ? fn.get(d1) : undefined; const ex = (P.expiries.get(d1) || []).find((e) => e >= d);
  const own = sig.bySym.get(t.sym) || []; const prev = own.filter((k) => k >= i - 10 && k <= i - 1).length;
  const v60 = t.bars.slice(Math.max(0, t.k - 60), t.k).map((x) => x.val).filter((x) => x > 0).sort((a, c) => a - c);
  const sd = (a) => { const mu = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - mu) ** 2, 0) / (a.length - 1)); };
  return { R: p1 && p2 ? p1.c / p2.c - 1 : null, OI: o && o.get(d1) > 0 && o.get(C.S[i - 2]) > 0 ? o.get(d1) / o.get(C.S[i - 2]) - 1 : null, GAP: p1 ? b.o / p1.c - 1 : null,
    NGAP: niftyGap(C, i), NRET: niftyMove(C, i - 1), VOLR: vols.length >= 15 && mean(vols) > 0 && p1 ? p1.v / mean(vols) : null,
    TREND: closes.length >= 15 && p1 ? p1.c / mean(closes) - 1 : null, VOL20: rets.length >= 15 ? sd(rets) : null, BASIS: fcl > 0 && p1 ? fcl / p1.c - 1 : null,
    NSIG: sig.byDay.get(i) || 0, DOW: new Date(`${d}T00:00:00Z`).getUTCDay(), TOEXP: ex ? Math.round((Date.parse(ex) - Date.parse(d)) / 864e5) : null,
    LOGP: p1 ? Math.log(p1.c) : null, LOGV: v60.length ? Math.log(v60[Math.floor(v60.length / 2)]) : null, OIREL: ois.length >= 15 && o.get(d1) > 0 ? o.get(d1) / mean(ois) : null,
    PREV: prev, R2: p2 && p3 ? p2.c / p3.c - 1 : null };
}

// ---------- the counted trades: features, futures net and excess ----------
// P: { sessions, stocks (bars with d, o, h, l, c, v, val), oi, fnear, futNear, expiries, fut, idx }
function rows(P, rule = RULE) {
  const C = context(P); const res = ofw.forward({ sessions: P.sessions, stocks: P.stocks, oi: P.oi, rule: { ...ofw.RULE, start: "2005-01-01" } });
  const sb = res.SB.trades.map((t) => ({ ...t, i: C.sIdx.get(t.entryDate) })).filter((t) => t.i !== undefined);
  const sig = { byDay: new Map(), bySym: new Map() }; for (const t of sb) { sig.byDay.set(t.i, (sig.byDay.get(t.i) || 0) + 1); if (!sig.bySym.has(t.symbol)) sig.bySym.set(t.symbol, []); sig.bySym.get(t.symbol).push(t.i); }
  const barsOf = new Map(P.stocks.map((s) => [s.sym, s.bars])); const out = [];
  for (const t of sb) { if (t.status !== "DONE" || t.entryDate < rule.start) continue; const f = P.fnear.get(t.symbol) && P.fnear.get(t.symbol).get(t.entryDate);
    const base = { symbol: t.symbol, entryDate: t.entryDate }; if (!f) { out.push({ ...base, status: "NO FUTURES PRICE" }); continue; }
    const B = futBench(P, C, t.i); if (B === null) { out.push({ ...base, status: "NOT COUNTED (universe under 30 names)" }); continue; }
    const q = Math.ceil(rule.notional / f.o), net = -(f.c / f.o - 1) - (charge("SELL", f.o, q, t.entryDate) + charge("BUY", f.c, q, t.entryDate)) / (f.o * q);
    const bars = barsOf.get(t.symbol); let k = 0, hi = bars.length; while (k < hi) { const mid = (k + hi) >> 1; if (bars[mid].d < t.entryDate) k = mid + 1; else hi = mid; }
    out.push({ ...base, status: "DONE", id: `${t.symbol}|${t.entryDate}`, features: features(C, P, sig, { i: t.i, sym: t.symbol, bars, k }), entry: f.o, exit: f.c, net, excess: net + B, rupees: Math.round(-rule.units * (f.c - f.o)) }); }
  return { lastSession: res.lastSession, rows: out, pending: res.SB.pending.map((p) => p.symbol) };
}
const nn = (x) => x === null || x === undefined || Number.isNaN(x);
const toCsv = (rs) => ["id," + FEATS.join(","), ...rs.filter((r) => r.status === "DONE").map((r) => [r.id, ...FEATS.map((k) => (nn(r.features[k]) ? "" : r.features[k]))].join(","))].join("\n") + "\n";

// ---------- the verdict: the weekly spread of futures excess, TAKE minus SKIP ----------
const T05 = [[1, 6.314], [2, 2.920], [3, 2.353], [4, 2.132], [5, 2.015], [6, 1.943], [7, 1.895], [8, 1.860], [9, 1.833], [10, 1.812], [12, 1.782], [15, 1.753], [20, 1.725], [30, 1.697], [60, 1.671], [120, 1.658]];
const tCrit05 = (df) => { let v = null; for (const [k, c] of T05) if (df >= k) v = c; return v; };
function summary(done, rule = RULE) {   // done: [{ entryDate, take, net, excess, rupees }]
  const n = done.length; if (!n) return { counted: 0, verdict: "COLLECTING" };
  const byW = new Map(); for (const t of done) { const w = isoWeek(t.entryDate); if (!byW.has(w)) byW.set(w, { T: [], S: [] }); byW.get(w)[t.take ? "T" : "S"].push(t.excess * 100); }
  const sp = [...byW.values()].filter((v) => v.T.length && v.S.length).map((v) => mean(v.T) - mean(v.S)); const G = sp.length;
  const m = G ? mean(sp) : null, sd = G > 1 ? Math.sqrt(sp.reduce((a, x) => a + (x - m) ** 2, 0) / (G - 1)) : null, t = sd ? m / (sd / Math.sqrt(G)) : null;
  const months = (Date.parse(done.map((x) => x.entryDate).sort().pop()) - Date.parse(rule.start)) / (30.44 * 864e5), crit = tCrit05(G - 1);
  const verdict = !(n >= rule.minTrades && months >= rule.minMonths && G >= rule.minWeeks) ? "COLLECTING" : m > 0 && t !== null && crit !== null && t >= crit ? "PASS" : "FAIL";
  const tk = done.filter((x) => x.take), r3 = (x) => +x.toFixed(3);
  return { counted: n, taken: tk.length, weeksBoth: G, spreadPct: m === null ? null : r3(m), t: t === null ? null : +t.toFixed(2),
    takeNetPct: tk.length ? r3(100 * mean(tk.map((x) => x.net))) : null, takeExcessPct: tk.length ? r3(100 * mean(tk.map((x) => x.excess))) : null,
    takeWinPct: tk.length ? +((100 * tk.filter((x) => x.net > 0).length) / tk.length).toFixed(1) : null, allNetPct: r3(100 * mean(done.map((x) => x.net))),
    takeRupees: tk.reduce((a, x) => a + x.rupees, 0), allRupees: done.reduce((a, x) => a + x.rupees, 0), verdict };
}
module.exports = { RULE, FEATS, readFut, readIdx, context, features, rows, toCsv, summary, tCrit05 };
