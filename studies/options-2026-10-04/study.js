"use strict";
// Implements EXACTLY ./PREREGISTRATION.txt, judged under research/audit-2026-10-04/PROTOCOL.txt.   node study.js --synthetic | node study.js
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const ROOT = path.resolve(__dirname, "..", "..");
const { calculateNseFuturesCharges } = require(path.join(ROOT, "api/_lib/shadow-broker"));
const { roundTripCost } = require(path.join(ROOT, "api/_lib/trade-costs"));
const HERE = __dirname;
const SHA = fs.readFileSync(path.join(HERE, "PREREGISTRATION.sha256"), "utf8").split(/\s+/)[0];
if (crypto.createHash("sha256").update(fs.readFileSync(path.join(HERE, "PREREGISTRATION.txt"))).digest("hex") !== SHA) { console.error("PRE-REGISTRATION CHANGED; void."); process.exit(2); }
const RESET = 0.18, NOTIONAL = 500000;
const MEMBERS = ["O1 buy ATM call 3d (baseline)", "O2 buy ATM put 3d (baseline)", "O3 buy straddle when IV < 0.8x realised 5d", "O4 buy straddle across results",
  "P1 sell max-OI straddle into expiry", "P2 futures toward max-OI strike on expiry day", "N1 long on leaving the F&O ban 5d", "N2 short on leaving the F&O ban 5d",
  "I1 industry momentum long-short 21d", "I2 industry-adjusted reversal long-short 5d"];
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const fc = (side, p, q, d) => calculateNseFuturesCharges({ side, price: p, quantity: q, asOfDate: `${d}T12:00:00Z` }).totalCharges;
const futNet = (side, e, x, d, xd) => { const q = Math.ceil(NOTIONAL / e); const cross = (+xd.slice(0, 4) - +d.slice(0, 4)) * 12 + (+xd.slice(5, 7) - +d.slice(5, 7));
  return side * (x / e - 1) - (fc(side > 0 ? "BUY" : "SELL", e, q, d) + fc(side > 0 ? "SELL" : "BUY", x, q, xd) + cross * (fc("BUY", x, q, xd) + fc("SELL", x, q, xd))) / (e * q); };
const optUnitCost = (entry, exit) => { const q = Math.max(1, Math.round(100000 / entry)); const r = roundTripCost({ entryPremium: entry, exitPremium: Math.max(exit, 0.05), quantity: q }); return r ? r.totalCost / q : null; };

