"use strict";

/**
 * EVERY PROBABILITY ON THE PAGE, CHECKED AGAINST PRICES THAT ACTUALLY MOVE.
 *
 * A formula checked only against itself proves nothing -- the same mistake can
 * sit in the code and in the test. So each number the desk shows is checked
 * here against an independent Monte Carlo simulation of the process the
 * formula claims to describe:
 *
 *   1. option prices (Black-76) against simulated terminal futures prices;
 *   2. put-call parity, an identity no model can bend;
 *   3. implied volatility, round-tripped through the pricer;
 *   4. the probability and median time of a buy limit BELOW the price being
 *      touched (paper-ledger firstPassage, the drift-corrected lower barrier);
 *   5. the same for a target ABOVE the price, and against the screener's own
 *      trade-odds timeToTarget;
 *   6. the paper ledger itself, run over simulated paths, against the exact
 *      answer for "target before stop" under a price with no edge.
 *
 * The random numbers come from xoshiro128** with a fixed seed. An LCG such as
 * mulberry32 repeats after ~4e9 draws and shows lattice structure well before
 * that; it is not fit to verify anything.
 *
 * Continuous monitoring is simulated honestly: a path observed at discrete
 * steps under-counts barrier touches, so each step adds the Brownian-bridge
 * probability that the path crossed the barrier BETWEEN the two observations.
 */

const { europeanOption, impliedVolatility } = require("../api/_lib/option-pricing");
const { timeToTarget } = require("../api/_lib/trade-odds");
const L = require("./paper-ledger");

let passed = 0;
let failed = 0;
function check(label, ok, detail = "") {
  if (ok) { passed += 1; console.log("  ok    " + label + (detail ? "  (" + detail + ")" : "")); }
  else { failed += 1; console.log("  FAIL  " + label + (detail ? "  (" + detail + ")" : "")); }
}

