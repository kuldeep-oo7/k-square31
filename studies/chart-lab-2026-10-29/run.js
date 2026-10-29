"use strict";
// Implements ./PREREGISTRATION.txt (sha256 in ./PREREGISTRATION.sha256): the chart lab, one batch, one run.
//   node run.js --checks        checks 6.1 and 6.2 (synthetic, no market data)
//   node run.js --real          6.1, 6.2, then discovery (6.5 counts, 6.4, 6.3), confirmation, and the one real scoring
//                               (RESULT.txt, result.json: summary rows only)
// Data (private, never committed), as the futures lab: K2_OOS_NSE = data-oos nse-old/ (cm/, fut/, idx/); K2_RESEARCH_DIR =
// a research/ tree (rising-stocks-2026-10-02/nse-data/cm, orderflow-2026-10-03/nse-fo/fut); K2_MACRO_IC = ind_close_all/.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const ROOT = path.resolve(__dirname, "..", "..");
const HERE = __dirname;
const SHA = fs.readFileSync(path.join(HERE, "PREREGISTRATION.sha256"), "utf8").split(/\s+/)[0];
if (crypto.createHash("sha256").update(fs.readFileSync(path.join(HERE, "PREREGISTRATION.txt"), "utf8").replace(/\r\n/g, "\n")).digest("hex") !== SHA) { console.error("PRE-REGISTRATION CHANGED; result void."); process.exit(2); }
const { calculateNseFuturesCharges } = require(path.join(ROOT, "api/_lib/shadow-broker"));

const NOTIONAL = 500000, RESET = 0.18, N_TRIALS = 430, VALID = 260, CAP = 20, FIX = 5, LO_R = 0.82, HI_R = 1.22;
const DISC = ["2005-01-01", "2020-10-31"], CONF = ["2020-10-01", "2026-10-01"], SPLIT = "2020-09-01", HALF = "2013-01-01";
const MEMBERS = [
  ["A1", "A1 leader breakout", 1, "TRAIL"], ["A2", "A2 laggard breakdown", -1, "TRAIL"],
  ["B1", "B1 gap-and-hold up", 1, "TRAIL"], ["B2", "B2 gap-and-hold down", -1, "TRAIL"],
  ["C1", "C1 capitulation bounce", 1, "FIX5"], ["C2", "C2 parabolic fade", -1, "FIX5"],
  ["D1", "D1 holy grail up", 1, "TRAIL"], ["D2", "D2 holy grail down", -1, "TRAIL"],
  ["E1", "E1 turtle soup+1 long", 1, "FIX5"], ["E2", "E2 turtle soup+1 short", -1, "FIX5"],
  ["F1", "F1 bull candle at 50d", 1, "FIX5"], ["F2", "F2 bear candle at 50d", -1, "FIX5"],
  ["G1", "G1 tight inside day up", 1, "TRAIL"], ["G2", "G2 tight inside day down", -1, "TRAIL"],
].map(([id, name, side, exit]) => ({ id, name, side, exit }));
const charge = (side, price, qty, d) => calculateNseFuturesCharges({ side, price, quantity: qty, asOfDate: `${d}T12:00:00Z` }).totalCharges;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

// ---------- data: the futures lab's loaders, unchanged ----------
const jsonDays = (dir, from, to) => fs.readdirSync(dir).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x) && x.slice(0, 10) >= from && x.slice(0, 10) <= to).sort();
function readCm(dir, from, to, P) {
  for (const f of jsonDays(dir, from, to)) { const d = f.slice(0, 10); P.sessions.push(d);
    for (const [, sym, series, o, h, l, c, , v, val] of JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))) {
      if (series !== "EQ" || !sym || ![o, h, l, c].every((x) => x > 0)) continue;
      if (!P.bySym.has(sym)) P.bySym.set(sym, { sym, bars: [] }); P.bySym.get(sym).bars.push({ d, o, h, l, c, v: +v || 0, val }); } }
}
function readFut(dir, from, to, P) {
  for (const f of jsonDays(dir, from, to)) { const d = f.slice(0, 10); const exps = new Set(), near = new Map(), fcs = new Map();
    for (const r of JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))) {
      if (r[1] !== "STK" || !(r[2] >= d)) continue; exps.add(r[2]); const o = Number(r[3]), c = Number(r[6]);   // Number(null) is 0: never a price
      if (c > 0) { if (!fcs.has(r[0])) fcs.set(r[0], []); fcs.get(r[0]).push([r[2], c]); }
      if (o > 0 && c > 0 && (!near.has(r[0]) || r[2] < near.get(r[0]).e)) near.set(r[0], { e: r[2], o, c }); }
    for (const [sym, v] of near) { if (!P.fnear.has(sym)) P.fnear.set(sym, new Map()); P.fnear.get(sym).set(d, v); }
    for (const [sym, list] of fcs) { if (!P.fc.has(sym)) P.fc.set(sym, new Map()); const m = P.fc.get(sym); for (const [e, c] of list.sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(0, 3)) { if (!m.has(e)) m.set(e, new Map()); m.get(e).set(d, c); } } }
}
function readIdxJson(dir, P) { if (!fs.existsSync(dir)) return;
  for (const f of jsonDays(dir, "0000", "9999")) { const v = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))["Nifty 50"]; if (Array.isArray(v) && v[3] > 0) P.idx.set(f.slice(0, 10), { o: v[0] > 0 ? v[0] : null, c: v[3] }); } }
