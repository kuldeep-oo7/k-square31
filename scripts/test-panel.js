"use strict";

const assert = require("node:assert/strict");
const {
  assignSplit,
  benchmarkBySplit,
  calendarSplitBoundaries,
  clusterRobustMean,
  deflatedTStat,
  expectedMaxTStat,
  normalCdf,
  normalQuantile,
  panelVerdict,
  quintileProfile,
  twoSidedPValue
} = require("../api/_lib/panel");

const near = (actual, expected, tolerance, message) =>
  assert.ok(Math.abs(Number(actual) - expected) <= tolerance, `${message}: got ${actual}, wanted ${expected} +/- ${tolerance}`);

// --- distribution primitives, checked against published constants -----------
near(normalQuantile(0.975), 1.959963985, 1e-6, "97.5th percentile of the standard normal");
near(normalQuantile(0.025), -1.959963985, 1e-6, "2.5th percentile is the mirror");
near(normalQuantile(0.99), 2.326347874, 1e-6, "99th percentile");
near(normalCdf(1.959963985), 0.975, 1e-6, "the CDF inverts the quantile");
near(normalCdf(0), 0.5, 1.2e-7, "the normal is centred at zero, to the erfc fit accuracy");
near(twoSidedPValue(1.959963985), 0.05, 1e-5, "t = 1.96 is the 5% two-sided point");
near(twoSidedPValue(2.575829304), 0.01, 1e-5, "t = 2.576 is the 1% two-sided point");
assert.equal(normalQuantile(0), null, "the quantile is undefined outside (0, 1)");
assert.equal(normalQuantile(1), null, "the quantile is undefined outside (0, 1)");

// --- selection hurdle ------------------------------------------------------
assert.equal(expectedMaxTStat(1), 0, "a single untried configuration carries no selection premium");
near(expectedMaxTStat(6), 1.30, 0.05, "expected maximum of six standard-normal draws");
near(expectedMaxTStat(194), 2.76, 0.05, "expected maximum over a 97-name two-sided universe");
for (let trials = 2; trials < 400; trials *= 2) {
  assert.ok(expectedMaxTStat(trials * 2) > expectedMaxTStat(trials), "searching harder can only raise the bar");
  assert.ok(
    Math.sqrt(2 * Math.log(trials)) >= expectedMaxTStat(trials),
    "sqrt(2*ln N) is the asymptotic leading term and must sit above the exact expectation"
  );
}
// A t-statistic only counts as evidence once it clears the bar its own search
// set. The same number is decisive or worthless depending on how many
// configurations were tried to reach it.
assert.ok(deflatedTStat(1.5, 6) > 0, "t = 1.5 survives a six-configuration search");
assert.ok(deflatedTStat(1.5, 194) < 0, "the same t = 1.5 is worthless after a 194-configuration search");
assert.ok(deflatedTStat(2.18, 6) > 0, "a per-symbol grid of six is cleared at t = 2.18");
assert.ok(deflatedTStat(2.18, 194) < 0, "a universe-wide search of 194 is not");
assert.ok(deflatedTStat(3.14, 194) > 0, "t = 3.14 does clear even a 194-configuration search");
assert.equal(deflatedTStat(null, 35), null, "a missing t-statistic deflates to nothing, never to zero");

// --- calendar splits and purging -------------------------------------------
const weekKeys = Array.from({ length: 100 }, (_, index) => `2024-${String(Math.floor(index / 30) + 1).padStart(2, "0")}-${String((index % 30) + 1).padStart(2, "0")}`);
const bounds = calendarSplitBoundaries(weekKeys, { developmentRatio: 0.60, validationRatio: 0.20 });
assert.equal(bounds.weeks, 100);
assert.equal(bounds.validationFrom, weekKeys[60], "the development window ends at 60% of calendar weeks");
assert.equal(bounds.finalTestFrom, weekKeys[80], "the validation window ends at 80%");
assert.equal(calendarSplitBoundaries(["2024-01-01"]), null, "two weeks cannot be split three ways");

