"use strict";

/**
 * Covariance, correlation and portfolio risk.
 *
 * This is the object the desk has never had. Without it there is no beta, no
 * factor model, no correlation-aware sizing, and no way to answer the first
 * question any risk officer asks: are these thirty-one positions thirty-one
 * bets, or one bet held thirty-one times?
 *
 * THE ESTIMATION PROBLEM. With N names and T observations the sample covariance
 * matrix has N(N+1)/2 free parameters. At N = 210 that is 22,155 numbers
 * estimated from roughly 1,250 daily observations each. The sample estimate is
 * therefore extremely noisy, and when N approaches or exceeds T it is singular
 * and cannot be inverted at all. Optimising directly on it produces the
 * well-documented failure where the optimiser loads onto whichever pair of
 * assets happened to look most negatively correlated by accident.
 *
 * THE FIX. Ledoit and Wolf (2004), "Honey, I Shrunk the Sample Covariance
 * Matrix": pull the noisy sample estimate toward a structured target,
 *
 *     Sigma = delta * F + (1 - delta) * S
 *
 * with F the constant-correlation model (every pair given the average sample
 * correlation, individual variances kept) and delta chosen ANALYTICALLY to
 * minimise expected quadratic loss. delta is not a tuning knob: it is computed
 * from the data, and it rises automatically when the sample is short or the
 * cross-section is wide, which is exactly when the sample estimate deserves
 * less trust.
 */

const round = (value, digits = 6) => {
  const factor = 10 ** digits;
  return Number.isFinite(Number(value)) ? Math.round(Number(value) * factor) / factor : null;
};

/**
 * Align per-symbol bar series onto the sessions they all share, and return log
 * returns. Overlapping dates only: a covariance computed across mismatched
 * calendars measures the calendar, not the assets.
 */
function alignedLogReturns(seriesBySymbol, { minSessions = 120 } = {}) {
  const symbols = Object.keys(seriesBySymbol).filter((symbol) => Array.isArray(seriesBySymbol[symbol]) && seriesBySymbol[symbol].length > 1);
  if (symbols.length < 2) return { symbols: [], sessions: [], returns: [] };

  const byDate = new Map();
  for (const symbol of symbols) {
    for (const bar of seriesBySymbol[symbol]) {
      const session = String(bar.session ?? bar.date ?? "");
      const close = Number(bar.close ?? bar.c);
      if (!session || !(close > 0)) continue;
      if (!byDate.has(session)) byDate.set(session, new Map());
      byDate.get(session).set(symbol, close);
    }
  }
  // Keep only sessions where every symbol printed a price.
  const sessions = [...byDate.keys()]
    .filter((session) => byDate.get(session).size === symbols.length)
    .sort();
  if (sessions.length <= minSessions) return { symbols, sessions, returns: [], insufficient: true };

  const returns = [];
  for (let t = 1; t < sessions.length; t += 1) {
    const previous = byDate.get(sessions[t - 1]);
    const current = byDate.get(sessions[t]);
    const row = new Array(symbols.length);
    let usable = true;
    for (let i = 0; i < symbols.length; i += 1) {
      const a = previous.get(symbols[i]);
      const b = current.get(symbols[i]);
      if (!(a > 0) || !(b > 0)) { usable = false; break; }
      row[i] = Math.log(b / a);
    }
    if (usable) returns.push(row);
  }
  return { symbols, sessions: sessions.slice(1), returns };
}

/**
 * Ledoit-Wolf linear shrinkage toward the constant-correlation target.
 * Returns the shrunk covariance, the correlation implied by it, and the
 * shrinkage intensity actually chosen.
 */
