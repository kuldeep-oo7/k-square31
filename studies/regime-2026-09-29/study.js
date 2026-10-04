"use strict";
// Implements EXACTLY research/regime-2026-09-29/PREREGISTRATION.txt
// (sha256 f729272a8067ada0b7547ee4494113b71ac4fc93c571499969cce2af569ca678,
// recorded 2026-09-29T15:26:01Z, before any result was computed).

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const ROOT = path.resolve(__dirname, "..", "..");
const { classifyMarketRegime } = require(path.join(ROOT, "api/_lib/market-regime"));
const { toTick } = require(path.join(ROOT, "api/_lib/session-levels"));
const { calculateNseFuturesCharges } = require(path.join(ROOT, "api/_lib/shadow-broker"));
const { clusterRobustMean } = require(path.join(ROOT, "api/_lib/panel"));

const HERE = __dirname;
const PREREG_SHA = "f729272a8067ada0b7547ee4494113b71ac4fc93c571499969cce2af569ca678";
const sha = crypto.createHash("sha256").update(fs.readFileSync(path.join(HERE, "PREREGISTRATION.txt"))).digest("hex");
if (sha !== PREREG_SHA) { console.error(`PRE-REGISTRATION CHANGED (${sha}); result void.`); process.exit(2); }

const DEV_END = "2024-09-19", FINAL_FROM = "2025-09-18", FINAL_TO = "2026-09-15";
const TICK = 0.05, HOLD = 20, NOTIONAL = 500000;
const bars = JSON.parse(fs.readFileSync(path.join(ROOT, "research/gap-filter-2026-09-29/nifty-50-nse.json"), "utf8")).rows
  .map((r) => ({ date: r.date, open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close) }))
  .filter((b) => [b.open, b.high, b.low, b.close].every((v) => v > 0));
const windowOf = (d) => (d < DEV_END ? "development" : d < FINAL_FROM ? "validation" : d <= FINAL_TO ? "final" : null);
const charges = (side, price, qty, date) => calculateNseFuturesCharges({ side, price, quantity: qty, asOfDate: `${date}T12:00:00Z` }).totalCharges;

function trade(i, side) {
  const d = bars[i];
  const long = side === "LONG";
  const entry = long ? toTick(d.open * 0.992, TICK, "down") : toTick(d.open * 1.008, TICK, "up");
  if (long ? !(d.low < entry) : !(d.high > entry)) return null;                    // unfilled
  const target = toTick(entry * (long ? 1.025 : 0.975), TICK, "nearest");
  const stop = toTick(entry * (long ? 0.985 : 1.015), TICK, "nearest");
  const through = (p, level) => (long ? p <= level : p >= level);                 // adverse: at or through the stop
  const reach = (p, level) => (long ? p >= level : p <= level);                   // favourable: at or through the target
  let exit = null, exitDay = null;
  for (let k = 0; k < HOLD && i + k < bars.length; k += 1) {
    const b = bars[i + k];
    const adverse = long ? b.low : b.high, favour = long ? b.high : b.low;
    if (k === 0) { if (through(adverse, stop)) { exit = stop; exitDay = b.date; break; } continue; }
    if (through(b.open, stop) || reach(b.open, target)) { exit = b.open; exitDay = b.date; break; }
    if (through(adverse, stop)) { exit = stop; exitDay = b.date; break; }
    if (reach(favour, target)) { exit = target; exitDay = b.date; break; }
    if (k === HOLD - 1) { exit = b.close; exitDay = b.date; }
  }
  if (exit === null) { exit = bars[bars.length - 1].close; exitDay = bars[bars.length - 1].date; }
  const qty = Math.ceil(NOTIONAL / entry);
  const cost = (charges(long ? "BUY" : "SELL", entry, qty, d.date) + charges(long ? "SELL" : "BUY", exit, qty, exitDay)) / (entry * qty);
  return (long ? exit / entry - 1 : 1 - exit / entry) - cost;
}

