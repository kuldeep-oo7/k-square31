"use strict";
// Implements ./PREREGISTRATION.txt (sha256 in ./PREREGISTRATION.sha256): the 09:15 lab, one batch, one run.
//   node run.js --features DIR   check 6.1, then the feature tables (real, null, planted) into DIR (the runner only)
//   python ml.py DIR             the three models, walk-forward (DIR/pred-*.csv)
//   node run.js --score DIR      checks 6.2 and 6.3, then the one real scoring (RESULT.txt, result.json: summary rows only)
// Data (private, never committed): K2_OOS_NSE = data-oos nse-old/ (cm/, fut/, idx/); K2_RESEARCH_DIR = a research/ tree
// (rising-stocks-2026-10-02/nse-data/cm, orderflow-2026-10-03/nse-fo/fut); K2_MACRO_IC = data-macro ind_close_all/.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const ROOT = path.resolve(__dirname, "..", "..");
const HERE = __dirname;
const SHA = fs.readFileSync(path.join(HERE, "PREREGISTRATION.sha256"), "utf8").split(/\s+/)[0];
if (crypto.createHash("sha256").update(fs.readFileSync(path.join(HERE, "PREREGISTRATION.txt"), "utf8").replace(/\r\n/g, "\n")).digest("hex") !== SHA) { console.error("PRE-REGISTRATION CHANGED; result void."); process.exit(2); }
const { calculateNseFuturesCharges } = require(path.join(ROOT, "api/_lib/shadow-broker"));
const ofw = require(path.join(ROOT, "api/_lib/oi-flow-forward"));

const NOTIONAL = 500000, RESET = 0.18, UNITS = 20, N_TRIALS = 344;
const DISC = ["2005-01-01", "2020-10-31"], CONF = ["2020-10-01", "2026-10-01"], SPLIT = "2020-09-01", ML_FROM = "2008-01-01";
const FEATS = ["R", "OI", "GAP", "NGAP", "NRET", "VOLR", "TREND", "VOL20", "BASIS", "NSIG", "DOW", "TOEXP", "LOGP", "LOGV", "OIREL", "PREV", "R2"];
const MEMBERS = ["F1 NIFTY gaps down", "F2 stock does not gap down", "F3 heavy volume", "F4 future at a discount", "F5 downtrend", "F6 first signal",
  "F7 not expiry week", "M1 trees", "M2 logistic", "M3 neural network"];
const nn = (x) => x === null || x === undefined || Number.isNaN(x);
const FILTERS = { [MEMBERS[0]]: (f) => (nn(f.NGAP) ? null : f.NGAP < 0), [MEMBERS[1]]: (f) => (nn(f.GAP) ? null : f.GAP >= 0), [MEMBERS[2]]: (f) => (nn(f.VOLR) ? null : f.VOLR >= 2),
  [MEMBERS[3]]: (f) => (nn(f.BASIS) ? null : f.BASIS < 0), [MEMBERS[4]]: (f) => (nn(f.TREND) ? null : f.TREND < 0), [MEMBERS[5]]: (f) => (nn(f.PREV) ? null : f.PREV === 0),
  [MEMBERS[6]]: (f) => (nn(f.TOEXP) ? null : f.TOEXP >= 7) };
const charge = (side, price, qty, d) => calculateNseFuturesCharges({ side, price, quantity: qty, asOfDate: `${d}T12:00:00Z` }).totalCharges;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

