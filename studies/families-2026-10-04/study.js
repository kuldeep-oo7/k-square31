"use strict";
// Implements EXACTLY ./PREREGISTRATION.txt (sha256 in ./PREREGISTRATION.sha256).
//   node study.js --synthetic | node study.js
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const ROOT = path.resolve(__dirname, "..", "..");
const { calculateNseFuturesCharges } = require(path.join(ROOT, "api/_lib/shadow-broker"));
const { roundTripCost } = require(path.join(ROOT, "api/_lib/trade-costs"));
const { clusterRobustMean } = require(path.join(ROOT, "api/_lib/panel"));
const HERE = __dirname;
const SHA = fs.readFileSync(path.join(HERE, "PREREGISTRATION.sha256"), "utf8").split(/\s+/)[0];
if (crypto.createHash("sha256").update(fs.readFileSync(path.join(HERE, "PREREGISTRATION.txt"))).digest("hex") !== SHA) { console.error("PRE-REGISTRATION CHANGED; result void."); process.exit(2); }

const DEV_END = "2024-09-19", FINAL_FROM = "2025-09-18", FINAL_TO = "2026-09-15";
const NOTIONAL = 500000, MIN_BARS = 250, UNIVERSE = 200, VALUE_WINDOW = 60, RESET = 0.18;
const windowOf = (d) => (d < DEV_END ? "development" : d < FINAL_FROM ? "validation" : d <= FINAL_TO ? "final" : null);
const MEMBERS = ["F1 delivery accumulation -> long 5d", "F2 delivery distribution -> short 5d", "F3 NIFTY PCR high -> long 10d", "F4 NIFTY PCR low -> short 10d",
  "F5 futures carry top 10% -> long 5d", "F6 futures carry bottom 10% -> short 5d", "F7 pairs (GGR) spread reversion", "F8 turn of month NIFTY long",
  "F9 monthly expiry week NIFTY long", "F10 Monday NIFTY short", "F11 short NIFTY straddle to expiry", "F12 short BANKNIFTY straddle to expiry"];
const futCost = (entry, exit, d, ed, cross = 0) => { const q = Math.ceil(NOTIONAL / entry); const ch = (s, p, dd) => calculateNseFuturesCharges({ side: s, price: p, quantity: q, asOfDate: `${dd}T12:00:00Z` }).totalCharges;
  return (ch("BUY", entry, d) + ch("SELL", exit, ed) + cross * (ch("BUY", exit, ed) + ch("SELL", exit, ed))) / (entry * q); };
const crossings = (d1, d2) => (+d2.slice(0, 4) - +d1.slice(0, 4)) * 12 + (+d2.slice(5, 7) - +d1.slice(5, 7));
const pct = (xs, q) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

