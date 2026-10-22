"use strict";
// Implements ./PREREGISTRATION.txt (sha256 in ./PREREGISTRATION.sha256): the options lab, one batch, one run.
//   node run.js --checks   checks 6.1-6.3 only (6.3 needs the discovery data); nothing is scored
//   node run.js            the real run: checks, discovery 2005-2020, confirmation 2020-2026 (RESULT.txt, result.json)
// Data (private, never committed): K2_OOS_NSE = data-oos nse-old/ (cm/, fut/, sopt/); K2_RESEARCH_DIR = a research/ tree
// (rising-stocks-2026-10-02/nse-data/cm, orderflow-2026-10-03/nse-fo/fut, options-2026-10-04/nse-sopt). Summary rows only.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const ROOT = path.resolve(__dirname, "..", "..");
const HERE = __dirname;
const SHA = fs.readFileSync(path.join(HERE, "PREREGISTRATION.sha256"), "utf8").split(/\s+/)[0];
if (crypto.createHash("sha256").update(fs.readFileSync(path.join(HERE, "PREREGISTRATION.txt"), "utf8").replace(/\r\n/g, "\n")).digest("hex") !== SHA) { console.error("PRE-REGISTRATION CHANGED; result void."); process.exit(2); }
const { calculateNseFuturesCharges } = require(path.join(ROOT, "api/_lib/shadow-broker"));

const NOTIONAL = 500000, RESET = 0.18, N_TRIALS = 352, RATE = 0.065;
const DISC = ["2005-01-01", "2020-10-31"], CONF = ["2020-10-01", "2026-10-01"], SPLIT = "2020-09-01";
const MEMBERS = ["O1 smirk long-short", "O2 smirk short only", "O3 call-put spread long-short", "O4 call-put spread long only", "O5 IV changes long-short",
  "O6 option/futures volume L-S", "O7 realized minus implied L-S", "O8 combined long-short"];
const charge = (side, price, qty, d) => calculateNseFuturesCharges({ side, price, quantity: qty, asOfDate: `${d}T12:00:00Z` }).totalCharges;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sdv = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const Phi = (x) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
const invPhi = (p) => { let lo = -10, hi = 10; for (let i = 0; i < 100; i += 1) { const m = (lo + hi) / 2; if (Phi(m) < p) lo = m; else hi = m; } return (lo + hi) / 2; };

// ---------- Black-76 and its implied volatility ----------
function b76(type, F, K, T, s) { const v = s * Math.sqrt(T), d1 = (Math.log(F / K) + 0.5 * v * v) / v, d2 = d1 - v, df = Math.exp(-RATE * T);
  return type === "CE" ? df * (F * Phi(d1) - K * Phi(d2)) : df * (K * Phi(-d2) - F * Phi(-d1)); }
