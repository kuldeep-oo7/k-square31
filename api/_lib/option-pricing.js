"use strict";

// European option research models. Full precision internally; round only in UI.
// BSM underlying = spot with continuous dividend yield. BLACK76 = futures price.
// Greeks: delta/underlying unit, gamma/unit^2, vega/1 vol percentage point,
// theta/calendar day (time passing), rho/1 rate percentage point.
// Black-76 rho holds the futures price FIXED, not a spot-derived forward.
const finite = (x) => typeof x === "number" && Number.isFinite(x);
const pdf = (x) => Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
function cdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const tail = pdf(x) * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - tail : tail;
}
function unavailable(reason) {
  return { available: false, status: "UNAVAILABLE", reason, price: null, delta: null, gamma: null, vega: null, theta: null, rho: null, iv: null };
}
function validate(p) {
  if (!["BSM", "BLACK76"].includes(p.model)) return "MODEL_MUST_BE_EXPLICIT";
  if (!["CE", "PE"].includes(p.optionType)) return "OPTION_TYPE_INVALID";
  if (![p.underlyingPrice, p.strike].every((n) => finite(n) && n > 0)) return "PRICE_OR_STRIKE_INVALID";
  if (!finite(p.timeToExpiryYears) || p.timeToExpiryYears < 0) return "EXPIRY_TIME_INVALID";
  if (p.timeToExpiryYears === 0) return null;
  if (!finite(p.riskFreeRate)) return "RATE_MISSING";
  if (p.model === "BSM" && !finite(p.dividendYield)) return "DIVIDEND_YIELD_MISSING";
  return null;
}
function priceBounds(p) {
  const error = validate(p);
  if (error) return { available: false, reason: error };
  const T = p.timeToExpiryYears;
  const discount = T === 0 ? 1 : Math.exp(-p.riskFreeRate * T);
  const assetDiscount = p.model === "BLACK76" ? discount : T === 0 ? 1 : Math.exp(-p.dividendYield * T);
  const asset = p.underlyingPrice * assetDiscount;
  const strike = p.strike * discount;
  const sign = p.optionType === "CE" ? 1 : -1;
  const lower = Math.max(0, sign * (asset - strike));
  const upper = p.optionType === "CE" ? asset : strike;
  return [lower, upper].every(finite) ? { available: true, lower, upper, discount, assetDiscount } : { available: false, reason: "NUMERICAL_OVERFLOW" };
}
function europeanOption(p = {}) {
  const error = validate(p);
  if (error) return unavailable(error);
  const { underlyingPrice: S, strike: K, timeToExpiryYears: T, riskFreeRate: r, volatility: sigma } = p;
  const call = p.optionType === "CE", sign = call ? 1 : -1;
  if (T === 0) {
    const difference = sign * (S - K);
    return { available: true, status: "EXPIRY_INTRINSIC", model: p.model, price: Math.max(difference, 0),
      delta: S === K ? null : difference > 0 ? sign : 0, gamma: S === K ? null : 0,
      theta: null, vega: 0, rho: 0, iv: null, reason: "Expiry theta and at-strike derivatives are not regular Greeks" };
  }
  if (!finite(sigma) || sigma < 0) return unavailable("VOLATILITY_MISSING_OR_INVALID");
  const bounds = priceBounds(p);
  if (!bounds.available) return unavailable(bounds.reason);
  if (sigma === 0) return { ...unavailable("Greeks withheld at the zero-volatility boundary"), available: true,
    status: "DETERMINISTIC_BOUNDARY", model: p.model, price: bounds.lower, iv: 0 };
  const futures = p.model === "BLACK76";
  const q = futures ? r : p.dividendYield;
  const rootT = Math.sqrt(T), D = bounds.discount, Q = bounds.assetDiscount;
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * rootT);
  const d2 = d1 - sigma * rootT;
  const price = sign * (S * Q * cdf(sign * d1) - K * D * cdf(sign * d2));
  const diffusion = S * Q * pdf(d1) * sigma / (2 * rootT);
  const thetaAnnual = futures ? -diffusion + r * price
    : -diffusion + sign * q * S * Q * cdf(sign * d1) - sign * r * K * D * cdf(sign * d2);
  const result = { available: true, status: "THEORETICAL_RESEARCH", model: p.model,
    price: Math.max(bounds.lower, Math.min(bounds.upper, price)),
    delta: sign * Q * cdf(sign * d1), gamma: Q * pdf(d1) / (S * sigma * rootT),
    vega: S * Q * rootT * pdf(d1) / 100, theta: thetaAnnual / 365,
    rho: (futures ? -T * price : sign * K * T * D * cdf(sign * d2)) / 100,
    iv: sigma, d1, d2 };
  if (![result.price, result.delta, result.gamma, result.vega, result.theta, result.rho].every(finite)) return unavailable("NUMERICAL_OVERFLOW");
  return result;
}
function impliedVolatility(p = {}, marketPrice, { maxVolatility = 5, tolerance = 1e-8, maxIterations = 200 } = {}) {
  const bounds = priceBounds(p);
  if (!bounds.available) return { available: false, iv: null, reason: bounds.reason };
  if (!finite(marketPrice) || marketPrice < 0 || p.timeToExpiryYears <= 0) return { available: false, iv: null, reason: "PRICE_OR_TIME_INVALID" };
  if (!finite(maxVolatility) || maxVolatility <= 0 || !finite(tolerance) || tolerance <= 0 || !Number.isInteger(maxIterations) || maxIterations <= 0) return { available: false, iv: null, reason: "SOLVER_CONFIG_INVALID" };
  if (marketPrice < bounds.lower - tolerance || marketPrice >= bounds.upper) return { available: false, iv: null, reason: "OUTSIDE_FINITE_VOLATILITY_BOUNDS" };
  if (Math.abs(marketPrice - bounds.lower) <= tolerance) return { available: true, iv: 0, status: "AT_LOWER_BOUND" };
  const highValue = europeanOption({ ...p, volatility: maxVolatility });
  if (!highValue.available || highValue.price < marketPrice) return { available: false, iv: null, reason: "VOLATILITY_NOT_BRACKETED" };
  let low = 0, high = maxVolatility;
  for (let i = 0; i < maxIterations; i += 1) {
    const iv = (low + high) / 2;
    const value = europeanOption({ ...p, volatility: iv });
    if (!value.available) return { available: false, iv: null, reason: value.reason };
    if (Math.abs(value.price - marketPrice) <= tolerance) return { available: true, iv, status: "IMPLIED_BY_INPUT_PRICE", iterations: i + 1 };
    if (value.price < marketPrice) low = iv; else high = iv;
  }
  return { available: false, iv: null, reason: "NO_CONVERGENCE" };
}
module.exports = { europeanOption, impliedVolatility, priceBounds };
