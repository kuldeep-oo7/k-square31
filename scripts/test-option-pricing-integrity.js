"use strict";

/**
 * Black-Scholes-Merton integrity.
 *
 * The desk previously priced all 420 equity contracts as a flat percentage of
 * spot -- calls at 2.2%, puts at 2.0% -- with targets at 1.35x and 1.70x the
 * premium, the stop at 0.60x, the short hedge leg at 0.28x and "max risk" at
 * 0.72x. A percentage of spot has no dependence on the strike, on time to
 * expiry, or on volatility, so a one-day and a thirty-day option on the same
 * name cost the same. Quoting the ATM call and the ATM put at different
 * percentages of the same spot also violated put-call parity on every contract
 * in the book, which is a standing arbitrage rather than a modelling error.
 *
 * These assertions check the pricing against values that exist independently of
 * this codebase: a textbook example, and the no-arbitrage identities that any
 * correct implementation must satisfy to machine precision.
 */

const assert = require("node:assert/strict");
const { europeanOption, impliedVolatility, priceBounds } = require("../api/_lib/option-pricing");
const { fnoUniverseEngine } = require("../api/_lib/universe-210");

const near = (actual, expected, tolerance, message) =>
  assert.ok(Math.abs(Number(actual) - expected) <= tolerance,
    `${message}: got ${actual}, wanted ${expected} +/- ${tolerance}`);

// --- 1. Textbook reference --------------------------------------------------
// Hull, "Options, Futures and Other Derivatives": S=42, K=40, r=10%, sigma=20%,
// T=0.5 gives a call of 4.76 and a put of 0.81.
const hull = { model: "BSM", underlyingPrice: 42, strike: 40, timeToExpiryYears: 0.5, riskFreeRate: 0.10, dividendYield: 0, volatility: 0.20 };
const hullCall = europeanOption({ ...hull, optionType: "CE" });
const hullPut = europeanOption({ ...hull, optionType: "PE" });
near(hullCall.price, 4.76, 0.005, "Hull reference call");
near(hullPut.price, 0.81, 0.005, "Hull reference put");
near(hullCall.delta, 0.779, 0.002, "Hull reference call delta");
console.log(`  ✓ Textbook reference reproduced: call ${hullCall.price.toFixed(4)} (4.76), put ${hullPut.price.toFixed(4)} (0.81)`);

// --- 2. Put-call parity -----------------------------------------------------
// C - P = S*exp(-qT) - K*exp(-rT). This is an arbitrage identity, not an
// approximation: it must hold to floating-point precision at every strike,
// every maturity and every volatility, or the two sides of the book disagree.
let worstParity = 0;
let parityChecks = 0;
for (const S of [50, 100, 250, 1000, 7500]) {
  for (const moneyness of [0.8, 0.95, 1.0, 1.05, 1.25]) {
    for (const T of [0.004, 0.08, 0.5, 2]) {
      for (const sigma of [0.08, 0.25, 0.6, 1.2]) {
        const K = S * moneyness;
        const shared = { model: "BSM", underlyingPrice: S, strike: K, timeToExpiryYears: T, riskFreeRate: 0.065, dividendYield: 0.012, volatility: sigma };
        const call = europeanOption({ ...shared, optionType: "CE" });
        const put = europeanOption({ ...shared, optionType: "PE" });
        if (!call.available || !put.available) continue;
        const residual = Math.abs((call.price - put.price) - (S * Math.exp(-0.012 * T) - K * Math.exp(-0.065 * T)));
        worstParity = Math.max(worstParity, residual / S);
        parityChecks += 1;
      }
    }
  }
}
assert.ok(parityChecks >= 300, `Parity must be exercised broadly, only ran ${parityChecks} checks`);
assert.ok(worstParity < 1e-10, `Put-call parity violated: worst relative residual ${worstParity}`);
console.log(`  ✓ Put-call parity holds across ${parityChecks} combinations (worst relative residual ${worstParity.toExponential(2)})`);

// --- 3. No-arbitrage bounds -------------------------------------------------
// A call is worth at least its discounted intrinsic value and never more than
// the discounted asset; a put never more than the discounted strike.
for (const S of [120, 900]) {
  for (const moneyness of [0.7, 1, 1.4]) {
    for (const sigma of [0.1, 0.5]) {
      const K = S * moneyness;
      const shared = { model: "BSM", underlyingPrice: S, strike: K, timeToExpiryYears: 0.25, riskFreeRate: 0.065, dividendYield: 0.01, volatility: sigma };
      for (const optionType of ["CE", "PE"]) {
        const bounds = priceBounds({ ...shared, optionType });
        const value = europeanOption({ ...shared, optionType });
        assert.ok(value.available && bounds.available);
        assert.ok(value.price >= bounds.lower - 1e-9, `${optionType} priced below intrinsic: ${value.price} < ${bounds.lower}`);
        assert.ok(value.price <= bounds.upper + 1e-9, `${optionType} priced above its ceiling: ${value.price} > ${bounds.upper}`);
      }
    }
  }
}
console.log("  ✓ Prices stay inside no-arbitrage bounds at every moneyness tested");

