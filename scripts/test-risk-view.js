"use strict";

/**
 * THE BAD-DAY RISK VIEW (api/_lib/risk-view.js), ON PRICES WHOSE ANSWER IS KNOWN.
 *
 * Every rule the page's risk figures rest on, one at a time: how a day's range
 * exits a row (a gap through the stop exits at the open, the stop before the
 * target), which days are not price moves at all (a demerger ex-date, a bonus
 * the provider adjusted on the wrong day), that a day still trading is not
 * history yet, that a missing bar never makes a two-day move, the quantile, the
 * average of the bad days, that the stocks' shares of it add up to it, the
 * 5% gap, and the call's reprice against an independent Black-76.
 */

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const R = require("../api/_lib/risk-view");
const H = require("../api/_lib/risk-history");
const CA = require("../api/_lib/nse-corporate-actions");

let passed = 0;
let failed = 0;
function check(label, condition, detail = "") {
  if (condition) { passed += 1; console.log("  ok    " + label); }
  else { failed += 1; console.log("  FAIL  " + label + (detail ? "  (" + detail + ")" : "")); }
}
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

// mulberry32: small, seeded, the same numbers on every machine.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Weekdays ending on `last`, oldest first.
function weekdays(count, last = "2026-09-25") {
  const out = [];
  let t = Date.parse(`${last}T00:00:00Z`);
  while (out.length < count) {
    const d = new Date(t);
    if (![0, 6].includes(d.getUTCDay())) out.unshift(d.toISOString().slice(0, 10));
    t -= 86_400_000;
  }
  return out;
}
// A price path from close-to-close moves; the open is half the move, the range brackets both.
function pathFrom(dates, moves, start = 100) {
  const rows = [[dates[0], start, start, start, start]];
  for (let i = 1; i < dates.length; i += 1) {
    const p = rows[i - 1][4], m = moves[i - 1];
    const o = p * (1 + m / 2), c = p * (1 + m);
    rows.push([dates[i], o, Math.max(o, c) * 1.002, Math.min(o, c) * 0.998, c]);
  }
  return rows;
}

console.log("how a day's range exits a row");
{
  const p = { entry: 100, stop: 98.5, target: 102.5 };
  const e = (po, pl, ph, pc) => R.exitPrice(p, po, pl, ph, pc);
  check("opening through the stop exits at the open, below the stop", e(97, 96, 99, 98).price === 97 && e(97, 96, 99, 98).how === "GAP_STOP");
  check("opening through the target exits at the open, above the target", e(103, 102.8, 104, 103.5).price === 103 && e(103, 102.8, 104, 103.5).how === "GAP_TARGET");
  check("a day that touches both exits at the stop -- the stop first", e(100, 98, 103, 101).price === 98.5 && e(100, 98, 103, 101).how === "STOP");
  check("a day that touches only the target exits at the target", e(100, 99, 103, 101).price === 102.5);
  check("a day that touches neither is marked at its close", e(100, 99, 101, 100.4).price === 100.4 && e(100, 99, 101, 100.4).how === "CLOSE");
  const noStop = R.exitPrice({ entry: 100, stop: null, target: null }, 90, 85, 95, 91);
  check("a row with no stop and no target rides to the close", noStop.price === 91);
}

console.log("\na session still trading is not history yet");
{
  const rows = [["2026-09-25", 1, 1, 1, 1], ["2026-09-28", 2, 2, 2, 2]];
  const at = (hhmm) => Date.parse(`2026-09-28T${hhmm}:00+05:30`);
  check("at 11:00 on the 28th, the 28th's bar is left out", H.completedRows(rows, at("11:00")).length === 1);
  check("at 15:45 it is still left out (the close settles after 15:30)", H.completedRows(rows, at("15:45")).length === 1);
  check("from 16:00 it counts", H.completedRows(rows, at("16:05")).length === 2);
  const c = H.compact([{ timestamp: 1790307900, open: 1, high: 2, low: 0.5, close: 1.5 }, { timestamp: 1790307901, open: 1, high: 2, low: 0.5, close: 1.6 }]);
  check("the provider's duplicate bar for one date is kept once (the later)", c.length === 1 && c[0][4] === 1.6 && c[0][0] === "2026-09-25", JSON.stringify(c));
}

