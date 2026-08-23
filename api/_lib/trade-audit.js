"use strict";

function round(value, digits = 2) {
  if (!Number.isFinite(Number(value))) return null;
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function auditPurchases(lots = [], recommendations = []) {
  const recMap = new Map();
  (Array.isArray(recommendations) ? recommendations : []).forEach((rec) => {
    if (rec?.symbol) recMap.set(String(rec.symbol).toUpperCase(), rec);
  });

  const audited = (Array.isArray(lots) ? lots : []).map((lot) => {
    const symbol = String(lot.symbol || "").toUpperCase();
    const rec = recMap.get(symbol) || null;
    const actualBuyPrice = Number(lot.buyAverage) || Number(lot.price) || 0;
    const quantity = Number(lot.quantity) || 0;
    const markPrice = Number(lot.markPrice) || Number(lot.mark) || actualBuyPrice;
    const side = lot.position === "short" ? "short" : "long";

    const modelEntry = rec?.entries?.[0]?.entry || Number(rec?.anchor) || null;
    const modelTarget = rec?.entries?.[0]?.target || (modelEntry ? (side === "short" ? modelEntry * 0.98 : modelEntry * 1.02) : null);
    const modelStop = rec?.entries?.[0]?.stopLoss || (modelEntry ? (side === "short" ? modelEntry * 1.01 : modelEntry * 0.99) : null);

    const onBuyList = Boolean(rec && rec.action !== "stand-aside");
    const slippagePct = modelEntry && actualBuyPrice > 0
      ? ((actualBuyPrice - modelEntry) / modelEntry) * 100
      : null;

    const investedCost = actualBuyPrice * quantity;
    const currentMarketValue = markPrice * quantity;
    const openPnl = side === "short"
      ? (actualBuyPrice - markPrice) * quantity
      : (markPrice - actualBuyPrice) * quantity;
    const openPnlPct = investedCost > 0 ? (openPnl / investedCost) * 100 : 0;

    let tradeHealth = "NEUTRAL";
    if (modelTarget && ((side === "long" && markPrice >= modelTarget) || (side === "short" && markPrice <= modelTarget))) {
      tradeHealth = "TARGET_REACHED";
    } else if (modelStop && ((side === "long" && markPrice <= modelStop) || (side === "short" && markPrice >= modelStop))) {
      tradeHealth = "STOP_TRIGGERED";
    } else if (openPnl > 0) {
      tradeHealth = "IN_PROFIT";
    } else if (openPnl < 0) {
      tradeHealth = "DRAWDOWN";
    }

    return {
      symbol,
      side,
      onBuyList,
      quantity,
      actualBuyPrice: round(actualBuyPrice),
      modelEntryPrice: round(modelEntry),
      slippagePct: round(slippagePct, 2),
      modelTargetPrice: round(modelTarget),
      modelStopLossPrice: round(modelStop),
      currentMarkPrice: round(markPrice),
      investedCost: round(investedCost),
      currentMarketValue: round(currentMarketValue),
      openPnl: round(openPnl),
      openPnlPct: round(openPnlPct, 2),
      tradeHealth,
      recommendationConviction: rec?.convictionPct ?? null,
      recommendationReason: rec?.reasons?.[0] || (onBuyList ? "Qualified momentum setup" : "Off-plan / Discretionary trade")
    };
  });

  const totalCost = audited.reduce((sum, item) => sum + item.investedCost, 0);
  const totalVal = audited.reduce((sum, item) => sum + item.currentMarketValue, 0);
  const totalPnl = totalVal - totalCost;
  const compliantTrades = audited.filter((item) => item.onBuyList).length;
  const complianceRatePct = audited.length ? (compliantTrades / audited.length) * 100 : 0;

  return {
    items: audited,
    summary: {
      totalPositions: audited.length,
      compliantPositions: compliantTrades,
      offPlanPositions: audited.length - compliantTrades,
      complianceRatePct: round(complianceRatePct, 1),
      totalInvestedCost: round(totalCost),
      totalMarketValue: round(totalVal),
      totalOpenPnl: round(totalPnl),
      totalOpenPnlPct: round(totalCost > 0 ? (totalPnl / totalCost) * 100 : 0, 2),
      targetsReached: audited.filter((item) => item.tradeHealth === "TARGET_REACHED").length,
      stopsTriggered: audited.filter((item) => item.tradeHealth === "STOP_TRIGGERED").length
    }
  };
}

module.exports = {
  auditPurchases,
  round
};
