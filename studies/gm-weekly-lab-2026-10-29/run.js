"use strict";
// Implements ./PREREGISTRATION.txt (sha256 in ./PREREGISTRATION.sha256): the GM weekly lab, one batch, one run.
//   node run.js --checks   checks 6.1 and 6.2 (hand-built and synthetic, no market data)
//   node run.js --real     6.1, 6.2, then discovery (6.5 counts, 6.4, 6.3), confirmation, and the one real scoring
//                          (RESULT.txt, result.json: summary rows only)
// Data (private, never committed), as the chart lab: K2_OOS_NSE = data-oos nse-old/ (cm/, fut/); K2_RESEARCH_DIR = a
// research/ tree (rising-stocks-2026-10-02/nse-data/cm, orderflow-2026-10-03/nse-fo/fut).
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const ROOT = path.resolve(__dirname, "..", "..");
const HERE = __dirname;
const SHA = fs.readFileSync(path.join(HERE, "PREREGISTRATION.sha256"), "utf8").split(/\s+/)[0];
if (crypto.createHash("sha256").update(fs.readFileSync(path.join(HERE, "PREREGISTRATION.txt"), "utf8").replace(/\r\n/g, "\n")).digest("hex") !== SHA) { console.error("PRE-REGISTRATION CHANGED; result void."); process.exit(2); }
const { calculateNseFuturesCharges } = require(path.join(ROOT, "api/_lib/shadow-broker"));

const NOTIONAL = 500000, RESET = 0.18, N_TRIALS = 440, VALID = 260, MINW = 35, LO_R = 0.82, HI_R = 1.22, UNITS = 20, NIFTY = "^NIFTY";
const DISC = ["2005-01-01", "2020-10-31"], CONF = ["2020-10-01", "2026-10-01"], SPLIT = "2020-09-01", HALF = "2013-01-01";
const MEMBERS = [["W1L", "W1L stage 2 long", 1], ["W1S", "W1S stage 4 short", -1], ["W2L", "W2L weekly Donchian long", 1], ["W2S", "W2S weekly Donchian short", -1],
  ["W3L", "W3L relative strength top", 1], ["W3S", "W3S relative strength bottom", -1], ["W4L", "W4L weekly bull candle", 1], ["W4S", "W4S weekly bear candle", -1],
  ["W5L", "W5L NIFTY trend long", 1], ["W5S", "W5S NIFTY trend short", -1]].map(([id, name, side]) => ({ id, name, side }));
const charge = (side, price, qty, d) => calculateNseFuturesCharges({ side, price, quantity: qty, asOfDate: `${d}T12:00:00Z` }).totalCharges;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

// ---------- data: the chart lab's loaders, plus NIFTY's near-month index future ----------
const jsonDays = (dir, from, to) => fs.readdirSync(dir).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x) && x.slice(0, 10) >= from && x.slice(0, 10) <= to).sort();
function readCm(dir, from, to, P) {
  for (const f of jsonDays(dir, from, to)) { const d = f.slice(0, 10); P.sessions.push(d);
    for (const [, sym, series, o, h, l, c, , v, val] of JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))) {
      if (series !== "EQ" || !sym || ![o, h, l, c].every((x) => x > 0)) continue;
      if (!P.bySym.has(sym)) P.bySym.set(sym, { sym, bars: [] }); P.bySym.get(sym).bars.push({ d, o, h, l, c, v: +v || 0, val }); } }
}
function readFut(dir, from, to, P) {
  for (const f of jsonDays(dir, from, to)) { const d = f.slice(0, 10); const near = new Map(), fcs = new Map();
    for (const r of JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))) {
      const sym = r[1] === "STK" ? r[0] : r[1] === "IDX" && r[0] === "NIFTY" ? NIFTY : null; if (!sym || !(r[2] >= d)) continue;
      const o = Number(r[3]), c = Number(r[6]);   // Number(null) is 0: never a price
      if (c > 0) { if (!fcs.has(sym)) fcs.set(sym, []); fcs.get(sym).push([r[2], c]); }
      if (o > 0 && c > 0 && (!near.has(sym) || r[2] < near.get(sym).e)) near.set(sym, { e: r[2], o, c }); }
    for (const [sym, v] of near) { if (!P.fnear.has(sym)) P.fnear.set(sym, new Map()); P.fnear.get(sym).set(d, v); }
    for (const [sym, list] of fcs) { if (!P.fc.has(sym)) P.fc.set(sym, new Map()); const m = P.fc.get(sym); for (const [e, c] of list.sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(0, 3)) { if (!m.has(e)) m.set(e, new Map()); m.get(e).set(d, c); } } }
}
function period(name) {
  const oos = path.resolve(process.env.K2_OOS_NSE || "nse-old"), R = path.resolve(process.env.K2_RESEARCH_DIR || path.join(ROOT, "research"));
  const P = { name, sessions: [], bySym: new Map(), fnear: new Map(), fc: new Map() };
  if (name === "discovery") { readCm(path.join(oos, "cm"), DISC[0], DISC[1], P); readFut(path.join(oos, "fut"), DISC[0], DISC[1], P); Object.assign(P, { from: DISC[0], to: DISC[1] }); }
  else { const pre = new Date(Date.parse(SPLIT) - 864e5).toISOString().slice(0, 10);
    readCm(path.join(oos, "cm"), "0000", pre, P); readCm(path.join(R, "rising-stocks-2026-10-02", "nse-data", "cm"), SPLIT, CONF[1], P);
    readFut(path.join(oos, "fut"), "0000", pre, P); readFut(path.join(R, "orderflow-2026-10-03", "nse-fo", "fut"), SPLIT, CONF[1], P); Object.assign(P, { from: CONF[0], to: CONF[1] }); }
  P.stocks = [...P.bySym.values()]; delete P.bySym; return P;
}