const NIFTY_RE = /^(nifty 50|cnx nifty|s&p cnx nifty)$/i;
function readIdxCsv(dir, P) { if (!dir || !fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir).filter((x) => /^\d{4}-\d{2}-\d{2}\.csv$/.test(x))) { const t = fs.readFileSync(path.join(dir, f), "utf8").split(/\r?\n/).map((l) => l.split(",").map((x) => x.replace(/"/g, "").trim()));
    const io = (t[0] || []).findIndex((x) => /Open Index Value/i.test(x)), ic = (t[0] || []).findIndex((x) => /Closing Index Value/i.test(x)); const r = t.find((x) => NIFTY_RE.test(x[0] || ""));
    if (ic >= 0 && r && +r[ic] > 0) P.idx.set(f.slice(0, 10), { o: io >= 0 && +r[io] > 0 ? +r[io] : null, c: +r[ic] }); } }
function period(name) {
  const oos = path.resolve(process.env.K2_OOS_NSE || "nse-old"), R = path.resolve(process.env.K2_RESEARCH_DIR || path.join(ROOT, "research"));
  const P = { name, sessions: [], bySym: new Map(), fnear: new Map(), fc: new Map(), idx: new Map() };
  if (name === "discovery") { readCm(path.join(oos, "cm"), DISC[0], DISC[1], P); readFut(path.join(oos, "fut"), DISC[0], DISC[1], P); readIdxJson(path.join(oos, "idx"), P); Object.assign(P, { from: DISC[0], to: DISC[1] }); }
  else { const pre = new Date(Date.parse(SPLIT) - 864e5).toISOString().slice(0, 10);
    readCm(path.join(oos, "cm"), "0000", pre, P); readCm(path.join(R, "rising-stocks-2026-10-02", "nse-data", "cm"), SPLIT, CONF[1], P);
    readFut(path.join(oos, "fut"), "0000", pre, P); readFut(path.join(R, "orderflow-2026-10-03", "nse-fo", "fut"), SPLIT, CONF[1], P);
    readIdxJson(path.join(oos, "idx"), P); readIdxCsv(process.env.K2_MACRO_IC, P); Object.assign(P, { from: CONF[0], to: CONF[1] }); }
  P.stocks = [...P.bySym.values()]; delete P.bySym; return P;
}

// ---------- the futures lab's universe (top 200 by median traded value, >= 250 bars since the last reset) ----------
function context(P) {
  const S = P.sessions, sIdx = new Map(S.map((d, i) => [d, i]));
  const firstOf = new Map(); S.forEach((d, i) => { if (!firstOf.has(d.slice(0, 7))) firstOf.set(d.slice(0, 7), i); });
  const months = [...firstOf.keys()], ranked = new Map(months.map((m) => [m, []]));
  for (const st of P.stocks) { const b = st.bars; let k = 0, lc = 0;
    for (const m of months) { const fd = S[firstOf.get(m)]; while (k < b.length && b[k].d < fd) { if (k > 0 && Math.abs(b[k].o / b[k - 1].c - 1) >= RESET) lc = k; k += 1; }
      if (k - lc < 250) continue; const v = b.slice(k - 60, k).map((x) => x.val).filter((x) => x > 0).sort((a, c) => a - c); if (v.length) ranked.get(m).push([st.sym, v[Math.floor(v.length / 2)]]); } }
  const uni = new Map(); for (const [m, r] of ranked) { r.sort((a, c) => c[1] - a[1]); uni.set(m, r.slice(0, 200).map((x) => x[0])); }
  return { S, sIdx, uni, uniSet: new Map([...uni].map(([m, l]) => [m, new Set(l)])), bo: new Map(), bc: new Map(), rs: new Map() };
}

// ---------- indicators on one stock's own bars (every value at j reads bars 0..j only) ----------
function rollExt(a, n, isMax) { const out = new Float64Array(a.length).fill(NaN), q = []; let h = 0;
  for (let j = 0; j < a.length; j += 1) { while (q.length > h && (isMax ? a[q[q.length - 1]] <= a[j] : a[q[q.length - 1]] >= a[j])) q.pop(); q.push(j); if (q[h] <= j - n) h += 1; if (j >= n - 1) out[j] = a[q[h]]; }
  return out; }
function indicators(bars) {
  const n = bars.length, f = (k) => Float64Array.from(bars, (b) => b[k]); const o = f("o"), h = f("h"), l = f("l"), c = f("c"), v = f("v");
  const reset = new Int32Array(n); for (let j = 1; j < n; j += 1) reset[j] = Math.abs(o[j] / c[j - 1] - 1) >= RESET ? j : reset[j - 1];
  const pc = new Float64Array(n + 1), pv = new Float64Array(n + 1); for (let j = 0; j < n; j += 1) { pc[j + 1] = pc[j] + c[j]; pv[j + 1] = pv[j] + v[j]; }
  const sma = (w) => { const a = new Float64Array(n).fill(NaN); for (let j = w - 1; j < n; j += 1) a[j] = (pc[j + 1] - pc[j + 1 - w]) / w; return a; };
  const vol50 = new Float64Array(n).fill(NaN); for (let j = 50; j < n; j += 1) vol50[j] = (pv[j] - pv[j - 50]) / 50;
  const ema = new Float64Array(n); for (let j = 0; j < n; j += 1) ema[j] = j === 0 ? c[0] : ema[j - 1] + (2 / 21) * (c[j] - ema[j - 1]);
  const atr = new Float64Array(n).fill(NaN), pdi = new Float64Array(n).fill(NaN), mdi = new Float64Array(n).fill(NaN), adx = new Float64Array(n).fill(NaN);
  let tA = 0, sT = 0, sP = 0, sM = 0, dxSum = 0, a = NaN, x = NaN;
  for (let j = 0; j < n; j += 1) {
    const tr = j === 0 ? h[0] - l[0] : Math.max(h[j] - l[j], Math.abs(h[j] - c[j - 1]), Math.abs(l[j] - c[j - 1]));
    if (j < 14) { tA += tr; if (j === 13) a = tA / 14; } else a = (a * 13 + tr) / 14; if (j >= 13) atr[j] = a;
    if (j === 0) continue; const up = h[j] - h[j - 1], dn = l[j - 1] - l[j], p = up > dn && up > 0 ? up : 0, m = dn > up && dn > 0 ? dn : 0;
    if (j <= 14) { sT += tr; sP += p; sM += m; if (j < 14) continue; } else { sT = sT - sT / 14 + tr; sP = sP - sP / 14 + p; sM = sM - sM / 14 + m; }
    const P1 = sT > 0 ? (100 * sP) / sT : 0, M1 = sT > 0 ? (100 * sM) / sT : 0, dx = P1 + M1 > 0 ? (100 * Math.abs(P1 - M1)) / (P1 + M1) : 0; pdi[j] = P1; mdi[j] = M1;
    if (j < 27) { dxSum += dx; continue; } if (j === 27) x = (dxSum + dx) / 14; else x = (x * 13 + dx) / 14; adx[j] = x; }
  return { n, o, h, l, c, v, reset, s10: sma(10), s20: sma(20), s50: sma(50), s150: sma(150), s200: sma(200), vol50, ema, atr, pdi, mdi, adx, hi250: rollExt(h, 250, true), lo250: rollExt(l, 250, false) };
}
function soup(x, c, k, side) {   // E1 (side +1, x = lows) and E2 (side -1, x = highs): Turtle Soup plus one, signal on k
  if (k < 22) return false; let ext = x[k - 2], at = k - 2;
  for (let q = k - 2; q >= k - 21; q -= 1) if (side > 0 ? x[q] < ext : x[q] > ext) { ext = x[q]; at = q; }
  for (let q = k - 2; q >= k - 21; q -= 1) if (x[q] === ext) { at = q; break; }   // the latest bar that reached it
  if (k - 1 - at < 4) return false;
  return side > 0 ? x[k - 1] < ext && c[k - 1] <= ext && c[k] > ext : x[k - 1] > ext && c[k - 1] >= ext && c[k] < ext;
}
function detect(I, k, rsAt, reg) {   // the 14 members' signals on bar k; rsAt() = RS percentile or null; reg = +1 UP, -1 DOWN, 0
  const out = []; if (k < VALID || k - I.reset[k] < VALID) return out;
  const { o, h, l, c, v } = I, O = o[k], H = h[k], L = l[k], C = c[k], R = H - L, s50 = I.s50[k], s150 = I.s150[k], s200 = I.s200[k];
  let hh = -Infinity, ll = Infinity; for (let q = k - 20; q <= k - 1; q += 1) { if (h[q] > hh) hh = h[q]; if (l[q] < ll) ll = l[q]; }
  const base = hh - ll <= 0.15 * c[k - 1], vr = I.vol50[k] > 0 ? v[k] / I.vol50[k] : NaN;
  if (reg === 1 && base && C > hh && vr >= 1.5 && C > s50 && s50 > s150 && s150 > s200 && s200 > I.s200[k - 21] && C >= 1.3 * I.lo250[k] && C >= 0.75 * I.hi250[k]) { const rs = rsAt(); if (rs !== null && rs >= 70) out.push("A1"); }
  if (reg === -1 && base && C < ll && vr >= 1.5 && C < s50 && s50 < s150 && s150 < s200 && s200 < I.s200[k - 21] && C <= 0.7 * I.hi250[k] && C <= 1.25 * I.lo250[k]) { const rs = rsAt(); if (rs !== null && rs <= 30) out.push("A2"); }
  const g = O / c[k - 1] - 1;
  if (reg === 1 && g >= 0.04 && g < 0.18 && vr >= 3 && C >= O && R > 0 && (C - L) / R >= 0.5) out.push("B1");
  if (reg === -1 && g <= -0.04 && g > -0.18 && vr >= 3 && C <= O && R > 0 && (H - C) / R >= 0.5) out.push("B2");
  const r10 = c[k - 1] / c[k - 11] - 1; let up = 0, dn = 0; for (let q = k - 5; q <= k - 1; q += 1) { if (c[q] > c[q - 1]) up += 1; else if (c[q] < c[q - 1]) dn += 1; }
  if (r10 <= -0.2 && dn >= 4 && C > O && C > c[k - 1]) out.push("C1");
  if (r10 >= 0.2 && up >= 4 && C < O && C < c[k - 1]) out.push("C2");
  if (I.adx[k - 1] >= 30 && I.pdi[k - 1] > I.mdi[k - 1] && l[k - 1] <= I.ema[k - 1] && C > h[k - 1]) out.push("D1");
  if (I.adx[k - 1] >= 30 && I.mdi[k - 1] > I.pdi[k - 1] && h[k - 1] >= I.ema[k - 1] && C < l[k - 1]) out.push("D2");
  if (soup(l, c, k, 1)) out.push("E1");
  if (soup(h, c, k, -1)) out.push("E2");
  const atr = I.atr[k], body = Math.abs(C - O), lower = Math.min(O, C) - L, upper = H - Math.max(O, C);
  const bullE = c[k - 1] < o[k - 1] && C > O && O <= c[k - 1] && C >= o[k - 1] && C - O > o[k - 1] - c[k - 1];
  const bearE = c[k - 1] > o[k - 1] && C < O && O >= c[k - 1] && C <= o[k - 1] && O - C > c[k - 1] - o[k - 1];
  const hammer = R > 0 && body <= 0.35 * R && lower >= 2 * body && lower >= 0.5 * R && upper <= 0.15 * R;
  const star = R > 0 && body <= 0.35 * R && upper >= 2 * body && upper >= 0.5 * R && lower <= 0.15 * R;
  if (s50 > s200 && s50 > I.s50[k - 10] && L <= s50 + 0.5 * atr && C >= s50 - 0.5 * atr && (bullE || hammer)) out.push("F1");
  if (s50 < s200 && s50 < I.s50[k - 10] && H >= s50 - 0.5 * atr && C <= s50 + 0.5 * atr && (bearE || star)) out.push("F2");
  const tight = H <= h[k - 1] && L >= l[k - 1] && R < h[k - 1] - l[k - 1] && R < h[k - 2] - l[k - 2] && R < h[k - 3] - l[k - 3];
  if (tight && reg === 1 && C > s50 && s50 > s200) out.push("G1");
  if (tight && reg === -1 && C < s50 && s50 < s200) out.push("G2");
  return out;
}

// ---------- NIFTY regime, RS ----------
function niftyRegime(P, S, upTo = Infinity) {   // reg[s] = +1 UP, -1 DOWN, 0; reads NIFTY closes of sessions <= s only
  const reg = new Int8Array(S.length), xs = [];
  for (let s = 0; s < S.length && s <= upTo; s += 1) { const ix = P.idx.get(S[s]); if (!ix || !(ix.c > 0)) continue; xs.push(ix.c); const n = xs.length; if (n < 25) continue;
    const sm = (w, end) => { let t = 0; for (let q = end - w; q < end; q += 1) t += xs[q]; return t / w; };
    const a10 = sm(10, n), a20 = sm(20, n), a20p = sm(20, n - 5); reg[s] = a10 > a20 && a20 > a20p ? 1 : a10 < a20 && a20 < a20p ? -1 : 0; }
  return reg;
}
function rsPct(C, ST, s) {   // percentile of the 126-bar return among the month's universe on session s
  if (C.rs.has(s)) return C.rs.get(s); const xs = [];
  for (const sym of C.uni.get(C.S[s].slice(0, 7)) || []) { const t = ST.get(sym); if (!t) continue; const j = t.sj.get(s); if (j === undefined || j < 126 || j - t.I.reset[j] < 126) continue; xs.push([sym, t.I.c[j] / t.I.c[j - 126] - 1]); }
  xs.sort((a, b) => a[1] - b[1]); const m = new Map(), n = xs.length;
  for (let a = 0; a < n;) { let b = a; while (b + 1 < n && xs[b + 1][1] === xs[a][1]) b += 1; const r = (a + b) / 2; for (let q = a; q <= b; q += 1) m.set(xs[q][0], n > 1 ? (100 * r) / (n - 1) : 50); a = b + 1; }
  C.rs.set(s, m); return m;
}

// ---------- futures prices and the market chain ----------
function futTrade(P, S, sym, i, h, side) {   // the futures lab's futHold, plus the -18%/+22% close-to-close guard
  const fn = P.fnear.get(sym), n0 = fn && fn.get(S[i]); if (!n0) return null; const fc = P.fc.get(sym); if (!fc) return null;
  let e = n0.e, px = n0.o, prev = n0.o, value = 1; const q = Math.ceil(NOTIONAL / n0.o); let cost = charge(side > 0 ? "BUY" : "SELL", n0.o, q, S[i]);
  for (let k = i; k <= i + h - 1; k += 1) { if (k >= S.length) return null; const d = S[k]; const c = fc.get(e) && fc.get(e).get(d); if (!(c > 0)) return null;
    if (c / prev < LO_R || c / prev > HI_R) return null; prev = c;
    if (k === i + h - 1) { value *= c / px; cost += charge(side > 0 ? "SELL" : "BUY", c, q, d); break; }
    if (d >= e) { const e2 = [...fc.keys()].filter((y) => y > e && fc.get(y).has(d)).sort()[0]; if (!e2) return null; const c2 = fc.get(e2).get(d);
      value *= c / px; cost += charge(side > 0 ? "SELL" : "BUY", c, q, d) + charge(side > 0 ? "BUY" : "SELL", c2, q, d); e = e2; px = c2; prev = c2; } }
  return { net: side * (value - 1) - cost / (n0.o * q) };
}
function bOpen(P, C, s) { if (C.bo.has(s)) return C.bo.get(s); const xs = [];
  for (const sym of C.uni.get(C.S[s].slice(0, 7)) || []) { const f = P.fnear.get(sym) && P.fnear.get(sym).get(C.S[s]); if (f) xs.push(f.c / f.o - 1); }
  const v = xs.length >= 30 ? mean(xs) : null; C.bo.set(s, v); return v; }
function bClose(P, C, s) { if (C.bc.has(s)) return C.bc.get(s); const xs = [], d0 = C.S[s - 1], d1 = C.S[s];
  for (const sym of C.uni.get(d1.slice(0, 7)) || []) { const f = P.fnear.get(sym) && P.fnear.get(sym).get(d0), fc = P.fc.get(sym); if (!f || !fc) continue; let e = f.e;
    if (d0 >= e) { e = [...fc.keys()].filter((y) => y > e && fc.get(y).has(d0)).sort()[0]; if (!e) continue; }
    const a = fc.get(e) && fc.get(e).get(d0), b = fc.get(e) && fc.get(e).get(d1); if (!(a > 0 && b > 0) || b / a < LO_R || b / a > HI_R) continue; xs.push(b / a - 1); }
  const v = xs.length >= 30 ? mean(xs) : null; C.bc.set(s, v); return v; }
function market(P, C, i, h) { const a = bOpen(P, C, i); if (a === null) return null; let v = 1 + a;
  for (let t = i + 1; t <= i + h - 1; t += 1) { const b = bClose(P, C, t); if (b === null) return null; v *= 1 + b; } return v - 1; }

// ---------- signals -> trades ----------
function stocksOf(P, C) {   // the stocks that are ever in the universe of the period and have futures, with their indicators
  const want = new Set(); for (const [m, l] of C.uni) if (m >= P.from.slice(0, 7) && m <= P.to.slice(0, 7)) for (const s of l) if (P.fnear.has(s)) want.add(s);
  const ST = new Map();
  for (const st of P.stocks) { if (!want.has(st.sym)) continue; const si = Int32Array.from(st.bars, (b) => C.sIdx.get(b.d)), sj = new Map(); si.forEach((s, j) => sj.set(s, j)); ST.set(st.sym, { sym: st.sym, bars: st.bars, I: indicators(st.bars), si, sj }); }
  return ST;
}
function exitOf(t, i, m, nS) {   // the exit session for entry session i
  if (m.exit === "FIX5") return i + FIX - 1 < nS ? i + FIX - 1 : null;
  for (let s = i; s <= i + CAP - 1 && s < nS; s += 1) { const j = t.sj.get(s); if (j === undefined) continue; const c = t.I.c[j], a = t.I.s10[j]; if (!(a > 0)) continue;
    if (m.side > 0 ? c < a : c > a) return Math.min(s + 1, i + CAP - 1) < nS ? Math.min(s + 1, i + CAP - 1) : null; }
  return i + CAP - 1 < nS ? i + CAP - 1 : null;
}
function trades(P, C, ST, reg, inS) {
  const T = Object.fromEntries(MEMBERS.map((m) => [m.id, []])), N = Object.fromEntries(MEMBERS.map((m) => [m.id, { signals: 0, busy: 0, dropped: 0 }])), byId = new Map(MEMBERS.map((m) => [m.id, m]));
  for (const t of ST.values()) { const busy = new Map();
    for (let k = VALID; k < t.I.n; k += 1) { const s = t.si[k]; if (s === undefined || s + 1 >= C.S.length) continue; const i = s + 1, d = C.S[i]; if (!inS(d)) continue;
      const fired = detect(t.I, k, () => { const m = rsPct(C, ST, s); return m.has(t.sym) ? m.get(t.sym) : null; }, reg[s]); if (!fired.length) continue;
      if (!C.uniSet.get(d.slice(0, 7)) || !C.uniSet.get(d.slice(0, 7)).has(t.sym)) continue;
      for (const id of fired) { const m = byId.get(id); N[id].signals += 1; if ((busy.get(id) ?? -1) >= i) { N[id].busy += 1; continue; }
        const x = exitOf(t, i, m, C.S.length); if (x === null) { N[id].dropped += 1; continue; } const h = x - i + 1;
        let bad = false; for (let s2 = i; s2 <= x && !bad; s2 += 1) { const j = t.sj.get(s2); if (j !== undefined && t.I.reset[j] === j && j > 0) bad = true; }
        const f = bad ? null : futTrade(P, C.S, t.sym, i, h, m.side), B = f ? market(P, C, i, h) : null;
        if (!f || B === null) { N[id].dropped += 1; continue; }
        busy.set(id, x); T[id].push({ sym: t.sym, i, h, side: m.side, date: d, net: f.net, v: f.net - m.side * B }); } } }
  return { T, N };
}
function redated(P, C, T, seed) {   // check 6.3: the same trades moved to random discovery sessions
  const r = rng(seed), lo = Math.max(0, C.S.findIndex((d) => d >= DISC[0])) + 25, hi = C.S.length - 25, out = {};
  for (const [id, ts] of Object.entries(T)) { out[id] = []; for (const t of ts) { const i = lo + Math.floor(r() * (hi - lo)); const f = futTrade(P, C.S, t.sym, i, t.h, t.side); if (!f) continue;
    const B = market(P, C, i, t.h); if (B === null) continue; out[id].push({ date: C.S[i], v: f.net - t.side * B, net: f.net, h: t.h }); } }
  return out;
}
function lookahead(P, C, ST, reg, seed, log) {   // check 6.4: detectors on bars cut after day k give the same answer
  const r = rng(seed), list = [...ST.values()]; let n = 0, same = 0, fired = 0;
  for (let tries = 0; n < 3000 && tries < 300000; tries += 1) { const t = list[Math.floor(r() * list.length)], k = VALID + Math.floor(r() * Math.max(1, t.I.n - VALID)); if (k >= t.I.n) continue;
    const s = t.si[k]; if (s === undefined || C.S[s] < P.from || C.S[s] > P.to) continue; const rsv = () => { const m = rsPct(C, ST, s); return m.has(t.sym) ? m.get(t.sym) : null; };
    const full = detect(t.I, k, rsv, reg[s]).join(","), cutReg = niftyRegime(P, C.S, s), cut = detect(indicators(t.bars.slice(0, k + 1)), k, rsv, cutReg[s]).join(",");
    n += 1; if (full === cut) same += 1; if (full) fired += 1; }
  const ok = n >= 3000 && same === n; log(` 6.4 no look-ahead: ${same} of ${n} sampled (stock, day) pairs identical after cutting the bars and NIFTY at day k (${fired} with a signal): ${ok ? "PASSED" : "FAILED"}`); return ok;
}

// ---------- scoring (the futures lab's, N = 430) ----------
function nwT(x, lag = 3) { const n = x.length, m = mean(x); const e = x.map((v) => v - m); let s = e.reduce((a, v) => a + v * v, 0) / n;
  for (let L = 1; L <= lag; L += 1) { let g = 0; for (let i = L; i < n; i += 1) g += e[i] * e[i - L]; s += 2 * (1 - L / (lag + 1)) * (g / n); } return m / Math.sqrt(s / n); }
const sdv = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const Phi = (x) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
const invPhi = (p) => { let lo = -10, hi = 10; for (let i = 0; i < 100; i += 1) { const m = (lo + hi) / 2; if (Phi(m) < p) lo = m; else hi = m; } return (lo + hi) / 2; };
const monthly = (items) => { const by = new Map(); for (const x of items) { const k = x.date.slice(0, 7); if (!by.has(k)) by.set(k, []); by.get(k).push(x.v * 100); } return [...by.keys()].sort().map((k) => mean(by.get(k))); };
function score(T) {
  const out = MEMBERS.map((mb) => { const it = T[mb.id] || [], s = monthly(it);
    const extra = { name: mb.name, trades: it.length, win: it.length ? (100 * it.filter((x) => x.v > 0).length) / it.length : null, net: it.length ? 100 * mean(it.map((x) => x.net)) : null,
      exc: it.length ? 100 * mean(it.map((x) => x.v)) : null, hold: it.length ? mean(it.map((x) => x.h)) : null };
    if (s.length < 24) return { ...extra, months: s.length, verdict: "NOT TESTABLE" }; const m = mean(s), sd = sdv(s);
    return { ...extra, months: s.length, monthMean: m, worstMonth: Math.min(...s), t: nwT(s), sr: m / sd, g3: mean(s.map((v) => ((v - m) / sd) ** 3)), g4: mean(s.map((v) => ((v - m) / sd) ** 4)) }; });
  const tested = out.filter((r) => r.verdict !== "NOT TESTABLE"), N = tested.length;
  if (N) { for (const r of tested) r.p = 1 - Phi(r.t); let ok = true; tested.slice().sort((a, b) => a.p - b.p).forEach((r, i) => { r.holm = ok && r.p <= 0.05 / (N - i); if (!r.holm) ok = false; });
    const g = 0.5772156649, SR0 = (N > 1 ? sdv(tested.map((r) => r.sr)) : 0) * ((1 - g) * invPhi(1 - 1 / N_TRIALS) + g * invPhi(1 - 1 / (N_TRIALS * Math.E)));
    for (const r of tested) { const den = 1 - r.g3 * r.sr + ((r.g4 - 1) / 4) * r.sr ** 2; r.dsr = den > 0 ? Phi(((r.sr - SR0) * Math.sqrt(r.months - 1)) / Math.sqrt(den)) : NaN;
      r.verdict = r.monthMean > 0 && r.t >= 3 && r.holm && r.dsr >= 0.95 ? "PASS" : r.monthMean > 0 && r.t >= 2 ? "PROMISING" : "FAIL"; } }
  return out;
}
const sgn = (x, d = 3) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}`;
const fmt = (r, judged = true) => (r.verdict === "NOT TESTABLE" ? `${r.name.padEnd(26)} ${String(r.trades).padStart(6)} trades | NOT TESTABLE (${r.months} months)`
  : `${r.name.padEnd(26)} ${String(r.trades).padStart(6)} trades | ${String(r.months).padStart(3)} months | ${sgn(r.monthMean)}% a month | worst ${sgn(r.worstMonth, 2)}% | t ${r.t.toFixed(2)}`
  + (judged ? ` | Holm ${r.holm ? "y" : "n"} | DSR ${Number.isFinite(r.dsr) ? r.dsr.toFixed(2) : "-"} -> ${r.verdict}` : "")
  + ` | a trade: net ${sgn(r.net)}%, excess ${sgn(r.exc)}%, won ${r.win.toFixed(0)}%, hold ${r.hold.toFixed(1)}`);

// ---------- checks 6.1 and 6.2 ----------
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), 1 | t); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function bizDays(from, n) { const S = []; for (let t = Date.parse(from); S.length < n; t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) S.push(d.toISOString().slice(0, 10)); } return S; }
function check61(log) {
  const S = ["2026-01-27", ...bizDays("2026-01-28", 11)], near = new Map(), fcE1 = new Map(), fcE2 = new Map();   // the futures lab's 5.1
  S.forEach((d, k) => { fcE1.set(d, 100 + k); fcE2.set(d, 101 + k); near.set(d, d <= "2026-01-27" ? { e: "2026-01-27", o: 99, c: 100 + k } : { e: "2026-02-24", o: 100 + k, c: 101 + k }); });
  const P = { fnear: new Map([["X", near]]), fc: new Map([["X", new Map([["2026-01-27", fcE1], ["2026-02-24", fcE2]])]]) };
  const q1 = Math.ceil(500000 / 99), one = futTrade(P, S, "X", 0, 1, -1), want1 = -(100 / 99 - 1) - (charge("SELL", 99, q1, S[0]) + charge("BUY", 100, q1, S[0])) / (99 * q1);
  const ten = futTrade(P, S, "X", 0, 10, 1), v = (100 / 99) * ((101 + 9) / 101), want10 = v - 1 - (charge("BUY", 99, q1, S[0]) + charge("SELL", 100, q1, S[0]) + charge("BUY", 101, q1, S[0]) + charge("SELL", 110, q1, S[9])) / (99 * q1);
  const okF = Math.abs(one.net - want1) < 1e-12 && Math.abs(ten.net - want10) < 1e-12;
  // the market chain on a toy: 30 stocks; day 0 open 100, close 100 (even) or 102 (odd), the contract expires on day 0; day 1 the next contract closes 110
  const T = ["2026-02-24", "2026-02-25"], Q = { fnear: new Map(), fc: new Map() }, syms = [];
  for (let n = 0; n < 30; n += 1) { const sym = `S${n}`, c0 = n % 2 ? 102 : 100; syms.push(sym); Q.fnear.set(sym, new Map([[T[0], { e: T[0], o: 100, c: c0 }], [T[1], { e: "2026-03-31", o: 109, c: 110 }]]));
    Q.fc.set(sym, new Map([[T[0], new Map([[T[0], c0]])], ["2026-03-31", new Map([[T[0], n % 2 ? 103 : 101], [T[1], 110]])]])); }
  const Cx = { S: T, uni: new Map([["2026-02", syms]]), bo: new Map(), bc: new Map() }, B = market(Q, Cx, 0, 2), wantB = 1.01 * (1 + (110 / 103 - 1 + 110 / 101 - 1) / 2) - 1;
  const okB = Math.abs(B - wantB) < 1e-12;
  log(` 6.1 futures by hand: one-session short ${(one.net * 100).toFixed(3)}%, 10-session long across an expiry ${(ten.net * 100).toFixed(3)}%; market chain across a roll ${(B * 100).toFixed(3)}% (want ${(wantB * 100).toFixed(3)}%): ${okF && okB ? "PASSED" : "FAILED"}`);
  return okF && okB;
}
function synthetic(seed, plant = 0.003) {   // check 6.2's market: +0.3% on each session's return for the 5 sessions after every E1 signal
  const r = rng(seed), g = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()), NS = 1800, NK = 250;
  const S = bizDays("2005-01-03", NS), exps = S.filter((_, k) => k % 20 === 19); const P = { name: "synthetic", sessions: S, fnear: new Map(), fc: new Map(), idx: new Map(), from: S[0], to: S[NS - 1] };
  let nc = 5000; for (const d of S) { const o = nc * (1 + 0.002 * g()); nc = o * (1 + 0.01 * g()); P.idx.set(d, { o, c: nc }); }
  P.stocks = []; let planted = 0;
  for (let n = 0; n < NK; n += 1) { const sym = `Z${n}`, drift = new Float64Array(NS + 6), l = new Float64Array(NS), c = new Float64Array(NS), bars = []; let pc = 50 + 950 * r(); const scale = Math.exp(14 + g());
    for (let s = 0; s < NS; s += 1) { const o = pc * (1 + 0.004 * g()), cl = o * (1 + 0.02 * g() + drift[s]), hi = Math.max(o, cl) * (1 + 0.006 * Math.abs(g())), lo = Math.min(o, cl) * (1 - 0.006 * Math.abs(g())), v = scale * Math.exp(0.4 * g());
      bars.push({ d: S[s], o, h: hi, l: lo, c: cl, v, val: v * cl }); l[s] = lo; c[s] = cl; pc = cl;
      if (s >= VALID && soup(l, c, s, 1)) { planted += 1; for (let q = s + 1; q <= s + 5; q += 1) drift[q] += plant; } }
    P.stocks.push({ sym, bars }); const near = new Map(), fc = new Map();
    bars.forEach((b, s) => { const e = exps.find((x) => x >= b.d); if (e) near.set(b.d, { e, o: b.o, c: b.c }); for (const x of exps.filter((y) => y >= b.d).slice(0, 3)) { if (!fc.has(x)) fc.set(x, new Map()); fc.get(x).set(b.d, b.c); } });
    P.fnear.set(sym, near); P.fc.set(sym, fc); }
  return { P, planted };
}
function check62(log) {
  const { P, planted } = synthetic(62), C = context(P), ST = stocksOf(P, C), reg = niftyRegime(P, C.S), { T } = trades(P, C, ST, reg, () => true), sc = score(T);
  const e1 = sc.find((x) => x.name.startsWith("E1")), others = sc.filter((x) => !x.name.startsWith("E1") && x.verdict === "PASS").length, ok = e1.t >= 3 && others <= 1;
  log(` 6.2 planted (+0.3% a session for 5 sessions after ${planted} E1 signals, synthetic): E1 t ${e1.t.toFixed(2)} on ${e1.trades} trades; other members PASS ${others} of 13 (at most 1): ${ok ? "PASSED" : "FAILED"}`);
  for (const x of sc) log("    " + fmt(x)); return ok;
}

if (require.main === module) {
  const mode = process.argv[2], lines = [], log = (x) => { lines.push(x); console.log(x); };
  const refuse = (why) => { fs.appendFileSync(path.join(HERE, "RESULT.txt"), lines.join("\n") + `\n${why}: real run refused.\n\n`); process.exit(1); };
  log(`CHART LAB: registration sha256 ${SHA.slice(0, 16)}... (verified); ${new Date().toISOString()}; mode ${mode}`);
  if (!check61(log)) refuse("CHECK 6.1 FAILED"); if (!check62(log)) refuse("CHECK 6.2 FAILED");
  if (mode === "--checks") process.exit(0);
  if (mode !== "--real") { console.error("usage: node run.js --checks | --real"); process.exit(1); }
  const res = {};
  for (const [name, tag] of [["discovery", "D"], ["confirmation", "C"]]) {
    const P = period(name), C = context(P), ST = stocksOf(P, C), reg = niftyRegime(P, C.S), inS = (d) => d >= P.from && d <= P.to;
    const { T, N } = trades(P, C, ST, reg, inS);
    log(`${name.toUpperCase()} DATA: ${P.sessions.length} sessions ${P.sessions[0]} .. ${P.sessions.at(-1)}, ${P.stocks.length} stocks, futures for ${P.fnear.size}, ${ST.size} studied; NIFTY on ${[...P.idx.keys()].filter((d) => inS(d)).length} sessions; UP ${reg.filter((x) => x === 1).length}, DOWN ${reg.filter((x) => x === -1).length}`);
    log(` 6.5 counts (signals / skipped while held / dropped / trades): ` + MEMBERS.map((m) => `${m.id} ${N[m.id].signals}/${N[m.id].busy}/${N[m.id].dropped}/${T[m.id].length}`).join(", "));
    if (tag === "D") {
      if (!lookahead(P, C, ST, reg, 64, log)) refuse("CHECK 6.4 FAILED");
      const ns = score(redated(P, C, T, 63)), passes = ns.filter((r) => r.verdict === "PASS").length;
      log(` 6.3 null (every discovery trade re-dated at random): ${passes} PASS of ${ns.filter((r) => r.verdict !== "NOT TESTABLE").length} (at most 1): ${passes <= 1 ? "PASSED" : "FAILED"}`); if (passes > 1) refuse("CHECK 6.3 FAILED");
      res.D = T; res.D1 = Object.fromEntries(Object.entries(T).map(([k, v]) => [k, v.filter((x) => x.date < HALF)])); res.D2 = Object.fromEntries(Object.entries(T).map(([k, v]) => [k, v.filter((x) => x.date >= HALF)]));
    } else res.C = T; }
  const rd = score(res.D), rc = score(res.C), h1 = score(res.D1), h2 = score(res.D2);   // all computed before anything is shown
  log(`\nDISCOVERY ${DISC[0]} .. ${DISC[1]}, priced on the near-month FUTURE, judged on FUTURES EXCESS (net - side x market); Holm across ${rd.filter((r) => r.verdict !== "NOT TESTABLE").length}; DSR with N = ${N_TRIALS}:`);
  for (const r of rd) log(" " + fmt(r)); const cand = rd.filter((r) => r.verdict === "PASS").map((r) => r.name);
  log(`DISCOVERY PASS: ${cand.join(", ") || "none"}. PROMISING: ${rd.filter((r) => r.verdict === "PROMISING").map((r) => r.name).join(", ") || "none"}.`);
  log(`\nDISCOVERY HALVES (reported, not judged): 2005-2012 | 2013-2020`);
  rd.forEach((r, k) => { const a = h1[k], b = h2[k], f = (x) => (x.verdict === "NOT TESTABLE" ? `NOT TESTABLE (${x.months} months)` : `${sgn(x.monthMean)}% a month t ${x.t.toFixed(2)} (${x.trades})`); log(`  ${r.name.padEnd(26)} ${f(a)} | ${f(b)}`); });
  log(`\nCONFIRMATION ${CONF[0]} .. ${CONF[1]} (every member reported; a discovery PASS is CONFIRMED with mean > 0 and t >= 2):`);
  for (const r of rc) log(" " + fmt(r, false) + (cand.includes(r.name) ? (r.monthMean > 0 && r.t >= 2 ? "  -> CONFIRMED" : "  -> NOT CONFIRMED") : ""));
  const conf = rc.filter((r) => cand.includes(r.name) && r.monthMean > 0 && r.t >= 2).map((r) => r.name);
  log(`\nCANDIDATES (discovery PASS and confirmed): ${conf.join(", ") || "none"}. A candidate goes to TRACK as a forward paper test first, never straight to the page.`);
  fs.appendFileSync(path.join(HERE, "RESULT.txt"), lines.join("\n") + "\n\n");
  const strip = (rs) => rs.map(({ g3, g4, sr, p, ...r }) => r);
  fs.writeFileSync(path.join(HERE, "result.json"), JSON.stringify({ registration: SHA, discovery: strip(rd), halves: { h2005_2012: strip(h1), h2013_2020: strip(h2) }, confirmation: strip(rc), candidates: conf }, null, 1));
  process.exit(0);
}
module.exports = { MEMBERS, detect, indicators, soup, futTrade, market, score, synthetic, context, stocksOf, niftyRegime, trades, lookahead, redated, fmt };
