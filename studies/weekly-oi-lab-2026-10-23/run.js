"use strict";
// Implements ./PREREGISTRATION.txt (sha256 in ./PREREGISTRATION.sha256): the weekly open-interest lab, one batch, one run.
//   node run.js --checks   checks 5.1-5.3 only (5.3 needs the discovery data); nothing is scored
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

const NOTIONAL = 500000, RESET = 0.18, N_TRIALS = 389;
const DISC = ["2005-01-01", "2020-10-31"], CONF = ["2020-10-01", "2026-10-01"], SPLIT = "2020-09-01";
const MEMBERS = ["W1 weekly long build-up", "W2 weekly short build-up", "W3 weekly short covering", "W4 weekly long unwinding"];
const RULES = [[(r, o) => r >= 0.05 && o >= 0.1, 1], [(r, o) => r <= -0.05 && o >= 0.1, -1], [(r, o) => r >= 0.05 && o <= -0.1, -1], [(r, o) => r <= -0.05 && o <= -0.1, 1]];
const charge = (side, price, qty, d) => calculateNseFuturesCharges({ side, price, quantity: qty, asOfDate: `${d}T12:00:00Z` }).totalCharges;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

// ---------- data (as the futures lab) ----------
const jsonDays = (dir, from, to) => fs.readdirSync(dir).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x) && x.slice(0, 10) >= from && x.slice(0, 10) <= to).sort();
function readCm(dir, from, to, P) {
  for (const f of jsonDays(dir, from, to)) { const d = f.slice(0, 10); P.sessions.push(d);
    for (const [, sym, series, o, h, l, c, , , val] of JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))) {
      if (series !== "EQ" || !sym || ![o, h, l, c].every((x) => x > 0)) continue; if (!P.bySym.has(sym)) P.bySym.set(sym, { sym, bars: [] }); P.bySym.get(sym).bars.push({ d, o, h, l, c, val }); } }
}
function readFut(dir, from, to, P) {
  for (const f of jsonDays(dir, from, to)) { const d = f.slice(0, 10); const near = new Map(), fcs = new Map();
    for (const r of JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))) { if (r[1] !== "STK") continue;
      if (!P.oi.has(r[0])) P.oi.set(r[0], new Map()); const m = P.oi.get(r[0]); m.set(d, (m.get(d) || 0) + (+r[8] || 0));
      if (r[2] >= d) { const o = Number(r[3]), c = Number(r[6]); if (c > 0) { if (!fcs.has(r[0])) fcs.set(r[0], []); fcs.get(r[0]).push([r[2], c]); } if (o > 0 && c > 0 && (!near.has(r[0]) || r[2] < near.get(r[0]).e)) near.set(r[0], { e: r[2], o, c }); } }
    for (const [sym, v] of near) { if (!P.fnear.has(sym)) P.fnear.set(sym, new Map()); P.fnear.get(sym).set(d, v); }
    for (const [sym, list] of fcs) { if (!P.fc.has(sym)) P.fc.set(sym, new Map()); const m = P.fc.get(sym); for (const [e, c] of list.sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(0, 3)) { if (!m.has(e)) m.set(e, new Map()); m.get(e).set(d, c); } } }
}
function period(name) {
  const oos = path.resolve(process.env.K2_OOS_NSE || "nse-old"), R = path.resolve(process.env.K2_RESEARCH_DIR || path.join(ROOT, "research"));
  const P = { name, sessions: [], bySym: new Map(), oi: new Map(), fnear: new Map(), fc: new Map() };
  if (name === "discovery") { readCm(path.join(oos, "cm"), DISC[0], DISC[1], P); readFut(path.join(oos, "fut"), DISC[0], DISC[1], P); Object.assign(P, { from: DISC[0], to: DISC[1] }); }
  else { const pre = new Date(Date.parse(SPLIT) - 864e5).toISOString().slice(0, 10);
    readCm(path.join(oos, "cm"), "0000", pre, P); readCm(path.join(R, "rising-stocks-2026-10-02", "nse-data", "cm"), SPLIT, CONF[1], P);
    readFut(path.join(oos, "fut"), "2019-01-01", pre, P); readFut(path.join(R, "orderflow-2026-10-03", "nse-fo", "fut"), SPLIT, CONF[1], P); Object.assign(P, { from: CONF[0], to: CONF[1] }); }
  P.stocks = [...P.bySym.values()]; delete P.bySym; return P;
}
function context(P) {
  const S = P.sessions, sIdx = new Map(S.map((d, i) => [d, i])), close = new Map();
  for (const st of P.stocks) { const m = new Map(); for (const b of st.bars) m.set(sIdx.get(b.d), b.c); close.set(st.sym, m); }
  const firstOf = new Map(); S.forEach((d, i) => { if (!firstOf.has(d.slice(0, 7))) firstOf.set(d.slice(0, 7), i); });
  const months = [...firstOf.keys()], ranked = new Map(months.map((m) => [m, []]));
  for (const st of P.stocks) { const b = st.bars; let k = 0, lc = 0;
    for (const m of months) { const fd = S[firstOf.get(m)]; while (k < b.length && b[k].d < fd) { if (k > 0 && Math.abs(b[k].o / b[k - 1].c - 1) >= RESET) lc = k; k += 1; }
      if (k - lc < 250) continue; const v = b.slice(k - 60, k).map((x) => x.val).filter((x) => x > 0).sort((a, c) => a - c); if (v.length) ranked.get(m).push([st.sym, v[Math.floor(v.length / 2)]]); } }
  const uni = new Map(); for (const [m, r] of ranked) { r.sort((a, c) => c[1] - a[1]); uni.set(m, r.slice(0, 200).map((x) => x[0])); }
  return { S, sIdx, close, uni };
}
function futHold(P, C, sym, i, h, side) {   // the futures lab's: the near-month future from the open of i to the close of i+h-1, rolling at an expiry
  const S = C.S, n0 = P.fnear.get(sym) && P.fnear.get(sym).get(S[i]); if (!n0) return null; const fc = P.fc.get(sym); if (!fc) return null;
  let e = n0.e, px = n0.o, value = 1; const q = Math.ceil(NOTIONAL / n0.o); let cost = charge(side > 0 ? "BUY" : "SELL", n0.o, q, S[i]);
  for (let k = i; k <= i + h - 1; k += 1) { const d = S[k]; if (k >= S.length) return null; const c = fc.get(e) && fc.get(e).get(d); if (!(c > 0)) return null;
    if (k === i + h - 1) { value *= c / px; cost += charge(side > 0 ? "SELL" : "BUY", c, q, d); break; }
    if (d >= e) { const e2 = [...fc.keys()].filter((x) => x > e && fc.get(x).has(d)).sort()[0]; if (!e2) return null; const c2 = fc.get(e2).get(d);
      value *= c / px; cost += charge(side > 0 ? "SELL" : "BUY", c, q, d) + charge(side > 0 ? "BUY" : "SELL", c2, q, d); e = e2; px = c2; } }
  return { net: side * (value - 1) - cost / (n0.o * q), gross: value - 1 };
}
function isoWeek(d) { const t = new Date(`${d}T00:00:00Z`); const day = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - day + 3); const y = t.getUTCFullYear();
  const w = 1 + Math.round((t - Date.UTC(y, 0, 4)) / 864e5 / 7 - ((new Date(Date.UTC(y, 0, 4)).getUTCDay() + 6) % 7 - 3) / 7); return `${y}-W${String(w).padStart(2, "0")}`; }
