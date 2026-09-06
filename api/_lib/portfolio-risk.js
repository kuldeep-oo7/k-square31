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
  dailyLossLimitInr: 50000,       // ₹50,000 daily portfolio stop-loss kill switch
  killSwitchTriggered: false
});

/**
 * Validates a proposed order intent against firm-wide portfolio risk constraints.
 */
function evaluatePortfolioRisk({
  proposedOrder,
  activePositions = [],
  dailyRealizedPnl = 0,
  marketRegime = null,
  limits = DEFAULT_PORTFOLIO_LIMITS
}) {
  const active = Array.isArray(activePositions) ? activePositions : [];

  // 1. Daily Loss Kill-Switch
  if (dailyRealizedPnl <= -limits.dailyLossLimitInr || limits.killSwitchTriggered) {
    return {
      approved: false,
      reason: `KILL_SWITCH_ACTIVE: Daily realized loss (₹${Math.abs(dailyRealizedPnl)}) hit daily limit (₹${limits.dailyLossLimitInr})`,
      killSwitch: true
    };
  }

  // 2. Global Macro Shock Shield gating
  if (marketRegime?.regime === "BLOODBATH_DEFENSIVE" || marketRegime?.shieldState === "LOCKDOWN") {
    return {
      approved: false,
      reason: `MACRO_SHOCK_SHIELD: Trading halted due to severe macro crisis (${marketRegime?.shockReason || "Bloodbath market regime"})`,
      killSwitch: false
    };
  }

  if (!proposedOrder) {
    return { approved: false, reason: "NO_ORDER_INTENT" };
  }

  // 3. Maximum Open Positions Cap
  if (active.length >= limits.maxOpenPositions) {
    return {
      approved: false,
      reason: `PORTFOLIO_CONCENTRATION: Maximum open positions (${limits.maxOpenPositions}) reached. Active: ${active.length}`
    };
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
  const currentMargin = active.reduce((sum, p) => sum + Number(p.estMarginRequired || p.margin || 0), 0);
  const proposedMargin = Number(proposedOrder.estMarginRequired || 0);
  const projectedMargin = currentMargin + proposedMargin;
  const maxAllowedMargin = limits.maxTotalCapital * limits.maxMarginUtilizationPct;

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
  if (proposedRisk > limits.maxSingleNameRiskBudget * 1.2) { // 20% max tolerance
    return {
      approved: false,
      reason: `SINGLE_NAME_RISK_EXCEEDED: Order risk (₹${proposedRisk}) exceeds maximum position risk budget (₹${limits.maxSingleNameRiskBudget})`,
      proposedRisk,
      maxSingleNameRiskBudget: limits.maxSingleNameRiskBudget
    };
  }

  return {
    approved: true,
    reason: "APPROVED_BY_PORTFOLIO_RISK_ENGINE",
    currentMargin,
    projectedMargin,
    availableMargin: round(maxAllowedMargin - projectedMargin, 2),
    activeCount: active.length + 1
  };
}

module.exports = {
  DEFAULT_PORTFOLIO_LIMITS,
  evaluatePortfolioRisk
};