// ---------- data (as the night lab, plus volume, the stocks' near-month futures, the expiries and NIFTY's open) ----------
const jsonDays = (dir, from, to) => fs.readdirSync(dir).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x) && x.slice(0, 10) >= from && x.slice(0, 10) <= to).sort();
function readCm(dir, from, to, P) {
  for (const f of jsonDays(dir, from, to)) { const d = f.slice(0, 10); P.sessions.push(d);
    for (const [, sym, series, o, h, l, c, , v, val] of JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))) {
      if (series !== "EQ" || !sym || ![o, h, l, c].every((x) => x > 0)) continue;
      if (!P.bySym.has(sym)) P.bySym.set(sym, { sym, bars: [] }); P.bySym.get(sym).bars.push({ d, o, h, l, c, v: +v || 0, val }); } }
}
function readFut(dir, from, to, P) {
  for (const f of jsonDays(dir, from, to)) { const d = f.slice(0, 10); const byExp = new Map(), exps = new Set(), near = new Map();
    for (const r of JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))) {
      if (r[1] === "STK") { if (!P.oi.has(r[0])) P.oi.set(r[0], new Map()); const m = P.oi.get(r[0]); m.set(d, (m.get(d) || 0) + (+r[8] || 0));
        if (r[2] >= d) { exps.add(r[2]); if (r[6] > 0 && (!near.has(r[0]) || r[2] < near.get(r[0])[0])) near.set(r[0], [r[2], +r[6]]); } }
      else if (r[1] === "IDX" && r[0] === "NIFTY" && r[2] >= d && r[6] > 0) byExp.set(r[2], { o: +r[3], c: +r[6] }); }
    for (const [sym, [, c]] of near) { if (!P.futNear.has(sym)) P.futNear.set(sym, new Map()); P.futNear.get(sym).set(d, c); }
    P.expiries.set(d, [...exps].sort());
    const k = [...byExp.keys()].sort()[0];
    if (k) P.fut.set(d, { o: byExp.get(k).o, c: byExp.get(k).c, pc: P.lastFut ? (P.lastFut.byExp.get(k) || {}).c ?? null : null, pd: P.lastFut ? P.lastFut.d : null });
    P.lastFut = { d, byExp }; }
}
function readIdxJson(dir, P) { if (!fs.existsSync(dir)) return;   // nse-old/idx: { "Nifty 50": [o, h, l, c] }
  for (const f of jsonDays(dir, "0000", "9999")) { const v = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))["Nifty 50"]; if (Array.isArray(v) && v[3] > 0) P.idx.set(f.slice(0, 10), { o: v[0] > 0 ? v[0] : null, c: v[3] }); } }
