"use strict";
// Implements EXACTLY ./PREREGISTRATION-v2.txt (sha256 in ./PREREGISTRATION-v2.sha256).
//   node study.js --synthetic   code checks on invented data (planted edge, random walk, no look-ahead)
//   node study.js               the one real run
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const ROOT = path.resolve(__dirname, "..", "..");
const { classifyMarketRegime } = require(path.join(ROOT, "api/_lib/market-regime"));
const { toTick } = require(path.join(ROOT, "api/_lib/session-levels"));
const { calculateNseFuturesCharges } = require(path.join(ROOT, "api/_lib/shadow-broker"));
const { clusterRobustMean } = require(path.join(ROOT, "api/_lib/panel"));

const HERE = __dirname;
const SHA = fs.readFileSync(path.join(HERE, "PREREGISTRATION-v2.sha256"), "utf8").split(/\s+/)[0];
const actual = crypto.createHash("sha256").update(fs.readFileSync(path.join(HERE, "PREREGISTRATION-v2.txt"))).digest("hex");
if (actual !== SHA) { console.error(`PRE-REGISTRATION CHANGED (${actual}); result void.`); process.exit(2); }

const DEV_END = "2024-09-19", FINAL_FROM = "2025-09-18", FINAL_TO = "2026-09-15";
const HOLD = 20, TICK = 0.05, NOTIONAL = 500000, LOOKBACK = 66, UNIVERSE = 200, VALUE_WINDOW = 60, RESET = 0.18;
const windowOf = (d) => (d < DEV_END ? "development" : d < FINAL_FROM ? "validation" : d <= FINAL_TO ? "final" : null);
const charge = (side, price, qty, date) => calculateNseFuturesCharges({ side, price, quantity: qty, asOfDate: `${date}T12:00:00Z` }).totalCharges;

// ---------- the engine (same code for synthetic and real data) ----------
// data: { sessions: [iso...], nifty: Map(iso -> {open,high,low,close}), stocks: [{ id, sym, bars: [{d,o,h,l,c,pc,val}] }] }
function run(data, { costs = true } = {}) {
  const sIndex = new Map(data.sessions.map((d, i) => [d, i]));
  const niftyDates = [...data.nifty.keys()].sort();
  const niftyBars = niftyDates.map((d) => ({ ...data.nifty.get(d), timestamp: Date.parse(d) / 1000 }));
  const niftyDown = new Map();   // entry session -> NIFTY in a downtrend on bars up to the session before
  for (let i = 1; i < data.sessions.length; i += 1) {
    const prev = data.sessions[i - 1];
    let k = niftyDates.length - 1; while (k >= 0 && niftyDates[k] > prev) k -= 1;
    if (k < 49) continue;
    niftyDown.set(data.sessions[i], classifyMarketRegime(niftyBars.slice(0, k + 1)).regime === "BEAR_HOSTILE");
  }
  // the universe, fixed on each month's first session from data before it
  const months = new Map();
  for (const d of data.sessions) { const m = d.slice(0, 7); if (!months.has(m)) months.set(m, d); }
  const members = new Map();
  for (const [m, first] of months) {
    const ranked = [];
    for (const st of data.stocks) {
      let n = 0; while (n < st.bars.length && st.bars[n].d < first) n += 1;
      if (n < LOOKBACK) continue;
      const vals = st.bars.slice(Math.max(0, n - VALUE_WINDOW), n).map((b) => b.val).filter(Number.isFinite).sort((a, b) => a - b);
      if (!vals.length) continue;
      ranked.push([st.id, vals[Math.floor(vals.length / 2)]]);
    }
    ranked.sort((a, b) => b[1] - a[1]);
    members.set(m, new Set(ranked.slice(0, UNIVERSE).map((x) => x[0])));
  }
  const trades = [];
  let dropped = 0;
  for (const st of data.stocks) {
    const bars = st.bars;
    // v2: a reset is an open >= 18% away from the previous close; nothing is adjusted
    const reset = bars.map((b, i) => i > 0 && Math.abs(b.o / bars[i - 1].c - 1) >= RESET);
    const plain = bars.map((b) => ({ open: b.o, high: b.h, low: b.l, close: b.c, timestamp: Date.parse(b.d) / 1000 }));
    let lastReset = -1;
    for (let i = 1; i < bars.length; i += 1) {
      if (reset[i - 1]) lastReset = i - 1;
      if (i < LOOKBACK || lastReset > i - LOOKBACK) continue;   // the 66 signal bars must all be after the last reset
      const d = bars[i].d;
      const win = windowOf(d);
      if (!win || !niftyDown.has(d) || !members.get(d.slice(0, 7))?.has(st.id)) continue;
      if (sIndex.get(bars[i - 1].d) !== sIndex.get(d) - 1) continue;   // the stock did not trade on d-1
      const regime = classifyMarketRegime(plain.slice(i - LOOKBACK, i)).regime;
      const down = niftyDown.get(d);
      const member = down && regime === "BULL_TRENDING" ? "H1" : down && regime === "BEAR_HOSTILE" ? "H2" : !down && regime === "BULL_TRENDING" ? "H3" : null;
      if (!member) continue;
      const long = member !== "H2";
      const t = simulate(bars, i, long);
      if (!t) continue;
      if (reset.slice(i, t.exitIndex + 1).some(Boolean)) { dropped += 1; continue; }
      const qty = Math.ceil(NOTIONAL / t.entry);
      const exitDay = bars[t.exitIndex].d;
      let cost = 0;
      if (costs) {
        cost = charge(long ? "BUY" : "SELL", t.entry, qty, d) + charge(long ? "SELL" : "BUY", t.exit, qty, exitDay);
        const rolls = new Set(bars.slice(i, t.exitIndex + 1).map((b) => b.d.slice(0, 7))).size - 1;
        for (let r = 0; r < rolls; r += 1) cost += charge("BUY", t.exit, qty, exitDay) + charge("SELL", t.exit, qty, exitDay);
      }
      const gross = long ? t.exit / t.entry - 1 : 1 - t.exit / t.entry;
      trades.push({ member, sym: st.sym, day: d, window: win, net: gross - cost / (t.entry * qty), gross });
    }
  }
  return { trades, dropped, niftyDownDays: [...niftyDown.values()].filter(Boolean).length };
}

