"use strict";
// Implements ./PREREGISTRATION.txt (sha256 in ./PREREGISTRATION.sha256): the breadth lab, one batch, one run.
//   node run.js --checks   checks 6.1-6.3 only (6.3 needs the discovery data); nothing is scored
//   node run.js            the real run (RESULT.txt, result.json: summary rows only)
// Data (private, never committed): K2_OOS_NSE = data-oos nse-old/ (cm/, fut/); K2_RESEARCH_DIR = a research/ tree
// (rising-stocks-2026-10-02/nse-data/cm, orderflow-2026-10-03/nse-fo/fut).
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const ROOT = path.resolve(__dirname, "..", "..");
const HERE = __dirname;
const SHA = fs.readFileSync(path.join(HERE, "PREREGISTRATION.sha256"), "utf8").split(/\s+/)[0];
if (crypto.createHash("sha256").update(fs.readFileSync(path.join(HERE, "PREREGISTRATION.txt"), "utf8").replace(/\r\n/g, "\n")).digest("hex") !== SHA) { console.error("PRE-REGISTRATION CHANGED; result void."); process.exit(2); }
const { calculateNseFuturesCharges } = require(path.join(ROOT, "api/_lib/shadow-broker"));
const { RULE: SBRULE } = require(path.join(ROOT, "api/_lib/oi-flow-forward"));

const NOTIONAL = 500000, RESET = 0.18, UNITS = 20, N_TRIALS = 376;
const DISC = ["2005-01-01", "2020-10-31"], CONF = ["2020-10-01", "2026-10-01"], SPLIT = "2020-09-01";
const MEMBERS = ["B1 short build-up crowd", "B2 long-unwinding crowd", "B3 breadth thrust", "B4 washout", "B5 new lows", "B6 OI surge on a down day"];
const charge = (side, price, qty, d) => calculateNseFuturesCharges({ side, price, quantity: qty, asOfDate: `${d}T12:00:00Z` }).totalCharges;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