const NIFTY_RE = /^(nifty 50|cnx nifty|s&p cnx nifty)$/i;
function readIdxCsv(dir, P) { if (!dir || !fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir).filter((x) => /^\d{4}-\d{2}-\d{2}\.csv$/.test(x))) { const t = fs.readFileSync(path.join(dir, f), "utf8").split(/\r?\n/).map((l) => l.split(",").map((x) => x.replace(/"/g, "").trim()));
    const io = (t[0] || []).findIndex((x) => /Open Index Value/i.test(x)), ic = (t[0] || []).findIndex((x) => /Closing Index Value/i.test(x)); const r = t.find((x) => NIFTY_RE.test(x[0] || ""));
    if (ic >= 0 && r && +r[ic] > 0) P.idx.set(f.slice(0, 10), { o: io >= 0 && +r[io] > 0 ? +r[io] : null, c: +r[ic] }); } }
function period(name) {
  const oos = path.resolve(process.env.K2_OOS_NSE || "nse-old"), R = path.resolve(process.env.K2_RESEARCH_DIR || path.join(ROOT, "research"));
  const P = { name, sessions: [], bySym: new Map(), oi: new Map(), futNear: new Map(), expiries: new Map(), fut: new Map(), idx: new Map(), lastFut: null };
  if (name === "discovery") { readCm(path.join(oos, "cm"), DISC[0], DISC[1], P); readFut(path.join(oos, "fut"), DISC[0], DISC[1], P); readIdxJson(path.join(oos, "idx"), P); Object.assign(P, { from: DISC[0], to: DISC[1] }); }
  else { const pre = new Date(Date.parse(SPLIT) - 864e5).toISOString().slice(0, 10);
    readCm(path.join(oos, "cm"), "0000", pre, P); readCm(path.join(R, "rising-stocks-2026-10-02", "nse-data", "cm"), SPLIT, CONF[1], P);
    readFut(path.join(oos, "fut"), "0000", pre, P); readFut(path.join(R, "orderflow-2026-10-03", "nse-fo", "fut"), SPLIT, CONF[1], P);
    readIdxJson(path.join(oos, "idx"), P); readIdxCsv(process.env.K2_MACRO_IC, P); Object.assign(P, { from: CONF[0], to: CONF[1] }); }
  P.stocks = [...P.bySym.values()]; delete P.bySym; delete P.lastFut; return P;
}

// ---------- context: bars by session index, NIFTY, the night lab's universe ----------
function context(P) {
  const S = P.sessions, sIdx = new Map(S.map((d, i) => [d, i])), bar = new Map();
  for (const st of P.stocks) { const m = new Map(); for (const b of st.bars) m.set(sIdx.get(b.d), b); bar.set(st.sym, m); }
  const nifty = new Map(); S.forEach((d, i) => { const ix = P.idx.get(d), fu = P.fut.get(d); if (ix || fu) nifty.set(i, { idx: ix || null, fut: fu || null }); });
  const firstOf = new Map(); S.forEach((d, i) => { if (!firstOf.has(d.slice(0, 7))) firstOf.set(d.slice(0, 7), i); });
  const months = [...firstOf.keys()], ranked = new Map(months.map((m) => [m, []]));
  for (const st of P.stocks) { const b = st.bars; let k = 0, lc = 0;
    for (const m of months) { const fd = S[firstOf.get(m)]; while (k < b.length && b[k].d < fd) { if (k > 0 && Math.abs(b[k].o / b[k - 1].c - 1) >= RESET) lc = k; k += 1; }
      if (k - lc < 250) continue; const v = b.slice(k - 60, k).map((x) => x.val).filter((x) => x > 0).sort((a, c) => a - c); if (v.length) ranked.get(m).push([st.sym, v[Math.floor(v.length / 2)]]); } }
  const uni = new Map(); for (const [m, r] of ranked) { r.sort((a, c) => c[1] - a[1]); uni.set(m, r.slice(0, 200).map((x) => x[0])); }
  return { S, sIdx, bar, nifty, uni, bc: new Map() };
}
function niftyMove(C, i) { const a = C.nifty.get(i - 1), b = C.nifty.get(i); if (!b) return null;
  if (a && a.idx && b.idx) return b.idx.c / a.idx.c - 1; if (b.fut && b.fut.pc > 0 && b.fut.pd === C.S[i - 1]) return b.fut.c / b.fut.pc - 1; return null; }
function niftyGap(C, i) { const a = C.nifty.get(i - 1), b = C.nifty.get(i); if (!b) return null;
  if (a && a.idx && b.idx && b.idx.o > 0) return b.idx.o / a.idx.c - 1; if (b.fut && b.fut.o > 0 && b.fut.pc > 0 && b.fut.pd === C.S[i - 1]) return b.fut.o / b.fut.pc - 1; return null; }
function bench(C, i) { if (C.bc.has(i)) return C.bc.get(i); const xs = [];
  for (const sym of C.uni.get(C.S[i].slice(0, 7)) || []) { const b = C.bar.get(sym).get(i); if (b) xs.push(b.c / b.o - 1); }
  const v = xs.length >= 30 ? mean(xs) : null; C.bc.set(i, v); return v; }

// ---------- the trades and their 09:15 features ----------
const windowVals = (m, lo, hi, f) => { const out = []; for (let k = lo; k <= hi; k += 1) { const b = m.get(k); if (b) out.push(f(b, k)); } return out; };
function features(C, P, sig, t) {   // only bars to d-1, F&O files to d-1, and the OPEN of d
  const i = t.i, d = C.S[i], d1 = C.S[i - 1], m = C.bar.get(t.sym), b = m.get(i), p1 = m.get(i - 1), p2 = m.get(i - 2), p3 = m.get(i - 3), o = P.oi.get(t.sym);
  const vols = windowVals(m, i - 21, i - 2, (x) => x.v), closes = windowVals(m, i - 20, i - 1, (x) => x.c);
  const rets = []; for (let k = i - 20; k <= i - 1; k += 1) { const a = m.get(k - 1), z = m.get(k); if (a && z) rets.push(z.c / a.c - 1); }
  const ois = []; if (o) for (let k = i - 20; k <= i - 1; k += 1) { const v = o.get(C.S[k]); if (v > 0) ois.push(v); }
  const fn = P.futNear.get(t.sym), fc = fn ? fn.get(d1) : undefined;
  const ex = (P.expiries.get(d1) || []).find((e) => e >= d); const st = P.stocks.find ? null : null;
  const own = sig.bySym.get(t.sym) || []; const prev = own.filter((k) => k >= i - 10 && k <= i - 1).length;
  const hist = t.bars, kk = t.k; const v60 = hist.slice(Math.max(0, kk - 60), kk).map((x) => x.val).filter((x) => x > 0).sort((a, c) => a - c);
  const sd = (a) => { const mu = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - mu) ** 2, 0) / (a.length - 1)); };
  return { R: p1 && p2 ? p1.c / p2.c - 1 : null, OI: o && o.get(d1) > 0 && o.get(C.S[i - 2]) > 0 ? o.get(d1) / o.get(C.S[i - 2]) - 1 : null, GAP: p1 ? b.o / p1.c - 1 : null,
    NGAP: niftyGap(C, i), NRET: niftyMove(C, i - 1), VOLR: vols.length >= 15 && mean(vols) > 0 && p1 ? p1.v / mean(vols) : null,
    TREND: closes.length >= 15 && p1 ? p1.c / mean(closes) - 1 : null, VOL20: rets.length >= 15 ? sd(rets) : null, BASIS: fc > 0 && p1 ? fc / p1.c - 1 : null,
    NSIG: sig.byDay.get(i) || 0, DOW: new Date(`${d}T00:00:00Z`).getUTCDay(), TOEXP: ex ? Math.round((Date.parse(ex) - Date.parse(d)) / 864e5) : null,
    LOGP: p1 ? Math.log(p1.c) : null, LOGV: v60.length ? Math.log(v60[Math.floor(v60.length / 2)]) : null, OIREL: ois.length >= 15 && o.get(d1) > 0 ? o.get(d1) / mean(ois) : null,
    PREV: prev, R2: p2 && p3 ? p2.c / p3.c - 1 : null, _st: st };
}
function table(P, C, tag) {   // every finished SB trade of the period with its features, EXCESS, net and GM rupees
  const res = ofw.forward({ sessions: P.sessions, stocks: P.stocks, oi: P.oi, rule: { ...ofw.RULE, start: "2005-01-01" } });
  const all = res.SB.trades.map((t) => ({ ...t, i: C.sIdx.get(t.entryDate) })).filter((t) => t.i !== undefined);
  const sig = { byDay: new Map(), bySym: new Map() }; for (const t of all) { sig.byDay.set(t.i, (sig.byDay.get(t.i) || 0) + 1); if (!sig.bySym.has(t.symbol)) sig.bySym.set(t.symbol, []); sig.bySym.get(t.symbol).push(t.i); }
  const barsOf = new Map(P.stocks.map((s) => [s.sym, s.bars])); const rows = [];
  for (const t of all) { if (t.status !== "DONE" || t.entryDate < P.from || t.entryDate > P.to) continue;
    if (tag === "C" && t.entryDate < CONF[0]) continue; const B = bench(C, t.i); if (B === null) continue;
    const bars = barsOf.get(t.symbol); let k = 0, hi = bars.length; while (k < hi) { const mid = (k + hi) >> 1; if (bars[mid].d < t.entryDate) k = mid + 1; else hi = mid; }
    const f = features(C, P, sig, { i: t.i, sym: t.symbol, bars, k }); delete f._st;
    const q = Math.ceil(NOTIONAL / t.entry); const net = -(t.exit / t.entry - 1) - (charge("SELL", t.entry, q, t.entryDate) + charge("BUY", t.exit, q, t.exitDate)) / (t.entry * q);
    rows.push({ id: `${tag}${rows.length}`, period: tag, date: t.entryDate, ...f, excess: net + B, net, rup: -UNITS * (t.exit - t.entry) }); }
  return rows;
}
const csv = (rows) => ["id,period,date," + FEATS.join(",") + ",excess", ...rows.map((r) => [r.id, r.period, r.date, ...FEATS.map((k) => (nn(r[k]) ? "" : r[k])), r.excess].join(","))].join("\n") + "\n";

