"use strict";

/** Mandatory pre-trade portfolio controls for leveraged NSE stock futures. */

const { normalizeOrderSide, round } = require("./shadow-broker");

const DEFAULT_PORTFOLIO_LIMITS = Object.freeze({
  maxTotalCapital: 2_000_000,
  maxMarginUtilizationPct: 0.70,
  maxOpenPositions: 5,
  maxSectorPositions: 2,
  maxSymbolPositions: 5,
  maxSingleNameRiskBudget: 25_000,
  maxGrossNotionalMultiple: 3.0,
  maxSessionParticipationPct: 0.02,
  stressMovePct: 0.05,
  maxStressLossPctOfEquity: 0.20,
  minDaysToExpiryForNewRisk: 4,
  dailyLossLimitInr: 50_000,
  killSwitchTriggered: false,
  requireCompleteMacro: true,
  requireSector: true,
  requireBanClear: true,
  requireCurrentMargin: false,
  strictOrderValidation: true
});

function invalidOrderReason(order, limits) {
  if (!order) return "NO_ORDER_INTENT";
  if (order.executable !== true) return order.rejectionReason || "ORDER_NOT_EXECUTABLE";
  if (!String(order.symbol || "").trim()) return "MISSING_SYMBOL";
  if (!normalizeOrderSide(order.side)) return "MISSING_OR_INVALID_SIDE";
  if (!String(order.clientOrderId || "").trim()) return "MISSING_CLIENT_ORDER_ID";
  if (!String(order.contractSymbol || "").trim()) return "MISSING_CONTRACT_SYMBOL";
  if (!String(order.instrumentId || "").trim()) return "MISSING_INSTRUMENT_ID";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(order.expiry || ""))) return "MISSING_OR_INVALID_EXPIRY";
  if (!(Number(order.tickSize) > 0)) return "MISSING_OR_INVALID_TICK_SIZE";
  const requiredNumbers = ["entryPrice", "targetPrice", "stopLossPrice", "tickSize", "lotSize", "lots", "quantity", "estMarginRequired", "maxRiskInr", "contractNotional", "sessionVolume", "openInterest"];
  if (requiredNumbers.some((key) => !(Number(order[key]) > 0) || !Number.isFinite(Number(order[key])))) return "MISSING_OR_NONFINITE_ORDER_NUMERIC";
  const sign = normalizeOrderSide(order.side) === "BUY" ? 1 : -1;
  if ((Number(order.targetPrice) - Number(order.entryPrice)) * sign <= 0
      || (Number(order.entryPrice) - Number(order.stopLossPrice)) * sign <= 0) return "INVALID_TARGET_STOP_DIRECTION";
  if ([order.entryPrice, order.targetPrice, order.stopLossPrice].some((price) => Math.abs(Number(price) / Number(order.tickSize) - Math.round(Number(price) / Number(order.tickSize))) > 1e-6)) return "PRICE_OFF_TICK_GRID";
  if (!Number.isInteger(Number(order.lotSize)) || !Number.isInteger(Number(order.lots))
      || Number(order.lots) * Number(order.lotSize) !== Number(order.quantity)) return "LOT_QUANTITY_MISMATCH";
  if (Math.abs(Number(order.contractNotional) - Number(order.entryPrice) * Number(order.quantity)) > 0.02) return "NOTIONAL_RECONCILIATION_MISMATCH";
  if (Number(order.maxRiskInr) + 0.02 < Math.abs(Number(order.entryPrice) - Number(order.stopLossPrice)) * Number(order.quantity)) return "STOP_RISK_UNDERSTATED";
  if (!(Number(order.lotSize) > 0) || !(Number(order.quantity) > 0)) return "INVALID_LOT_OR_QUANTITY";
  if (Math.abs(Number(order.quantity) / Number(order.lotSize) - Math.round(Number(order.quantity) / Number(order.lotSize))) > 1e-9) return "QUANTITY_NOT_IN_WHOLE_LOTS";
  if (!(Number(order.estMarginRequired) > 0)) return "MISSING_MARGIN_REQUIREMENT";
  if (!(Number(order.maxRiskInr) > 0)) return "MISSING_POSITION_RISK";
  if (!(Number(order.contractNotional) > 0)) return "MISSING_CONTRACT_NOTIONAL";
  if (limits.requireSector && !String(order.sector || "").trim()) return "MISSING_SECTOR";
  if (limits.requireBanClear && order.banStatus !== "CLEAR") return order.banStatus === "BANNED" ? "SECURITY_IN_FO_BAN" : "FO_BAN_STATUS_UNAVAILABLE";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(order.dataAsOf || ""))) return "MISSING_OR_INVALID_MARKET_DATA_DATE";
  if (!(Number(order.sessionVolume) > 0) || !(Number(order.openInterest) > 0)) return "MISSING_LIQUIDITY_OR_OPEN_INTEREST";
  if (limits.requireCurrentMargin && order.marginSource !== "BROKER_OR_CLEARING_CURRENT") return "CURRENT_MARGIN_UNAVAILABLE";
  return null;
}