function impliedVol(type, price, F, K, T) {
  if (!(T > 0 && F > 0 && K > 0 && price > 0)) return null; const intr = Math.exp(-RATE * T) * Math.max(0, type === "CE" ? F - K : K - F); if (!(price > intr)) return null;
  let lo = 0.01, hi = 5; if (b76(type, F, K, T, lo) > price || b76(type, F, K, T, hi) < price) return null;
  for (let k = 0; k < 80; k += 1) { const m = (lo + hi) / 2; if (b76(type, F, K, T, m) < price) lo = m; else hi = m; } const s = (lo + hi) / 2;
  return s <= 0.0101 || s >= 4.999 ? null : s;
}
// one stock on one formation day: rows [symbol, expiry, strike, CE|PE, close, settle, oi, contracts]; fclose: "SYM|expiry" -> futures close
function stockIv(d, sym, rows, fclose) {
  const E = [...new Set(rows.map((r) => r[1]))].sort().find((e) => (Date.parse(e) - Date.parse(d)) / 864e5 >= 7); if (!E) return null;
  const F = fclose.get(`${sym}|${E}`); if (!(F > 0)) return null; const T = (Date.parse(E) - Date.parse(d)) / 864e5 / 365;
  const opts = rows.filter((r) => r[1] === E && +r[7] > 0 && +r[4] > 0).map((r) => ({ K: +r[2], type: r[3], oi: +r[6] || 0, iv: impliedVol(r[3], +r[4], F, +r[2], T) })).filter((o) => o.iv !== null);
  const closest = (arr, lo, hi, target) => { let best = null; for (const o of arr) { const m = o.K / F; if (m < lo || m > hi) continue; if (!best || Math.abs(m - target) < Math.abs(best.K / F - target) || (Math.abs(m - target) === Math.abs(best.K / F - target) && o.K < best.K)) best = o; } return best; };
  const puts = opts.filter((o) => o.type === "PE"), calls = opts.filter((o) => o.type === "CE");
  const p95 = closest(puts, 0.80, 0.95, 0.95), c100 = closest(calls, 0.95, 1.05, 1.0), c1 = closest(calls, 0, Infinity, 1), p1 = closest(puts, 0, Infinity, 1);
  const byK = new Map(); for (const o of opts) { if (!byK.has(o.K)) byK.set(o.K, {}); byK.get(o.K)[o.type] = o; }
  const pairs = [...byK.entries()].filter(([, v]) => v.CE && v.PE).sort((a, b) => a[0] - b[0]);
  let w = 0, acc = 0; for (const [, v] of pairs) { const x = (v.CE.oi + v.PE.oi) / 2; w += x; acc += x * (v.CE.iv - v.PE.iv); }
  const cps = pairs.length ? (w > 0 ? acc / w : mean(pairs.map(([, v]) => v.CE.iv - v.PE.iv))) : null;
  const atm = pairs.reduce((b, x) => (!b || Math.abs(x[0] / F - 1) < Math.abs(b[0] / F - 1) ? x : b), null);
  return { smirk: p95 && c100 ? p95.iv - c100.iv : null, cps, ivatm: atm ? (atm[1].CE.iv + atm[1].PE.iv) / 2 : null, ivc1: c1 ? c1.iv : null, ivp1: p1 ? p1.iv : null };
}

// ---------- data ----------
const days = (dir, from, to, ext) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.endsWith(ext) && /^\d{4}-\d{2}-\d{2}/.test(x) && x.slice(0, 10) >= from && x.slice(0, 10) <= to).sort() : []);
function readCm(dir, from, to, P) {
  for (const f of days(dir, from, to, ".json")) { const d = f.slice(0, 10); P.sessions.push(d);
    for (const [, sym, series, o, h, l, c, , v, val] of JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))) {
      if (series !== "EQ" || !sym || ![o, h, l, c].every((x) => x > 0)) continue;
      if (!P.bySym.has(sym)) P.bySym.set(sym, { sym, bars: [] }); P.bySym.get(sym).bars.push({ d, o, h, l, c, v: +v || 0, val }); } }
}
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return []; } };
const readGz = (f) => { try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(f))); } catch { return []; } };
function period(name) {
  const oos = path.resolve(process.env.K2_OOS_NSE || "nse-old"), R = path.resolve(process.env.K2_RESEARCH_DIR || path.join(ROOT, "research"));
  const P = { name, sessions: [], bySym: new Map() };
  if (name === "discovery") { readCm(path.join(oos, "cm"), DISC[0], DISC[1], P); Object.assign(P, { from: DISC[0], to: DISC[1],
    futRows: (d) => readJson(path.join(oos, "fut", `${d}.json`)), optRows: (d) => readGz(path.join(oos, "sopt", `${d}.json.gz`)) }); }
  else { const pre = new Date(Date.parse(SPLIT) - 864e5).toISOString().slice(0, 10);   // night lab A1: data-oos before 2020-09-01 as look-back only
    readCm(path.join(oos, "cm"), "0000", pre, P); readCm(path.join(R, "rising-stocks-2026-10-02", "nse-data", "cm"), SPLIT, CONF[1], P);
    Object.assign(P, { from: CONF[0], to: CONF[1], futRows: (d) => (d < SPLIT ? readJson(path.join(oos, "fut", `${d}.json`)) : readJson(path.join(R, "orderflow-2026-10-03", "nse-fo", "fut", `${d}.json`))),
      optRows: (d) => (d < SPLIT ? [] : readGz(path.join(R, "options-2026-10-04", "nse-sopt", `${d}.json.gz`))) }); }
  P.stocks = [...P.bySym.values()]; delete P.bySym; return P;
}
function isoWeek(d) { const t = new Date(`${d}T00:00:00Z`); const day = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - day + 3); const y = t.getUTCFullYear();
  const w = 1 + Math.round((t - Date.UTC(y, 0, 4)) / 864e5 / 7 - ((new Date(Date.UTC(y, 0, 4)).getUTCDay() + 6) % 7 - 3) / 7); return `${y}-W${String(w).padStart(2, "0")}`; }