// data: { sessions, stocks:[{sym,bars:[{d,o,h,l,c,val}]}], sopt: Map(d -> rows[sym,exp,K,typ,close,settle,oi,vol]), bans: {d:[syms]|null}, industry: {sym: name}, events:[{sym,date}] }
function run(data) {
  const out = new Map(MEMBERS.map((m) => [m, []])); const add = (k, d, v) => { if (Number.isFinite(v)) out.get(MEMBERS[k]).push({ day: d, v }); };
  const S = data.sessions, sIndex = new Map(S.map((d, i) => [d, i]));
  const bySym = new Map(data.stocks.map((s) => [s.sym, s])); const idx = new Map(data.stocks.map((s) => [s.sym, new Map(s.bars.map((b, i) => [b.d, i]))]));
  const cutsOf = new Map(data.stocks.map((st) => { const b = st.bars, cut = [0]; for (let i = 1; i < b.length; i += 1) if (Math.abs(b[i].o / b[i - 1].c - 1) >= RESET) cut.push(i); return [st.sym, cut]; }));
  const firstOf = new Map(); for (const d of S) if (!firstOf.has(d.slice(0, 7))) firstOf.set(d.slice(0, 7), d);
  const uni = new Map(); for (const [m, first] of firstOf) { const ranked = [];
    for (const st of data.stocks) { let k = 0; while (k < st.bars.length && st.bars[k].d < first) k += 1; const lc = cutsOf.get(st.sym).filter((x) => x < k).pop() ?? 0; if (k - lc < 250) continue;
      const v = st.bars.slice(Math.max(lc, k - 60), k).map((b) => b.val).filter(Number.isFinite).sort((a, b) => a - b); if (v.length) ranked.push([st.sym, v[Math.floor(v.length / 2)]]); }
    ranked.sort((a, b) => b[1] - a[1]); uni.set(m, new Set(ranked.slice(0, 200).map((x) => x[0]))); }
  const inU = (sym, d) => uni.get(d.slice(0, 7))?.has(sym);
  // a clean window of h sessions from session index of d for sym (consecutive sessions, no reset after the first bar)
  const window = (sym, d, h) => { const st = bySym.get(sym), i = idx.get(sym)?.get(d); if (!st || i === undefined || i + h - 1 >= st.bars.length) return null;
    for (let k = i; k <= i + h - 1; k += 1) { if (sIndex.get(st.bars[k].d) !== sIndex.get(d) + (k - i)) return null; if (k > i && Math.abs(st.bars[k].o / st.bars[k - 1].c - 1) >= RESET) return null; } return { st, i }; };
  const bCache = new Map(); const B = (d, h) => { const key = `${d}|${h}`; if (bCache.has(key)) return bCache.get(key); const xs = [];
    for (const sym of uni.get(d.slice(0, 7)) || []) { const w = window(sym, d, h); if (w) xs.push(w.st.bars[w.i + h - 1].c / w.st.bars[w.i].o - 1); }
    const v = xs.length >= 30 ? xs.reduce((a, b) => a + b, 0) / xs.length : null; bCache.set(key, v); return v; };
  const closeOf = (sym, d) => { const i = idx.get(sym)?.get(d); return i === undefined ? null : bySym.get(sym).bars[i].c; };
  // option lookups
  // MEMORY-SAFE LOADING (added after registration; logic unchanged -- verified by running the synthetic market
  // eager and lazy and comparing every observation): a bounded per-day cache, and the passes below walk days in order.
  const optIdx = new Map(); const opt = (d) => { if (optIdx.has(d)) return optIdx.get(d); if (optIdx.size > 40) optIdx.delete(optIdx.keys().next().value); const rows = data.sopt.get(d) || []; const m = new Map();
    for (const r of rows) { const k = `${r[0]}|${r[1]}|${r[2]}|${r[3]}`; m.set(k, r); } const bySymRows = new Map(); for (const r of rows) { if (!bySymRows.has(r[0])) bySymRows.set(r[0], []); bySymRows.get(r[0]).push(r); }
    const o = { m, bySymRows }; optIdx.set(d, o); return o; };
  const price = (d, sym, E, K, typ) => { const r = opt(d).m.get(`${sym}|${E}|${K}|${typ}`); return r && r[4] > 0 ? r[4] : null; };
  const atm = (d, sym, minDays) => { const rows = opt(d).bySymRows.get(sym); const s = closeOf(sym, d); if (!rows || !(s > 0)) return null;
    const E = [...new Set(rows.map((r) => r[1]))].filter((e) => days(d, e) >= minDays).sort()[0]; if (!E) return null;
    const ks = [...new Set(rows.filter((r) => r[1] === E).map((r) => r[2]))]; if (!ks.length) return null; const K = ks.reduce((a, b) => (Math.abs(b - s) < Math.abs(a - s) ? b : a)); return { E, K, s }; };
  const optRet = (entry, exit) => { if (!(entry > 0) || !(exit > 0)) return null; const c = optUnitCost(entry, exit); return c === null ? null : (exit - entry - c) / entry; };
  const realised = (sym, d) => { const w = idx.get(sym)?.get(d); if (w === undefined || w < 21) return null; const b = bySym.get(sym).bars; const r = [];
    for (let k = w - 19; k <= w; k += 1) { if (Math.abs(b[k].o / b[k - 1].c - 1) >= RESET) return null; r.push(Math.log(b[k].c / b[k - 1].c)); } const m = r.reduce((a, x) => a + x, 0) / r.length; return Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / r.length * 252); };
  const lastO3 = new Map();
  for (let i = 0; i < S.length; i += 1) { const d = S[i];
    for (const sym of uni.get(d.slice(0, 7)) || []) {
      const a = atm(d, sym, 8); if (!a) continue;
      if (i % 5 === 0 && S[i + 3]) { const x = S[i + 3]; if (window(sym, d, 4)) { add(0, d, optRet(price(d, sym, a.E, a.K, "CE"), price(x, sym, a.E, a.K, "CE"))); add(1, d, optRet(price(d, sym, a.E, a.K, "PE"), price(x, sym, a.E, a.K, "PE"))); } }
      if (S[i + 5] && (lastO3.get(sym) ?? -99) <= i - 5 && window(sym, d, 6)) { const ce = price(d, sym, a.E, a.K, "CE"), pe = price(d, sym, a.E, a.K, "PE"), rv = realised(sym, d);
        if (ce && pe && rv) { const iv = (ce + pe) / (0.8 * a.s * Math.sqrt(days(d, a.E) / 365)); if (iv < 0.8 * rv) { const x = S[i + 5]; const ce2 = price(x, sym, a.E, a.K, "CE"), pe2 = price(x, sym, a.E, a.K, "PE");
          if (ce2 && pe2) { const c = optUnitCost(ce, ce2), p = optUnitCost(pe, pe2); if (c !== null && p !== null) { add(2, d, (ce2 + pe2 - ce - pe - c - p) / (ce + pe)); lastO3.set(sym, i); } } } } } } }
  // O4 results straddle
  const seen = new Set();
  for (const e of data.events.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.sym < b.sym ? -1 : 1))) { const key = `${e.sym}|${e.date}`; if (seen.has(key)) continue; seen.add(key); const m0 = S.find((x) => x >= e.date); if (!m0) continue; const j = sIndex.get(m0); if (j < 1 || !S[j + 1]) continue;
    const d = S[j - 1], x = S[j + 1]; if (!inU(e.sym, d) || !window(e.sym, d, 3)) continue; const a = atm(d, e.sym, 8); if (!a) continue;
    const ce = price(d, e.sym, a.E, a.K, "CE"), pe = price(d, e.sym, a.E, a.K, "PE"), ce2 = price(x, e.sym, a.E, a.K, "CE"), pe2 = price(x, e.sym, a.E, a.K, "PE");
    if (ce && pe && ce2 && pe2) { const c = optUnitCost(ce, ce2), p = optUnitCost(pe, pe2); if (c !== null && p !== null) add(3, d, (ce2 + pe2 - ce - pe - c - p) / (ce + pe)); } }
  // P1/P2 pinning: every stock expiry E that is a session
  const expiries = data.expiriesBySym || (() => { const m = new Map(); for (const [, rows] of data.sopt) for (const r of rows) { if (!m.has(r[0])) m.set(r[0], new Set()); m.get(r[0]).add(r[1]); } return m; })();
  const pins = []; for (const [sym, set] of expiries) for (const E of set) pins.push([E, sym]); pins.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
  for (const [E, sym] of pins) { const j = sIndex.get(E); if (j === undefined || j < 1) continue; const p = S[j - 1]; if (!inU(sym, p) || !window(sym, p, 2)) continue;
    const rows = (opt(p).bySymRows.get(sym) || []).filter((r) => r[1] === E); if (!rows.length) continue; const oi = new Map(); for (const r of rows) oi.set(r[2], (oi.get(r[2]) || 0) + r[6]);
    const Kstar = [...oi.entries()].sort((a, b) => b[1] - a[1])[0][0]; const s = closeOf(sym, p), sE = closeOf(sym, E); if (!(s > 0) || !(sE > 0)) continue;
    if (Math.abs(s - Kstar) / s <= 0.03) { const ce = price(p, sym, E, Kstar, "CE"), pe = price(p, sym, E, Kstar, "PE"); if (ce && pe) { const c = optUnitCost(ce, Math.max(sE - Kstar, 0)), q = optUnitCost(pe, Math.max(Kstar - sE, 0));
      if (c !== null && q !== null) add(4, p, (ce + pe - Math.abs(sE - Kstar) - c - q) / s); } }
    const gap = Kstar / s - 1; if (Math.abs(gap) >= 0.005) { const w = window(sym, E, 1); const b1 = B(E, 1); if (w && b1 !== null) { const side = gap > 0 ? 1 : -1; add(5, E, futNet(side, w.st.bars[w.i].o, w.st.bars[w.i].c, E, E) - side * b1); } } }
  // N1/N2 leaving the ban
  for (let i = 1; i < S.length; i += 1) { const d = S[i], prev = data.bans[S[i - 1]], now = data.bans[d]; if (!Array.isArray(prev) || !Array.isArray(now)) continue;
    for (const sym of prev) { if (now.includes(sym)) continue; const w = window(sym, d, 5); const b5 = B(d, 5); if (!w || b5 === null) continue; const e = w.st.bars[w.i].o, x = w.st.bars[w.i + 4].c, xd = w.st.bars[w.i + 4].d;
      add(6, d, futNet(1, e, x, d, xd) - b5); add(7, d, futNet(-1, e, x, d, xd) + b5); } }
  // I1 industry momentum (month starts) and I2 industry-adjusted reversal (every 5th session)
  for (const [m, d] of firstOf) { const i = sIndex.get(d); if (i < 127 || !S[i + 20]) continue; const groups = new Map();
    for (const sym of uni.get(m)) { const ind = data.industry[sym]; if (!ind) continue; const w = window(sym, d, 21); const st = bySym.get(sym), j = idx.get(sym).get(d); if (!w || j < 127) continue;
      let clean = true; for (let k = j - 126; k < j; k += 1) if (Math.abs(st.bars[k].o / st.bars[k - 1].c - 1) >= RESET) clean = false; if (!clean || sIndex.get(st.bars[j - 127].d) !== i - 127) continue;
      if (!groups.has(ind)) groups.set(ind, []); groups.get(ind).push({ sym, past: st.bars[j - 1].c / st.bars[j - 127].c - 1, e: st.bars[j].o, x: st.bars[j + 20].c, xd: st.bars[j + 20].d }); }
    const ranked = [...groups.values()].filter((g) => g.length >= 3).map((g) => ({ g, r: g.reduce((a, x) => a + x.past, 0) / g.length })).sort((a, b) => b.r - a.r); if (ranked.length < 6) continue;
    const L = ranked.slice(0, 3).flatMap((x) => x.g), Sh = ranked.slice(-3).flatMap((x) => x.g);
    const ln = L.reduce((a, x) => a + futNet(1, x.e, x.x, d, x.xd), 0) / L.length, sn = Sh.reduce((a, x) => a + futNet(-1, x.e, x.x, d, x.xd), 0) / Sh.length; add(8, d, (ln + sn) / 2); }
  for (let i = 6; i + 4 < S.length; i += 1) { if (i % 5 !== 0) continue; const d = S[i]; const recs = [];
    for (const sym of uni.get(d.slice(0, 7)) || []) { const ind = data.industry[sym]; if (!ind) continue; const w = window(sym, d, 5); const st = bySym.get(sym), j = idx.get(sym).get(d); if (!w || j < 6 || sIndex.get(st.bars[j - 6].d) !== i - 6) continue;
      let clean = true; for (let k = j - 5; k < j; k += 1) if (Math.abs(st.bars[k].o / st.bars[k - 1].c - 1) >= RESET) clean = false; if (!clean) continue;
      recs.push({ sym, ind, r5: st.bars[j - 1].c / st.bars[j - 6].c - 1, e: st.bars[j].o, x: st.bars[j + 4].c, xd: st.bars[j + 4].d }); }
    const byInd = new Map(); for (const r of recs) { if (!byInd.has(r.ind)) byInd.set(r.ind, []); byInd.get(r.ind).push(r); }
    const adj = recs.filter((r) => byInd.get(r.ind).length >= 3).map((r) => { const g = byInd.get(r.ind); return { ...r, a: r.r5 - g.reduce((s, x) => s + x.r5, 0) / g.length }; }).sort((a, b) => a.a - b.a);
    if (adj.length < 30) continue; const k = Math.floor(adj.length * 0.1); const L = adj.slice(0, k), Sh = adj.slice(-k);
    const ln = L.reduce((a, x) => a + futNet(1, x.e, x.x, d, x.xd), 0) / L.length, sn = Sh.reduce((a, x) => a + futNet(-1, x.e, x.x, d, x.xd), 0) / Sh.length; add(9, d, (ln + sn) / 2); }
  return out;
}