function simulate(bars, i, long) {
  const { o: open, h: high0, l: low0 } = bars[i];
  const last = () => ({ exit: bars[bars.length - 1].c, exitIndex: bars.length - 1 });
  if (long) {
    const entry = toTick(open * 0.992, TICK, "down");
    if (!(low0 < entry)) return null;
    const target = toTick(entry * 1.025, TICK, "nearest"), stop = toTick(entry * 0.985, TICK, "nearest");
    if (low0 <= stop) return { entry, exit: stop, exitIndex: i };
    for (let k = 1; k < HOLD; k += 1) {
      const j = i + k; if (j >= bars.length) return { entry, ...last() };
      const b = bars[j];
      if (b.o <= stop || b.o >= target) return { entry, exit: b.o, exitIndex: j };
      if (b.l <= stop) return { entry, exit: stop, exitIndex: j };
      if (b.h >= target) return { entry, exit: target, exitIndex: j };
      if (k === HOLD - 1) return { entry, exit: b.c, exitIndex: j };
    }
  } else {
    const entry = toTick(open * 1.008, TICK, "up");
    if (!(high0 > entry)) return null;
    const target = toTick(entry * 0.975, TICK, "nearest"), stop = toTick(entry * 1.015, TICK, "nearest");
    if (high0 >= stop) return { entry, exit: stop, exitIndex: i };
    for (let k = 1; k < HOLD; k += 1) {
      const j = i + k; if (j >= bars.length) return { entry, ...last() };
      const b = bars[j];
      if (b.o >= stop || b.o <= target) return { entry, exit: b.o, exitIndex: j };
      if (b.h >= stop) return { entry, exit: stop, exitIndex: j };
      if (b.l <= target) return { entry, exit: target, exitIndex: j };
      if (k === HOLD - 1) return { entry, exit: b.c, exitIndex: j };
    }
  }
  return null;
}

// ---------- statistics ----------
function lgamma(x) { const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x); x -= 1; let a = c[0]; const t = x + g + 0.5; for (let i = 1; i < 9; i += 1) a += c[i] / (x + i); return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a); }
function pUpper(t, df) { // one-sided p = P(T >= t), Student-t with df degrees of freedom
  if (!Number.isFinite(t) || df < 1) return 1;
  const pdf = (x) => Math.exp(lgamma((df + 1) / 2) - lgamma(df / 2) - 0.5 * Math.log(df * Math.PI) - ((df + 1) / 2) * Math.log(1 + (x * x) / df));
  const n = 40000, hi = Math.max(t, 0) + 80; let s = 0; const h = (hi - t) / n;
  for (let i = 0; i <= n; i += 1) s += pdf(t + i * h) * (i === 0 || i === n ? 0.5 : 1);
  return Math.min(1, Math.max(0, s * h)); }