function computeSignals(P, onlyFrom) {   // per formation day: each stock's IV measures; per session: option and futures contracts by stock
  const S = P.sessions, wk = S.map(isoWeek), lastOfWeek = new Set(), lastOfMonth = new Set();
  S.forEach((d, i) => { if (i === S.length - 1 || wk[i + 1] !== wk[i]) lastOfWeek.add(i); if (i === S.length - 1 || S[i + 1].slice(0, 7) !== d.slice(0, 7)) lastOfMonth.add(i); });
  const sig = new Map(), optC = new Map(), futC = new Map(); let ivDays = 0;
  for (let i = 0; i < S.length; i += 1) { const d = S[i]; if (d < onlyFrom) continue; const form = lastOfWeek.has(i) || lastOfMonth.has(i);
    const fc = new Map(), fclose = new Map(); for (const r of P.futRows(d)) if (r[1] === "STK") { fc.set(r[0], (fc.get(r[0]) || 0) + (+r[10] || 0)); if (form && r[6] > 0) fclose.set(`${r[0]}|${r[2]}`, +r[6]); }
    const oc = new Map(), bySym = new Map(); for (const r of P.optRows(d)) { oc.set(r[0], (oc.get(r[0]) || 0) + (+r[7] || 0)); if (form) { if (!bySym.has(r[0])) bySym.set(r[0], []); bySym.get(r[0]).push(r); } }
    futC.set(i, fc); optC.set(i, oc);
    if (form && bySym.size) { const m = new Map(); for (const [sym, rows] of bySym) { const v = stockIv(d, sym, rows, fclose); if (v) m.set(sym, v); } sig.set(i, m); ivDays += 1; } }
  return { sig, optC, futC, lastOfWeek, lastOfMonth, wk, ivDays };
}

// ---------- the night lab's engine (studies/night-lab-2026-10-23/run.js): universe, legs, charges, books ----------
function context(P) {
  const S = P.sessions, sIdx = new Map(S.map((d, i) => [d, i])), bar = new Map();
  for (const st of P.stocks) { const m = new Map(); for (const b of st.bars) m.set(sIdx.get(b.d), b); bar.set(st.sym, m); }
  const firstOf = new Map(); S.forEach((d, i) => { if (!firstOf.has(d.slice(0, 7))) firstOf.set(d.slice(0, 7), i); });
  const months = [...firstOf.keys()], ranked = new Map(months.map((m) => [m, []]));
  for (const st of P.stocks) { const b = st.bars; let k = 0, lc = 0;
    for (const m of months) { const fd = S[firstOf.get(m)]; while (k < b.length && b[k].d < fd) { if (k > 0 && Math.abs(b[k].o / b[k - 1].c - 1) >= RESET) lc = k; k += 1; }
      if (k - lc < 250) continue; const v = b.slice(k - 60, k).map((x) => x.val).filter((x) => x > 0).sort((a, c) => a - c); if (v.length) ranked.get(m).push([st.sym, v[Math.floor(v.length / 2)]]); } }
  const uni = new Map(); for (const [m, r] of ranked) { r.sort((a, c) => c[1] - a[1]); uni.set(m, r.slice(0, 200).map((x) => x[0])); }
  return { S, sIdx, bar, uni, bc: new Map() };
}
function legFill(C, sym, i, h) { const m = C.bar.get(sym); if (!m) return null; const first = m.get(i); if (!first) return null; let last = first;
  for (let k = i + 1; k <= i + h - 1; k += 1) { const b = m.get(k), p = m.get(k - 1); if (!b || Math.abs(b.o / p.c - 1) >= RESET) return null; last = b; }
  return { e: first.o, x: last.c, d: C.S[i], xd: C.S[i + h - 1] }; }