// ---------- the futures lab's universe; the market's weeks ----------
function weeksOf(S) {
  const key = (d) => { const t = Date.parse(`${d}T00:00:00Z`), dow = new Date(t).getUTCDay(); return new Date(t - ((dow + 6) % 7) * 864e5).toISOString().slice(0, 10); };
  const wkOf = new Int32Array(S.length), W = []; S.forEach((d, s) => { const k = key(d); if (!W.length || W[W.length - 1].key !== k) W.push({ key: k, first: s, last: s }); else W[W.length - 1].last = s; wkOf[s] = W.length - 1; });
  return { W, wkOf };
}
function context(P) {
  const S = P.sessions, sIdx = new Map(S.map((d, i) => [d, i]));
  const firstOf = new Map(); S.forEach((d, i) => { if (!firstOf.has(d.slice(0, 7))) firstOf.set(d.slice(0, 7), i); });
  const months = [...firstOf.keys()], ranked = new Map(months.map((m) => [m, []]));
  for (const st of P.stocks) { const b = st.bars; let k = 0, lc = 0;
    for (const m of months) { const fd = S[firstOf.get(m)]; while (k < b.length && b[k].d < fd) { if (k > 0 && Math.abs(b[k].o / b[k - 1].c - 1) >= RESET) lc = k; k += 1; }
      if (k - lc < 250) continue; const v = b.slice(k - 60, k).map((x) => x.val).filter((x) => x > 0).sort((a, c) => a - c); if (v.length) ranked.get(m).push([st.sym, v[Math.floor(v.length / 2)]]); } }
  const uni = new Map(); for (const [m, r] of ranked) { r.sort((a, c) => c[1] - a[1]); uni.set(m, r.slice(0, 200).map((x) => x[0])); }
  return { S, sIdx, uni, uniSet: new Map([...uni].map(([m, l]) => [m, new Set(l)])), ...weeksOf(S), mk: new Map() };
}

