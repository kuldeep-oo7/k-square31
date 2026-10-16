"use strict";
// Kronos forward paper watch ("KF"), studies/kronos-forward-2026-10-16/PREREGISTRATION.txt. Kronos FAILED its test
// (t 1.35); this only watches it on future prices, for GM Global paper. The forecasts come from scripts/kronos-forecast.py.
const fs = require("node:fs");
const path = require("node:path");
const { calculateNseFuturesCharges } = require("./shadow-broker");
const { isoWeek } = require("./springy-dip");

const RULE = { start: "2026-10-19", top: 100, rank: 200, valueWindow: 60, minBars: 250, ctx: 512, h: 5, reset: 0.18, minNames: 20,
  notional: 500000, verdictWeeks: 52, nwLags: 4 };

// NSE CM bhavcopy files (YYYY-MM-DD.json: [isin, symbol, series, open, high, low, close, prevClose, volume, value]), EQ only.
function loadCm(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort(); const sessions = files.map((f) => f.slice(0, 10)); const bySym = new Map();
  for (const f of files) { const d = f.slice(0, 10);
    for (const r of JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))) { const [, sym, series, o, h, l, c, , qty, val] = r;
      if (series !== "EQ" || !sym || ![o, h, l, c].every((x) => x > 0)) continue;
      if (!bySym.has(sym)) bySym.set(sym, []); bySym.get(sym).push({ d, o, h, l, c, val, qty: qty > 0 ? qty : 0 }); } }
  return { sessions, bySym };
}
const isReset = (b, i) => i > 0 && Math.abs(b[i].o / b[i - 1].c - 1) >= RULE.reset;
const lastReset = (b, upto) => { let lc = 0; for (let i = 1; i <= upto; i += 1) if (isReset(b, i)) lc = i; return lc; };

// The month's first 100 by median traded value, LIVE ONLY: the stock must have a bar on the session before the month's first.
function universe({ sessions, bySym }, month) {
  const fi = sessions.findIndex((d) => d.slice(0, 7) === month); if (fi < 1) return [];
  const first = sessions[fi], prev = sessions[fi - 1]; const out = [];
  for (const [sym, b] of bySym) { let k = 0; while (k < b.length && b[k].d < first) k += 1;
    if (!k || b[k - 1].d !== prev) continue;                          // stopped trading: not ranked (DIFFERENCE 1)
    const lc = lastReset(b, k - 1); if (k - lc < RULE.minBars) continue;
    const v = b.slice(Math.max(lc, k - RULE.valueWindow), k).map((x) => x.val).filter(Number.isFinite).sort((x, y) => x - y);
    if (v.length) out.push([sym, v[Math.floor(v.length / 2)]]); }
  return out.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, RULE.rank).slice(0, RULE.top).map((x) => x[0]);
}

// The model inputs for session d, sorted by symbol. futSyms: the symbols with stock futures (STF) in NSE's F&O file of d.
function inputsFor(data, d, futSyms, nextTradingDate) {
  const ty = []; let q = d; for (let k = 0; k < RULE.h; k += 1) { q = nextTradingDate(q); ty.push(q); }
  const rows = [];
  for (const sym of universe(data, d.slice(0, 7)).slice().sort()) { if (!futSyms.has(sym)) continue;   // DIFFERENCE 2
    const b = data.bySym.get(sym); const j = b.findIndex((x) => x.d === d); if (j < 0) continue;
    const lc = lastReset(b, j); if (j - lc + 1 < RULE.minBars) continue; const bars = b.slice(Math.max(lc, j - RULE.ctx + 1), j + 1);
    rows.push({ sym, t: bars.map((x) => x.d), ty, o: bars.map((x) => x.o), h: bars.map((x) => x.h), l: bars.map((x) => x.l), c: bars.map((x) => x.c), v: bars.map((x) => x.qty) }); }
  return rows;
}

// One stored day from the forecasts: longs = top tenth, shorts = bottom tenth. contractFor(sym, exitDate) -> expiry or null.
function makeDay({ d, entry, exit, preds, madeAt, contractFor }) {
  const ranked = Object.entries(preds).filter(([, v]) => Number.isFinite(v)).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const k = Math.floor(ranked.length / 10);
  const pick = (list) => list.map(([symbol, p]) => ({ symbol, predPct: +(p * 100).toFixed(2), expiry: contractFor(symbol, exit) }));
  return { signalDate: d, entry, exit, madeAt, names: ranked.length, enough: ranked.length >= RULE.minNames,
    long: ranked.length >= RULE.minNames ? pick(ranked.slice(0, k)) : [], short: ranked.length >= RULE.minNames ? pick(ranked.slice(-k).reverse()) : [],
    preds: Object.fromEntries(ranked.map(([s, p]) => [s, +p.toFixed(6)])) };
}

