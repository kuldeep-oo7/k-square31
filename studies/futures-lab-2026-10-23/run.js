"use strict";
// Implements ./PREREGISTRATION.txt (sha256 in ./PREREGISTRATION.sha256): the futures lab, one batch, one run.
//   node run.js --features DIR   check 5.1, then the tables (real, null, planted; U1-U3 trade values) into DIR (the runner only)
//   python ml.py DIR             U5-U7, walk-forward (DIR/pred-*.csv)
//   node run.js --score DIR      checks 5.2 and 5.3, then the one real scoring (RESULT.txt, result.json: summary rows only)
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

const NOTIONAL = 500000, RESET = 0.18, UNITS = 20, N_TRIALS = 359;
const DISC = ["2005-01-01", "2020-10-31"], CONF = ["2020-10-01", "2026-10-01"], SPLIT = "2020-09-01", ML_FROM = "2008-01-01";
const FEATS = ["R", "OI", "GAP", "NGAP", "NRET", "VOLR", "TREND", "VOL20", "BASIS", "NSIG", "DOW", "TOEXP", "LOGP", "LOGV", "OIREL", "PREV", "R2"];
const MEMBERS = ["U1 SB on futures", "U2 strong SB on futures", "U3 LU bounce on futures", "U4 share gap filter, futures", "U5 trees, futures", "U6 logistic, futures", "U7 neural network, futures"];
const RULE_MEMBERS = MEMBERS.slice(0, 3);
const nn = (x) => x === null || x === undefined || Number.isNaN(x);
const charge = (side, price, qty, d) => calculateNseFuturesCharges({ side, price, quantity: qty, asOfDate: `${d}T12:00:00Z` }).totalCharges;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

// ---------- data (as the 09:15 lab, plus every stock contract's daily close for the futures prices) ----------
const jsonDays = (dir, from, to) => fs.readdirSync(dir).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x) && x.slice(0, 10) >= from && x.slice(0, 10) <= to).sort();
function readCm(dir, from, to, P) {
  for (const f of jsonDays(dir, from, to)) { const d = f.slice(0, 10); P.sessions.push(d);
    for (const [, sym, series, o, h, l, c, , v, val] of JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))) {
      if (series !== "EQ" || !sym || ![o, h, l, c].every((x) => x > 0)) continue;
      if (!P.bySym.has(sym)) P.bySym.set(sym, { sym, bars: [] }); P.bySym.get(sym).bars.push({ d, o, h, l, c, v: +v || 0, val }); } }
}
function readFut(dir, from, to, P) {
  for (const f of jsonDays(dir, from, to)) { const d = f.slice(0, 10); const byExp = new Map(), exps = new Set(), near = new Map(), fcs = new Map();
    for (const r of JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))) {
      if (r[1] === "STK") { if (!P.oi.has(r[0])) P.oi.set(r[0], new Map()); const m = P.oi.get(r[0]); m.set(d, (m.get(d) || 0) + (+r[8] || 0));
        if (r[2] >= d) { exps.add(r[2]); const o = Number(r[3]), c = Number(r[6]);   // Number(null) is 0: never a price
          if (c > 0) { if (!fcs.has(r[0])) fcs.set(r[0], []); fcs.get(r[0]).push([r[2], c]); }
          if (o > 0 && c > 0 && (!near.has(r[0]) || r[2] < near.get(r[0]).e)) near.set(r[0], { e: r[2], o, c }); } }
      else if (r[1] === "IDX" && r[0] === "NIFTY" && r[2] >= d && r[6] > 0) byExp.set(r[2], { o: +r[3], c: +r[6] }); }
    for (const [sym, v] of near) { if (!P.fnear.has(sym)) P.fnear.set(sym, new Map()); P.fnear.get(sym).set(d, v); if (!P.futNear.has(sym)) P.futNear.set(sym, new Map()); P.futNear.get(sym).set(d, v.c); }
    for (const [sym, list] of fcs) { if (!P.fc.has(sym)) P.fc.set(sym, new Map()); const m = P.fc.get(sym); for (const [e, c] of list.sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(0, 3)) { if (!m.has(e)) m.set(e, new Map()); m.get(e).set(d, c); } }
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
  const P = { name, sessions: [], bySym: new Map(), oi: new Map(), futNear: new Map(), fnear: new Map(), fc: new Map(), expiries: new Map(), fut: new Map(), idx: new Map(), lastFut: null };
  if (name === "discovery") { readCm(path.join(oos, "cm"), DISC[0], DISC[1], P); readFut(path.join(oos, "fut"), DISC[0], DISC[1], P); readIdxJson(path.join(oos, "idx"), P); Object.assign(P, { from: DISC[0], to: DISC[1] }); }
  else { const pre = new Date(Date.parse(SPLIT) - 864e5).toISOString().slice(0, 10);
    readCm(path.join(oos, "cm"), "0000", pre, P); readCm(path.join(R, "rising-stocks-2026-10-02", "nse-data", "cm"), SPLIT, CONF[1], P);
    readFut(path.join(oos, "fut"), "0000", pre, P); readFut(path.join(R, "orderflow-2026-10-03", "nse-fo", "fut"), SPLIT, CONF[1], P);
    readIdxJson(path.join(oos, "idx"), P); readIdxCsv(process.env.K2_MACRO_IC, P); Object.assign(P, { from: CONF[0], to: CONF[1] }); }
  P.stocks = [...P.bySym.values()]; delete P.bySym; delete P.lastFut; return P;
}

