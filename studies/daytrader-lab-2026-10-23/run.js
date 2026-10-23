"use strict";
// Implements ./PREREGISTRATION.txt (sha256 in ./PREREGISTRATION.sha256): the AI day-trader lab, one batch, one run.
//   node run.js --features DIR   check 7.1, then the tables (real, null, planted) into DIR (the runner only)
//   python ml.py DIR             the three models, walk-forward (DIR/pred-*.csv)
//   node run.js --score DIR      checks 7.2 and 7.3, then the one real scoring (RESULT.txt, result.json: summary rows only)
//   node run.js --synthetic DIR  the planted table only (a dry run of 7.2 reads no market data)
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

const NOTIONAL = 500000, RESET = 0.18, N_TRIALS = 370, ML_FROM = "2008-01-01";
const DISC = ["2005-01-01", "2020-10-31"], CONF = ["2020-10-01", "2026-10-01"], SPLIT = "2020-09-01";
const FEATS = ["R1", "R5", "R20", "GAP", "NGAP", "NRET", "OI1", "OI5", "VOLR", "VOL20", "BASIS", "TREND", "HL", "CLV", "DOW", "TOEXP", "LOGP", "LOGV"];
const MEMBERS = ["A1 trees long-short", "A2 trees long only", "A3 trees short only", "A4 logistic long-short", "A5 neural network long-short"];
const nn = (x) => x === null || x === undefined || Number.isNaN(x);
const charge = (side, price, qty, d) => calculateNseFuturesCharges({ side, price, quantity: qty, asOfDate: `${d}T12:00:00Z` }).totalCharges;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

// ---------- data (as the futures lab) ----------
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
        if (r[2] >= d) { exps.add(r[2]); const o = Number(r[3]), c = Number(r[6]); if (o > 0 && c > 0 && (!near.has(r[0]) || r[2] < near.get(r[0]).e)) near.set(r[0], { e: r[2], o, c }); } }
      else if (r[1] === "IDX" && r[0] === "NIFTY" && r[2] >= d && r[6] > 0) byExp.set(r[2], { o: +r[3], c: +r[6] }); }
    for (const [sym, v] of near) { if (!P.fnear.has(sym)) P.fnear.set(sym, new Map()); P.fnear.get(sym).set(d, v); }
    P.expiries.set(d, [...exps].sort());
    const k = [...byExp.keys()].sort()[0];
    if (k) P.fut.set(d, { o: byExp.get(k).o, c: byExp.get(k).c, pc: P.lastFut ? (P.lastFut.byExp.get(k) || {}).c ?? null : null, pd: P.lastFut ? P.lastFut.d : null });
    P.lastFut = { d, byExp }; }
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
  const P = { name, sessions: [], bySym: new Map(), oi: new Map(), fnear: new Map(), expiries: new Map(), fut: new Map(), idx: new Map(), lastFut: null };
  if (name === "discovery") { readCm(path.join(oos, "cm"), DISC[0], DISC[1], P); readFut(path.join(oos, "fut"), DISC[0], DISC[1], P); readIdxJson(path.join(oos, "idx"), P); Object.assign(P, { from: DISC[0], to: DISC[1] }); }
  else { const pre = new Date(Date.parse(SPLIT) - 864e5).toISOString().slice(0, 10);
    readCm(path.join(oos, "cm"), "0000", pre, P); readCm(path.join(R, "rising-stocks-2026-10-02", "nse-data", "cm"), SPLIT, CONF[1], P);
    readFut(path.join(oos, "fut"), "0000", pre, P); readFut(path.join(R, "orderflow-2026-10-03", "nse-fo", "fut"), SPLIT, CONF[1], P);
    readIdxJson(path.join(oos, "idx"), P); readIdxCsv(process.env.K2_MACRO_IC, P); Object.assign(P, { from: CONF[0], to: CONF[1] }); }
  P.stocks = [...P.bySym.values()]; delete P.bySym; delete P.lastFut; return P;
}
function context(P) {
  const S = P.sessions, sIdx = new Map(S.map((d, i) => [d, i])), bar = new Map();
  for (const st of P.stocks) { const m = new Map(); for (const b of st.bars) m.set(sIdx.get(b.d), b); bar.set(st.sym, m); }
  const nifty = new Map(); S.forEach((d, i) => { const ix = P.idx.get(d), fu = P.fut.get(d); if (ix || fu) nifty.set(i, { idx: ix || null, fut: fu || null }); });
  const firstOf = new Map(); S.forEach((d, i) => { if (!firstOf.has(d.slice(0, 7))) firstOf.set(d.slice(0, 7), i); });
  const months = [...firstOf.keys()], ranked = new Map(months.map((m) => [m, []])), k60 = new Map();
  for (const st of P.stocks) { const b = st.bars; let k = 0, lc = 0;
    for (const m of months) { const fd = S[firstOf.get(m)]; while (k < b.length && b[k].d < fd) { if (k > 0 && Math.abs(b[k].o / b[k - 1].c - 1) >= RESET) lc = k; k += 1; }
      if (k - lc < 250) continue; const v = b.slice(k - 60, k).map((x) => x.val).filter((x) => x > 0).sort((a, c) => a - c); if (v.length) ranked.get(m).push([st.sym, v[Math.floor(v.length / 2)]]); } }
  const uni = new Map(); for (const [m, r] of ranked) { r.sort((a, c) => c[1] - a[1]); uni.set(m, r.slice(0, 200)); }
  return { S, sIdx, bar, nifty, uni, k60 };
}
function niftyMove(C, i) { const a = C.nifty.get(i - 1), b = C.nifty.get(i); if (!b) return null;
  if (a && a.idx && b.idx) return b.idx.c / a.idx.c - 1; if (b.fut && b.fut.pc > 0 && b.fut.pd === C.S[i - 1]) return b.fut.c / b.fut.pc - 1; return null; }