// ---------- data: shares (CM), stock futures OI, NIFTY futures per contract ----------
const jsonDays = (dir, from, to) => fs.readdirSync(dir).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x) && x.slice(0, 10) >= from && x.slice(0, 10) <= to).sort();
function readCm(dir, from, to, P) {
  for (const f of jsonDays(dir, from, to)) { const d = f.slice(0, 10); P.sessions.push(d);
    for (const [, sym, series, o, h, l, c, , , val] of JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))) {
      if (series !== "EQ" || !sym || ![o, h, l, c].every((x) => x > 0)) continue;
      if (!P.bySym.has(sym)) P.bySym.set(sym, { sym, bars: [] }); P.bySym.get(sym).bars.push({ d, o, h, l, c, val }); } }
}
function readFut(dir, from, to, P) {
  for (const f of jsonDays(dir, from, to)) { const d = f.slice(0, 10); const nf = new Map();
    for (const r of JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))) {
      if (r[1] === "STK") { if (!P.oi.has(r[0])) P.oi.set(r[0], new Map()); const m = P.oi.get(r[0]); m.set(d, (m.get(d) || 0) + (+r[8] || 0)); }
      else if (r[1] === "IDX" && r[0] === "NIFTY" && r[2] >= d) { const o = Number(r[3]), c = Number(r[6]); if (c > 0) nf.set(r[2], { o: o > 0 ? o : null, c }); } }
    if (nf.size) P.nifty.set(d, nf); }
}
function period(name) {
  const oos = path.resolve(process.env.K2_OOS_NSE || "nse-old"), R = path.resolve(process.env.K2_RESEARCH_DIR || path.join(ROOT, "research"));
  const P = { name, sessions: [], bySym: new Map(), oi: new Map(), nifty: new Map() };
  if (name === "discovery") { readCm(path.join(oos, "cm"), DISC[0], DISC[1], P); readFut(path.join(oos, "fut"), DISC[0], DISC[1], P); Object.assign(P, { from: DISC[0], to: DISC[1] }); }
  else { const pre = new Date(Date.parse(SPLIT) - 864e5).toISOString().slice(0, 10);
    readCm(path.join(oos, "cm"), "0000", pre, P); readCm(path.join(R, "rising-stocks-2026-10-02", "nse-data", "cm"), SPLIT, CONF[1], P);
    readFut(path.join(oos, "fut"), "0000", pre, P); readFut(path.join(R, "orderflow-2026-10-03", "nse-fo", "fut"), SPLIT, CONF[1], P); Object.assign(P, { from: CONF[0], to: CONF[1] }); }
  P.stocks = [...P.bySym.values()]; delete P.bySym; return P;
}
function context(P) {   // bars by session index; the night lab's monthly universe
  const S = P.sessions, sIdx = new Map(S.map((d, i) => [d, i])), bar = new Map();
  for (const st of P.stocks) { const m = new Map(); for (const b of st.bars) m.set(sIdx.get(b.d), b); bar.set(st.sym, m); }
  const firstOf = new Map(); S.forEach((d, i) => { if (!firstOf.has(d.slice(0, 7))) firstOf.set(d.slice(0, 7), i); });
  const months = [...firstOf.keys()], ranked = new Map(months.map((m) => [m, []]));
  for (const st of P.stocks) { const b = st.bars; let k = 0, lc = 0;
    for (const m of months) { const fd = S[firstOf.get(m)]; while (k < b.length && b[k].d < fd) { if (k > 0 && Math.abs(b[k].o / b[k - 1].c - 1) >= RESET) lc = k; k += 1; }
      if (k - lc < 250) continue; const v = b.slice(k - 60, k).map((x) => x.val).filter((x) => x > 0).sort((a, c) => a - c); if (v.length) ranked.get(m).push([st.sym, v[Math.floor(v.length / 2)]]); } }
  const uni = new Map(); for (const [m, r] of ranked) { r.sort((a, c) => c[1] - a[1]); uni.set(m, r.slice(0, 200).map((x) => x[0])); }
  return { S, sIdx, bar, uni };
}
// NIFTY futures (the index lab's pricing)
function market(S, byDay) {
  const near = (d) => { const m = byDay.get(d); if (!m) return null; const e = [...m.keys()].filter((x) => m.get(x).o > 0).sort()[0]; return e ? { e, o: m.get(e).o, c: m.get(e).c } : null; };
  const px = (d, e, k) => { const m = byDay.get(d); const v = m && m.get(e); return v ? v[k] : null; };
  return { S, byDay, near, px };
}
function hold(D, i0, i1, side) {   // the open of session i0 to the close of session i1, rolling at an expiry
  const S = D.S; if (i0 < 1 || i1 >= S.length || i1 < i0) return null; const n = D.near(S[i0]); if (!n) return null; let e = n.e, px = n.o; const entry = px, q = Math.ceil(NOTIONAL / entry);
  let cost = charge(side > 0 ? "BUY" : "SELL", entry, q, S[i0]), value = 1;
  for (let k = i0; k <= i1; k += 1) { const c = D.px(S[k], e, "c"); if (!(c > 0)) return null;
    if (k === i1) { value *= c / px; cost += charge(side > 0 ? "SELL" : "BUY", c, q, S[k]); break; }
    if (S[k] >= e) { const e2 = [...D.byDay.get(S[k]).keys()].filter((x) => x > e).sort()[0]; const c2 = e2 ? D.px(S[k], e2, "c") : null; if (!(c2 > 0)) return null;
      value *= c / px; cost += charge(side > 0 ? "SELL" : "BUY", c, q, S[k]) + charge(side > 0 ? "BUY" : "SELL", c2, q, S[k]); e = e2; px = c2; } }
  return { net: side * (value - 1) - cost / (entry * q), rup: side * (value - 1) * entry * UNITS };
}
function niftyDown(D, j) { const n = D.near(D.S[j]); if (!n) return null; const c0 = D.px(D.S[j - 1], n.e, "c"); return c0 > 0 ? n.c < c0 : null; }