// ---------- protocol v2 scoring ----------
const Phi = (x) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const dd = 0.3989423 * Math.exp(-x * x / 2); const p = dd * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
function score(out) { const rows = [];
  for (const [m, obs] of out) { const month = new Map(); for (const o of obs) { const k = o.day.slice(0, 7); if (!month.has(k)) month.set(k, []); month.get(k).push(o.v); }
    const s = [...month.keys()].sort().map((k) => (month.get(k).reduce((a, b) => a + b, 0) / month.get(k).length) * 100);
    if (s.length < 24) { rows.push({ m, months: s.length, n: obs.length, verdict: "NOT TESTABLE" }); continue; }
    const n = s.length, mu = s.reduce((a, b) => a + b, 0) / n, e = s.map((v) => v - mu); let v = e.reduce((a, x) => a + x * x, 0) / n; for (let L = 1; L <= 3; L += 1) { let g = 0; for (let i = L; i < n; i += 1) g += e[i] * e[i - L]; v += 2 * (1 - L / 4) * (g / n); }
    const t = mu / Math.sqrt(v / n), sd = Math.sqrt(e.reduce((a, x) => a + x * x, 0) / (n - 1)), sh = (mu / sd) * Math.sqrt(12);
    rows.push({ m, months: n, n: obs.length, mean: mu, t, sharpe: sh, worst: Math.min(...obs.map((o) => o.v)) * 100, p: 1 - Phi(t), verdict: mu > 0 && t >= 3 ? "PASS" : mu > 0 && t >= 2 ? "PROMISING" : "FAIL" }); }
  const tested = rows.filter((r) => r.verdict !== "NOT TESTABLE"); const N = tested.length; let ok = true;
  tested.slice().sort((a, b) => a.p - b.p).forEach((r, i) => { r.holm = ok && r.p <= 0.05 / (N - i); if (!r.holm) ok = false; });
  return rows; }