function finish(side, e, x, d, xd) { const q = Math.ceil(NOTIONAL / e); const cross = (+xd.slice(0, 4) - +d.slice(0, 4)) * 12 + (+xd.slice(5, 7) - +d.slice(5, 7));
  return side * (x / e - 1) - (charge(side > 0 ? "BUY" : "SELL", e, q, d) + charge(side > 0 ? "SELL" : "BUY", x, q, xd) + cross * (charge("BUY", x, q, xd) + charge("SELL", x, q, xd))) / (e * q); }
function bench(C, i, h) { const key = `${i}|${h}`; if (C.bc.has(key)) return C.bc.get(key); const xs = [];
  for (const sym of C.uni.get(C.S[i].slice(0, 7)) || []) { const m = C.bar.get(sym); const a = m.get(i), b = m.get(i + h - 1); if (!a || !b) continue; let ok = true; for (let k = i + 1; k <= i + h - 1; k += 1) if (!m.get(k)) ok = false; if (ok) xs.push(b.c / a.o - 1); }
  const v = xs.length >= 30 ? mean(xs) : null; C.bc.set(key, v); return v; }
function bookValue(C, t) { const L = [], Sh = []; for (const g of t.legs) { const f = legFill(C, g.sym, t.i, t.h); if (!f) continue; (g.side > 0 ? L : Sh).push(finish(g.side, f.e, f.x, f.d, f.xd)); }
  if (!L.length && !Sh.length) return null; if (t.longShort && (!L.length || !Sh.length)) return null; const net = t.longShort ? (mean(L) + mean(Sh)) / 2 : mean([...L, ...Sh]);
  if (!t.excess) return net; const B = bench(C, t.i, t.h); return B === null ? null : net - t.legs[0].side * B; }

