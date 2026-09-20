"use strict";

/**
 * The equations, checked against something that is not this codebase.
 *
 * A formula that agrees with itself proves nothing. Every check below compares
 * an implementation against an INDEPENDENT reference: a published value, an
 * analytic special case, or a simulation whose answer is known in advance.
 *
 * SCOPE. Ledoit-Wolf shrinkage, Meucci effective bets and the panel statistics
 * are NOT here: scripts/test-covariance.js and scripts/test-panel.js already
 * assert known-covariance recovery, positive semi-definiteness over 400 probes,
 * adaptive shrinkage, the Euler decomposition, eigenvalue closed forms, purged
 * splits and cluster collapse. Re-testing them here with hand-rolled fixtures
 * adds no independence -- and on the first attempt it added four FALSE failures,
 * every one of them caused by calling those functions with transposed inputs.
 * A duplicate test that is wrong is worse than no duplicate test.
 *
 * Two conventions worth knowing before reading the calls below, both of which
 * cost me a false bug report:
 *   - calculateMoments, forecastGarch11Volatility and calculateCornishFisherRisk
 *     all take a PRICE SERIES and derive returns themselves.
 *   - THE UNITS ARE NOT CONSISTENT BETWEEN THEM, and the same file exports both.
 *     forecastGarch11Volatility returns DECIMALS (0.1687 means 16.87%).
 *     calculateCornishFisherRisk returns PERCENT (varPct 2.32 means 2.32%).
 *     Read the field name, not the neighbouring function.
 */

const aq = require("../api/_lib/advanced-quant");
const panel = require("../api/_lib/panel");
const ic = require("../api/_lib/institutional-calculus");
const odds = require("../api/_lib/trade-odds");
const { europeanOption, impliedVolatility } = require("../api/_lib/option-pricing");

let checks = 0, failures = 0;
function check(label, condition, detail) {
  checks += 1;
  if (condition) { console.log(`  PASS  ${label}`); return; }
  failures += 1;
  console.log(`  FAIL  ${label}${detail ? `  -- ${detail}` : ""}`);
}

