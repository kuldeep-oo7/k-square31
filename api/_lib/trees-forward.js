"use strict";
// THE TREES FORWARD PAPER WATCH (studies/trees-forward-2026-10-22/PREREGISTRATION.txt): the combined model's C1 trees
// long-short, run live as tested. The model itself runs in .github/workflows/trees.yml (features.js + model.py at commit
// 04a0b39); this module keeps the schedule, the lists and the score. Kept apart from kronos-forward.js on purpose.
const { calculateNseFuturesCharges } = require("./shadow-broker");
const { context } = require("./forward-v3");

const RULE = { first: "2022-10-03", every: 5, lag: 2, h: 5, minNames: 50, notional: 500000, verdictBooks: 52, nwLags: 4,
  registeredAt: "2026-10-22T03:05:11Z" };   // commit a62f846, 08:35:11 IST: only lists made after it count

// rebalance feature dates: every 5th NSE session counted from the first session on or after 2022-10-03 (model.py)
function schedule(sessions) {
  const first = sessions.findIndex((d) => d >= RULE.first); if (first < 0) return { first: -1, isRebalance: () => false };
  return { first, isRebalance: (i) => i >= first && (i - first) % RULE.every === 0 };
}

// One stored list: longs = top tenth by the trees' prediction, shorts = bottom tenth. Symbols only (predictions stay private).
// preds: Map(sym -> T) in the predictions file's row order; ties keep that order (a stable sort, as the study's score.js).
function makeList({ d, entry, exit, preds, madeAt, futSyms, contractFor, coverage }) {
  const ranked = [...preds].filter(([, v]) => Number.isFinite(v)).sort((a, b) => b[1] - a[1]);
  const k = Math.floor(ranked.length / 10); const enough = ranked.length >= RULE.minNames;
  const pick = (list) => list.map(([symbol]) => ({ symbol, futures: futSyms.has(symbol), expiry: contractFor(symbol, exit) }));
  return { signalDate: d, entry, exit, madeAt, names: ranked.length, enough, long: enough ? pick(ranked.slice(0, k)) : [], short: enough ? pick(ranked.slice(-k).reverse()) : [], coverage: coverage || null };
}
const onTime = (list) => Date.parse(list.madeAt) < Date.parse(`${list.entry}T09:15:00+05:30`);
const counted = (list) => list.enough && onTime(list) && Date.parse(list.madeAt) > Date.parse(RULE.registeredAt);

// the study's charges (combined-model score.js futNet): both sides, quantity ceil(500000 / entry), one roll per month crossed
const fc = (side, p, q, d) => calculateNseFuturesCharges({ side, price: p, quantity: q, asOfDate: `${d}T12:00:00Z` }).totalCharges;
function futNet(side, e, x, d, xd) { const q = Math.ceil(RULE.notional / e); const cross = (+xd.slice(0, 4) - +d.slice(0, 4)) * 12 + (+xd.slice(5, 7) - +d.slice(5, 7));
  return side * (x / e - 1) - (fc(side > 0 ? "BUY" : "SELL", e, q, d) + fc(side > 0 ? "SELL" : "BUY", x, q, xd) + cross * (fc("BUY", x, q, xd) + fc("SELL", x, q, xd))) / (e * q); }