// ---------- weekly bars and the stock signals (every value at weekly bar m reads daily bars up to m's last session) ----------
function resets(bars) { const r = new Int32Array(bars.length); for (let j = 1; j < bars.length; j += 1) r[j] = Math.abs(bars[j].o / bars[j - 1].c - 1) >= RESET ? j : r[j - 1]; return r; }
function weekly(bars, sIdx, wkOf) {
  const X = { wk: [], o: [], h: [], l: [], c: [], kLast: [] };
  bars.forEach((b, k) => { const w = wkOf[sIdx.get(b.d)], n = X.wk.length;
    if (n && X.wk[n - 1] === w) { if (b.h > X.h[n - 1]) X.h[n - 1] = b.h; if (b.l < X.l[n - 1]) X.l[n - 1] = b.l; X.c[n - 1] = b.c; X.kLast[n - 1] = k; }
    else { X.wk.push(w); X.o.push(b.o); X.h.push(b.h); X.l.push(b.l); X.c.push(b.c); X.kLast.push(k); } });
  const n = X.wk.length, sma = new Float64Array(n).fill(NaN); let t = 0; for (let m = 0; m < n; m += 1) { t += X.c[m]; if (m >= 30) t -= X.c[m - 30]; if (m >= 29) sma[m] = t / 30; }
  const don = new Int8Array(n); let st = 0;   // W2: the Donchian state after weekly bar m
  for (let m = 0; m < n; m += 1) { if (m >= 20) {
      let h10 = -Infinity, l10 = Infinity, h20 = -Infinity, l20 = Infinity;
      for (let q = m - 20; q <= m - 1; q += 1) { if (X.h[q] > h20) h20 = X.h[q]; if (X.l[q] < l20) l20 = X.l[q]; if (q >= m - 10) { if (X.h[q] > h10) h10 = X.h[q]; if (X.l[q] < l10) l10 = X.l[q]; } }
      if (st === 1 && X.c[m] < l10) st = 0; else if (st === -1 && X.c[m] > h10) st = 0;
      if (st === 0) st = X.c[m] > h20 ? 1 : X.c[m] < l20 ? -1 : 0; }
    don[m] = st; }
  return Object.assign(X, { n, sma, don });
}
function candle(X, m, side) {   // the chart lab's candle definitions, on weekly bars
  const O = X.o[m], H = X.h[m], L = X.l[m], C = X.c[m], R = H - L, body = Math.abs(C - O), lower = Math.min(O, C) - L, upper = H - Math.max(O, C), po = X.o[m - 1], pc = X.c[m - 1];
  if (side > 0) return (pc < po && C > O && O <= pc && C >= po && C - O > po - pc) || (R > 0 && body <= 0.35 * R && lower >= 2 * body && lower >= 0.5 * R && upper <= 0.15 * R);
  return (pc > po && C < O && O >= pc && C <= po && O - C > pc - po) || (R > 0 && body <= 0.35 * R && upper >= 2 * body && upper >= 0.5 * R && lower <= 0.15 * R);
}
function detectW(X, m, reset) {   // { W1, W2, W4 } each +1, -1 or 0, for the week after weekly bar m
  const out = { W1: 0, W2: 0, W4: 0 }; if (m < MINW || X.kLast[m] - reset[X.kLast[m]] < VALID) return out;
  const C = X.c[m], s = X.sma[m], sp = X.sma[m - 4], up = s > sp, dn = s < sp;
  out.W1 = C > s && up ? 1 : C < s && dn ? -1 : 0; out.W2 = X.don[m];
  if (up && X.l[m] <= 1.02 * s && C >= 0.98 * s && candle(X, m, 1)) out.W4 = 1; else if (dn && X.h[m] >= 0.98 * s && C <= 1.02 * s && candle(X, m, -1)) out.W4 = -1;
  return out;
}
function rsRanks(C, ST, w) {   // W3 for trade week w + 1: the universe ranked by the return from 27 to 2 weekly bars before it
  if (w + 1 >= C.W.length) return null; const mo = C.S[C.W[w + 1].first].slice(0, 7), xs = [];
  for (const sym of C.uni.get(mo) || []) { const t = ST.get(sym); if (!t) continue; const m = t.mOf.get(w); if (m === undefined || m < 27 || m < MINW || t.X.kLast[m] - t.reset[t.X.kLast[m]] < VALID) continue; xs.push([sym, t.X.c[m - 1] / t.X.c[m - 26] - 1]); }
  if (xs.length < 30) return null; xs.sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1)); const k = Math.floor(xs.length / 10);
  return new Map([...xs.slice(0, k).map((x) => [x[0], -1]), ...xs.slice(xs.length - k).map((x) => [x[0], 1])]);
}
function niftySig(P, C, upTo = Infinity) {   // W5: per week w, +1 / -1 / 0 for week w + 1, from NIFTY near-month futures weekly closes
  const fn = P.fnear.get(NIFTY), wc = C.W.map((x, w) => (w <= upTo && fn && fn.get(C.S[x.last]) ? fn.get(C.S[x.last]).c : NaN)), sig = new Int8Array(C.W.length);
  const sma = (w) => { if (w < 29) return NaN; let t = 0; for (let q = w - 29; q <= w; q += 1) t += wc[q]; return t / 30; };   // NaN if a week is missing
  for (let w = 33; w < C.W.length && w <= upTo; w += 1) { const s = sma(w), sp = sma(w - 4); if (!(s > 0 && sp > 0 && wc[w] > 0)) continue; sig[w] = wc[w] > s && s > sp ? 1 : wc[w] < s && s < sp ? -1 : 0; }
  return sig;
}

// ---------- GM's week on the near-month future, the market, holdings ----------
function gmWeek(P, C, t, sym, w) {   // { e, o, c, end, cut } or null: first session's open -> last close, cut at the contract's expiry
  const { W, S } = C, s0 = W[w].first, s1 = W[w].last, n0 = P.fnear.get(sym) && P.fnear.get(sym).get(S[s0]); if (!n0) return null;
  const fc = P.fc.get(sym) && P.fc.get(sym).get(n0.e); if (!fc) return null; let prev = n0.o, end = s1, cut = false;
  for (let s = s0; s <= s1; s += 1) { const c = fc.get(S[s]); if (!(c > 0) || c / prev < LO_R || c / prev > HI_R) return null; prev = c;
    if (t) { const j = t.sj.get(s); if (j !== undefined && j > 0 && t.reset[j] === j) return null; }
    if (S[s] >= n0.e) { end = s; cut = true; break; } }
  return { e: n0.e, o: n0.o, c: fc.get(S[end]), end, cut };
}
function market(P, C, ST, w) { if (C.mk.has(w)) return C.mk.get(w); const xs = [];
  for (const sym of C.uni.get(C.S[C.W[w].first].slice(0, 7)) || []) { const g = gmWeek(P, C, ST.get(sym) || null, sym, w); if (g) xs.push(g.c / g.o - 1); }
  const v = xs.length >= 30 ? mean(xs) : null; C.mk.set(w, v); return v; }
