"use strict";
// Implements ./PREREGISTRATION.txt (sha256 in ./PREREGISTRATION.sha256): the GM strategy generator, one batch, one run.
//   node run.js --checks   checks 6.1 and 6.2 (hand-built and synthetic, no market data)
//   node run.js --real     6.1, 6.2, then the data (6.5 counts, 6.4, 6.3), and the one real scoring (RESULT.txt, result.json)
// GM weeks, holdings, charges, the universe and weekly bars are the GM weekly lab's own code (required below).
// Data (private, never committed): K2_OOS_NSE = data-oos nse-old/ (cm/, fut/); K2_RESEARCH_DIR = a research/ tree.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const ROOT = path.resolve(__dirname, "..", "..");
const HERE = __dirname;
const SHA = fs.readFileSync(path.join(HERE, "PREREGISTRATION.sha256"), "utf8").split(/\s+/)[0];
if (crypto.createHash("sha256").update(fs.readFileSync(path.join(HERE, "PREREGISTRATION.txt"), "utf8").replace(/\r\n/g, "\n")).digest("hex") !== SHA) { console.error("PRE-REGISTRATION CHANGED; result void."); process.exit(2); }
const A1 = fs.readFileSync(path.join(HERE, "AMENDMENT-A1.sha256"), "utf8").split(/\s+/)[0];
if (crypto.createHash("sha256").update(fs.readFileSync(path.join(HERE, "AMENDMENT-A1.txt"), "utf8").replace(/\r\n/g, "\n")).digest("hex") !== A1) { console.error("AMENDMENT A1 CHANGED; result void."); process.exit(2); }
const WL = require(path.join(ROOT, "studies/gm-weekly-lab-2026-10-29/run.js"));

const RESET = 0.18, VALID = 260, MINW = 35, NIFTY = "^NIFTY", N_TRIALS = 442, LO_R = 0.82, HI_R = 1.22, UNITS = 20, BOOK = 5, PICK = 5;
const FIRST_Y = 2008, DISC = ["2008-01-01", "2020-10-31"], CONF = ["2020-10-01", "2026-10-01"], SPLIT = "2020-09-01";
const BLOCKS = ["B1 close>SMA30", "B2 close<SMA30", "B3 SMA30 rising", "B4 SMA30 falling", "B5 Donchian long", "B6 Donchian short", "B7 RS top", "B8 RS bottom",
  "B9 bull candle", "B10 bear candle", "B11 at line from above", "B12 at line from below", "B13 NIFTY up", "B14 NIFTY down", "B15 last week top", "B16 last week bottom",
  "B17 volume high", "B18 volume low", "B19 tight range", "B20 wide range", "B21 OI build-up", "B22 OI unwinding", "B23 basis high", "B24 basis low",
  "B25 near 52w high", "B26 near 52w low", "B27 volatile", "B28 calm", "B29 expensive", "B30 cheap"];
const CONDS = []; for (let i = 0; i < 30; i += 1) CONDS.push([i]); for (let i = 0; i < 30; i += 1) for (let j = i + 1; j < 30; j += 1) CONDS.push([i, j]);
const CMASK = CONDS.map((c) => c.reduce((m, i) => (m | (1 << i)) >>> 0, 0));
const cname = (c) => CONDS[c].map((i) => BLOCKS[i].split(" ")[0]).join("&") + " (" + CONDS[c].map((i) => BLOCKS[i].split(" ").slice(1).join(" ")).join(" + ") + ")";
const XS = [["rs", 6, 7], ["r1", 14, 15], ["vr", 16, 17], ["rr", 19, 18], ["oir", 20, 21], ["basis", 22, 23], ["sd", 26, 27], ["px", 28, 29]];   // [value, top-fifth block, bottom-fifth block]
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

// ---------- data: the weekly lab's loaders, plus each stock's total futures open interest per day ----------
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
      if (r[1] === "STK") { if (!P.oi.has(r[0])) P.oi.set(r[0], new Map()); const m = P.oi.get(r[0]); m.set(d, (m.get(d) || 0) + (+r[8] || 0)); }
      const sym = r[1] === "STK" ? r[0] : r[1] === "IDX" && r[0] === "NIFTY" ? NIFTY : null; if (!sym || !(r[2] >= d)) continue;
      const o = Number(r[3]), c = Number(r[6]);   // Number(null) is 0: never a price
      if (c > 0) { if (!fcs.has(sym)) fcs.set(sym, []); fcs.get(sym).push([r[2], c]); }
      if (o > 0 && c > 0 && (!near.has(sym) || r[2] < near.get(sym).e)) near.set(sym, { e: r[2], o, c }); }
    for (const [sym, v] of near) { if (!P.fnear.has(sym)) P.fnear.set(sym, new Map()); P.fnear.get(sym).set(d, v); }
    for (const [sym, list] of fcs) { if (!P.fc.has(sym)) P.fc.set(sym, new Map()); const m = P.fc.get(sym); for (const [e, c] of list.sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(0, 3)) { if (!m.has(e)) m.set(e, new Map()); m.get(e).set(d, c); } } }
}
function load() {   // one load, 2005-01 .. 2026-10-01
  const oos = path.resolve(process.env.K2_OOS_NSE || "nse-old"), R = path.resolve(process.env.K2_RESEARCH_DIR || path.join(ROOT, "research")), pre = new Date(Date.parse(SPLIT) - 864e5).toISOString().slice(0, 10);
  const P = { name: "all", sessions: [], bySym: new Map(), fnear: new Map(), fc: new Map(), oi: new Map(), from: "2005-01-01", to: CONF[1] };
  readCm(path.join(oos, "cm"), "0000", pre, P); readCm(path.join(R, "rising-stocks-2026-10-02", "nse-data", "cm"), SPLIT, CONF[1], P);
  readFut(path.join(oos, "fut"), "0000", pre, P); readFut(path.join(R, "orderflow-2026-10-03", "nse-fo", "fut"), SPLIT, CONF[1], P);
  P.stocks = [...P.bySym.values()]; delete P.bySym; return P;
}

