"use strict";
// Implements ./PREREGISTRATION.txt and ./AMENDMENT-A1.txt (each with its .sha256): the night lab, one batch, one run.
//   node run.js --checks       checks 5.1-5.3 only (5.3 needs the discovery data); nothing is scored
//   node run.js                the real run: checks, discovery 2005-2020, confirmation 2020-2026 (RESULT.txt, result.json)
// Data (private, never committed): K2_OOS_NSE = data-oos nse-old/ (cm/, fut/, idx/); K2_RESEARCH_DIR = a research/ tree
// (rising-stocks-2026-10-02/nse-data/cm and orderflow-2026-10-03/nse-fo/fut, both from 2020-09-01); K2_MACRO_IC = data-macro
// ind_close_all/ (NSE index closes 2014-2026). Output: summary rows only (the repository is public).
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const ROOT = path.resolve(__dirname, "..", "..");
const HERE = __dirname;
const SHA = {};
for (const f of ["PREREGISTRATION", "AMENDMENT-A1"]) { SHA[f] = fs.readFileSync(path.join(HERE, `${f}.sha256`), "utf8").split(/\s+/)[0];
  const got = crypto.createHash("sha256").update(fs.readFileSync(path.join(HERE, `${f}.txt`), "utf8").replace(/\r\n/g, "\n")).digest("hex");
  if (got !== SHA[f]) { console.error(`${f}.txt CHANGED; result void.`); process.exit(2); } }
const { calculateNseFuturesCharges } = require(path.join(ROOT, "api/_lib/shadow-broker"));
const ofw = require(path.join(ROOT, "api/_lib/oi-flow-forward"));

const NOTIONAL = 500000, RESET = 0.18, SLIP = 0.001, UNITS = 20, N_TRIALS = 317;
const DISC = ["2005-01-01", "2020-10-31"], CONF = ["2020-10-01", "2026-10-01"], SPLIT = "2020-09-01";
const MEMBERS = ["S1 stop +1.0%", "S2 stop +1.5%", "S3 stop +2.0%", "S4 stop +3.0%", "S5 SB after a NIFTY down day", "S6 SB two sessions", "S7 SB strong signal",
  "C1 squeeze long", "P1 MAX long-short", "P2 MAX low tenth long", "P3 high-volume long-short", "P4 high-volume long", "P5 same-month seasonality",
  "P6 tug of war intraday", "P7 tug of war overnight", "P8 pre-holiday NIFTY", "P9 lead-lag small caps"];
const SB_GROUP = new Set(MEMBERS.slice(0, 8));
const STOPS = { [MEMBERS[0]]: 0.01, [MEMBERS[1]]: 0.015, [MEMBERS[2]]: 0.02, [MEMBERS[3]]: 0.03 };
const charge = (side, price, qty, d) => calculateNseFuturesCharges({ side, price, quantity: qty, asOfDate: `${d}T12:00:00Z` }).totalCharges;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

// ---------- data ----------
const jsonDays = (dir, from, to) => fs.readdirSync(dir).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x) && x.slice(0, 10) >= from && x.slice(0, 10) <= to).sort();
function readCm(dir, from, to, P) {   // EQ bars; val kept raw, as scripts/springy-dip-forward.js loadCm (SB's own universe reads it)
  for (const f of jsonDays(dir, from, to)) { const d = f.slice(0, 10); P.sessions.push(d);
    for (const [, sym, series, o, h, l, c, , v, val] of JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))) {
      if (series !== "EQ" || !sym || ![o, h, l, c].every((x) => x > 0)) continue;
      if (!P.bySym.has(sym)) P.bySym.set(sym, { sym, bars: [] }); P.bySym.get(sym).bars.push({ d, o, h, l, c, v: +v || 0, val }); } }
}
function readFut(dir, from, to, P) {   // stock futures OI summed over expiries; the near-month NIFTY future and THE SAME contract's previous close (A1)
  for (const f of jsonDays(dir, from, to)) { const d = f.slice(0, 10); const byExp = new Map();
    for (const r of JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))) {
      if (r[1] === "STK") { if (!P.oi.has(r[0])) P.oi.set(r[0], new Map()); const m = P.oi.get(r[0]); m.set(d, (m.get(d) || 0) + (+r[8] || 0)); }
      else if (r[1] === "IDX" && r[0] === "NIFTY" && r[2] >= d && r[6] > 0) byExp.set(r[2], r[6]); }
    const near = [...byExp.keys()].sort()[0];
    if (near) P.fut.set(d, { c: byExp.get(near), pc: P.lastFut ? P.lastFut.byExp.get(near) ?? null : null, pd: P.lastFut ? P.lastFut.d : null });
    P.lastFut = { d, byExp }; }
}
function readIdxJson(dir, P) { if (!fs.existsSync(dir)) return;   // nse-old/idx: { "Nifty 50": [o, h, l, c] }
  for (const f of jsonDays(dir, "0000", "9999")) { const v = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))["Nifty 50"]; if (Array.isArray(v) && v[3] > 0) P.idx.set(f.slice(0, 10), v[3]); } }
