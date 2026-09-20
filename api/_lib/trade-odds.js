"use strict";

/**
 * The two numbers a derivatives desk looks at before anything else.
 *
 * A card that says BUY, gives a price, and gives an exit still has not answered
 * the only questions that decide whether the trade is worth taking:
 *
 *   1. What are the odds? -- the probability the position finishes in profit.
 *   2. Is the option CHEAP OR EXPENSIVE? -- what you pay for volatility against
 *      how much the stock has actually been moving.
 *
 * The second is the one retail almost never sees and the one that most reliably
 * decides the outcome. An option's price is, in the end, a price for future
 * movement. If a stock has been moving at 24% annualised and the option is
 * priced at 32%, then every buyer is paying for a third more movement than the
 * stock has been delivering, and no amount of being right about DIRECTION fixes
 * paying the wrong price for VOLATILITY. That gap is the variance risk premium,
 * it is usually positive, and it is the documented reason option buyers lose on
 * average while sellers win on average.
 *
 * This does NOT predict direction. It cannot, and nothing in this repository
 * has ever demonstrated that it can -- the out-of-sample test failed. What it
 * does is price the bet honestly: given no view at all, here are the odds, and
 * here is whether you are paying over the odds to take them.
 *
 * Every number comes from measured data: real bars for realized volatility,
 * the traded premium for implied. Nothing is assumed.
 */

const TRADING_DAYS = 252;

const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;

function stdev(values) {
  if (values.length < 2) return null;
  const m = mean(values);
  return Math.sqrt(values.reduce((a, v) => a + (v - m) ** 2, 0) / (values.length - 1));
}

/** Standard normal CDF (Abramowitz & Stegun 26.2.17, |error| < 7.5e-8). */
function normalCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const pdf = Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
  const tail = pdf * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - tail : tail;
}

/**
 * Close-to-close realized volatility, annualised.
 */
function closeToCloseVol(bars, window) {
  const closes = bars.map((b) => Number(b.close)).filter((c) => Number.isFinite(c) && c > 0);
  if (closes.length < 3) return null;
  const returns = [];
  for (let i = 1; i < closes.length; i += 1) returns.push(Math.log(closes[i] / closes[i - 1]));
  const sample = window ? returns.slice(-window) : returns;
  if (sample.length < 2) return null;
  const sd = stdev(sample);
  return sd === null ? null : sd * Math.sqrt(TRADING_DAYS);
}

/**
 * Parkinson's high-low estimator. Roughly five times more efficient than
 * close-to-close for the same number of bars, because a day's range carries
 * more information about movement than its two endpoints do -- a stock that
 * travels widely and closes flat shows nothing in a close-to-close series.
 */
function parkinsonVol(bars, window) {
  const sample = (window ? bars.slice(-window) : bars)
    .map((b) => ({ high: Number(b.high), low: Number(b.low) }))
    .filter((b) => Number.isFinite(b.high) && Number.isFinite(b.low) && b.low > 0 && b.high >= b.low);
  if (sample.length < 3) return null;
  const squares = sample.map((b) => Math.log(b.high / b.low) ** 2);
  return Math.sqrt(mean(squares) / (4 * Math.log(2))) * Math.sqrt(TRADING_DAYS);
}

/**
 * Yang-Zhang realized volatility: the estimator that counts the overnight gap.
 *
 * Parkinson uses only the intraday high-low range, so it is blind to the move
 * between yesterday's close and today's open -- and on Indian equities that gap
 * is a large part of the actual movement. Measured across all 210 symbols on a
 * 20-day window, Parkinson came in BELOW Yang-Zhang on 184 of them (88%), by a
 * median of 8.8% of the true figure.
 *
 * That bias is not harmless here, because this desk divides implied by realized
 * to decide cheap against expensive. Understating the denominator by 8.8%
 * inflates every ratio by about 9.6% and tilts the whole universe toward
 * EXPENSIVE. An estimator's error becomes a verdict's error.
 *
 * Yang-Zhang sums three pieces -- overnight, open-to-close, and Rogers-Satchell
 * for the intraday range -- which makes it both gap-aware and independent of
 * drift, unlike close-to-close which a trending stock inflates.
 *
 *   sigma^2 = V_overnight + k*V_open_close + (1-k)*V_rogers_satchell
 *   k = 0.34 / (1.34 + (n+1)/(n-1))
 */