// ---------- the blocks ----------
function resets(bars) { const r = new Int32Array(bars.length); for (let j = 1; j < bars.length; j += 1) r[j] = Math.abs(bars[j].o / bars[j - 1].c - 1) >= RESET ? j : r[j - 1]; return r; }
function rollExt(a, n, isMax) { const out = new Float64Array(a.length).fill(NaN), q = []; let h = 0;
  for (let j = 0; j < a.length; j += 1) { while (q.length > h && (isMax ? a[q[q.length - 1]] <= a[j] : a[q[q.length - 1]] >= a[j])) q.pop(); q.push(j); if (q[h] <= j - n) h += 1; if (j >= n - 1) out[j] = a[q[h]]; }
  return out; }
function candle(X, m, side) {   // the chart lab's candle definitions on weekly bars (as the weekly lab)
  const O = X.o[m], H = X.h[m], L = X.l[m], C = X.c[m], R = H - L, body = Math.abs(C - O), lower = Math.min(O, C) - L, upper = H - Math.max(O, C), po = X.o[m - 1], pc = X.c[m - 1];
  if (side > 0) return (pc < po && C > O && O <= pc && C >= po && C - O > po - pc) || (R > 0 && body <= 0.35 * R && lower >= 2 * body && lower >= 0.5 * R && upper <= 0.15 * R);
  return (pc > po && C < O && O >= pc && C <= po && O - C > pc - po) || (R > 0 && body <= 0.35 * R && upper >= 2 * body && upper >= 0.5 * R && lower <= 0.15 * R);
}
function featuresOf(P, C, sym, bars) {   // per weekly bar m: null, or { bits (per-stock blocks), raw values for the fifths }; reads bars <= m's last session only
  const X = WL.weekly(bars, C.sIdx, C.wkOf), reset = resets(bars), n = X.n, hi = rollExt(bars.map((b) => b.h), 250, true), lo = rollExt(bars.map((b) => b.l), 250, false);
  const sd = new Float64Array(bars.length).fill(NaN); let s1 = 0, s2 = 0;
  for (let k = 1; k < bars.length; k += 1) { const r = bars[k].c / bars[k - 1].c - 1; s1 += r; s2 += r * r; if (k > 20) { const r0 = bars[k - 20].c / bars[k - 21].c - 1; s1 -= r0; s2 -= r0 * r0; } if (k >= 20) sd[k] = Math.sqrt(Math.max(0, (s2 - (s1 * s1) / 20) / 19)); }
  const vol = new Float64Array(n); { let m = 0; bars.forEach((b, k) => { while (X.kLast[m] < k) m += 1; vol[m] += b.v; }); }
  const oi = P.oi.get(sym), fn = P.fnear.get(sym), rows = new Array(n).fill(null);
  for (let m = MINW; m < n; m += 1) { const k = X.kLast[m]; if (k - reset[k] < VALID) continue;
    const c = X.c[m], s = X.sma[m], sp = X.sma[m - 4]; let bits = 0; const set = (i, on) => { if (on) bits = (bits | (1 << i)) >>> 0; };
    set(0, c > s); set(1, c < s); set(2, s > sp); set(3, s < sp); set(4, X.don[m] === 1); set(5, X.don[m] === -1); set(8, candle(X, m, 1)); set(9, candle(X, m, -1));
    set(10, X.l[m] <= 1.02 * s && c >= 0.98 * s); set(11, X.h[m] >= 0.98 * s && c <= 1.02 * s); set(24, c >= 0.95 * hi[k]); set(25, c <= 1.05 * lo[k]);
    let vm = 0, rm = 0; for (let q = m - 20; q <= m - 1; q += 1) vm += vol[q]; for (let q = m - 10; q <= m - 1; q += 1) rm += X.h[q] - X.l[q]; vm /= 20; rm /= 10;
    const d1 = bars[k].d, d0 = bars[X.kLast[m - 1]].d, o1 = oi ? oi.get(d1) : undefined, o0 = oi ? oi.get(d0) : undefined, f1 = fn ? fn.get(d1) : undefined;
    rows[m] = { bits, rs: X.c[m - 1] / X.c[m - 26] - 1, r1: c / X.c[m - 1] - 1, vr: vm > 0 ? vol[m] / vm : NaN, rr: rm > 0 ? (X.h[m] - X.l[m]) / rm : NaN,
      oir: o1 > 0 && o0 > 0 ? o1 / o0 : NaN, basis: f1 ? f1.c / c - 1 : NaN, sd: sd[k], px: c }; }
  return { X, reset, rows };
}
function niftySig(P, C, upTo = Infinity) {   // the weekly lab's W5 signal per week (copied: that function is not exported)
  const fn = P.fnear.get(NIFTY), wc = C.W.map((x, w) => (w <= upTo && fn && fn.get(C.S[x.last]) ? fn.get(C.S[x.last]).c : NaN)), sig = new Int8Array(C.W.length);
  const sma = (w) => { if (w < 29) return NaN; let t = 0; for (let q = w - 29; q <= w; q += 1) t += wc[q]; return t / 30; };
  for (let w = 33; w < C.W.length && w <= upTo; w += 1) { const s = sma(w), sp = sma(w - 4); if (!(s > 0 && sp > 0 && wc[w] > 0)) continue; sig[w] = wc[w] > s && s > sp ? 1 : wc[w] < s && s < sp ? -1 : 0; }
  return sig;
}
function fifths(list) {   // list [sym, value]: { top: Set, bottom: Set } or null (fewer than 30, or no spread at the cuts)
  const xs = list.filter((x) => Number.isFinite(x[1])).sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1)), n = xs.length; if (n < 30) return null; const k = Math.floor(n / 5);
  if (xs[k - 1][1] === xs[n - k][1]) return null; return { bottom: new Set(xs.slice(0, k).map((x) => x[0])), top: new Set(xs.slice(n - k).map((x) => x[0])) };
}
function weekRecords(C, F, ns, w) {   // the records of trade week w: { sym, w, bits } for the month's universe stocks with a row at week w - 1
  const u = C.uni.get(C.S[C.W[w].first].slice(0, 7)) || [], rows = [];
  for (const sym of u) { const f = F.get(sym); if (!f) continue; const m = f.mOf.get(w - 1); if (m === undefined || !f.rows[m]) continue; rows.push([sym, f.rows[m]]); }
  const bits = new Map(rows.map(([sym, r]) => [sym, r.bits]));
  for (const [key, top, bot] of XS) { const q = fifths(rows.map(([sym, r]) => [sym, r[key]])); if (!q) continue; for (const sym of q.top) bits.set(sym, (bits.get(sym) | (1 << top)) >>> 0); for (const sym of q.bottom) bits.set(sym, (bits.get(sym) | (1 << bot)) >>> 0); }
  const nb = ns[w - 1] === 1 ? 1 << 12 : ns[w - 1] === -1 ? 1 << 13 : 0;
  return [...bits].map(([sym, b]) => ({ sym, w, bits: (b | nb) >>> 0 }));
}
function marketOf(P, C, ST, w) {   // the weekly lab's market M_w (same code; shares its memo C.mk)
  if (C.mk.has(w)) return C.mk.get(w); const xs = [];
  for (const sym of C.uni.get(C.S[C.W[w].first].slice(0, 7)) || []) { const g = WL.gmWeek(P, C, ST.get(sym) || null, sym, w); if (g) xs.push(g.c / g.o - 1); }
  const v = xs.length >= 30 ? mean(xs) : null; C.mk.set(w, v); return v; }