// data: { sessions, stocks:[{sym,bars:[{d,o,h,l,c,val}]}], deliv: Map(d -> {SYM:[q,dq,dp]}), fut: Map(d -> rows), opt: Map(d -> {oi, idx}),
//         nifty: Map(d -> {open,close}), niftyFutExpiries: [iso], niftyOptExpiries: [iso] }
function run(data) {
  const trades = []; const add = (k, d, net) => { const w = windowOf(d); if (w && Number.isFinite(net)) trades.push({ member: MEMBERS[k], day: d, window: w, net }); };
  const sIndex = new Map(data.sessions.map((d, i) => [d, i]));
  // universe
  const cutsOf = new Map(); for (const st of data.stocks) { const b = st.bars, cut = [0]; for (let i = 1; i < b.length; i += 1) if (Math.abs(b[i].o / b[i - 1].c - 1) >= RESET) cut.push(i); cutsOf.set(st.sym, cut); }
  const months = new Map(); for (const d of data.sessions) { const m = d.slice(0, 7); if (!months.has(m)) months.set(m, d); }
  const members = new Map();
  for (const [m, first] of months) { const ranked = [];
    for (const st of data.stocks) { let k = 0; while (k < st.bars.length && st.bars[k].d < first) k += 1; const lc = cutsOf.get(st.sym).filter((x) => x < k).pop() ?? 0; if (k - lc < MIN_BARS) continue;
      const v = st.bars.slice(Math.max(lc, k - VALUE_WINDOW), k).map((b) => b.val).filter(Number.isFinite).sort((a, b) => a - b); if (v.length) ranked.push([st.sym, v[Math.floor(v.length / 2)]]); }
    ranked.sort((a, b) => b[1] - a[1]); members.set(m, new Set(ranked.slice(0, UNIVERSE).map((x) => x[0]))); }
  const inU = (sym, d) => members.get(d.slice(0, 7))?.has(sym);
  const bySym = new Map(data.stocks.map((s) => [s.sym, s]));
  const resetDays = new Map(data.stocks.map((s) => [s.sym, new Set(cutsOf.get(s.sym).filter((x) => x > 0).map((x) => s.bars[x].d))]));
  const crossesReset = (sym, bars, i, j) => bars.slice(i, j + 1).some((b) => resetDays.get(sym).has(b.d));

  // F1/F2 delivery
  for (const st of data.stocks) { const b = st.bars;
    for (let i = 62; i + 4 < b.length; i += 1) { const d = b[i].d; if (!inU(st.sym, d) || sIndex.get(b[i - 1].d) !== sIndex.get(d) - 1) continue;
      const dp = data.deliv.get(b[i - 1].d)?.[st.sym]?.[2]; if (!Number.isFinite(dp)) continue;
      const hist = []; for (let k = i - 61; k < i - 1; k += 1) { const v = data.deliv.get(b[k].d)?.[st.sym]?.[2]; if (Number.isFinite(v)) hist.push(v); }
      if (hist.length < 30 || dp < pct(hist, 0.9)) continue;
      if (crossesReset(st.sym, b, i - 1, i + 4)) continue;
      const up = b[i - 1].c > b[i - 2].c, dn = b[i - 1].c < b[i - 2].c; const g = b[i + 4].c / b[i].o - 1; const cost = futCost(b[i].o, b[i + 4].c, d, b[i + 4].d, crossings(d, b[i + 4].d));
      if (up) add(0, d, g - cost); else if (dn) add(1, d, -g - cost); } }
  // NIFTY helpers
  const nd = data.sessions.filter((d) => data.nifty.has(d)); const nIdx = new Map(nd.map((d, i) => [d, i]));
  const niftyTrade = (k, entryD, exitD, side) => { const e = data.nifty.get(entryD).open, x = data.nifty.get(exitD).close; add(k, entryD, side * (x / e - 1) - futCost(e, x, entryD, exitD, crossings(entryD, exitD))); };
  // F3/F4 PCR
  const pcr = new Map(); for (const d of nd) { const a = data.opt.get(d)?.oi?.NIFTY; if (a && a[0] > 0) pcr.set(d, a[1] / a[0]); }
  const devP = [...pcr.entries()].filter(([d]) => windowOf(d) === "development").map(([, v]) => v); const lo = pct(devP, 1 / 3), hi = pct(devP, 2 / 3);
  for (let i = 1; i + 9 < nd.length; i += 1) { const v = pcr.get(nd[i - 1]); if (v === undefined) continue; if (v >= hi) niftyTrade(2, nd[i], nd[i + 9], 1); else if (v <= lo) niftyTrade(3, nd[i], nd[i + 9], -1); }
  // F5/F6 carry
  const futKey = (d) => { const m = new Map(); for (const r of data.fut.get(d) || []) if (r[1] === "STK") m.set(`${r[0]}|${r[2]}`, r); return m; };
  const futMaps = new Map(); const fm = (d) => { if (!futMaps.has(d)) futMaps.set(d, futKey(d)); return futMaps.get(d); };
  for (let i = 1; i + 4 < data.sessions.length; i += 1) { const d = data.sessions[i], p = data.sessions[i - 1], x = data.sessions[i + 4];
    if (!windowOf(d)) continue; const cand = [];
    for (const r of data.fut.get(p) || []) { if (r[1] !== "STK" || !inU(r[0], d)) continue; const dte = days(p, r[2]); if (dte < 5 || dte > 30 || r[2] <= x) continue;
      const st = bySym.get(r[0]); const sb = st?.bars.find((b) => b.d === p); if (!sb || !(r[6] > 0)) continue; cand.push({ sym: r[0], exp: r[2], carry: (sb.c / r[6] - 1) * 365 / dte }); }
    if (cand.length < 20) continue; cand.sort((a, b) => a.carry - b.carry); const k = Math.max(1, Math.floor(cand.length * 0.1));
    for (const [list, side, mi] of [[cand.slice(-k), 1, 4], [cand.slice(0, k), -1, 5]]) for (const c of list) { const e = fm(d).get(`${c.sym}|${c.exp}`), z = fm(x).get(`${c.sym}|${c.exp}`);
      if (!e || !z || !(e[3] > 0) || !(z[6] > 0)) continue; const st = bySym.get(c.sym); const ii = st.bars.findIndex((b) => b.d === d); if (ii < 0 || crossesReset(c.sym, st.bars, ii, ii + 4)) continue;
      add(mi, d, side * (z[6] / e[3] - 1) - futCost(e[3], z[6], d, x)); } }
  // F7 pairs
  const closeAt = new Map(data.stocks.map((s) => [s.sym, new Map(s.bars.map((b) => [b.d, b]))]));
  for (const [m, first] of months) { const fi = sIndex.get(first); if (fi < 250 || fi + 125 >= data.sessions.length) continue; if (!windowOf(first) && first < DEV_END) { /* dev ok */ }
    const form = data.sessions.slice(fi - 250, fi), trade = data.sessions.slice(fi, fi + 125);
    const syms = [...members.get(m)].filter((s) => { const cm = closeAt.get(s); return form.every((d) => cm.has(d)) && trade.every((d) => cm.has(d)) && ![...form, ...trade].some((d) => resetDays.get(s).has(d)); });
    const norm = new Map(syms.map((s) => { const cm = closeAt.get(s); const p0 = cm.get(form[0]).c; return [s, form.map((d) => cm.get(d).c / p0)]; }));
    const pairs = []; for (let a = 0; a < syms.length; a += 1) for (let b = a + 1; b < syms.length; b += 1) { const A = norm.get(syms[a]), B = norm.get(syms[b]); let ssd = 0; for (let t = 0; t < A.length; t += 1) ssd += (A[t] - B[t]) ** 2; pairs.push([ssd, syms[a], syms[b]]); }
    pairs.sort((x, y) => x[0] - y[0]);
    for (const [, sa, sb] of pairs.slice(0, 20)) { const A = norm.get(sa), B = norm.get(sb); const spr = A.map((v, t) => v - B[t]); const mu = spr.reduce((x, y) => x + y, 0) / spr.length; const sd = Math.sqrt(spr.reduce((x, y) => x + (y - mu) ** 2, 0) / spr.length);
      const ca = closeAt.get(sa), cb = closeAt.get(sb); const p0a = ca.get(form[0]).c, p0b = cb.get(form[0]).c; let open = null;
      for (let t = 0; t < trade.length; t += 1) { const s = ca.get(trade[t]).c / p0a - cb.get(trade[t]).c / p0b;
        if (!open) { if (Math.abs(s) > 2 * sd && t + 1 < trade.length) { const e = trade[t + 1]; open = { e, sign: Math.sign(s), ea: ca.get(e).o, eb: cb.get(e).o }; t += 0; } continue; }
        const last = t === trade.length - 1; const crossed = Math.sign(s) !== open.sign;
        if ((crossed && t + 1 < trade.length) || last) { const xd = last ? trade[t] : trade[t + 1]; const xa = last ? ca.get(xd).c : ca.get(xd).o, xb = last ? cb.get(xd).c : cb.get(xd).o;
          const ra = xa / open.ea - 1, rb = xb / open.eb - 1; const g = open.sign > 0 ? (-ra + rb) / 2 : (ra - rb) / 2; // short the high one, buy the low one
          if (open.e < xd || open.e === xd) add(6, open.e, g - (futCost(open.ea, xa, open.e, xd, crossings(open.e, xd)) + futCost(open.eb, xb, open.e, xd, crossings(open.e, xd))) / 2);
          open = null; if (last) break; t += 1; } } } }
  // F8 turn of month, F9 expiry week, F10 Monday
  for (let i = 0; i < nd.length; i += 1) { const d = nd[i]; const nx = nd[i + 1];
    if (nx && nx.slice(0, 7) !== d.slice(0, 7)) { const third = nd[i + 3]; if (third && third.slice(0, 7) === nx.slice(0, 7)) niftyTrade(7, d, third, 1); }
    if (new Date(`${d}T00:00:00Z`).getUTCDay() === 1) niftyTrade(9, d, d, -1); }
  for (const E of data.niftyFutExpiries) { const j = nIdx.get(E); if (j === undefined || j < 4) continue; niftyTrade(8, nd[j - 4], E, 1); }
  // F11/F12 short straddles
  const straddle = (k, und, spotOf, expiries, minD, maxD, qty) => { let prevE = "0000";
    for (const E of expiries) { const d = data.sessions.find((x) => x > prevE && days(x, E) >= minD && days(x, E) <= maxD && data.opt.get(x)?.idx?.[und]?.length); prevE = E; if (!d) continue;
      const S = spotOf(d), SE = spotOf(E); if (!(S > 0) || !(SE > 0)) continue;
      const rows = data.opt.get(d).idx[und].filter((r) => r[0] === E && r[3] > 0); const strikes = [...new Set(rows.map((r) => r[1]))].filter((K) => rows.some((r) => r[1] === K && r[2] === "CE") && rows.some((r) => r[1] === K && r[2] === "PE"));
      if (!strikes.length) continue; const K = strikes.reduce((a, b) => (Math.abs(b - S) < Math.abs(a - S) ? b : a));
      const ce = rows.find((r) => r[1] === K && r[2] === "CE")[3], pe = rows.find((r) => r[1] === K && r[2] === "PE")[3]; const prem = ce + pe, pay = Math.abs(SE - K);
      const c1 = roundTripCost({ entryPremium: ce, exitPremium: Math.max(SE - K, 0.05), quantity: qty }), c2 = roundTripCost({ entryPremium: pe, exitPremium: Math.max(K - SE, 0.05), quantity: qty });
      if (!c1 || !c2) return; const cost = (c1.totalCost + c2.totalCost) / qty;
      add(k, d, (prem - pay - cost) / S); } };
  straddle(10, "NIFTY", (d) => data.nifty.get(d)?.close, data.niftyOptExpiries, 4, 10, 75);
  const bnExp = [...new Set([...data.opt.values()].flatMap((o) => (o.idx?.BANKNIFTY || []).map((r) => r[0])))].sort();
  const bnSpot = (d) => { const rows = (data.fut.get(d) || []).filter((r) => r[0] === "BANKNIFTY" && r[1] === "IDX").sort((a, b) => (a[2] < b[2] ? -1 : 1)); return rows[0]?.[7] || rows[0]?.[6]; };
  straddle(11, "BANKNIFTY", bnSpot, bnExp, 4, 35, 30);
  return { trades };
}