const NIFTY_RE = /^(nifty 50|cnx nifty|s&p cnx nifty)$/i;   // NIFTY 50's names in NSE's ind_close_all over the years
function readIdxCsv(dir, P) { if (!dir || !fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir).filter((x) => /^\d{4}-\d{2}-\d{2}\.csv$/.test(x))) { const t = fs.readFileSync(path.join(dir, f), "utf8").split(/\r?\n/).map((l) => l.split(",").map((x) => x.replace(/"/g, "").trim()));
    const ic = (t[0] || []).findIndex((x) => /Closing Index Value/i.test(x)); const r = t.find((x) => NIFTY_RE.test(x[0] || "")); if (ic >= 0 && r && +r[ic] > 0) P.idx.set(f.slice(0, 10), +r[ic]); } }
function period(name) {
  const oos = path.resolve(process.env.K2_OOS_NSE || "nse-old"), R = path.resolve(process.env.K2_RESEARCH_DIR || path.join(ROOT, "research"));
  const P = { name, sessions: [], bySym: new Map(), oi: new Map(), fut: new Map(), idx: new Map(), lastFut: null };
  if (name === "discovery") { readCm(path.join(oos, "cm"), DISC[0], DISC[1], P); readFut(path.join(oos, "fut"), DISC[0], DISC[1], P); readIdxJson(path.join(oos, "idx"), P); Object.assign(P, { from: DISC[0], to: DISC[1] }); }
  else { const pre = new Date(Date.parse(SPLIT) - 864e5).toISOString().slice(0, 10);   // A1: data-oos before 2020-09-01 as look-back only
    readCm(path.join(oos, "cm"), "0000", pre, P); readCm(path.join(R, "rising-stocks-2026-10-02", "nse-data", "cm"), SPLIT, CONF[1], P);
    readFut(path.join(oos, "fut"), "0000", pre, P); readFut(path.join(R, "orderflow-2026-10-03", "nse-fo", "fut"), SPLIT, CONF[1], P);
    readIdxJson(path.join(oos, "idx"), P); readIdxCsv(process.env.K2_MACRO_IC, P); Object.assign(P, { from: CONF[0], to: CONF[1] }); }
  P.stocks = [...P.bySym.values()]; delete P.bySym; delete P.lastFut; return P;
}

// ---------- the engine: a book is { legs: [{ sym, side }], i (entry session), h, kind, stop?, excess?, longShort?, paired? } ----------
// kind "oc": open of session i -> close of session i+h-1; "co": close of i -> open of i+1; "cc" (NIFTY only): close of i-1 -> close of i
function context(P) {
  const S = P.sessions, sIdx = new Map(S.map((d, i) => [d, i])), bar = new Map();
  for (const st of P.stocks) { const m = new Map(); for (const b of st.bars) m.set(sIdx.get(b.d), b); bar.set(st.sym, m); }
  const nifty = new Map(); S.forEach((d, i) => { const ix = P.idx.get(d), fu = P.fut.get(d); if (ix || fu) nifty.set(i, { idx: ix || null, fut: fu || null }); });
  const firstOf = new Map(); S.forEach((d, i) => { if (!firstOf.has(d.slice(0, 7))) firstOf.set(d.slice(0, 7), i); });
  const months = [...firstOf.keys()], ranked = new Map(months.map((m) => [m, []]));
  for (const st of P.stocks) { const b = st.bars; let k = 0, lc = 0;   // one pass per stock: k = bars before the month, lc = its last reset bar
    for (const m of months) { const fd = S[firstOf.get(m)]; while (k < b.length && b[k].d < fd) { if (k > 0 && Math.abs(b[k].o / b[k - 1].c - 1) >= RESET) lc = k; k += 1; }
      if (k - lc < 250) continue; const v = b.slice(k - 60, k).map((x) => x.val).filter((x) => x > 0).sort((a, c) => a - c); if (v.length) ranked.get(m).push([st.sym, v[Math.floor(v.length / 2)]]); } }
  const uni = new Map(); for (const [m, r] of ranked) { r.sort((a, c) => c[1] - a[1]); uni.set(m, r.slice(0, 200).map((x) => x[0])); }
  const lastOf = new Map(); months.forEach((m, k) => lastOf.set(m, k + 1 < months.length ? firstOf.get(months[k + 1]) - 1 : S.length - 1));
  return { S, sIdx, bar, nifty, uni, firstOf, lastOf, months, bc: new Map() };
}
function niftyMove(C, i) {   // A1: NIFTY's close-to-close move into session i, or null
  const a = C.nifty.get(i - 1), b = C.nifty.get(i); if (!b) return null;
  if (a && a.idx && b.idx) return b.idx / a.idx - 1;
  if (b.fut && b.fut.pc > 0 && b.fut.pd === C.S[i - 1]) return b.fut.c / b.fut.pc - 1;
  return null;
}
function legFill(C, sym, side, i, h, kind, stop) {   // { e, x, d, xd } of one leg, or null (no bar, a missed session or a reset)
  if (sym === "NIFTY") { const mv = kind === "cc" ? niftyMove(C, i) : null; if (mv === null) return null; const a = C.nifty.get(i - 1), b = C.nifty.get(i);
    const e = a && a.idx && b.idx ? a.idx : b.fut.pc; return { e, x: e * (1 + mv), d: C.S[i - 1], xd: C.S[i] }; }
  const m = C.bar.get(sym); if (!m) return null;
  if (kind === "co") { const a = m.get(i), b = m.get(i + 1); if (!a || !b || Math.abs(b.o / a.c - 1) >= RESET) return null; return { e: a.c, x: b.o, d: C.S[i], xd: C.S[i + 1] }; }
  const first = m.get(i); if (!first) return null; let last = first;
  for (let k = i + 1; k <= i + h - 1; k += 1) { const b = m.get(k), p = m.get(k - 1); if (!b || Math.abs(b.o / p.c - 1) >= RESET) return null; last = b; }
  if (stop && h === 1) { const lvl = side < 0 ? first.o * (1 + stop) : first.o * (1 - stop);
    if (side < 0 ? first.h >= lvl : first.l <= lvl) return { e: first.o, x: side < 0 ? lvl * (1 + SLIP) : lvl * (1 - SLIP), d: C.S[i], xd: C.S[i] }; }
  return { e: first.o, x: last.c, d: C.S[i], xd: C.S[i + h - 1] };
}
function finish(side, e, x, d, xd) {   // net return after NSE futures charges on both legs, plus a roll round trip per month end crossed
  const q = Math.ceil(NOTIONAL / e); const cross = (+xd.slice(0, 4) - +d.slice(0, 4)) * 12 + (+xd.slice(5, 7) - +d.slice(5, 7));
  return side * (x / e - 1) - (charge(side > 0 ? "BUY" : "SELL", e, q, d) + charge(side > 0 ? "SELL" : "BUY", x, q, xd) + cross * (charge("BUY", x, q, xd) + charge("SELL", x, q, xd))) / (e * q);
}
const legRet = (C, sym, side, i, h, kind, stop) => { const f = legFill(C, sym, side, i, h, kind, stop); return f ? finish(side, f.e, f.x, f.d, f.xd) : null; };
function bench(C, i, h) {   // the equal-weighted universe return, open of i to close of i+h-1 (gross, long side); >= 30 names
  const key = `${i}|${h}`; if (C.bc.has(key)) return C.bc.get(key); const xs = [];
  for (const sym of C.uni.get(C.S[i].slice(0, 7)) || []) { const m = C.bar.get(sym); const a = m.get(i), b = m.get(i + h - 1); if (!a || !b) continue;
    let ok = true; for (let k = i + 1; k <= i + h - 1; k += 1) if (!m.get(k)) ok = false; if (ok) xs.push(b.c / a.o - 1); }
  const v = xs.length >= 30 ? mean(xs) : null; C.bc.set(key, v); return v;
}
function tradeValue(C, t) {   // { net, excess } of a book
  const L = [], Sh = []; for (const g of t.legs) { const r = legRet(C, g.sym, g.side, t.i, t.h, t.kind, t.stop); if (r === null) continue; (g.side > 0 ? L : Sh).push(r); }
  if (!L.length && !Sh.length) return null; if (t.longShort && (!L.length || !Sh.length)) return null;
  const net = t.longShort ? (mean(L) + mean(Sh)) / 2 : mean([...L, ...Sh]);
  let excess = null; if (t.excess) { const B = bench(C, t.i, t.h); if (B === null) return null; excess = net - t.legs[0].side * B; }
  return { net, excess };
}

// ---------- members ----------
function sbTrades(P, C) {   // SB exactly as oi-flow-forward.js; R and OI of the signal day for S7
  const res = ofw.forward({ sessions: P.sessions, stocks: P.stocks, oi: P.oi, rule: { ...ofw.RULE, start: P.from } });
  return res.SB.trades.filter((t) => t.status === "DONE" && t.entryDate <= P.to).map((t) => { const i = C.sIdx.get(t.entryDate), m = C.bar.get(t.symbol); const p1 = m.get(i - 1), p2 = m.get(i - 2);
    const o = P.oi.get(t.symbol); return { sym: t.symbol, i, R: p1 && p2 ? p1.c / p2.c - 1 : null, OI: o && p1 && p2 && o.get(p2.d) > 0 ? o.get(p1.d) / o.get(p2.d) - 1 : null }; });
}
function members(P, C) {
  const T = new Map(MEMBERS.map((m) => [m, []])), add = (m, t) => T.get(m).push(t), S = C.S, inSample = (i) => i >= 0 && i < S.length && S[i] >= P.from && S[i] <= P.to;
  for (const x of sbTrades(P, C).filter((y) => inSample(y.i))) { const base = { legs: [{ sym: x.sym, side: -1 }], i: x.i, h: 1, kind: "oc" };
    for (const [m, y] of Object.entries(STOPS)) add(m, { ...base, stop: y, paired: true });
    const mv = niftyMove(C, x.i - 1); if (mv !== null && mv < 0) add(MEMBERS[4], { ...base, excess: true });
    add(MEMBERS[5], { ...base, h: 2, excess: true });
    if (x.R !== null && x.OI !== null && x.R <= -0.03 && x.OI >= 0.06) add(MEMBERS[6], { ...base, excess: true });
    const b = C.bar.get(x.sym).get(x.i); if (b && b.c > b.o && inSample(x.i + 1)) add(MEMBERS[7], { legs: [{ sym: x.sym, side: 1 }], i: x.i + 1, h: 1, kind: "oc", excess: true }); }
  // monthly books: P1/P2 MAX, P5 seasonality, P6/P7 tug of war
  const bar = (sym, i) => C.bar.get(sym).get(i), monthRet = new Map(), tenth = (n) => Math.floor(n / 10);
  const mret = (sym, m) => { const k = `${sym}|${m}`; if (monthRet.has(k)) return monthRet.get(k); const fi = C.firstOf.get(m), li = C.lastOf.get(m); const a = bar(sym, fi - 1), z = bar(sym, li); let v = null;
    if (a && z) { let p = a, clean = true; for (let i = fi; i <= li; i += 1) { const b = bar(sym, i); if (!b) continue; if (Math.abs(b.o / p.c - 1) >= RESET) { clean = false; break; } p = b; } if (clean) v = z.c / a.c - 1; }   // A1 item 5
    monthRet.set(k, v); return v; };
  for (let mi = 1; mi < C.months.length; mi += 1) { const m = C.months[mi], prev = C.months[mi - 1]; const fi = C.firstOf.get(m), li = C.lastOf.get(m), pf = C.firstOf.get(prev);
    if (!inSample(fi)) continue; const U = C.uni.get(m) || []; if (U.length < 100) continue; const h = li - fi + 1;
    const mx = []; for (const sym of U) { let best = null; for (let i = pf; i <= fi - 1; i += 1) { const a = bar(sym, i - 1), b = bar(sym, i); if (a && b) best = best === null ? b.c / a.c - 1 : Math.max(best, b.c / a.c - 1); } if (best !== null) mx.push([sym, best]); }
    if (mx.length >= 100) { mx.sort((a, b) => a[1] - b[1]); const k = tenth(mx.length); const lo = mx.slice(0, k).map((x) => x[0]), hi = mx.slice(-k).map((x) => x[0]);
      add(MEMBERS[8], { legs: [...lo.map((sym) => ({ sym, side: 1 })), ...hi.map((sym) => ({ sym, side: -1 }))], i: fi, h, kind: "oc", longShort: true });
      add(MEMBERS[9], { legs: lo.map((sym) => ({ sym, side: 1 })), i: fi, h, kind: "oc", excess: true }); }
    const sea = []; for (const sym of U) { const r = []; for (let y = 1; y <= 5; y += 1) { const mm = `${+m.slice(0, 4) - y}-${m.slice(5, 7)}`; if (!C.firstOf.has(mm)) break; const v = mret(sym, mm); if (v === null) break; r.push(v); } if (r.length === 5) sea.push([sym, mean(r)]); }
    if (sea.length >= 100) { sea.sort((a, b) => a[1] - b[1]); const k = tenth(sea.length);
      add(MEMBERS[12], { legs: [...sea.slice(-k).map((x) => ({ sym: x[0], side: 1 })), ...sea.slice(0, k).map((x) => ({ sym: x[0], side: -1 }))], i: fi, h, kind: "oc", longShort: true }); }
    const ov = []; for (const sym of U) { let s = 0, n = 0; for (let i = pf; i <= fi - 1; i += 1) { const a = bar(sym, i - 1), b = bar(sym, i); if (a && b) { s += Math.log(b.o / a.c); n += 1; } } if (n >= 10) ov.push([sym, s]); }
    if (ov.length >= 100) { ov.sort((a, b) => a[1] - b[1]); const k = tenth(ov.length); const top = ov.slice(-k).map((x) => x[0]), bot = ov.slice(0, k).map((x) => x[0]);
      for (let i = fi; i <= li; i += 1) { add(MEMBERS[13], { legs: [...bot.map((sym) => ({ sym, side: 1 })), ...top.map((sym) => ({ sym, side: -1 }))], i, h: 1, kind: "oc", longShort: true });
        if (i + 1 < S.length) add(MEMBERS[14], { legs: [...top.map((sym) => ({ sym, side: 1 })), ...bot.map((sym) => ({ sym, side: -1 }))], i, h: 1, kind: "co", longShort: true }); } } }
  // P3/P4 high-volume premium: non-overlapping 50-session intervals from the sample's first session; formation day = the 50th
  const s0 = S.findIndex((d) => d >= P.from);
  for (let a = s0; a + 69 < S.length; a += 50) { const f = a + 49; if (!inSample(f + 1)) continue; const U = C.uni.get(S[f].slice(0, 7)) || []; const hiV = [], loV = [];
    for (const sym of U) { const vols = []; for (let i = a; i <= f; i += 1) { const b = bar(sym, i); if (!b) break; vols.push(b.v); } if (vols.length < 50) continue;
      const vf = vols[49]; if (vols.filter((v) => v < vf).length >= 45) hiV.push(sym); else if (vols.filter((v) => v > vf).length >= 45) loV.push(sym); }
    if (hiV.length && loV.length) add(MEMBERS[10], { legs: [...hiV.map((sym) => ({ sym, side: 1 })), ...loV.map((sym) => ({ sym, side: -1 }))], i: f + 1, h: 20, kind: "oc", longShort: true });
    if (hiV.length) add(MEMBERS[11], { legs: hiV.map((sym) => ({ sym, side: 1 })), i: f + 1, h: 20, kind: "oc", excess: true }); }
  // P8 pre-holiday NIFTY (session i is pre-holiday when the next weekday is not a session); P9 lead-lag small caps
  for (let i = 2; i < S.length; i += 1) { if (!inSample(i)) continue;
    const nx = new Date(`${S[i]}T00:00:00Z`); do { nx.setUTCDate(nx.getUTCDate() + 1); } while (nx.getUTCDay() === 0 || nx.getUTCDay() === 6); const nwd = nx.toISOString().slice(0, 10);
    if (nwd <= S[S.length - 1] && !C.sIdx.has(nwd) && niftyMove(C, i) !== null) add(MEMBERS[15], { legs: [{ sym: "NIFTY", side: 1 }], i, h: 1, kind: "cc" });
    const mv = niftyMove(C, i - 1); if (mv !== null && Math.abs(mv) >= 0.01) { const U = C.uni.get(S[i].slice(0, 7)) || []; const small = U.slice(Math.floor((U.length * 2) / 3));
      if (small.length >= 30) add(MEMBERS[16], { legs: small.map((sym) => ({ sym, side: mv > 0 ? 1 : -1 })), i, h: 1, kind: "oc" }); } }
  return T;
}

// ---------- scoring ----------
function nwT(x, lag = 3) { const n = x.length, m = mean(x); const e = x.map((v) => v - m); let s = e.reduce((a, v) => a + v * v, 0) / n;
  for (let L = 1; L <= lag; L += 1) { let g = 0; for (let i = L; i < n; i += 1) g += e[i] * e[i - L]; s += 2 * (1 - L / (lag + 1)) * (g / n); } return m / Math.sqrt(s / n); }
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const Phi = (x) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
const invPhi = (p) => { let lo = -10, hi = 10; for (let i = 0; i < 100; i += 1) { const m = (lo + hi) / 2; if (Phi(m) < p) lo = m; else hi = m; } return (lo + hi) / 2; };
function score(C, T) {
  const rows = MEMBERS.map((name) => { const ts = T.get(name) || []; const month = new Map(); let n = 0, won = 0, rup = 0, rupBase = 0;
    for (const t of ts) { let v; const g = t.legs[0];
      if (t.paired) { const fa = legFill(C, g.sym, -1, t.i, 1, "oc", t.stop), fb = legFill(C, g.sym, -1, t.i, 1, "oc", null); if (!fa || !fb) continue;
        v = finish(-1, fa.e, fa.x, fa.d, fa.xd) - finish(-1, fb.e, fb.x, fb.d, fb.xd); rup -= UNITS * (fa.x - fa.e); rupBase -= UNITS * (fb.x - fb.e); }
      else { const r = tradeValue(C, t); if (!r) continue; v = t.excess ? r.excess : r.net;
        if (SB_GROUP.has(name)) { const f = legFill(C, g.sym, g.side, t.i, t.h, t.kind, t.stop); if (f) rup += g.side * UNITS * (f.x - f.e); } }
      n += 1; if (v > 0) won += 1; const k = C.S[t.i].slice(0, 7); if (!month.has(k)) month.set(k, []); month.get(k).push(v * 100); }
    const s = [...month.keys()].sort().map((k) => mean(month.get(k))); const extra = SB_GROUP.has(name) ? { rupees: Math.round(rup), ...(STOPS[name] ? { rupeesBase: Math.round(rupBase) } : {}) } : {};
    if (s.length < 24) return { name, trades: n, months: s.length, verdict: "NOT TESTABLE", ...extra };
    const m = mean(s), sdev = sd(s); return { name, trades: n, months: s.length, win: (100 * won) / n, monthMean: m, worstMonth: Math.min(...s), t: nwT(s), sr: m / sdev,
      g3: mean(s.map((v) => ((v - m) / sdev) ** 3)), g4: mean(s.map((v) => ((v - m) / sdev) ** 4)), ...extra }; });
  const tested = rows.filter((r) => r.verdict !== "NOT TESTABLE"); const N = tested.length;
  if (N) { for (const r of tested) r.p = 1 - Phi(r.t); let ok = true; tested.slice().sort((a, b) => a.p - b.p).forEach((r, i) => { r.holm = ok && r.p <= 0.05 / (N - i); if (!r.holm) ok = false; });
    const g = 0.5772156649, SR0 = (N > 1 ? sd(tested.map((r) => r.sr)) : 0) * ((1 - g) * invPhi(1 - 1 / N_TRIALS) + g * invPhi(1 - 1 / (N_TRIALS * Math.E)));
    for (const r of tested) { const den = 1 - r.g3 * r.sr + ((r.g4 - 1) / 4) * r.sr ** 2; r.dsr = den > 0 ? Phi(((r.sr - SR0) * Math.sqrt(r.months - 1)) / Math.sqrt(den)) : NaN;
      r.verdict = r.monthMean > 0 && r.t >= 3 && r.holm && r.dsr >= 0.95 ? "PASS" : r.monthMean > 0 && r.t >= 2 ? "PROMISING" : "FAIL"; } }
  return rows;
}
const sgn = (x, d = 3) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}`;
const fmt = (r, judged = true) => r.verdict === "NOT TESTABLE" ? `${r.name.padEnd(29)} NOT TESTABLE (${r.months} months, ${r.trades} trades)`
  : `${r.name.padEnd(29)} ${String(r.trades).padStart(6)} trades | ${String(r.months).padStart(3)} months | ${sgn(r.monthMean)}% a month | won ${r.win.toFixed(0)}% | worst month ${sgn(r.worstMonth, 2)}% | t ${r.t.toFixed(2)}`
    + (judged ? ` | Holm ${r.holm ? "y" : "n"} | DSR ${Number.isFinite(r.dsr) ? r.dsr.toFixed(2) : "-"} -> ${r.verdict}` : "");

// ---------- checks ----------
function check51(log) {
  const C = { S: ["2026-01-05"], nifty: new Map(), bar: new Map([["X", new Map([[0, { d: "2026-01-05", o: 100, h: 101.5, l: 99, c: 100.5 }]])], ["Y", new Map([[0, { d: "2026-01-05", o: 100, h: 101.4, l: 98, c: 99 }]])]]) };
  const a = legRet(C, "X", -1, 0, 1, "oc", 0.015), b = legRet(C, "Y", -1, 0, 1, "oc", 0.015);
  const ea = finish(-1, 100, 101.5 * 1.001, "2026-01-05", "2026-01-05"), eb = finish(-1, 100, 99, "2026-01-05", "2026-01-05"); const ok = Math.abs(a - ea) < 1e-12 && Math.abs(b - eb) < 1e-12;
  log(` 5.1 hand-built stop (S2): high 101.5 -> bought back at 101.5 x 1.001 (net ${(a * 100).toFixed(3)}%); high 101.4 -> covered at the close 99 (net ${(b * 100).toFixed(3)}%): ${ok ? "PASSED" : "FAILED"}`); return ok;
}
function synth(seed, plant) {   // a synthetic market: 220 stocks; with plant, last month's highest-MAX tenth loses 2% more this month
  let s = seed >>> 0; const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), 1 | t); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const sessions = []; for (let t = Date.parse("2008-01-01"); sessions.length < 1600; t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) sessions.push(d.toISOString().slice(0, 10)); }
  const NS = 220, px = Array(NS).fill(100), bars = Array.from({ length: NS }, () => []), maxCur = Array(NS).fill(-1), losers = new Set(); let mCur = sessions[0].slice(0, 7);
  for (const d of sessions) { if (d.slice(0, 7) !== mCur) { mCur = d.slice(0, 7); losers.clear(); if (plant) for (const [k] of maxCur.map((v, k) => [k, v]).sort((a, b) => b[1] - a[1]).slice(0, 22)) losers.add(k); maxCur.fill(-1); }
    for (let k = 0; k < NS; k += 1) { const r = (losers.has(k) ? -0.02 / 21 : 0) + 0.015 * gauss(); const o = px[k] * (1 + 0.002 * gauss()), c = o * (1 + r);
      bars[k].push({ d, o, h: Math.max(o, c) * 1.003, l: Math.min(o, c) * 0.997, c, v: 1e5 * (1 + rnd()), val: 1e9 * (1 + rnd()) }); maxCur[k] = Math.max(maxCur[k], c / px[k] - 1); px[k] = c; } }
  return { name: "synthetic", sessions, stocks: bars.map((b, k) => ({ sym: `S${k}`, bars: b })), oi: new Map(), idx: new Map(), fut: new Map(), from: sessions[300], to: sessions[sessions.length - 1] };
}
function check52(log) { const P = synth(52, true), C = context(P); const r = score(C, members(P, C)).find((x) => x.name === MEMBERS[8]); const ok = !!r && r.verdict !== "NOT TESTABLE" && r.t >= 3;
  log(` 5.2 planted MAX edge (top tenth -2% a month): P1 ${r && r.verdict !== "NOT TESTABLE" ? `t ${r.t.toFixed(2)}, ${sgn(r.monthMean)}% a month` : "not testable"}: ${ok ? "PASSED" : "FAILED"}`); return ok; }
function check53(C, T, log) {   // every member's books moved to random discovery sessions (same counts, sides, holds)
  let s = 53 >>> 0; const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), 1 | t); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const lo = Math.max(0, C.S.findIndex((d) => d >= DISC[0])), hi = C.S.length - 25; const R = new Map();
  for (const [m, ts] of T) R.set(m, ts.map((t) => ({ ...t, i: lo + 2 + Math.floor(rnd() * (hi - lo - 2)) })));
  const rows = score(C, R), passes = rows.filter((r) => r.verdict === "PASS").length;
  log(` 5.3 re-dated null on the discovery data: ${passes} PASS of ${rows.filter((r) => r.verdict !== "NOT TESTABLE").length} (at most 1 allowed): ${passes <= 1 ? "PASSED" : "FAILED"}`); return passes <= 1;
}
const dataLine = (P, C) => `${P.sessions.length} sessions ${P.sessions[0]} .. ${P.sessions.at(-1)}, ${P.stocks.length} stocks, futures OI for ${P.oi.size}; NIFTY: index close on ${P.idx.size} days, futures fallback on ${[...C.nifty.values()].filter((v) => !v.idx && v.fut).length}`;
const strip = (rows) => rows.map(({ g3, g4, sr, p, ...r }) => r);

if (require.main === module) {
  const lines = [], log = (x) => { lines.push(x); console.log(x); };
  const refuse = (why) => { fs.appendFileSync(path.join(HERE, "RESULT.txt"), lines.join("\n") + `\n${why}: real run refused.\n\n`); process.exit(1); };
  const checksOnly = process.argv.includes("--checks");
  log(`NIGHT LAB${checksOnly ? " (checks only)" : ""}: registration sha256 ${SHA.PREREGISTRATION.slice(0, 16)}..., amendment A1 ${SHA["AMENDMENT-A1"].slice(0, 16)}... (both verified); run ${new Date().toISOString()}`);
  log("CHECKS:"); if (!check51(log)) refuse("CHECK 5.1 FAILED"); if (!check52(log)) refuse("CHECK 5.2 FAILED");
  const oos = path.resolve(process.env.K2_OOS_NSE || "nse-old"), R = path.resolve(process.env.K2_RESEARCH_DIR || path.join(ROOT, "research"));   // every input present before anything real is computed
  for (const d of [path.join(oos, "cm"), path.join(oos, "fut"), path.join(oos, "idx"), path.join(R, "rising-stocks-2026-10-02", "nse-data", "cm"), path.join(R, "orderflow-2026-10-03", "nse-fo", "fut"), process.env.K2_MACRO_IC])
    if (!d || !fs.existsSync(d) || !fs.readdirSync(d).length) { console.error(`MISSING INPUT ${d || "K2_MACRO_IC"}: nothing computed.`); process.exit(3); }
  const rd =(() => { const D = period("discovery"), C = context(D); log(`DISCOVERY DATA: ${dataLine(D, C)}`); const T = members(D, C);
    log(" books: " + MEMBERS.map((m) => `${m.split(" ")[0]} ${T.get(m).length}`).join(", ")); if (!check53(C, T, log)) refuse("CHECK 5.3 FAILED"); return checksOnly ? null : score(C, T); })();
  if (checksOnly) { console.log("checks only: nothing scored, nothing written"); process.exit(0); }
  log(`\nDISCOVERY ${DISC[0]} .. ${DISC[1]} (monthly mean %, net of charges; S1-S4 = stop minus base SB on the same trades; S5-S7, C1, P2, P4 = excess over the universe; Holm across ${rd.filter((r) => r.verdict !== "NOT TESTABLE").length}; DSR with N = ${N_TRIALS}):`);
  for (const r of rd) log(" " + fmt(r));
  const cand = rd.filter((r) => r.verdict === "PASS").map((r) => r.name);
  log(`DISCOVERY PASS: ${cand.join(", ") || "none"}. PROMISING: ${rd.filter((r) => r.verdict === "PROMISING").map((r) => r.name).join(", ") || "none"}.`);
  const rf = (() => { const F = period("confirmation"), C = context(F); log(`\nCONFIRMATION DATA: ${dataLine(F, C)}`); return score(C, members(F, C)); })();
  log(`CONFIRMATION ${CONF[0]} .. ${CONF[1]} (every member reported; a discovery PASS is CONFIRMED with mean > 0 and t >= 2):`);
  for (const r of rf) log(" " + fmt(r, false) + (cand.includes(r.name) ? (r.monthMean > 0 && r.t >= 2 ? "  -> CONFIRMED" : "  -> NOT CONFIRMED") : ""));
  log(` GM rupees at ${UNITS} units, gross before charges, ${CONF[0]} .. ${CONF[1]} (reported, not judged): ` + rf.filter((r) => r.rupees !== undefined).map((r) => `${r.name.split(" ")[0]} Rs ${r.rupees.toLocaleString("en-IN")}${r.rupeesBase !== undefined ? ` (base SB on the same trades Rs ${r.rupeesBase.toLocaleString("en-IN")})` : ""}`).join("; "));
  const conf = rf.filter((r) => cand.includes(r.name) && r.monthMean > 0 && r.t >= 2).map((r) => r.name);
  log(`\nCANDIDATES (discovery PASS and confirmed): ${conf.join(", ") || "none"}. A candidate goes to TRACK as a forward paper test first, never straight to FUTURES.`);
  fs.appendFileSync(path.join(HERE, "RESULT.txt"), lines.join("\n") + "\n\n");
  fs.writeFileSync(path.join(HERE, "result.json"), JSON.stringify({ registration: SHA.PREREGISTRATION, amendmentA1: SHA["AMENDMENT-A1"], discovery: strip(rd), confirmation: strip(rf), candidates: conf }, null, 1));
}
module.exports = { MEMBERS, legFill, legRet, finish, niftyMove, members, score, context, synth };