assert.equal(assignSplit({ weekKey: weekKeys[10], exitSession: weekKeys[11] }, bounds), "development");
assert.equal(assignSplit({ weekKey: weekKeys[70], exitSession: weekKeys[71] }, bounds), "validation");
assert.equal(assignSplit({ weekKey: weekKeys[90], exitSession: weekKeys[95] }, bounds), "finalTest");
assert.equal(
  assignSplit({ weekKey: weekKeys[59], exitSession: weekKeys[65] }, bounds),
  null,
  "a label that opens in development and closes in validation is purged, never leaked"
);
assert.equal(
  assignSplit({ weekKey: weekKeys[79], exitSession: weekKeys[85] }, bounds),
  null,
  "the same purge applies at the validation/final-test boundary"
);

// --- cluster-robust standard error ------------------------------------------
// Twenty weeks, fifty names each. Every name in a week moves together, so the
// panel holds 20 independent observations and not 1000. A naive i.i.d. standard
// error would divide by sqrt(1000) and overstate significance by about sqrt(50).
const shocks = [1.4, -0.9, 0.6, -1.7, 2.1, -0.3, 0.8, -1.1, 1.9, -2.4, 0.2, 1.3, -0.7, 0.5, -1.5, 2.2, -0.4, 0.9, -1.2, 1.6];
const correlated = [];
for (let week = 0; week < shocks.length; week += 1) {
  for (let name = 0; name < 50; name += 1) correlated.push({ value: shocks[week], cluster: `W${week}` });
}
const clustered = clusterRobustMean(correlated);
assert.equal(clustered.n, 1000);
assert.equal(clustered.clusters, 20, "clustering collapses 1000 fills onto 20 shared weekly shocks");
const flat = correlated.map((row) => row.value);
const average = flat.reduce((sum, value) => sum + value, 0) / flat.length;
const naiveSe = Math.sqrt(flat.reduce((sum, value) => sum + (value - average) ** 2, 0) / (flat.length - 1) / flat.length);
assert.ok(
  clustered.standardErrorPct > naiveSe * 5,
  `the clustered standard error must dwarf the i.i.d. one under perfect within-week correlation (clustered ${clustered.standardErrorPct}, naive ${naiveSe.toFixed(5)})`
);
// Independent clusters: the sandwich estimate should land near the i.i.d. one.
const independent = shocks.flatMap((value, week) => [{ value, cluster: `W${week}` }]);
const solo = clusterRobustMean(independent);
near(solo.n, 20, 0, "one observation per cluster");
assert.equal(clusterRobustMean([{ value: 1, cluster: "A" }]).tStat, null, "a single observation carries no t-statistic");
assert.equal(clusterRobustMean([{ value: 1, cluster: "A" }, { value: 2, cluster: "A" }]).tStat, null, "one cluster cannot bound its own error");

// --- buy-and-hold control ---------------------------------------------------
const returns = [];
for (const [session, value] of [["2024-01-10", 1], ["2024-01-11", 1], ["2024-03-05", -2], ["2024-04-01", 0.5]]) {
  for (let name = 0; name < 4; name += 1) returns.push({ session, returnPct: value });
}
const benchmark = benchmarkBySplit(returns, { ...bounds, symbolCount: 4 });
assert.equal(benchmark.development.sessions, 2, "two sessions per name fall in the development window");
near(benchmark.development.meanDailyPct, 1, 1e-9, "development mean daily return");
near(benchmark.development.compoundedPctPerName, 2.01, 0.01, "two 1% sessions compound to 2.01%");
assert.ok(benchmark.validation.meanDailyPct < 0, "the validation window carries the negative session");

