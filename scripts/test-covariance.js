"use strict";

/**
 * Covariance, shrinkage and portfolio risk.
 *
 * The estimator is checked by GENERATING returns from a known covariance and
 * requiring it to recover that covariance, and by constructing portfolios whose
 * correct answer is known analytically: perfectly correlated assets are one bet,
 * independent assets diversify as sqrt(N), and an asset's beta against itself
 * is one. None of these depend on the implementation being right, which is the
 * point.
 */

const assert = require("node:assert/strict");
const {
  alignedLogReturns,
  betasAgainst,
  buildRiskModel,
  correlationFrom,
  portfolioRisk,
  principalComponents,
  shrinkageCovariance
} = require("../api/_lib/covariance");

const near = (actual, expected, tolerance, message) =>
  assert.ok(Math.abs(Number(actual) - expected) <= tolerance,
    `${message}: got ${actual}, wanted ${expected} +/- ${tolerance}`);

// Deterministic standard normals: Box-Muller over mulberry32.
//
// The obvious `state = (state * 1103515245 + 12345) % 2147483648` is wrong in
// JavaScript: the multiply exceeds 2^53 and the double loses the low bits, so
// the stream degrades. Measured, it produced a variance of 1.013 to 1.028
// instead of 1.000, which is a 1 to 3 percent inflation -- enough to fail a
// covariance-recovery test and make a correct estimator look biased. mulberry32
// uses Math.imul and stays exact in 32-bit integers.
function gaussians(seed) {
  let state = seed >>> 0;
  const uniform = () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) + 0.5) / 4294967296;
  };
  let spare = null;
  return () => {
    if (spare !== null) { const value = spare; spare = null; return value; }
    const u = Math.max(1e-12, uniform());
    const v = uniform();
    const radius = Math.sqrt(-2 * Math.log(u));
    spare = radius * Math.sin(2 * Math.PI * v);
    return radius * Math.cos(2 * Math.PI * v);
  };
}

// --- 1. Recovering a known covariance ---------------------------------------
// Three assets driven by one common factor plus idiosyncratic noise, so the true
// covariance is known in closed form:  Sigma_ij = b_i b_j * var(F) + delta_ij * var(e_i)
const loadings = [1.2, 0.8, 0.4];
const idiosyncratic = [0.010, 0.014, 0.020];
const factorVol = 0.011;
const draw = gaussians(20260917);
const T = 40000;
const rows = [];
for (let t = 0; t < T; t += 1) {
  const factor = draw() * factorVol;
  rows.push(loadings.map((beta, i) => beta * factor + draw() * idiosyncratic[i]));
}
const estimate = shrinkageCovariance(rows, ["A", "B", "C"]);
assert.ok(estimate, "the estimator must return a result");
assert.ok(estimate.shrinkage >= 0 && estimate.shrinkage <= 1,
  `shrinkage intensity must lie in [0,1], got ${estimate.shrinkage}`);

// The tolerance is the estimator's OWN sampling error, not a number picked to
// make the test pass: the standard error of a covariance entry is
// sqrt((sigma_ii * sigma_jj + sigma_ij^2) / T). Four of those is a real bar --
// a systematically wrong estimator fails it, sampling noise does not.
const trueCovariance = (i, j) =>
  loadings[i] * loadings[j] * factorVol * factorVol + (i === j ? idiosyncratic[i] ** 2 : 0);
for (let i = 0; i < 3; i += 1) {
  for (let j = 0; j < 3; j += 1) {
    const truth = trueCovariance(i, j);
    const standardError = Math.sqrt((trueCovariance(i, i) * trueCovariance(j, j) + truth * truth) / T);
    near(estimate.covariance[i][j], truth, 4 * standardError, `covariance entry [${i}][${j}]`);
  }
}
console.log(`  ✓ Recovered a known covariance from generated returns (shrinkage ${estimate.shrinkage})`);