// ---------- synthetic data for the checks ----------
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), 1 | t); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function synthMarket(seed) {   // 60 stocks, 400 sessions, futures OI and NIFTY index files, for check 6.1
  const r = rng(seed), g = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
  const sessions = []; for (let t = Date.parse("2012-01-02"); sessions.length < 400; t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) sessions.push(d.toISOString().slice(0, 10)); }
  const P = { name: "synthetic", sessions, stocks: [], oi: new Map(), futNear: new Map(), expiries: new Map(), fut: new Map(), idx: new Map(), from: sessions[0], to: sessions.at(-1) };
  for (let k = 0; k < 60; k += 1) { let px = 100 + k; const bars = [], oi = new Map(), fn = new Map(); let o = 1e6;
    for (const d of sessions) { const op = px * (1 + 0.004 * g()), c = op * (1 + 0.02 * g()); bars.push({ d, o: op, h: Math.max(op, c) * 1.005, l: Math.min(op, c) * 0.995, c, v: 1e5 * (1 + r()), val: 1e9 * (1 + r()) - k });
      o *= 1 + 0.05 * g(); oi.set(d, o); fn.set(d, c * (1 + 0.002 * g())); px = c; }
    P.stocks.push({ sym: `S${k}`, bars }); P.oi.set(`S${k}`, oi); P.futNear.set(`S${k}`, fn); }
  let lvl = 5000; for (const d of sessions) { const o = lvl * (1 + 0.003 * g()), c = o * (1 + 0.01 * g()); P.idx.set(d, { o, c }); lvl = c; P.expiries.set(d, [`${d.slice(0, 7)}-28`, `${d.slice(0, 7)}-29`].filter((e) => e >= d)); }
  return P;
}
function check61(log) {   // features of d are unchanged when everything after d's open changes
  const P = synthMarket(61), C = context(P); const rows = table(P, C, "D"); const d = rows.length ? rows[Math.floor(rows.length / 2)].date : null;
  if (!d) { log(" 6.1 timing: no synthetic trade: FAILED"); return false; }
  const Q = synthMarket(61); const r = rng(7); const di = Q.sessions.indexOf(d);
  for (const st of Q.stocks) for (const b of st.bars) { const i = Q.sessions.indexOf(b.d); if (i === di) { b.c *= 1 + 0.05 * (r() - 0.5); b.h = Math.max(b.o, b.c) * 1.01; b.l = Math.min(b.o, b.c) * 0.99; }
    if (i > di) { b.o *= 1 + 0.05 * (r() - 0.5); b.c *= 1 + 0.05 * (r() - 0.5); b.h = Math.max(b.o, b.c) * 1.01; b.l = Math.min(b.o, b.c) * 0.99; b.v *= 2 * r(); } }
  for (const [, m] of Q.oi) for (const [k, v] of m) if (k >= d) m.set(k, v * (1 + 0.1 * (r() - 0.5)));
  for (const [, m] of Q.futNear) for (const [k, v] of m) if (k >= d) m.set(k, v * (1 + 0.1 * (r() - 0.5)));
  for (const [k, v] of Q.idx) { if (k === d) v.c *= 1.03; if (k > d) { v.o *= 1.02; v.c *= 0.97; } }
  const CQ = context(Q); const rowsQ = table(Q, CQ, "D"); const a = rows.filter((x) => x.date === d), b = rowsQ.filter((x) => x.date === d);
  const same = a.length > 0 && a.length === b.length && a.every((x, k) => FEATS.every((f) => (nn(x[f]) && nn(b[k][f])) || x[f] === b[k][f]));
  log(` 6.1 timing: ${a.length} synthetic trades on ${d}; every feature unchanged after d's high, low, close and all later data changed: ${same ? "PASSED" : "FAILED"}`); return same;
}
function plantedRows(seed, kind) {   // synthetic trade tables for check 6.2 (features independent; EXCESS planted)
  const r = rng(seed), g = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); const rows = [];
  const days = []; for (let t = Date.parse("2005-01-03"); t < Date.parse("2020-10-01"); t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) days.push(d.toISOString().slice(0, 10)); }
  for (let n = 0; n < 40000; n += 1) { const f = { R: -0.02 - 0.02 * r(), OI: 0.03 + 0.08 * r(), GAP: 0.01 * g(), NGAP: 0.007 * g(), NRET: 0.01 * g(), VOLR: Math.exp(0.6 * g()), TREND: 0.04 * g(), VOL20: 0.02 * (0.5 + r()),
      BASIS: 0.003 * g(), NSIG: Math.floor(20 * r()), DOW: 1 + Math.floor(5 * r()), TOEXP: Math.floor(30 * r()), LOGP: 3 + 4 * r(), LOGV: 18 + 3 * r(), OIREL: Math.exp(0.2 * g()), PREV: Math.floor(3 * r()), R2: 0.02 * g() };
    const base = kind === "F2" ? (f.GAP >= 0 ? 0.005 : -0.005) : f.NGAP < 0 && f.VOLR >= 2 ? 0.006 : -0.002;
    rows.push({ id: `P${n}`, period: "D", date: days[Math.floor(r() * days.length)], ...f, excess: base + 0.02 * g(), net: 0, rup: 0 }); }
  return rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