function niftyGap(C, i) { const a = C.nifty.get(i - 1), b = C.nifty.get(i); if (!b) return null;
  if (a && a.idx && b.idx && b.idx.o > 0) return b.idx.o / a.idx.c - 1; if (b.fut && b.fut.o > 0 && b.fut.pc > 0 && b.fut.pd === C.S[i - 1]) return b.fut.o / b.fut.pc - 1; return null; }

// ---------- one stock-day's 18 features (only bars to d-1, F&O files to d-1, and the share's and NIFTY's OPEN of d) ----------
function features(P, C, sym, i) {
  const S = C.S, m = C.bar.get(sym), b = m.get(i), p = (k) => m.get(i - k), o = P.oi.get(sym), d1 = S[i - 1];
  const r = (a, z) => (p(a) && p(z) ? p(a).c / p(z).c - 1 : null);
  const vols = [], closes = [], rets = []; for (let k = i - 21; k <= i - 2; k += 1) { const x = m.get(k); if (x) vols.push(x.v); }
  for (let k = i - 20; k <= i - 1; k += 1) { const x = m.get(k), y = m.get(k - 1); if (x) closes.push(x.c); if (x && y) rets.push(x.c / y.c - 1); }
  const oiAt = (k) => (o ? o.get(S[i - k]) : undefined); const fn = P.fnear.get(sym), f1 = fn ? fn.get(d1) : undefined, ex = (P.expiries.get(d1) || []).find((e) => e >= S[i]);
  const sd = (a) => { const mu = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - mu) ** 2, 0) / (a.length - 1)); }; const q = p(1);
  const v60 = []; for (let k = i - 1; k >= 0 && v60.length < 60 && k >= i - 90; k -= 1) { const x = m.get(k); if (x && x.val > 0) v60.push(x.val); } v60.sort((a, c) => a - c);   // the stock's last 60 bars before d
  const medVal = v60.length ? v60[Math.floor(v60.length / 2)] : null;
  return { R1: r(1, 2), R5: r(1, 6), R20: r(1, 21), GAP: q ? b.o / q.c - 1 : null, NGAP: niftyGap(C, i), NRET: niftyMove(C, i - 1),
    OI1: oiAt(1) > 0 && oiAt(2) > 0 ? oiAt(1) / oiAt(2) - 1 : null, OI5: oiAt(1) > 0 && oiAt(6) > 0 ? oiAt(1) / oiAt(6) - 1 : null,
    VOLR: vols.length >= 15 && mean(vols) > 0 && q ? q.v / mean(vols) : null, VOL20: rets.length >= 15 ? sd(rets) : null, BASIS: f1 && q ? f1.c / q.c - 1 : null,
    TREND: closes.length >= 15 && q ? q.c / mean(closes) - 1 : null, HL: q ? (q.h - q.l) / q.c : null, CLV: q && q.h > q.l ? (q.c - q.l) / (q.h - q.l) : null,
    DOW: new Date(`${S[i]}T00:00:00Z`).getUTCDay(), TOEXP: ex ? Math.round((Date.parse(ex) - Date.parse(S[i])) / 864e5) : null, LOGP: q ? Math.log(q.c) : null, LOGV: medVal > 0 ? Math.log(medVal) : null };
}
function table(P, C, tag) {   // every universe stock-day with a near-month future: features, futures open and close, label
  const S = C.S, rows = []; let id = 0;
  for (let i = 22; i < S.length; i += 1) { const d = S[i]; if (d < P.from || d > P.to || (tag === "C" && d < CONF[0])) continue; const day = [];
    for (const [sym] of C.uni.get(d.slice(0, 7)) || []) { const f = P.fnear.get(sym) && P.fnear.get(sym).get(d); if (!f || !C.bar.get(sym).get(i)) continue;
      const sb = C.bar.get(sym).get(i); day.push({ id: `${tag}${id++}`, period: tag, date: d, fo: f.o, fc: f.c, so: sb.o, sc: sb.c, ...features(P, C, sym, i) }); }
    if (day.length < 30) continue; const B = mean(day.map((x) => x.fc / x.fo - 1)); for (const x of day) { x.excess = x.fc / x.fo - 1 - B; rows.push(x); } }
  return rows;
}
const csv = (rows) => ["id,period,date," + FEATS.join(",") + ",excess", ...rows.map((r) => [r.id, r.period, r.date, ...FEATS.map((k) => (nn(r[k]) ? "" : r[k])), r.excess].join(","))].join("\n") + "\n";
const bookCsv = (rows) => ["id,period,date,fo,fc,so,sc,gap", ...rows.map((r) => [r.id, r.period, r.date, r.fo, r.fc, r.so ?? "", r.sc ?? "", nn(r.GAP) ? "" : r.GAP].join(","))].join("\n") + "\n";

