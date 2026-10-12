"use strict";
// Shared by prepare.js and score.js: the NSE data, the rebalance plan and the trees' features (./PREREGISTRATION.txt).
const fs = require("node:fs");
const path = require("node:path");
const ROOT = path.resolve(__dirname, "..", "..");
const { context } = require(path.join(ROOT, "api/_lib/forward-v3"));

const START = "2024-07-01", EVERY = 10, TOP = 100, H = 5, CTX = 512, MINBARS = 250, RESET = 0.18;
const FEATURES = ["r1", "r5", "r20", "r60", "vol20", "range20", "volratio", "dist52"];

function load(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort(); const sessions = files.map((f) => f.slice(0, 10)); const bySym = new Map();
  for (const f of files) { const d = f.slice(0, 10); for (const r of JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))) { const [, sym, series, o, h, l, c, , qty, val] = r;
      if (series !== "EQ" || !sym || ![o, h, l, c].every((x) => x > 0)) continue; if (!bySym.has(sym)) bySym.set(sym, { sym, bars: [] }); bySym.get(sym).bars.push({ d, o, h, l, c, val, qty: qty > 0 ? qty : 0 }); } }
  return { sessions, stocks: [...bySym.values()] };
}

// the month's universe IN ORDER of 60-session median traded value (the same rule as forward-v3 context().uni, which returns a Set)
function ranked(stocks, S, m) {
  const first = S.find((d) => d.slice(0, 7) === m); if (!first) return [];
  const out = [];
  for (const st of stocks) { const b = st.bars; let k = 0; while (k < b.length && b[k].d < first) k += 1;
    let lc = 0; for (let i = 1; i < k; i += 1) if (Math.abs(b[i].o / b[i - 1].c - 1) >= RESET) lc = i; if (k - lc < 250) continue;
    const v = b.slice(Math.max(lc, k - 60), k).map((x) => x.val).filter(Number.isFinite).sort((x, y) => x - y); if (v.length) out.push([st.sym, v[Math.floor(v.length / 2)]]); }
  return out.sort((a, b) => b[1] - a[1]).slice(0, 200).map((x) => x[0]);
}

function plan(data, { start = START } = {}) {
  const S = data.sessions; const ctx = context(data); const bySym = new Map(data.stocks.map((s) => [s.sym, s]));
  const rCache = new Map(); const top = (m) => { if (!rCache.has(m)) rCache.set(m, ranked(data.stocks, S, m).slice(0, TOP)); return rCache.get(m); };
  const namesAt = (i, withTarget) => { const e = S[i], d = S[i - 1]; const names = [];
    for (const sym of top(e.slice(0, 7))) { const st = bySym.get(sym); const w = ctx.window(sym, e, H); if (!w) continue;
      const j = w.i - 1; if (j < 0 || st.bars[j].d !== d) continue;   // the stock traded on d, the session before e
      let lc = 0; for (let k = 1; k <= j; k += 1) if (Math.abs(st.bars[k].o / st.bars[k - 1].c - 1) >= RESET) lc = k;
      if (j - lc + 1 < MINBARS) continue; const bars = st.bars.slice(Math.max(lc, j - CTX + 1), j + 1);
      names.push({ sym, bars, w, gross: w.complete ? st.bars[w.i + H - 1].c / st.bars[w.i].o - 1 : null }); }
    if (withTarget) { const g = names.filter((x) => x.gross !== null); const m = g.length ? g.reduce((a, x) => a + x.gross, 0) / g.length : 0; for (const x of names) x.target = x.gross === null ? null : x.gross - m; }
    return names; };
  const rebalances = [], history = [];
  for (let i = 1; i < S.length; i += 1) { if (i % EVERY !== 0) continue;
    if (S[i] < "2021-09-01") continue;   // a year of history first, so the first universe is full
    history.push({ i, e: S[i], d: S[i - 1], names: namesAt(i, true) });
    if (S[i] >= start && S[i + H - 1]) rebalances.push({ i, e: S[i], d: S[i - 1], names: namesAt(i, false) }); }
  return { S, ctx, rebalances, history };
}

function features(bars) {
  const n = bars.length; if (n < 250) return null; const c = bars.map((b) => b.c); const lr = (a, b) => Math.log(c[n - 1 - a] / c[n - 1 - b]);
  const rets = []; for (let k = n - 20; k < n; k += 1) rets.push(Math.log(c[k] / c[k - 1])); const m = rets.reduce((a, x) => a + x, 0) / 20;
  const vol20 = Math.sqrt(rets.reduce((a, x) => a + (x - m) ** 2, 0) / 19);
  const range20 = bars.slice(-20).reduce((a, b) => a + (b.h - b.l) / b.c, 0) / 20;
  const q5 = bars.slice(-5).reduce((a, b) => a + b.qty, 0) / 5, q60 = bars.slice(-60).reduce((a, b) => a + b.qty, 0) / 60;
  const hi = Math.max(...c.slice(-250));
  return [lr(0, 1), lr(0, 5), lr(0, 20), lr(0, 60), vol20, range20, q60 > 0 ? q5 / q60 : 1, c[n - 1] / hi - 1];
}

module.exports = { START, EVERY, TOP, H, CTX, FEATURES, load, plan, features };
