"use strict";

/**
 * Pooled cross-sectional (panel) evaluation.
 *
 * `weekly-cycle.js` judges one symbol at a time. That is the right unit for a
 * trading decision and the wrong unit for deciding whether the rule works at
 * all: running a 5-rung, 2-sided selection over hundreds of names generates
 * hundreds of independent chances to pass a t-test on noise, and a per-symbol
 * verdict can never see that. This module supplies the three controls that
 * absence makes impossible:
 *
 *   1. calendar-time splits shared by every name, so a pooled panel is cut on
 *      dates rather than on each name's own count of resolved labels;
 *   2. an equal-weighted buy-and-hold benchmark over the identical universe and
 *      identical splits, so a rising market is never mistaken for edge;
 *   3. a selection hurdle that accounts for the number of configurations tried
 *      (Bailey and Lopez de Prado, expected maximum of N draws), so the best
 *      cell of a grid is not read as if it were the only cell tested.
 *
 * Nothing here places or filters an order. It is measurement only.
 */

const EULER_MASCHERONI = 0.5772156649015329;

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Number.isFinite(Number(value)) ? Math.round(Number(value) * factor) / factor : null;
}

function mean(values) {
  const finite = values.map(Number).filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : 0;
}

/** Complementary error function, Numerical Recipes Chebyshev fit (absolute error below 1.2e-7). */
function erfc(x) {
  const z = Math.abs(x);
  const t = 2 / (2 + z);
  const y = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418
    + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587
    + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? y : 2 - y;
}

function normalCdf(x) {
  return 1 - 0.5 * erfc(x / Math.SQRT2);
}

/** Two-sided p-value for a t-statistic, read against the normal limit. */
function twoSidedPValue(tStat) {
  return Number.isFinite(Number(tStat)) ? round(erfc(Math.abs(Number(tStat)) / Math.SQRT2), 6) : null;
}

/** Inverse standard normal CDF, Acklam rational approximation (absolute error below 1.2e-9). */
function normalQuantile(p) {
  if (!(p > 0 && p < 1)) return null;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const low = 0.02425;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - low) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * Expected maximum of `trials` independent standard-normal draws.
 *
 * This is the t-statistic a strategy reaches by luck alone once you have tried
 * `trials` configurations and kept the best. Bailey and Lopez de Prado (2014),
 * "The Deflated Sharpe Ratio".
 *
 * sqrt(2*ln N) is only this expression's asymptotic leading term and sits above
 * it at every practical N (at N = 6: 1.8930 against 1.3001), so a hurdle built
 * from it is conservative, not lax. What matters is not the formula but the N
 * fed to it. A per-symbol gate that counts 5 rungs plus one as its trials is
 * scoring a 6-trial search; running that same gate across a 97-name, 2-sided
 * universe is a 194-trial search, where the bar is 2.7556 rather than 1.3001.
 * Counting only the trials one function can see is what lets a universe-wide
 * sweep pass on noise while every individual test looks disciplined.
 */
function expectedMaxTStat(trials) {
  const count = Math.max(1, Math.floor(Number(trials) || 1));
  if (count === 1) return 0;
  const first = normalQuantile(1 - 1 / count);
  const second = normalQuantile(1 - 1 / (count * Math.E));
  if (first === null || second === null) return round(Math.sqrt(2 * Math.log(count)), 4);
  return round((1 - EULER_MASCHERONI) * first + EULER_MASCHERONI * second, 4);
}

/**
 * How far the observed t-statistic clears the bar that pure selection would
 * have cleared. Positive means the result survives the search that produced it.
 */
function deflatedTStat(observedTStat, trials) {
  // Number(null) is 0, so an absent t-statistic would otherwise deflate to a
  // large negative number and read as a measured result. clusterRobustMean
  // returns null whenever a sample holds fewer than two clusters, so this path
  // is reached in normal use and must stay unmeasured rather than become data.
  if (observedTStat === null || observedTStat === undefined || observedTStat === "") return null;
  const observed = Number(observedTStat);
  return Number.isFinite(observed) ? round(observed - expectedMaxTStat(trials), 4) : null;
}

/**
 * Calendar-time split boundaries shared by every name in the panel.
 * Cutting on dates keeps one symbol's label density from moving another
 * symbol's test window.
 */
function calendarSplitBoundaries(weekKeys, options = {}) {
  const ordered = [...new Set((Array.isArray(weekKeys) ? weekKeys : []).filter(Boolean))].sort();
  if (ordered.length < 3) return null;
  const developmentRatio = Number(options.developmentRatio ?? 0.60);
  const validationRatio = Number(options.validationRatio ?? 0.20);
  const developmentEnd = Math.max(1, Math.floor(ordered.length * developmentRatio));
  const validationEnd = Math.max(developmentEnd + 1, Math.floor(ordered.length * (developmentRatio + validationRatio)));
  return {
    firstWeek: ordered[0],
    validationFrom: ordered[Math.min(developmentEnd, ordered.length - 1)],
    finalTestFrom: ordered[Math.min(validationEnd, ordered.length - 1)],
    lastWeek: ordered.at(-1),
    weeks: ordered.length
  };
}