function lgamma(x) { const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x); x -= 1; let a = c[0]; const t = x + g + 0.5; for (let i = 1; i < 9; i += 1) a += c[i] / (x + i); return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a); }
function pUpper(t, df) { if (!Number.isFinite(t) || df < 1) return 1; const pdf = (x) => Math.exp(lgamma((df + 1) / 2) - lgamma(df / 2) - 0.5 * Math.log(df * Math.PI) - ((df + 1) / 2) * Math.log(1 + (x * x) / df));
  const n = 40000, hi = Math.max(t, 0) + 80; let s = 0; const h = (hi - t) / n; for (let i = 0; i <= n; i += 1) s += pdf(t + i * h) * (i === 0 || i === n ? 0.5 : 1); return Math.min(1, Math.max(0, s * h)); }
function stats(rows) { if (!rows.length) return { trades: 0, months: 0, meanPct: null, t: null, winPct: null, worstPct: null }; const r = clusterRobustMean(rows.map((x) => ({ value: x.net * 100, cluster: x.day.slice(0, 7) })));
  return { trades: rows.length, months: new Set(rows.map((x) => x.day.slice(0, 7))).size, meanPct: r.meanPct, t: r.tStat, winPct: (100 * rows.filter((x) => x.net > 0).length) / rows.length, worstPct: 100 * Math.min(...rows.map((x) => x.net)) }; }