function value(P, C, ST, list, oneWeek = false) {   // list: { sym, w, side } -> position-week values (holdings join consecutive weeks)
  const by = new Map(); for (const x of list) { if (!by.has(x.sym)) by.set(x.sym, []); by.get(x.sym).push(x); }
  const out = [], holds = []; let dropped = 0;
  const finish = (H) => { if (!H) return; const q = Math.ceil(NOTIONAL / H.o1), a = H.weeks[0], z = H.weeks[H.weeks.length - 1], side = H.side;
    const cIn = charge(side > 0 ? "BUY" : "SELL", H.o1, q, C.S[C.W[a.w].first]), cOut = charge(side > 0 ? "SELL" : "BUY", z.g.c, q, C.S[z.g.end]);
    H.weeks.forEach((k, i) => { const chg = (i === 0 ? cIn : 0) + (i === H.weeks.length - 1 ? cOut : 0), net = side * (k.g.c / k.g.o - 1) - chg / (H.o1 * q);
      out.push({ sym: H.sym, w: k.w, date: C.S[C.W[k.w].first], side, net, v: H.sym === NIFTY ? net : net - side * k.M, rup: UNITS * side * (k.g.c - k.g.o), price: k.g.o }); });
    holds.push({ sym: H.sym, date: C.S[C.W[a.w].first], real: UNITS * side * (z.g.c - H.o1), gm: H.weeks.reduce((s, k) => s + UNITS * side * (k.g.c - k.g.o), 0), weeks: H.weeks.length }); };
  for (const [sym, xs] of by) { xs.sort((a, b) => a.w - b.w); let H = null;
    for (const x of xs) { const t = ST.get(sym) || null, g = gmWeek(P, C, t, sym, x.w), M = sym === NIFTY ? 0 : market(P, C, ST, x.w);
      if (!g || M === null) { finish(H); H = null; dropped += 1; continue; }
      if (!oneWeek && H && H.side === x.side && H.e === g.e && x.w === H.lastW + 1 && !H.cutLast) { H.weeks.push({ w: x.w, g, M }); H.lastW = x.w; H.cutLast = g.cut; }
      else { finish(H); H = { sym, side: x.side, e: g.e, o1: g.o, weeks: [{ w: x.w, g, M }], lastW: x.w, cutLast: g.cut }; } }
    finish(H); }
  return { out, holds, dropped };
}

// ---------- signals -> position-weeks ----------
function studied(P, C, extra = []) {
  const want = new Set(extra); for (const [m, l] of C.uni) if (m >= P.from.slice(0, 7) && m <= P.to.slice(0, 7)) for (const s of l) if (P.fnear.has(s)) want.add(s);
  const ST = new Map();
  for (const st of P.stocks) { if (!want.has(st.sym)) continue; const X = weekly(st.bars, C.sIdx, C.wkOf), mOf = new Map(), sj = new Map();
    X.wk.forEach((w, m) => mOf.set(w, m)); st.bars.forEach((b, j) => sj.set(C.sIdx.get(b.d), j)); ST.set(st.sym, { sym: st.sym, bars: st.bars, X, mOf, sj, reset: resets(st.bars) }); }
  return ST;
}
function positions(P, C, ST, inS) {   // every member's { sym, w, side } with week w in the period
  const L = Object.fromEntries(MEMBERS.map((m) => [m.id, []])), inUni = (sym, w) => { const u = C.uniSet.get(C.S[C.W[w].first].slice(0, 7)); return u && u.has(sym); };
  for (const t of ST.values()) for (let m = MINW; m < t.X.n; m += 1) { const w = t.X.wk[m] + 1; if (w >= C.W.length || !inS(C.S[C.W[w].first]) || !inUni(t.sym, w)) continue;
    const d = detectW(t.X, m, t.reset); for (const k of ["W1", "W2", "W4"]) if (d[k]) L[`${k}${d[k] > 0 ? "L" : "S"}`].push({ sym: t.sym, w, side: d[k] }); }
  for (let w = 0; w + 1 < C.W.length; w += 1) { if (!inS(C.S[C.W[w + 1].first])) continue; const r = rsRanks(C, ST, w); if (r) for (const [sym, side] of r) L[side > 0 ? "W3L" : "W3S"].push({ sym, w: w + 1, side }); }
  const ns = niftySig(P, C); for (let w = 0; w + 1 < C.W.length; w += 1) if (ns[w] && inS(C.S[C.W[w + 1].first])) L[ns[w] > 0 ? "W5L" : "W5S"].push({ sym: NIFTY, w: w + 1, side: ns[w] });
  return L;
}

// ---------- checks 6.3 and 6.4 ----------
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), 1 | t); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function redated(P, C, ST, L, seed) { const r = rng(seed), lo = 40, hi = C.W.length - 2, out = {};
  for (const [id, xs] of Object.entries(L)) out[id] = value(P, C, ST, xs.map((x) => ({ ...x, w: lo + Math.floor(r() * (hi - lo)) })), true).out;
  return out; }
