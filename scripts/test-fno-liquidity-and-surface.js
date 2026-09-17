"use strict";

/**
 * Liquidity, capacity, basis and the implied-volatility surface.
 *
 * These run on synthetic bhavcopy rows so they are deterministic and need no
 * network. The rows are shaped exactly like the NSE F&O file, and the option
 * prices are GENERATED from a known volatility, so inverting them is a real
 * round trip: the surface must recover the volatility that produced the prices.
 */

const assert = require("node:assert/strict");
const {
  admitOrder,
  annualisedBasisPct,
  buildLiquidityProfile,
  normaliseDate,
  PARTICIPATION_CAP
} = require("../api/_lib/fno-liquidity");
const { buildSurface, chainFromRows, volatilityFor } = require("../api/_lib/iv-surface");
const { europeanOption } = require("../api/_lib/option-pricing");

const near = (actual, expected, tolerance, message) =>
  assert.ok(Math.abs(Number(actual) - expected) <= tolerance,
    `${message}: got ${actual}, wanted ${expected} +/- ${tolerance}`);

// --- date normalisation -----------------------------------------------------
// The bhavcopy carries both forms. An unparsed date previously made every basis
// on the desk come back null with nothing reporting a failure.
assert.equal(normaliseDate("20260917"), "2026-09-17");
assert.equal(normaliseDate("2026-09-17"), "2026-09-17");
assert.equal(normaliseDate("garbage"), null);
assert.equal(normaliseDate(null), null);

// --- basis ------------------------------------------------------------------
// A future 1% above spot with 30 days to run is carrying roughly 12% annualised.
near(annualisedBasisPct(1010, 1000, 30), 12.17, 0.05, "annualised basis on a 1% premium over 30 days");
near(annualisedBasisPct(990, 1000, 30), -12.17, 0.05, "a discount carries the opposite sign");
assert.equal(annualisedBasisPct(1010, 1000, 0), null, "an expired contract has no annualised basis");
assert.equal(annualisedBasisPct(0, 1000, 30), null, "a zero price is not a basis");

// --- liquidity and capacity -------------------------------------------------
function futuresSession(session, rows) {
  return { session, futures: rows.map((row) => ({ session, ...row })) };
}
const deep = { symbol: "DEEP", expiry: "2026-09-29", settle: 1000, close: 1000, underlying: 995, openInterest: 5_000_000, contracts: 20_000, turnoverInr: 2_000_000_000, lotSize: 250 };
const thin = { symbol: "THIN", expiry: "2026-09-29", settle: 400, close: 400, underlying: 399, openInterest: 1_000, contracts: 5, turnoverInr: 1_000_000, lotSize: 100 };
const sessions = ["2026-09-17", "2026-09-16", "2026-09-15", "2026-09-12", "2026-09-11", "2026-09-10"]
  .map((day) => futuresSession(day, [deep, thin]));
const profile = buildLiquidityProfile(sessions);

assert.equal(profile.asOf, "2026-09-17", "the profile is dated by its latest session");
assert.equal(profile.sessionsObserved, 6);
const deepProfile = profile.symbols.DEEP;
const thinProfile = profile.symbols.THIN;

assert.equal(deepProfile.tradeable, true, "a name with Rs 200 crore of daily turnover is tradeable");
assert.equal(thinProfile.tradeable, false, "a name with Rs 10 lakh of turnover is not");
assert.ok(thinProfile.reasons.includes("TURNOVER_BELOW_FLOOR") || thinProfile.reasons.includes("OPEN_INTEREST_BELOW_FLOOR"),
  `the rejection must say why, got ${thinProfile.reasons.join(",")}`);

// Capacity is turnover times the participation cap, expressed in whole lots,
// because the contract is indivisible.
near(deepProfile.capacityInr, 2_000_000_000 * PARTICIPATION_CAP, 1, "capacity is the participation share of turnover");
assert.equal(deepProfile.notionalPerLotInr, 1000 * 250, "notional per lot is price times lot size");
assert.equal(deepProfile.capacityLots, Math.floor(200_000_000 / 250_000), "capacity in lots is floored, never rounded up");
assert.ok(Number.isInteger(deepProfile.capacityLots), "a fractional lot cannot be traded");

// Basis flows through from the same rows.
near(deepProfile.basisPct, (1000 / 995 - 1) * 100, 0.01, "basis percentage");
assert.ok(deepProfile.basisAnnualisedPct > 0, "a future above spot carries positive basis");
assert.equal(deepProfile.daysToExpiry, 12, "days to expiry measured from the latest session");

// --- order admission --------------------------------------------------------
const small = admitOrder(profile, "DEEP", 10);
assert.equal(small.admitted, true);
assert.equal(small.lots, 10, "an order inside capacity is admitted whole");
assert.equal(small.cappedByCapacity, false);

