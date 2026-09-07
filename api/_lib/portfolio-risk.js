"use strict";

/**
 * K-Square Range Desk - Portfolio Risk & Allocation Engine
 *
 * Implements firm-wide portfolio risk controls for leveraged NSE Equity Futures:
 * - Aggregate Portfolio Margin Limit (prevents over-leveraging)
 * - Maximum Open Positions (cross-name diversification cap)
 * - Sector Concentration Limits
 * - Daily Drawdown Halt / Kill-Switch
 * - Market Shock Shield Integration
 */

const { round } = require("./shadow-broker");

const DEFAULT_PORTFOLIO_LIMITS = Object.freeze({
  maxTotalCapital: 2000000,       // ₹20,00,000 total capital
  maxMarginUtilizationPct: 0.70,  // Max 70% deployed into margin (₹14,00,000)
  maxOpenPositions: 5,            // Max 5 simultaneous stock futures positions
  maxSectorPositions: 2,          // Max 2 positions per sector
  maxSingleNameRiskBudget: 25000, // ₹25,000 risk cap per position
  maxGrossNotionalMultiple: 3.0,  // Gross futures notional / account equity
  dailyLossLimitInr: 50000,       // ₹50,000 daily portfolio stop-loss kill switch
  killSwitchTriggered: false,
  requireCompleteMacro: false,
  requireSector: false,
  strictOrderValidation: false
});

function invalidOrderReason(order, limits = {}) {
  if (!order) return "NO_ORDER_INTENT";
  if (order.executable === false) return order.rejectionReason || "ORDER_NOT_EXECUTABLE";
  if (limits.strictOrderValidation) {
    if (!String(order.symbol || "").trim()) return "MISSING_SYMBOL";
    if (!(order.side === "long" || order.side === "short" || order.side === "buy" || order.side === "sell")) return "MISSING_OR_INVALID_SIDE";
    if (!String(order.contractSymbol || "").trim()) return "MISSING_CONTRACT_SYMBOL";
    if (!String(order.expiry || "").match(/^\d{4}-\d{2}-\d{2}$/)) return "MISSING_OR_INVALID_EXPIRY";
    if (!(Number(order.lotSize) > 0) || !(Number(order.quantity) > 0)) return "INVALID_LOT_OR_QUANTITY";
    if (Math.abs(Number(order.quantity) / Number(order.lotSize) - Math.round(Number(order.quantity) / Number(order.lotSize))) > 1e-9) return "QUANTITY_NOT_IN_WHOLE_LOTS";
    if (!(Number(order.estMarginRequired) > 0)) return "MISSING_MARGIN_REQUIREMENT";
    if (!(Number(order.maxRiskInr) > 0)) return "MISSING_POSITION_RISK";
    if (limits.requireSector && !String(order.sector || "").trim()) return "MISSING_SECTOR";
  }
  return null;
}

/**
 * Validates a proposed order intent against firm-wide portfolio risk constraints.
 */