function lookahead(P, C, ST, seed, log) {
  const r = rng(seed), list = [...ST.values()]; let n = 0, same = 0, fired = 0;
  for (let tries = 0; n < 3000 && tries < 300000; tries += 1) { const t = list[Math.floor(r() * list.length)], m = MINW + Math.floor(r() * Math.max(1, t.X.n - MINW)); if (m >= t.X.n) continue;
    const k = t.X.kLast[m], cut = t.bars.slice(0, k + 1), X2 = weekly(cut, C.sIdx, C.wkOf), a = JSON.stringify(detectW(t.X, m, t.reset)), b = JSON.stringify(detectW(X2, m, resets(cut)));
    n += 1; if (a === b) same += 1; if (a !== '{"W1":0,"W2":0,"W4":0}') fired += 1; }
  let wn = 0, wsame = 0; for (let tries = 0; wn < 100 && tries < 5000; tries += 1) { const w = 40 + Math.floor(r() * (C.W.length - 42)); const full = rsRanks(C, ST, w); if (!full) continue;
    const last = C.W[w].last, ST2 = new Map(); for (const t of ST.values()) { const cut = t.bars.filter((b) => C.sIdx.get(b.d) <= last); const X = weekly(cut, C.sIdx, C.wkOf), mOf = new Map(); X.wk.forEach((x, m) => mOf.set(x, m)); ST2.set(t.sym, { ...t, X, mOf, reset: resets(cut) }); }
    wn += 1; if (JSON.stringify([...full].sort()) === JSON.stringify([...rsRanks(C, ST2, w)].sort())) wsame += 1; }
  const ns = niftySig(P, C); let nn = 0, nsame = 0; for (let w = 40; w < C.W.length; w += 13) { nn += 1; if (niftySig(P, C, w)[w] === ns[w]) nsame += 1; }
  const ok = n >= 3000 && same === n && wn >= 100 && wsame === wn && nsame === nn;
  log(` 6.4 no look-ahead: W1/W2/W4 ${same} of ${n} (stock, week) pairs identical after cutting (${fired} with a signal); W3 ranks ${wsame} of ${wn} weeks; W5 ${nsame} of ${nn} weeks: ${ok ? "PASSED" : "FAILED"}`);
  return ok;
}

// ---------- scoring (the chart lab's, N = 440) and the GM report ----------
function nwT(x, lag = 3) { const n = x.length, m = mean(x); const e = x.map((v) => v - m); let s = e.reduce((a, v) => a + v * v, 0) / n;
  for (let L = 1; L <= lag; L += 1) { let g = 0; for (let i = L; i < n; i += 1) g += e[i] * e[i - L]; s += 2 * (1 - L / (lag + 1)) * (g / n); } return m / Math.sqrt(s / n); }