// ---------- members ----------
function books(P, C, Z) {
  const S = C.S, T = new Map(MEMBERS.map((m) => [m, []])), add = (m, b) => T.get(m).push(b), inSample = (i) => i < S.length && S[i] >= P.from && S[i] <= P.to;
  const tenth = (n) => Math.floor(n / 10), sorted = (xs) => xs.sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1)), syms = (xs) => xs.map((x) => x[0]);
  const ls = (lo, hi, i, h) => ({ legs: [...lo.map((sym) => ({ sym, side: 1 })), ...hi.map((sym) => ({ sym, side: -1 }))], i, h, longShort: true });
  const one = (ss, side, i, h) => ({ legs: ss.map((sym) => ({ sym, side })), i, h, excess: true });
  for (const f of [...Z.lastOfWeek].sort((a, b) => a - b)) { const i = f + 1; if (!inSample(i)) continue; let e = i; while (e + 1 < S.length && Z.wk[e + 1] === Z.wk[i]) e += 1; const h = e - i + 1;
    const U = new Set(C.uni.get(S[i].slice(0, 7)) || []), sg = Z.sig.get(f) || new Map();
    const sm = sorted([...sg].filter(([s, v]) => U.has(s) && v.smirk !== null).map(([s, v]) => [s, v.smirk]));
    if (sm.length >= 50) { const k = tenth(sm.length); add(MEMBERS[0], ls(syms(sm.slice(0, k)), syms(sm.slice(-k)), i, h)); add(MEMBERS[1], one(syms(sm.slice(-k)), -1, i, h)); }
    const cp = sorted([...sg].filter(([s, v]) => U.has(s) && v.cps !== null).map(([s, v]) => [s, v.cps]));
    if (cp.length >= 50) { const k = tenth(cp.length); add(MEMBERS[2], ls(syms(cp.slice(-k)), syms(cp.slice(0, k)), i, h)); add(MEMBERS[3], one(syms(cp.slice(-k)), 1, i, h)); }
    let a = f; while (a - 1 >= 0 && Z.wk[a - 1] === Z.wk[f]) a -= 1; const ov = [];
    for (const s of U) { let o = 0, fu = 0; for (let q = a; q <= f; q += 1) { o += (Z.optC.get(q) && Z.optC.get(q).get(s)) || 0; fu += (Z.futC.get(q) && Z.futC.get(q).get(s)) || 0; } if (fu > 0) ov.push([s, o / fu]); }
    const of = sorted(ov); if (of.length >= 50) { const k = tenth(of.length); add(MEMBERS[5], ls(syms(of.slice(0, k)), syms(of.slice(-k)), i, h)); }
    const both = [...sg].filter(([s, v]) => U.has(s) && v.smirk !== null && v.cps !== null);
    if (both.length >= 50) { const z = (xs) => { const m = mean(xs), s = sdv(xs) || 1; return xs.map((x) => (x - m) / s); }; const za = z(both.map(([, v]) => -v.smirk)), zb = z(both.map(([, v]) => v.cps));
      const cm = sorted(both.map(([s], q) => [s, (za[q] + zb[q]) / 2])); const k = tenth(cm.length); add(MEMBERS[7], ls(syms(cm.slice(-k)), syms(cm.slice(0, k)), i, h)); } }
  const me = [...Z.lastOfMonth].sort((a, b) => a - b);
  for (let q = 1; q < me.length; q += 1) { const f = me[q], fp = me[q - 1], i = f + 1; if (!inSample(i)) continue; let e = i; while (e + 1 < S.length && S[e + 1].slice(0, 7) === S[i].slice(0, 7)) e += 1; const h = e - i + 1;
    const U = new Set(C.uni.get(S[i].slice(0, 7)) || []), sg = Z.sig.get(f) || new Map(), sp = Z.sig.get(fp) || new Map();
    const dv = sorted([...sg].filter(([s, v]) => U.has(s) && v.ivc1 !== null && v.ivp1 !== null && sp.get(s) && sp.get(s).ivc1 !== null && sp.get(s).ivp1 !== null).map(([s, v]) => [s, (v.ivc1 - sp.get(s).ivc1) - (v.ivp1 - sp.get(s).ivp1)]));
    if (dv.length >= 50) { const k = tenth(dv.length); add(MEMBERS[4], ls(syms(dv.slice(-k)), syms(dv.slice(0, k)), i, h)); }
    const rv = []; for (const [s, v] of sg) { if (!U.has(s) || v.ivatm === null) continue; const m = C.bar.get(s); if (!m) continue; const rs = [];
      for (let t = f - 20; t <= f; t += 1) { const x = m.get(t - 1), y = m.get(t); if (x && y) rs.push(Math.log(y.c / x.c)); } if (rs.length >= 15) rv.push([s, sdv(rs) * Math.sqrt(252) - v.ivatm]); }
    const rr = sorted(rv); if (rr.length >= 50) { const k = tenth(rr.length); add(MEMBERS[6], ls(syms(rr.slice(0, k)), syms(rr.slice(-k)), i, h)); } }
  return T;
}

// ---------- scoring (as the night lab) ----------
function nwT(x, lag = 3) { const n = x.length, m = mean(x); const e = x.map((v) => v - m); let s = e.reduce((a, v) => a + v * v, 0) / n;
  for (let L = 1; L <= lag; L += 1) { let g = 0; for (let i = L; i < n; i += 1) g += e[i] * e[i - L]; s += 2 * (1 - L / (lag + 1)) * (g / n); } return m / Math.sqrt(s / n); }