function evaluatePortfolioRisk({
  proposedOrder,
  activePositions = [],
  dailyRealizedPnl = 0,
  dailyUnrealizedPnl = 0,
  accountEquity = null,
  marketRegime = null,
  limits = DEFAULT_PORTFOLIO_LIMITS
}) {
  const active = Array.isArray(activePositions) ? activePositions : [];

  const dailyNetPnl = Number(dailyRealizedPnl || 0) + Number(dailyUnrealizedPnl || 0);

  // 1. Daily Loss Kill-Switch. Variation margin is economic P&L even before a
  // position is closed, so realized-only loss is not a sufficient protection.
  if (dailyNetPnl <= -limits.dailyLossLimitInr || limits.killSwitchTriggered) {
    return {
      approved: false,
      reason: `KILL_SWITCH_ACTIVE: Daily net P&L (₹${dailyNetPnl}) hit daily limit (₹${limits.dailyLossLimitInr})`,
      killSwitch: true
    };
  }

  // 2. Global Macro Shock Shield gating. Missing required data is not NORMAL.
  if (limits.requireCompleteMacro && (!marketRegime || marketRegime.dataComplete !== true)) {
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
      reason: `MACRO_SHOCK_SHIELD: Trading halted due to severe macro crisis (${marketRegime?.shockReason || "Bloodbath market regime"})`,
      killSwitch: false
    };
  }

  const validationFailure = invalidOrderReason(proposedOrder, limits);
  if (validationFailure) return { approved: false, reason: validationFailure };

  if (marketRegime?.severity === "ELEVATED_RISK" && proposedOrder.side !== "short") {
    const allowed = Array.isArray(marketRegime.allowedLongLevels) ? marketRegime.allowedLongLevels : [];
    if (!allowed.includes(Number(proposedOrder.level))) {
      return { approved: false, reason: `MACRO_LEVEL_VETO: Long level ${proposedOrder.level} is not allowed in elevated risk` };
    }
  }

  // 3. Maximum Open Positions Cap
  if (active.length >= limits.maxOpenPositions) {
    return {
      approved: false,
      reason: `PORTFOLIO_CONCENTRATION: Maximum open positions (${limits.maxOpenPositions}) reached. Active: ${active.length}`
    };
  }

  if (proposedOrder.symbol && proposedOrder.side && active.some((position) => position.symbol === proposedOrder.symbol && position.side === proposedOrder.side)) {
    return { approved: false, reason: `DUPLICATE_DIRECTIONAL_EXPOSURE: ${proposedOrder.symbol} ${proposedOrder.side} already open` };
  }

  // 4. Sector Concentration Cap
  if (proposedOrder.sector) {
    const sectorCount = active.filter((p) => p.sector === proposedOrder.sector).length;
    if (sectorCount >= limits.maxSectorPositions) {
      return {
        approved: false,
        reason: `SECTOR_CONCENTRATION: Sector '${proposedOrder.sector}' has reached maximum ${limits.maxSectorPositions} positions`
      };
    }
  }

  // 5. Aggregate Margin Utilization Check
  if (active.some((position) => !(Number(position.marginBlocked || position.estMarginRequired || position.margin) >= 0))) {
    return { approved: false, reason: "ACTIVE_POSITION_MARGIN_UNAVAILABLE" };
  }
  const currentMargin = active.reduce((sum, p) => sum + Number(p.marginBlocked || p.estMarginRequired || p.margin || 0), 0);
  const proposedMargin = Number(proposedOrder.estMarginRequired || 0);
  const projectedMargin = currentMargin + proposedMargin;
  const capitalBase = Number(accountEquity) > 0 ? Number(accountEquity) : limits.maxTotalCapital;
  const maxAllowedMargin = capitalBase * limits.maxMarginUtilizationPct;

  if (projectedMargin > maxAllowedMargin) {
    return {
      approved: false,
      reason: `MARGIN_EXCEEDED: Projected margin utilization (₹${projectedMargin}) exceeds maximum allowed margin (₹${maxAllowedMargin})`,
      currentMargin,
      projectedMargin,
      maxAllowedMargin
    };
  }

  // 6. Single-Position Risk Cap Enforcement
  const proposedRisk = Number(proposedOrder.maxRiskInr || 0);
  if (proposedRisk > limits.maxSingleNameRiskBudget) {
    return {
      approved: false,
      reason: `SINGLE_NAME_RISK_EXCEEDED: Order risk (₹${proposedRisk}) exceeds maximum position risk budget (₹${limits.maxSingleNameRiskBudget})`,
      proposedRisk,
      maxSingleNameRiskBudget: limits.maxSingleNameRiskBudget
    };
  }


  // 7. Gross notional leverage cap. Margin alone can look safe while correlated
  // futures notionals grow far beyond the account's loss-bearing capacity.
  const currentGrossNotional = active.reduce((sum, position) => sum + Math.abs(Number(position.contractNotional || position.notional || 0)), 0);
  const proposedNotional = Math.abs(Number(proposedOrder.contractNotional || 0));
  const projectedGrossNotional = currentGrossNotional + proposedNotional;
  const maxGrossNotional = capitalBase * (limits.maxGrossNotionalMultiple || 3.0);
  if (proposedNotional > 0 && projectedGrossNotional > maxGrossNotional) {
    return {
      approved: false,
      reason: `GROSS_NOTIONAL_EXCEEDED: Projected ₹${projectedGrossNotional} exceeds ₹${maxGrossNotional}`,
      currentGrossNotional,
      projectedGrossNotional,
      maxGrossNotional
    };
  }

  return {
    approved: true,
    reason: "APPROVED_BY_PORTFOLIO_RISK_ENGINE",
    currentMargin,
    projectedMargin,
    availableMargin: round(maxAllowedMargin - projectedMargin, 2),
    dailyNetPnl: round(dailyNetPnl, 2),
    currentGrossNotional: round(currentGrossNotional, 2),
    projectedGrossNotional: round(projectedGrossNotional, 2),
    maxGrossNotional: round(maxGrossNotional, 2),
    activeCount: active.length + 1
  };
}

module.exports = {
  DEFAULT_PORTFOLIO_LIMITS,
  evaluatePortfolioRisk
};