// ---------- breadth on session j ----------
// stocks: [{ c (close j), c1 (close j-1), closes50 (last 50 closes to j, or null), min250 (lowest close of the 250 before j, or null), oi, oi1 }]
function measures(stocks) {
  const both = stocks.filter((s) => s.c > 0 && s.c1 > 0); if (!both.length) return null;
  const R = (s) => s.c / s.c1 - 1, oiCh = (s) => (s.oi > 0 && s.oi1 > 0 ? s.oi / s.oi1 - 1 : null);
  const sb = both.filter((s) => R(s) <= -SBRULE.rCut && oiCh(s) !== null && oiCh(s) >= SBRULE.oiCut).length, lu = both.filter((s) => R(s) <= -SBRULE.rCut && oiCh(s) !== null && oiCh(s) <= -SBRULE.oiCut).length;
  const a50 = both.filter((s) => s.closes50); const lows = both.filter((s) => s.min250 > 0); const ois = both.filter((s) => s.oi > 0 && s.oi1 > 0);
  return { sb, lu, up: both.filter((s) => s.c > s.c1).length / both.length, above50: a50.length ? a50.filter((s) => s.c > mean(s.closes50)).length / a50.length : null,
    low: lows.length ? lows.filter((s) => s.c <= s.min250).length / lows.length : null, oiChange: ois.length ? ois.reduce((a, s) => a + s.oi, 0) / ois.reduce((a, s) => a + s.oi1, 0) - 1 : null, n: both.length };
}
function series(P, C) {   // breadth measures for every session
  const S = C.S, out = new Map();
  for (let j = 1; j < S.length; j += 1) { const U = C.uni.get(S[j].slice(0, 7)) || []; if (U.length < 100) continue; const st = [];
    for (const sym of U) { const m = C.bar.get(sym), b = m.get(j), p = m.get(j - 1); if (!b || !p) continue; const o = P.oi.get(sym);
      const c50 = []; for (let k = j - 49; k <= j; k += 1) { const x = m.get(k); if (x) c50.push(x.c); }
      let mn = Infinity, cnt = 0; for (let k = j - 250; k <= j - 1; k += 1) { const x = m.get(k); if (x) { cnt += 1; if (x.c < mn) mn = x.c; } }
      st.push({ c: b.c, c1: p.c, closes50: c50.length >= 45 ? c50 : null, min250: cnt >= 200 ? mn : null, oi: o ? o.get(S[j]) : undefined, oi1: o ? o.get(S[j - 1]) : undefined }); }
    const v = measures(st); if (v && v.n >= 100) out.set(j, v); }
  return out;
}
const pct80 = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.floor(0.8 * (s.length - 1))]; };
function trades(D, B, from, to) {   // D: NIFTY market on the same sessions; B: breadth by session index
  const S = D.S, T = new Map(MEMBERS.map((m) => [m, []])), inS = (i) => i >= 1 && i < S.length && S[i] >= from && S[i] <= to;
  const top = (j, key) => { const hist = []; for (let k = j - 250; k <= j - 1; k += 1) { const v = B.get(k); if (v && v[key] !== null && v[key] !== undefined) hist.push(v[key]); } const v = B.get(j);
    return hist.length >= 200 && v && v[key] !== null && v[key] !== undefined ? v[key] >= pct80(hist) : false; };
  for (let i = 2; i < S.length; i += 1) { if (!inS(i)) continue; const j = i - 1, v = B.get(j); if (!v) continue;
    if (top(j, "sb")) T.get(MEMBERS[0]).push({ i, len: 0, side: -1 }); if (top(j, "lu")) T.get(MEMBERS[1]).push({ i, len: 0, side: 1 });
    if (v.up >= 0.8) T.get(MEMBERS[2]).push({ i, len: 4, side: 1 }); if (v.above50 !== null && v.above50 < 0.2) T.get(MEMBERS[3]).push({ i, len: 4, side: 1 });
    if (v.low !== null && v.low >= 0.1) T.get(MEMBERS[4]).push({ i, len: 4, side: 1 }); if (top(j, "oiChange") && niftyDown(D, j) === true) T.get(MEMBERS[5]).push({ i, len: 0, side: -1 }); }
  return T;
}

