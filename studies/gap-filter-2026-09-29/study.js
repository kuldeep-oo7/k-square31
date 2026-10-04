"use strict";
// Implements EXACTLY research/gap-filter-2026-09-29/PREREGISTRATION.txt
// (sha256 05b439241e0613c62b77a4681ebe593f99ea027c7174a750989cf34d6f41324c,
// recorded 2026-09-29T02:13:15Z, before any result was computed).

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const ROOT = path.resolve(__dirname, "..", "..");
const { contaminatedDays } = require(path.join(ROOT, "api/_lib/risk-view"));
const { toTick } = require(path.join(ROOT, "api/_lib/session-levels"));
const { calculateNseFuturesCharges } = require(path.join(ROOT, "api/_lib/shadow-broker"));
const { clusterRobustMean } = require(path.join(ROOT, "api/_lib/panel"));

const HERE = __dirname;
const PREREG_SHA = "05b439241e0613c62b77a4681ebe593f99ea027c7174a750989cf34d6f41324c";
const sha = crypto.createHash("sha256").update(fs.readFileSync(path.join(HERE, "PREREGISTRATION.txt"))).digest("hex");
if (sha !== PREREG_SHA) { console.error(`PRE-REGISTRATION CHANGED (${sha}); result void.`); process.exit(2); }

const DEV_END = "2024-09-19", FINAL_FROM = "2025-09-18", FINAL_TO = "2026-09-15";
const GAP_DOWN = -0.005, HOLD = 20, ENTRY = 0.992, TARGET = 1.025, STOP = 0.985, TICK = 0.05, NOTIONAL = 500000;

// ---- data ----
const nifty = JSON.parse(fs.readFileSync(path.join(HERE, "nifty-50-nse.json"), "utf8")).rows;
const calendar = nifty.map((r) => r.date);
const inCalendar = new Set(calendar);
const niftyGap = new Map();
for (let i = 1; i < nifty.length; i += 1) niftyGap.set(nifty[i].date, nifty[i].open / nifty[i - 1].close - 1);
const actions = JSON.parse(fs.readFileSync(path.join(HERE, "corporate-actions-nse.json"), "utf8")).rows;
const dividends = JSON.parse(fs.readFileSync(path.join(HERE, "dividends-nse.json"), "utf8")).rows;

const windowOf = (d) => (d < DEV_END ? "development" : d < FINAL_FROM ? "validation" : d <= FINAL_TO ? "final" : null);
const isoWeek = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d - firstThu) / 86_400_000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
};
const charges = (side, price, qty, date) => calculateNseFuturesCharges({ side, price, quantity: qty, asOfDate: `${date}T12:00:00Z` }).totalCharges;

// ---- the trades ----
const trades = [];
let removedDays = 0, droppedTrades = 0;
// A stock NSE could not give complete ("SYMBOL.incomplete.json") is left out, decided before any result.
for (const file of fs.readdirSync(path.join(HERE, "nse-panel")).filter((f) => f.endsWith(".json") && !f.endsWith(".incomplete.json"))) {
  const sym = file.replace(/\.json$/, "");
  const raw = JSON.parse(fs.readFileSync(path.join(HERE, "nse-panel", file), "utf8"))
    .filter((r) => inCalendar.has(r[0]) && [r[1], r[2], r[3], r[4]].every((v) => Number(v) > 0))
    .map((r) => [r[0], Number(r[1]), Number(r[2]), Number(r[3]), Number(r[4]), Number(r[5])]);
  // (a) corporate actions, (b) dividends >= 1% of the previous close, (c) no range.
  const bad = contaminatedDays(raw, actions.filter((a) => a.symbol === sym));
  for (const dv of dividends.filter((x) => x.symbol === sym)) {
    const i = raw.findIndex((r) => r[0] >= dv.exDate);
    // An amount NSE did not file (VEDL 2022-03-09) is removed as a precaution.
    if (i >= 0 && (dv.perShare === null || (raw[i][5] > 0 && dv.perShare / raw[i][5] >= 0.01))) bad.add(raw[i][0]);
  }
  for (const r of raw) if (r[1] === r[2] && r[2] === r[3] && r[3] === r[4]) bad.add(r[0]);
  removedDays += bad.size;

  for (let i = 0; i < raw.length; i += 1) {
    const [d, open, , low] = raw[i];
    if (!windowOf(d) || !niftyGap.has(d)) continue;
    const buy = toTick(open * ENTRY, TICK, "down");
    if (!(low < buy)) continue;                           // unfilled day order
    const target = toTick(buy * TARGET, TICK, "nearest");
    const stop = toTick(buy * STOP, TICK, "nearest");
    let exit = null, exitDay = null, touched = false;
    for (let k = 0; k < HOLD && i + k < raw.length; k += 1) {
      const [day, o, h, l, c] = raw[i + k];
      if (bad.has(day)) { touched = true; break; }
      if (k === 0) {                                       // the fill day
        if (l <= stop) { exit = stop; exitDay = day; break; }
        continue;                                          // a target on the fill bar does not count
      }
      if (o <= stop || o >= target) { exit = o; exitDay = day; break; }
      if (l <= stop) { exit = stop; exitDay = day; break; }
      if (h >= target) { exit = target; exitDay = day; break; }
      if (k === HOLD - 1) { exit = c; exitDay = day; }
    }
    if (touched) { droppedTrades += 1; continue; }
    if (exit === null) { const last = raw[raw.length - 1]; exit = last[4]; exitDay = last[0]; }   // data ended
    const qty = Math.ceil(NOTIONAL / buy);
    const cost = (charges("BUY", buy, qty, d) + charges("SELL", exit, qty, exitDay)) / (buy * qty);
    trades.push({ sym, day: d, net: exit / buy - 1 - cost, gross: exit / buy - 1 });
  }
}