function verdicts(trades) { const by = new Map(MEMBERS.map((n) => [n, { development: [], validation: [], final: [] }])); for (const t of trades) by.get(t.member)[t.window].push(t);
  const out = {}; for (const n of MEMBERS) { const g = by.get(n); out[n] = { development: stats(g.development), validation: stats(g.validation), final: stats(g.final) }; out[n].p = out[n].final.trades > 1 ? pUpper(out[n].final.t, out[n].final.months - 1) : 1; }
  const order = MEMBERS.slice().sort((a, b) => out[a].p - out[b].p); let ok = true;
  order.forEach((n, k) => { const o = out[n], a = 0.05 / (order.length - k); const holm = ok && o.p <= a; if (!holm) ok = false; o.holmAlpha = a;
    o.verdict = o.final.trades < 30 ? "NOT TESTABLE" : o.validation.meanPct > 0 && o.final.meanPct > 0 && holm ? "PASS" : "FAIL"; }); return out; }

// ---------- synthetic market with every data type ----------
function synthetic(seed, plant) {
  let s = seed; const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const sessions = []; for (let t = Date.parse("2020-09-01"); sessions.length < 1500; t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) sessions.push(d.toISOString().slice(0, 10)); }
  const lastWeekdayOfMonth = new Set(); for (let i = 0; i < sessions.length; i += 1) if (!sessions[i + 1] || sessions[i + 1].slice(0, 7) !== sessions[i].slice(0, 7)) lastWeekdayOfMonth.add(sessions[i]);
  const thursdays = sessions.filter((d) => new Date(`${d}T00:00:00Z`).getUTCDay() === 4);
  const monthEnds = [...lastWeekdayOfMonth];
  const expOf = (d) => monthEnds.find((e) => e >= d && days(d, e) >= 0) || monthEnds.at(-1);
  const stocks = [], deliv = new Map(sessions.map((d) => [d, {}])), fut = new Map(sessions.map((d) => [d, []])), opt = new Map(), nifty = new Map();
  for (let k = 0; k < 40; k += 1) { const sym = `S${k}`; let px = 300 + 100 * k, drift = 0; const bars = []; let basis = 0;
    sessions.forEach((d, i) => { const twin = k % 2 === 1 && plant.pairs ? stocks[k - 1].bars[i] : null;
      const o = px * (1 + 0.002 * gauss()); let c = o * (1 + drift + 0.015 * gauss()); if (twin) c = twin.c * (300 + 100 * k) / (300 + 100 * (k - 1)) * (1 + 0.02 * gauss());
      bars.push({ d, o, h: Math.max(o, c) * 1.005, l: Math.min(o, c) * 0.995, c, val: 1e9 * (1 + rnd()) });
      const dp = 30 + 20 * rnd() + (rnd() < 0.05 ? 40 : 0); deliv.get(d)[sym] = [1e5, 1e5 * dp / 100, dp];
      drift = plant.deliv && dp > 70 && c > (bars.length > 1 ? bars[bars.length - 2].c : o) ? 0.006 : drift * 0.7;
      basis = plant.carry ? 0.6 * basis + 0.004 * gauss() : 0.004 * gauss(); const e = expOf(d); const fc = c * (1 + basis); fut.get(d).push([sym, "STK", e, o * (1 + basis), fc * 1.005, fc * 0.995, fc, fc, 1e6, 0, 100]);
      px = c; }); stocks.push({ sym, bars }); }
  let n = 15000, pcrv = 1, carryN = 0; sessions.forEach((d, i) => { const tom = lastWeekdayOfMonth.has(d) || (i >= 1 && lastWeekdayOfMonth.has(sessions[i - 1])) || (i >= 2 && lastWeekdayOfMonth.has(sessions[i - 2])) || (i >= 3 && lastWeekdayOfMonth.has(sessions[i - 3]));
    const o = n; carryN = plant.pcr && pcrv > 1.15 ? 0.003 : carryN * 0.9; n = o * (1 + (plant.tom && tom ? 0.004 : 0) + carryN + 0.009 * gauss()); nifty.set(d, { open: o, close: n }); pcrv = 0.8 + 0.5 * rnd();
    const E = thursdays.find((t) => t > d) || d; const T = Math.max(days(d, E), 1) / 365; const iv = plant.vrp ? 0.3 : 0.143; const rows = [];
    for (let K = Math.round(n / 50) * 50 - 200; K <= Math.round(n / 50) * 50 + 200; K += 50) { const tv = 0.4 * n * iv * Math.sqrt(T); rows.push([E, K, "CE", Math.max(n - K, 0) + tv, 0, 1e5], [E, K, "PE", Math.max(K - n, 0) + tv, 0, 1e5]); }
    opt.set(d, { oi: { NIFTY: [1e6, 1e6 * pcrv, 0, 0] }, idx: { NIFTY: rows, BANKNIFTY: [] } }); });
  return { sessions, stocks, deliv, fut, opt, nifty, niftyFutExpiries: monthEnds, niftyOptExpiries: thursdays };
}
const out = []; const line = (x) => { console.log(x); out.push(x); };
const fmt = (st) => (st.trades ? `${st.meanPct >= 0 ? "+" : ""}${st.meanPct.toFixed(3)}% t ${st.t.toFixed(2)} win ${st.winPct.toFixed(0)}% worst ${st.worstPct.toFixed(1)}% (${st.trades})` : "no trades");