console.log("\ncorporate actions: the ratio in the filing");
{
  check("Bonus 1:4 -> 4 held become 5 -> 0.8", near(CA.priceRatio("Bonus 1:4"), 0.8));
  check("Bonus 1:2 -> 2/3", near(CA.priceRatio("Bonus 1:2"), 2 / 3));
  check("Bonus 2:1 -> 1/3", near(CA.priceRatio("Bonus 2:1"), 1 / 3));
  check("split Rs 10 to Rs 2 -> 0.2", near(CA.priceRatio("Face Value Split (Sub-Division) - From Rs 10/- Per Share To Rs 2/- Per Share"), 0.2));
  check("split Rs 5 to Re 1 -> 0.2", near(CA.priceRatio("Face Value Split (Sub-Division) - From Rs 5/- Per Share To Re 1/- Per Share"), 0.2));
  check("consolidation Re 1 to Rs 10 -> 10", near(CA.priceRatio("Consolidation Of Equity Shares From Re 1 Per Share To Rs 10 Per Share"), 10));
  check("a demerger has no ratio in its filing", CA.priceRatio("Demerger") === null);
  check("a bonus of preference shares is not an equity ratio", CA.priceRatio("Scheme Of Arrangement - Bonus Ncrps 4:1") === null);
  check("NSE's date format", CA.isoDate("06-Dec-2024") === "2024-12-06" && CA.isoDate("junk") === null);
}

console.log("\ndays that are not price moves");
{
  const dates = weekdays(40, "2026-01-30");
  const moves = dates.slice(1).map(() => 0.001);
  const rows = pathFrom(dates, moves, 1000);
  // A demerger on day 10: the provider shows a 60% "fall".
  const dm = rows.findIndex((r) => r[0] === dates[10]);
  for (let i = dm; i < rows.length; i += 1) rows[i] = [rows[i][0], ...rows[i].slice(1).map((v) => v * 0.4)];
  // A 1:4 bonus the provider adjusted on the wrong day: prices before day 20 are
  // un-adjusted, so day 20 opens at exactly 4/5 of the close before.
  const wrong = rows.findIndex((r) => r[0] === dates[20]);
  for (let i = 0; i < wrong; i += 1) rows[i] = [rows[i][0], ...rows[i].slice(1).map((v) => v * 1.25)];
  // A real crash on day 30: opens 10% down, closes 27% down. No filing.
  const crash = rows.findIndex((r) => r[0] === dates[30]);
  const p = rows[crash - 1][4];
  rows[crash] = [dates[30], p * 0.9, p * 0.9, p * 0.72, p * 0.73];
  // ...and stays down.
  for (let i = crash + 1; i < rows.length; i += 1) rows[i] = [rows[i][0], ...rows[i].slice(1).map((v) => v * 0.73)];
  const actions = [{ exDate: dates[10], ratio: null, subject: "Demerger" }, { exDate: dates[35], ratio: 0.8, subject: "Bonus 1:4" }];
  const bad = R.contaminatedDays(rows, actions);
  check("the demerger ex-date is left out", bad.has(dates[10]));
  check("the bonus adjusted on the wrong day is left out (its gap is exactly the bonus ratio)", bad.has(dates[20]), [...bad].join(","));
  check("the bonus's own ex-date is left out too", bad.has(dates[35]));
  check("the real crash stays in (-27%, no filing, a gap of 10% that is no ratio)", !bad.has(dates[30]));
  check("and nothing else is touched", bad.size === 3, [...bad].join(","));
  const weekend = R.contaminatedDays(rows, [{ exDate: "2026-01-10", ratio: null }]);
  check("an ex-date that is not a session marks the next session", weekend.has("2026-01-12") && weekend.size === 1, [...weekend].join(","));
}