/**
 * Purged split assignment. A label belongs to a split only when it both opens
 * and closes inside it; one that straddles a boundary is dropped rather than
 * leaked, because its outcome is partly determined by the later window.
 */
function assignSplit(label, bounds) {
  if (!bounds || !label) return null;
  const opened = String(label.weekKey ?? "");
  const closed = String(label.exitSession ?? opened);
  if (!opened) return null;
  if (opened < bounds.validationFrom) return closed < bounds.validationFrom ? "development" : null;
  if (opened < bounds.finalTestFrom) return closed < bounds.finalTestFrom ? "validation" : null;
  return "finalTest";
}

/**
 * Cluster-robust (sandwich) standard error of a pooled mean.
 *
 * Every name laddering in the same calendar week shares that week's market
 * shock, so fills are not independent across the cross-section. Clustering on
 * the entry week is what keeps a panel of 12,000 correlated fills from
 * reporting the standard error of 12,000 independent ones.
 */
function clusterRobustMean(observations) {
  const rows = (Array.isArray(observations) ? observations : [])
    .map((row) => ({ value: Number(row?.value), cluster: String(row?.cluster ?? "") }))
    .filter((row) => Number.isFinite(row.value) && row.cluster);
  if (rows.length < 2) {
    return { n: rows.length, meanPct: rows.length ? round(rows[0].value, 4) : null, standardErrorPct: null, tStat: null, pValue: null, clusters: rows.length };
  }
  const average = mean(rows.map((row) => row.value));
  const residualByCluster = new Map();
  for (const row of rows) residualByCluster.set(row.cluster, Number(residualByCluster.get(row.cluster) || 0) + row.value - average);
  const groups = [...residualByCluster.values()];
  if (groups.length < 2) {
    return { n: rows.length, meanPct: round(average, 4), standardErrorPct: null, tStat: null, pValue: null, clusters: groups.length };
  }
  const meat = groups.reduce((sum, residualSum) => sum + residualSum ** 2, 0);
  const variance = (groups.length / (groups.length - 1)) * meat / rows.length ** 2;
  const standardError = Math.sqrt(Math.max(0, variance));
  const tStat = standardError > 0 ? average / standardError : null;
  return {
    n: rows.length,
    meanPct: round(average, 4),
    standardErrorPct: round(standardError, 5),
    tStat: round(tStat, 3),
    pValue: twoSidedPValue(tStat),
    clusters: groups.length
  };
}

/**
 * Equal-weighted buy-and-hold of the identical universe over the identical
 * splits. Without this control a rule measured only in a rising market reports
 * the market's drift as its own edge.
 *
 * Each name is compounded on its own and the terminal returns are then averaged
 * across names. Compounding a pooled arithmetic mean instead would not be a
 * return anybody could have earned: by the AM-GM inequality it drifts away from
 * the realised figure by roughly half the variance per period, in either
 * direction once cross-sectional dispersion is present. `meanDailyPct` is kept
 * alongside because it is the right scale for comparing against a per-fill
 * number, but it is explicitly not the holding return.
 */
function benchmarkBySplit(dailyReturns, bounds) {
  const splits = ["development", "validation", "finalTest"];
  const pooled = { development: [], validation: [], finalTest: [] };
  const wealth = { development: new Map(), validation: new Map(), finalTest: new Map() };
  for (const row of Array.isArray(dailyReturns) ? dailyReturns : []) {
    const value = Number(row?.returnPct);
    const session = String(row?.session ?? "");
    if (!Number.isFinite(value) || !session || !bounds) continue;
    const split = session < bounds.validationFrom ? "development" : session < bounds.finalTestFrom ? "validation" : "finalTest";
    pooled[split].push(value);
    const symbol = String(row?.symbol ?? "__POOLED__");
    const held = wealth[split].get(symbol) || { product: 1, sessions: 0 };
    held.product *= 1 + value / 100;
    held.sessions += 1;
    wealth[split].set(symbol, held);
  }
  const summary = {};
  for (const split of splits) {
    const names = [...wealth[split].values()].filter((held) => held.sessions > 0);
    const compounded = names.map((held) => (held.product - 1) * 100);
    summary[split] = {
      sessions: names.length ? Math.round(mean(names.map((held) => held.sessions))) : 0,
      symbols: names.length,
      meanDailyPct: round(mean(pooled[split]), 4),
      compoundedPctPerName: compounded.length ? round(mean(compounded), 2) : null,
      medianCompoundedPctPerName: compounded.length
        ? round([...compounded].sort((a, b) => a - b)[Math.floor(compounded.length / 2)], 2)
        : null
    };
  }
  return summary;
}