if (process.argv.includes("--synthetic")) {
  // each edge planted in its own invented market, so one plant cannot mask another
  const want = [[0, "F1", "deliv"], [2, "F3", "pcr"], [4, "F5", "carry"], [6, "F7", "pairs"], [7, "F8", "tom"], [10, "F11", "vrp"]]; let found = 0;
  for (const [k, lab, key] of want) { const f = verdicts(run(synthetic(5, { [key]: true })).trades)[MEMBERS[k]]; const ok = f.final.meanPct > 0 && f.final.t > 2; found += ok ? 1 : 0; line(`(1) planted ${lab}: final ${fmt(f.final)} ${ok ? "FOUND" : "missed"}`); }
  let passes = 0; for (let k = 1; k <= 3; k += 1) passes += Object.values(verdicts(run(synthetic(k * 211, {})).trades)).filter((x) => x.verdict === "PASS").length;
  line(`(2) 3 noise markets x 12 members: ${passes} PASS (want <= 1)`);
  const base = synthetic(23, {}); const cut = base.sessions[1100]; const A = run(base).trades.filter((x) => x.day < base.sessions[1100 - 130]);
  for (const st of base.stocks) for (const b of st.bars) if (b.d >= cut) { b.o *= 1.1; b.c *= 0.8; }
  for (const [d, v] of base.nifty) if (d >= cut) base.nifty.set(d, { open: v.open * 1.2, close: v.close * 0.7 });
  for (const [d, rows] of base.fut) if (d >= cut) for (const r of rows) { r[3] *= 1.1; r[6] *= 0.9; }
  const B = run(base).trades.filter((x) => x.day < base.sessions[1100 - 130]);
  const key = (x) => `${x.member}|${x.day}|${x.net}`; const a = A.map(key).sort(), b = B.map(key).sort(); const same = a.length === b.length && a.every((x, k) => x === b[k]);
  line(`(3) changing every value after ${cut}: ${A.length} trades entered before ${base.sessions[1100 - 130]} ${same ? "IDENTICAL" : "CHANGED -- LOOK-AHEAD"}`);
  process.exit(found === 6 && passes <= 1 && same ? 0 : 1);
}