const sdv = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const Phi = (x) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
const invPhi = (p) => { let lo = -10, hi = 10; for (let i = 0; i < 100; i += 1) { const m = (lo + hi) / 2; if (Phi(m) < p) lo = m; else hi = m; } return (lo + hi) / 2; };
const monthly = (items) => { const by = new Map(); for (const x of items) { const k = x.date.slice(0, 7); if (!by.has(k)) by.set(k, []); by.get(k).push(x.v * 100); } return [...by.keys()].sort().map((k) => mean(by.get(k))); };
function gmReport(it, holds, exps) {   // reported, not judged: rupees at 20 units, expiry months, the most expensive tenth
  const rup = it.reduce((s, x) => s + x.rup, 0), real = holds.reduce((s, h) => s + h.real, 0), cyc = new Map();
  for (const x of it) { let a = 0, b = exps.length; while (a < b) { const q = (a + b) >> 1; if (exps[q] < x.date) a = q + 1; else b = q; } const k = exps[a] || "end"; cyc.set(k, (cyc.get(k) || 0) + x.rup); }
  const cv = [...cyc.values()], p90 = it.length ? it.map((x) => x.price).sort((a, b) => a - b)[Math.floor(0.9 * (it.length - 1))] : 0, top = it.filter((x) => x.price >= p90).reduce((s, x) => s + x.rup, 0);
  return { gmRupees: Math.round(rup), realRupees: Math.round(real), months: cv.length, posMonths: cv.length ? (100 * cv.filter((v) => v > 0).length) / cv.length : null, worstMonth: cv.length ? Math.round(Math.min(...cv)) : null, topTenthRupees: Math.round(top), holdings: holds.length };
}
function score(T, H, exps) {
  const out = MEMBERS.map((mb) => { const it = T[mb.id] || [], s = monthly(it);
    const extra = { name: mb.name, weeks: it.length, win: it.length ? (100 * it.filter((x) => x.v > 0).length) / it.length : null, net: it.length ? 100 * mean(it.map((x) => x.net)) : null, exc: it.length ? 100 * mean(it.map((x) => x.v)) : null, ...(H ? gmReport(it, H[mb.id] || [], exps) : {}) };
    if (s.length < 24) return { ...extra, nMonths: s.length, verdict: "NOT TESTABLE" }; const m = mean(s), sd = sdv(s);
    return { ...extra, nMonths: s.length, monthMean: m, worst: Math.min(...s), t: nwT(s), sr: m / sd, g3: mean(s.map((v) => ((v - m) / sd) ** 3)), g4: mean(s.map((v) => ((v - m) / sd) ** 4)) }; });
  const tested = out.filter((r) => r.verdict !== "NOT TESTABLE"), N = tested.length;
  if (N) { for (const r of tested) r.p = 1 - Phi(r.t); let ok = true; tested.slice().sort((a, b) => a.p - b.p).forEach((r, i) => { r.holm = ok && r.p <= 0.05 / (N - i); if (!r.holm) ok = false; });
    const g = 0.5772156649, SR0 = (N > 1 ? sdv(tested.map((r) => r.sr)) : 0) * ((1 - g) * invPhi(1 - 1 / N_TRIALS) + g * invPhi(1 - 1 / (N_TRIALS * Math.E)));
    for (const r of tested) { const den = 1 - r.g3 * r.sr + ((r.g4 - 1) / 4) * r.sr ** 2; r.dsr = den > 0 ? Phi(((r.sr - SR0) * Math.sqrt(r.nMonths - 1)) / Math.sqrt(den)) : NaN;
      r.verdict = r.monthMean > 0 && r.t >= 3 && r.holm && r.dsr >= 0.95 ? "PASS" : r.monthMean > 0 && r.t >= 2 ? "PROMISING" : "FAIL"; } }
  return out;
}
const sgn = (x, d = 3) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}`;
const inr = (x) => `${x < 0 ? "-" : "+"}Rs ${Math.abs(x).toLocaleString("en-IN")}`;
const fmt = (r, judged = true) => (r.verdict === "NOT TESTABLE" ? `${r.name.padEnd(29)} ${String(r.weeks).padStart(6)} weeks | NOT TESTABLE (${r.nMonths} months)`
  : `${r.name.padEnd(29)} ${String(r.weeks).padStart(6)} weeks | ${String(r.nMonths).padStart(3)} months | ${sgn(r.monthMean)}% a month | t ${r.t.toFixed(2)}`
  + (judged ? ` | Holm ${r.holm ? "y" : "n"} | DSR ${Number.isFinite(r.dsr) ? r.dsr.toFixed(2) : "-"} -> ${r.verdict}` : "")
  + ` | a week: net ${sgn(r.net)}%, judged ${sgn(r.exc)}%, won ${r.win.toFixed(0)}%`
  + (r.gmRupees !== undefined ? ` | GM 20u ${inr(r.gmRupees)} (real ${inr(r.realRupees)}; top-priced tenth ${inr(r.topTenthRupees)}) | expiry months up ${r.posMonths.toFixed(0)}% of ${r.months}, worst ${inr(r.worstMonth)}` : ""));

// ---------- checks 6.1 and 6.2 ----------
function check61(log) {   // one long holding: Tue start (holiday Monday), weekend gap, cut at a Tue expiry; then a new holding on the next contract
  const S = ["2026-01-27", "2026-01-28", "2026-01-29", "2026-01-30", "2026-02-02", "2026-02-03", "2026-02-04", "2026-02-05", "2026-02-06", "2026-02-09", "2026-02-10", "2026-02-11", "2026-02-12", "2026-02-13"];
  const E1 = "2026-02-03", E2 = "2026-03-03", c1 = [100.5, 101, 102, 103, 104, 105], o1 = [100, 100.6, 101.2, 102.2, 101, 104.2], c2 = [106, 107, 108, 109, 111, 112, 113, 114, 115];
  const fnear = new Map(), f1 = new Map(), f2 = new Map();
  S.forEach((d, s) => { if (s <= 5) { fnear.set(d, { e: E1, o: o1[s], c: c1[s] }); f1.set(d, c1[s]); } if (s >= 5) f2.set(d, c2[s - 5]); if (s >= 6) fnear.set(d, { e: E2, o: s === 9 ? 110 : c2[s - 6], c: c2[s - 5] }); });
  const P = { fnear: new Map([[NIFTY, fnear]]), fc: new Map([[NIFTY, new Map([[E1, f1], [E2, f2]])]]) }, C = { S, ...weeksOf(S), uni: new Map(), mk: new Map() };
  const { out, holds } = value(P, C, new Map(), [0, 1, 2].map((w) => ({ sym: NIFTY, w, side: 1 })));
  const q1 = Math.ceil(NOTIONAL / 100), q2 = Math.ceil(NOTIONAL / 110), cin1 = charge("BUY", 100, q1, S[0]), cout1 = charge("SELL", 105, q1, S[5]), cin2 = charge("BUY", 110, q2, S[9]), cout2 = charge("SELL", 115, q2, S[13]);
  const want = [103 / 100 - 1 - cin1 / (100 * q1), 105 / 101 - 1 - cout1 / (100 * q1), 115 / 110 - 1 - (cin2 + cout2) / (110 * q2)];
  const ok = out.length === 3 && holds.length === 2 && out.every((x, i) => Math.abs(x.net - want[i]) < 1e-12) && Math.abs(holds[0].gm - 20 * (103 - 100 + 105 - 101)) < 1e-9 && Math.abs(holds[0].real - 20 * (105 - 100)) < 1e-9 && Math.abs(holds[1].gm - 100) < 1e-9 && C.W.length === 3;
  log(` 6.1 GM bookkeeping by hand: holding 1 GM ${holds[0] ? holds[0].gm.toFixed(2) : "-"} (want 140.00), real ${holds[0] ? holds[0].real.toFixed(2) : "-"} (want 100.00), ${holds.length} holdings (want 2), weekly nets ${out.map((x) => (x.net * 100).toFixed(4)).join(" / ")}% (want ${want.map((x) => (x * 100).toFixed(4)).join(" / ")}%), no charge at the Monday re-base: ${ok ? "PASSED" : "FAILED"}`);
  return ok;
}
function bizDays(from, n) { const S = []; for (let t = Date.parse(from); S.length < n; t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) S.push(d.toISOString().slice(0, 10)); } return S; }
function synthetic(seed, plant = 0.003) {   // the chart lab's market; +0.3% a session in the week after every W4L signal
  const r = rng(seed), g = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()), NS = 1800, NK = 250;
  const S = bizDays("2005-01-03", NS), sIdx = new Map(S.map((d, i) => [d, i])), { W, wkOf } = weeksOf(S), exps = S.filter((_, k) => k % 20 === 19);
  const P = { name: "synthetic", sessions: S, fnear: new Map(), fc: new Map(), from: S[0], to: S[NS - 1], stocks: [] }; let planted = 0;
  const put = (sym, bars) => { const near = new Map(), fc = new Map(); bars.forEach((b) => { const e = exps.find((x) => x >= b.d); if (e) near.set(b.d, { e, o: b.o, c: b.c }); for (const x of exps.filter((y) => y >= b.d).slice(0, 3)) { if (!fc.has(x)) fc.set(x, new Map()); fc.get(x).set(b.d, b.c); } }); P.fnear.set(sym, near); P.fc.set(sym, fc); };
  let nc = 5000; const nb = []; for (const d of S) { const o = nc * (1 + 0.002 * g()); nc = o * (1 + 0.01 * g()); nb.push({ d, o, c: nc }); } put(NIFTY, nb);
  for (let n = 0; n < NK; n += 1) { const sym = `Z${n}`, drift = new Float64Array(NS), bars = []; let pc = 50 + 950 * r(); const scale = Math.exp(14 + g());
    for (let s = 0; s < NS; s += 1) { const o = pc * (1 + 0.004 * g()), cl = o * (1 + 0.02 * g() + drift[s]), hi = Math.max(o, cl) * (1 + 0.006 * Math.abs(g())), lo = Math.min(o, cl) * (1 - 0.006 * Math.abs(g())), v = scale * Math.exp(0.4 * g());
      bars.push({ d: S[s], o, h: hi, l: lo, c: cl, v, val: v * cl }); pc = cl;
      if (s === W[wkOf[s]].last && s >= VALID && wkOf[s] + 1 < W.length) { const X = weekly(bars, sIdx, wkOf), m = X.n - 1;
        if (detectW(X, m, resets(bars)).W4 === 1) { planted += 1; const nx = W[wkOf[s] + 1]; for (let q = nx.first; q <= nx.last; q += 1) drift[q] += plant; } } }
    P.stocks.push({ sym, bars }); put(sym, bars); }
  return { P, planted };
}
function check62(log) {
  const { P, planted } = synthetic(62), C = context(P), ST = studied(P, C), L = positions(P, C, ST, () => true), T = {};
  for (const [id, xs] of Object.entries(L)) T[id] = value(P, C, ST, xs).out;
  const sc = score(T), w4 = sc.find((x) => x.name.startsWith("W4L")), others = sc.filter((x) => !x.name.startsWith("W4L") && x.verdict === "PASS").length, ok = w4.verdict !== "NOT TESTABLE" && w4.t >= 3 && others <= 1;
  log(` 6.2 planted (+0.3% a session in the week after ${planted} W4L signals, synthetic): W4L t ${w4.t !== undefined ? w4.t.toFixed(2) : "-"} on ${w4.weeks} weeks; other members PASS ${others} of 9 (at most 1): ${ok ? "PASSED" : "FAILED"}`);
  for (const x of sc) log("    " + fmt(x)); return ok;
}

if (require.main === module) {
  const mode = process.argv[2], lines = [], log = (x) => { lines.push(x); console.log(x); };
  const refuse = (why) => { fs.appendFileSync(path.join(HERE, "RESULT.txt"), lines.join("\n") + `\n${why}: real run refused.\n\n`); process.exit(1); };
  log(`GM WEEKLY LAB: registration sha256 ${SHA.slice(0, 16)}... (verified); ${new Date().toISOString()}; mode ${mode}`);
  if (!check61(log)) refuse("CHECK 6.1 FAILED"); if (!check62(log)) refuse("CHECK 6.2 FAILED");
  if (mode === "--checks") process.exit(0);
  if (mode !== "--real") { console.error("usage: node run.js --checks | --real"); process.exit(1); }
  const res = {};
  for (const [name, tag] of [["discovery", "D"], ["confirmation", "C"]]) {
    const P = period(name), C = context(P), ST = studied(P, C), inS = (d) => d >= P.from && d <= P.to, L = positions(P, C, ST, inS), T = {}, H = {}, drop = {};
    for (const [id, xs] of Object.entries(L)) { const v = value(P, C, ST, xs); T[id] = v.out; H[id] = v.holds; drop[id] = v.dropped; }
    const exps = [...new Set([...(P.fnear.get(NIFTY) || new Map()).values()].map((x) => x.e))].sort();
    log(`${name.toUpperCase()} DATA: ${P.sessions.length} sessions ${P.sessions[0]} .. ${P.sessions.at(-1)}, ${C.W.length} weeks, ${P.stocks.length} stocks, futures for ${P.fnear.size} (NIFTY ${P.fnear.has(NIFTY) ? "yes" : "NO"}), ${ST.size} studied; NIFTY expiries ${exps.length}`);
    log(` 6.5 counts (signals / dropped / position-weeks / holdings): ` + MEMBERS.map((m) => `${m.id} ${L[m.id].length}/${drop[m.id]}/${T[m.id].length}/${H[m.id].length}`).join(", "));
    if (tag === "D") {
      if (!lookahead(P, C, ST, 64, log)) refuse("CHECK 6.4 FAILED");
      const ns = score(redated(P, C, ST, L, 63)), passes = ns.filter((r) => r.verdict === "PASS").length;
      log(` 6.3 null (every discovery position-week re-dated at random): ${passes} PASS of ${ns.filter((r) => r.verdict !== "NOT TESTABLE").length} (at most 1): ${passes <= 1 ? "PASSED" : "FAILED"}`); if (passes > 1) refuse("CHECK 6.3 FAILED");
      const half = (lo, hi) => Object.fromEntries(Object.entries(T).map(([k, v]) => [k, v.filter((x) => x.date >= lo && x.date < hi)]));
      res.D = { T, H, exps }; res.D1 = half("0000", HALF); res.D2 = half(HALF, "9999");
    } else res.C = { T, H, exps }; }
  const rd = score(res.D.T, res.D.H, res.D.exps), rc = score(res.C.T, res.C.H, res.C.exps), h1 = score(res.D1), h2 = score(res.D2);   // all computed before anything is shown
  log(`\nDISCOVERY ${DISC[0]} .. ${DISC[1]}, GM's week (Monday open -> Friday close, cut at expiry) on the near-month FUTURE; W1-W4 judged on GM EXCESS, W5 on net; Holm across ${rd.filter((r) => r.verdict !== "NOT TESTABLE").length}; DSR with N = ${N_TRIALS}:`);
  for (const r of rd) log(" " + fmt(r)); const cand = rd.filter((r) => r.verdict === "PASS").map((r) => r.name);
  log(`DISCOVERY PASS: ${cand.join(", ") || "none"}. PROMISING: ${rd.filter((r) => r.verdict === "PROMISING").map((r) => r.name).join(", ") || "none"}.`);
  log(`\nDISCOVERY HALVES (reported, not judged): 2005-2012 | 2013-2020`);
  rd.forEach((r, k) => { const f = (x) => (x.verdict === "NOT TESTABLE" ? `NOT TESTABLE (${x.nMonths} months)` : `${sgn(x.monthMean)}% a month t ${x.t.toFixed(2)} (${x.weeks})`); log(`  ${r.name.padEnd(29)} ${f(h1[k])} | ${f(h2[k])}`); });
  log(`\nCONFIRMATION ${CONF[0]} .. ${CONF[1]} (every member reported; a discovery PASS is CONFIRMED with mean > 0 and t >= 2):`);
  for (const r of rc) log(" " + fmt(r, false) + (cand.includes(r.name) ? (r.monthMean > 0 && r.t >= 2 ? "  -> CONFIRMED" : "  -> NOT CONFIRMED") : ""));
  const conf = rc.filter((r) => cand.includes(r.name) && r.monthMean > 0 && r.t >= 2).map((r) => r.name);
  log(`\nCANDIDATES (discovery PASS and confirmed): ${conf.join(", ") || "none"}. A candidate goes to TRACK as a forward paper test first, never straight to the page.`);
  fs.appendFileSync(path.join(HERE, "RESULT.txt"), lines.join("\n") + "\n\n");
  const strip = (rs) => rs.map(({ g3, g4, sr, p, ...r }) => r);
  fs.writeFileSync(path.join(HERE, "result.json"), JSON.stringify({ registration: SHA, discovery: strip(rd), halves: { h2005_2012: strip(h1), h2013_2020: strip(h2) }, confirmation: strip(rc), candidates: conf }, null, 1));
  process.exit(0);
}
module.exports = { MEMBERS, weekly, detectW, gmWeek, value, score, synthetic, context, studied, positions, lookahead, redated, check61 };