/**
 * Quintile profile of a conditioner, split by split.
 *
 * A conditioner that only ranks correctly in development has been fitted, not
 * discovered. `signStable` is the whole point of the function: it asks whether
 * the top-minus-bottom spread keeps its sign once the data is unseen.
 */
function quintileProfile(rows, featureKey, options = {}) {
  const valueKey = options.valueKey || "value";
  const clusterKey = options.clusterKey || "cluster";
  const splitKey = options.splitKey || "split";
  const bands = Math.max(2, Number(options.bands) || 5);
  const profile = { feature: featureKey };
  for (const split of ["development", "validation", "finalTest"]) {
    const usable = (Array.isArray(rows) ? rows : [])
      .filter((row) => row?.[splitKey] === split && Number.isFinite(Number(row?.[featureKey])) && Number.isFinite(Number(row?.[valueKey])))
      .sort((a, b) => Number(a[featureKey]) - Number(b[featureKey]));
    if (usable.length < bands * 2) { profile[split] = null; continue; }
    const width = Math.floor(usable.length / bands);
    const bandMeans = [];
    for (let index = 0; index < bands; index += 1) {
      const slice = usable.slice(index * width, index === bands - 1 ? usable.length : (index + 1) * width);
      bandMeans.push(round(mean(slice.map((row) => Number(row[valueKey]))), 4));
    }
    const toObservations = (slice) => slice.map((row) => ({ value: Number(row[valueKey]), cluster: row[clusterKey] }));
    const top = clusterRobustMean(toObservations(usable.slice((bands - 1) * width)));
    const bottom = clusterRobustMean(toObservations(usable.slice(0, width)));
    const spread = bandMeans.at(-1) - bandMeans[0];
    // Standard error of the top-minus-bottom difference. The two bands hold
    // disjoint fills, so their cluster-robust errors add in quadrature.
    const spreadError = Number.isFinite(Number(top.standardErrorPct)) && Number.isFinite(Number(bottom.standardErrorPct))
      ? Math.sqrt(Number(top.standardErrorPct) ** 2 + Number(bottom.standardErrorPct) ** 2)
      : null;
    profile[split] = {
      n: usable.length,
      bandMeans,
      spread: round(spread, 4),
      spreadErrorPct: round(spreadError, 5),
      spreadTStat: spreadError > 0 ? round(spread / spreadError, 3) : null,
      top,
      bottom
    };
  }
  const measured = ["development", "validation", "finalTest"].map((split) => profile[split]).filter((row) => row && Number.isFinite(row.spread));
  // Agreeing on a sign is not stability: three spreads of -0.02, -0.20 and
  // -0.01 share a sign and say nothing. A conditioner counts as stable only
  // when every window it was measured in ranks the same way AND each window's
  // spread is larger than that window's own sampling error.
  profile.signStable = measured.length >= 2
    && (measured.every((row) => row.spread > 0) || measured.every((row) => row.spread < 0))
    && measured.every((row) => Number.isFinite(row.spreadTStat) && Math.abs(row.spreadTStat) >= 1);
  return profile;
}

/**
 * Panel verdict. Development is where a rule is allowed to look good;
 * validation is where it has to stay good. `edgeConfirmed` requires a positive,
 * search-adjusted validation mean, and says so about validation alone: the
 * final-test figures travel with the report strictly for later inspection.
 */
function panelVerdict(bySplit, options = {}) {
  const trials = Math.max(1, Number(options.trials) || 1);
  const hurdle = expectedMaxTStat(trials);
  const validation = bySplit?.validation || null;
  const development = bySplit?.development || null;
  const edgeConfirmed = Boolean(
    validation && Number(validation.n) >= (Number(options.minimumFills) || 100)
    && Number(validation.meanPct) > 0
    && Number(validation.tStat) >= hurdle
  );
  return {
    trialsConsidered: trials,
    selectionHurdleTStat: hurdle,
    // Asymptotic form reported alongside for comparison; it exceeds the exact
    // expected maximum at every practical N, so it errs strict.
    naiveHurdleTStat: round(Math.sqrt(2 * Math.log(Math.max(2, trials))), 4),
    developmentMeanPct: development ? development.meanPct : null,
    validationMeanPct: validation ? validation.meanPct : null,
    validationTStat: validation ? validation.tStat : null,
    validationDeflatedTStat: validation ? deflatedTStat(validation.tStat, trials) : null,
    edgeConfirmed,
    verdict: edgeConfirmed ? "EDGE_SURVIVES_VALIDATION" : "NO_CONFIRMED_EDGE",
    benchmark: options.benchmark || null,
    // A rule can only be credited with alpha against what holding the same
    // universe over the same window would have paid on its own.
    note: "development statistics are selection-contaminated by construction and never establish an edge"
  };
}

module.exports = {
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
};