function weeks(S) { const wk = S.map(isoWeek), out = []; let a = 0; for (let i = 1; i <= S.length; i += 1) if (i === S.length || wk[i] !== wk[i - 1]) { out.push([a, i - 1]); a = i; } return out; }

// ---------- members ----------
function books(P, C) {
  const S = C.S, W = weeks(S), T = new Map(MEMBERS.map((m) => [m, []]));
  for (let w = 1; w < W.length; w += 1) { const f = W[w - 1][1], [i, e] = W[w]; if (S[i] < P.from || S[i] > P.to || f < 5) continue; const U = C.uni.get(S[i].slice(0, 7)) || []; const picks = MEMBERS.map(() => []);
    for (const s of U) { const c = C.close.get(s), o = P.oi.get(s); const c0 = c.get(f), c5 = c.get(f - 5), o0 = o && o.get(S[f]), o5 = o && o.get(S[f - 5]); if (!(c0 > 0 && c5 > 0 && o0 > 0 && o5 > 0)) continue;
      const r = c0 / c5 - 1, x = o0 / o5 - 1; RULES.forEach(([ok], k) => { if (ok(r, x)) picks[k].push(s); }); }
    picks.forEach((names, k) => { if (names.length) T.get(MEMBERS[k]).push({ i, h: e - i + 1, side: RULES[k][1], names, U }); }); }
  return T;
}
function bookValue(P, C, t) { const v = []; for (const s of t.names) { const x = futHold(P, C, s, t.i, t.h, t.side); if (x) v.push(x.net); } if (!v.length) return null;
  const B = []; for (const s of t.U) { const x = futHold(P, C, s, t.i, t.h, 1); if (x) B.push(x.gross); } if (B.length < 30) return null; return mean(v) - t.side * mean(B); }

