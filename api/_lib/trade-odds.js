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
function tradeOdds({ spot, bars, impliedVol, breakevenLong, breakevenFull, daysToExpiry, isBullish = true }) {
  const years = Number(daysToExpiry) / 365;
  if (!(spot > 0) || !(years > 0) || !Array.isArray(bars) || bars.length < 5) {
    return { available: false, reason: "INSUFFICIENT_DATA_FOR_ODDS" };
  }

  const rv20 = closeToCloseVol(bars, 20);
  const rvAll = closeToCloseVol(bars);
  const park20 = parkinsonVol(bars, 20);
  // Prefer Parkinson where a real range exists: same data, less noise.
  const realized = park20 || rv20 || rvAll;
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
    realizedCloseToClose20Pct: rv20 ? Math.round(rv20 * 1000) / 10 : null,
    realizedParkinson20Pct: park20 ? Math.round(park20 * 1000) / 10 : null,
    estimator: park20 ? "PARKINSON_20D" : rv20 ? "CLOSE_TO_CLOSE_20D" : "CLOSE_TO_CLOSE_ALL",
    probabilityOfProfitPct: pProfit === null ? null : Math.round(pProfit * 1000) / 10,
    probabilityOfLossPct: pProfit === null ? null : Math.round((1 - pProfit) * 1000) / 10,
    probabilityOfMaxProfitPct: pFull === null ? null : Math.round(pFull * 1000) / 10,
    volatility: volatilityVerdict(impliedVol, realized),
    // Stated so the number is never mistaken for a forecast.
    driftAssumption: "ZERO. No directional view is applied, because none has been validated.",
    basis: "MEASURED"
  };
}

module.exports = {
  TRADING_DAYS,
  closeToCloseVol,
  normalCdf,
  parkinsonVol,
  probabilityAbove,
  tradeOdds,
  volatilityVerdict
};
