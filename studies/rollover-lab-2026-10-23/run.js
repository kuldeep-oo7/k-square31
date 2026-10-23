"use strict";
// Implements ./PREREGISTRATION.txt (sha256 in ./PREREGISTRATION.sha256): the rollover lab, one batch, one run.
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

const NOTIONAL = 500000, RESET = 0.18, N_TRIALS = 381;
const DISC = ["2005-01-01", "2020-10-31"], CONF = ["2020-10-01", "2026-10-01"], SPLIT = "2020-09-01";
const MEMBERS = ["R1 rolling longs", "R2 rolling shorts", "R3 both, long-short", "R4 unwound, short", "R5 NIFTY rollover"];
const charge = (side, price, qty, d) => calculateNseFuturesCharges({ side, price, quantity: qty, asOfDate: `${d}T12:00:00Z` }).totalCharges;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

// ---------- data: shares (CM) and every futures contract's open, close and OI ----------
const jsonDays = (dir, from, to) => fs.readdirSync(dir).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x) && x.slice(0, 10) >= from && x.slice(0, 10) <= to).sort();
function readCm(dir, from, to, P) {
  for (const f of jsonDays(dir, from, to)) { const d = f.slice(0, 10); P.sessions.push(d);
    for (const [, sym, series, o, h, l, c, , , val] of JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))) {
      if (series !== "EQ" || !sym || ![o, h, l, c].every((x) => x > 0)) continue;
      if (!P.bySym.has(sym)) P.bySym.set(sym, { sym, bars: [] }); P.bySym.get(sym).bars.push({ d, o, h, l, c, val }); } }
}
function readFut(dir, from, to, P) {   // P.fo: day -> Map("SYM" or "NIFTY" -> Map(expiry -> { o, c, oi }))
  for (const f of jsonDays(dir, from, to)) { const d = f.slice(0, 10), day = new Map();
    for (const r of JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))) { if (r[2] < d) continue; const key = r[1] === "STK" ? r[0] : r[1] === "IDX" && r[0] === "NIFTY" ? "NIFTY" : null; if (!key) continue;
      if (!day.has(key)) day.set(key, new Map()); const o = Number(r[3]), c = Number(r[6]); day.get(key).set(r[2], { o: o > 0 ? o : null, c: c > 0 ? c : null, oi: +r[8] || 0 }); }   // Number(null) is 0: never a price
    P.fo.set(d, day); }
}
function period(name) {
  const oos = path.resolve(process.env.K2_OOS_NSE || "nse-old"), R = path.resolve(process.env.K2_RESEARCH_DIR || path.join(ROOT, "research"));
  const P = { name, sessions: [], bySym: new Map(), fo: new Map() };
  if (name === "discovery") { readCm(path.join(oos, "cm"), DISC[0], DISC[1], P); readFut(path.join(oos, "fut"), DISC[0], DISC[1], P); Object.assign(P, { from: DISC[0], to: DISC[1] }); }
  else { const pre = new Date(Date.parse(SPLIT) - 864e5).toISOString().slice(0, 10);
    readCm(path.join(oos, "cm"), "0000", pre, P); readCm(path.join(R, "rising-stocks-2026-10-02", "nse-data", "cm"), SPLIT, CONF[1], P);
    readFut(path.join(oos, "fut"), "2020-01-01", pre, P); readFut(path.join(R, "orderflow-2026-10-03", "nse-fo", "fut"), SPLIT, CONF[1], P); Object.assign(P, { from: CONF[0], to: CONF[1] }); }
  P.stocks = [...P.bySym.values()]; delete P.bySym; return P;
}
function context(P) {   // share closes by session index; the night lab's monthly universe
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

// ---------- rollover, the next series' trade ----------
function rollover(contracts, X) { let all = 0, later = 0; for (const [e, v] of contracts) { all += v.oi; if (e > X) later += v.oi; } return all > 0 ? later / all : null; }
function nextTrade(P, C, key, iX, side) {   // the contract expiring next after X: its open on the session after X -> its close on its own expiry
  const S = C.S, X = S[iX]; if (iX + 1 >= S.length) return null; const now = P.fo.get(X) && P.fo.get(X).get(key); if (!now) return null;
  const e1 = [...now.keys()].filter((e) => e > X).sort()[0]; if (!e1) return null; const iE = C.sIdx.get(e1); if (iE === undefined || iE <= iX + 1) return null;
  const a = P.fo.get(S[iX + 1]), z = P.fo.get(e1); const o = a && a.get(key) && a.get(key).get(e1) ? a.get(key).get(e1).o : null, c = z && z.get(key) && z.get(key).get(e1) ? z.get(key).get(e1).c : null;
  if (!(o > 0 && c > 0)) return null; const q = Math.ceil(NOTIONAL / o);
  return { gross: c / o - 1, net: side * (c / o - 1) - (charge(side > 0 ? "BUY" : "SELL", o, q, S[iX + 1]) + charge(side > 0 ? "SELL" : "BUY", c, q, e1)) / (o * q), e1 };
}
function expiryDays(P, C) {   // sessions on which most stocks' nearest contract expires
  const out = []; for (let i = 0; i < C.S.length; i += 1) { const day = P.fo.get(C.S[i]); if (!day) continue; let n = 0, hit = 0;
    for (const [k, m] of day) { if (k === "NIFTY") continue; n += 1; if ([...m.keys()].sort()[0] === C.S[i]) hit += 1; } if (n >= 20 && hit >= n / 2) out.push(i); }
  return out;
}
function trades(P, C, from, to) {
  const S = C.S, X = expiryDays(P, C), T = new Map(MEMBERS.map((m) => [m, []])); const nifty = [];
  for (let q = 1; q < X.length; q += 1) { const iX = X[q], iP = X[q - 1], d = S[iX]; if (S[iX + 1] === undefined || S[iX + 1] < from || S[iX + 1] > to) continue; const day = P.fo.get(d);
    const U = (C.uni.get(d.slice(0, 7)) || []).filter((s) => day.has(s) && [...day.get(s).keys()].some((e) => e > d)); const rows = [];
    for (const s of U) { const ro = rollover(day.get(s), d), a = C.close.get(s).get(iX), b = C.close.get(s).get(iP); if (ro === null || !(a > 0 && b > 0)) continue; rows.push({ s, ro, move: a / b - 1 }); }
    const nr = niftyRow(P, C, iX, iP); if (nr) nifty.push({ ...nr, iX });
    if (rows.length < 50) continue; const sorted = rows.map((r) => r.ro).sort((x, y) => x - y), hi = sorted[Math.floor(0.8 * (sorted.length - 1))], lo = sorted[Math.floor(0.2 * (sorted.length - 1))];
    const longs = rows.filter((r) => r.ro >= hi && r.move > 0).map((r) => r.s), shorts = rows.filter((r) => r.ro >= hi && r.move < 0).map((r) => r.s), unwound = rows.filter((r) => r.ro <= lo).map((r) => r.s);
    const base = { iX, U: rows.map((r) => r.s) };
    if (longs.length) T.get(MEMBERS[0]).push({ ...base, legs: longs.map((s) => [s, 1]), excess: true });
    if (shorts.length) T.get(MEMBERS[1]).push({ ...base, legs: shorts.map((s) => [s, -1]), excess: true });
    if (longs.length && shorts.length) T.get(MEMBERS[2]).push({ ...base, legs: [...longs.map((s) => [s, 1]), ...shorts.map((s) => [s, -1])], longShort: true });
    if (unwound.length) T.get(MEMBERS[3]).push({ ...base, legs: unwound.map((s) => [s, -1]), excess: true }); }
  for (let q = 12; q < nifty.length; q += 1) { const n = nifty[q]; if (S[n.iX + 1] === undefined || S[n.iX + 1] < from || S[n.iX + 1] > to) continue;
    const med = nifty.slice(q - 12, q).map((x) => x.ro).sort((a, b) => a - b); const m = (med[5] + med[6]) / 2;
    if (n.ro > m && n.move !== 0) T.get(MEMBERS[4]).push({ iX: n.iX, legs: [["NIFTY", n.move > 0 ? 1 : -1]] }); }
  return T;
}
function niftyRow(P, C, iX, iP) { const X = C.S[iX], day = P.fo.get(X), prev = P.fo.get(C.S[iP]); if (!day || !prev || !day.get("NIFTY") || !prev.get("NIFTY")) return null;
  const m = day.get("NIFTY"); if (!m.has(X)) return null; const ro = rollover(m, X); const a = m.get(X).c, b = prev.get("NIFTY").get(X) ? prev.get("NIFTY").get(X).c : null; return ro !== null && a > 0 && b > 0 ? { ro, move: a / b - 1 } : null; }
function bookValue(P, C, t) {   // net (raw) or excess of one series book
  const L = [], Sh = []; for (const [s, side] of t.legs) { const v = nextTrade(P, C, s, t.iX, side); if (v) (side > 0 ? L : Sh).push(v.net); }
  if (!L.length && !Sh.length) return null; if (t.longShort && (!L.length || !Sh.length)) return null; const net = t.longShort ? (mean(L) + mean(Sh)) / 2 : mean([...L, ...Sh]);
  if (!t.excess) return net; const B = []; for (const s of t.U) { const v = nextTrade(P, C, s, t.iX, 1); if (v) B.push(v.gross); } if (B.length < 30) return null; return net - t.legs[0][1] * mean(B);
}

// ---------- scoring (as the night lab) ----------
function nwT(x, lag = 3) { const n = x.length, m = mean(x); const e = x.map((v) => v - m); let s = e.reduce((a, v) => a + v * v, 0) / n;
  for (let L = 1; L <= lag; L += 1) { let g = 0; for (let i = L; i < n; i += 1) g += e[i] * e[i - L]; s += 2 * (1 - L / (lag + 1)) * (g / n); } return m / Math.sqrt(s / n); }
const sdv = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const Phi = (x) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
const invPhi = (p) => { let lo = -10, hi = 10; for (let i = 0; i < 100; i += 1) { const m = (lo + hi) / 2; if (Phi(m) < p) lo = m; else hi = m; } return (lo + hi) / 2; };
function score(P, C, T) {
  const rows = MEMBERS.map((name) => { const month = new Map(); let n = 0, won = 0, legs = 0;
    for (const t of T.get(name) || []) { const v = bookValue(P, C, t); if (v === null) continue; n += 1; legs += t.legs.length; if (v > 0) won += 1; const k = C.S[t.iX + 1].slice(0, 7); if (!month.has(k)) month.set(k, []); month.get(k).push(v * 100); }
    const s = [...month.keys()].sort().map((k) => mean(month.get(k))); if (s.length < 24) return { name, books: n, months: s.length, verdict: "NOT TESTABLE" };
    const m = mean(s), sd = sdv(s); return { name, books: n, names: +(legs / n).toFixed(1), months: s.length, win: (100 * won) / n, monthMean: m, worstMonth: Math.min(...s), t: nwT(s), sr: m / sd,
      g3: mean(s.map((v) => ((v - m) / sd) ** 3)), g4: mean(s.map((v) => ((v - m) / sd) ** 4)) }; });
  const tested = rows.filter((r) => r.verdict !== "NOT TESTABLE"); const N = tested.length;
  if (N) { for (const r of tested) r.p = 1 - Phi(r.t); let ok = true; tested.slice().sort((a, b) => a.p - b.p).forEach((r, i) => { r.holm = ok && r.p <= 0.05 / (N - i); if (!r.holm) ok = false; });
    const g = 0.5772156649, SR0 = (N > 1 ? sdv(tested.map((r) => r.sr)) : 0) * ((1 - g) * invPhi(1 - 1 / N_TRIALS) + g * invPhi(1 - 1 / (N_TRIALS * Math.E)));
    for (const r of tested) { const den = 1 - r.g3 * r.sr + ((r.g4 - 1) / 4) * r.sr ** 2; r.dsr = den > 0 ? Phi(((r.sr - SR0) * Math.sqrt(r.months - 1)) / Math.sqrt(den)) : NaN;
      r.verdict = r.monthMean > 0 && r.t >= 3 && r.holm && r.dsr >= 0.95 ? "PASS" : r.monthMean > 0 && r.t >= 2 ? "PROMISING" : "FAIL"; } }
  return rows;
}
const sgn = (x, d = 3) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}`;
const fmt = (r, judged = true) => (r.verdict === "NOT TESTABLE" ? `${r.name.padEnd(22)} NOT TESTABLE (${r.months} months, ${r.books} books)`
  : `${r.name.padEnd(22)} ${String(r.books).padStart(4)} series | ${String(r.names).padStart(5)} names | ${String(r.months).padStart(3)} months | ${sgn(r.monthMean)}% a series | won ${r.win.toFixed(0)}% | worst ${sgn(r.worstMonth, 2)}% | t ${r.t.toFixed(2)}`
    + (judged ? ` | Holm ${r.holm ? "y" : "n"} | DSR ${Number.isFinite(r.dsr) ? r.dsr.toFixed(2) : "-"} -> ${r.verdict}` : ""));

// ---------- checks ----------
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), 1 | t); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function check51(log) {
  const ro = rollover(new Map([["2026-01-27", { oi: 600 }], ["2026-02-24", { oi: 300 }], ["2026-03-31", { oi: 100 }]]), "2026-01-27");
  const S = ["2026-01-27", "2026-01-28", "2026-02-23", "2026-02-24"], fo = new Map(S.map((d, k) => [d, new Map([["X", new Map([["2026-02-24", { o: 100 + k, c: 101 + k, oi: 1 }], ...(d <= "2026-01-27" ? [["2026-01-27", { o: 99, c: 99, oi: 1 }]] : [])])]])]));
  const P = { fo }, C = { S, sIdx: new Map(S.map((d, i) => [d, i])) }; const t = nextTrade(P, C, "X", 0, 1), q = Math.ceil(500000 / 101);
  const want = 104 / 101 - 1 - (charge("BUY", 101, q, S[1]) + charge("SELL", 104, q, S[3])) / (101 * q); const ok = Math.abs(ro - 0.4) < 1e-12 && t && Math.abs(t.net - want) < 1e-12;
  log(` 5.1 rollover by hand: ${ro}; the next contract from its open after X (101) to its close on its own expiry (104): ${t ? (t.net * 100).toFixed(3) : "-"}%: ${ok ? "PASSED" : "FAILED"}`); return ok;
}
function synth(seed) {   // 200 stocks, monthly expiries; top-fifth-rollover stocks that rose over the series gain 2% more over the next series
  const r = rng(seed), g = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); const S = []; for (let t = Date.parse("2006-01-02"); t < Date.parse("2020-10-31"); t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) S.push(d.toISOString().slice(0, 10)); }
  const exps = []; S.forEach((d, i) => { if (i === S.length - 1 || S[i + 1].slice(0, 7) !== d.slice(0, 7)) exps.push(d); }); exps.push("2020-11-26", "2020-12-31");
  const NS = 200, px = Array(NS).fill(100), stocks = Array.from({ length: NS }, (_, k) => ({ sym: `S${k}`, bars: [] })), fo = new Map(); let ro = Array(NS).fill(0.5), drift = Array(NS).fill(0), lastX = Array(NS).fill(100);
  for (const d of S) { const near = exps.filter((e) => e >= d).slice(0, 3), day = new Map();
    for (let k = 0; k < NS; k += 1) { const o = px[k] * (1 + 0.002 * g()), c = o * (1 + drift[k] + 0.015 * g()); stocks[k].bars.push({ d, o, h: Math.max(o, c), l: Math.min(o, c), c, val: 1e9 - k }); px[k] = c;
      day.set(`S${k}`, new Map(near.map((e, j) => [e, { o: o * (1 + 0.002 * j), c: c * (1 + 0.002 * j), oi: j === 0 ? 1000 * (1 - ro[k]) : (1000 * ro[k]) / (near.length - 1) }]))); }
    fo.set(d, day);
    if (exps.includes(d)) { const moves = px.map((p, k) => p / lastX[k] - 1); for (let k = 0; k < NS; k += 1) lastX[k] = px[k];
      const sorted = ro.slice().sort((a, b) => a - b), hi = sorted[Math.floor(0.8 * (NS - 1))]; const days = Math.max(1, S.filter((x) => x > d && x <= exps[exps.indexOf(d) + 1]).length);
      drift = ro.map((v, k) => (v >= hi && moves[k] > 0 ? 0.02 / days : 0)); ro = Array.from({ length: NS }, () => 0.3 + 0.6 * r()); } }
  return { sessions: S, stocks, fo, from: S[300], to: S.at(-1) };
}
function check52(log) { const P = synth(52), C = context(P), r = score(P, C, trades(P, C, P.from, P.to)).find((x) => x.name === MEMBERS[0]); const ok = r.verdict !== "NOT TESTABLE" && r.t >= 3;
  log(` 5.2 planted rolling-longs edge (+2% over the next series): R1 ${r.books} series, t ${r.t !== undefined ? r.t.toFixed(2) : "-"}: ${ok ? "PASSED" : "FAILED"}`); return ok; }
function check53(P, C, T, log) { const r = rng(53), X = expiryDays(P, C).filter((i) => C.S[i] >= DISC[0]); const R = new Map(); for (const [m, ts] of T) R.set(m, ts.map((t) => ({ ...t, iX: X[1 + Math.floor(r() * (X.length - 3))] })));
  const rows = score(P, C, R), passes = rows.filter((x) => x.verdict === "PASS").length;
  log(` 5.3 re-dated null on the discovery data: ${passes} PASS of ${rows.filter((x) => x.verdict !== "NOT TESTABLE").length} (at most 1 allowed): ${passes <= 1 ? "PASSED" : "FAILED"}`); return passes <= 1; }

if (require.main === module) {
  const lines = [], log = (x) => { lines.push(x); console.log(x); };
  const refuse = (why) => { fs.appendFileSync(path.join(HERE, "RESULT.txt"), lines.join("\n") + `\n${why}: real run refused.\n\n`); process.exit(1); };
  const checksOnly = process.argv.includes("--checks"); log(`ROLLOVER LAB${checksOnly ? " (checks only)" : ""}: registration sha256 ${SHA.slice(0, 16)}... (verified); run ${new Date().toISOString()}`);
  log("CHECKS:"); if (!check51(log)) refuse("CHECK 5.1 FAILED"); if (!check52(log)) refuse("CHECK 5.2 FAILED");
  const run = (name) => { const P = period(name), C = context(P), T = trades(P, C, P.from, P.to);
    log(`${name.toUpperCase()} DATA: ${P.sessions.length} sessions ${P.sessions[0]} .. ${P.sessions.at(-1)}, ${P.stocks.length} stocks, ${expiryDays(P, C).length} expiry days; series books: ` + MEMBERS.map((m) => `${m.split(" ")[0]} ${T.get(m).length}`).join(", ")); return { P, C, T }; };
  const D = run("discovery"); if (!check53(D.P, D.C, D.T, log)) refuse("CHECK 5.3 FAILED"); if (checksOnly) { console.log("checks only: nothing scored, nothing written"); process.exit(0); }
  const rd = score(D.P, D.C, D.T); D.P = null; const F = run("confirmation"); const rf = score(F.P, F.C, F.T);   // both computed before anything is shown
  log(`\nDISCOVERY ${DISC[0]} .. ${DISC[1]} (the next futures series, priced on futures; R1, R2, R4 excess; Holm across ${rd.filter((r) => r.verdict !== "NOT TESTABLE").length}; DSR with N = ${N_TRIALS}):`);
  for (const r of rd) log(" " + fmt(r)); const cand = rd.filter((r) => r.verdict === "PASS").map((r) => r.name);
  log(`DISCOVERY PASS: ${cand.join(", ") || "none"}. PROMISING: ${rd.filter((r) => r.verdict === "PROMISING").map((r) => r.name).join(", ") || "none"}.`);
  log(`\nCONFIRMATION ${CONF[0]} .. ${CONF[1]} (every member reported; a discovery PASS is CONFIRMED with mean > 0 and t >= 2):`);
  for (const r of rf) log(" " + fmt(r, false) + (cand.includes(r.name) ? (r.monthMean > 0 && r.t >= 2 ? "  -> CONFIRMED" : "  -> NOT CONFIRMED") : ""));
  const conf = rf.filter((r) => cand.includes(r.name) && r.monthMean > 0 && r.t >= 2).map((r) => r.name);
  log(`\nCANDIDATES (discovery PASS and confirmed): ${conf.join(", ") || "none"}. A candidate goes to TRACK as a forward paper test first, never straight to FUTURES.`);
  fs.appendFileSync(path.join(HERE, "RESULT.txt"), lines.join("\n") + "\n\n");
  const strip = (rs) => rs.map(({ g3, g4, sr, p, ...r }) => r); fs.writeFileSync(path.join(HERE, "result.json"), JSON.stringify({ registration: SHA, discovery: strip(rd), confirmation: strip(rf), candidates: conf }, null, 1));
}
module.exports = { MEMBERS, rollover, nextTrade, trades, score, synth, check51, check52 };