const rows = [];
for (let i = 1; i < bars.length; i += 1) {
  const w = windowOf(bars[i].date);
  if (!w) continue;
  const regime = classifyMarketRegime(bars.slice(0, i)).regime;
  rows.push({ day: bars[i].date, month: bars[i].date.slice(0, 7), window: w, bear: regime === "BEAR_HOSTILE", long: trade(i, "LONG"), short: trade(i, "SHORT") });
}
const stats = (xs) => { const r = clusterRobustMean(xs.map((x) => ({ value: x.v * 100, cluster: x.month }))); return { n: xs.length, months: new Set(xs.map((x) => x.month)).size, meanPct: r.meanPct, t: r.tStat }; };
const pick = (w, cond, side) => rows.filter((r) => r.window === w && cond(r) && r[side] !== null).map((r) => ({ v: r[side], month: r.month }));
function tCritical(df, alpha = 0.05) {
  const lgamma = (x) => { const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x); x -= 1; let a = c[0]; const t = x + g + 0.5; for (let i = 1; i < 9; i += 1) a += c[i] / (x + i); return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a); };
  const pdf = (t) => Math.exp(lgamma((df + 1) / 2) - lgamma(df / 2) - 0.5 * Math.log(df * Math.PI) - ((df + 1) / 2) * Math.log(1 + (t * t) / df));
  const upper = (t) => { let s = 0; const n = 20000, hi = t + 60; const h = (hi - t) / n; for (let i = 0; i <= n; i += 1) s += pdf(t + i * h) * (i === 0 || i === n ? 0.5 : 1); return s * h; };
  let lo = 0, hi = 10; for (let it = 0; it < 60; it += 1) { const mid = (lo + hi) / 2; if (upper(mid) > alpha) lo = mid; else hi = mid; } return (lo + hi) / 2;
}

const out = [];
const line = (s) => { out.push(s); console.log(s); };
line(`NIFTY TREND READER AS A DIRECTION FILTER -- run ${new Date().toISOString()}, prereg sha256 ${PREREG_SHA} (verified)`);
line(`${rows.length} entry days; BEAR_HOSTILE on ${rows.filter((r) => r.bear).length}`);
const res = {};
for (const w of ["development", "validation", "final"]) {
  res[w] = {
    H1: stats(pick(w, (r) => r.bear, "short")),
    H2: stats(pick(w, (r) => !r.bear, "long")),
    longAll: stats(pick(w, () => true, "long")),
    longBear: stats(pick(w, (r) => r.bear, "long")),
    shortAll: stats(pick(w, () => true, "short"))
  };
  const R = res[w];
  line(`\n${w.toUpperCase()}`);
  line(`  H1 shorts in downtrends     mean ${R.H1.meanPct}%  t ${R.H1.t}  (${R.H1.n} trades, ${R.H1.months} months)`);
  line(`  H2 longs outside downtrends mean ${R.H2.meanPct}%  t ${R.H2.t}  (${R.H2.n} trades, ${R.H2.months} months)`);
  line(`     longs every day          mean ${R.longAll.meanPct}%  t ${R.longAll.t}  (${R.longAll.n})`);
  line(`     longs in downtrends      mean ${R.longBear.meanPct}%  t ${R.longBear.t}  (${R.longBear.n})`);
  line(`     shorts every day         mean ${R.shortAll.meanPct}%  t ${R.shortAll.t}  (${R.shortAll.n})`);
}
for (const h of ["H1", "H2"]) {
  const f = res.final[h], v = res.validation[h];
  const crit = tCritical(Math.max(1, f.months - 1));
  const pass = v.meanPct > 0 && f.meanPct > 0 && f.t >= crit;
  line(`\n${h}: validation mean ${v.meanPct} > 0? final mean ${f.meanPct} > 0? final t ${f.t} >= ${crit.toFixed(3)} (df ${f.months - 1})?  VERDICT: ${pass ? "PASS" : "FAIL"}`);
}
fs.writeFileSync(path.join(HERE, "RESULT.txt"), out.join("\n") + "\n");
