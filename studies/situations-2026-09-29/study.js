"use strict";
// Implements EXACTLY research/situations-2026-09-29/PREREGISTRATION.txt
// (sha256 03f93c90f2501a306cb8a701351091fd58bac5c57d1af706cf6b7f27bbb6bdf7,
// recorded 2026-09-29T17:27:09Z, before any result was computed).
// Part A: A1-A5 on NIFTY now; P1 (stock candles) needs the complete NSE panel and is run
// separately when it is final. Until then the multiplicity verdict is the conservative
// Bonferroni bound (p <= 0.05/6), which Holm can only loosen, never tighten.
// Part B: descriptive, by situation.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const HERE = __dirname;
const ROOT = path.resolve(HERE, "..", "..");
const { classifyMarketRegime } = require(path.join(ROOT, "api/_lib/market-regime"));
const { identifyCandlestickPatterns } = require(path.join(ROOT, "api/_lib/candlestick-engine"));
const { toTick } = require(path.join(ROOT, "api/_lib/session-levels"));
const { calculateNseFuturesCharges } = require(path.join(ROOT, "api/_lib/shadow-broker"));
const { clusterRobustMean } = require(path.join(ROOT, "api/_lib/panel"));

const PREREG_SHA = "03f93c90f2501a306cb8a701351091fd58bac5c57d1af706cf6b7f27bbb6bdf7";
const sha = crypto.createHash("sha256").update(fs.readFileSync(path.join(HERE, "PREREGISTRATION.txt"))).digest("hex");
if (sha !== PREREG_SHA) { console.error(`PRE-REGISTRATION CHANGED (${sha}); result void.`); process.exit(2); }

const DEV_END = "2024-09-19", FINAL_FROM = "2025-09-18", FINAL_TO = "2026-09-15";
const TICK = 0.05, HOLD = 20, NOTIONAL = 500000;
const windowOf = (d) => (d < DEV_END ? "development" : d < FINAL_FROM ? "validation" : d <= FINAL_TO ? "final" : null);

// ---- data --------------------------------------------------------------------
const bars = JSON.parse(fs.readFileSync(path.join(ROOT, "research/gap-filter-2026-09-29/nifty-50-nse.json"), "utf8")).rows
  .map((r) => ({ date: r.date, open: Number(r.open), high: Number(r.high), low: Number(r.low), close: Number(r.close) }))
  .filter((b) => [b.open, b.high, b.low, b.close].every((v) => v > 0));
const sessions = new Set(bars.map((b) => b.date));
const exp = JSON.parse(fs.readFileSync(path.join(HERE, "nifty-expiries-nse.json"), "utf8"));
const weekly = new Set(exp.OPTIDX.filter((d) => sessions.has(d)));
const monthly = exp.FUTIDX.filter((d) => sessions.has(d)).sort();
const series = (name) => JSON.parse(fs.readFileSync(path.join(HERE, `yahoo-${name}.json`), "utf8")).rows;
const sp = series("sp500"), brent = series("brent"), vix = series("indiavix");

// The last row of a series dated strictly BEFORE `day`, and its close-to-close return.
function lastBefore(rows, day) {
  let lo = 0, hi = rows.length - 1, k = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (rows[mid][0] < day) { k = mid; lo = mid + 1; } else hi = mid - 1; }
  return k;
}
const retBefore = (rows, day) => { const k = lastBefore(rows, day); return k >= 1 ? rows[k][1] / rows[k - 1][1] - 1 : null; };
const levelBefore = (rows, day) => { const k = lastBefore(rows, day); return k >= 0 ? rows[k][1] : null; };