function shrinkageCovariance(returns, symbols) {
  const T = returns.length;
  const N = symbols.length;
  if (T < 2 || N < 2) return null;

  // Demean each column.
  const means = new Array(N).fill(0);
  for (const row of returns) for (let i = 0; i < N; i += 1) means[i] += row[i];
  for (let i = 0; i < N; i += 1) means[i] /= T;
  const x = returns.map((row) => row.map((value, i) => value - means[i]));

  // Sample covariance, 1/T convention to match the Ledoit-Wolf derivation.
  const S = Array.from({ length: N }, () => new Array(N).fill(0));
  for (const row of x) {
    for (let i = 0; i < N; i += 1) {
      const xi = row[i];
      for (let j = i; j < N; j += 1) {
        S[i][j] += xi * row[j];
      }
    }
  }
  for (let i = 0; i < N; i += 1) {
    for (let j = i; j < N; j += 1) {
      S[i][j] /= T;
      S[j][i] = S[i][j];
    }
  }

  const sd = new Array(N);
  for (let i = 0; i < N; i += 1) sd[i] = Math.sqrt(Math.max(1e-16, S[i][i]));

  // Average pairwise correlation -> the constant-correlation target F.
  let sumCorrelation = 0;
  let pairs = 0;
  for (let i = 0; i < N; i += 1) {
    for (let j = i + 1; j < N; j += 1) {
      sumCorrelation += S[i][j] / (sd[i] * sd[j]);
      pairs += 1;
    }
  }
  const rBar = pairs ? sumCorrelation / pairs : 0;

  const F = Array.from({ length: N }, () => new Array(N).fill(0));
  for (let i = 0; i < N; i += 1) {
    F[i][i] = S[i][i];
    for (let j = i + 1; j < N; j += 1) {
      F[i][j] = rBar * sd[i] * sd[j];
      F[j][i] = F[i][j];
    }
  }

  // pi: summed asymptotic variance of the sample covariance entries.
  const piMatrix = Array.from({ length: N }, () => new Array(N).fill(0));
  for (const row of x) {
    for (let i = 0; i < N; i += 1) {
      const xi = row[i];
      for (let j = i; j < N; j += 1) {
        const d = xi * row[j] - S[i][j];
        piMatrix[i][j] += d * d;
      }
    }
  }
  let piHat = 0;
  for (let i = 0; i < N; i += 1) {
    for (let j = i; j < N; j += 1) {
      piMatrix[i][j] /= T;
      piMatrix[j][i] = piMatrix[i][j];
      piHat += i === j ? piMatrix[i][j] : 2 * piMatrix[i][j];
    }
  }

  // rho: covariance between the target's estimation error and the sample's.
  // theta[i][j] = (1/T) * sum_t (x_it^2 - S_ii)(x_it x_jt - S_ij)
  const theta = Array.from({ length: N }, () => new Array(N).fill(0));
  for (const row of x) {
    for (let i = 0; i < N; i += 1) {
      const vi = row[i] * row[i] - S[i][i];
      for (let j = 0; j < N; j += 1) {
        theta[i][j] += vi * (row[i] * row[j] - S[i][j]);
      }
    }
  }
  for (let i = 0; i < N; i += 1) for (let j = 0; j < N; j += 1) theta[i][j] /= T;

  let rhoHat = 0;
  for (let i = 0; i < N; i += 1) rhoHat += piMatrix[i][i];
  for (let i = 0; i < N; i += 1) {
    for (let j = 0; j < N; j += 1) {
      if (i === j) continue;
      rhoHat += (rBar / 2) * ((sd[j] / sd[i]) * theta[i][j] + (sd[i] / sd[j]) * theta[j][i]);
    }
  }

  // gamma: how wrong the target is, in Frobenius norm.
  let gammaHat = 0;
  for (let i = 0; i < N; i += 1) {
    for (let j = 0; j < N; j += 1) {
      const d = F[i][j] - S[i][j];
      gammaHat += d * d;
    }
  }

  // The optimal intensity. Nothing here is chosen by hand.
  const kappa = gammaHat > 0 ? (piHat - rhoHat) / gammaHat : 0;
  const delta = Math.max(0, Math.min(1, kappa / T));

  const sigma = Array.from({ length: N }, () => new Array(N).fill(0));
  for (let i = 0; i < N; i += 1) {
    for (let j = 0; j < N; j += 1) {
      sigma[i][j] = delta * F[i][j] + (1 - delta) * S[i][j];
    }
  }

  return {
    symbols,
    observations: T,
    dimension: N,
    shrinkage: round(delta, 6),
    averageCorrelation: round(rBar, 6),
    covariance: sigma,
    sampleCovariance: S,
    standardDeviations: sd,
    // A sample estimate needs roughly N observations per name to be usable at
    // all; below that it is singular and shrinkage is doing the real work.
    sampleIsRankDeficient: T < N
  };
}

/** Correlation matrix implied by a covariance matrix. */
function correlationFrom(covariance) {
  const N = covariance.length;
  const sd = covariance.map((row, i) => Math.sqrt(Math.max(1e-16, row[i])));
  return covariance.map((row, i) => row.map((value, j) => value / (sd[i] * sd[j])));
}