// ---------- the generator ----------
function nwT(x, lag = 3) { const n = x.length, m = mean(x); const e = x.map((v) => v - m); let s = e.reduce((a, v) => a + v * v, 0) / n;
  for (let L = 1; L <= lag; L += 1) { let g = 0; for (let i = L; i < n; i += 1) g += e[i] * e[i - L]; s += 2 * (1 - L / (lag + 1)) * (g / n); } return m / Math.sqrt(s / n); }
function generator(C, recs, years, log) {   // recs: { sym, w, bits, val (gross excess or null) }; returns per year the selected rules and the picks
  const months = [...new Set(C.W.map((x) => C.S[x.first].slice(0, 7)))].sort(), mi = new Map(months.map((m, i) => [m, i])), NM = months.length, NC = CONDS.length;
  const sum = new Float64Array(NC * NM), cnt = new Float64Array(NC * NM), ss = new Map(), sc = new Map(), valued = recs.filter((r) => r.val !== null);
  const bitsList = (b) => { const on = []; for (let i = 0; i < 30; i += 1) if (b & (1 << i)) on.push(i); return on; }, cid = (i, j) => (j === undefined ? i : 30 + (i * (59 - i)) / 2 + (j - i - 1));
  for (const r of valued) { const on = bitsList(r.bits), m = mi.get(C.S[C.W[r.w].first].slice(0, 7)), y1 = +C.S[C.W[r.w].first].slice(0, 4), y2 = +C.S[C.W[r.w].last].slice(0, 4); r.cs = [];
    for (let a = 0; a < on.length; a += 1) { r.cs.push(cid(on[a])); for (let b = a + 1; b < on.length; b += 1) r.cs.push(cid(on[a], on[b])); }
    for (const c of r.cs) { sum[c * NM + m] += r.val; cnt[c * NM + m] += 1; if (y2 > y1) { const k = `${c}:${y2}`; ss.set(k, (ss.get(k) || 0) + r.val); sc.set(k, (sc.get(k) || 0) + 1); } } }
  const out = [];
  out.srSpread = (lo, hi) => {   // A1.2: the standard deviation of the 930 rules' monthly Sharpe ratios over months [lo, hi] (a short rule's ratio is minus its long rule's)
    const sq = []; for (let c = 0; c < NC; c += 1) { const s = []; for (let m = 0; m < NM; m += 1) { if (months[m] < lo || months[m] > hi) continue; const n = cnt[c * NM + m]; if (n > 0) s.push(sum[c * NM + m] / n); }
      if (s.length >= 24) { const sr = mean(s) / sdv(s); if (Number.isFinite(sr)) sq.push(sr * sr, sr * sr); } }
    return sq.length ? Math.sqrt(mean(sq)) : NaN; };
  for (const Y of years) { const cut = `${Y}-01`, decIdx = mi.get(`${Y - 1}-12`), stats = [];
    const tots = new Float64Array(NC);
    for (let c = 0; c < NC; c += 1) { const s = []; let tot = 0;
      for (let m = 0; m < NM && months[m] < cut; m += 1) { let a = sum[c * NM + m], n = cnt[c * NM + m]; if (m === decIdx) { a -= ss.get(`${c}:${Y}`) || 0; n -= sc.get(`${c}:${Y}`) || 0; } if (n > 0) { s.push(a / n); tot += n; } }
      tots[c] = tot; if (s.length >= 36 && tot >= 200) { const t = nwT(s); if (Number.isFinite(t)) stats.push({ c, t, n: tot }); } }
    const train = valued.filter((r) => C.S[C.W[r.w].last] < `${Y}-01-01`), dc = new Float64Array(30);   // the direct count of each block's training position-weeks
    for (const r of train) for (let i = 0; i < 30; i += 1) if (r.bits & (1 << i)) dc[i] += 1;
    let leak = 0; for (let i = 0; i < 30; i += 1) leak += Math.abs(dc[i] - tots[i]);
    const pick = (side) => { const cand = stats.map((x) => ({ ...x, t: side * x.t })).filter((x) => x.t > 0).sort((a, b) => b.t - a.t || a.c - b.c), sel = [];
      for (const x of cand) { if (sel.length >= PICK) break; let A = 0; const AB = sel.map(() => 0);
        for (const r of train) if ((r.bits & CMASK[x.c]) >>> 0 === CMASK[x.c]) { A += 1; sel.forEach((s, i) => { if ((r.bits & CMASK[s.c]) >>> 0 === CMASK[s.c]) AB[i] += 1; }); }
        if (A > 0 && AB.every((v) => v / A < 0.8)) sel.push(x); }
      return sel; };
    out.push({ Y, eligible: stats.length, long: pick(1), short: pick(-1), trainN: train.length, leak }); }
  return out;
}
function book(C, recs, sel) {   // picks per week of each year from that year's selected rules: capped book and all picks
  const byY = new Map(sel.map((s) => [s.Y, s])), byW = new Map(); for (const r of recs) { if (!byW.has(r.w)) byW.set(r.w, []); byW.get(r.w).push(r); }
  const res = { bookL: [], bookS: [], allL: [], allS: [] };
  for (const [w, rs] of byW) { const s = byY.get(+C.S[C.W[w].first].slice(0, 4)); if (!s) continue; const L = [], Sh = [];
    for (const r of rs) { const sl = s.long.reduce((a, x) => a + (((r.bits & CMASK[x.c]) >>> 0) === CMASK[x.c] ? x.t : 0), 0), sh = s.short.reduce((a, x) => a + (((r.bits & CMASK[x.c]) >>> 0) === CMASK[x.c] ? x.t : 0), 0);
      if (sl > 0 && sh > 0) continue; if (sl > 0) L.push([r.sym, sl]); if (sh > 0) Sh.push([r.sym, sh]); }
    for (const [list, bk, all, side] of [[L, res.bookL, res.allL, 1], [Sh, res.bookS, res.allS, -1]]) { list.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
      list.forEach(([sym], i) => { const x = { sym, w, side }; all.push(x); if (i < BOOK) bk.push(x); }); } }
  return res;
}