// ---- trades ------------------------------------------------------------------
const charges = (side, price, qty, date) => calculateNseFuturesCharges({ side, price, quantity: qty, asOfDate: `${date}T12:00:00Z` }).totalCharges;
function simple(i, k, long) {
  // Enter at open(d = bars[i]), exit at close(bars[i + k]); NET of futures charges, % of entry.
  if (i + k >= bars.length) return null;
  const entry = bars[i].open, exit = bars[i + k].close, qty = Math.ceil(NOTIONAL / entry);
  const cost = (charges(long ? "BUY" : "SELL", entry, qty, bars[i].date) + charges(long ? "SELL" : "BUY", exit, qty, bars[i + k].date)) / (entry * qty);
  return (long ? exit / entry - 1 : 1 - exit / entry) - cost;
}
// The desk's futures geometry, exactly as research/regime-2026-09-29/study.js.
function geometry(i, side) {
  const d = bars[i];
  const long = side === "LONG";
  const entry = long ? toTick(d.open * 0.992, TICK, "down") : toTick(d.open * 1.008, TICK, "up");
  if (long ? !(d.low < entry) : !(d.high > entry)) return null;
  const target = toTick(entry * (long ? 1.025 : 0.975), TICK, "nearest");
  const stop = toTick(entry * (long ? 0.985 : 1.015), TICK, "nearest");
  const through = (p, level) => (long ? p <= level : p >= level);
  const reach = (p, level) => (long ? p >= level : p <= level);
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

// ---- every NSE session d, with its situation (known at d's open) ---------------
const realised20 = (i) => {
  if (i < 21) return null;
  const r = []; for (let k = i - 20; k < i; k += 1) r.push(Math.log(bars[k].close / bars[k - 1].close));
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1)) * Math.sqrt(252);
};
const days = [];
for (let i = 1; i < bars.length; i += 1) {
  const d = bars[i];
  const w = windowOf(d.date);
  if (!w) continue;
  const prior = bars.slice(0, i);
  const regime = classifyMarketRegime(prior).regime;
  const candle = identifyCandlestickPatterns(prior.slice(-7)).bias;
  const sma200 = i >= 200 ? prior.slice(-200).reduce((a, b) => a + b.close, 0) / 200 : null;
  const vixLevel = levelBefore(vix, d.date);
  const vk = lastBefore(vix, d.date);
  const vixChange = vk >= 1 ? vix[vk][1] / vix[vk - 1][1] - 1 : null;
  const nextMonthly = monthly.find((x) => x >= d.date) || null;
  const sessionsToMonthly = nextMonthly ? bars.slice(i).findIndex((b) => b.date === nextMonthly) : -1;
  days.push({
    i, day: d.date, month: d.date.slice(0, 7), window: w,
    gap: d.open / bars[i - 1].close - 1,
    us: retBefore(sp, d.date), crude: retBefore(brent, d.date),
    vixLevel, vixChange, rv20: realised20(i), regime, candle,
    aboveSma200: sma200 === null ? null : bars[i - 1].close > sma200,
    expiryDay: weekly.has(d.date), dayBeforeExpiry: i + 1 < bars.length && weekly.has(bars[i + 1].date),
    monthlyExpiryWeek: sessionsToMonthly >= 0 && sessionsToMonthly <= 4,
    t: { dayLong: simple(i, 0, true), weekLong: null, bLong: geometry(i, "LONG"), bShort: geometry(i, "SHORT") }
  });
}
// B-WEEK: close(d-1) -> close(d+4), long, net (entered at the previous close).
for (const x of days) {
  const i = x.i;
  if (i + 4 >= bars.length) continue;
  const entry = bars[i - 1].close, exit = bars[i + 4].close, qty = Math.ceil(NOTIONAL / entry);
  x.t.weekLong = exit / entry - 1 - (charges("BUY", entry, qty, bars[i - 1].date) + charges("SELL", exit, qty, bars[i + 4].date)) / (entry * qty);
}