/** Portfolio variance w' Sigma w, and the annualised volatility it implies. */
function portfolioRisk(covariance, weights, { periodsPerYear = 252 } = {}) {
  const N = covariance.length;
  if (!Array.isArray(weights) || weights.length !== N) return null;
  let variance = 0;
  for (let i = 0; i < N; i += 1) {
    for (let j = 0; j < N; j += 1) variance += weights[i] * covariance[i][j] * weights[j];
  }
  variance = Math.max(0, variance);
  const daily = Math.sqrt(variance);

  // Marginal contribution to risk: d(sigma_p)/d(w_i) * w_i. These sum to the
  // portfolio volatility and say which position is actually carrying the risk,
  // which is rarely the largest position.
  const contributions = new Array(N).fill(0);
  if (daily > 0) {
    for (let i = 0; i < N; i += 1) {
      let row = 0;
      for (let j = 0; j < N; j += 1) row += covariance[i][j] * weights[j];
      contributions[i] = weights[i] * row / daily;
    }
  }

  // The diversification ratio: weighted average volatility over portfolio
  // volatility. 1.0 means the positions are one bet.
  let weightedVol = 0;
  for (let i = 0; i < N; i += 1) weightedVol += Math.abs(weights[i]) * Math.sqrt(Math.max(0, covariance[i][i]));
  const diversificationRatio = daily > 0 ? weightedVol / daily : null;

  // Concentration of risk CONTRIBUTIONS. Useful, but it is not a count of
  // independent bets: five perfectly correlated assets held equally produce five
  // equal contributions and this index reads 5, when the honest answer is 1.
  const totalContribution = contributions.reduce((sum, value) => sum + Math.abs(value), 0);
  let herfindahl = 0;
  if (totalContribution > 0) {
    for (const contribution of contributions) {
      const share = Math.abs(contribution) / totalContribution;
      herfindahl += share * share;
    }
  }

  return {
    dailyVolatility: round(daily, 8),
    annualisedVolatilityPct: round(daily * Math.sqrt(periodsPerYear) * 100, 4),
    variance: round(variance, 12),
    riskContributions: contributions.map((value) => round(value, 8)),
    diversificationRatio: round(diversificationRatio, 4),
    contributionConcentration: herfindahl > 0 ? round(1 / herfindahl, 3) : null,
    effectiveNumberOfBets: effectiveNumberOfBets(covariance, weights)
  };
}

/**
 * Effective number of bets (Meucci).
 *
 * Rotate the portfolio onto the uncorrelated principal portfolios of the
 * covariance matrix, take each one's share of total portfolio variance, and
 * report the exponential of the entropy of those shares. Because the principal
 * portfolios are uncorrelated by construction, this counts INDEPENDENT sources
 * of risk rather than line items:
 *
 *   - perfectly correlated holdings collapse onto one component and return 1,
 *     however many tickers are held;
 *   - N independent equal-weighted holdings spread evenly and return N.
 *
 * A book of thirty-one names returning an effective count near one is a single
 * position wearing thirty-one labels, which is the thing a risk report exists
 * to catch.
 */
function effectiveNumberOfBets(covariance, weights) {
  const N = covariance.length;
  if (!Array.isArray(weights) || weights.length !== N) return null;
  const { components } = principalComponents(covariance, N, { iterations: 200, tolerance: 1e-12 });
  const shares = [];
  let total = 0;
  for (const component of components) {
    if (!(component.eigenvalue > 1e-18)) continue;
    let projection = 0;
    for (let i = 0; i < N; i += 1) projection += component.loadings[i] * weights[i];
    const variance = component.eigenvalue * projection * projection;
    if (variance > 0) { shares.push(variance); total += variance; }
  }
  if (!(total > 0) || !shares.length) return null;
  let entropy = 0;
  for (const share of shares) {
    const p = share / total;
    if (p > 0) entropy -= p * Math.log(p);
  }
  return round(Math.exp(entropy), 3);
}

/**
 * Beta of each name against a chosen column (the market proxy), from the
 * covariance matrix itself. This is CAPM's beta, and it is the first thing the
 * desk gains from having a covariance matrix at all.
 */