// ---------- scoring (the labs' Holm and full Deflated Sharpe, N = 442) ----------
const sdv = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const Phi = (x) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
const invPhi = (p) => { let lo = -10, hi = 10; for (let i = 0; i < 100; i += 1) { const m = (lo + hi) / 2; if (Phi(m) < p) lo = m; else hi = m; } return (lo + hi) / 2; };
const monthly = (items) => { const by = new Map(); for (const x of items) { const k = x.date.slice(0, 7); if (!by.has(k)) by.set(k, []); by.get(k).push(x.v * 100); } return [...by.keys()].sort().map((k) => mean(by.get(k))); };
function gmReport(it, holds, exps) {
  const rup = it.reduce((s, x) => s + x.rup, 0), real = holds.reduce((s, h) => s + h.real, 0), cyc = new Map();
  for (const x of it) { let a = 0, b = exps.length; while (a < b) { const q = (a + b) >> 1; if (exps[q] < x.date) a = q + 1; else b = q; } const k = exps[a] || "end"; cyc.set(k, (cyc.get(k) || 0) + x.rup); }
  const cv = [...cyc.values()], p90 = it.length ? it.map((x) => x.price).sort((a, b) => a - b)[Math.floor(0.9 * (it.length - 1))] : 0, top = it.filter((x) => x.price >= p90).reduce((s, x) => s + x.rup, 0);
  return { gmRupees: Math.round(rup), realRupees: Math.round(real), months: cv.length, posMonths: cv.length ? (100 * cv.filter((v) => v > 0).length) / cv.length : null, worstMonth: cv.length ? Math.round(Math.min(...cv)) : null, topTenthRupees: Math.round(top), holdings: holds.length };
}
function score(members, spread) {   // members: [{ name, it, holds, exps }]; spread = A1.2's standard deviation of the searched rules' Sharpe ratios
  const out = members.map(({ name, it, holds, exps }) => { const s = monthly(it);
    const extra = { name, weeks: it.length, win: it.length ? (100 * it.filter((x) => x.v > 0).length) / it.length : null, net: it.length ? 100 * mean(it.map((x) => x.net)) : null, exc: it.length ? 100 * mean(it.map((x) => x.v)) : null, ...(holds ? gmReport(it, holds, exps) : {}) };
    if (s.length < 24) return { ...extra, nMonths: s.length, verdict: "NOT TESTABLE" }; const m = mean(s), sd = sdv(s);
    return { ...extra, nMonths: s.length, monthMean: m, t: nwT(s), sr: m / sd, g3: mean(s.map((v) => ((v - m) / sd) ** 3)), g4: mean(s.map((v) => ((v - m) / sd) ** 4)) }; });
  const tested = out.filter((r) => r.verdict !== "NOT TESTABLE"), N = tested.length;
  if (N) { for (const r of tested) r.p = 1 - Phi(r.t); let ok = true; tested.slice().sort((a, b) => a.p - b.p).forEach((r, i) => { r.holm = ok && r.p <= 0.05 / (N - i); if (!r.holm) ok = false; });
    const g = 0.5772156649, SR0 = (Number.isFinite(spread) ? spread : NaN) * ((1 - g) * invPhi(1 - 1 / N_TRIALS) + g * invPhi(1 - 1 / (N_TRIALS * Math.E)));
    for (const r of tested) { const den = 1 - r.g3 * r.sr + ((r.g4 - 1) / 4) * r.sr ** 2; r.dsr = den > 0 ? Phi(((r.sr - SR0) * Math.sqrt(r.nMonths - 1)) / Math.sqrt(den)) : NaN;
      r.verdict = r.monthMean > 0 && r.t >= 3 && r.holm && r.dsr >= 0.95 ? "PASS" : r.monthMean > 0 && r.t >= 2 ? "PROMISING" : "FAIL"; } }
  return out;
}
const sgn = (x, d = 3) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}`;
const inr = (x) => `${x < 0 ? "-" : "+"}Rs ${Math.abs(x).toLocaleString("en-IN")}`;
const fmt = (r, judged = true) => (r.verdict === "NOT TESTABLE" ? `${r.name.padEnd(24)} ${String(r.weeks).padStart(6)} weeks | NOT TESTABLE (${r.nMonths} months)`
  : `${r.name.padEnd(24)} ${String(r.weeks).padStart(6)} weeks | ${String(r.nMonths).padStart(3)} months | ${sgn(r.monthMean)}% (monthly mean of weeks) | t ${r.t.toFixed(2)}`
  + (judged ? ` | Holm ${r.holm ? "y" : "n"} | DSR ${Number.isFinite(r.dsr) ? r.dsr.toFixed(2) : "-"} -> ${r.verdict}` : "")
  + ` | a week: net ${sgn(r.net)}%, judged ${sgn(r.exc)}%, won ${r.win.toFixed(0)}%`
  + (r.gmRupees !== undefined ? ` | GM 20u ${inr(r.gmRupees)} (real ${inr(r.realRupees)}; top-priced tenth ${inr(r.topTenthRupees)}) | expiry months up ${r.posMonths.toFixed(0)}% of ${r.months}, worst ${inr(r.worstMonth)}` : ""));

// ---------- the pipeline, shared by the synthetic check and the real run ----------
function build(P, log) {
  const C = WL.context(P), ST = WL.studied(P, C), F = new Map(), ns = niftySig(P, C);
  for (const [sym, t] of ST) { const f = featuresOf(P, C, sym, t.bars), mOf = new Map(); f.X.wk.forEach((w, m) => mOf.set(w, m)); F.set(sym, { ...f, mOf }); }
  const recs = []; for (let w = 1; w < C.W.length; w += 1) recs.push(...weekRecords(C, F, ns, w));
  for (const r of recs) { const g = WL.gmWeek(P, C, ST.get(r.sym) || null, r.sym, r.w), M = g ? marketOf(P, C, ST, r.w) : null; r.val = g && M !== null ? g.c / g.o - 1 - M : null; }
  return { C, ST, F, ns, recs };
}
function run(P, B, years, log) {   // the generator, the books, the judged values
  const sel = generator(B.C, B.recs, years, log), bk = book(B.C, B.recs, sel), V = {};
  sel.spreadDisc = sel.srSpread(DISC[0].slice(0, 7), DISC[1].slice(0, 7));
  for (const k of Object.keys(bk)) V[k] = WL.value(P, B.C, B.ST, bk[k]);
  return { sel, bk, V };
}
function synthetic(seed, plant = 0.003) {   // the weekly lab's market, 3,000 sessions; +0.3% a session in the week after every B9 AND B3
  let s0 = seed >>> 0; const r = () => { s0 = (s0 + 0x6d2b79f5) >>> 0; let t = s0; t = Math.imul(t ^ (t >>> 15), 1 | t); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const g = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()), NS = 3000, NK = 250, S = []; for (let t = Date.parse("2005-01-03"); S.length < NS; t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) S.push(d.toISOString().slice(0, 10)); }
  const C0 = WL.context({ sessions: S, stocks: [] }), exps = S.filter((_, k) => k % 20 === 19);
  const P = { name: "synthetic", sessions: S, fnear: new Map(), fc: new Map(), oi: new Map(), from: S[0], to: S[NS - 1], stocks: [] }; let planted = 0;
  const put = (sym, bars) => { const near = new Map(), fc = new Map(); bars.forEach((b) => { const e = exps.find((x) => x >= b.d); if (e) near.set(b.d, { e, o: b.o, c: b.c }); for (const x of exps.filter((y) => y >= b.d).slice(0, 3)) { if (!fc.has(x)) fc.set(x, new Map()); fc.get(x).set(b.d, b.c); } }); P.fnear.set(sym, near); P.fc.set(sym, fc); };
  let nc = 5000; const nb = []; for (const d of S) { const o = nc * (1 + 0.002 * g()); nc = o * (1 + 0.01 * g()); nb.push({ d, o, c: nc }); } put(NIFTY, nb);
  for (let n = 0; n < NK; n += 1) { const sym = `Z${n}`, drift = new Float64Array(NS), bars = []; let pc = 50 + 950 * r(); const scale = Math.exp(14 + g());
    for (let s = 0; s < NS; s += 1) { const o = pc * (1 + 0.004 * g()), cl = o * (1 + 0.02 * g() + drift[s]), hi = Math.max(o, cl) * (1 + 0.006 * Math.abs(g())), lo = Math.min(o, cl) * (1 - 0.006 * Math.abs(g())), v = scale * Math.exp(0.4 * g());
      bars.push({ d: S[s], o, h: hi, l: lo, c: cl, v, val: v * cl }); pc = cl;
      const wk = C0.wkOf[s]; if (s === C0.W[wk].last && s >= VALID && wk + 1 < C0.W.length) { const X = WL.weekly(bars, C0.sIdx, C0.wkOf), m = X.n - 1;
        if (m >= MINW && candle(X, m, 1) && X.sma[m] > X.sma[m - 4]) { planted += 1; const nx = C0.W[wk + 1]; for (let q = nx.first; q <= nx.last; q += 1) drift[q] += plant; } } }
    P.stocks.push({ sym, bars }); put(sym, bars); }
  return { P, planted };
}
function check62(log) {
  const { P, planted } = synthetic(62), B = build(P), years = []; for (let Y = FIRST_Y; Y <= +P.to.slice(0, 4); Y += 1) years.push(Y);
  const R = run(P, B, years), target = 30 + (2 * 57) / 2 + (8 - 2 - 1);   // the pair (B3, B9)
  const picked = R.sel.filter((s) => s.long.some((x) => x.c === target)).map((s) => s.Y), sc = score([{ name: "G-LONG", it: R.V.bookL.out }, { name: "G-SHORT", it: R.V.bookS.out }], R.sel.srSpread("2008-01", "2016-12"));
  const ok = picked.length > 0 && sc[0].verdict !== "NOT TESTABLE" && sc[0].t >= 3;
  log(` 6.2 planted (+0.3% a session after ${planted} "B9 AND B3" signals, synthetic, ${B.recs.length} records): the rule ${cname(target)} selected in ${picked.join(", ") || "no year"}; G-LONG t ${sc[0].t !== undefined ? sc[0].t.toFixed(2) : "-"} (DSR ${Number.isFinite(sc[0].dsr) ? sc[0].dsr.toFixed(2) : "-"}, ${sc[0].verdict}), G-SHORT t ${sc[1].t !== undefined ? sc[1].t.toFixed(2) : "-"}: ${ok ? "PASSED" : "FAILED"}`);
  return ok;
}
function nullCheck(B, years, seed, log) {   // 6.3 (amendment A1.1): outcomes permuted among each week's stocks (judged); each stock's outcomes shifted >= 52 weeks (reported)
  let s = seed >>> 0; const r = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), 1 | t); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const idx = new Map(B.recs.map((x, i) => [x, i])), fresh = () => B.recs.map((x) => ({ sym: x.sym, w: x.w, bits: x.bits, val: null }));
  const tOf = (recs) => { const sel = generator(B.C, recs, years), bk = book(B.C, recs, sel), vmap = new Map(recs.map((x) => [`${x.sym}|${x.w}`, x.val]));
    const it = (list) => list.map((x) => ({ date: B.C.S[B.C.W[x.w].first], v: x.side * (vmap.get(`${x.sym}|${x.w}`) ?? NaN) })).filter((x) => Number.isFinite(x.v) && x.date >= DISC[0] && x.date <= DISC[1]);
    return [nwT(monthly(it(bk.bookL))), nwT(monthly(it(bk.bookS)))]; };
  const byW = new Map(), byS = new Map(); for (const x of B.recs) if (x.val !== null) { if (!byW.has(x.w)) byW.set(x.w, []); byW.get(x.w).push(x); if (!byS.has(x.sym)) byS.set(x.sym, []); byS.get(x.sym).push(x); }
  const perm = fresh(); for (const [, xs] of byW) { const v = xs.map((x) => x.val); for (let k = v.length - 1; k > 0; k -= 1) { const j = Math.floor(r() * (k + 1)); [v[k], v[j]] = [v[j], v[k]]; } xs.forEach((x, i) => { perm[idx.get(x)].val = v[i]; }); }
  const shift = fresh(); for (const [, xs] of byS) { xs.sort((a, b) => a.w - b.w); const n = xs.length, k = n > 104 ? 52 + Math.floor(r() * (n - 104)) : Math.floor(n / 2); xs.forEach((x, i) => { shift[idx.get(x)].val = xs[(i + k) % n].val; }); }
  const [pl, ps] = tOf(perm), [sl, sh] = tOf(shift), ok = pl < 2 && ps < 2;
  log(` 6.3 null (A1.1: outcomes permuted among each week's stocks; generator re-run; 2008-2020): G-LONG t ${pl.toFixed(2)}, G-SHORT t ${ps.toFixed(2)} (both below 2): ${ok ? "PASSED" : "FAILED"}. Reported, not judged: outcomes shifted >= 52 weeks within each stock: G-LONG t ${sl.toFixed(2)}, G-SHORT t ${sh.toFixed(2)}`);
  return ok;
}
function lookahead(P, B, seed, log) {   // 6.4
  let s = seed >>> 0; const r = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), 1 | t); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const syms = [...B.F.keys()]; let n = 0, same = 0;
  for (let tries = 0; n < 3000 && tries < 300000; tries += 1) { const sym = syms[Math.floor(r() * syms.length)], f = B.F.get(sym), m = MINW + Math.floor(r() * Math.max(1, f.X.n - MINW)); if (m >= f.X.n || !f.rows[m]) continue;
    const cut = B.ST.get(sym).bars.slice(0, f.X.kLast[m] + 1), g = featuresOf(P, B.C, sym, cut); n += 1; if (JSON.stringify(g.rows[m]) === JSON.stringify(f.rows[m])) same += 1; }
  let wn = 0, wsame = 0; for (let tries = 0; wn < 100 && tries < 5000; tries += 1) { const w = 60 + Math.floor(r() * (B.C.W.length - 62)), full = weekRecords(B.C, B.F, B.ns, w); if (full.length < 30) continue;
    const last = B.C.W[w - 1].last, F2 = new Map(), u = new Set(B.C.uni.get(B.C.S[B.C.W[w].first].slice(0, 7)) || []); for (const [sym, t] of B.ST) { if (!u.has(sym)) continue; const cut = t.bars.filter((b) => B.C.sIdx.get(b.d) <= last); const g = featuresOf(P, B.C, sym, cut), mOf = new Map(); g.X.wk.forEach((x, m) => mOf.set(x, m)); F2.set(sym, { ...g, mOf }); }
    const key = (rs) => JSON.stringify(rs.map((x) => [x.sym, x.bits]).sort()); wn += 1; if (key(full) === key(weekRecords(B.C, F2, niftySig(P, B.C, w - 1), w))) wsame += 1; }
  const ok = n >= 3000 && same === n && wn >= 100 && wsame === wn;
  log(` 6.4 no look-ahead: per-stock blocks and values ${same} of ${n} stock-weeks identical after cutting; whole-week blocks (fifths, NIFTY) ${wsame} of ${wn} weeks identical: ${ok ? "PASSED" : "FAILED"}`); return ok;
}