// ---------- context, NIFTY, the universe (the 09:15 lab's) ----------
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
  return { S, sIdx, bar, nifty, uni, bf: new Map() };
}
function niftyMove(C, i) { const a = C.nifty.get(i - 1), b = C.nifty.get(i); if (!b) return null;
  if (a && a.idx && b.idx) return b.idx.c / a.idx.c - 1; if (b.fut && b.fut.pc > 0 && b.fut.pd === C.S[i - 1]) return b.fut.c / b.fut.pc - 1; return null; }
function niftyGap(C, i) { const a = C.nifty.get(i - 1), b = C.nifty.get(i); if (!b) return null;
  if (a && a.idx && b.idx && b.idx.o > 0) return b.idx.o / a.idx.c - 1; if (b.fut && b.fut.o > 0 && b.fut.pc > 0 && b.fut.pd === C.S[i - 1]) return b.fut.o / b.fut.pc - 1; return null; }

// ---------- futures prices ----------
function futHold(P, C, sym, i, h, side) {   // { gross, cost } of holding the near-month future from the open of i to the close of i+h-1, rolling at expiry
  const S = C.S, n0 = P.fnear.get(sym) && P.fnear.get(sym).get(S[i]); if (!n0) return null; const fc = P.fc.get(sym); if (!fc) return null;
  let e = n0.e, px = n0.o, value = 1; const q = Math.ceil(NOTIONAL / n0.o); let cost = charge(side > 0 ? "BUY" : "SELL", n0.o, q, S[i]);
  for (let k = i; k <= i + h - 1; k += 1) { const d = S[k]; if (k >= S.length) return null; const c = fc.get(e) && fc.get(e).get(d); if (!(c > 0)) return null;
    if (k === i + h - 1) { value *= c / px; cost += charge(side > 0 ? "SELL" : "BUY", c, q, d); break; }
    if (d >= e) { const e2 = [...fc.keys()].filter((x) => x > e && fc.get(x).has(d)).sort()[0]; if (!e2) return null; const c2 = fc.get(e2).get(d);
      value *= c / px; cost += charge(side > 0 ? "SELL" : "BUY", c, q, d) + charge(side > 0 ? "BUY" : "SELL", c2, q, d); e = e2; px = c2; } }
  return { net: side * (value - 1) - cost / (n0.o * q), o: n0.o };
}
function futBench(P, C, i) { if (C.bf.has(i)) return C.bf.get(i); const xs = [];
  for (const sym of C.uni.get(C.S[i].slice(0, 7)) || []) { const f = P.fnear.get(sym) && P.fnear.get(sym).get(C.S[i]); if (f) xs.push(f.c / f.o - 1); }
  const v = xs.length >= 30 ? mean(xs) : null; C.bf.set(i, v); return v; }