function nullRows(rows, seed) {   // the 17 features shuffled among the trades of each month, labels fixed (check 6.3)
  const r = rng(seed), byM = new Map(); for (const x of rows) { const k = x.date.slice(0, 7); if (!byM.has(k)) byM.set(k, []); byM.get(k).push(x); } const out = [];
  for (const [, xs] of byM) { const fv = xs.map((x) => FEATS.map((f) => x[f])); for (let k = fv.length - 1; k > 0; k -= 1) { const j = Math.floor(r() * (k + 1)); [fv[k], fv[j]] = [fv[j], fv[k]]; }
    xs.forEach((x, k) => out.push({ ...x, id: `N${out.length}`, ...Object.fromEntries(FEATS.map((f, q) => [f, fv[k][q]])) })); }
  return out;
}

// ---------- scoring ----------
function nwT(x, lag = 3) { const n = x.length, m = mean(x); const e = x.map((v) => v - m); let s = e.reduce((a, v) => a + v * v, 0) / n;
  for (let L = 1; L <= lag; L += 1) { let g = 0; for (let i = L; i < n; i += 1) g += e[i] * e[i - L]; s += 2 * (1 - L / (lag + 1)) * (g / n); } return m / Math.sqrt(s / n); }
const sdv = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const Phi = (x) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
const invPhi = (p) => { let lo = -10, hi = 10; for (let i = 0; i < 100; i += 1) { const m = (lo + hi) / 2; if (Phi(m) < p) lo = m; else hi = m; } return (lo + hi) / 2; };
function takeOf(name, pred) { if (FILTERS[name]) return (x) => FILTERS[name](x); const k = name.slice(0, 2); return (x) => { const p = pred.get(x.id); return p ? p[k] : null; }; }
function series(rows, take) {   // monthly SPREAD (take - skip) and TAKE's own excess
  const by = new Map(); let nT = 0, nS = 0, rupT = 0, rupAll = 0;
  for (const x of rows) { const tk = take(x); rupAll += x.rup; if (tk === null || tk === undefined) continue; const k = x.date.slice(0, 7); if (!by.has(k)) by.set(k, { T: [], S: [] });
    by.get(k)[tk ? "T" : "S"].push(x.excess * 100); if (tk) { nT += 1; rupT += x.rup; } else nS += 1; }
  const keys = [...by.keys()].sort(); const spread = [], own = [];
  for (const k of keys) { const v = by.get(k); if (v.T.length) own.push(mean(v.T)); if (v.T.length && v.S.length) spread.push(mean(v.T) - mean(v.S)); }
  return { spread, own, nT, nS, rupT: Math.round(rupT), rupAll: Math.round(rupAll) };
}
function score(rows, pred, mlFrom) {
  const out = MEMBERS.map((name) => { const use = name[0] === "M" ? rows.filter((x) => x.date >= mlFrom) : rows; const s = series(use, takeOf(name, pred));
    const base = { name, taken: s.nT, skipped: s.nS, rupTake: s.rupT, rupAll: s.rupAll, ownMean: s.own.length ? mean(s.own) : null, ownT: s.own.length > 3 ? nwT(s.own) : null };
    if (s.spread.length < 24) return { ...base, months: s.spread.length, verdict: "NOT TESTABLE" };
    const m = mean(s.spread), sd = sdv(s.spread); return { ...base, months: s.spread.length, monthMean: m, t: nwT(s.spread), sr: m / sd, worst: Math.min(...s.spread),
      g3: mean(s.spread.map((v) => ((v - m) / sd) ** 3)), g4: mean(s.spread.map((v) => ((v - m) / sd) ** 4)) }; });
  const tested = out.filter((r) => r.verdict !== "NOT TESTABLE"); const N = tested.length;
  if (N) { for (const r of tested) r.p = 1 - Phi(r.t); let ok = true; tested.slice().sort((a, b) => a.p - b.p).forEach((r, i) => { r.holm = ok && r.p <= 0.05 / (N - i); if (!r.holm) ok = false; });
    const g = 0.5772156649, SR0 = (N > 1 ? sdv(tested.map((r) => r.sr)) : 0) * ((1 - g) * invPhi(1 - 1 / N_TRIALS) + g * invPhi(1 - 1 / (N_TRIALS * Math.E)));
    for (const r of tested) { const den = 1 - r.g3 * r.sr + ((r.g4 - 1) / 4) * r.sr ** 2; r.dsr = den > 0 ? Phi(((r.sr - SR0) * Math.sqrt(r.months - 1)) / Math.sqrt(den)) : NaN;
      r.verdict = r.monthMean > 0 && r.t >= 3 && r.holm && r.dsr >= 0.95 ? "PASS" : r.monthMean > 0 && r.t >= 2 ? "PROMISING" : "FAIL"; } }
  return out;
}
const sgn = (x, d = 3) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}`;
const fmt = (r, judged = true) => r.verdict === "NOT TESTABLE" ? `${r.name.padEnd(27)} NOT TESTABLE (${r.months} months)`
  : `${r.name.padEnd(27)} take ${String(r.taken).padStart(6)} / skip ${String(r.skipped).padStart(6)} | ${String(r.months).padStart(3)} months | spread ${sgn(r.monthMean)}% | worst ${sgn(r.worst, 2)}% | t ${r.t.toFixed(2)}`
    + (judged ? ` | Holm ${r.holm ? "y" : "n"} | DSR ${Number.isFinite(r.dsr) ? r.dsr.toFixed(2) : "-"} -> ${r.verdict}` : "") + ` | take's own excess ${r.ownMean === null ? "-" : sgn(r.ownMean)}% (t ${r.ownT === null ? "-" : r.ownT.toFixed(2)})`;