// ---------- real data ----------
const R = path.join(ROOT, "research");
const cmDir = path.join(R, "rising-stocks-2026-10-02", "nse-data", "cm"); const files = fs.readdirSync(cmDir).filter((f) => f.endsWith(".json")).sort();
const sessions = files.map((f) => f.slice(0, 10)); const bySym = new Map();
for (const f of files) { const d = f.slice(0, 10); for (const r of JSON.parse(fs.readFileSync(path.join(cmDir, f), "utf8"))) { const [, sym, series, o, h, l, c, , , val] = r;
  if (series !== "EQ" || !sym || ![o, h, l, c].every((x) => x > 0)) continue; if (!bySym.has(sym)) bySym.set(sym, { sym, bars: [] }); bySym.get(sym).bars.push({ d, o, h, l, c, val }); } }
const readMap = (dir) => { const m = new Map(); if (!fs.existsSync(dir)) return m; for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) m.set(f.slice(0, 10), JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))); return m; };
const fut = readMap(path.join(R, "orderflow-2026-10-03", "nse-fo", "fut"));
const extra = path.join(R, "families-2026-10-04", "nse-extra"); const deliv = readMap(path.join(extra, "deliv")), opt = readMap(path.join(extra, "opt"));
const nifty = new Map(JSON.parse(fs.readFileSync(path.join(R, "rising-stocks-2026-10-02", "nse-data", "nifty-50-nse.json"), "utf8")).rows.map((r) => [r.date, { open: r.open, close: r.close }]));
const exps = JSON.parse(fs.readFileSync(path.join(R, "situations-2026-09-29", "nifty-expiries-nse.json"), "utf8"));
line(`coverage: ${sessions.length} sessions; futures files ${fut.size}, delivery ${deliv.size}, options ${opt.size}`);
const res = run({ sessions, stocks: [...bySym.values()], deliv, fut, opt, nifty, niftyFutExpiries: exps.FUTIDX.slice().sort(), niftyOptExpiries: exps.OPTIDX.slice().sort() });
const v = verdicts(res.trades);
line(`FAMILIES -- run ${new Date().toISOString()}, prereg sha256 ${SHA} (verified); ${res.trades.length} trades`);
for (const [n, o] of Object.entries(v)) line(`${n.padEnd(40)} | dev ${fmt(o.development)} | val ${fmt(o.validation)} | final ${fmt(o.final)} | p ${o.p.toExponential(1)} vs ${o.holmAlpha.toFixed(4)} | ${o.verdict}`);
const pass = Object.entries(v).filter(([, o]) => o.verdict === "PASS").map(([n]) => n); line(`\nPASS: ${pass.length ? pass.join(", ") : "none"}`);
fs.writeFileSync(path.join(HERE, "RESULT.txt"), out.join("\n") + "\n"); fs.writeFileSync(path.join(HERE, "result.json"), JSON.stringify({ sha: SHA, verdicts: v }, null, 2));