// ---------- synthetic market ----------
function synthetic(seed, plant) {
  let s = seed; const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const N = (x) => Phi(x); const sessions = []; for (let t = Date.parse("2020-09-01"); sessions.length < 1500; t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) sessions.push(d.toISOString().slice(0, 10)); }
  const monthEnds = sessions.filter((d, i) => !sessions[i + 1] || sessions[i + 1].slice(0, 7) !== d.slice(0, 7));
  const stocks = [], sopt = new Map(sessions.map((d) => [d, []])), bans = {}, industry = {}, events = []; const inds = ["A", "B", "C", "D", "E", "F", "G", "H"];
  const indShock = new Map(inds.map((x) => [x, 0]));
  for (let k = 0; k < 80; k += 1) { const sym = `S${k}`; industry[sym] = inds[k % 8]; let px = 500; const bars = []; let rev = 0;
    sessions.forEach((d, i) => { const vol = 0.012 + 0.0002 * (k % 10); /* constant true vol per stock, so fair prices are fair */ const o = px * (1 + 0.002 * gauss()); const r = vol * gauss() + (plant.reversal ? rev : 0); const c = o * (1 + r);
      bars.push({ d, o, h: Math.max(o, c) * 1.004, l: Math.min(o, c) * 0.996, c, val: 1e9 * (1 + rnd()) }); rev = -0.18 * r; px = c;
      if (i % 63 === k % 63 && i > 300) events.push({ sym, date: d });
      const E = monthEnds.find((e) => days(d, e) >= 0) || d; const T = Math.max(sessions.indexOf(E) - i, 1) / 252;   /* trading-day time: fair when variance only accrues on sessions */ const ivMul = plant.cheapVol && Math.floor(i / 50 + k) % 2 === 1 ? 0.55 : 1; const iv = Math.sqrt(vol * vol + 0.002 * 0.002) * Math.sqrt(252) * ivMul;
      for (let K = Math.round(c * 0.9 / 10) * 10; K <= c * 1.1; K += 10) { const sv = iv * Math.sqrt(T); const d1 = (Math.log(c / K) + sv * sv / 2) / sv; const call = c * N(d1) - K * N(d1 - sv); const put = call - c + K;
        const oiBoost = Math.abs(K - Math.round(c / 50) * 50) < 1 ? 5 : 1; sopt.get(d).push([sym, E, K, "CE", Math.max(call, 0.05), 0, 1e4 * oiBoost, 100], [sym, E, K, "PE", Math.max(put, 0.05), 0, 1e4 * oiBoost, 100]); } });
    stocks.push({ sym, bars }); }
  sessions.forEach((d, i) => { bans[d] = i % 37 < 3 ? [`S${(i * 7) % 80}`] : []; });
  return { sessions, stocks, sopt, bans, industry, events };
}
const outLines = []; const line = (x) => { console.log(x); outLines.push(x); };
const fmt = (r) => (r.verdict === "NOT TESTABLE" ? `NOT TESTABLE (${r.months} months, ${r.n} trades)` : `${r.mean >= 0 ? "+" : ""}${r.mean.toFixed(3)}% t ${r.t.toFixed(2)} Sharpe ${r.sharpe.toFixed(2)} worst ${r.worst.toFixed(1)}% (${r.n} trades, ${r.months} months) Holm ${r.holm ? "yes" : "no"} ${r.verdict}`);
if (process.argv.includes("--synthetic")) {
  const a = score(run(synthetic(3, { cheapVol: true }))).find((r) => r.m.startsWith("O3")), b = score(run(synthetic(3, { reversal: true }))).find((r) => r.m.startsWith("I2"));
  line(`(1) planted cheap vol O3: ${fmt(a)}`); line(`    planted reversal I2: ${fmt(b)}`);
  const ok1 = a.t >= 3 && b.t >= 3;
  let passes = 0; for (let k = 1; k <= 3; k += 1) for (const r of score(run(synthetic(k * 173, {})))) if (r.verdict === "PASS") { passes += 1; line(`    noise PASS: ${r.m} ${fmt(r)}`); }
  line(`(2) 3 fair-priced noise markets x 10 members: ${passes} PASS (want <= 1)`);
  const base = synthetic(19, {}); const cut = base.sessions[1100]; const keyOf = (o) => [...o].flatMap(([m, xs]) => xs.filter((x) => x.day < base.sessions[1100 - 30]).map((x) => `${m}|${x.day}|${x.v}`)).sort();
  const A = keyOf(run(base)); for (const st of base.stocks) for (const b2 of st.bars) if (b2.d >= cut) { b2.o *= 1.1; b2.c *= 0.8; } for (const [d, rows] of base.sopt) if (d >= cut) for (const r of rows) { r[4] *= 1.5; r[6] *= 3; }
  const Bk = keyOf(run(base)); const same = A.length === Bk.length && A.every((x, i) => x === Bk[i]); line(`(3) changing every price after ${cut}: ${A.length} earlier observations ${same ? "IDENTICAL" : "CHANGED -- LOOK-AHEAD"}`);
  // (4) the memory-safe loader gives exactly the same observations as the eager one
  const eagerData = synthetic(23, { cheapVol: true });
  const lazyData = { ...eagerData, sopt: { get: (d) => eagerData.sopt.get(d) }, expiriesBySym: (() => { const m = new Map(); for (const [, rows] of eagerData.sopt) for (const r of rows) { if (!m.has(r[0])) m.set(r[0], new Set()); m.get(r[0]).add(r[1]); } return m; })() };
  const flat = (o) => [...o].flatMap(([m, xs]) => xs.map((x) => `${m}|${x.day}|${x.v}`)).sort();
  const E1 = flat(run(eagerData)), L1 = flat(run(lazyData)); const sameLoad = E1.length === L1.length && E1.every((x, i) => x === L1[i]);
  line(`(4) memory-safe loading vs loading everything: ${E1.length} observations ${sameLoad ? "IDENTICAL" : "DIFFERENT"}`);
  process.exit(ok1 && passes <= 1 && same && sameLoad ? 0 : 1);
}
// ---------- real data ----------
const R = path.join(ROOT, "research"); const cmDir = path.join(R, "rising-stocks-2026-10-02", "nse-data", "cm"); const files = fs.readdirSync(cmDir).filter((f) => f.endsWith(".json")).sort();
const sessions = files.map((f) => f.slice(0, 10)); const bySym = new Map();
for (const f of files) { const d = f.slice(0, 10); for (const r of JSON.parse(fs.readFileSync(path.join(cmDir, f), "utf8"))) { const [, sym, series, o, h, l, c, , , val] = r;
  if (series !== "EQ" || !sym || ![o, h, l, c].every((x) => x > 0)) continue; if (!bySym.has(sym)) bySym.set(sym, { sym, bars: [] }); bySym.get(sym).bars.push({ d, o, h, l, c, val }); } }