// --- 2. Positive semi-definiteness ------------------------------------------
// Every quadratic form must be non-negative, or the matrix can produce a
// portfolio with negative variance and the optimiser will happily find it.
const probe = gaussians(7);
for (let trial = 0; trial < 400; trial += 1) {
  const w = [probe(), probe(), probe()];
  let quadratic = 0;
  for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) quadratic += w[i] * estimate.covariance[i][j] * w[j];
  assert.ok(quadratic >= -1e-12, `negative variance found: ${quadratic}`);
}
assert.ok(estimate.covariance.every((row, i) => row[i] > 0), "variances must be positive");
assert.ok(estimate.covariance.every((row, i) => row.every((v, j) => Math.abs(v - estimate.covariance[j][i]) < 1e-15)),
  "a covariance matrix must be symmetric");
console.log("  ✓ Positive semi-definite and symmetric across 400 random probes");

// --- 3. Shrinkage rises when the sample gets shorter -------------------------
// This is the property that makes shrinkage worth having: less data, more
// reliance on structure, chosen without anybody turning a knob.
const short = shrinkageCovariance(rows.slice(0, 60), ["A", "B", "C"]);
assert.ok(short.shrinkage > estimate.shrinkage,
  `a 60-observation sample must shrink harder than a ${T}-observation one: ${short.shrinkage} vs ${estimate.shrinkage}`);
console.log(`  ✓ Shrinkage adapts to sample length: ${T} obs -> ${estimate.shrinkage}, 60 obs -> ${short.shrinkage}`);

// --- 4. Portfolios whose answer is known analytically ------------------------
// (a) Perfectly correlated assets are ONE bet however many you hold.
const identicalVol = 0.02;
const perfect = Array.from({ length: 5 }, () => new Array(5).fill(identicalVol * identicalVol));
const perfectRisk = portfolioRisk(perfect, new Array(5).fill(0.2));
near(perfectRisk.dailyVolatility, identicalVol, 1e-8, "five identical perfectly correlated assets carry one asset's risk");
near(perfectRisk.diversificationRatio, 1, 1e-4, "a diversification ratio of exactly 1 means one bet");
near(perfectRisk.effectiveNumberOfBets, 1, 0.01, "effective bets must be 1, not 5");

// (b) Independent assets diversify as sqrt(N).
//
// Volatilities are deliberately made slightly DISTINCT. On an exactly
// degenerate spectrum -- every variance identical, so the covariance is a
// scaled identity -- every orthonormal basis is an eigenbasis, and the
// effective-bet count depends on which arbitrary basis the solver happens to
// return. The quantity is undefined there, so asserting a value would be
// asserting an artefact. Distinct variances make the eigenbasis unique.
const N = 16;
const vols = Array.from({ length: N }, (_, i) => 0.018 + 0.0005 * i);
const independent = Array.from({ length: N }, (_, i) =>
  Array.from({ length: N }, (_, j) => (i === j ? vols[i] * vols[i] : 0)));
const equalWeights = new Array(N).fill(1 / N);
const independentRisk = portfolioRisk(independent, equalWeights);
const expectedVol = Math.sqrt(vols.reduce((sum, v) => sum + v * v, 0)) / N;
near(independentRisk.dailyVolatility, expectedVol, 1e-8, "independent assets scale risk by 1/sqrt(N)");
const weightedVol = vols.reduce((sum, v) => sum + v, 0) / N;
near(independentRisk.diversificationRatio, weightedVol / expectedVol, 1e-4,
  "diversification ratio is weighted average vol over portfolio vol");
assert.ok(independentRisk.diversificationRatio > Math.sqrt(N) * 0.98,
  `uncorrelated assets must diversify at roughly sqrt(N) = ${Math.sqrt(N)}, got ${independentRisk.diversificationRatio}`);
// With near-equal variances the risk is spread across all N principal
// directions, so the effective count must land close to N.
assert.ok(independentRisk.effectiveNumberOfBets > N * 0.95,
  `${N} independent positions must read as close to ${N} bets, got ${independentRisk.effectiveNumberOfBets}`);
console.log(`  ✓ One bet reads as 1.0 and ${N} independent bets read as ${independentRisk.effectiveNumberOfBets}`);