const shareNet = (side, o, c, d, xd) => { const q = Math.ceil(NOTIONAL / o); return side * (c / o - 1) - (charge(side > 0 ? "BUY" : "SELL", o, q, d) + charge(side > 0 ? "SELL" : "BUY", c, q, xd)) / (o * q); };

// ---------- the 09:15 lab's features (only bars to d-1, F&O files to d-1, and the OPEN of d) ----------
const windowVals = (m, lo, hi, f) => { const out = []; for (let k = lo; k <= hi; k += 1) { const b = m.get(k); if (b) out.push(f(b, k)); } return out; };
function features(C, P, sig, t) {
  const i = t.i, d = C.S[i], d1 = C.S[i - 1], m = C.bar.get(t.sym), b = m.get(i), p1 = m.get(i - 1), p2 = m.get(i - 2), p3 = m.get(i - 3), o = P.oi.get(t.sym);
  const vols = windowVals(m, i - 21, i - 2, (x) => x.v), closes = windowVals(m, i - 20, i - 1, (x) => x.c);
  const rets = []; for (let k = i - 20; k <= i - 1; k += 1) { const a = m.get(k - 1), z = m.get(k); if (a && z) rets.push(z.c / a.c - 1); }
  const ois = []; if (o) for (let k = i - 20; k <= i - 1; k += 1) { const v = o.get(C.S[k]); if (v > 0) ois.push(v); }
  const fn = P.futNear.get(t.sym), fcl = fn ? fn.get(d1) : undefined; const ex = (P.expiries.get(d1) || []).find((e) => e >= d);
  const own = sig.bySym.get(t.sym) || []; const prev = own.filter((k) => k >= i - 10 && k <= i - 1).length;
  const v60 = t.bars.slice(Math.max(0, t.k - 60), t.k).map((x) => x.val).filter((x) => x > 0).sort((a, c) => a - c);
  const sd = (a) => { const mu = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - mu) ** 2, 0) / (a.length - 1)); };
  return { R: p1 && p2 ? p1.c / p2.c - 1 : null, OI: o && o.get(d1) > 0 && o.get(C.S[i - 2]) > 0 ? o.get(d1) / o.get(C.S[i - 2]) - 1 : null, GAP: p1 ? b.o / p1.c - 1 : null,
    NGAP: niftyGap(C, i), NRET: niftyMove(C, i - 1), VOLR: vols.length >= 15 && mean(vols) > 0 && p1 ? p1.v / mean(vols) : null,
    TREND: closes.length >= 15 && p1 ? p1.c / mean(closes) - 1 : null, VOL20: rets.length >= 15 ? sd(rets) : null, BASIS: fcl > 0 && p1 ? fcl / p1.c - 1 : null,
    NSIG: sig.byDay.get(i) || 0, DOW: new Date(`${d}T00:00:00Z`).getUTCDay(), TOEXP: ex ? Math.round((Date.parse(ex) - Date.parse(d)) / 864e5) : null,
    LOGP: p1 ? Math.log(p1.c) : null, LOGV: v60.length ? Math.log(v60[Math.floor(v60.length / 2)]) : null, OIREL: ois.length >= 15 && o.get(d1) > 0 ? o.get(d1) / mean(ois) : null,
    PREV: prev, R2: p2 && p3 ? p2.c / p3.c - 1 : null };
}
function tables(P, C, tag) {   // SB rows (features + FUTURES EXCESS) for U4-U7, and the trade values of U1-U3
  const res = ofw.forward({ sessions: P.sessions, stocks: P.stocks, oi: P.oi, rule: { ...ofw.RULE, start: "2005-01-01" } });
  const inS = (d) => d >= P.from && d <= P.to && (tag !== "C" || d >= CONF[0]);
  const sb = res.SB.trades.map((t) => ({ ...t, i: C.sIdx.get(t.entryDate) })).filter((t) => t.i !== undefined);
  const sig = { byDay: new Map(), bySym: new Map() }; for (const t of sb) { sig.byDay.set(t.i, (sig.byDay.get(t.i) || 0) + 1); if (!sig.bySym.has(t.symbol)) sig.bySym.set(t.symbol, []); sig.bySym.get(t.symbol).push(t.i); }
  const barsOf = new Map(P.stocks.map((s) => [s.sym, s.bars])); const rows = [], U = { [MEMBERS[0]]: [], [MEMBERS[1]]: [], [MEMBERS[2]]: [] }, trades = { [MEMBERS[0]]: [], [MEMBERS[1]]: [], [MEMBERS[2]]: [] };
  for (const t of sb) { if (t.status !== "DONE" || !inS(t.entryDate)) continue; const fh = futHold(P, C, t.symbol, t.i, 1, -1); if (!fh) continue;
    const sv = shareNet(-1, t.entry, t.exit, t.entryDate, t.exitDate), m = C.bar.get(t.symbol), p1 = m.get(t.i - 1), p2 = m.get(t.i - 2), o = P.oi.get(t.symbol);
    const n1 = P.fnear.get(t.symbol).get(t.entryDate); const rup = -UNITS * (n1.c - n1.o);
    U[MEMBERS[0]].push({ date: t.entryDate, v: fh.net, sv, rup }); trades[MEMBERS[0]].push({ sym: t.symbol, i: t.i, h: 1, side: -1 });
    const R = p1 && p2 ? p1.c / p2.c - 1 : null, OI = o && p1 && p2 && o.get(p2.d) > 0 ? o.get(p1.d) / o.get(p2.d) - 1 : null; const B = futBench(P, C, t.i);
    if (R !== null && OI !== null && R <= -0.03 && OI >= 0.06 && B !== null) { U[MEMBERS[1]].push({ date: t.entryDate, v: fh.net + B, sv, rup }); trades[MEMBERS[1]].push({ sym: t.symbol, i: t.i, h: 1, side: -1, excess: true }); }
    if (B === null) continue; const bars = barsOf.get(t.symbol); let k = 0, hi = bars.length; while (k < hi) { const mid = (k + hi) >> 1; if (bars[mid].d < t.entryDate) k = mid + 1; else hi = mid; }
    rows.push({ id: `${tag}${rows.length}`, period: tag, date: t.entryDate, ...features(C, P, sig, { i: t.i, sym: t.symbol, bars, k }), excess: fh.net + B, rup }); }
  for (const t of res.LU.trades) { const i = C.sIdx.get(t.entryDate); if (t.status !== "DONE" || i === undefined || !inS(t.entryDate)) continue; const fh = futHold(P, C, t.symbol, i, 10, 1); if (!fh) continue;
    const ex = C.sIdx.get(t.exitDate); const fx = P.fc.get(t.symbol); U[MEMBERS[2]].push({ date: t.entryDate, v: fh.net, sv: shareNet(1, t.entry, t.exit, t.entryDate, t.exitDate), rup: 0 }); trades[MEMBERS[2]].push({ sym: t.symbol, i, h: 10, side: 1 }); void ex; void fx; }
  return { rows, U, trades };
}
function redated(P, C, trades, seed) {   // check 5.3 for U1-U3: the same trades moved to random discovery sessions
  const r = rng(seed), lo = Math.max(0, C.S.findIndex((d) => d >= DISC[0])) + 25, hi = C.S.length - 25; const out = {};
  for (const [m, ts] of Object.entries(trades)) { out[m] = []; for (const t of ts) { const i = lo + Math.floor(r() * (hi - lo)); const fh = futHold(P, C, t.sym, i, t.h, t.side); if (!fh) continue;
    let v = fh.net; if (t.excess) { const B = futBench(P, C, i); if (B === null) continue; v += B; } out[m].push({ date: C.S[i], v }); } }
  return out;
}
const csv = (rows) => ["id,period,date," + FEATS.join(",") + ",excess", ...rows.map((r) => [r.id, r.period, r.date, ...FEATS.map((k) => (nn(r[k]) ? "" : r[k])), r.excess].join(","))].join("\n") + "\n";