console.log("\na missing bar never makes a two-day move");
{
  const dates = weekdays(30);
  const a = pathFrom(dates, dates.slice(1).map(() => 0.01));
  const b = pathFrom(dates, dates.slice(1).map(() => 0.01)).filter((r) => r[0] !== dates[15]);
  const c = pathFrom(dates, dates.slice(1).map(() => 0.01));
  const hist = { A: { rows: a }, B: { rows: b }, C: { rows: c }, [H.MARKET]: { rows: c } };
  const idx = R.historyIndex({ symbols: ["A", "B", "C"], historyFor: (s) => hist[s], actionsFor: () => [], now: Date.parse("2026-09-28T12:00:00+05:30") });
  check("B has no move on the day it has no bar", !idx.moves.get("B").has(dates[15]));
  check("nor on the next day -- that would be two days of movement", !idx.moves.get("B").has(dates[16]));
  check("A has both", idx.moves.get("A").has(dates[15]) && idx.moves.get("A").has(dates[16]));
  check("a move is measured from the close before: +1% a day", near(idx.moves.get("A").get(dates[16])[3], 0.01, 1e-9));
  const lone = { A: { rows: a }, B: { rows: [...b, ["2026-09-26", 1, 1, 1, 1]] }, C: { rows: c }, [H.MARKET]: { rows: c } };
  const idx2 = R.historyIndex({ symbols: ["A", "B", "C"], historyFor: (s) => lone[s], actionsFor: () => [], now: Date.parse("2026-09-28T12:00:00+05:30") });
  check("a date only one series has (a stray Saturday bar) is not on the calendar", !idx2.calendar.includes("2026-09-26"));
}

// A book with a known answer: 300 days, stocks A and B.
const DATES = weekdays(301);
const r1 = rng(7), r2 = rng(11), rm = rng(3);
const mkt = DATES.slice(1).map(() => (rm() - 0.5) * 0.03);
const movesA = mkt.map((m) => m + (r1() - 0.5) * 0.01);
const movesB = mkt.map((m) => 0.5 * m + (r2() - 0.5) * 0.02);
const HIST = {
  A: { rows: pathFrom(DATES, movesA, 200) },
  B: { rows: pathFrom(DATES, movesB, 50) },
  SHORT: { rows: pathFrom(DATES.slice(-100), movesA.slice(-99), 80) },
  [H.MARKET]: { rows: pathFrom(DATES, mkt, 20000) }
};
const NOW = Date.parse("2026-09-28T12:00:00+05:30");
const index = R.historyIndex({ symbols: ["A", "B", "SHORT"], historyFor: (s) => HIST[s], actionsFor: () => [], now: NOW });

console.log("\nthe quantile, the average of the bad days, and whose they are");
{
  // No stop, no target: the P&L of a day is exactly qty x entry x (close move).
  const pos = [
    { symbol: "A", qty: 10, entry: 200, stop: null, target: null, priceAt: (m) => 200 * m },
    { symbol: "B", qty: 40, entry: 50, stop: null, target: null, priceAt: (m) => 50 * m },
    { symbol: "SHORT", qty: 5, entry: 80, stop: null, target: null, priceAt: (m) => 80 * m }
  ];
  const out = R.simulate(pos, index);
  const days = DATES.slice(1).map((d, i) => 10 * 200 * movesA[i] + 40 * 50 * movesB[i]).sort((a, b) => a - b);
  const k = Math.ceil(0.05 * days.length);
  check("300 days replayed", out.days === 300, out.days);
  check("1 day in 20 of 300 is the 15th worst day", out.tailDays === 15 && k === 15);
  check("the 1-in-20 loss is the 15th worst day's", out.var === Math.round(-days[k - 1]), `${out.var} vs ${Math.round(-days[k - 1])}`);
  check("the average of the bad days is the mean of the 15 worst", out.es === Math.round(-days.slice(0, k).reduce((a, b) => a + b, 0) / k), `${out.es}`);
  check("the worst day is the worst", out.worst.rupees === Math.round(days[0]));
  check("the stocks' shares of the bad days add up to the whole", Math.abs(out.contributionsSum - out.es) <= 1, `${out.contributionsSum} vs ${out.es}`);
  check("a stock with under a year of history is left out, and named", out.excluded.length === 1 && out.excluded[0].symbol === "SHORT" && out.excluded[0].sessions === 99, JSON.stringify(out.excluded));
  check("the NIFTY move on the worst day is carried", out.worst.marketPct !== null);
}

