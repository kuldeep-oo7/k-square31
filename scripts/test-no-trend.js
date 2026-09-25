"use strict";

/**
 * WITH NO TREND, THE DESK'S FUTURES HAVE NO EDGE -- CHECKED THROUGH THE LEDGER.
 *
 * The page now says that a futures row's target comes before its stop at most
 * as often as its break-even (37.5% for +2.5% / -1.5%), because a price with
 * no trend is a fair game and a fair game stopped at two levels has an
 * expected result of zero. That is arithmetic; this test is the measurement.
 * Seeded random-walk prices with no trend run through the ledger's own rules
 * -- observe() and settle() in scripts/paper-ledger.js: a fill only on a trade
 * through the buy, a target only through it, a stop on a touch, a gap exiting
 * at the open, the 20-session hold -- and the result must not beat the
 * ceiling. A second run with a strong upward trend must beat it, or the test
 * could not tell an edge if it saw one.
 */

const L = require("./paper-ledger");
const { ENTRY_DISCOUNT, TARGET_1, STOP } = require("../api/_lib/session-levels");

let passed = 0;
let failed = 0;
function check(label, condition, detail = "") {
  if (condition) { passed += 1; console.log("  ok    " + label); }
  else { failed += 1; console.log("  FAIL  " + label + (detail ? "  (" + detail + ")" : "")); }
}

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
function normal(u) {
  const a = Math.max(u(), 1e-12), b = u();
  return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * b);
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const stamp = (iso, hhmm) => `${iso.slice(8, 10)}-${MON[Number(iso.slice(5, 7)) - 1]}-${iso.slice(0, 4)} ${hhmm}:00`;
const istMs = (iso, hhmm) => Date.parse(`${iso}T${hhmm}:00+05:30`);

const MARKS = 18;          // builds a session, about every 20 minutes
const SUB = 5;             // price steps between two builds (the day's high and low see them all)
const SIGMA = 0.25;        // a year
const STEPS_PER_YEAR = 250 * MARKS * SUB;

/**
 * One trade from the moment its level is set: shown at `p0`, buy limit 0.8%
 * under it, target and stop from the desk's own constants. `drift` is a
 * yearly trend in the price (0 = none).
 */
function runTrade(u, drift) {
  const p0 = 1000;
  const buy = Math.round(p0 * ENTRY_DISCOUNT * 100) / 100;
  let day = "2026-10-05";
  const trade = L.tradeFromLevel({
    kind: "FUT", symbol: "TEST", contract: "TEST", expiry: null, lotSize: 1,
    buy, target: Math.round(buy * TARGET_1 * 100) / 100, stop: Math.round(buy * STOP * 100) / 100,
    sessionDate: day, shownAt: new Date(istMs(day, "09:33")).toISOString(), anchorSource: "TEST", expected: null, priceBasis: "CONTRACT"
  });
  const dt = 1 / STEPS_PER_YEAR;
  const step = (p) => p * Math.exp((drift - (SIGMA * SIGMA) / 2) * dt + SIGMA * Math.sqrt(dt) * normal(u));
  let price = p0;
  for (let session = 0; session < 25; session += 1) {
    // The night between sessions: about a fifth of a day's variance, taken at once -- a gap.
    if (session > 0) {
      day = L.nextTradingDate(day);
      for (let k = 0; k < (MARKS * SUB) / 5; k += 1) price = step(price);
    }
    const open = price;
    let high = open, low = open;
    for (let m = 0; m < MARKS; m += 1) {
      for (let k = 0; k < SUB; k += 1) { price = step(price); high = Math.max(high, price); low = Math.min(low, price); }
      const minutes = 9 * 60 + 33 + m * 20;
      const hhmm = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
      L.observe(trade, { ltp: price, open, high, low, exchangeFeedTime: stamp(day, hhmm), exchangeTradeTime: stamp(day, hhmm) }, istMs(day, hhmm));
      if (trade.status !== "WAITING" && trade.status !== "OPEN") return trade;
    }
    L.settle(trade, istMs(day, "15:31"));
    if (trade.status !== "WAITING" && trade.status !== "OPEN") return trade;
  }
  return trade;
}

function tally(drift, n, seed) {
  const u = rng(seed);
  const out = { filled: 0, target: 0, stop: 0, other: 0, pnl: [] };
  for (let i = 0; i < n; i += 1) {
    const t = runTrade(u, drift);
    if (!t.filledAt) continue;
    out.filled += 1;
    if (t.status === "TARGET") out.target += 1; else if (t.status === "STOP") out.stop += 1; else out.other += 1;
    out.pnl.push(Number(t.pnl?.pct));
  }
  const mean = out.pnl.reduce((a, b) => a + b, 0) / out.pnl.length;
  const sd = Math.sqrt(out.pnl.reduce((a, b) => a + (b - mean) ** 2, 0) / (out.pnl.length - 1));
  return { ...out, targetShare: out.target / out.filled, meanPct: mean, sePct: sd / Math.sqrt(out.pnl.length) };
}

console.log("no trend, through the ledger's own rules:");

const ceiling = (1 - STOP) / (TARGET_1 - STOP);
check("the desk's geometry puts the break-even at 37.5%", Math.abs(ceiling - 0.375) < 1e-9, String(ceiling));

const flat = tally(0, 12000, 20260925);
const se = Math.sqrt((ceiling * (1 - ceiling)) / flat.filled);
console.log(`    no trend: ${flat.filled} filled, target first ${(100 * flat.targetShare).toFixed(1)}%, stop ${flat.stop}, other ${flat.other}, mean ${flat.meanPct.toFixed(3)}% +/- ${flat.sePct.toFixed(3)}`);
check("with no trend the target comes first no more often than the break-even (37.5%, allowing 3 standard errors)",
  flat.targetShare <= ceiling + 3 * se, `${(100 * flat.targetShare).toFixed(1)}%`);
check("and the average trade makes nothing or loses, before any charge (allowing 3 standard errors)",
  flat.meanPct <= 3 * flat.sePct, `${flat.meanPct.toFixed(3)}%`);

// A strong upward trend (+150% a year) is an edge. The same test must see it.
const trend = tally(1.5, 4000, 20260926);
console.log(`    +150%/yr trend: target first ${(100 * trend.targetShare).toFixed(1)}%, mean ${trend.meanPct.toFixed(3)}%`);
check("with a real upward trend the target share clears the break-even -- the test can see an edge", trend.targetShare > ceiling + 3 * se,
  `${(100 * trend.targetShare).toFixed(1)}%`);
check("and the average trade makes money", trend.meanPct > 3 * trend.sePct, `${trend.meanPct.toFixed(3)}%`);

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