// ---------- synthetic data for the checks ----------
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), 1 | t); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function synthMarket(seed) {   // 60 stocks, 400 sessions, futures and NIFTY, for check 7.1
  const r = rng(seed), g = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
  const sessions = []; for (let t = Date.parse("2012-01-02"); sessions.length < 400; t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) sessions.push(d.toISOString().slice(0, 10)); }
  const P = { name: "synthetic", sessions, stocks: [], oi: new Map(), fnear: new Map(), expiries: new Map(), fut: new Map(), idx: new Map(), from: sessions[0], to: sessions.at(-1) };
  for (let k = 0; k < 60; k += 1) { let px = 100 + k; const bars = [], oi = new Map(), fn = new Map(); let o = 1e6;
    for (const d of sessions) { const op = px * (1 + 0.004 * g()), c = op * (1 + 0.02 * g()); bars.push({ d, o: op, h: Math.max(op, c) * 1.005, l: Math.min(op, c) * 0.995, c, v: 1e5 * (1 + r()), val: 1e9 * (1 + r()) - k });
      o *= 1 + 0.05 * g(); oi.set(d, o); fn.set(d, { e: `${d.slice(0, 7)}-28`, o: op * 1.001, c: c * 1.001 }); px = c; }
    P.stocks.push({ sym: `S${k}`, bars }); P.oi.set(`S${k}`, oi); P.fnear.set(`S${k}`, fn); }
  let lvl = 5000; for (const d of sessions) { const o = lvl * (1 + 0.003 * g()), c = o * (1 + 0.01 * g()); P.idx.set(d, { o, c }); lvl = c; P.expiries.set(d, [`${d.slice(0, 7)}-28`, `${d.slice(0, 7)}-29`].filter((e) => e >= d)); }
  return P;
}
function check71(log) {
  const P = synthMarket(71), C = context(P), rows = table(P, C, "D"); const d = rows.length ? rows[Math.floor(rows.length / 2)].date : null; if (!d) { log(" 7.1 timing: no synthetic rows: FAILED"); return false; }
  const Q = synthMarket(71), r = rng(7), di = Q.sessions.indexOf(d);
  for (const st of Q.stocks) for (const b of st.bars) { const i = Q.sessions.indexOf(b.d); if (i === di) { b.c *= 1 + 0.05 * (r() - 0.5); b.h = Math.max(b.o, b.c) * 1.01; b.l = Math.min(b.o, b.c) * 0.99; }
    if (i > di) { b.o *= 1 + 0.05 * (r() - 0.5); b.c *= 1 + 0.05 * (r() - 0.5); b.h = Math.max(b.o, b.c) * 1.01; b.l = Math.min(b.o, b.c) * 0.99; b.v *= 2 * r(); } }
  for (const [, m] of Q.oi) for (const [k, v] of m) if (k >= d) m.set(k, v * (1 + 0.1 * (r() - 0.5)));
  for (const [, m] of Q.fnear) for (const [k, v] of m) if (k > d) m.set(k, { ...v, o: v.o * 1.02, c: v.c * 0.98 }); else if (k === d) m.set(k, { ...v, c: v.c * 0.97 });
  for (const [k, v] of Q.idx) { if (k === d) v.c *= 1.03; if (k > d) { v.o *= 1.02; v.c *= 0.97; } }
  const rowsQ = table(Q, context(Q), "D"); const a = rows.filter((x) => x.date === d), b = rowsQ.filter((x) => x.date === d);
  const same = a.length > 0 && a.length === b.length && a.every((x, k) => FEATS.every((f) => (nn(x[f]) && nn(b[k][f])) || x[f] === b[k][f]));
  log(` 7.1 timing: ${a.length} synthetic stock-days on ${d}; every feature unchanged after d's high, low, close and all later data changed: ${same ? "PASSED" : "FAILED"}`); return same;
}
function plantedRows(seed) {   // 120 stocks a day, 2005-2020: excess +0.6% when GAP < 0 and OI1 > 0.03, else -0.1%; noise 2%
  const r = rng(seed), g = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); const rows = []; let id = 0;
  for (let t = Date.parse("2005-01-03"); t < Date.parse("2020-10-01"); t += 864e5) { const day = new Date(t); if (!(day.getUTCDay() % 6) || r() < 0.4) continue; const d = day.toISOString().slice(0, 10);
    for (let k = 0; k < 120; k += 1) { const f = { R1: 0.02 * g(), R5: 0.04 * g(), R20: 0.08 * g(), GAP: 0.01 * g(), NGAP: 0.007 * g(), NRET: 0.01 * g(), OI1: 0.05 * g(), OI5: 0.1 * g(), VOLR: Math.exp(0.5 * g()), VOL20: 0.02 * (0.5 + r()),
        BASIS: 0.003 * g(), TREND: 0.04 * g(), HL: 0.03 * r(), CLV: r(), DOW: day.getUTCDay(), TOEXP: Math.floor(30 * r()), LOGP: 3 + 4 * r(), LOGV: 18 + 3 * r() };
      const x = (f.GAP < 0 && f.OI1 > 0.03 ? 0.006 : -0.001) + 0.02 * g(); rows.push({ id: `P${id++}`, period: "D", date: d, fo: 100, fc: 100 * (1 + x), ...f, excess: x }); } }
  return rows;
}
function nullRows(rows, seed) { const r = rng(seed), byD = new Map(); for (const x of rows) { if (!byD.has(x.date)) byD.set(x.date, []); byD.get(x.date).push(x); } const out = [];
  for (const [, xs] of byD) { const fv = xs.map((x) => FEATS.map((f) => x[f])); for (let k = fv.length - 1; k > 0; k -= 1) { const j = Math.floor(r() * (k + 1)); [fv[k], fv[j]] = [fv[j], fv[k]]; }
    xs.forEach((x, k) => out.push({ ...x, id: `N${out.length}`, ...Object.fromEntries(FEATS.map((f, q) => [f, fv[k][q]])) })); } return out; }