console.log("\nstops and gaps on the bad days");
{
  const pos = [{ symbol: "A", qty: 20, entry: 200, stop: 197, target: 205, priceAt: (m) => 200 * m }];
  const out = R.simulate(pos, index);
  const minMove = Math.min(...movesA);
  check("with a stop, no ordinary day loses more than the stop -- unless it opens through it",
    out.worst.rupees >= Math.round(20 * 200 * Math.min(minMove / 2, -0.015)) - 1, `${out.worst.rupees}`);
  check("the stop total is the rows' distance to their stops", out.stopTotal === 60);
}

console.log("\nthe market opening 5% lower");
{
  // A stock that IS the market has a sensitivity of exactly 1.
  const hist = { M1: { rows: HIST[H.MARKET].rows }, [H.MARKET]: HIST[H.MARKET] };
  const idx = R.historyIndex({ symbols: ["M1"], historyFor: (s) => hist[s], actionsFor: () => [], now: NOW });
  const out = R.simulate([{ symbol: "M1", qty: 20, entry: 100, stop: 98.5, target: 102.5, priceAt: (m) => 100 * m }], idx);
  check("sensitivity 1 to NIFTY", out.gap && near(out.gap.medianBeta, 1, 0.01), JSON.stringify(out.gap));
  check("a 5% gap through a 1.5% stop loses the whole 5%: 20 x 100 x -5% = -100", out.gap && out.gap.rupees === -100, JSON.stringify(out.gap));
  const idxNoMkt = R.historyIndex({ symbols: ["M1"], historyFor: (s) => (s === H.MARKET ? null : hist[s]), actionsFor: () => [], now: NOW });
  const noGap = R.simulate([{ symbol: "M1", qty: 20, entry: 100, stop: 98.5, target: 102.5, priceAt: (m) => 100 * m }], idxNoMkt);
  check("without NIFTY's history there is no gap figure -- not a zero", noGap.available && noGap.gap === null);
}

console.log("\na call, repriced");
{
  // Black-76, written out independently of option-pricing.js, with a
  // high-precision normal CDF (Abramowitz-Stegun 7.1.26 is not enough for this check).
  const erf = (x) => {
    // W. J. Cody's rational approximation via the complementary error function series.
    const t = 1 / (1 + 0.5 * Math.abs(x));
    const y = 1 - t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806
      + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
    return x >= 0 ? y : -y;
  };
  const N = (x) => 0.5 * (1 + erf(x / Math.SQRT2));
  const b76 = (F, K, T, s, r = 0.065) => {
    const d1 = (Math.log(F / K) + 0.5 * s * s * T) / (s * Math.sqrt(T)), d2 = d1 - s * Math.sqrt(T);
    return Math.exp(-r * T) * (F * N(d1) - K * N(d2));
  };
  const c = { symbol: "A", buy: 35.7, stop: 17.85, sell: 53.55, forward: 1167.7, strike: 1160, daysLeft: 29.8, iv: 24.1, lotSize: 625 };
  const p = R.callPosition(c);
  const T0 = 29.8 / 365, T1 = 28.8 / 365, s = 0.241;
  const scale = 35.7 / b76(1167.7, 1160, T0, s);
  for (const m of [0.95, 1, 1.03]) {
    const want = scale * b76(1167.7 * m, 1160, T1, s);
    check(`at ${((m - 1) * 100).toFixed(0)}% the call is worth ${want.toFixed(2)} (independent Black-76)`, near(p.priceAt(m), want, 0.02), p.priceAt(m).toFixed(4));
  }
  check("a day later with the stock unchanged, the call is worth a little less (one day of decay)", p.priceAt(1) < 35.7 && p.priceAt(1) > 34.5, p.priceAt(1).toFixed(3));
  check("and more when the stock is higher", p.priceAt(1.02) > p.priceAt(1) && p.priceAt(0.98) < p.priceAt(1));
  const deep = R.callPosition({ ...c, strike: 3000, buy: 0.05, daysLeft: 2 });
  check("a call the model values at nothing is not scaled up into rupees (left out)", deep === null);
  check("a call with no implied volatility is left out, not priced at zero", R.callPosition({ ...c, iv: null }) === null);
}