function score(C, T) {
  const rows = MEMBERS.map((name) => { const month = new Map(); let n = 0, won = 0, legs = 0;
    for (const t of T.get(name) || []) { const v = bookValue(C, t); if (v === null) continue; n += 1; legs += t.legs.length; if (v > 0) won += 1; const k = C.S[t.i].slice(0, 7); if (!month.has(k)) month.set(k, []); month.get(k).push(v * 100); }
    const s = [...month.keys()].sort().map((k) => mean(month.get(k))); if (s.length < 24) return { name, books: n, months: s.length, verdict: "NOT TESTABLE" };
    const m = mean(s), sd = sdv(s); return { name, books: n, months: s.length, perSide: +(legs / n / (name.includes("only") ? 1 : 2)).toFixed(1), win: (100 * won) / n, monthMean: m, worstMonth: Math.min(...s), t: nwT(s), sr: m / sd,
      g3: mean(s.map((v) => ((v - m) / sd) ** 3)), g4: mean(s.map((v) => ((v - m) / sd) ** 4)) }; });
  const tested = rows.filter((r) => r.verdict !== "NOT TESTABLE"); const N = tested.length;
  if (N) { for (const r of tested) r.p = 1 - Phi(r.t); let ok = true; tested.slice().sort((a, b) => a.p - b.p).forEach((r, i) => { r.holm = ok && r.p <= 0.05 / (N - i); if (!r.holm) ok = false; });
    const g = 0.5772156649, SR0 = (N > 1 ? sdv(tested.map((r) => r.sr)) : 0) * ((1 - g) * invPhi(1 - 1 / N_TRIALS) + g * invPhi(1 - 1 / (N_TRIALS * Math.E)));
    for (const r of tested) { const den = 1 - r.g3 * r.sr + ((r.g4 - 1) / 4) * r.sr ** 2; r.dsr = den > 0 ? Phi(((r.sr - SR0) * Math.sqrt(r.months - 1)) / Math.sqrt(den)) : NaN;
      r.verdict = r.monthMean > 0 && r.t >= 3 && r.holm && r.dsr >= 0.95 ? "PASS" : r.monthMean > 0 && r.t >= 2 ? "PROMISING" : "FAIL"; } }
  return rows;
}
const sgn = (x, d = 3) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}`;
const fmt = (r, judged = true) => r.verdict === "NOT TESTABLE" ? `${r.name.padEnd(31)} NOT TESTABLE (${r.months} months, ${r.books} books)`
  : `${r.name.padEnd(31)} ${String(r.books).padStart(5)} books | ${String(r.perSide).padStart(4)} a side | ${String(r.months).padStart(3)} months | ${sgn(r.monthMean)}% a month | won ${r.win.toFixed(0)}% | worst month ${sgn(r.worstMonth, 2)}% | t ${r.t.toFixed(2)}`
    + (judged ? ` | Holm ${r.holm ? "y" : "n"} | DSR ${Number.isFinite(r.dsr) ? r.dsr.toFixed(2) : "-"} -> ${r.verdict}` : "");

// ---------- checks ----------
function check61(log) { let worst = 0, n = 0;
  for (const type of ["CE", "PE"]) for (const s of [0.15, 0.3, 0.5, 0.8]) for (const m of [0.8, 0.9, 0.95, 1, 1.05, 1.1, 1.2]) for (const dd of [7, 15, 30, 60]) {
    const F = 1000, K = F * m, T = dd / 365, p = b76(type, F, K, T, s); if (p - Math.exp(-RATE * T) * Math.max(0, type === "CE" ? F - K : K - F) < 0.05) continue;   // under one NSE tick of time value carries no volatility
    const v = impliedVol(type, p, F, K, T); n += 1; worst = Math.max(worst, v === null ? 1 : Math.abs(v - s)); }
  const ok = worst < 1e-4; log(` 6.1 implied volatility: ${n} Black-76 prices with at least one tick (0.05) of time value solved back, worst error ${worst.toExponential(1)}: ${ok ? "PASSED" : "FAILED"}`); return ok; }
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), 1 | t); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function synth(seed) {   // 150 stocks, 900 sessions; option chains on formation days from a stock's smirk; the steepest tenth loses 1% the next week
  const r = rng(seed), g = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
  const S = []; for (let t = Date.parse("2008-01-01"); S.length < 900; t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) S.push(d.toISOString().slice(0, 10)); }
  const wk = S.map(isoWeek), NS = 150, px = Array(NS).fill(0).map((_, k) => 100 + k), bars = Array.from({ length: NS }, () => []), smirk = new Map(); let losers = new Set();
  const expiries = []; for (let i = 0; i < S.length; i += 1) if (i === S.length - 1 || S[i + 1].slice(0, 7) !== S[i].slice(0, 7)) expiries.push(S[i]);
  for (let y = 0; y < 3; y += 1) { const last = new Date(`${expiries[expiries.length - 1]}T00:00:00Z`); last.setUTCDate(last.getUTCDate() + 30); expiries.push(last.toISOString().slice(0, 10)); }
  for (let i = 0; i < S.length; i += 1) {
    if (i > 0 && wk[i] !== wk[i - 1]) { let e = i; while (e + 1 < S.length && wk[e + 1] === wk[i]) e += 1; }
    for (let k = 0; k < NS; k += 1) { const drift = losers.has(k) ? -0.01 / 5 : 0; const o = px[k] * (1 + 0.003 * g()), c = o * (1 + drift + 0.015 * g());
      bars[k].push({ d: S[i], o, h: Math.max(o, c) * 1.004, l: Math.min(o, c) * 0.996, c, v: 1e5, val: 1e9 - k }); px[k] = c; }
    if (i === S.length - 1 || wk[i + 1] !== wk[i]) { const s = Array.from({ length: NS }, () => 0.2 * r()); smirk.set(i, s); losers = new Set(s.map((v, k) => [k, v]).sort((a, b) => b[1] - a[1]).slice(0, 15).map((x) => x[0])); } }
  const F = (k, i, E) => bars[k][i].c * Math.exp(RATE * (Date.parse(E) - Date.parse(S[i])) / 864e5 / 365);
  const P = { name: "synthetic", sessions: S, stocks: bars.map((b, k) => ({ sym: `S${k}`, bars: b })), from: S[300], to: S[S.length - 1] };
  const idx = new Map(S.map((d, i) => [d, i])); const near = (d) => expiries.filter((e) => e >= d).slice(0, 2);
  P.futRows = (d) => { const i = idx.get(d); const out = []; for (let k = 0; k < NS; k += 1) for (const E of near(d)) out.push([`S${k}`, "STK", E, 0, 0, 0, F(k, i, E), 0, 1000, 0, 100]); return out; };
  P.optRows = (d) => { const i = idx.get(d), s = smirk.get(i); if (!s) return []; const out = [];
    for (let k = 0; k < NS; k += 1) { const E = near(d).find((e) => (Date.parse(e) - Date.parse(d)) / 864e5 >= 7); const f = F(k, i, E), T = (Date.parse(E) - Date.parse(d)) / 864e5 / 365;
      for (let m = 0.88; m <= 1.121; m += 0.01) { const K = +(f * m).toFixed(2), vol = 0.3 + s[k] * Math.min(1, Math.max(0, 1 - K / f) / 0.05);   // flat below 95%: the smirk does not depend on which listed strike is nearest
        for (const type of ["CE", "PE"]) { const p = b76(type, f, K, T, vol); if (p >= 0.05) out.push([`S${k}`, E, K, type, +p.toFixed(4), +p.toFixed(4), 100, 10]); } } }
    return out; };
  return P;
}
function check62(log) { const P = synth(62), C = context(P), Z = computeSignals(P, "0000"), r = score(C, books(P, C, Z)).find((x) => x.name === MEMBERS[0]); const ok = !!r && r.verdict !== "NOT TESTABLE" && r.t >= 3;
  log(` 6.2 planted smirk edge (steepest tenth -1% the next week): O1 ${r && r.verdict !== "NOT TESTABLE" ? `t ${r.t.toFixed(2)}, ${sgn(r.monthMean)}% a month` : "not testable"}: ${ok ? "PASSED" : "FAILED"}`); return ok; }
function check63(C, T, log) { const r = rng(63); const lo = Math.max(0, C.S.findIndex((d) => d >= DISC[0])), hi = C.S.length - 25; const R = new Map();
  for (const [m, ts] of T) R.set(m, ts.map((t) => ({ ...t, i: lo + 2 + Math.floor(r() * (hi - lo - 2)) })));
  const rows = score(C, R), passes = rows.filter((x) => x.verdict === "PASS").length;
  log(` 6.3 re-dated null on the discovery data: ${passes} PASS of ${rows.filter((x) => x.verdict !== "NOT TESTABLE").length} (at most 1 allowed): ${passes <= 1 ? "PASSED" : "FAILED"}`); return passes <= 1; }

if (require.main === module) {
  const lines = [], log = (x) => { lines.push(x); console.log(x); };
  const refuse = (why) => { fs.appendFileSync(path.join(HERE, "RESULT.txt"), lines.join("\n") + `\n${why}: real run refused.\n\n`); process.exit(1); };
  const checksOnly = process.argv.includes("--checks");
  log(`OPTIONS LAB${checksOnly ? " (checks only)" : ""}: registration sha256 ${SHA.slice(0, 16)}... (verified); run ${new Date().toISOString()}`);
  log("CHECKS:"); if (!check61(log)) refuse("CHECK 6.1 FAILED"); if (!check62(log)) refuse("CHECK 6.2 FAILED");
  const oos = path.resolve(process.env.K2_OOS_NSE || "nse-old"), R = path.resolve(process.env.K2_RESEARCH_DIR || path.join(ROOT, "research"));
  for (const d of [path.join(oos, "cm"), path.join(oos, "fut"), path.join(oos, "sopt"), path.join(R, "rising-stocks-2026-10-02", "nse-data", "cm"), path.join(R, "orderflow-2026-10-03", "nse-fo", "fut"), path.join(R, "options-2026-10-04", "nse-sopt")])
    if (!fs.existsSync(d) || !fs.readdirSync(d).length) { console.error(`MISSING INPUT ${d}: nothing computed.`); process.exit(3); }
  const run = (name) => { const P = period(name), C = context(P), Z = computeSignals(P, name === "discovery" ? "0000" : "2020-08-01"), T = books(P, C, Z);
    log(`${name.toUpperCase()} DATA: ${P.sessions.length} sessions ${P.sessions[0]} .. ${P.sessions.at(-1)}, ${P.stocks.length} stocks; implied volatilities on ${Z.ivDays} formation days`);
    log(" books: " + MEMBERS.map((m) => `${m.split(" ")[0]} ${T.get(m).length}`).join(", ")); return { C, T }; };
  const D = run("discovery"); if (!check63(D.C, D.T, log)) refuse("CHECK 6.3 FAILED");
  if (checksOnly) { console.log("checks only: nothing scored, nothing written"); process.exit(0); }
  const rd = score(D.C, D.T); D.C = null; D.T = null; const F = run("confirmation"); const rf = score(F.C, F.T);   // both computed before anything is shown
  log(`\nDISCOVERY ${DISC[0]} .. ${DISC[1]} (monthly mean %, net of charges; O2, O4 = excess over the universe; Holm across ${rd.filter((r) => r.verdict !== "NOT TESTABLE").length}; DSR with N = ${N_TRIALS}):`);
  for (const r of rd) log(" " + fmt(r)); const cand = rd.filter((r) => r.verdict === "PASS").map((r) => r.name);
  log(`DISCOVERY PASS: ${cand.join(", ") || "none"}. PROMISING: ${rd.filter((r) => r.verdict === "PROMISING").map((r) => r.name).join(", ") || "none"}.`);
  log(`\nCONFIRMATION ${CONF[0]} .. ${CONF[1]} (every member reported; a discovery PASS is CONFIRMED with mean > 0 and t >= 2):`);
  for (const r of rf) log(" " + fmt(r, false) + (cand.includes(r.name) ? (r.monthMean > 0 && r.t >= 2 ? "  -> CONFIRMED" : "  -> NOT CONFIRMED") : ""));
  const conf = rf.filter((r) => cand.includes(r.name) && r.monthMean > 0 && r.t >= 2).map((r) => r.name);
  log(`\nCANDIDATES (discovery PASS and confirmed): ${conf.join(", ") || "none"}. A candidate goes to TRACK as a forward paper test first, never straight to FUTURES.`);
  fs.appendFileSync(path.join(HERE, "RESULT.txt"), lines.join("\n") + "\n\n");
  const strip = (rs) => rs.map(({ g3, g4, sr, p, ...r }) => r); fs.writeFileSync(path.join(HERE, "result.json"), JSON.stringify({ registration: SHA, discovery: strip(rd), confirmation: strip(rf), candidates: conf }, null, 1));
}
module.exports = { MEMBERS, b76, impliedVol, stockIv, computeSignals, context, books, score, synth, isoWeek };