const sd = path.join(HERE, "nse-sopt"); const soptDays = fs.readdirSync(sd).filter((x) => x.endsWith(".json.gz")).map((f) => f.slice(0, 10)).sort();
const readDay = (d) => (soptDays.includes(d) ? JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(sd, `${d}.json.gz`)))) : undefined);
const soptCache = new Map(); const sopt = { get: (d) => { if (soptCache.has(d)) return soptCache.get(d); if (soptCache.size > 12) soptCache.delete(soptCache.keys().next().value); const v = readDay(d); soptCache.set(d, v); return v; }, size: soptDays.length };
const expiriesBySym = new Map(); for (const d of soptDays) for (const r of readDay(d)) { if (!expiriesBySym.has(r[0])) expiriesBySym.set(r[0], new Set()); expiriesBySym.get(r[0]).add(r[1]); }
const bans = JSON.parse(fs.readFileSync(path.join(R, "ban-2026-10-04", "nse-ban", "bans.json"), "utf8"));
const industry = JSON.parse(fs.readFileSync(path.join(R, "industry-2026-10-04", "industries.json"), "utf8"));
const MON = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" }; const events = []; const bmDir = path.join(R, "results-vrp-2026-10-04", "nse-board-meetings");
for (const f of fs.readdirSync(bmDir)) for (const [sym, date, purpose] of JSON.parse(fs.readFileSync(path.join(bmDir, f), "utf8"))) { if (!/result/i.test(purpose || "")) continue; const [dd, mm, yy] = String(date).split("-"); if (!MON[(mm || "").toUpperCase()]) continue; events.push({ sym, date: `${yy}-${MON[mm.toUpperCase()]}-${dd.padStart(2, "0")}` }); }
line(`coverage: ${sessions.length} sessions; option files ${sopt.size}; ban days ${Object.values(bans).filter(Array.isArray).length}; industries for ${Object.keys(industry).length} symbols`);
const rows = score(run({ sessions, stocks: [...bySym.values()], sopt, expiriesBySym, bans, industry, events }));
line(`OPTIONS / PINNING / BAN / INDUSTRY -- run ${new Date().toISOString()}, prereg sha256 ${SHA} (verified), judged under protocol v2`);
for (const r of rows) line(`${r.m.padEnd(46)} | ${fmt(r)}`);
fs.writeFileSync(path.join(HERE, "RESULT.txt"), outLines.join("\n") + "\n");