// A list counts only if it was made before 09:15 IST on its entry day.
const onTime = (day) => Date.parse(day.madeAt) < Date.parse(`${day.entry}T09:15:00+05:30`);

const charge = (side, price, qty, date) => calculateNseFuturesCharges({ side, price, quantity: qty, asOfDate: `${date}T12:00:00Z` }).totalCharges;
function tradeNet(b, i, side) {   // b: bars, i: index of the entry bar; null if not finished, "VOID" across a reset
  const j = i + RULE.h - 1; if (j >= b.length) return null;
  for (let k = i; k <= j; k += 1) if (isReset(b, k)) return "VOID";
  const e = b[i].o, x = b[j].c, q = Math.ceil(RULE.notional / e); const rolls = new Set(b.slice(i, j + 1).map((y) => y.d.slice(0, 7))).size - 1;
  const cost = charge(side > 0 ? "BUY" : "SELL", e, q, b[i].d) + charge(side > 0 ? "SELL" : "BUY", x, q, b[j].d) + rolls * (charge("BUY", x, q, b[j].d) + charge("SELL", x, q, b[j].d));
  return { entry: e, exit: x, exitDate: b[j].d, net: side * (x / e - 1) - cost / (e * q) };
}
function nwT(x, lags) { const n = x.length; if (n < 3) return null; const m = x.reduce((a, v) => a + v, 0) / n; const e = x.map((v) => v - m);
  let s = e.reduce((a, v) => a + v * v, 0) / n; for (let L = 1; L <= Math.min(lags, n - 1); L += 1) { let g = 0; for (let i = L; i < n; i += 1) g += e[i] * e[i - L]; s += 2 * (1 - L / (lags + 1)) * (g / n); }
  return s > 0 ? m / Math.sqrt(s / n) : null; }

// Scores every stored day (entry >= start, on time). The trades are the stocks' shares (CM open and close), as registered.
function score(days, data) {
  const books = [];
  for (const day of Object.values(days).sort((a, b) => (a.entry < b.entry ? -1 : 1))) {
    if (day.entry < RULE.start || !day.enough) continue;
    if (!onTime(day)) { books.push({ entry: day.entry, status: "LATE" }); continue; }
    const legs = []; let open = false;
    for (const [side, list] of [[1, day.long], [-1, day.short]]) for (const p of list) { const b = data.bySym.get(p.symbol); const i = b ? b.findIndex((x) => x.d === day.entry) : -1;
      if (i < 0) { if (data.sessions.includes(day.entry)) legs.push({ symbol: p.symbol, side, status: "VOID (no price)" }); else open = true; continue; }
      const t = tradeNet(b, i, side); if (t === null) { open = true; continue; }
      legs.push(t === "VOID" ? { symbol: p.symbol, side, status: "VOID (corporate action)" } : { symbol: p.symbol, side, ...t, netPct: +(t.net * 100).toFixed(3), status: "DONE" }); }
    const L = legs.filter((x) => x.status === "DONE" && x.side > 0), S = legs.filter((x) => x.status === "DONE" && x.side < 0);
    const mean = (a) => a.reduce((s, x) => s + x.net, 0) / a.length;
    books.push(open || !L.length || !S.length ? { entry: day.entry, status: open ? "OPEN" : "VOID", legs } : { entry: day.entry, status: "DONE", valuePct: +(((mean(L) + mean(S)) / 2) * 100).toFixed(3), legs }); }
  const done = books.filter((x) => x.status === "DONE"); const byWeek = new Map();
  for (const x of done) { const w = isoWeek(x.entry); if (!byWeek.has(w)) byWeek.set(w, []); byWeek.get(w).push(x.valuePct); }
  const weekly = [...byWeek.keys()].sort().map((w) => byWeek.get(w).reduce((a, v) => a + v, 0) / byWeek.get(w).length);
  const n = done.length, m = n ? done.reduce((a, x) => a + x.valuePct, 0) / n : null; const t = nwT(weekly, RULE.nwLags);
  const wm = weekly.length ? weekly.reduce((a, v) => a + v, 0) / weekly.length : null;
  const verdict = weekly.length < RULE.verdictWeeks ? "COLLECTING" : wm > 0 && t !== null && t >= 3 ? "PASS" : "FAIL";
  return { books, summary: { finished: n, meanPct: m === null ? null : +m.toFixed(3), winPct: n ? +((100 * done.filter((x) => x.valuePct > 0).length) / n).toFixed(1) : null,
    weeks: weekly.length, t: t === null ? null : +t.toFixed(2), verdict } };
}

module.exports = { RULE, loadCm, universe, inputsFor, makeDay, onTime, score, tradeNet };