// (c) Risk contributions must sum to the portfolio volatility, by Euler's theorem.
const mixedWeights = [0.4, 0.35, 0.25];
const mixed = portfolioRisk(estimate.covariance, mixedWeights);
const summed = mixed.riskContributions.reduce((sum, value) => sum + value, 0);
near(summed, mixed.dailyVolatility, 1e-7, "marginal risk contributions must sum to total risk");
console.log("  ✓ Risk contributions sum to portfolio volatility (Euler decomposition)");

// --- 5. Beta -----------------------------------------------------------------
const betaResult = betasAgainst(estimate.covariance, ["A", "B", "C"], "A");
near(betaResult.betas.A, 1, 1e-6, "an asset's beta against itself is exactly 1");
// B's beta to A is cov(B,A)/var(A); with one factor that is (b_B/b_A) diluted by
// A's idiosyncratic variance, so it must sit strictly below the loading ratio.
assert.ok(betaResult.betas.B > 0 && betaResult.betas.B < loadings[1] / loadings[0],
  `single-factor beta must be positive and diluted by idiosyncratic variance, got ${betaResult.betas.B}`);
assert.ok(betaResult.betas.C < betaResult.betas.B, "a lower factor loading must give a lower beta");
assert.equal(betasAgainst(estimate.covariance, ["A", "B", "C"], "MISSING"), null, "an absent market proxy yields no betas");
console.log(`  ✓ Beta: self 1.000, B ${betaResult.betas.B}, C ${betaResult.betas.C}, ordered by factor loading`);

// --- 6. Principal components -------------------------------------------------
// For an equicorrelated matrix the leading eigenvalue share is known exactly:
// (1 + (n-1)*rho) / n.
const rho = 0.4;
const n = 12;
const equicorrelated = Array.from({ length: n }, (_, i) =>
  Array.from({ length: n }, (_, j) => (i === j ? 1 : rho) * identicalVol * identicalVol));
const pcs = principalComponents(equicorrelated, 2);
const expectedShare = (1 + (n - 1) * rho) / n * 100;
near(pcs.components[0].varianceSharePct, expectedShare, 0.05,
  "leading eigenvalue share of an equicorrelated matrix");
assert.ok(pcs.components[0].eigenvalue > pcs.components[1].eigenvalue, "components must come out ordered");
console.log(`  ✓ PC1 share ${pcs.components[0].varianceSharePct}% matches the closed form ${expectedShare.toFixed(2)}%`);

// --- 7. Correlation and alignment -------------------------------------------
const correlation = correlationFrom(estimate.covariance);
for (let i = 0; i < 3; i += 1) {
  near(correlation[i][i], 1, 1e-9, "a correlation matrix has a unit diagonal");
  for (let j = 0; j < 3; j += 1) {
    assert.ok(correlation[i][j] >= -1.000001 && correlation[i][j] <= 1.000001,
      `correlation out of bounds at [${i}][${j}]: ${correlation[i][j]}`);
  }
}

// Sessions that not every name printed must be dropped, or the covariance
// measures the calendar rather than the assets.
const ragged = {
  X: [{ session: "2026-01-01", close: 100 }, { session: "2026-01-02", close: 101 }, { session: "2026-01-03", close: 102 }],
  Y: [{ session: "2026-01-01", close: 50 }, { session: "2026-01-03", close: 51 }]
};
const alignment = alignedLogReturns(ragged, { minSessions: 0 });
assert.equal(alignment.sessions.length, 1, "only sessions common to every symbol survive alignment");
assert.deepEqual(alignment.symbols, ["X", "Y"]);

const thin = buildRiskModel({ X: ragged.X, Y: ragged.Y }, { minSessions: 120 });
assert.equal(thin.available, false, "a model must refuse to build on too few shared sessions");
assert.equal(thin.reason, "TOO_FEW_SHARED_SESSIONS");
console.log("  ✓ Correlation bounded, ragged calendars aligned, thin samples refused");

console.log("Covariance tests passed: known-covariance recovery, positive semi-definiteness, adaptive shrinkage, analytic portfolio cases, Euler risk decomposition, beta, eigenvalue closed form and calendar alignment");