// ---------- synthetic data for the checks ----------
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), 1 | t); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function check51(log) {   // futures pricing by hand
  const S = ["2026-01-27", "2026-01-28"]; for (let t = Date.parse("2026-01-29"); S.length < 12; t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) S.push(d.toISOString().slice(0, 10)); }
  const C = { S, bf: new Map() }; const near = new Map(), fcE1 = new Map(), fcE2 = new Map();
  S.forEach((d, k) => { fcE1.set(d, 100 + k); fcE2.set(d, 101 + k); near.set(d, d <= "2026-01-27" ? { e: "2026-01-27", o: 99, c: 100 + k } : { e: "2026-02-24", o: 100 + k, c: 101 + k }); });
  const P = { fnear: new Map([["X", near]]), fc: new Map([["X", new Map([["2026-01-27", fcE1], ["2026-02-24", fcE2]])]]) };
  const q1 = Math.ceil(500000 / 99), one = futHold(P, C, "X", 0, 1, -1), want1 = -(100 / 99 - 1) - (charge("SELL", 99, q1, S[0]) + charge("BUY", 100, q1, S[0])) / (99 * q1);
  const ten = futHold(P, C, "X", 0, 10, 1); const last = S[9], v = (100 / 99) * ((101 + 9) / 101); const want10 = v - 1 - (charge("BUY", 99, q1, S[0]) + charge("SELL", 100, q1, S[0]) + charge("BUY", 101, q1, S[0]) + charge("SELL", 110, q1, last)) / (99 * q1);
  const ok = Math.abs(one.net - want1) < 1e-12 && Math.abs(ten.net - want10) < 1e-12;
  log(` 5.1 futures pricing by hand: one-session short ${(one.net * 100).toFixed(3)}%; 10-session long across the 27 Jan expiry chains two contracts with one roll, ${(ten.net * 100).toFixed(3)}%: ${ok ? "PASSED" : "FAILED"}`); return ok;
}
function plantedRows(seed) {   // the 09:15 lab's planted table for M1 (check 6.2 there, 5.2 here)
  const r = rng(seed), g = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); const rows = [];
  const days = []; for (let t = Date.parse("2005-01-03"); t < Date.parse("2020-10-01"); t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) days.push(d.toISOString().slice(0, 10)); }
  for (let n = 0; n < 40000; n += 1) { const f = { R: -0.02 - 0.02 * r(), OI: 0.03 + 0.08 * r(), GAP: 0.01 * g(), NGAP: 0.007 * g(), NRET: 0.01 * g(), VOLR: Math.exp(0.6 * g()), TREND: 0.04 * g(), VOL20: 0.02 * (0.5 + r()),
      BASIS: 0.003 * g(), NSIG: Math.floor(20 * r()), DOW: 1 + Math.floor(5 * r()), TOEXP: Math.floor(30 * r()), LOGP: 3 + 4 * r(), LOGV: 18 + 3 * r(), OIREL: Math.exp(0.2 * g()), PREV: Math.floor(3 * r()), R2: 0.02 * g() };
    const base = f.NGAP < 0 && f.VOLR >= 2 ? 0.006 : -0.002; rows.push({ id: `P${n}`, period: "D", date: days[Math.floor(r() * days.length)], ...f, excess: base + 0.02 * g(), rup: 0 }); }
  return rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