function yangZhangVol(bars, window) {
  const sample = (window ? bars.slice(-(window + 1)) : bars)
    .map((b) => ({ open: Number(b.open), high: Number(b.high), low: Number(b.low), close: Number(b.close) }))
    .filter((b) => [b.open, b.high, b.low, b.close].every((v) => Number.isFinite(v) && v > 0));
  const n = sample.length - 1;
  if (n < 3) return null;

  const overnight = [];
  const openClose = [];
  const rogersSatchell = [];
  for (let i = 1; i < sample.length; i += 1) {
    const prev = sample[i - 1];
    const bar = sample[i];
    overnight.push(Math.log(bar.open / prev.close));
    openClose.push(Math.log(bar.close / bar.open));
    rogersSatchell.push(
      Math.log(bar.high / bar.close) * Math.log(bar.high / bar.open)
      + Math.log(bar.low / bar.close) * Math.log(bar.low / bar.open)
    );
  }
  const variance = (values) => {
    const m = mean(values);
    return values.reduce((a, v) => a + (v - m) ** 2, 0) / (n - 1);
  };
  const k = 0.34 / (1.34 + (n + 1) / (n - 1));
  const total = variance(overnight) + k * variance(openClose) + (1 - k) * mean(rogersSatchell);
  // A negative variance means the inputs were not a coherent OHLC series.
  return total > 0 ? Math.sqrt(total) * Math.sqrt(TRADING_DAYS) : null;
}

/**
 * Probability the underlying finishes above (or below) a level at expiry,
 * under a lognormal with the supplied volatility.
 *
 * The drift is ZERO by default and that is a deliberate refusal rather than an
 * oversight. Any non-zero drift is a directional forecast, and this desk has no
 * validated one: inserting an expected return here would smuggle an assumed
 * edge into a number presented as a measurement. Zero drift asks the honest
 * question -- if the stock simply moves as much as it has been moving, with no
 * view about which way, how often does this position pay?
 */
function probabilityAbove({ spot, level, volatility, years, drift = 0 }) {
  if (!(spot > 0) || !(level > 0) || !(volatility > 0) || !(years > 0)) return null;
  const d2 = (Math.log(spot / level) + (drift - (volatility * volatility) / 2) * years)
    / (volatility * Math.sqrt(years));
  return normalCdf(d2);
}

/**
 * Whether the option is cheap or expensive, and by how much.
 *
 * Positive premium means implied exceeds realized: you are paying for more
 * movement than the stock has produced. Sustained, that is a losing trade for
 * a buyer even when the directional call is right.
 */
function volatilityVerdict(impliedVol, realizedVol) {
  if (!(impliedVol > 0) || !(realizedVol > 0)) {
    return { available: false, reason: "VOLATILITY_UNAVAILABLE" };
  }
  const premiumPoints = (impliedVol - realizedVol) * 100;
  const ratio = impliedVol / realizedVol;
  let verdict, meaning;
  if (ratio >= 1.25) {
    verdict = "EXPENSIVE";
    meaning = "You are paying for materially more movement than this stock has been delivering. Buying premium here is trading against the price of volatility, not just the direction.";
  } else if (ratio >= 1.10) {
    verdict = "RICH";
    meaning = "Implied sits above realized. Ordinary for listed options, but it is a headwind a buyer has to overcome before direction even matters.";
  } else if (ratio >= 0.90) {
    verdict = "FAIR";
    meaning = "Implied is close to what the stock has actually been doing. You are paying about the right price for the movement.";
  } else {
    verdict = "CHEAP";
    meaning = "Implied sits below realized movement. Unusual, and the condition under which buying premium is structurally favoured.";
  }
  return {
    available: true,
    verdict,
    meaning,
    impliedVolPct: Math.round(impliedVol * 1000) / 10,
    realizedVolPct: Math.round(realizedVol * 1000) / 10,
    premiumPoints: Math.round(premiumPoints * 10) / 10,
    ratio: Math.round(ratio * 100) / 100,
    // True for a BUYER. A seller faces the mirror image.
    favoursBuyer: ratio < 1.0
  };
}