function stats(rows) {
  if (!rows.length) return { trades: 0, months: 0, meanPct: null, t: null, winPct: null };
  const r = clusterRobustMean(rows.map((x) => ({ value: x.net * 100, cluster: x.day.slice(0, 7) })));
  return { trades: rows.length, months: new Set(rows.map((x) => x.day.slice(0, 7))).size, meanPct: r.meanPct, t: r.tStat,
    winPct: (100 * rows.filter((x) => x.net > 0).length) / rows.length };
}
function verdicts(trades) {
  const out = {};
  for (const m of ["H1", "H2", "H3"]) {
    const by = (w) => stats(trades.filter((x) => x.member === m && x.window === w));
    out[m] = { development: by("development"), validation: by("validation"), final: by("final") };
    const f = out[m].final;
    out[m].p = f.trades ? pUpper(f.t, f.months - 1) : 1;
  }
  const order = Object.keys(out).sort((a, b) => out[a].p - out[b].p);
  let stillOk = true;
  order.forEach((m, k) => {
    const o = out[m], alpha = 0.05 / (order.length - k);
    const holm = stillOk && o.p <= alpha; if (!holm) stillOk = false;
    o.holmAlpha = alpha;
    o.verdict = o.final.trades < 30 ? "NOT TESTABLE"
      : o.validation.meanPct > 0 && o.final.meanPct > 0 && holm ? "PASS" : "FAIL";
  });
  return out;
}

// ---------- synthetic checks ----------
function synthetic(seed, { plant = false } = {}) {
  let s = seed; const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const sessions = []; for (let t = Date.parse("2021-01-04"); sessions.length < 1450; t += 86400000) { const d = new Date(t); if (d.getUTCDay() % 6) sessions.push(d.toISOString().slice(0, 10)); }
  const nifty = new Map(); let nx = 15000;
  // NIFTY alternates long up and down phases so both regimes occur
  sessions.forEach((d, i) => { const drift = Math.sin(i / 60) * 0.002; const o = nx; nx *= 1 + drift + 0.008 * gauss(); nifty.set(d, { open: o, high: Math.max(o, nx) * 1.003, low: Math.min(o, nx) * 0.997, close: nx }); });
  const stocks = [];
  for (let k = 0; k < 60; k += 1) {
    let px = 100 + 900 * rnd(); const bars = []; let mom = 0;
    sessions.forEach((d) => {
      // planted: persistent trends (a stock rising keeps rising); otherwise a pure random walk
      if (plant) mom = 0.97 * mom + 0.0012 * gauss();
      const o = px * (1 + 0.004 * gauss());
      const c = o * (1 + (plant ? mom * 4 : 0) + 0.015 * gauss());
      const h = Math.max(o, c) * (1 + Math.abs(0.008 * gauss())), l = Math.min(o, c) * (1 - Math.abs(0.008 * gauss()));
      bars.push({ d, o, h, l, c, pc: px, val: 1e8 * (1 + rnd()) }); px = c;
    });
    stocks.push({ id: `S${k}`, sym: `S${k}`, bars });
  }
  return { sessions, nifty, stocks };
}

const out = [];
const line = (s) => { console.log(s); out.push(s); };
const fmt = (st) => st.trades ? `mean ${st.meanPct >= 0 ? "+" : ""}${st.meanPct.toFixed(3)}%  t ${st.t.toFixed(2)}  win ${st.winPct.toFixed(1)}%  (${st.trades} trades, ${st.months} months)` : "no trades";