const huge = admitOrder(profile, "DEEP", 999_999);
assert.equal(huge.lots, deepProfile.capacityLots, "an oversized order is cut to capacity, not refused outright");
assert.equal(huge.cappedByCapacity, true);

assert.equal(admitOrder(profile, "THIN", 1).admitted, false, "an illiquid name admits nothing");
assert.equal(admitOrder(profile, "UNKNOWN", 1).reason, "NO_LIQUIDITY_DATA",
  "a name with no data is refused rather than assumed liquid");

// --- implied volatility surface ---------------------------------------------
// Prices are generated from a KNOWN volatility, so recovering it is a genuine
// inversion test rather than a self-consistency check.
const SESSION = "2026-09-17";
const EXPIRY = "2026-10-27";
const FUTURE = 1000;
const SPOT = 994;
const TRUE_IV = 0.28;
const T = (Date.parse(`${EXPIRY}T15:30:00Z`) - Date.parse(`${SESSION}T00:00:00Z`)) / (365 * 86_400_000);

const rows = [{
  FinInstrmTp: "STF", TckrSymb: "TESTCO", XpryDt: EXPIRY, SttlmPric: String(FUTURE),
  ClsPric: String(FUTURE), UndrlygPric: String(SPOT), NewBrdLotQty: "250"
}];
for (const strike of [850, 900, 950, 1000, 1050, 1100, 1150]) {
  for (const optionType of ["CE", "PE"]) {
    const model = europeanOption({
      model: "BLACK76", optionType, underlyingPrice: FUTURE, strike,
      timeToExpiryYears: T, riskFreeRate: 0.065, volatility: TRUE_IV
    });
    rows.push({
      FinInstrmTp: "STO", TckrSymb: "TESTCO", XpryDt: EXPIRY, OptnTp: optionType,
      StrkPric: String(strike), SttlmPric: model.price.toFixed(2), ClsPric: model.price.toFixed(2),
      UndrlygPric: String(SPOT), TtlTradgVol: "500", OpnIntrst: "10000", NewBrdLotQty: "250"
    });
  }
}

const chain = chainFromRows(rows);
const entry = chain.get(`TESTCO|${EXPIRY}`);
assert.ok(entry, "the chain must key on symbol and expiry");
assert.equal(entry.futuresPrice, FUTURE, "the future for the same expiry must be attached to the chain");

const surface = buildSurface(rows, SESSION);
const smile = surface.symbols.TESTCO.front;
assert.equal(smile.available, true, smile.reason || "the surface must solve");
assert.equal(smile.pricedOff, "FUTURE", "an option with a listed future is priced off the future, not spot");
assert.equal(smile.method, "BLACK76_ON_FUTURE_EUROPEAN_EQUIVALENT_IV");
near(smile.basisPct, (FUTURE / SPOT - 1) * 100, 0.01, "basis carried onto the smile");

// Every solved strike must return the volatility the prices were built from.
assert.ok(smile.solvedStrikes >= 12, `expected the full grid to invert, got ${smile.solvedStrikes}`);
for (const point of smile.points) {
  near(point.iv, TRUE_IV, 0.002, `strike ${point.strike} ${point.optionType} must recover the input volatility`);
}
near(smile.atmIv, TRUE_IV, 0.002, "at-the-money volatility");
// A flat input surface has no skew; anything else means the solver is tilting it.
near(smile.skew25Delta, 0, 0.004, "a flat surface must show no skew");

// Interpolation between observed strikes, and an honest flag outside them.
const inside = volatilityFor(surface, "TESTCO", 1025);
assert.equal(inside.available, true);
assert.equal(inside.extrapolated, false);
near(inside.volatility, TRUE_IV, 0.003, "interpolated volatility between observed strikes");
const outside = volatilityFor(surface, "TESTCO", 5000);
assert.equal(outside.extrapolated, true, "beyond the observed wings the result must declare itself extrapolated");
assert.equal(volatilityFor(surface, "NOPE", 100).available, false, "an unknown symbol yields no volatility");

// --- untraded strikes must not be inverted ----------------------------------
// A settlement price on a strike nobody touched is an exchange construction.
const dead = rows.map((row) => (row.FinInstrmTp === "STO"
  ? { ...row, TtlTradgVol: "0", OpnIntrst: "0" }
  : row));
const deadChain = chainFromRows(dead);
assert.equal(deadChain.size, 0, "strikes with no volume and no open interest are excluded, not inverted");
assert.equal(chainFromRows(dead, { requireActivity: false }).size, 1,
  "the exclusion is opt-out, so a caller can still inspect the full file");

console.log("F&O liquidity and IV surface tests passed: date normalisation, annualised basis, capacity in whole lots, order admission caps, Black-76 inversion recovering a known volatility across the grid, smile interpolation and untraded-strike exclusion");