// --- conditioner stability ---------------------------------------------------
// A feature that ranks correctly in every split is stable; one that ranks
// correctly only in development is fitted. The second case is the one that has
// to be caught, because it is the one that looks best in a backtest.
const stable = [];
const fitted = [];
for (const split of ["development", "validation", "finalTest"]) {
  const flip = split === "development" ? 1 : -1;
  for (let index = 0; index < 500; index += 1) {
    const feature = index / 500;
    stable.push({ split, feature, value: feature - 0.5, cluster: `W${index % 25}` });
    fitted.push({ split, feature, value: flip * (feature - 0.5), cluster: `W${index % 25}` });
  }
}
const stableProfile = quintileProfile(stable, "feature", { valueKey: "value", clusterKey: "cluster" });
assert.equal(stableProfile.signStable, true, "a genuinely monotone conditioner keeps its sign out of sample");
assert.ok(stableProfile.development.spread > 0 && stableProfile.validation.spread > 0);
assert.equal(stableProfile.development.bandMeans.length, 5);
const fittedProfile = quintileProfile(fitted, "feature", { valueKey: "value", clusterKey: "cluster" });
assert.equal(fittedProfile.signStable, false, "a conditioner whose spread flips sign out of sample is fitted, not discovered");
assert.ok(fittedProfile.development.spread > 0 && fittedProfile.validation.spread < 0);
assert.ok(stableProfile.development.spreadTStat > 1, "a real spread is large relative to its own sampling error");

// Agreeing on a sign is not stability. This conditioner ranks the same way in
// every split and every spread is a rounding error against the noise around it;
// reporting it as stable is how a backtest talks itself into a dead feature.
const noisy = [];
let seed = 7;
const nextNoise = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return (seed / 2147483648 - 0.5) * 20; };
for (const split of ["development", "validation", "finalTest"]) {
  for (let index = 0; index < 900; index += 1) {
    noisy.push({ split, feature: index / 900, value: (index / 900) * 0.01 + nextNoise(), cluster: `W${index % 30}` });
  }
}
const noisyProfile = quintileProfile(noisy, "feature", { valueKey: "value", clusterKey: "cluster" });
assert.ok(Math.abs(noisyProfile.development.spreadTStat) < 1, "the planted spread is smaller than its own sampling error");
assert.equal(noisyProfile.signStable, false, "a spread below its own standard error is never stability, whatever its sign");

// --- panel verdict ------------------------------------------------------------
const losing = panelVerdict(
  { development: { meanPct: 0.28, tStat: 2.18, n: 12296 }, validation: { meanPct: -0.1416, tStat: -0.63, n: 4129 } },
  { trials: 35, minimumFills: 100 }
);
assert.equal(losing.edgeConfirmed, false);
assert.equal(losing.verdict, "NO_CONFIRMED_EDGE");
assert.ok(losing.validationDeflatedTStat < 0, "a negative validation mean can never be deflated into an edge");
assert.ok(losing.developmentMeanPct > 0, "a positive development mean is reported and still does not confirm anything");

const winning = panelVerdict(
  { development: { meanPct: 0.30, tStat: 3.0, n: 9000 }, validation: { meanPct: 0.22, tStat: 3.4, n: 3000 } },
  { trials: 35, minimumFills: 100 }
);
assert.equal(winning.edgeConfirmed, true);
assert.equal(winning.verdict, "EDGE_SURVIVES_VALIDATION");
assert.ok(winning.validationDeflatedTStat > 0);

const thin = panelVerdict(
  { development: { meanPct: 0.30, tStat: 3.0, n: 9000 }, validation: { meanPct: 0.9, tStat: 4.0, n: 44 } },
  { trials: 35, minimumFills: 100 }
);
assert.equal(thin.edgeConfirmed, false, "a large mean on 44 fills is not an edge regardless of its t-statistic");

console.log("Panel tests passed: normal quantiles, search-adjusted hurdle, purged calendar splits, cluster-robust errors, buy-and-hold control and conditioner sign stability");