if (require.main === module) {
  const mode = process.argv[2], lines = [], log = (x) => { lines.push(x); console.log(x); };
  const refuse = (why) => { fs.appendFileSync(path.join(HERE, "RESULT.txt"), lines.join("\n") + `\n${why}: real run refused.\n\n`); process.exit(1); };
  log(`GM STRATEGY GENERATOR: registration sha256 ${SHA.slice(0, 16)}... (verified); ${new Date().toISOString()}; mode ${mode}; ${CONDS.length} conditions x 2 sides`);
  if (!WL.check61(log)) refuse("CHECK 6.1 FAILED"); if (!check62(log)) refuse("CHECK 6.2 FAILED");
  if (mode === "--checks") process.exit(0);
  if (mode !== "--real") { console.error("usage: node run.js --checks | --real"); process.exit(1); }
  const P = load(), B = build(P), years = []; for (let Y = FIRST_Y; Y <= 2026; Y += 1) years.push(Y);
  log(`DATA: ${P.sessions.length} sessions ${P.sessions[0]} .. ${P.sessions.at(-1)}, ${B.C.W.length} weeks, ${P.stocks.length} stocks, futures for ${P.fnear.size} (NIFTY ${P.fnear.has(NIFTY) ? "yes" : "NO"}), OI for ${P.oi.size}, ${B.F.size} studied`);
  const bc = new Array(30).fill(0); for (const x of B.recs) for (let i = 0; i < 30; i += 1) if (x.bits & (1 << i)) bc[i] += 1;
  log(` 6.5 counts: ${B.recs.length} stock-weeks, ${B.recs.filter((x) => x.val !== null).length} with a GM value; block counts ` + BLOCKS.map((b, i) => `${b.split(" ")[0]} ${bc[i]}`).join(", "));
  if (!lookahead(P, B, 64, log)) refuse("CHECK 6.4 FAILED");
  const R = run(P, B, years), leak = R.sel.reduce((a, s) => a + s.leak, 0);
  log(` 6.4 training reads nothing that ends in the year it trades (counts used for ranking = direct counts of position-weeks ending before 1 Jan, all 30 blocks, every year): mismatch ${leak}: ${leak === 0 ? "PASSED" : "FAILED"}`); if (leak) refuse("CHECK 6.4 FAILED");
  if (!nullCheck(B, years, 63, log)) refuse("CHECK 6.3 FAILED");
  log(` 6.5 books: long ${R.bk.bookL.length} position-weeks (all picks ${R.bk.allL.length}), short ${R.bk.bookS.length} (all picks ${R.bk.allS.length}); dropped by price ${R.V.bookL.dropped} / ${R.V.bookS.dropped}`);
  const exps = [...new Set([...(P.fnear.get(NIFTY) || new Map()).values()].map((x) => x.e))].sort();
  const part = (v, lo, hi) => ({ it: v.out.filter((x) => x.date >= lo && x.date <= hi), holds: v.holds.filter((h) => h.date >= lo && h.date <= hi), exps });
  log(` A1.2: standard deviation of the 930 searched rules' monthly Sharpe ratios, 2008-2020: ${R.sel.spreadDisc.toFixed(4)} (the DSR benchmark's spread)`);
  const D = score([{ name: "G-LONG (book of 5)", ...part(R.V.bookL, ...DISC) }, { name: "G-SHORT (book of 5)", ...part(R.V.bookS, ...DISC) }], R.sel.spreadDisc);
  const Cf = score([{ name: "G-LONG (book of 5)", ...part(R.V.bookL, ...CONF) }, { name: "G-SHORT (book of 5)", ...part(R.V.bookS, ...CONF) }]);
  const AD = score([{ name: "all long picks", ...part(R.V.allL, ...DISC) }, { name: "all short picks", ...part(R.V.allS, ...DISC) }], R.sel.spreadDisc), AC = score([{ name: "all long picks", ...part(R.V.allL, ...CONF) }, { name: "all short picks", ...part(R.V.allS, ...CONF) }]);
  log(`\nTHE RULES THE GENERATOR PICKED EACH JANUARY (from the past only; t on its training data):`);
  for (const s of R.sel) log(`  ${s.Y} (${s.eligible} eligible): LONG ${s.long.map((x) => `${cname(x.c)} t ${x.t.toFixed(1)}`).join("; ") || "-"} | SHORT ${s.short.map((x) => `${cname(x.c)} t ${x.t.toFixed(1)}`).join("; ") || "-"}`);
  log(`\nDISCOVERY (trading weeks ${DISC[0]} .. ${DISC[1]}), GM's week on the near-month future, judged on GM EXCESS net of holding charges; Holm across 2; DSR with N = ${N_TRIALS}:`);
  for (const r of D) log(" " + fmt(r)); const cand = D.filter((r) => r.verdict === "PASS").map((r) => r.name);
  log(`DISCOVERY PASS: ${cand.join(", ") || "none"}. PROMISING: ${D.filter((r) => r.verdict === "PROMISING").map((r) => r.name).join(", ") || "none"}.`);
  log(` reported, not judged: ` + AD.map((r) => fmt(r, false)).join("\n                         "));
  log(`\nCONFIRMATION (trading weeks ${CONF[0]} .. ${CONF[1]}; the same walk-forward continuing; a discovery PASS is CONFIRMED with mean > 0 and t >= 2):`);
  for (const r of Cf) log(" " + fmt(r, false) + (cand.includes(r.name) ? (r.monthMean > 0 && r.t >= 2 ? "  -> CONFIRMED" : "  -> NOT CONFIRMED") : ""));
  log(` reported, not judged: ` + AC.map((r) => fmt(r, false)).join("\n                         "));
  const conf = Cf.filter((r) => cand.includes(r.name) && r.monthMean > 0 && r.t >= 2).map((r) => r.name);
  log(`\nCANDIDATES (discovery PASS and confirmed): ${conf.join(", ") || "none"}. A candidate goes to TRACK as a forward paper test first, never straight to the page.`);
  fs.appendFileSync(path.join(HERE, "RESULT.txt"), lines.join("\n") + "\n\n");
  const strip = (rs) => rs.map(({ g3, g4, sr, p, ...x }) => x);
  fs.writeFileSync(path.join(HERE, "result.json"), JSON.stringify({ registration: SHA, rules: R.sel.map((s) => ({ Y: s.Y, eligible: s.eligible, long: s.long.map((x) => ({ rule: cname(x.c), t: x.t })), short: s.short.map((x) => ({ rule: cname(x.c), t: x.t })) })), discovery: strip(D), confirmation: strip(Cf), allPicks: { discovery: strip(AD), confirmation: strip(AC) }, candidates: conf }, null, 1));
  process.exit(0);
}
module.exports = { BLOCKS, CONDS, featuresOf, generator, book, synthetic, build, run, score, lookahead, nullCheck, fmt, cname };