/**
 * The full picture for one position.
 *
 * `breakevens` carries the level(s) the underlying must reach. The odds are
 * reported against the stock's OWN measured movement rather than against the
 * implied volatility, because implied is the price being charged and using it
 * to compute the odds would be quoting the seller's own assumptions back as
 * though they were evidence.
 */
/**
 * How long until it gets there.
 *
 * "Buy at X, sell at Y" is only half an instruction -- the other half is
 * whether Y is reachable in the time the contract has left. An option expires;
 * a target that needs six weeks on a contract with nine days is not a target,
 * it is a way of losing the premium slowly.
 *
 * This is a first-passage problem, not an end-point one. The position can be
 * closed the moment the underlying TOUCHES the level, so what matters is the
 * probability of touching at any point before expiry, which by the reflection
 * principle is about twice the probability of merely finishing beyond it:
 *
 *     P(touch by T) = 2 * N(-|ln(B/S)| / (sigma * sqrt(T)))
 *
 * The median time is derived from the same expression, solved for the t at
 * which half of the eventual touches have happened. Drift is zero, for the
 * same reason as everywhere else here: a drift term is a directional forecast
 * and this desk has no validated one.
 */
function timeToTarget({ spot, target, volatility, daysAvailable }) {
  const years = Number(daysAvailable) / 365;
  if (!(spot > 0) || !(target > 0) || !(volatility > 0) || !(years > 0)) return null;
  const distance = Math.abs(Math.log(target / spot));
  if (distance === 0) return { probabilityOfTouchPct: 100, medianDaysIfItHappens: 0, reachable: true };

  // FIRST PASSAGE WITH THE ITO DRIFT, not the naive reflection principle.
  //
  // 2*N(-b/(sigma*sqrt(T))) is the reflection result for driftless ARITHMETIC
  // Brownian motion. A price is geometric, and a martingale price has log-drift
  // of -sigma^2/2 -- so using the driftless form quietly assumes the stock
  // drifts UP at +sigma^2/2 and reports a better chance of reaching the target
  // than the mathematics supports. Monte Carlo over 200,000 paths put the
  // overstatement at 1 to 5 percentage points, always optimistic.
  //
  // The drifted first-passage probability for an upper barrier b > 0 is
  //   N((-b + mu*T)/(sigma*sqrt(T))) + exp(2*mu*b/sigma^2) * N((-b - mu*T)/(sigma*sqrt(T)))
  const sigmaRootT = volatility * Math.sqrt(years);
  const mu = -0.5 * volatility * volatility;
  const touch = Math.min(1, Math.max(0,
    normalCdf((-distance + mu * years) / sigmaRootT)
    + Math.exp((2 * mu * distance) / (volatility * volatility))
      * normalCdf((-distance - mu * years) / sigmaRootT)
  ));

  // Median of the first-passage time, conditional on it happening at all
  // before expiry. Found by bisection on P(touch by t) = half of P(touch by T).
  const target_p = touch / 2;
  let low = 1e-6, high = years, mid = years;
  for (let i = 0; i < 80; i += 1) {
    mid = (low + high) / 2;
    const rt = volatility * Math.sqrt(mid);
    const p = Math.min(1, Math.max(0,
      normalCdf((-distance + mu * mid) / rt)
      + Math.exp((2 * mu * distance) / (volatility * volatility)) * normalCdf((-distance - mu * mid) / rt)
    ));
    if (p < target_p) low = mid; else high = mid;
  }
  return {
    probabilityOfTouchPct: Math.round(touch * 1000) / 10,
    medianDaysIfItHappens: Math.round(mid * 365 * 10) / 10,
    daysAvailable: Math.round(Number(daysAvailable) * 10) / 10,
    // The single thing a reader needs: is this target realistic in the time left?
    reachable: touch >= 0.5,
    basis: "MEASURED_VOLATILITY_ZERO_DRIFT"
  };
}