// --- 4. Monotonicity and Greek signs ----------------------------------------
// Optionality is worth more with more volatility and more time. If either of
// these fails the model is not pricing an option.
const mono = { model: "BSM", optionType: "CE", underlyingPrice: 1000, strike: 1000, timeToExpiryYears: 0.25, riskFreeRate: 0.065, dividendYield: 0 };
let previousVol = -1;
for (const sigma of [0.05, 0.10, 0.20, 0.40, 0.80]) {
  const value = europeanOption({ ...mono, volatility: sigma }).price;
  assert.ok(value > previousVol, `Call value must rise with volatility: ${sigma} gave ${value}`);
  previousVol = value;
}
let previousTime = -1;
for (const T of [0.02, 0.1, 0.5, 1, 3]) {
  const value = europeanOption({ ...mono, timeToExpiryYears: T, volatility: 0.25 }).price;
  assert.ok(value > previousTime, `Call value must rise with time to expiry: ${T} gave ${value}`);
  previousTime = value;
}
const atm = europeanOption({ ...mono, volatility: 0.25 });
const atmPut = europeanOption({ ...mono, optionType: "PE", volatility: 0.25 });
assert.ok(atm.delta > 0 && atm.delta < 1, `Call delta must lie in (0,1), got ${atm.delta}`);
assert.ok(atmPut.delta < 0 && atmPut.delta > -1, `Put delta must lie in (-1,0), got ${atmPut.delta}`);
assert.ok(atm.gamma > 0, "Gamma is positive for a long option");
assert.ok(atm.vega > 0, "Vega is positive for a long option");
assert.ok(atm.theta < 0, "A long option loses value as time passes");
near(atm.gamma, atmPut.gamma, 1e-12, "Call and put at one strike share gamma");
near(atm.vega, atmPut.vega, 1e-12, "Call and put at one strike share vega");
near(atm.delta - atmPut.delta, Math.exp(-0 * 0.25), 1e-9, "Call delta minus put delta equals exp(-qT)");
console.log(`  ✓ Monotone in volatility and time; Greek signs and shared gamma/vega correct`);

// --- 5. Implied volatility inverts the price --------------------------------
for (const sigma of [0.12, 0.33, 0.74]) {
  const shared = { model: "BSM", optionType: "CE", underlyingPrice: 2500, strike: 2600, timeToExpiryYears: 0.15, riskFreeRate: 0.065, dividendYield: 0.008 };
  const priced = europeanOption({ ...shared, volatility: sigma });
  const recovered = impliedVolatility(shared, priced.price);
  assert.ok(recovered.available, `Implied volatility must invert a model price: ${recovered.reason}`);
  near(recovered.iv, sigma, 1e-5, "Implied volatility round trip");
}
console.log("  ✓ Implied volatility inverts the model price to 1e-5");

// --- 6. The desk must never publish a premium it did not price --------------
// This is the regression that matters operationally: a contract with no measured
// volatility must be UNPRICED, not 2.2% of spot.
const universe = fnoUniverseEngine.getUniverse({ severity: "NORMAL", shieldActive: false });
const chains = universe.filter((row) => row.options);
assert.ok(chains.length > 100, "The universe must carry option chains");
let unpriced = 0;
for (const row of chains) {
  for (const leg of [row.options.call, row.options.put]) {
    assert.ok(leg && typeof leg.available === "boolean", `${row.symbol} option leg must declare availability`);
    if (!leg.available) {
      unpriced += 1;
      assert.equal(leg.premium, null, `${row.symbol} ${leg.type} is unpriced and must not carry a premium`);
      assert.equal(leg.capitalRequired, null, `${row.symbol} ${leg.type} must not imply capital for an unpriced contract`);
      assert.ok(typeof leg.reason === "string" && leg.reason.length > 0, `${row.symbol} ${leg.type} must say why it is unpriced`);
    } else {
      assert.ok(leg.premium > 0, `${row.symbol} ${leg.type} priced contract needs a positive premium`);
      assert.equal(row.options.model, "BLACK_SCHOLES_MERTON", "A priced chain must name its model");
      const greeks = leg.greeks || leg;
      assert.ok(Number.isFinite(greeks.delta) && Number.isFinite(greeks.gamma),
        `${row.symbol} ${leg.type} priced contract carries Greeks`);
      assert.ok(leg.type === "CE" ? greeks.delta > 0 : greeks.delta < 0,
        `${row.symbol} ${leg.type} delta must carry the sign of the option type`);
      // The whole premium is at risk on a long option.
      assert.equal(leg.maxLossRupees, Math.round(leg.premium * leg.lotSize),
        `${row.symbol} ${leg.type} max loss on a long option is the full premium`);
      // Breakeven at expiry is exact: strike plus premium for a call, minus for a put.
      const expectedBreakeven = Math.round((leg.type === "CE" ? leg.strike + leg.premium : leg.strike - leg.premium) * 100) / 100;
      assert.equal(leg.breakeven, expectedBreakeven,
        `${row.symbol} ${leg.type} breakeven must be strike ${leg.type === "CE" ? "+" : "-"} premium`);
      // No fabricated traded mark or arbitrary target ladder.
      assert.equal(leg.currentPrice, null, `${row.symbol} ${leg.type} must not publish a mark it did not receive`);
      assert.equal(leg.target1, null, `${row.symbol} ${leg.type} must not publish an arbitrary premium multiple as a target`);
    }
  }
  const spread = row.options.spread;
  if (spread.available) {
    assert.ok(spread.netDebit > 0, "A debit spread costs a positive net debit");
    assert.equal(spread.maxLossRupees, Math.round(spread.netDebit * row.options.call.lotSize),
      "A vertical debit spread cannot lose more than its net debit");
    assert.ok(spread.netDebit < (row.options.call.premium ?? Infinity),
      "A spread must cost less than the outright long leg it is built from");
  } else {
    assert.equal(spread.maxLossRupees, null, "An unpriced spread must not quote a max loss");
  }
}
console.log(`  ✓ Desk contracts fail closed: ${unpriced} of ${chains.length * 2} legs report UNPRICED rather than a percentage of spot`);

console.log("Option-pricing integrity passed: textbook reference, put-call parity, no-arbitrage bounds, Greek signs, IV inversion and fail-closed desk pricing");