const readPred = (f) => { const m = new Map(); const L = fs.readFileSync(f, "utf8").trim().split(/\r?\n/); const h = L[0].split(",");
  for (const l of L.slice(1)) { const v = l.split(","); const o = Object.fromEntries(h.map((k, q) => [k, v[q]])); m.set(o.id, { M1: o.take1 === "1", M2: o.take2 === "1", M3: o.take3 === "1" }); } return m; };

if (require.main === module) {
  const mode = process.argv[2], DIR = path.resolve(process.argv[3] || "work"); const lines = [], log = (x) => { lines.push(x); console.log(x); };
  const refuse = (why) => { fs.appendFileSync(path.join(HERE, "RESULT.txt"), lines.join("\n") + `\n${why}: real run refused.\n\n`); process.exit(1); };
  if (mode === "--features") {
    log(`09:15 LAB features: registration sha256 ${SHA.slice(0, 16)}... (verified); ${new Date().toISOString()}`); if (!check61(log)) refuse("CHECK 6.1 FAILED");
    fs.mkdirSync(DIR, { recursive: true });
    const D = period("discovery"), CD = context(D); const rd = table(D, CD, "D");
    log(`DISCOVERY DATA: ${D.sessions.length} sessions ${D.sessions[0]} .. ${D.sessions.at(-1)}, ${D.stocks.length} stocks; ${rd.length} SB trades with features`);
    const F = period("confirmation"), CF = context(F); const rc = table(F, CF, "C");
    log(`CONFIRMATION DATA: ${F.sessions.length} sessions ${F.sessions[0]} .. ${F.sessions.at(-1)}, ${F.stocks.length} stocks; ${rc.length} SB trades with features`);
    log(" missing features (discovery / confirmation): " + FEATS.map((k) => `${k} ${rd.filter((x) => nn(x[k])).length}/${rc.filter((x) => nn(x[k])).length}`).join(", "));
    const real = [...rd, ...rc], nul = nullRows(rd, 63), pl = plantedRows(62, "M1");
    for (const [n, rows] of [["real", real], ["null", nul], ["planted", pl]]) { fs.writeFileSync(path.join(DIR, `${n}.csv`), csv(rows)); fs.writeFileSync(path.join(DIR, `${n}.json`), JSON.stringify(rows)); }
    fs.appendFileSync(path.join(DIR, "log.txt"), lines.join("\n") + "\n"); console.log("features written (runner only)"); process.exit(0); }
  if (mode === "--synthetic") {   // a dry run of check 6.2 alone, on synthetic data only (no market data is read)
    fs.mkdirSync(DIR, { recursive: true }); const pl = plantedRows(62, "M1"); fs.writeFileSync(path.join(DIR, "planted.csv"), csv(pl)); fs.writeFileSync(path.join(DIR, "planted.json"), JSON.stringify(pl)); process.exit(0); }
  if (mode === "--planted") {
    const f2 = series(plantedRows(62, "F2"), takeOf(MEMBERS[1], null)).spread; const pm = JSON.parse(fs.readFileSync(path.join(DIR, "planted.json"), "utf8")), pp = readPred(path.join(DIR, "pred-planted.csv"));
    const m1 = series(pm.filter((x) => x.date >= ML_FROM), takeOf(MEMBERS[7], pp)).spread, m2 = series(pm.filter((x) => x.date >= ML_FROM), takeOf(MEMBERS[8], pp)).spread, m3 = series(pm.filter((x) => x.date >= ML_FROM), takeOf(MEMBERS[9], pp)).spread;
    console.log(`synthetic dry run of 6.2: F2 t ${nwT(f2).toFixed(2)}; M1 t ${nwT(m1).toFixed(2)} (M2 t ${nwT(m2).toFixed(2)}, M3 t ${nwT(m3).toFixed(2)}, reported only)`); process.exit(0); }
  if (mode === "--score") {
    lines.push(...fs.readFileSync(path.join(DIR, "log.txt"), "utf8").trim().split("\n")); log("CHECKS 6.2-6.3:");
    const f2 = series(plantedRows(62, "F2"), takeOf(MEMBERS[1], null)).spread, t2 = nwT(f2); const pm = JSON.parse(fs.readFileSync(path.join(DIR, "planted.json"), "utf8")), pp = readPred(path.join(DIR, "pred-planted.csv"));
    const m1 = series(pm.filter((x) => x.date >= ML_FROM), takeOf(MEMBERS[7], pp)).spread, t1 = nwT(m1); const ok62 = t2 >= 3 && t1 >= 3;
    log(` 6.2 planted: F2 finds the gap edge (t ${t2.toFixed(2)}), M1 finds the NIFTY-gap x volume edge (t ${t1.toFixed(2)}): ${ok62 ? "PASSED" : "FAILED"}`); if (!ok62) refuse("CHECK 6.2 FAILED");
    const nr = JSON.parse(fs.readFileSync(path.join(DIR, "null.json"), "utf8")), np = readPred(path.join(DIR, "pred-null.csv")); const ns = score(nr, np, ML_FROM); const passes = ns.filter((r) => r.verdict === "PASS").length;
    log(` 6.3 null (features shuffled within each month): ${passes} PASS of ${ns.filter((r) => r.verdict !== "NOT TESTABLE").length} (at most 1): ${passes <= 1 ? "PASSED" : "FAILED"}`); if (passes > 1) refuse("CHECK 6.3 FAILED");
    const real = JSON.parse(fs.readFileSync(path.join(DIR, "real.json"), "utf8")), pr = readPred(path.join(DIR, "pred-real.csv"));
    const rd = score(real.filter((x) => x.period === "D"), pr, ML_FROM), rc = score(real.filter((x) => x.period === "C"), pr, ML_FROM);   // both computed before anything is shown
    log(`\nDISCOVERY ${DISC[0]} .. ${DISC[1]} (M1-M3 from ${ML_FROM.slice(0, 4)}): monthly SPREAD = take's mean excess - skip's, %; Holm across ${rd.filter((r) => r.verdict !== "NOT TESTABLE").length}; DSR with N = ${N_TRIALS}:`);
    for (const r of rd) log(" " + fmt(r)); const cand = rd.filter((r) => r.verdict === "PASS").map((r) => r.name);
    log(`DISCOVERY PASS: ${cand.join(", ") || "none"}. PROMISING: ${rd.filter((r) => r.verdict === "PROMISING").map((r) => r.name).join(", ") || "none"}.`);
    log(`\nCONFIRMATION ${CONF[0]} .. ${CONF[1]} (every member reported; a discovery PASS is CONFIRMED with spread > 0 and t >= 2):`);
    for (const r of rc) log(" " + fmt(r, false) + (cand.includes(r.name) ? (r.monthMean > 0 && r.t >= 2 ? "  -> CONFIRMED" : "  -> NOT CONFIRMED") : ""));
    log(` GM rupees at ${UNITS} units, gross, 2020-2026 (reported, not judged): all SB Rs ${rc[0].rupAll.toLocaleString("en-IN")}; take only: ` + rc.map((r) => `${r.name.split(" ")[0]} Rs ${r.rupTake.toLocaleString("en-IN")}`).join(", "));
    const conf = rc.filter((r) => cand.includes(r.name) && r.monthMean > 0 && r.t >= 2).map((r) => r.name);
    log(`\nCANDIDATES (discovery PASS and confirmed): ${conf.join(", ") || "none"}. A candidate goes to TRACK as a forward paper test first, never straight to FUTURES.`);
    fs.appendFileSync(path.join(HERE, "RESULT.txt"), lines.join("\n") + "\n\n");
    const strip = (rs) => rs.map(({ g3, g4, sr, p, ...r }) => r); fs.writeFileSync(path.join(HERE, "result.json"), JSON.stringify({ registration: SHA, discovery: strip(rd), confirmation: strip(rc), candidates: conf }, null, 1));
    process.exit(0); }
  console.error("usage: node run.js --features DIR | --score DIR"); process.exit(1);
}
module.exports = { FEATS, MEMBERS, features, table, context, synthMarket, plantedRows, nullRows, series, score, check61, csv };