function tradeOdds({ spot, bars, impliedVol, breakevenLong, breakevenFull, daysToExpiry, isBullish = true }) {
  const years = Number(daysToExpiry) / 365;
  if (!(spot > 0) || !(years > 0) || !Array.isArray(bars) || bars.length < 5) {
    return { available: false, reason: "INSUFFICIENT_DATA_FOR_ODDS" };
  }

  // MATCH THE WINDOW TO THE TENOR.
  //
  // This compared a 20-day BACKWARD realized volatility against a 9-day FORWARD
  // implied volatility and called the difference a variance risk premium. Those
  // measure different horizons: a stock that was wild three weeks ago and calm
  // since reads EXPENSIVE, and one that just started moving reads CHEAP, in
  // both cases because of days the option does not cover.
  //
  // The option's own tenor is the right window. Bounded at 10 so an estimate
  // never rests on a handful of bars, and at 60 so a long-dated contract does
  // not reach back into a different regime.
  const tenorWindow = Math.max(10, Math.min(60, Math.round(Number(daysToExpiry) || 20)));
  const rvTenor = closeToCloseVol(bars, tenorWindow);
  const rvAll = closeToCloseVol(bars);
  const parkTenor = parkinsonVol(bars, tenorWindow);
  const yzTenor = yangZhangVol(bars, tenorWindow);
  // Yang-Zhang first: it counts the overnight gap, which Parkinson cannot see
  // and which is a large part of how Indian equities actually move. Parkinson
  // and close-to-close remain as fallbacks for incomplete OHLC.
  const realized = yzTenor || parkTenor || rvTenor || rvAll;
  const rv20 = rvTenor;
  const park20 = parkTenor;
  if (!(realized > 0)) return { available: false, reason: "REALIZED_VOLATILITY_UNAVAILABLE" };

  const side = (level) => {
    const above = probabilityAbove({ spot, level, volatility: realized, years });
    if (above === null) return null;
    return isBullish ? above : 1 - above;
  };

  const pProfit = breakevenLong > 0 ? side(breakevenLong) : null;
  const pFull = breakevenFull > 0 ? side(breakevenFull) : null;

  return {
    available: true,
    spot,
    daysToExpiry: Number(daysToExpiry),
    barsUsed: bars.length,
    realizedVolPct: Math.round(realized * 1000) / 10,
    realizedCloseToClosePct: rvTenor ? Math.round(rvTenor * 1000) / 10 : null,
    realizedParkinsonPct: parkTenor ? Math.round(parkTenor * 1000) / 10 : null,
    realizedYangZhangPct: yzTenor ? Math.round(yzTenor * 1000) / 10 : null,
    estimator: yzTenor ? `YANG_ZHANG_${tenorWindow}D` : parkTenor ? `PARKINSON_${tenorWindow}D` : rvTenor ? `CLOSE_TO_CLOSE_${tenorWindow}D` : "CLOSE_TO_CLOSE_ALL",
    realizedWindowDays: tenorWindow,
    probabilityOfProfitPct: pProfit === null ? null : Math.round(pProfit * 1000) / 10,
    probabilityOfLossPct: pProfit === null ? null : Math.round((1 - pProfit) * 1000) / 10,
    probabilityOfMaxProfitPct: pFull === null ? null : Math.round(pFull * 1000) / 10,
    volatility: volatilityVerdict(impliedVol, realized),
    // How long, not just how likely. A target that needs six weeks on a
    // contract with nine days left is not a target.
    timing: breakevenLong > 0
      ? timeToTarget({ spot, target: breakevenLong, volatility: realized, daysAvailable: Number(daysToExpiry) })
      : null,
    timingToMax: breakevenFull > 0
      ? timeToTarget({ spot, target: breakevenFull, volatility: realized, daysAvailable: Number(daysToExpiry) })
      : null,
    // Stated so the number is never mistaken for a forecast.
    driftAssumption: "ZERO. No directional view is applied, because none has been validated.",
    basis: "MEASURED"
  };
}

module.exports = {
  TRADING_DAYS,
  timeToTarget,
  closeToCloseVol,
  yangZhangVol,
  normalCdf,
  parkinsonVol,
  probabilityAbove,
  tradeOdds,
  volatilityVerdict
};