function evaluatePortfolioRisk({
  proposedOrder,
  activePositions = [],
  dailyRealizedPnl = 0,
  dailyUnrealizedPnl = 0,
  accountEquity = null,
  marketRegime = null,
  limits = DEFAULT_PORTFOLIO_LIMITS
}) {
  const effective = { ...DEFAULT_PORTFOLIO_LIMITS, ...(limits || {}) };
  const active = Array.isArray(activePositions) ? activePositions : [];
  if (![dailyRealizedPnl, dailyUnrealizedPnl].every((value) => value !== null && Number.isFinite(Number(value)))) return { approved: false, reason: "DAILY_PNL_UNAVAILABLE" };
  if (!(Number(accountEquity) > 0) || !Number.isFinite(Number(accountEquity))) return { approved: false, reason: "ACCOUNT_EQUITY_UNAVAILABLE" };
  const dailyNetPnl = Number(dailyRealizedPnl) + Number(dailyUnrealizedPnl);

  if (dailyNetPnl <= -effective.dailyLossLimitInr || effective.killSwitchTriggered) {
    return {
      approved: false,
      reason: `KILL_SWITCH_ACTIVE: Daily net P&L (₹${dailyNetPnl}) hit daily limit (₹${effective.dailyLossLimitInr})`,
      killSwitch: true
    };
  }

  if (effective.requireCompleteMacro && (!marketRegime || marketRegime.dataComplete !== true)) {
    return {
      approved: false,
      reason: `MACRO_DATA_UNAVAILABLE: ${marketRegime?.missingFields?.join(", ") || "no complete macro assessment"}`,
      killSwitch: false
    };
  }
  if (
    marketRegime?.severity === "CRITICAL_BLOODBATH"
    || marketRegime?.severity === "DATA_UNAVAILABLE"
    || marketRegime?.actionDirective === "FULL_DEFENSE"
    || marketRegime?.actionDirective === "NO_NEW_ORDERS_DATA_LOCKDOWN"
    || marketRegime?.regime === "BLOODBATH_DEFENSIVE"
    || marketRegime?.shieldState === "LOCKDOWN"
  ) {
    return {
      approved: false,
      reason: `MACRO_SHOCK_SHIELD: Trading halted (${marketRegime?.summary || marketRegime?.shockReason || "severe/unknown market regime"})`,
      killSwitch: false
    };
  }

  const validationFailure = invalidOrderReason(proposedOrder, effective);
  if (validationFailure) return { approved: false, reason: validationFailure };

  const proposedSide = normalizeOrderSide(proposedOrder.side);
  if (marketRegime?.severity === "ELEVATED_RISK" && proposedSide === "BUY") {
    const allowed = Array.isArray(marketRegime.allowedLongLevels) ? marketRegime.allowedLongLevels : [];
    if (!allowed.includes(Number(proposedOrder.level))) {
      return { approved: false, reason: `MACRO_LEVEL_VETO: Long level ${proposedOrder.level} is not allowed in elevated risk` };
    }
  }

  if (active.length >= effective.maxOpenPositions) {
    return { approved: false, reason: `PORTFOLIO_CONCENTRATION: Maximum open positions (${effective.maxOpenPositions}) reached. Active: ${active.length}` };
  }
  if (active.some((position) => position.clientOrderId === proposedOrder.clientOrderId)) {
    return { approved: false, reason: `DUPLICATE_CLIENT_ORDER_ID: ${proposedOrder.clientOrderId}` };
  }
  const symbolPositions = active.filter((position) => position.symbol === proposedOrder.symbol).length;
  if (symbolPositions >= effective.maxSymbolPositions) {
    return { approved: false, reason: `SINGLE_SYMBOL_POSITION_CAP: ${proposedOrder.symbol} already has ${symbolPositions} legs` };
  }

  const sectorCount = active.filter((position) => position.sector === proposedOrder.sector).length;
  if (sectorCount >= effective.maxSectorPositions) {
    return { approved: false, reason: `SECTOR_CONCENTRATION: Sector '${proposedOrder.sector}' has reached maximum ${effective.maxSectorPositions} positions` };
  }

  if (active.some((position) => !(Number(position.marginBlocked || position.estMarginRequired || position.margin) > 0))) {
    return { approved: false, reason: "ACTIVE_POSITION_MARGIN_UNAVAILABLE" };
  }
  if (active.some((position) => !(Number(position.contractNotional || position.notional) > 0)
      || !Number.isFinite(Number(position.contractNotional || position.notional)))) return { approved: false, reason: "ACTIVE_POSITION_NOTIONAL_UNAVAILABLE" };
  const currentMargin = active.reduce((sum, position) => sum + Number(position.marginBlocked || position.estMarginRequired || position.margin), 0);
  const proposedMargin = Number(proposedOrder.estMarginRequired);
  const projectedMargin = currentMargin + proposedMargin;
  const capitalBase = Number(accountEquity);
  const maxAllowedMargin = capitalBase * effective.maxMarginUtilizationPct;
  if (projectedMargin > maxAllowedMargin) {
    return { approved: false, reason: `MARGIN_EXCEEDED: Projected ₹${projectedMargin} exceeds ₹${maxAllowedMargin}`, currentMargin, projectedMargin, maxAllowedMargin };
  }

  const proposedRisk = Number(proposedOrder.maxRiskInr);
  if (proposedRisk > effective.maxSingleNameRiskBudget) {
    return { approved: false, reason: `SINGLE_NAME_RISK_EXCEEDED: ₹${proposedRisk} exceeds ₹${effective.maxSingleNameRiskBudget}`, proposedRisk };
  }

  // UDiFF volume is contract volume, so compare requested lots—not shares.
  const requestedLots = Number(proposedOrder.lots) || Number(proposedOrder.quantity) / Number(proposedOrder.lotSize);
  const participationPct = requestedLots / Number(proposedOrder.sessionVolume);
  if (!Number.isFinite(participationPct) || participationPct > effective.maxSessionParticipationPct) {
    return { approved: false, reason: `LIQUIDITY_CAPACITY_EXCEEDED: ${(participationPct * 100).toFixed(3)}% > ${(effective.maxSessionParticipationPct * 100).toFixed(2)}%`, participationPct };
  }

  const daysToExpiry = Math.ceil((Date.parse(`${proposedOrder.expiry}T00:00:00Z`) - Date.parse(`${proposedOrder.dataAsOf}T00:00:00Z`)) / 86_400_000);
  if (!Number.isFinite(daysToExpiry) || daysToExpiry < effective.minDaysToExpiryForNewRisk) {
    return { approved: false, reason: `EXPIRY_WINDOW_BLOCK: ${daysToExpiry} calendar days to expiry`, daysToExpiry };
  }

  const currentGrossNotional = active.reduce((sum, position) => sum + Math.abs(Number(position.contractNotional || position.notional || 0)), 0);
  const proposedNotional = Math.abs(Number(proposedOrder.contractNotional));
  const projectedGrossNotional = currentGrossNotional + proposedNotional;
  const maxGrossNotional = capitalBase * effective.maxGrossNotionalMultiple;
  if (projectedGrossNotional > maxGrossNotional) {
    return { approved: false, reason: `GROSS_NOTIONAL_EXCEEDED: Projected ₹${projectedGrossNotional} exceeds ₹${maxGrossNotional}`, currentGrossNotional, projectedGrossNotional, maxGrossNotional };
  }

  const projectedStressLoss = round(projectedGrossNotional * effective.stressMovePct, 2);
  const maxStressLoss = round(capitalBase * effective.maxStressLossPctOfEquity, 2);
  if (projectedStressLoss > maxStressLoss) {
    return { approved: false, reason: `PORTFOLIO_STRESS_EXCEEDED: ${effective.stressMovePct * 100}% shock loses ₹${projectedStressLoss} versus ₹${maxStressLoss} limit`, projectedStressLoss, maxStressLoss };
  }

  return {
    approved: true,
    reason: "APPROVED_BY_PORTFOLIO_RISK_ENGINE",
    currentMargin: round(currentMargin, 2),
    projectedMargin: round(projectedMargin, 2),
    availableMargin: round(maxAllowedMargin - projectedMargin, 2),
    dailyNetPnl: round(dailyNetPnl, 2),
    currentGrossNotional: round(currentGrossNotional, 2),
    projectedGrossNotional: round(projectedGrossNotional, 2),
    maxGrossNotional: round(maxGrossNotional, 2),
    participationPct: round(participationPct, 6),
    daysToExpiry,
    projectedStressLoss,
    maxStressLoss,
    activeCount: active.length + 1
  };
}

module.exports = { DEFAULT_PORTFOLIO_LIMITS, evaluatePortfolioRisk, invalidOrderReason };
