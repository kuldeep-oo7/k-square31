"use strict";

/**
 * K-Square Range Desk - Shadow Trading Ledger
 *
 * Provides transactional, idempotent persistence for paper/shadow trades
 * across weekly and monthly expiry cycles.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { round } = require("./shadow-broker");

const LEDGER_PATH = path.resolve(__dirname, "../../data/shadow-ledger.json");

function loadShadowLedger() {
  try {
    if (fs.existsSync(LEDGER_PATH)) {
      return JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"));
    }
  } catch (err) {
    console.warn("Could not read shadow ledger, creating empty:", err.message);
  }
  return {
    version: "1.0.0",
    updatedAt: new Date().toISOString(),
    accountEquity: 1000000.0, // ₹10 Lakh initial paper capital
    availableMargin: 1000000.0,
    positions: [],
    closedTrades: [],
    contractNotes: []
  };
}

function saveShadowLedger(ledger) {
  ledger.updatedAt = new Date().toISOString();
  const dir = path.dirname(LEDGER_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2), "utf8");
}

function computeTradeId(symbol, contractSymbol, weekKey, side, level = 1) {
  return `SHD_${symbol}_${contractSymbol || "FUT"}_${weekKey}_L${level}_${side.toUpperCase()}`;
}

/**
 * Opens a new shadow position if not already present.
 */
function openShadowPosition(ledger, { orderIntent, fillDetails, weekKey, level = 1 }) {
  const tradeId = computeTradeId(
    orderIntent.symbol,
    orderIntent.contractSymbol,
    weekKey,
    orderIntent.side,
    level
  );

  // Idempotency check: do not duplicate active or closed trade with same key
  const exists = ledger.positions.some((p) => p.tradeId === tradeId) ||
                 ledger.closedTrades.some((c) => c.tradeId === tradeId);
  if (exists) {
    return { opened: false, tradeId, reason: "Position already exists in ledger" };
  }

  const marginRequired = Number(orderIntent.estMarginRequired) || round(fillDetails.fillPrice * fillDetails.quantity * 0.22);
  if (ledger.availableMargin < marginRequired) {
    return { opened: false, tradeId, reason: "Insufficient paper margin" };
  }

  const position = {
    tradeId,
    symbol: orderIntent.symbol,
    contractSymbol: orderIntent.contractSymbol,
    side: fillDetails.side,
    level,
    quantity: fillDetails.quantity,
    lotSize: fillDetails.lotSize,
    lots: fillDetails.lots,
    originalEntryPrice: fillDetails.fillPrice,
    weeklyReferencePrice: fillDetails.fillPrice,
    previousSettlementPrice: fillDetails.fillPrice,
    targetPrice: Number(orderIntent.targetPrice || orderIntent.target),
    stopLossPrice: Number(orderIntent.stopLossPrice || orderIntent.stopLoss),
    marginBlocked: marginRequired,
    slippagePaid: fillDetails.totalSlippageInr,
    entryFees: fillDetails.fees,
    holdingSessions: 1,
    weekendGapPnl: 0,
    currentUnrealizedPnl: 0,
    enteredAt: fillDetails.timestamp,
    anchorWeek: weekKey,
    status: "OPEN"
  };

  ledger.positions.push(position);
  ledger.availableMargin = round(ledger.availableMargin - marginRequired);

  return { opened: true, tradeId, position };
}

/**
 * Replaces weeklyReferencePrice on Monday without closing the position.
 */
function rebaseMondayPosition(position, mondayOpenPrice, newWeekKey) {
  const fridayClose = position.previousSettlementPrice || position.weeklyReferencePrice || position.originalEntryPrice;
  const isLong = position.side === "BUY";
  const weekendGap = isLong
    ? round((mondayOpenPrice - fridayClose) * position.quantity)
    : round((fridayClose - mondayOpenPrice) * position.quantity);

  position.weekendGapPnl = round(position.weekendGapPnl + weekendGap);
  position.weeklyReferencePrice = mondayOpenPrice;
  position.anchorWeek = newWeekKey;
  position.holdingSessions += 1;

  return {
    rebased: true,
    tradeId: position.tradeId,
    weekendGap,
    weeklyReferencePrice: mondayOpenPrice
  };
}

/**
 * Closes an active shadow position, calculates final taxes/fees, and produces trade record.
 */
function closeShadowPosition(ledger, { tradeId, exitFill, contractNote, reason }) {
  const idx = ledger.positions.findIndex((p) => p.tradeId === tradeId);
  if (idx === -1) return { closed: false, reason: "Position not found" };

  const pos = ledger.positions[idx];
  ledger.positions.splice(idx, 1);

  // Restore margin
  ledger.availableMargin = round(ledger.availableMargin + pos.marginBlocked);

  const netPnl = contractNote.breakdown.netRealizedPnl;
  ledger.accountEquity = round(ledger.accountEquity + netPnl);

  const closedRecord = {
    ...pos,
    status: "CLOSED",
    exitPrice: exitFill.fillPrice,
    exitTime: exitFill.timestamp,
    exitReason: reason,
    exitFees: exitFill.fees,
    contractNoteNumber: contractNote.contractNoteNumber,
    grossPnl: contractNote.breakdown.grossPnl,
    totalTaxesAndCharges: contractNote.breakdown.totalTaxesAndCharges,
    netRealizedPnl: netPnl,
    returnPct: contractNote.breakdown.returnOnTurnoverPct
  };

  ledger.closedTrades.push(closedRecord);
  ledger.contractNotes.push(contractNote);

  return { closed: true, closedRecord };
}

module.exports = {
  closeShadowPosition,
  computeTradeId,
  loadShadowLedger,
  openShadowPosition,
  rebaseMondayPosition,
  saveShadowLedger
};