console.log("\nIndia VIX's move on the worst day");
{
  const c = { symbol: "A", buy: 6, stop: 3, sell: 9, forward: 200, strike: 200, daysLeft: 30, iv: 25, lotSize: 100 };
  const first = R.simulate([R.callPosition(c)], index);
  // India VIX flat at 15, except +50% on the calls' worst day (and level after).
  const vixRows = DATES.map((d) => [d, 15, 15, 15, 15]);
  const at = vixRows.findIndex((r) => r[0] === first.worst.date);
  for (let i = at; i < vixRows.length; i += 1) vixRows[i] = [vixRows[i][0], 22.5, 22.5, 22.5, 22.5];
  const hist = { ...HIST, [H.VIX]: { rows: vixRows } };
  const idx = R.historyIndex({ symbols: ["A", "B", "SHORT"], historyFor: (s) => hist[s], actionsFor: () => [], now: NOW });
  const out = R.simulate([R.callPosition(c)], idx);
  check("India VIX does not change the figures -- volatility is held where it is",
    out.worst.date === first.worst.date && out.worst.rupees === first.worst.rupees && out.var === first.var);
  check("India VIX's move that day is carried: +50%", out.worst.vixPct === 50, String(out.worst.vixPct));
  check("the call at the same price with volatility 50% higher is worth more -- the cushion the page describes",
    R.callPosition(c).priceAt(0.95, 1.5) > R.callPosition(c).priceAt(0.95, 1));
  check("without India VIX's history the move is unknown, not zero", first.worst.vixPct === null);
}

console.log("\nthe page's inputs, failing honestly");
{
  const futures = [{ symbol: "A", buy: 200, stop: 197, target1: 205 }];
  const none = R.riskView({ futures, historyFor: (s) => HIST[s], actions: null, now: NOW });
  check("without NSE's corporate actions there is no figure, and the reason says why", none.available === false && /corporate-action/.test(none.reason));
  const empty = R.riskView({ futures, historyFor: () => null, actions: { ok: true, rows: [] }, now: NOW });
  check("without price history there is no figure", empty.available === false && /no price history/.test(empty.reason));
  const ok = R.riskView({ futures, calls: [], historyFor: (s) => HIST[s], actions: { ok: true, fetchedAt: "2026-09-27T10:00:00Z", rows: [] }, now: NOW });
  check("with both, the futures side is worked out at 20 units", ok.available && ok.futures.available && ok.units === 20 && ok.calls === null, JSON.stringify(ok).slice(0, 200));
  const broken = R.riskView({ futures, historyFor: () => { throw new Error("disk gone"); }, actions: { ok: true, rows: [] }, now: NOW });
  check("a failure inside is a reason, never a thrown build", broken.available === false && /disk gone/.test(broken.reason));
}

console.log("\nthe history cache round-trips, and the fetch keeps its budget");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "k2-risk-"));
  H.saveHistory("M&M", [["2026-09-25", 1, 2, 0.5, 1.5]], { dir, now: Date.parse("2026-09-25T12:00:00Z") });
  const back = H.readHistory("M&M", { dir });
  check("a symbol with & is stored and read back", back && back.rows.length === 1 && back.range === "2y");
  (async () => {
    let calls = 0;
    const fetcher = async (symbol) => {
      calls += 1;
      if (symbol === "BAD") throw new Error("Symbol not found");
      const ts = Math.floor(Date.parse("2026-09-24T09:15:00+05:30") / 1000);
      return { timestamp: Array.from({ length: 30 }, (_, i) => ts - (29 - i) * 86400),
        indicators: { quote: [{ open: Array(30).fill(10), high: Array(30).fill(11), low: Array(30).fill(9), close: Array(30).fill(10) }] } };
    };
    const now = Date.parse("2026-09-25T18:00:00+05:30");
    const r = await H.refreshRiskHistory(["GOOD", "BAD"], { dir, now, fetcher, delayMs: 0 });
    check("fetches NIFTY, India VIX and every name, and records the failure", r.wanted === 4 && r.fetched === 3 && r.failed === 1 && /BAD/.test(r.failures[0]), JSON.stringify(r));
    const again = await H.refreshRiskHistory(["GOOD", "BAD"], { dir, now, fetcher, delayMs: 0 });
    check("a copy taken after the latest close is not fetched again", again.due === 1 && again.fetched === 0, JSON.stringify(again));
    console.log("\n" + passed + " passed, " + failed + " failed");
    process.exit(failed ? 1 : 0);
  })();
}