function nullRows(rows, seed) { const r = rng(seed), byM = new Map(); for (const x of rows) { const k = x.date.slice(0, 7); if (!byM.has(k)) byM.set(k, []); byM.get(k).push(x); } const out = [];
  for (const [, xs] of byM) { const fv = xs.map((x) => FEATS.map((f) => x[f])); for (let k = fv.length - 1; k > 0; k -= 1) { const j = Math.floor(r() * (k + 1)); [fv[k], fv[j]] = [fv[j], fv[k]]; }
    xs.forEach((x, k) => out.push({ ...x, id: `N${out.length}`, ...Object.fromEntries(FEATS.map((f, q) => [f, fv[k][q]])) })); } return out; }

// ---------- scoring ----------
function nwT(x, lag = 3) { const n = x.length, m = mean(x); const e = x.map((v) => v - m); let s = e.reduce((a, v) => a + v * v, 0) / n;
  for (let L = 1; L <= lag; L += 1) { let g = 0; for (let i = L; i < n; i += 1) g += e[i] * e[i - L]; s += 2 * (1 - L / (lag + 1)) * (g / n); } return m / Math.sqrt(s / n); }
const sdv = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const Phi = (x) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
const invPhi = (p) => { let lo = -10, hi = 10; for (let i = 0; i < 100; i += 1) { const m = (lo + hi) / 2; if (Phi(m) < p) lo = m; else hi = m; } return (lo + hi) / 2; };
const monthly = (items, key = "v") => { const by = new Map(); for (const x of items) { const k = x.date.slice(0, 7); if (!by.has(k)) by.set(k, []); by.get(k).push(x[key] * 100); } return [...by.keys()].sort().map((k) => mean(by.get(k))); };
function spread(rows, take) { const by = new Map(); let nT = 0, nS = 0, rupT = 0;
  for (const x of rows) { const tk = take(x); if (tk === null || tk === undefined) continue; const k = x.date.slice(0, 7); if (!by.has(k)) by.set(k, { T: [], S: [] }); by.get(k)[tk ? "T" : "S"].push(x.excess * 100); if (tk) { nT += 1; rupT += x.rup; } else nS += 1; }
  const s = []; for (const k of [...by.keys()].sort()) { const v = by.get(k); if (v.T.length && v.S.length) s.push(mean(v.T) - mean(v.S)); } return { s, nT, nS, rupT: Math.round(rupT) }; }