/**
 * A sound PRNG. A linear congruential generator cycles under about a billion
 * draws and has already produced one false result in this project -- it made a
 * correct first-passage formula look wrong. Never verify anything with one.
 */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussian(rnd) {
  const u = Math.max(rnd(), 1e-12), v = Math.max(rnd(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function gbmPrices(rnd, n, dailyVol, drift = 0, start = 100) {
  let p = start;
  const out = [p];
  for (let i = 0; i < n; i += 1) { p *= Math.exp(drift + gaussian(rnd) * dailyVol); out.push(p); }
  return out;
}

console.log("\n=== THE GENERATOR ITSELF, BEFORE TRUSTING ANYTHING IT SAYS ===");
{
  const rnd = mulberry32(1);
  const x = Array.from({ length: 200000 }, () => gaussian(rnd));
  const n = x.length;
  const m = x.reduce((a, b) => a + b, 0) / n;
  const mom = (k) => x.reduce((a, v) => a + (v - m) ** k, 0) / n;
  const sd = Math.sqrt(mom(2));
  check(`mean ${m.toFixed(4)} and sd ${sd.toFixed(4)} are Gaussian`, Math.abs(m) < 0.01 && Math.abs(sd - 1) < 0.01);
  check(`skew ${(mom(3) / sd ** 3).toFixed(4)} and excess kurtosis ${(mom(4) / sd ** 4 - 3).toFixed(4)} are Gaussian`,
    Math.abs(mom(3) / sd ** 3) < 0.03 && Math.abs(mom(4) / sd ** 4 - 3) < 0.05);
}

console.log("\n=== BLACK-SCHOLES, against Hull's published values ===");
{
  const c = europeanOption({ underlyingPrice: 42, strike: 40, timeToExpiryYears: 0.5, riskFreeRate: 0.10, dividendYield: 0, volatility: 0.20, optionType: "CE", model: "BSM" });
  const p = europeanOption({ underlyingPrice: 42, strike: 40, timeToExpiryYears: 0.5, riskFreeRate: 0.10, dividendYield: 0, volatility: 0.20, optionType: "PE", model: "BSM" });
  check(`Hull ch.15 call 4.7594 (got ${c.price.toFixed(4)})`, Math.abs(c.price - 4.7594) < 1e-4);
  check(`Hull ch.15 put 0.8086 (got ${p.price.toFixed(4)})`, Math.abs(p.price - 0.8086) < 1e-4);

  const g = europeanOption({ underlyingPrice: 49, strike: 50, timeToExpiryYears: 0.3846, riskFreeRate: 0.05, dividendYield: 0, volatility: 0.20, optionType: "CE", model: "BSM" });
  check(`Hull ch.19 Greeks: delta .522 gamma .066 vega 12.1 theta -4.31 rho 8.91`,
    Math.abs(g.delta - 0.522) < 5e-4 && Math.abs(g.gamma - 0.066) < 5e-4
    && Math.abs(g.vega * 100 - 12.1) < 0.05 && Math.abs(g.theta * 365 + 4.31) < 0.05
    && Math.abs(g.rho * 100 - 8.91) < 0.05);

  // Parity is an identity, so the tolerance is machine precision, not judgement.
  const S = 100, K = 95, r = 0.05, q = 0.02, T = 0.75, sig = 0.3;
  const cc = europeanOption({ underlyingPrice: S, strike: K, timeToExpiryYears: T, riskFreeRate: r, dividendYield: q, volatility: sig, optionType: "CE", model: "BSM" });
  const pp = europeanOption({ underlyingPrice: S, strike: K, timeToExpiryYears: T, riskFreeRate: r, dividendYield: q, volatility: sig, optionType: "PE", model: "BSM" });
  const gap = Math.abs((cc.price - pp.price) - (S * Math.exp(-q * T) - K * Math.exp(-r * T)));
  check(`put-call parity holds to ${gap.toExponential(1)}`, gap < 1e-12);

  const iv = impliedVolatility({ underlyingPrice: S, strike: K, timeToExpiryYears: T, riskFreeRate: r, dividendYield: q, optionType: "CE", model: "BSM" }, cc.price);
  check(`implied volatility round-trips 0.30 to ${iv.iv.toFixed(8)}`, Math.abs(iv.iv - 0.3) < 1e-8);
}

console.log("\n=== NORMAL DISTRIBUTION ===");
{
  const cases = [[0, 0.5], [1, 0.841344746068543], [1.96, 0.975002104851780],
    [2.575829, 0.995000000000000], [-1, 0.158655253931457], [-3, 0.001349898031630]];
  const worst = Math.max(...cases.map(([x, p]) => Math.abs(panel.normalCdf(x) - p)));
  check(`normal CDF matches published values to ${worst.toExponential(1)}`, worst < 1e-6);
  const rt = Math.max(...[0.025, 0.1, 0.5, 0.9, 0.975].map((p) => Math.abs(panel.normalCdf(panel.normalQuantile(p)) - p)));
  check(`the quantile function inverts the CDF to ${rt.toExponential(1)}`, rt < 1e-6);
}

console.log("\n=== GARCH(1,1) ===");
{
  // WHAT THIS MODULE IS, stated plainly because the name oversells it: alpha and
  // beta are NOT estimated. They are hard-coded at 0.08 and 0.88, the standard
  // textbook daily-equity pair, so persistence is 0.96 for every instrument on
  // the desk. Only omega is fitted, by Engle's variance targeting:
  //     omega = sampleVariance * (1 - alpha - beta)
  // which forces the long-run variance to equal the sample variance exactly.
  // That identity is what these checks assert; a maximum-likelihood claim would
  // not survive them and is not made.
  const rnd = mulberry32(7);
  const omega = 0.000002, alpha = 0.08, beta = 0.90;
  const trueLongRun = Math.sqrt((omega / (1 - alpha - beta)) * 252);   // 0.1587
  let v = omega / (1 - alpha - beta), prev = 0, price = 100;
  const prices = [price], rets = [];
  for (let i = 0; i < 4000; i += 1) {
    v = omega + alpha * prev * prev + beta * v;
    prev = Math.sqrt(v) * gaussian(rnd);
    price *= Math.exp(prev);
    prices.push(price); rets.push(prev);
  }
  const fit = ic.forecastGarch11Volatility(prices);

  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sampleAnnual = Math.sqrt(rets.reduce((a, x) => a + (x - mean) ** 2, 0) / (rets.length - 1) * 252);
  check(`variance targeting is exact: long-run ${fit.longRunAnnualizedVol} = sample ${sampleAnnual.toFixed(4)}`,
    Math.abs(fit.longRunAnnualizedVol - sampleAnnual) < 5e-4);
  check(`and that lands on the simulated truth: ${fit.longRunAnnualizedVol} vs ${trueLongRun.toFixed(4)}`,
    Math.abs(fit.longRunAnnualizedVol / trueLongRun - 1) < 0.15);

  // Mean reversion must point the forecast FROM the current level TOWARD the
  // long-run level. If it ever sat outside that interval the projection
  // recursion would be wrong, and it would not show up as an error.
  const lo = Math.min(fit.currentAnnualizedVol, fit.longRunAnnualizedVol);
  const hi = Math.max(fit.currentAnnualizedVol, fit.longRunAnnualizedVol);
  check(`the 5-day forecast ${fit.forecastedAnnualizedVol} reverts between current ${fit.currentAnnualizedVol} and long-run ${fit.longRunAnnualizedVol}`,
    fit.forecastedAnnualizedVol >= lo - 1e-9 && fit.forecastedAnnualizedVol <= hi + 1e-9);
  check(`persistence is the declared constant 0.96, not a fitted number`, fit.persistence === 0.96);

  // Two different regimes must NOT produce the same answer. Units are DECIMALS.
  const calm = ic.forecastGarch11Volatility(gbmPrices(mulberry32(8), 1500, 0.005));
  const wild = ic.forecastGarch11Volatility(gbmPrices(mulberry32(9), 1500, 0.030));
  check(`a wild series reads far higher than a calm one (${(wild.currentAnnualizedVol * 100).toFixed(1)}% vs ${(calm.currentAnnualizedVol * 100).toFixed(1)}%)`,
    wild.currentAnnualizedVol > calm.currentAnnualizedVol * 2);
  check(`each lands on its own true vol (calm ${(calm.longRunAnnualizedVol * 100).toFixed(1)}% vs 7.9%, wild ${(wild.longRunAnnualizedVol * 100).toFixed(1)}% vs 47.6%)`,
    Math.abs(calm.longRunAnnualizedVol - 0.005 * Math.sqrt(252)) < 0.02
    && Math.abs(wild.longRunAnnualizedVol - 0.030 * Math.sqrt(252)) < 0.06);

  // The regime label is what the desk actually consumes -- it is worth 25% of
  // the composite score -- so its cut points are asserted here explicitly.
  check(`the regime label cuts at 15% and 28% as documented`,
    ic.forecastGarch11Volatility(gbmPrices(mulberry32(31), 900, 0.005)).volatilityRegime === "LOW_VOL"
    && ic.forecastGarch11Volatility(gbmPrices(mulberry32(32), 900, 0.0125)).volatilityRegime === "MODERATE_VOL"
    && ic.forecastGarch11Volatility(gbmPrices(mulberry32(33), 900, 0.030)).volatilityRegime === "HIGH_VOL");
}

console.log("\n=== MOMENTS AND CORNISH-FISHER VaR / CVaR ===");
{
  const rnd = mulberry32(11);
  const prices = gbmPrices(rnd, 20000, 0.01);
  const mom = ic.calculateMoments(prices);
  check(`recovers 1% daily vol (got ${mom.stdDev.toFixed(4)})`, Math.abs(mom.stdDev - 0.01) < 0.0005);
  check(`Gaussian kurtosis is 3 (got ${mom.kurtosis.toFixed(3)})`, Math.abs(mom.kurtosis - 3) < 0.15);
  check(`Gaussian skew is 0 (got ${mom.skewness.toFixed(3)})`, Math.abs(mom.skewness) < 0.1);

  const r = ic.calculateCornishFisherRisk(prices);
  check(`VaR99 on Gaussian data equals 2.326 sigma (got ${r.varPct.toFixed(3)}%)`, Math.abs(r.varPct - 2.326) < 0.15);
  check(`CVaR >= VaR always (${r.cvarPct.toFixed(3)} >= ${r.varPct.toFixed(3)})`, r.cvarPct >= r.varPct - 1e-9);
  check(`the adjustment is near-neutral on Gaussian data (${r.adjustedQuantile} vs ${r.gaussianQuantile})`,
    Math.abs(r.adjustedQuantile - r.gaussianQuantile) < 0.15);
  check("it reports whether the expansion is inside its valid domain", typeof r.cornishFisherValid === "boolean");

  // Fat tails must widen the loss, and must NEVER return zero: this desk once
  // shipped a VaR of 0 on fat-tailed input because a Math.max(0, ...) hid it.
  const rnd2 = mulberry32(12);
  let p1 = 100; const fat = [p1];
  for (let i = 0; i < 20000; i += 1) {
    const z = gaussian(rnd2);
    p1 *= Math.exp((Math.abs(z) > 2 ? z * 3 : z) * 0.01);
    fat.push(p1);
  }
  const rf = ic.calculateCornishFisherRisk(fat);
  check(`fat tails widen VaR (${rf.varPct.toFixed(2)}% vs ${r.varPct.toFixed(2)}%) and never return zero`,
    rf.varPct > r.varPct && rf.varPct > 0);
}

console.log("\n=== HURST EXPONENT (rescaled range) ===");
{
  // WHAT R/S ACTUALLY MEASURES, written down because testing it against the
  // wrong null is how this check first failed for no reason. Classical R/S
  // de-means every window with that window's OWN mean, so a deterministic drift
  // is removed before the range is taken. A strongly TRENDING random walk with
  // independent increments therefore reads 0.5, and correctly so. R/S measures
  // AUTOCORRELATION IN THE INCREMENTS, not slope. These checks drive that
  // directly, with an AR(1) on the log returns.
  //
  // KNOWN AND ACCEPTED BIAS: the naive log-log slope is positively biased on
  // short series. The finite-sample E[R/S] of Anis & Lloyd (1976) is steeper
  // than the asymptotic 0.5, and the bias is worst below n = 100. This desk
  // carries a median of 67 daily bars, so the LEVEL reads high -- an independent
  // series lands near 0.58, not 0.50 -- and only the CROSS-SECTIONAL ORDER is
  // used downstream. These checks therefore assert ordering, not level.
  const ar1 = (phi, seed, n = 1200, sd = 0.01) => {
    const rnd = mulberry32(seed);
    let e = 0, p = 100;
    const out = [p];
    for (let i = 0; i < n; i += 1) {
      e = phi * e + Math.sqrt(1 - phi * phi) * gaussian(rnd) * sd;
      p *= Math.exp(e);
      out.push(p);
    }
    return out;
  };
  const anti = aq.calculateHurstExponent(ar1(-0.45, 41));
  const walk = aq.calculateHurstExponent(ar1(0, 42));
  const persistent = aq.calculateHurstExponent(ar1(0.45, 43));

  check(`ordered anti-persistent < independent < persistent (${anti.toFixed(3)} < ${walk.toFixed(3)} < ${persistent.toFixed(3)})`,
    anti < walk && walk < persistent);
  check(`separated by more than noise (gaps ${(walk - anti).toFixed(3)} and ${(persistent - walk).toFixed(3)})`,
    walk - anti > 0.04 && persistent - walk > 0.04);

  // Drift alone must NOT move it. This is the check that catches the wrong null:
  // if adding a strong trend raised H, the estimator would be reading slope,
  // which is not what the desk ranks on.
  const flat = aq.calculateHurstExponent(gbmPrices(mulberry32(51), 1200, 0.01, 0));
  const steep = aq.calculateHurstExponent(gbmPrices(mulberry32(51), 1200, 0.01, 0.006));
  check(`a pure drift does not move it (${flat.toFixed(3)} vs ${steep.toFixed(3)}) -- R/S reads memory, not slope`,
    Math.abs(flat - steep) < 0.05);
}

console.log("\n=== VOLATILITY ESTIMATORS ===");
{
  // With NO overnight gap the two must broadly agree; with a gap, Parkinson
  // cannot see it and must read low. Both directions are asserted.
  const build = (rnd, gapShare, sigma) => {
    const bars = [];
    let s = 100;
    const sd = sigma * Math.sqrt(1 / 252);
    for (let i = 0; i < 400; i += 1) {
      const open = s * Math.exp(gaussian(rnd) * sd * Math.sqrt(gapShare));
      let px = open, hi = open, lo = open;
      const intra = sd * Math.sqrt(1 - gapShare);
      for (let k = 0; k < 40; k += 1) { px *= Math.exp(gaussian(rnd) * intra / Math.sqrt(40)); hi = Math.max(hi, px); lo = Math.min(lo, px); }
      s = px;
      bars.push({ open, high: hi, low: lo, close: px });
    }
    return bars;
  };
  const flat = build(mulberry32(66), 0, 0.25);
  check(`with no gap the estimators agree (P ${(odds.parkinsonVol(flat) * 100).toFixed(1)}% vs YZ ${(odds.yangZhangVol(flat) * 100).toFixed(1)}%)`,
    Math.abs(odds.parkinsonVol(flat) - odds.yangZhangVol(flat)) / odds.yangZhangVol(flat) < 0.20);

  const gapped = build(mulberry32(67), 0.5, 0.25);
  const pk = odds.parkinsonVol(gapped), yz = odds.yangZhangVol(gapped);
  check(`with half the variance overnight, Parkinson reads LOW (${(pk * 100).toFixed(1)}% vs YZ ${(yz * 100).toFixed(1)}%, true 25%)`,
    pk < yz * 0.85);
  check(`Yang-Zhang stays near the truth (got ${(yz * 100).toFixed(1)}%, true 25%)`, Math.abs(yz - 0.25) / 0.25 < 0.25);
}

console.log("\n=== FIRST PASSAGE ===");
{
  // The drifted form must contain the driftless one as its mu=0 special case.
  const S = 100, B = 105, v = 0.25, d = 30;
  const b = Math.log(B / S), T = d / 365, rt = v * Math.sqrt(T);
  const driftless = 2 * panel.normalCdf(-b / rt) * 100;
  const drifted = odds.timeToTarget({ spot: S, target: B, volatility: v, daysAvailable: d }).probabilityOfTouchPct;
  check(`the drifted form sits BELOW the driftless one (${drifted.toFixed(2)}% < ${driftless.toFixed(2)}%)`,
    drifted < driftless, "a martingale price has log-drift -sigma^2/2, so ignoring it flatters the trade");

  // And Monte Carlo must converge onto it as monitoring gets finer.
  const mc = (steps, paths, seed) => {
    const rnd = mulberry32(seed);
    const dt = T / steps, sd = v * Math.sqrt(dt), drift = -0.5 * v * v * dt;
    let hit = 0;
    for (let p = 0; p < paths; p += 1) {
      let x = S;
      for (let i = 0; i < steps; i += 1) { x *= Math.exp(drift + gaussian(rnd) * sd); if (x >= B) { hit += 1; break; } }
    }
    return hit / paths * 100;
  };
  const coarse = mc(100, 30000, 5), fine = mc(4000, 30000, 5);
  check(`Monte Carlo converges upward onto it (${coarse.toFixed(2)}% at 100 steps, ${fine.toFixed(2)}% at 4000, formula ${drifted.toFixed(2)}%)`,
    fine > coarse && Math.abs(fine - drifted) < 1.0,
    "the residual gap is discrete monitoring in the simulation, not error in the formula");
}

console.log("\n" + "=".repeat(72));
console.log(failures === 0
  ? `ALL ${checks} EQUATION CHECKS PASSED, each against an independent reference.`
  : `${failures} of ${checks} CHECKS FAILED. Do not trust the affected outputs.`);
console.log("=".repeat(72));
process.exit(failures === 0 ? 0 : 1);