// ---------- scoring (as the night lab) ----------
function nwT(x, lag = 3) { const n = x.length, m = mean(x); const e = x.map((v) => v - m); let s = e.reduce((a, v) => a + v * v, 0) / n;
  for (let L = 1; L <= lag; L += 1) { let g = 0; for (let i = L; i < n; i += 1) g += e[i] * e[i - L]; s += 2 * (1 - L / (lag + 1)) * (g / n); } return m / Math.sqrt(s / n); }
const sdv = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const Phi = (x) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
const invPhi = (p) => { let lo = -10, hi = 10; for (let i = 0; i < 100; i += 1) { const m = (lo + hi) / 2; if (Phi(m) < p) lo = m; else hi = m; } return (lo + hi) / 2; };
function score(P, C, T) {
  const rows = MEMBERS.map((name) => { const month = new Map(); let n = 0, won = 0, names = 0;
    for (const t of T.get(name) || []) { const v = bookValue(P, C, t); if (v === null) continue; n += 1; names += t.names.length; if (v > 0) won += 1; const k = C.S[t.i].slice(0, 7); if (!month.has(k)) month.set(k, []); month.get(k).push(v * 100); }
    const s = [...month.keys()].sort().map((k) => mean(month.get(k))); if (s.length < 24) return { name, books: n, months: s.length, verdict: "NOT TESTABLE" };
    const m = mean(s), sd = sdv(s); return { name, books: n, names: +(names / n).toFixed(1), months: s.length, win: (100 * won) / n, monthMean: m, worstMonth: Math.min(...s), t: nwT(s), sr: m / sd,
      g3: mean(s.map((v) => ((v - m) / sd) ** 3)), g4: mean(s.map((v) => ((v - m) / sd) ** 4)) }; });
  const tested = rows.filter((r) => r.verdict !== "NOT TESTABLE"); const N = tested.length;
  if (N) { for (const r of tested) r.p = 1 - Phi(r.t); let ok = true; tested.slice().sort((a, b) => a.p - b.p).forEach((r, i) => { r.holm = ok && r.p <= 0.05 / (N - i); if (!r.holm) ok = false; });
    const g = 0.5772156649, SR0 = (N > 1 ? sdv(tested.map((r) => r.sr)) : 0) * ((1 - g) * invPhi(1 - 1 / N_TRIALS) + g * invPhi(1 - 1 / (N_TRIALS * Math.E)));
    for (const r of tested) { const den = 1 - r.g3 * r.sr + ((r.g4 - 1) / 4) * r.sr ** 2; r.dsr = den > 0 ? Phi(((r.sr - SR0) * Math.sqrt(r.months - 1)) / Math.sqrt(den)) : NaN;
      r.verdict = r.monthMean > 0 && r.t >= 3 && r.holm && r.dsr >= 0.95 ? "PASS" : r.monthMean > 0 && r.t >= 2 ? "PROMISING" : "FAIL"; } }
  return rows;
}
const sgn = (x, d = 3) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}`;
const fmt = (r, judged = true) => (r.verdict === "NOT TESTABLE" ? `${r.name.padEnd(26)} NOT TESTABLE (${r.months} months, ${r.books} weeks)`
  : `${r.name.padEnd(26)} ${String(r.books).padStart(4)} weeks | ${String(r.names).padStart(5)} names | ${String(r.months).padStart(3)} months | ${sgn(r.monthMean)}% a week vs market | won ${r.win.toFixed(0)}% | worst month ${sgn(r.worstMonth, 2)}% | t ${r.t.toFixed(2)}`
    + (judged ? ` | Holm ${r.holm ? "y" : "n"} | DSR ${Number.isFinite(r.dsr) ? r.dsr.toFixed(2) : "-"} -> ${r.verdict}` : ""));

// ---------- checks ----------
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), 1 | t); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function synth(seed) {   // 120 stocks; weekly price and OI moves; W1 names (up >= 5% with OI >= 10%) gain 1.5% more the next week
  const r = rng(seed), g = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); const S = []; for (let t = Date.parse("2008-01-01"); t < Date.parse("2016-12-31"); t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) S.push(d.toISOString().slice(0, 10)); }
  const exp = new Map(); S.forEach((d, i) => { if (i === S.length - 1 || S[i + 1].slice(0, 7) !== d.slice(0, 7)) exp.set(d.slice(0, 7), d); });
  const wk = S.map(isoWeek), NS = 120, P = { sessions: S, stocks: Array.from({ length: NS }, (_, k) => ({ sym: `S${k}`, bars: [] })), oi: new Map(), fnear: new Map(), fc: new Map(), from: S[300], to: S.at(-1) };
  const px = Array(NS).fill(100), oi = Array(NS).fill(1e6), drift = Array(NS).fill(0), anchorPx = Array(NS).fill(100), anchorOi = Array(NS).fill(1e6); let hist = [];
  S.forEach((d, i) => { const e1 = exp.get(d.slice(0, 7)), nm = new Date(`${d.slice(0, 7)}-15T00:00:00Z`); nm.setUTCMonth(nm.getUTCMonth() + 1); const e2 = exp.get(nm.toISOString().slice(0, 7)) || `${nm.toISOString().slice(0, 7)}-28`;
    for (let k = 0; k < NS; k += 1) { const s = `S${k}`, o = px[k] * (1 + 0.002 * g()), c = o * (1 + drift[k] + 0.018 * g()); P.stocks[k].bars.push({ d, o, h: Math.max(o, c), l: Math.min(o, c), c, val: 1e9 - k }); px[k] = c;
      oi[k] *= 1 + 0.03 * g(); if (!P.oi.has(s)) P.oi.set(s, new Map()); P.oi.get(s).set(d, oi[k]); if (!P.fnear.has(s)) { P.fnear.set(s, new Map()); P.fc.set(s, new Map()); }
      P.fnear.get(s).set(d, { e: e1, o, c }); for (const [e, f] of [[e1, 1], [e2, 1.003]]) { if (!P.fc.get(s).has(e)) P.fc.get(s).set(e, new Map()); P.fc.get(s).get(e).set(d, c * f); } }
    hist.push(i); if (hist.length > 6) hist.shift();
    if (i === S.length - 1 || wk[i + 1] !== wk[i]) { for (let k = 0; k < NS; k += 1) { const c5 = hist.length === 6 ? P.stocks[k].bars[hist[0]].c : null, o5 = hist.length === 6 ? P.oi.get(`S${k}`).get(S[hist[0]]) : null;
        drift[k] = c5 && o5 && px[k] / c5 - 1 >= 0.05 && oi[k] / o5 - 1 >= 0.1 ? 0.015 / 5 : 0; } } });
  return P;
}
function check51(log) {
  const S = ["2026-01-19", "2026-01-20", "2026-01-21", "2026-01-22", "2026-01-23", "2026-01-26", "2026-01-27", "2026-01-28", "2026-01-29", "2026-01-30"];
  const c = [100, 100, 101, 102, 104, 106, 106, 106, 106, 106], oi = [1e6, 1e6, 1e6, 1.05e6, 1.1e6, 1.12e6, 1, 1, 1, 1].map((x) => x * 1);
  const pick = RULES[0][0](c[5] / c[0] - 1, oi[5] / oi[0] - 1);
  const fnear = new Map([["2026-01-27", { e: "2026-01-27", o: 107, c: 108 }]]), fc = new Map([["2026-01-27", new Map([["2026-01-27", 108]])], ["2026-02-24", new Map([["2026-01-27", 109], ["2026-01-28", 110], ["2026-01-29", 111], ["2026-01-30", 112]])]]);
  const P = { fnear: new Map([["X", fnear]]), fc: new Map([["X", fc]]) }, C = { S }; const v = futHold(P, C, "X", 6, 4, 1), q = Math.ceil(500000 / 107);
  const want = (108 / 107) * (112 / 109) - 1 - (charge("BUY", 107, q, S[6]) + charge("SELL", 108, q, S[6]) + charge("BUY", 109, q, S[6]) + charge("SELL", 112, q, S[9])) / (107 * q);
  const ok = pick && v && Math.abs(v.net - want) < 1e-12;
  log(` 5.1 by hand: up 6% with OI up 12% is a W1 name (${pick}); its week from the first open to the last close rolls at the 27 Jan expiry: ${v ? (v.net * 100).toFixed(3) : "-"}%: ${ok ? "PASSED" : "FAILED"}`); return ok;
}
function check52(log) { const P = synth(52), C = context(P), r = score(P, C, books(P, C)).find((x) => x.name === MEMBERS[0]); const ok = r.verdict !== "NOT TESTABLE" && r.t >= 3;
  log(` 5.2 planted (W1 names +1.5% the next week): W1 ${r.books} weeks, t ${r.t !== undefined ? r.t.toFixed(2) : "-"}: ${ok ? "PASSED" : "FAILED"}`); return ok; }
function check53(P, C, T, log) { const r = rng(53), W = weeks(C.S).filter(([i]) => C.S[i] >= DISC[0] && i > 300); const R = new Map();
  for (const [m, ts] of T) R.set(m, ts.map((t) => { const [i, e] = W[Math.floor(r() * W.length)]; return { ...t, i, h: e - i + 1 }; }));
  const rows = score(P, C, R), passes = rows.filter((x) => x.verdict === "PASS").length;
  log(` 5.3 re-dated null on the discovery data: ${passes} PASS of ${rows.filter((x) => x.verdict !== "NOT TESTABLE").length} (at most 1 allowed): ${passes <= 1 ? "PASSED" : "FAILED"}`); return passes <= 1; }

if (require.main === module) {
  const lines = [], log = (x) => { lines.push(x); console.log(x); };
  const refuse = (why) => { fs.appendFileSync(path.join(HERE, "RESULT.txt"), lines.join("\n") + `\n${why}: real run refused.\n\n`); process.exit(1); };
  const checksOnly = process.argv.includes("--checks"); log(`WEEKLY OI LAB${checksOnly ? " (checks only)" : ""}: registration sha256 ${SHA.slice(0, 16)}... (verified); run ${new Date().toISOString()}`);
  log("CHECKS:"); if (!check51(log)) refuse("CHECK 5.1 FAILED"); if (!check52(log)) refuse("CHECK 5.2 FAILED");
  const run = (name) => { const P = period(name), C = context(P), T = books(P, C); log(`${name.toUpperCase()} DATA: ${P.sessions.length} sessions ${P.sessions[0]} .. ${P.sessions.at(-1)}, ${P.stocks.length} stocks; weekly books: ` + MEMBERS.map((m) => `${m.split(" ")[0]} ${T.get(m).length}`).join(", ")); return { P, C, T }; };
  const D = run("discovery"); if (!check53(D.P, D.C, D.T, log)) refuse("CHECK 5.3 FAILED"); if (checksOnly) { console.log("checks only: nothing scored, nothing written"); process.exit(0); }
  const rd = score(D.P, D.C, D.T); D.P = null; const F = run("confirmation"); const rf = score(F.P, F.C, F.T);   // both computed before anything is shown
  log(`\nDISCOVERY ${DISC[0]} .. ${DISC[1]} (next week on futures, excess over the universe's futures; Holm across ${rd.filter((r) => r.verdict !== "NOT TESTABLE").length}; DSR with N = ${N_TRIALS}):`);
  for (const r of rd) log(" " + fmt(r)); const cand = rd.filter((r) => r.verdict === "PASS").map((r) => r.name);
  log(`DISCOVERY PASS: ${cand.join(", ") || "none"}. PROMISING: ${rd.filter((r) => r.verdict === "PROMISING").map((r) => r.name).join(", ") || "none"}.`);
  log(`\nCONFIRMATION ${CONF[0]} .. ${CONF[1]} (every member reported; a discovery PASS is CONFIRMED with mean > 0 and t >= 2):`);
  for (const r of rf) log(" " + fmt(r, false) + (cand.includes(r.name) ? (r.monthMean > 0 && r.t >= 2 ? "  -> CONFIRMED" : "  -> NOT CONFIRMED") : ""));
  const conf = rf.filter((r) => cand.includes(r.name) && r.monthMean > 0 && r.t >= 2).map((r) => r.name);
  log(`\nCANDIDATES (discovery PASS and confirmed): ${conf.join(", ") || "none"}. A candidate goes to TRACK as a forward paper test first, never straight to FUTURES.`);
  fs.appendFileSync(path.join(HERE, "RESULT.txt"), lines.join("\n") + "\n\n");
  const strip = (rs) => rs.map(({ g3, g4, sr, p, ...r }) => r); fs.writeFileSync(path.join(HERE, "result.json"), JSON.stringify({ registration: SHA, discovery: strip(rd), confirmation: strip(rf), candidates: conf }, null, 1));
}
module.exports = { MEMBERS, books, score, synth, futHold, check51, check52 };