// ---- xoshiro128** -------------------------------------------------------------
function rng(seed) {
  let a = seed >>> 0, b = 0x9e3779b9, c = 0x243f6a88, d = 0xb7e15162;
  const rotl = (x, k) => (x << k) | (x >>> (32 - k));
  const next = () => {
    const result = Math.imul(rotl(Math.imul(b, 5), 7), 9) >>> 0;
    const t = b << 9;
    c ^= a; d ^= b; b ^= c; a ^= d; c ^= t; d = rotl(d, 11);
    return result / 4294967296;
  };
  for (let i = 0; i < 20; i += 1) next();
  let spare = null;
  next.normal = () => {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let u = 0; while (u === 0) u = next();
    const v = next();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
  return next;
}

// ---- 1-3. Black-76 prices, parity, implied volatility -------------------------
console.log("option prices (Black-76, the model a futures price takes):");
{
  const r = rng(11);
  const F = 370.5, T = 33.7 / 365, rate = 0.065, sigma = 0.1558;
  const disc = Math.exp(-rate * T);
  for (const [K, type] of [[380, "PE"], [360, "CE"], [400, "CE"], [340, "PE"]]) {
    const model = europeanOption({ model: "BLACK76", underlyingPrice: F, strike: K, timeToExpiryYears: T,
      riskFreeRate: rate, volatility: sigma, optionType: type }).price;
    // Terminal futures price under the pricing measure: a martingale.
    const N = 400000;
    let sum = 0, sumSq = 0;
    for (let i = 0; i < N / 2; i += 1) {
      const z = r.normal();
      for (const zz of [z, -z]) {           // antithetic pair
        const FT = F * Math.exp(-0.5 * sigma * sigma * T + sigma * Math.sqrt(T) * zz);
        const pay = disc * Math.max(0, type === "CE" ? FT - K : K - FT);
        sum += pay; sumSq += pay * pay;
      }
    }
    const mean = sum / N;
    const se = Math.sqrt((sumSq / N - mean * mean) / N);
    check(`${type} K=${K}: Black-76 ${model.toFixed(4)} vs simulation ${mean.toFixed(4)}`,
      Math.abs(model - mean) < 4 * se + 1e-6, `${((model - mean) / se).toFixed(2)} standard errors`);
  }

  const c = europeanOption({ model: "BLACK76", underlyingPrice: F, strike: 380, timeToExpiryYears: T, riskFreeRate: rate, volatility: sigma, optionType: "CE" }).price;
  const p = europeanOption({ model: "BLACK76", underlyingPrice: F, strike: 380, timeToExpiryYears: T, riskFreeRate: rate, volatility: sigma, optionType: "PE" }).price;
  check("put-call parity C - P = e^(-rT)(F - K)", Math.abs((c - p) - disc * (F - 380)) < 1e-9,
    `${(c - p).toFixed(6)} vs ${(disc * (F - 380)).toFixed(6)}`);

  let worst = 0;
  for (const s of [0.08, 0.1558, 0.3, 0.6, 1.2]) {
    for (const [K, type] of [[340, "PE"], [380, "PE"], [360, "CE"], [420, "CE"]]) {
      const price = europeanOption({ model: "BLACK76", underlyingPrice: F, strike: K, timeToExpiryYears: T, riskFreeRate: rate, volatility: s, optionType: type }).price;
      if (!(price > 0.05)) continue;
      const iv = impliedVolatility({ model: "BLACK76", underlyingPrice: F, strike: K, timeToExpiryYears: T, riskFreeRate: rate, optionType: type }, price).iv;
      worst = Math.max(worst, Math.abs(iv - s));
    }
  }
  check("implied volatility recovers the volatility that made the price, 8% to 120%", worst < 1e-6, `worst error ${worst.toExponential(2)}`);

  // The defect this session fixed, stated as a number rather than a claim.
  const bsm = impliedVolatility({ model: "BSM", underlyingPrice: F, strike: 380, timeToExpiryYears: T, riskFreeRate: rate, dividendYield: 0, optionType: "PE" }, 12.75).iv;
  const b76 = impliedVolatility({ model: "BLACK76", underlyingPrice: F, strike: 380, timeToExpiryYears: T, riskFreeRate: rate, optionType: "PE" }, 12.75).iv;
  check("a futures price in BSM with no dividend misprices volatility (the old defect)", Math.abs(bsm - b76) > 0.02,
    `BSM ${(100 * bsm).toFixed(2)}% vs Black-76 ${(100 * b76).toFixed(2)}% for TATAPOWER OCT 380 PE at 12.75`);
}

// ---- 4-5. Touch probabilities and times --------------------------------------
/**
 * Simulate a GBM with martingale drift, monitored continuously via the
 * Brownian bridge, and report how often and how fast it touches `level`.
 */
function simulateTouch({ from, to, sigma, tradingDays, paths = 100000, stepsPerDay = 50, seed = 7 }) {
  const r = rng(seed);
  const years = tradingDays / 252;
  const steps = Math.max(10, Math.round(stepsPerDay * tradingDays));
  const dt = years / steps;
  const drift = -0.5 * sigma * sigma * dt;
  const vol = sigma * Math.sqrt(dt);
  const barrier = Math.log(to / from);
  const up = barrier > 0;
  let touched = 0;
  const times = [];
  for (let p = 0; p < paths; p += 1) {
    let x = 0;
    for (let i = 1; i <= steps; i += 1) {
      const nx = x + drift + vol * r.normal();
      const beyond = up ? nx >= barrier : nx <= barrier;
      let hit = beyond;
      if (!hit) {
        // Probability the path crossed and came back between the two marks.
        const da = up ? barrier - x : x - barrier;
        const db = up ? barrier - nx : nx - barrier;
        if (da > 0 && db > 0 && r() < Math.exp((-2 * da * db) / (sigma * sigma * dt))) hit = true;
      }
      if (hit) { touched += 1; times.push((i / steps) * tradingDays); break; }
      x = nx;
    }
  }
  times.sort((a, b) => a - b);
  return { probabilityPct: (100 * touched) / paths, medianTradingDays: times.length ? times[Math.floor(times.length / 2)] : null, se: 100 * Math.sqrt((touched / paths) * (1 - touched / paths) / paths) };
}

console.log("\ntouch probabilities and times (paper-ledger firstPassage):");
for (const c of [
  { name: "futures buy limit 0.8% BELOW, rest of a session, 19.6% vol", from: 3946.4, to: 3914.83, sigma: 0.196, tradingDays: 0.95 },
  { name: "futures target +2.5% ABOVE the fill, 20 sessions, 19.6% vol", from: 3914.83, to: 4012.7, sigma: 0.196, tradingDays: 20 },
  { name: "a deep 5% dip in one session at 45% vol (a shock day)", from: 100, to: 95, sigma: 0.45, tradingDays: 1 },
  { name: "a 10% rally in 5 sessions at 30% vol", from: 100, to: 110, sigma: 0.30, tradingDays: 5 }
]) {
  const formula = L.firstPassage(c);
  const sim = simulateTouch({ ...c, paths: 60000, stepsPerDay: 40 });
  const zs = (formula.probabilityPct - sim.probabilityPct) / sim.se;
  check(c.name, Math.abs(zs) < 4,
    `formula ${formula.probabilityPct}% vs simulated ${sim.probabilityPct.toFixed(1)}% (${zs.toFixed(1)} SE); median ${formula.medianTradingDays} vs ${sim.medianTradingDays === null ? "-" : sim.medianTradingDays.toFixed(3)} sessions`);
  if (sim.medianTradingDays !== null && formula.medianTradingDays > 0.02) {
    check("  and its median time agrees within 12%", Math.abs(formula.medianTradingDays - sim.medianTradingDays) / sim.medianTradingDays < 0.12);
  }
}

{
  // The screener's own target odds (trade-odds.timeToTarget), which times in
  // CALENDAR days against a 252-day volatility.
  const sim = simulateTouch({ from: 100, to: 106, sigma: 0.25, tradingDays: 30 * 252 / 365, paths: 60000, stepsPerDay: 30, seed: 19 });
  const t = timeToTarget({ spot: 100, target: 106, volatility: 0.25, daysAvailable: 30 });
  const zs = (t.probabilityOfTouchPct - sim.probabilityPct) / sim.se;
  check("screener odds: +6% within 30 calendar days at 25% vol", Math.abs(zs) < 4,
    `formula ${t.probabilityOfTouchPct}% vs simulated ${sim.probabilityPct.toFixed(1)}% (${zs.toFixed(1)} SE)`);
}

// ---- 6. The paper ledger, run over simulated markets --------------------------
/**
 * A price with NO edge, i.e. a martingale, hits +2.5% before -1.5% (from the
 * fill) with probability exactly (fill - stop) / (target - stop) = 0.375, by
 * optional stopping. Run the REAL ledger over simulated minute-by-minute paths,
 * marked every twenty minutes with the window's high and low, and it must come
 * out at or just under 37.5%: never above, because every ambiguity it meets is
 * resolved against the record.
 *
 * It is also the most important number on this page for a trader: with these
 * levels, a coin-flip market wins 37.5% of the time and breaks even. Anything
 * the desk adds has to show up as a hit rate ABOVE 37.5%.
 */
console.log("\nthe paper ledger, marked like the real one, on markets with no edge:");
{
  const r = rng(29);
  const sigma = 0.25;
  const minutesPerSession = 375;
  const dtMin = 1 / (252 * minutesPerSession);
  const runs = 3000;
  const outcome = { TARGET: 0, STOP: 0, TIMED_OUT: 0, TIME_EXIT: 0, EXPIRED: 0, OPEN: 0 };
  for (let run = 0; run < runs; run += 1) {
    const t = L.tradeFromLevel({ kind: "FUT", symbol: "SIM", contract: "SIMFUT", expiry: "2027-06-29",
      buy: 100, target: 102.5, stop: 98.5, sessionDate: "2027-01-04", shownAt: "2027-01-04T04:03:00.000Z" });
    // Start filled, so the test is target-versus-stop and nothing else.
    t.status = "OPEN"; t.filledAt = t.shownAt; t.best = 100; t.worst = 100;
    let price = 100;
    const dayMs = 86_400_000;
    let clock = Date.parse("2027-01-04T09:33:00+05:30");
    t.obs = { date: "2027-01-04", high: 100, low: 100, last: 100 };
    for (let day = 0; day < 20 && t.status === "OPEN"; day += 1) {
      const sessionStart = Date.parse("2027-01-04T09:15:00+05:30") + day * dayMs;
      const iso = new Date(sessionStart + 330 * 60_000).toISOString().slice(0, 10);
      const feedDay = iso.slice(8, 10) + "-" + ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][Number(iso.slice(5, 7)) - 1] + "-" + iso.slice(0, 4);
      let dayHigh = price, dayLow = price;
      const open = price;
      for (let m = 1; m <= minutesPerSession && t.status === "OPEN"; m += 1) {
        price *= Math.exp(-0.5 * sigma * sigma * dtMin + sigma * Math.sqrt(dtMin) * r.normal());
        dayHigh = Math.max(dayHigh, price); dayLow = Math.min(dayLow, price);
        if (m % 20 === 0 || m === minutesPerSession) {
          clock = sessionStart + m * 60_000;
          L.observe(t, { ltp: price, high: dayHigh, low: dayLow, open, exchangeFeedTime: feedDay + " 10:00:00" }, clock);
        }
      }
    }
    outcome[t.status] = (outcome[t.status] || 0) + 1;
  }
  const decided = outcome.TARGET + outcome.STOP;
  const hit = outcome.TARGET / decided;
  const se = Math.sqrt(0.375 * 0.625 / decided);
  console.log(`    ${runs} simulated trades: ${outcome.TARGET} target, ${outcome.STOP} stop, ${outcome.TIMED_OUT} still open after 20 sessions`);
  check("target-before-stop is at or under the exact 37.5% for a price with no edge",
    hit <= 0.375 + 3 * se, `${(100 * hit).toFixed(1)}% of ${decided} decided`);
  check("and not far under it -- the harsh rules cost little on a 20-minute mark",
    hit >= 0.375 - 6 * se, `${(100 * (0.375 - hit)).toFixed(1)} points below the exact value`);
}

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
