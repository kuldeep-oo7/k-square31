"use strict";
// The forward paper test of the AI day-trader (studies/daytrader-forward-2026-10-26/PREREGISTRATION.txt): every session the
// trees model ranks the universe's stock futures from what is known at 09:15; long the top tenth, short the bottom tenth,
// open to close on futures. Features copied unchanged from studies/daytrader-lab-2026-10-23/run.js; the model's
// probabilities come from scripts/daytrader-predict.py; books() and summary() score them.
const fs = require("node:fs");
const path = require("node:path");
const { calculateNseFuturesCharges } = require("./shadow-broker");
const { isoWeek } = require("./springy-dip");

const RULE = { start: "2026-10-26", notional: 500000, reset: 0.18, minNames: 50, minSessions: 60, minMonths: 3, top: 3 };
const FEATS = ["R1", "R5", "R20", "GAP", "NGAP", "NRET", "OI1", "OI5", "VOLR", "VOL20", "BASIS", "TREND", "HL", "CLV", "DOW", "TOEXP", "LOGP", "LOGV"];
const charge = (side, price, qty, d) => calculateNseFuturesCharges({ side, price, quantity: qty, asOfDate: `${d}T12:00:00Z` }).totalCharges;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const nn = (x) => x === null || x === undefined || Number.isNaN(x);

// ---------- NSE's files (as the lab reads them) ----------
const jsonDays = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort() : []);
function readCm(dir) { const P = { sessions: [], bySym: new Map() };
  for (const f of jsonDays(dir)) { const d = f.slice(0, 10); P.sessions.push(d);
    for (const [, sym, series, o, h, l, c, , v, val] of JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))) {
      if (series !== "EQ" || !sym || ![o, h, l, c].every((x) => x > 0)) continue; if (!P.bySym.has(sym)) P.bySym.set(sym, { sym, bars: [] }); P.bySym.get(sym).bars.push({ d, o, h, l, c, v: +v || 0, val }); } }
  return { sessions: P.sessions, stocks: [...P.bySym.values()] }; }
function readFut(dir, P) {
  for (const f of jsonDays(dir)) { const d = f.slice(0, 10); const byExp = new Map(), exps = new Set(), near = new Map();
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
function readIdx(dir, P) { for (const f of jsonDays(dir)) { const v = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))["Nifty 50"]; if (Array.isArray(v) && v[3] > 0) P.idx.set(f.slice(0, 10), { o: v[0] > 0 ? v[0] : null, c: v[3] }); } }

// ---------- context, NIFTY, features (copied unchanged from the lab) ----------
function context(P) {
  const S = P.sessions, sIdx = new Map(S.map((d, i) => [d, i])), bar = new Map();
  for (const st of P.stocks) { const m = new Map(); for (const b of st.bars) m.set(sIdx.get(b.d), b); bar.set(st.sym, m); }
  const nifty = new Map(); S.forEach((d, i) => { const ix = P.idx.get(d), fu = P.fut.get(d); if (ix || fu) nifty.set(i, { idx: ix || null, fut: fu || null }); });
  const firstOf = new Map(); S.forEach((d, i) => { if (!firstOf.has(d.slice(0, 7))) firstOf.set(d.slice(0, 7), i); });
  const months = [...firstOf.keys()], ranked = new Map(months.map((m) => [m, []]));
  for (const st of P.stocks) { const b = st.bars; let k = 0, lc = 0;
    for (const m of months) { const fd = S[firstOf.get(m)]; while (k < b.length && b[k].d < fd) { if (k > 0 && Math.abs(b[k].o / b[k - 1].c - 1) >= RULE.reset) lc = k; k += 1; }
      if (k - lc < 250) continue; const v = b.slice(k - 60, k).map((x) => x.val).filter((x) => x > 0).sort((a, c) => a - c); if (v.length) ranked.get(m).push([st.sym, v[Math.floor(v.length / 2)]]); } }
  const uni = new Map(); for (const [m, r] of ranked) { r.sort((a, c) => c[1] - a[1]); uni.set(m, r.slice(0, 200)); }
  return { S, sIdx, bar, nifty, uni };
}
function niftyMove(C, i) { const a = C.nifty.get(i - 1), b = C.nifty.get(i); if (!b) return null;
  if (a && a.idx && b.idx) return b.idx.c / a.idx.c - 1; if (b.fut && b.fut.pc > 0 && b.fut.pd === C.S[i - 1]) return b.fut.c / b.fut.pc - 1; return null; }