if (process.argv.includes("--synthetic")) {
  const planted = verdicts(run(synthetic(7, { plant: true }), { costs: false }).trades);
  line(`(1) planted edge, H1 long final: ${fmt(planted.H1.final)}; H3: ${fmt(planted.H3.final)}`);
  const ok1 = planted.H3.final.meanPct > 0 && planted.H3.final.t > 2;
  line(`    planted edge found (H3 mean > 0, t > 2): ${ok1 ? "YES" : "NO"}`);
  let passes = 0;
  for (let seed = 1; seed <= 10; seed += 1) { const v = verdicts(run(synthetic(seed * 97)).trades); passes += ["H1", "H2", "H3"].filter((m) => v[m].verdict === "PASS").length; }
  line(`(2) 10 random walks x 3 members: ${passes} PASS (want 0, or at most a chance one)`);
  const base = synthetic(11); const cut = base.sessions[1000];
  const a = run(base).trades.filter((x) => x.day < base.sessions[1000 - 21]);
  for (const st of base.stocks) for (const b of st.bars) if (b.d >= cut) { b.o *= 1.3; b.h *= 1.4; b.l *= 0.8; b.c *= 0.7; }
  for (const [d, b] of base.nifty) if (d >= cut) base.nifty.set(d, { ...b, close: b.close * 0.5 });
  const b2 = run(base).trades.filter((x) => x.day < base.sessions[1000 - 21]);
  const same = a.length === b2.length && a.every((x, k) => x.day === b2[k].day && x.sym === b2[k].sym && x.net === b2[k].net);
  line(`(3) changing every price after ${cut}: ${a.length} earlier trades ${same ? "IDENTICAL" : "CHANGED -- LOOK-AHEAD"}`);
  process.exit(ok1 && passes <= 1 && same ? 0 : 1);
}

// ---------- the real data (v2: keyed by NSE symbol, series EQ) ----------
const cmDir = path.join(HERE, "nse-data", "cm");
const files = fs.readdirSync(cmDir).filter((f) => f.endsWith(".json")).sort();
const sessions = files.map((f) => f.slice(0, 10));
const bySym = new Map();
for (const f of files) {
  const d = f.slice(0, 10);
  for (const r of JSON.parse(fs.readFileSync(path.join(cmDir, f), "utf8"))) {
    const [, sym, series, o, h, l, c, pc, , val] = r;
    if (series !== "EQ" || !sym || ![o, h, l, c].every((v) => v > 0)) continue;
    if (!bySym.has(sym)) bySym.set(sym, { id: sym, sym, bars: [] });
    bySym.get(sym).bars.push({ d, o, h, l, c, pc, val });
  }
}
// v2: the three known resets must be detected as reset days.
for (const [sym, day] of [["RELIANCE", "2024-10-28"], ["TATASTEEL", "2022-07-28"], ["IRCTC", "2021-10-28"]]) {
  const st = bySym.get(sym); const i = st ? st.bars.findIndex((b) => b.d === day) : -1;
  const g = i > 0 ? st.bars[i].o / st.bars[i - 1].c - 1 : null;
  line(`reset ${sym} ${day}: open/close(t-1) - 1 = ${g === null ? "missing" : (100 * g).toFixed(1) + "%"} ${g !== null && Math.abs(g) >= RESET ? "detected" : "NOT DETECTED"}`);
}
const nifty = new Map(JSON.parse(fs.readFileSync(path.join(HERE, "nse-data", "nifty-50-nse.json"), "utf8")).rows
  .map((r) => [r.date, { open: r.open, high: r.high, low: r.low, close: r.close }]));
const res = run({ sessions, nifty, stocks: [...bySym.values()] });
const v = verdicts(res.trades);
line(`RISING ON THEIR OWN -- run ${new Date().toISOString()}, prereg v2 sha256 ${SHA} (verified)`);
line(`${bySym.size} EQ symbols, ${sessions.length} sessions; NIFTY in a downtrend on ${res.niftyDownDays} entry sessions; ${res.dropped} trades dropped for a reset`);
const names = { H1: "H1 NIFTY down, stock RISING -> long  (the live rule)", H2: "H2 NIFTY down, stock FALLING -> short (the live puts)", H3: "H3 NIFTY not down, stock RISING -> long" };
for (const m of ["H1", "H2", "H3"]) {
  line(""); line(names[m]);
  for (const w of ["development", "validation", "final"]) line(`  ${w.padEnd(12)} ${fmt(v[m][w])}`);
  line(`  final one-sided p ${v[m].p.toExponential(2)} vs Holm ${v[m].holmAlpha.toFixed(4)}  ->  VERDICT: ${v[m].verdict}`);
}
fs.writeFileSync(path.join(HERE, "RESULT.txt"), out.join("\n") + "\n");
fs.writeFileSync(path.join(HERE, "result.json"), JSON.stringify({ sha: SHA, verdicts: v, dropped: res.dropped }, null, 2));