// ---------- scoring (as the night lab) ----------
function nwT(x, lag = 3) { const n = x.length, m = mean(x); const e = x.map((v) => v - m); let s = e.reduce((a, v) => a + v * v, 0) / n;
  for (let L = 1; L <= lag; L += 1) { let g = 0; for (let i = L; i < n; i += 1) g += e[i] * e[i - L]; s += 2 * (1 - L / (lag + 1)) * (g / n); } return m / Math.sqrt(s / n); }
const sdv = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const Phi = (x) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
const invPhi = (p) => { let lo = -10, hi = 10; for (let i = 0; i < 100; i += 1) { const m = (lo + hi) / 2; if (Phi(m) < p) lo = m; else hi = m; } return (lo + hi) / 2; };
function score(D, T) {
  const rows = MEMBERS.map((name) => { const month = new Map(); let n = 0, won = 0, sum = 0, rup = 0;
    for (const t of T.get(name) || []) { const v = hold(D, t.i, t.i + t.len, t.side); if (!v) continue; n += 1; sum += v.net; rup += v.rup; if (v.net > 0) won += 1; const k = D.S[t.i].slice(0, 7); if (!month.has(k)) month.set(k, []); month.get(k).push(v.net * 100); }
    const s = [...month.keys()].sort().map((k) => mean(month.get(k))); if (s.length < 24) return { name, trades: n, months: s.length, verdict: "NOT TESTABLE" };
    const m = mean(s), sd = sdv(s); return { name, trades: n, months: s.length, win: (100 * won) / n, perTrade: (100 * sum) / n, rupees: Math.round(rup), monthMean: m, worstMonth: Math.min(...s), t: nwT(s), sr: m / sd,
      g3: mean(s.map((v) => ((v - m) / sd) ** 3)), g4: mean(s.map((v) => ((v - m) / sd) ** 4)) }; });
  const tested = rows.filter((r) => r.verdict !== "NOT TESTABLE"); const N = tested.length;
  if (N) { for (const r of tested) r.p = 1 - Phi(r.t); let ok = true; tested.slice().sort((a, b) => a.p - b.p).forEach((r, i) => { r.holm = ok && r.p <= 0.05 / (N - i); if (!r.holm) ok = false; });
    const g = 0.5772156649, SR0 = (N > 1 ? sdv(tested.map((r) => r.sr)) : 0) * ((1 - g) * invPhi(1 - 1 / N_TRIALS) + g * invPhi(1 - 1 / (N_TRIALS * Math.E)));
    for (const r of tested) { const den = 1 - r.g3 * r.sr + ((r.g4 - 1) / 4) * r.sr ** 2; r.dsr = den > 0 ? Phi(((r.sr - SR0) * Math.sqrt(r.months - 1)) / Math.sqrt(den)) : NaN;
      r.verdict = r.monthMean > 0 && r.t >= 3 && r.holm && r.dsr >= 0.95 ? "PASS" : r.monthMean > 0 && r.t >= 2 ? "PROMISING" : "FAIL"; } }
  return rows;
}
const sgn = (x, d = 3) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}`;
const fmt = (r, judged = true) => (r.verdict === "NOT TESTABLE" ? `${r.name.padEnd(27)} NOT TESTABLE (${r.months} months, ${r.trades} trades)`
  : `${r.name.padEnd(27)} ${String(r.trades).padStart(5)} trades | ${String(r.months).padStart(3)} months | ${sgn(r.perTrade)}% a trade | won ${r.win.toFixed(0)}% | worst month ${sgn(r.worstMonth, 2)}% | t ${r.t.toFixed(2)}`
    + (judged ? ` | Holm ${r.holm ? "y" : "n"} | DSR ${Number.isFinite(r.dsr) ? r.dsr.toFixed(2) : "-"} -> ${r.verdict}` : ` | GM 20 units Rs ${r.rupees.toLocaleString("en-IN")}`));

// ---------- checks ----------
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), 1 | t); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function check61(log) {
  const c50 = Array.from({ length: 50 }, (_, k) => 100 + (k % 3));
  const st = [{ c: 98, c1: 100, closes50: c50, min250: 99, oi: 105, oi1: 100 }, { c: 98.3, c1: 100, closes50: c50, min250: 90, oi: 105, oi1: 100 }, { c: 97, c1: 99, closes50: c50, min250: 97, oi: 1050, oi1: 1000 },
    { c: 101, c1: 100, closes50: c50, min250: 80, oi: 100, oi1: 100 }];
  const m = measures(st), wantOi = (105 + 105 + 1050 + 100) / (100 + 100 + 1000 + 100) - 1, m50 = mean(c50);
  const ok = m.sb === 3 && m.lu === 0 && m.up === 0.25 && Math.abs(m.above50 - st.filter((s) => s.c > m50).length / 4) < 1e-12 && m.low === 0.5 && Math.abs(m.oiChange - wantOi) < 1e-12;
  log(` 6.1 signals by hand: SB count ${m.sb}, UP share ${m.up}, ABOVE-50 ${m.above50}, LOW share ${m.low}, OI change ${(m.oiChange * 100).toFixed(2)}%: ${ok ? "PASSED" : "FAILED"}`); return ok;
}
function synth(seed) {   // 220 stocks with a market factor; NIFTY futures = the average path; +0.5% for NIFTY the day after an UP share >= 80%
  const r = rng(seed), g = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); const S = []; for (let t = Date.parse("2007-01-01"); t < Date.parse("2020-10-31"); t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) S.push(d.toISOString().slice(0, 10)); }
  const NS = 220, px = Array(NS).fill(100), stocks = Array.from({ length: NS }, (_, k) => ({ sym: `S${k}`, bars: [] })), byDay = new Map(); let lvl = 5000, bump = false;
  const exp = new Map(); S.forEach((d, i) => { if (i === S.length - 1 || S[i + 1].slice(0, 7) !== d.slice(0, 7)) exp.set(d.slice(0, 7), d); });
  for (const d of S) { const f = r() < 0.07 ? 0.02 : 0.004 * g(); let ups = 0;
    for (let k = 0; k < NS; k += 1) { const o = px[k] * (1 + 0.002 * g()), c = o * (1 + f + 0.012 * g()); stocks[k].bars.push({ d, o, h: Math.max(o, c), l: Math.min(o, c), c, val: 1e9 - k }); if (c > px[k]) ups += 1; px[k] = c; }
    const no = lvl * (1 + 0.001 * g()), nc = no * (1 + (bump ? 0.005 : 0) + 0.005 * g()); const e1 = exp.get(d.slice(0, 7)); const nm = new Date(`${d.slice(0, 7)}-15T00:00:00Z`); nm.setUTCMonth(nm.getUTCMonth() + 1);
    byDay.set(d, new Map([[e1, { o: no, c: nc }], [exp.get(nm.toISOString().slice(0, 7)) || `${nm.toISOString().slice(0, 7)}-28`, { o: no * 1.003, c: nc * 1.003 }]])); lvl = nc; bump = ups / NS >= 0.8; }
  return { P: { sessions: S, stocks, oi: new Map(), nifty: byDay, from: S[300], to: S.at(-1) }, D: market(S, byDay) };
}
function check62(log) { const { P, D } = synth(62), C = context(P), B = series(P, C), r = score(D, trades(D, B, P.from, P.to)).find((x) => x.name === MEMBERS[2]); const ok = r.verdict !== "NOT TESTABLE" && r.t >= 3;
  log(` 6.2 planted breadth thrust (+0.5% the next day): B3 ${r.trades} trades, t ${r.t !== undefined ? r.t.toFixed(2) : "-"}: ${ok ? "PASSED" : "FAILED"}`); return ok; }
function check63(D, T, log) { const r = rng(63), lo = 260, hi = D.S.length - 30; const R = new Map(); for (const [m, ts] of T) R.set(m, ts.map((t) => ({ ...t, i: lo + Math.floor(r() * (hi - lo)) })));
  const rows = score(D, R), passes = rows.filter((x) => x.verdict === "PASS").length;
  log(` 6.3 re-dated null on the discovery data: ${passes} PASS of ${rows.filter((x) => x.verdict !== "NOT TESTABLE").length} (at most 1 allowed): ${passes <= 1 ? "PASSED" : "FAILED"}`); return passes <= 1; }

if (require.main === module) {
  const lines = [], log = (x) => { lines.push(x); console.log(x); };
  const refuse = (why) => { fs.appendFileSync(path.join(HERE, "RESULT.txt"), lines.join("\n") + `\n${why}: real run refused.\n\n`); process.exit(1); };
  const checksOnly = process.argv.includes("--checks"); log(`BREADTH LAB${checksOnly ? " (checks only)" : ""}: registration sha256 ${SHA.slice(0, 16)}... (verified); run ${new Date().toISOString()}`);
  log("CHECKS:"); if (!check61(log)) refuse("CHECK 6.1 FAILED"); if (!check62(log)) refuse("CHECK 6.2 FAILED");
  const run = (name) => { const P = period(name), C = context(P), D = market(P.sessions, P.nifty), B = series(P, C), T = trades(D, B, P.from, P.to);
    log(`${name.toUpperCase()} DATA: ${P.sessions.length} sessions ${P.sessions[0]} .. ${P.sessions.at(-1)}, ${P.stocks.length} stocks, breadth on ${B.size} sessions; trades: ` + MEMBERS.map((m) => `${m.split(" ")[0]} ${T.get(m).length}`).join(", ")); return { D, T }; };
  const Dd = run("discovery"); if (!check63(Dd.D, Dd.T, log)) refuse("CHECK 6.3 FAILED"); if (checksOnly) { console.log("checks only: nothing scored, nothing written"); process.exit(0); }
  const rd = score(Dd.D, Dd.T); const Ff = run("confirmation"); const rf = score(Ff.D, Ff.T);   // both computed before anything is shown
  log(`\nDISCOVERY ${DISC[0]} .. ${DISC[1]} (NIFTY near-month future; monthly mean of net %; Holm across ${rd.filter((r) => r.verdict !== "NOT TESTABLE").length}; DSR with N = ${N_TRIALS}):`);
  for (const r of rd) log(" " + fmt(r)); const cand = rd.filter((r) => r.verdict === "PASS").map((r) => r.name);
  log(`DISCOVERY PASS: ${cand.join(", ") || "none"}. PROMISING: ${rd.filter((r) => r.verdict === "PROMISING").map((r) => r.name).join(", ") || "none"}.`);
  log(`\nCONFIRMATION ${CONF[0]} .. ${CONF[1]} (every member reported; a discovery PASS is CONFIRMED with mean > 0 and t >= 2):`);
  for (const r of rf) log(" " + fmt(r, false) + (cand.includes(r.name) ? (r.monthMean > 0 && r.t >= 2 ? "  -> CONFIRMED" : "  -> NOT CONFIRMED") : ""));
  const conf = rf.filter((r) => cand.includes(r.name) && r.monthMean > 0 && r.t >= 2).map((r) => r.name);
  log(`\nCANDIDATES (discovery PASS and confirmed): ${conf.join(", ") || "none"}. A candidate goes to TRACK as a forward paper test first, never straight to FUTURES.`);
  fs.appendFileSync(path.join(HERE, "RESULT.txt"), lines.join("\n") + "\n\n");
  const strip = (rs) => rs.map(({ g3, g4, sr, p, ...r }) => r); fs.writeFileSync(path.join(HERE, "result.json"), JSON.stringify({ registration: SHA, discovery: strip(rd), confirmation: strip(rf), candidates: conf }, null, 1));
}
module.exports = { MEMBERS, measures, series, trades, score, synth, check61, check62 };