function niftyGap(C, i) { const a = C.nifty.get(i - 1), b = C.nifty.get(i); if (!b) return null;
  if (a && a.idx && b.idx && b.idx.o > 0) return b.idx.o / a.idx.c - 1; if (b.fut && b.fut.o > 0 && b.fut.pc > 0 && b.fut.pd === C.S[i - 1]) return b.fut.o / b.fut.pc - 1; return null; }
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
// every universe stock-day from rule.start with a near-month future (as the lab's table(), without the label)
function rows(P, rule = RULE) {
  const C = context(P), S = C.S, out = [];
  for (let i = 22; i < S.length; i += 1) { const d = S[i]; if (d < rule.start) continue;
    for (const [sym] of C.uni.get(d.slice(0, 7)) || []) { const f = P.fnear.get(sym) && P.fnear.get(sym).get(d); if (!f || !C.bar.get(sym).get(i)) continue;
      out.push({ id: `${d}|${sym}`, date: d, symbol: sym, fo: f.o, fc: f.c, features: features(P, C, sym, i) }); } }
  return { lastSession: S[S.length - 1], rows: out };
}
const toCsv = (rs) => ["id," + FEATS.join(","), ...rs.map((r) => [r.id, ...FEATS.map((k) => (nn(r.features[k]) ? "" : r.features[k]))].join(","))].join("\n") + "\n";

// ---------- books and the verdict ----------
const legNet = (side, o, c, d) => { const q = Math.ceil(RULE.notional / o); return side * (c / o - 1) - (charge(side > 0 ? "BUY" : "SELL", o, q, d) + charge(side > 0 ? "SELL" : "BUY", c, q, d)) / (o * q); };
function books(rs, prob, rule = RULE) {   // rs: [{ id, date, symbol, fo, fc }], prob: Map(id -> probability); one book a day (values in %)
  const byD = new Map(); for (const x of rs) { const p = prob.get(x.id); if (p === undefined || !(x.fo > 0 && x.fc > 0)) continue; if (!byD.has(x.date)) byD.set(x.date, []); byD.get(x.date).push({ ...x, p }); }
  const out = [];
  for (const [d, xs] of [...byD].sort()) { if (xs.length < rule.minNames) continue; const k = Math.floor(xs.length / 10), B = mean(xs.map((x) => x.fc / x.fo - 1));
    const s = xs.slice().sort((a, b) => a.p - b.p || (a.symbol < b.symbol ? -1 : 1)), L = s.slice(-k), Sh = s.slice(0, k), L3 = s.slice(-rule.top), S3 = s.slice(0, rule.top);
    const ln = mean(L.map((x) => legNet(1, x.fo, x.fc, d))), sn = mean(Sh.map((x) => legNet(-1, x.fo, x.fc, d)));
    const l3 = mean(L3.map((x) => legNet(1, x.fo, x.fc, d))), s3 = mean(S3.map((x) => legNet(-1, x.fo, x.fc, d))), r3 = (v) => +(v * 100).toFixed(3);
    out.push({ date: d, names: xs.length, k, bookPct: r3((ln + sn) / 2), longExcessPct: r3(ln - B), shortExcessPct: r3(sn + B), top3Pct: r3((l3 + s3) / 2),
      top3Long: L3.map((x) => x.symbol).reverse(), top3Short: S3.map((x) => x.symbol) }); }
  return out;
}
const T05 = [[1, 6.314], [2, 2.920], [3, 2.353], [4, 2.132], [5, 2.015], [6, 1.943], [7, 1.895], [8, 1.860], [9, 1.833], [10, 1.812], [12, 1.782], [15, 1.753], [20, 1.725], [30, 1.697], [60, 1.671], [120, 1.658]];
const tCrit05 = (df) => { let v = null; for (const [k, c] of T05) if (df >= k) v = c; return v; };
function summary(days, rule = RULE) {
  const n = days.length; if (!n) return { sessions: 0, verdict: "COLLECTING" };
  const byW = new Map(); for (const x of days) { const w = isoWeek(x.date); if (!byW.has(w)) byW.set(w, []); byW.get(w).push(x.bookPct); }
  const wk = [...byW.values()].map(mean), G = wk.length, m = mean(days.map((x) => x.bookPct)), mw = mean(wk), sd = G > 1 ? Math.sqrt(wk.reduce((a, x) => a + (x - mw) ** 2, 0) / (G - 1)) : null, t = sd ? mw / (sd / Math.sqrt(G)) : null;
  const months = (Date.parse(days[days.length - 1].date) - Date.parse(rule.start)) / (30.44 * 864e5), crit = tCrit05(G - 1);
  const verdict = !(n >= rule.minSessions && months >= rule.minMonths) ? "COLLECTING" : mw > 0 && t !== null && crit !== null && t >= crit ? "PASS" : "FAIL";
  const r3 = (x) => +x.toFixed(3);
  return { sessions: n, weeks: G, bookPct: r3(m), t: t === null ? null : +t.toFixed(2), wonPct: +((100 * days.filter((x) => x.bookPct > 0).length) / n).toFixed(1),
    longExcessPct: r3(mean(days.map((x) => x.longExcessPct))), shortExcessPct: r3(mean(days.map((x) => x.shortExcessPct))), top3Pct: r3(mean(days.map((x) => x.top3Pct))), verdict };
}
module.exports = { RULE, FEATS, readCm, readFut, readIdx, context, features, rows, toCsv, books, summary, tCrit05 };