// ---------- books and scoring ----------
function readBook(f) { const out = []; const L = fs.readFileSync(f, "utf8").split("\n"); for (const l of L.slice(1)) { if (!l) continue; const [id, period, date, fo, fc, so, sc, gap] = l.split(",");
  out.push({ id, period, date, fo: +fo, fc: +fc, so: so ? +so : null, sc: sc ? +sc : null, gap: gap ? +gap : null }); } return out; }
function readPred(f) { const m = new Map(); const L = fs.readFileSync(f, "utf8").split("\n"); for (const l of L.slice(1)) { if (!l) continue; const [id, p1, p2, p3] = l.split(","); m.set(id, [+p1, +p2, +p3]); } return m; }
const legNet = (side, o, c, d) => { const q = Math.ceil(NOTIONAL / o); return side * (c / o - 1) - (charge(side > 0 ? "BUY" : "SELL", o, q, d) + charge(side > 0 ? "SELL" : "BUY", c, q, d)) / (o * q); };
function books(rows, pred) {   // daily books for the five members; value in %
  const byD = new Map(); for (const x of rows) { if (x.date < ML_FROM) continue; const p = pred.get(x.id); if (!p) continue; if (!byD.has(x.date)) byD.set(x.date, []); byD.get(x.date).push({ ...x, p }); }
  const out = new Map(MEMBERS.map((m) => [m, []]));
  for (const [d, xs] of [...byD].sort()) { if (xs.length < 50) continue; const k = Math.floor(xs.length / 10), B = mean(xs.map((x) => x.fc / x.fo - 1));
    for (const [mi, col] of [[0, 0], [3, 1], [4, 2]]) { const s = xs.slice().sort((a, b) => a.p[col] - b.p[col] || (a.id < b.id ? -1 : 1)); const L = s.slice(-k), Sh = s.slice(0, k);
      const ln = mean(L.map((x) => legNet(1, x.fo, x.fc, d))), sn = mean(Sh.map((x) => legNet(-1, x.fo, x.fc, d)));
      out.get(MEMBERS[mi]).push({ date: d, v: ((ln + sn) / 2) * 100, k }); if (mi === 0) { out.get(MEMBERS[1]).push({ date: d, v: (ln - B) * 100, k }); out.get(MEMBERS[2]).push({ date: d, v: (sn + B) * 100, k }); } } }
  return out;
}
function nwT(x, lag = 3) { const n = x.length, m = mean(x); const e = x.map((v) => v - m); let s = e.reduce((a, v) => a + v * v, 0) / n;
  for (let L = 1; L <= lag; L += 1) { let g = 0; for (let i = L; i < n; i += 1) g += e[i] * e[i - L]; s += 2 * (1 - L / (lag + 1)) * (g / n); } return m / Math.sqrt(s / n); }