// ---- entry-day returns ----
const byDay = new Map();
for (const t of trades) { if (!byDay.has(t.day)) byDay.set(t.day, []); byDay.get(t.day).push(t.net); }
const days = [...byDay.entries()].map(([day, xs]) => ({ day, ret: xs.reduce((a, b) => a + b, 0) / xs.length, n: xs.length,
  gapDown: niftyGap.get(day) <= GAP_DOWN, window: windowOf(day), week: isoWeek(day) }));

// One-sided 5% Student-t critical value, numerically (as in the earlier studies).
function tCritical(df, alpha = 0.05) {
  const lgamma = (x) => { const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x); x -= 1; let a = c[0]; const t = x + g + 0.5; for (let i = 1; i < 9; i += 1) a += c[i] / (x + i); return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a); };
  const pdf = (t) => Math.exp(lgamma((df + 1) / 2) - lgamma(df / 2) - 0.5 * Math.log(df * Math.PI) - ((df + 1) / 2) * Math.log(1 + (t * t) / df));
  const upper = (t) => { let s = 0; const n = 20000, hi = t + 60; const h = (hi - t) / n; for (let i = 0; i <= n; i += 1) s += pdf(t + i * h) * (i === 0 || i === n ? 0.5 : 1); return s * h; };
  let lo = 0, hi = 10; for (let it = 0; it < 60; it += 1) { const mid = (lo + hi) / 2; if (upper(mid) > alpha) lo = mid; else hi = mid; } return (lo + hi) / 2;
}
const stats = (rows) => {
  const r = clusterRobustMean(rows.map((x) => ({ value: x.ret * 100, cluster: x.week })));
  return { days: rows.length, weeks: new Set(rows.map((x) => x.week)).size, trades: rows.reduce((a, x) => a + x.n, 0), meanPct: r.meanPct, t: r.tStat };
};
const out = [];
const line = (s) => { out.push(s); console.log(s); };
line(`GAP-DOWN FILTER ON THE DESK'S FUTURES RULES -- run ${new Date().toISOString()}, prereg sha256 ${PREREG_SHA} (verified)`);
line(`trades: ${trades.length} filled (${droppedTrades} dropped: a removed day in their window); removed stock-days: ${removedDays}`);
line(`entry days: ${days.length}; gap-down mornings (NIFTY open <= -0.50%): ${days.filter((x) => x.gapDown).length}`);
const results = {};
for (const w of ["development", "validation", "final"]) {
  const inW = days.filter((x) => x.window === w);
  const H1 = stats(inW.filter((x) => !x.gapDown)), S1 = stats(inW), S2 = stats(inW.filter((x) => x.gapDown));
  results[w] = { H1, S1, S2 };
  line(`\n${w.toUpperCase()}`);
  line(`  H1 filtered     mean ${H1.meanPct}%/day  t ${H1.t}  (${H1.days} days, ${H1.weeks} weeks, ${H1.trades} trades)`);
  line(`  S1 unfiltered   mean ${S1.meanPct}%/day  t ${S1.t}  (${S1.days} days)`);
  line(`  S2 gap-down     mean ${S2.meanPct}%/day  t ${S2.t}  (${S2.days} days)`);
  line(`  S3 H1 - S1      ${(H1.meanPct - S1.meanPct).toFixed(4)} pct points/day`);
}
const crit = tCritical(results.final.H1.weeks - 1);
const pass = results.validation.H1.meanPct > 0 && results.final.H1.meanPct > 0 && results.final.H1.t >= crit;
line(`\nDECISION (H1): validation mean ${results.validation.H1.meanPct} > 0? final mean ${results.final.H1.meanPct} > 0? final t ${results.final.H1.t} >= ${crit.toFixed(3)} (one-sided 5%, df ${results.final.H1.weeks - 1})?`);
line(`VERDICT: ${pass ? "PASS -- paper tracking only, per the pre-registration" : "FAIL"}`);
fs.writeFileSync(path.join(HERE, "RESULT.txt"), out.join("\n") + "\n");