const readPred = (f) => { const m = new Map(); const L = fs.readFileSync(f, "utf8").trim().split(/\r?\n/); const h = L[0].split(",");
  for (const l of L.slice(1)) { const v = l.split(","); const o = Object.fromEntries(h.map((k, q) => [k, v[q]])); m.set(o.id, { U5: o.take1 === "1", U6: o.take2 === "1", U7: o.take3 === "1" }); } return m; };
function score(U, rows, pred) {   // U: rule members' trade values; rows + pred: the split members
  const out = MEMBERS.map((name) => { let s, extra = {};
    if (RULE_MEMBERS.includes(name)) { const it = U[name] || []; s = monthly(it); extra = { trades: it.length, win: it.length ? (100 * it.filter((x) => x.v > 0).length) / it.length : 0, meanTrade: it.length ? (100 * mean(it.map((x) => x.v))) : null,
      shareMeanTrade: it.length && it[0].sv !== undefined ? 100 * mean(it.map((x) => x.sv)) : null, rupees: Math.round(it.reduce((a, x) => a + (x.rup || 0), 0)) }; }
    else { const k = name.slice(0, 2); const use = k === "U4" ? rows : rows.filter((x) => x.date >= ML_FROM); const take = k === "U4" ? (x) => (nn(x.GAP) ? null : x.GAP >= 0) : (x) => { const p = pred.get(x.id); return p ? p[k] : null; };
      const sp = spread(use, take); s = sp.s; extra = { trades: sp.nT + sp.nS, taken: sp.nT, rupees: sp.rupT }; }
    if (s.length < 24) return { name, months: s.length, ...extra, verdict: "NOT TESTABLE" }; const m = mean(s), sd = sdv(s);
    return { name, months: s.length, ...extra, monthMean: m, worstMonth: Math.min(...s), t: nwT(s), sr: m / sd, g3: mean(s.map((v) => ((v - m) / sd) ** 3)), g4: mean(s.map((v) => ((v - m) / sd) ** 4)) }; });
  const tested = out.filter((r) => r.verdict !== "NOT TESTABLE"); const N = tested.length;
  if (N) { for (const r of tested) r.p = 1 - Phi(r.t); let ok = true; tested.slice().sort((a, b) => a.p - b.p).forEach((r, i) => { r.holm = ok && r.p <= 0.05 / (N - i); if (!r.holm) ok = false; });
    const g = 0.5772156649, SR0 = (N > 1 ? sdv(tested.map((r) => r.sr)) : 0) * ((1 - g) * invPhi(1 - 1 / N_TRIALS) + g * invPhi(1 - 1 / (N_TRIALS * Math.E)));
    for (const r of tested) { const den = 1 - r.g3 * r.sr + ((r.g4 - 1) / 4) * r.sr ** 2; r.dsr = den > 0 ? Phi(((r.sr - SR0) * Math.sqrt(r.months - 1)) / Math.sqrt(den)) : NaN;
      r.verdict = r.monthMean > 0 && r.t >= 3 && r.holm && r.dsr >= 0.95 ? "PASS" : r.monthMean > 0 && r.t >= 2 ? "PROMISING" : "FAIL"; } }
  return out;
}
const sgn = (x, d = 3) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}`;
const fmt = (r, judged = true) => (r.verdict === "NOT TESTABLE" ? `${r.name.padEnd(30)} NOT TESTABLE (${r.months} months)` : `${r.name.padEnd(30)} ${String(r.trades).padStart(6)} trades${r.taken !== undefined ? ` (take ${r.taken})` : ""} | ${String(r.months).padStart(3)} months | ${sgn(r.monthMean)}% a month | worst ${sgn(r.worstMonth, 2)}% | t ${r.t.toFixed(2)}`
  + (judged ? ` | Holm ${r.holm ? "y" : "n"} | DSR ${Number.isFinite(r.dsr) ? r.dsr.toFixed(2) : "-"} -> ${r.verdict}` : "")
  + (r.meanTrade !== undefined && r.meanTrade !== null ? ` | futures ${sgn(r.meanTrade)}% a trade (won ${r.win.toFixed(0)}%) vs shares ${r.shareMeanTrade === null ? "-" : sgn(r.shareMeanTrade)}%` : ""));

if (require.main === module) {
  const mode = process.argv[2], DIR = path.resolve(process.argv[3] || "work"); const lines = [], log = (x) => { lines.push(x); console.log(x); };
  const refuse = (why) => { fs.appendFileSync(path.join(HERE, "RESULT.txt"), lines.join("\n") + `\n${why}: real run refused.\n\n`); process.exit(1); };
  if (mode === "--features") {
    log(`FUTURES LAB features: registration sha256 ${SHA.slice(0, 16)}... (verified); ${new Date().toISOString()}`); if (!check51(log)) refuse("CHECK 5.1 FAILED");
    fs.mkdirSync(DIR, { recursive: true }); const out = {};
    for (const [name, tag] of [["discovery", "D"], ["confirmation", "C"]]) { const P = period(name), C = context(P), t = tables(P, C, tag);
      log(`${name.toUpperCase()} DATA: ${P.sessions.length} sessions ${P.sessions[0]} .. ${P.sessions.at(-1)}, ${P.stocks.length} stocks, futures for ${P.fnear.size}; SB rows ${t.rows.length}; ` + RULE_MEMBERS.map((m) => `${m.split(" ")[0]} ${t.U[m].length}`).join(", "));
      out[tag] = { rows: t.rows, U: t.U }; if (tag === "D") out.nullU = redated(P, C, t.trades, 53); }
    const real = [...out.D.rows, ...out.C.rows], nul = nullRows(out.D.rows, 63), pl = plantedRows(62);
    for (const [n, rows] of [["real", real], ["null", nul], ["planted", pl]]) { fs.writeFileSync(path.join(DIR, `${n}.csv`), csv(rows)); fs.writeFileSync(path.join(DIR, `${n}.json`), JSON.stringify(rows)); }
    fs.writeFileSync(path.join(DIR, "rules.json"), JSON.stringify({ D: out.D.U, C: out.C.U, nullD: out.nullU })); fs.appendFileSync(path.join(DIR, "log.txt"), lines.join("\n") + "\n"); console.log("tables written (runner only)"); process.exit(0); }
  if (mode === "--score") {
    lines.push(...fs.readFileSync(path.join(DIR, "log.txt"), "utf8").trim().split("\n")); log("CHECKS 5.2-5.3:");
    const pm = JSON.parse(fs.readFileSync(path.join(DIR, "planted.json"), "utf8")), pp = readPred(path.join(DIR, "pred-planted.csv"));
    const t52 = nwT(spread(pm.filter((x) => x.date >= ML_FROM), (x) => { const p = pp.get(x.id); return p ? p.U5 : null; }).s); const ok52 = t52 >= 3;
    log(` 5.2 planted (NIFTY-gap x volume edge): U5 trees t ${t52.toFixed(2)}: ${ok52 ? "PASSED" : "FAILED"}`); if (!ok52) refuse("CHECK 5.2 FAILED");
    const R = JSON.parse(fs.readFileSync(path.join(DIR, "rules.json"), "utf8")), nr = JSON.parse(fs.readFileSync(path.join(DIR, "null.json"), "utf8")), np = readPred(path.join(DIR, "pred-null.csv"));
    const ns = score(R.nullD, nr, np), passes = ns.filter((r) => r.verdict === "PASS").length;
    log(` 5.3 null (U1-U3 re-dated, U4-U7 features shuffled within each month): ${passes} PASS of ${ns.filter((r) => r.verdict !== "NOT TESTABLE").length} (at most 1): ${passes <= 1 ? "PASSED" : "FAILED"}`); if (passes > 1) refuse("CHECK 5.3 FAILED");
    const real = JSON.parse(fs.readFileSync(path.join(DIR, "real.json"), "utf8")), pr = readPred(path.join(DIR, "pred-real.csv"));
    const rd = score(R.D, real.filter((x) => x.period === "D"), pr), rc = score(R.C, real.filter((x) => x.period === "C"), pr);   // both computed before anything is shown
    log(`\nDISCOVERY ${DISC[0]} .. ${DISC[1]}, priced on the near-month FUTURE (U1, U3 net; U2 excess; U4-U7 monthly spread take - skip; U5-U7 from 2008); Holm across ${rd.filter((r) => r.verdict !== "NOT TESTABLE").length}; DSR with N = ${N_TRIALS}:`);
    for (const r of rd) log(" " + fmt(r)); const cand = rd.filter((r) => r.verdict === "PASS").map((r) => r.name);
    log(`DISCOVERY PASS: ${cand.join(", ") || "none"}. PROMISING: ${rd.filter((r) => r.verdict === "PROMISING").map((r) => r.name).join(", ") || "none"}.`);
    log(`\nCONFIRMATION ${CONF[0]} .. ${CONF[1]} (U1 and U4 were seen here tonight, post-hoc; every member reported; a discovery PASS is CONFIRMED with mean > 0 and t >= 2):`);
    for (const r of rc) log(" " + fmt(r, false) + (cand.includes(r.name) ? (r.monthMean > 0 && r.t >= 2 ? "  -> CONFIRMED" : "  -> NOT CONFIRMED") : ""));
    log(` GM rupees at ${UNITS} units on futures, gross, 2020-2026 (reported, not judged): ` + rc.filter((r) => r.rupees !== undefined && r.name !== MEMBERS[2]).map((r) => `${r.name.split(" ")[0]} Rs ${r.rupees.toLocaleString("en-IN")}`).join(", "));
    const conf = rc.filter((r) => cand.includes(r.name) && r.monthMean > 0 && r.t >= 2).map((r) => r.name);
    log(`\nCANDIDATES (discovery PASS and confirmed): ${conf.join(", ") || "none"}. A candidate goes to TRACK as a forward paper test first, never straight to FUTURES.`);
    fs.appendFileSync(path.join(HERE, "RESULT.txt"), lines.join("\n") + "\n\n");
    const strip = (rs) => rs.map(({ g3, g4, sr, p, ...r }) => r); fs.writeFileSync(path.join(HERE, "result.json"), JSON.stringify({ registration: SHA, discovery: strip(rd), confirmation: strip(rc), candidates: conf }, null, 1));
    process.exit(0); }
  if (mode === "--synthetic") { fs.mkdirSync(DIR, { recursive: true }); const pl = plantedRows(62); fs.writeFileSync(path.join(DIR, "planted.csv"), csv(pl)); fs.writeFileSync(path.join(DIR, "planted.json"), JSON.stringify(pl)); console.log(check51((x) => console.log(x)) ? "5.1 ok" : "5.1 FAILED"); process.exit(0); }
  console.error("usage: node run.js --features DIR | --score DIR | --synthetic DIR"); process.exit(1);
}
module.exports = { MEMBERS, futHold, futBench, check51, tables, context, score, spread, monthly, period };