function betasAgainst(covariance, symbols, marketSymbol) {
  const index = symbols.indexOf(marketSymbol);
  if (index < 0) return null;
  const marketVariance = covariance[index][index];
  if (!(marketVariance > 0)) return null;
  const betas = {};
  for (let i = 0; i < symbols.length; i += 1) {
    betas[symbols[i]] = round(covariance[i][index] / marketVariance, 6);
  }
  return { marketSymbol, marketVariance: round(marketVariance, 12), betas };
}

/**
 * Leading principal components by power iteration with deflation.
 *
 * The first component of an equity covariance matrix is almost always "the
 * market": if it explains most of the variance, then a book of many names is
 * economically one position, however many tickers it holds.
 */
function principalComponents(covariance, count = 3, { iterations = 300, tolerance = 1e-10 } = {}) {
  const N = covariance.length;
  const working = covariance.map((row) => [...row]);
  let totalVariance = 0;
  for (let i = 0; i < N; i += 1) totalVariance += covariance[i][i];
  const components = [];

  for (let c = 0; c < Math.min(count, N); c += 1) {
    // The start vector must NOT be uniform. On a degenerate spectrum -- an
    // identity-scaled covariance, where every direction is an eigenvector with
    // the same eigenvalue -- a uniform start converges immediately to itself,
    // deflation removes exactly that direction, and the next iteration begins
    // inside the null space and returns nothing. The effect was that sixteen
    // independent assets reported ONE component instead of sixteen. A
    // deterministic varied start, different for each component, breaks the tie
    // without introducing randomness into a reproducible computation.
    let state = (c + 1) * 0x9E3779B1;
    let vector = new Array(N);
    let seedNorm = 0;
    for (let i = 0; i < N; i += 1) {
      state = (state + 0x6D2B79F5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      vector[i] = (((t ^ (t >>> 14)) >>> 0) / 4294967296) - 0.5;
      seedNorm += vector[i] * vector[i];
    }
    seedNorm = Math.sqrt(seedNorm) || 1;
    for (let i = 0; i < N; i += 1) vector[i] /= seedNorm;
    let eigenvalue = 0;
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const next = new Array(N).fill(0);
      for (let i = 0; i < N; i += 1) {
        let sum = 0;
        for (let j = 0; j < N; j += 1) sum += working[i][j] * vector[j];
        next[i] = sum;
      }
      const norm = Math.sqrt(next.reduce((sum, value) => sum + value * value, 0));
      if (!(norm > 0)) break;
      for (let i = 0; i < N; i += 1) next[i] /= norm;
      let shift = 0;
      for (let i = 0; i < N; i += 1) shift += Math.abs(next[i] - vector[i]);
      vector = next;
      eigenvalue = norm;
      if (shift < tolerance) break;
    }
    components.push({
      index: c,
      eigenvalue: round(eigenvalue, 12),
      varianceSharePct: totalVariance > 0 ? round(eigenvalue / totalVariance * 100, 3) : null,
      loadings: vector.map((value) => round(value, 6))
    });
    // Deflate so the next iteration finds the next component.
    for (let i = 0; i < N; i += 1) {
      for (let j = 0; j < N; j += 1) working[i][j] -= eigenvalue * vector[i] * vector[j];
    }
  }
  return { totalVariance: round(totalVariance, 12), components };
}

/** Build everything from raw series in one call. */
function buildRiskModel(seriesBySymbol, options = {}) {
  const aligned = alignedLogReturns(seriesBySymbol, options);
  if (!aligned.returns.length) {
    return { available: false, reason: aligned.insufficient ? "TOO_FEW_SHARED_SESSIONS" : "NO_ALIGNED_RETURNS", symbols: aligned.symbols };
  }
  const estimate = shrinkageCovariance(aligned.returns, aligned.symbols);
  if (!estimate) return { available: false, reason: "ESTIMATION_FAILED", symbols: aligned.symbols };
  return {
    available: true,
    method: "LEDOIT_WOLF_LINEAR_SHRINKAGE_CONSTANT_CORRELATION_TARGET",
    firstSession: aligned.sessions[0],
    lastSession: aligned.sessions.at(-1),
    ...estimate
  };
}

module.exports = {
  alignedLogReturns,
  effectiveNumberOfBets,
  betasAgainst,
  buildRiskModel,
  correlationFrom,
  portfolioRisk,
  principalComponents,
  shrinkageCovariance
};