const sdv = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const Phi = (x) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
const invPhi = (p) => { let lo = -10, hi = 10; for (let i = 0; i < 100; i += 1) { const m = (lo + hi) / 2; if (Phi(m) < p) lo = m; else hi = m; } return (lo + hi) / 2; };
function score(bk) {
  const out = MEMBERS.map((name) => { const it = bk.get(name) || []; const by = new Map(); for (const x of it) { const k = x.date.slice(0, 7); if (!by.has(k)) by.set(k, []); by.get(k).push(x.v); }
    const s = [...by.keys()].sort().map((k) => mean(by.get(k))); const base = { name, books: it.length, perSide: it.length ? +(mean(it.map((x) => x.k))).toFixed(1) : 0, win: it.length ? (100 * it.filter((x) => x.v > 0).length) / it.length : 0, perDay: it.length ? mean(it.map((x) => x.v)) : null };
    if (s.length < 24) return { ...base, months: s.length, verdict: "NOT TESTABLE" }; const m = mean(s), sd = sdv(s);
    return { ...base, months: s.length, monthMean: m, worstMonth: Math.min(...s), t: nwT(s), sr: m / sd, g3: mean(s.map((v) => ((v - m) / sd) ** 3)), g4: mean(s.map((v) => ((v - m) / sd) ** 4)) }; });
  const tested = out.filter((r) => r.verdict !== "NOT TESTABLE"); const N = tested.length;
  if (N) { for (const r of tested) r.p = 1 - Phi(r.t); let ok = true; tested.slice().sort((a, b) => a.p - b.p).forEach((r, i) => { r.holm = ok && r.p <= 0.05 / (N - i); if (!r.holm) ok = false; });
    const g = 0.5772156649, SR0 = (N > 1 ? sdv(tested.map((r) => r.sr)) : 0) * ((1 - g) * invPhi(1 - 1 / N_TRIALS) + g * invPhi(1 - 1 / (N_TRIALS * Math.E)));
    for (const r of tested) { const den = 1 - r.g3 * r.sr + ((r.g4 - 1) / 4) * r.sr ** 2; r.dsr = den > 0 ? Phi(((r.sr - SR0) * Math.sqrt(r.months - 1)) / Math.sqrt(den)) : NaN;
      r.verdict = r.monthMean > 0 && r.t >= 3 && r.holm && r.dsr >= 0.95 ? "PASS" : r.monthMean > 0 && r.t >= 2 ? "PROMISING" : "FAIL"; } }
  return out;
}
const sgn = (x, d = 3) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}`;
const fmt = (r, judged = true) => (r.verdict === "NOT TESTABLE" ? `${r.name.padEnd(29)} NOT TESTABLE (${r.months} months)` : `${r.name.padEnd(29)} ${String(r.books).padStart(5)} days | ${String(r.perSide).padStart(4)} a side | ${String(r.months).padStart(3)} months | ${sgn(r.perDay)}% a day | won ${r.win.toFixed(0)}% | worst month ${sgn(r.worstMonth, 2)}% | t ${r.t.toFixed(2)}`
  + (judged ? ` | Holm ${r.holm ? "y" : "n"} | DSR ${Number.isFinite(r.dsr) ? r.dsr.toFixed(2) : "-"} -> ${r.verdict}` : ""));

if (require.main === module) {
  const mode = process.argv[2], DIR = path.resolve(process.argv[3] || "work"); const lines = [], log = (x) => { lines.push(x); console.log(x); };
  const refuse = (why) => { fs.appendFileSync(path.join(HERE, "RESULT.txt"), lines.join("\n") + `\n${why}: real run refused.\n\n`); process.exit(1); };
  const write = (name, rows) => { fs.writeFileSync(path.join(DIR, `${name}.csv`), csv(rows)); fs.writeFileSync(path.join(DIR, `${name}-book.csv`), bookCsv(rows)); };
  if (mode === "--synthetic") { fs.mkdirSync(DIR, { recursive: true }); write("planted", plantedRows(72)); console.log("planted table written"); process.exit(0); }
  if (mode === "--features") {
    log(`AI DAY-TRADER LAB features: registration sha256 ${SHA.slice(0, 16)}... (verified); ${new Date().toISOString()}`); if (!check71(log)) refuse("CHECK 7.1 FAILED");
    fs.mkdirSync(DIR, { recursive: true }); let real = [], disc = null;
    for (const [name, tag] of [["discovery", "D"], ["confirmation", "C"]]) { const P = period(name), C = context(P), rows = table(P, C, tag);
      log(`${name.toUpperCase()} DATA: ${P.sessions.length} sessions ${P.sessions[0]} .. ${P.sessions.at(-1)}, ${P.stocks.length} stocks, futures for ${P.fnear.size}; ${rows.length} stock-days on ${new Set(rows.map((x) => x.date)).size} days`);
      real = real.concat(rows); if (tag === "D") disc = rows; }
    log(" missing features: " + FEATS.map((k) => `${k} ${real.filter((x) => nn(x[k])).length}`).join(", "));
    write("real", real); write("null", nullRows(disc, 73)); write("planted", plantedRows(72));
    fs.appendFileSync(path.join(DIR, "log.txt"), lines.join("\n") + "\n"); console.log("tables written (runner only)"); process.exit(0); }
  if (mode === "--score" || mode === "--planted") {
    if (mode === "--score") lines.push(...fs.readFileSync(path.join(DIR, "log.txt"), "utf8").trim().split("\n")); log("CHECKS 7.2-7.3:");
    const bp = score(books(readBook(path.join(DIR, "planted-book.csv")), readPred(path.join(DIR, "pred-planted.csv")))).find((x) => x.name === MEMBERS[0]); const ok72 = bp.verdict !== "NOT TESTABLE" && bp.t >= 3;
    log(` 7.2 planted (GAP < 0 and OI1 > 0.03): A1 t ${bp.t !== undefined ? bp.t.toFixed(2) : "-"}, ${bp.perDay !== null ? sgn(bp.perDay) : "-"}% a day: ${ok72 ? "PASSED" : "FAILED"}`);
    if (mode === "--planted") process.exit(0); if (!ok72) refuse("CHECK 7.2 FAILED");
    const ns = score(books(readBook(path.join(DIR, "null-book.csv")), readPred(path.join(DIR, "pred-null.csv")))), passes = ns.filter((r) => r.verdict === "PASS").length;
    log(` 7.3 null (features shuffled within each day): ${passes} PASS of ${ns.filter((r) => r.verdict !== "NOT TESTABLE").length} (at most 1): ${passes <= 1 ? "PASSED" : "FAILED"}`); if (passes > 1) refuse("CHECK 7.3 FAILED");
    const all = readBook(path.join(DIR, "real-book.csv")), pr = readPred(path.join(DIR, "pred-real.csv"));
    const rd = score(books(all.filter((x) => x.period === "D"), pr)), rc = score(books(all.filter((x) => x.period === "C"), pr));   // both computed before anything is shown
    log(`\nDISCOVERY ${ML_FROM} .. ${DISC[1]} (daily books on futures, monthly mean of %; A2, A3 vs the universe's futures; Holm across ${rd.filter((r) => r.verdict !== "NOT TESTABLE").length}; DSR with N = ${N_TRIALS}; spreads not modelled):`);
    for (const r of rd) log(" " + fmt(r)); const cand = rd.filter((r) => r.verdict === "PASS").map((r) => r.name);
    log(`DISCOVERY PASS: ${cand.join(", ") || "none"}. PROMISING: ${rd.filter((r) => r.verdict === "PROMISING").map((r) => r.name).join(", ") || "none"}.`);
    log(`\nCONFIRMATION ${CONF[0]} .. ${CONF[1]} (every member reported; a discovery PASS is CONFIRMED with mean > 0 and t >= 2):`);
    for (const r of rc) log(" " + fmt(r, false) + (cand.includes(r.name) ? (r.monthMean > 0 && r.t >= 2 ? "  -> CONFIRMED" : "  -> NOT CONFIRMED") : ""));
    const conf = rc.filter((r) => cand.includes(r.name) && r.monthMean > 0 && r.t >= 2).map((r) => r.name);
    log(`\nCANDIDATES (discovery PASS and confirmed): ${conf.join(", ") || "none"}. A candidate goes to TRACK as a forward paper test first, never straight to FUTURES.`);
    fs.appendFileSync(path.join(HERE, "RESULT.txt"), lines.join("\n") + "\n\n");
    const strip = (rs) => rs.map(({ g3, g4, sr, p, ...r }) => r); fs.writeFileSync(path.join(HERE, "result.json"), JSON.stringify({ registration: SHA, discovery: strip(rd), confirmation: strip(rc), candidates: conf }, null, 1));
    process.exit(0); }
  if (mode === "--posthoc") {   // DESCRIPTIVE, AFTER THE RESULT (23 Oct 2026): is the trees' edge the futures' first print? Summary rows only.
    const all = readBook(path.join(DIR, "real-book.csv")), pr = readPred(path.join(DIR, "pred-real.csv")), ng = new Map();
    for (const l of fs.readFileSync(path.join(DIR, "pred-nogap.csv"), "utf8").split("\n").slice(1)) { if (!l) continue; const [id, p] = l.split(","); ng.set(id, [+p, +p, +p]); }
    const out = [], say = (x) => { out.push(x); console.log(x); };
    const cuts = [["2008-01 .. 2012-12", "2008-01-01", "2012-12-31"], ["2013-01 .. 2016-12", "2013-01-01", "2016-12-31"], ["2017-01 .. 2020-09", "2017-01-01", "2020-09-30"],
      ["2020-10 .. 2025-12-05 (futures open = first trade)", "2020-10-01", "2025-12-05"], ["2025-12-08 .. 2026-10-01 (futures pre-open auction)", "2025-12-08", "2026-10-01"]];
    const pick = (rows, pred, col, price) => { const byD = new Map(); for (const x of rows) { const p = pred.get(x.id); if (!p) continue; if (!byD.has(x.date)) byD.set(x.date, []); byD.get(x.date).push({ ...x, p }); } const days = [];
      for (const [d, xs] of [...byD].sort()) { if (xs.length < 50) continue; const k = Math.floor(xs.length / 10), s = xs.slice().sort((a, b) => a.p[col] - b.p[col] || (a.id < b.id ? -1 : 1)), L = s.slice(-k), Sh = s.slice(0, k);
        const o = (x) => (price === "share" ? x.so : x.fo), c = (x) => (price === "share" ? x.sc : x.fc); if ([...L, ...Sh].some((x) => !(o(x) > 0 && c(x) > 0))) continue;
        const ln = mean(L.map((x) => legNet(1, o(x), c(x), d))), sn = mean(Sh.map((x) => legNet(-1, o(x), c(x), d))), ug = mean(xs.filter((x) => x.gap !== null).map((x) => x.gap));
        days.push({ date: d, v: ((ln + sn) / 2) * 100, gl: mean(L.filter((x) => x.gap !== null).map((x) => x.gap)) - ug, gs: mean(Sh.filter((x) => x.gap !== null).map((x) => x.gap)) - ug }); }
      return days; };
    const stat = (days) => { const by = new Map(); for (const x of days) { const k = x.date.slice(0, 7); if (!by.has(k)) by.set(k, []); by.get(k).push(x.v); } const s = [...by.keys()].sort().map((k) => mean(by.get(k)));
      return s.length >= 6 ? `${days.length} days, ${sgn(mean(days.map((x) => x.v)))}% a day, monthly t ${nwT(s).toFixed(2)}` : `${days.length} days (too few months)`; };
    say(`POST-HOC AUDIT of the AI day-trader (descriptive, after the result; ${new Date().toISOString()}). Same tables and predictions as the run.`);
    const tf = pick(all, pr, 0, "futures"), ts = pick(all, pr, 0, "share"), nf = pick(all, ng, 0, "futures");
    say("A1 trees long-short, by period:"); for (const [name, a, b] of cuts) { const f = (xs) => xs.filter((x) => x.date >= a && x.date <= b);
      say(` ${name.padEnd(52)} futures ${stat(f(tf))} | the same picks on SHARES ${stat(f(ts))} | trees WITHOUT GAP and NGAP, futures ${stat(f(nf))}`); }
    say(` picks' share gap at the open vs the day's average: longs ${sgn(100 * mean(tf.map((x) => x.gl)))}%, shorts ${sgn(100 * mean(tf.map((x) => x.gs)))}%`);
    const small = all.filter((x) => x.gap !== null && Math.abs(x.gap) < 0.005), sf = pick(small, pr, 0, "futures");
    say(` only stocks whose share opened within 0.5% of the previous close (re-ranked among them): 2008-2020 ${stat(sf.filter((x) => x.date < "2020-10-01"))}; 2020-2026 ${stat(sf.filter((x) => x.date >= "2020-10-01"))}`);
    fs.writeFileSync(path.join(HERE, "POSTHOC.txt"), out.join("\n") + "\n"); process.exit(0); }
  console.error("usage: node run.js --features DIR | --score DIR | --synthetic DIR | --planted DIR | --posthoc DIR"); process.exit(1);
}
module.exports = { FEATS, MEMBERS, features, table, context, synthMarket, plantedRows, nullRows, books, score, check71, csv, period };