// ---- statistics -----------------------------------------------------------------
const stats = (xs) => {
  if (!xs.length) return { n: 0, months: 0, meanPct: null, t: null, winPct: null };
  const r = clusterRobustMean(xs.map((x) => ({ value: x.v * 100, cluster: x.month })));
  return { n: xs.length, months: new Set(xs.map((x) => x.month)).size, meanPct: r.meanPct, t: r.tStat, winPct: Math.round(1000 * xs.filter((x) => x.v > 0).length / xs.length) / 10 };
};
function lgamma(x) {
  const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1; let a = c[0]; const t = x + g + 0.5; for (let i = 1; i < 9; i += 1) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
// One-sided upper-tail p of Student-t with df degrees of freedom (numerical integration).
function pUpper(t, df) {
  if (!Number.isFinite(t) || !(df >= 1)) return null;
  const pdf = (x) => Math.exp(lgamma((df + 1) / 2) - lgamma(df / 2) - 0.5 * Math.log(df * Math.PI) - ((df + 1) / 2) * Math.log(1 + (x * x) / df));
  const hi = t + 200, n = 200000, h = (hi - t) / n;
  let s = 0; for (let k = 0; k <= n; k += 1) s += pdf(t + k * h) * (k === 0 || k === n ? 0.5 : 1);
  return Math.min(1, Math.max(0, s * h));
}

// ---- PART A ------------------------------------------------------------------------
const A = {
  A1: { name: "US overnight (S&P 500 <= -1%: short NIFTY open->close; >= +1%: long)", pick: (x) => (x.us === null ? null : x.us <= -0.01 ? false : x.us >= 0.01 ? true : null), k: 0 },
  A2: { name: "Crude spike (Brent >= +3%: short NIFTY open->close; <= -3%: long)", pick: (x) => (x.crude === null ? null : x.crude >= 0.03 ? false : x.crude <= -0.03 ? true : null), k: 0 },
  A3: { name: "Gap continuation (NIFTY gap <= -1%: short open->close; >= +1%: long)", pick: (x) => (x.gap <= -0.01 ? false : x.gap >= 0.01 ? true : null), k: 0 },
  A4: { name: "India VIX spike (>= +10% the session before: short NIFTY open(d)->close(d+4))", pick: (x) => (x.vixChange !== null && x.vixChange >= 0.10 ? false : null), k: 4 },
  A5: { name: "NIFTY candle (desk's candlestick bias of d-1: BULLISH long, BEARISH short, open(d)->close(d+4))", pick: (x) => (x.candle === "BULLISH" ? true : x.candle === "BEARISH" ? false : null), k: 4 }
};
const out = [];
const line = (s = "") => { out.push(s); console.log(s); };
line(`DIRECTION SIGNALS AND DESK RULES BY SITUATION -- run ${new Date().toISOString()}`);
line(`pre-registration sha256 ${PREREG_SHA} (verified; recorded 2026-09-29T17:27:09Z)`);
line(`NIFTY sessions ${bars[0].date} .. ${bars[bars.length - 1].date} (NSE); days studied ${days.length}; weekly expiries in range ${[...weekly].length}; monthly ${monthly.length}`);
line(`S&P 500 ${sp[0][0]}..${sp[sp.length - 1][0]}; Brent ${brent[0][0]}..${brent[brent.length - 1][0]}; India VIX ${vix[0][0]}..${vix[vix.length - 1][0]} (Yahoo = NSE's EOD closes on all 41 sessions checked, Aug-Sep 2026)`);
line("");
line("PART A -- the direction signals (NET of futures charges; errors clustered by month)");
const verdicts = {};
for (const [id, h] of Object.entries(A)) {
  const res = {};
  for (const w of ["development", "validation", "final"]) {
    const xs = [];
    for (const x of days.filter((y) => y.window === w)) {
      const side = h.pick(x);
      if (side === null) continue;
      const v = simple(x.i, h.k, side);
      if (v !== null) xs.push({ v, month: x.month });
    }
    res[w] = stats(xs);
  }
  const f = res.final;
  const p = f.n >= 20 && f.months >= 2 ? pUpper(f.t, f.months - 1) : null;
  verdicts[id] = { res, p };
  line(`${id} ${h.name}`);
  for (const w of ["development", "validation", "final"]) {
    const r = res[w];
    line(`   ${w.padEnd(12)} ${String(r.n).padStart(4)} trades ${String(r.months).padStart(3)} months  mean ${r.meanPct === null ? "  -  " : (r.meanPct >= 0 ? "+" : "") + r.meanPct.toFixed(3) + "%"}  t ${r.t === null ? "-" : r.t.toFixed(2)}  winners ${r.winPct ?? "-"}%`);
  }
  const testable = f.n >= 20;
  const bonf = 0.05 / 6;
  const pass = testable && res.validation.meanPct > 0 && f.meanPct > 0 && p !== null && p <= bonf;
  verdicts[id].verdict = !testable ? "NOT TESTABLE (under 20 final trades)" : pass ? "PASS (Bonferroni; on re-used data)" : "FAIL";
  line(`   final one-sided p ${p === null ? "-" : p.toFixed(4)} vs 0.05/6 = ${bonf.toFixed(4)} -> ${verdicts[id].verdict}`);
  line("");
}
line("P1 (stock candles) waits for the complete NSE panel (NSE refused the history requests on 29 Sep");
line("after 18; the fetch stopped itself). Its p joins Holm when run; until then each A above is judged");
line("against 0.05/6, the strictest step, which Holm can only relax.");
line("");

// ---- PART B ---------------------------------------------------------------------------
const tercile = (key) => {
  const v = days.filter((x) => x.window === "development" && x[key] !== null).map((x) => x[key]).sort((a, b) => a - b);
  return [v[Math.floor(v.length / 3)], v[Math.floor((2 * v.length) / 3)]];
};
const [vixLo, vixHi] = tercile("vixLevel"), [rvLo, rvHi] = tercile("rv20");
const pct = (x) => `${(100 * x).toFixed(1)}%`;
const SITUATIONS = [
  ["gap <= -1%", (x) => x.gap <= -0.01], ["gap -1%..-0.3%", (x) => x.gap > -0.01 && x.gap <= -0.003], ["gap -0.3..+0.3%", (x) => x.gap > -0.003 && x.gap < 0.003],
  ["gap +0.3..+1%", (x) => x.gap >= 0.003 && x.gap < 0.01], ["gap >= +1%", (x) => x.gap >= 0.01],
  ["weekly expiry day", (x) => x.expiryDay], ["session before an expiry", (x) => x.dayBeforeExpiry], ["monthly expiry week", (x) => x.monthlyExpiryWeek],
  [`India VIX low (< ${vixLo.toFixed(2)})`, (x) => x.vixLevel !== null && x.vixLevel < vixLo], [`India VIX mid`, (x) => x.vixLevel !== null && x.vixLevel >= vixLo && x.vixLevel < vixHi],
  [`India VIX high (>= ${vixHi.toFixed(2)})`, (x) => x.vixLevel !== null && x.vixLevel >= vixHi],
  [`NIFTY calm (20d vol < ${pct(rvLo)})`, (x) => x.rv20 !== null && x.rv20 < rvLo], ["NIFTY normal vol", (x) => x.rv20 !== null && x.rv20 >= rvLo && x.rv20 < rvHi],
  [`NIFTY volatile (20d vol >= ${pct(rvHi)})`, (x) => x.rv20 !== null && x.rv20 >= rvHi],
  ["regime BULL", (x) => x.regime === "BULL_TRENDING"], ["regime NEUTRAL", (x) => x.regime === "NEUTRAL_CHOPPY"], ["regime BEAR", (x) => x.regime === "BEAR_HOSTILE"],
  ["above 200-day average", (x) => x.aboveSma200 === true], ["below 200-day average", (x) => x.aboveSma200 === false],
  ["US fell >= 1% overnight", (x) => x.us !== null && x.us <= -0.01], ["US within +-1%", (x) => x.us !== null && x.us > -0.01 && x.us < 0.01], ["US rose >= 1% overnight", (x) => x.us !== null && x.us >= 0.01],
  ["crude fell >= 3%", (x) => x.crude !== null && x.crude <= -0.03], ["crude within +-3%", (x) => x.crude !== null && x.crude > -0.03 && x.crude < 0.03], ["crude rose >= 3%", (x) => x.crude !== null && x.crude >= 0.03],
  ["every day", () => true]
];
const RULES = [["B-LONG desk futures buy", "bLong"], ["B-SHORT its mirror (put stand-in)", "bShort"], ["B-DAY NIFTY open->close", "dayLong"], ["B-WEEK NIFTY 5 sessions", "weekLong"]];
line("PART B -- DESCRIPTIVE ONLY: every rule, by the situation of the day it starts (whole period, 2021-09 .. 2026-09-15)");
line(`terciles fixed on the development window: India VIX ${vixLo.toFixed(2)} / ${vixHi.toFixed(2)}; NIFTY 20-day volatility ${pct(rvLo)} / ${pct(rvHi)}`);
const table = [];
for (const [label, key] of RULES) {
  line("");
  line(`${label}:`);
  line(`   ${"situation".padEnd(34)} ${"trades".padStart(6)} ${"mean".padStart(8)} ${"t".padStart(6)} ${"winners".padStart(8)}   dev / valid / final mean`);
  for (const [sit, cond] of SITUATIONS) {
    const all = days.filter((x) => cond(x) && x.t[key] !== null && x.t[key] !== undefined);
    const s = stats(all.map((x) => ({ v: x.t[key], month: x.month })));
    const byW = ["development", "validation", "final"].map((w) => stats(all.filter((x) => x.window === w).map((x) => ({ v: x.t[key], month: x.month }))));
    const fmt = (m) => (m === null ? "   -  " : `${m >= 0 ? "+" : ""}${m.toFixed(2)}%`);
    line(`   ${sit.padEnd(34)} ${String(s.n).padStart(6)} ${fmt(s.meanPct).padStart(8)} ${s.t === null ? "     -" : s.t.toFixed(2).padStart(6)} ${(s.winPct === null ? "-" : s.winPct + "%").padStart(8)}   ${byW.map((b) => fmt(b.meanPct)).join(" / ")}${s.n < 30 ? "   (too few)" : ""}`);
    table.push({ rule: label, situation: sit, n: s.n, meanPct: s.meanPct, t: s.t, winPct: s.winPct, byWindow: byW.map((b) => ({ n: b.n, meanPct: b.meanPct })) });
  }
}
line("");
line("Part B decides nothing: 26 situations x 4 rules is ~100 cells, and about 5 of them will look");
line("significant at t > 2 by chance alone. A cell only becomes a rule by a test fixed before it is run.");

fs.writeFileSync(path.join(HERE, "RESULT.txt"), out.join("\n") + "\n");
fs.writeFileSync(path.join(HERE, "result.json"), JSON.stringify({ prereg: PREREG_SHA, runAt: new Date().toISOString(), partA: verdicts, partB: table, terciles: { vix: [vixLo, vixHi], rv20: [rvLo, rvHi] } }, null, 1));