// one leg, as features.js labels it: forward-v3 context().window over h sessions from the entry (contiguous, no reset)
function leg(ctx, sym, entry, side) {
  const w = ctx.window(sym, entry, RULE.h); if (!w) return ctx.sIndex.has(entry) ? { status: "VOID" } : { status: "OPEN" };
  // not complete: OPEN only while the market itself has not reached the 5th session; a stock that stopped trading inside
  // its window is VOID, as the study drops it (replay 22 Oct 2026: two books were held OPEN forever by such a leg)
  if (!w.complete) return ctx.sIndex.get(entry) + RULE.h - 1 <= ctx.S.length - 1 ? { status: "VOID" } : { status: "OPEN" };
  const b = w.st.bars; const e = b[w.i].o, x = b[w.i + RULE.h - 1].c, xd = b[w.i + RULE.h - 1].d;
  return { status: "DONE", entry: e, exit: x, exitDate: xd, net: futNet(side, e, x, entry, xd) };
}
function bookValue(ctx, list) {
  const L = [], S = []; let open = false;
  for (const [side, names, out] of [[1, list.long, L], [-1, list.short, S]]) for (const p of names) { const r = leg(ctx, p.symbol, list.entry, side); if (r.status === "OPEN") open = true; else if (r.status === "DONE") out.push(r.net); }
  if (open) return { status: "OPEN" }; if (!L.length || !S.length) return { status: "VOID" };
  const m = (a) => a.reduce((s, v) => s + v, 0) / a.length; return { status: "DONE", value: (m(L) + m(S)) / 2, nLong: L.length, nShort: S.length };
}
function nwT(x, lags) { const n = x.length; if (n < 3) return null; const m = x.reduce((a, v) => a + v, 0) / n; const e = x.map((v) => v - m);
  let s = e.reduce((a, v) => a + v * v, 0) / n; for (let L = 1; L <= Math.min(lags, n - 1); L += 1) { let g = 0; for (let i = L; i < n; i += 1) g += e[i] * e[i - L]; s += 2 * (1 - L / (lags + 1)) * (g / n); }
  return s > 0 ? m / Math.sqrt(s / n) : null; }

// Scores every stored list. data: { sessions, stocks } (NSE CM, shares). ctx may be passed in to reuse.
function score(lists, data, ctx = context(data)) {
  const books = [];
  for (const list of Object.values(lists).sort((a, b) => (a.entry < b.entry ? -1 : 1))) {
    if (!list.enough) continue; if (!counted(list)) { books.push({ entry: list.entry, status: onTime(list) ? "BEFORE REGISTRATION" : "LATE" }); continue; }
    const v = bookValue(ctx, list); books.push({ entry: list.entry, exit: list.exit, status: v.status, valuePct: v.status === "DONE" ? +(v.value * 100).toFixed(3) : undefined }); }
  const done = books.filter((x) => x.status === "DONE"); const vals = done.map((x) => x.valuePct); const n = vals.length;
  const m = n ? vals.reduce((a, v) => a + v, 0) / n : null; const t = nwT(vals, RULE.nwLags);
  const verdict = n < RULE.verdictBooks ? "COLLECTING" : m > 0 && t !== null && t >= 3 ? "PASS" : "FAIL";
  return { books, summary: { finished: n, meanPct: m === null ? null : +m.toFixed(3), winPct: n ? +((100 * vals.filter((v) => v > 0).length) / n).toFixed(1) : null, t: t === null ? null : +t.toFixed(2), verdict } };
}

// REPLAY (registration): the study's C1 through this module's scoring, from its predictions [{ i, d, sym, T }]. dataEnd: the
// study's data end (its amendment A2, 2026-10-09): a book whose 5th session is after it could not be scored by the study.
function replayC1(preds, data, dataEnd = "2026-10-09") {
  const ctx = context(data); const S = data.sessions; const byI = new Map(); for (const r of preds) { if (!byI.has(r.i)) byI.set(r.i, new Map()); byI.get(r.i).set(r.sym, r.T); }
  const out = [];
  for (const i of [...byI.keys()].sort((a, b) => a - b)) { const entry = S[i + RULE.lag]; if (!entry || !S[i + RULE.lag + RULE.h - 1] || S[i + RULE.lag + RULE.h - 1] > dataEnd) continue;
    const list = makeList({ d: S[i], entry, exit: null, preds: byI.get(i), madeAt: "", futSyms: new Set(), contractFor: () => null });
    if (!list.enough) continue; const v = bookValue(ctx, list); if (v.status === "DONE") out.push({ day: entry, value: v.value }); }
  const month = new Map(); for (const o of out) month.set(o.day.slice(0, 7), (month.get(o.day.slice(0, 7)) || []).concat(o.value));
  const s = [...month.keys()].sort().map((k) => (month.get(k).reduce((a, v) => a + v, 0) / month.get(k).length) * 100);
  return { rebalances: out.length, meanPct: (out.reduce((a, o) => a + o.value, 0) / out.length) * 100, winPct: (100 * out.filter((o) => o.value > 0).length) / out.length, t: nwT(s, 3) };
}
module.exports = { RULE, schedule, makeList, onTime, counted, futNet, leg, bookValue, score, replayC1 };
