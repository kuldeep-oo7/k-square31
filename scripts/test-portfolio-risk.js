"use strict";

const assert = require("node:assert/strict");
const { evaluatePortfolioRisk, invalidOrderReason, DEFAULT_PORTFOLIO_LIMITS } = require("../api/_lib/portfolio-risk");

const normalMacro = {
  dataComplete: true,
  severity: "NORMAL",
  actionDirective: "NORMAL_OPERATION",
  missingFields: []
};

const sampleOrder = {
  executable: true,
  symbol: "RELIANCE",
  side: "long",
  clientOrderId: "K2_RISK_TEST_1",
  contractSymbol: "RELIANCE26OCTFUT",
  instrumentId: "NSE-FO-RELIANCE-OCT",
  expiry: "2026-10-27",
  tickSize: 0.05,
  lotSize: 500,
  lots: 1,
  quantity: 500,
  entryPrice: 1000,
  targetPrice: 1020,
  stopLossPrice: 970,
  estMarginRequired: 160000,
  marginSource: "CONSERVATIVE_ESTIMATE",
  maxRiskInr: 15000,
  contractNotional: 500000,
  sector: "ENERGY",
  banStatus: "CLEAR",
  dataAsOf: "2026-09-08",
  sessionVolume: 100000,
  openInterest: 800000,
  level: 1
};

function evaluate(overrides = {}) {
  return evaluatePortfolioRisk({
    proposedOrder: sampleOrder,
    activePositions: [],
    accountEquity: 2_000_000,
    marketRegime: normalMacro,
    ...overrides
  });
}

assert.equal(evaluate().approved, true);
assert.equal(evaluate().reason, "APPROVED_BY_PORTFOLIO_RISK_ENGINE");

assert.equal(invalidOrderReason({ ...sampleOrder, instrumentId: null }, DEFAULT_PORTFOLIO_LIMITS), "MISSING_INSTRUMENT_ID");
assert.equal(evaluate({ proposedOrder: { ...sampleOrder, banStatus: "UNAVAILABLE" } }).reason, "FO_BAN_STATUS_UNAVAILABLE");
assert.equal(evaluate({ proposedOrder: { ...sampleOrder, banStatus: "BANNED" } }).reason, "SECURITY_IN_FO_BAN");
assert.match(evaluate({ marketRegime: null }).reason, /^MACRO_DATA_UNAVAILABLE/);
assert.match(evaluate({ proposedOrder: { ...sampleOrder, expiry: "2026-09-10" } }).reason, /^EXPIRY_WINDOW_BLOCK/);
assert.match(evaluate({ proposedOrder: { ...sampleOrder, sessionVolume: 20 } }).reason, /^LIQUIDITY_CAPACITY_EXCEEDED/);

const kill = evaluate({ dailyRealizedPnl: -30000, dailyUnrealizedPnl: -25000 });
assert.equal(kill.approved, false);
assert.equal(kill.killSwitch, true);
assert.match(kill.reason, /^KILL_SWITCH_ACTIVE/);

const macroLock = evaluate({
  marketRegime: { dataComplete: true, severity: "CRITICAL_BLOODBATH", actionDirective: "FULL_DEFENSE" }
});
assert.equal(macroLock.approved, false);
assert.match(macroLock.reason, /^MACRO_SHOCK_SHIELD/);

const activeFive = Array.from({ length: 5 }, (_, index) => ({
  clientOrderId: `ACTIVE_${index}`,
  symbol: `SYM${index}`,
  sector: `SECTOR${index}`,
  marginBlocked: 100000,
  contractNotional: 200000
}));
assert.match(evaluate({ activePositions: activeFive }).reason, /^PORTFOLIO_CONCENTRATION/);

const activeSector = [
  { clientOrderId: "A", symbol: "ONGC", sector: "ENERGY", marginBlocked: 100000, contractNotional: 200000 },
  { clientOrderId: "B", symbol: "BPCL", sector: "ENERGY", marginBlocked: 100000, contractNotional: 200000 }
];
assert.match(evaluate({ activePositions: activeSector }).reason, /^SECTOR_CONCENTRATION/);

const heavyMargin = [
  { clientOrderId: "A", symbol: "A", sector: "IT", marginBlocked: 700000, contractNotional: 200000 },
  { clientOrderId: "B", symbol: "B", sector: "BANK", marginBlocked: 650000, contractNotional: 200000 }
];
assert.match(evaluate({ activePositions: heavyMargin }).reason, /^MARGIN_EXCEEDED/);
assert.match(evaluate({ proposedOrder: { ...sampleOrder, maxRiskInr: 35000 } }).reason, /^SINGLE_NAME_RISK_EXCEEDED/);

const leveraged = evaluate({ proposedOrder: { ...sampleOrder, entryPrice: 13000, targetPrice: 13260, stopLossPrice: 12970, contractNotional: 6_500_000 } });
assert.match(leveraged.reason, /^(GROSS_NOTIONAL_EXCEEDED|PORTFOLIO_STRESS_EXCEEDED)/);

const stressLimits = {
  ...DEFAULT_PORTFOLIO_LIMITS,
  maxGrossNotionalMultiple: 10,
  maxStressLossPctOfEquity: 0.01
};
assert.match(evaluate({ limits: stressLimits }).reason, /^PORTFOLIO_STRESS_EXCEEDED/);

console.log("Portfolio-risk tests passed: complete order schema, ban/macro freshness, capacity, expiry, concentration, leverage, stress and net-loss kill switch");
assert.equal(evaluate({ accountEquity: null }).reason, "ACCOUNT_EQUITY_UNAVAILABLE");
assert.equal(evaluate({ dailyUnrealizedPnl: NaN }).reason, "DAILY_PNL_UNAVAILABLE");
assert.equal(evaluate({ proposedOrder: { ...sampleOrder, targetPrice: 990 } }).reason, "INVALID_TARGET_STOP_DIRECTION");
assert.equal(evaluate({ proposedOrder: { ...sampleOrder, lots: 0.5 } }).reason, "LOT_QUANTITY_MISMATCH");
assert.equal(evaluate({ proposedOrder: { ...sampleOrder, contractNotional: 1 } }).reason, "NOTIONAL_RECONCILIATION_MISMATCH");
assert.equal(evaluate({ proposedOrder: { ...sampleOrder, maxRiskInr: 1 } }).reason, "STOP_RISK_UNDERSTATED");
