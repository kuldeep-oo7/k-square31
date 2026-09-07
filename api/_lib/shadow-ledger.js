"use strict";

/**
 * Transactional paper ledger for NSE stock futures.
 *
 * Three prices are deliberately separate:
 *   originalEntryPrice       immutable trade economics
 *   previousSettlementPrice daily variation-margin reference
 *   weeklyReferencePrice     Monday reporting attribution only
 */

const fs = require("node:fs");
const path = require("node:path");
const { round, normalizeOrderSide } = require("./shadow-broker");

const LEDGER_PATH = path.resolve(__dirname, "../../data/shadow-ledger.json");

function emptyShadowLedger(initialEquity = 1_000_000) {
  return {
    version: "2.0.0",
    updatedAt: new Date().toISOString(),
    initialEquity: round(initialEquity, 2),
    accountEquity: round(initialEquity, 2),
    availableMargin: round(initialEquity, 2),
    accounting: {
      externalFlows: 0,
      cumulativeVariationPnl: 0,
      cumulativeChargesPaid: 0,
      migrationAdjustment: 0
    },
    killSwitch: { triggered: false, reason: null, triggeredAt: null },
    positions: [],
    closedTrades: [],
    contractNotes: [],
    settlements: [],
    auditEvents: []
  };
}

function normalizeLedger(raw) {
  const base = emptyShadowLedger(Number(raw?.initialEquity || raw?.accountEquity) || 1_000_000);
  const ledger = { ...base, ...(raw || {}) };
  ledger.positions = Array.isArray(ledger.positions) ? ledger.positions : [];
  ledger.closedTrades = Array.isArray(ledger.closedTrades) ? ledger.closedTrades : [];
  ledger.contractNotes = Array.isArray(ledger.contractNotes) ? ledger.contractNotes : [];
  ledger.settlements = Array.isArray(ledger.settlements) ? ledger.settlements : [];
  ledger.auditEvents = Array.isArray(ledger.auditEvents) ? ledger.auditEvents : [];
  ledger.killSwitch = { ...base.killSwitch, ...(ledger.killSwitch || {}) };
  ledger.accounting = { ...base.accounting, ...(ledger.accounting || {}) };
  const expectedWithoutMigration = Number(ledger.initialEquity)
    + Number(ledger.accounting.externalFlows || 0)
    + Number(ledger.accounting.cumulativeVariationPnl || 0)
    - Number(ledger.accounting.cumulativeChargesPaid || 0);
  if (Math.abs(expectedWithoutMigration + Number(ledger.accounting.migrationAdjustment || 0) - Number(ledger.accountEquity)) > 0.011) {
    ledger.accounting.migrationAdjustment = round(Number(ledger.accountEquity) - expectedWithoutMigration, 2);
  }
  ledger.version = "2.0.0";
  recomputeAvailableMargin(ledger);
  return ledger;
}

function loadShadowLedger(filePath = LEDGER_PATH) {
  try {
    if (fs.existsSync(filePath)) return normalizeLedger(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch (err) {
    throw new Error(`Could not read shadow ledger: ${err.message}`);
  }
  return emptyShadowLedger();
}

function saveShadowLedger(ledger, filePath = LEDGER_PATH) {
  const normalized = normalizeLedger(ledger);
  normalized.updatedAt = new Date().toISOString();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(normalized, null, 2), "utf8");
  fs.renameSync(tempPath, filePath);
  Object.assign(ledger, normalized);
}

function appendAuditEvent(ledger, event) {
  ledger.auditEvents ||= [];
  ledger.auditEvents.push({ ...event, recordedAt: event.recordedAt || new Date().toISOString() });
  if (ledger.auditEvents.length > 10_000) ledger.auditEvents = ledger.auditEvents.slice(-10_000);
}

function ensureAccounting(ledger) {
  if (ledger.initialEquity === undefined) ledger.initialEquity = Number(ledger.accountEquity || 0);
  ledger.accounting ||= { externalFlows: 0, cumulativeVariationPnl: 0, cumulativeChargesPaid: 0, migrationAdjustment: 0 };
  return ledger.accounting;
}

function recomputeAvailableMargin(ledger) {
  const blocked = (Array.isArray(ledger.positions) ? ledger.positions : [])
    .reduce((sum, position) => sum + Math.max(0, Number(position.marginBlocked) || 0), 0);
  ledger.availableMargin = round(Math.max(0, Number(ledger.accountEquity || 0) - blocked), 2);
  return ledger.availableMargin;
}

function accountReconciliation(ledger) {
  const accounting = ledger.accounting || {};
  const expectedEquity = round(
    Number(ledger.initialEquity || 0)
      + Number(accounting.externalFlows || 0)
      + Number(accounting.cumulativeVariationPnl || 0)
      - Number(accounting.cumulativeChargesPaid || 0)
      + Number(accounting.migrationAdjustment || 0),
    2
  );
  const difference = round(Number(ledger.accountEquity || 0) - expectedEquity, 2);
  return { reconciled: Math.abs(difference) <= 0.01, expectedEquity, actualEquity: Number(ledger.accountEquity), difference };
}

function positionReconciliation(position, markPrice = null) {
  const mark = Number(markPrice || position.previousSettlementPrice);
  const sign = positionSign(position);
  const lifetimeGrossPnl = round((mark - Number(position.originalEntryPrice)) * Number(position.quantity) * sign, 2);
  const attributedPnl = round(
    Number(position.completedWeeklyPnl || 0)
      + Number(position.weekendGapPnl || 0)
      + (mark - Number(position.weeklyReferencePrice)) * Number(position.quantity) * sign,
    2
  );
  const difference = round(lifetimeGrossPnl - attributedPnl, 2);
  return { reconciled: Math.abs(difference) <= 0.01, lifetimeGrossPnl, attributedPnl, difference };
}

function computeTradeId(symbol, contractSymbol, weekKey, side, level = 1, clientOrderId = null) {
  const normalized = normalizeOrderSide(side);
  const base = `SHD_${String(symbol || "").toUpperCase()}_${contractSymbol || "FUT"}_${weekKey}_L${level}_${normalized || "INVALID"}`;
  return clientOrderId ? `${base}_${clientOrderId}` : base;
}

function positionSign(position) {
  return normalizeOrderSide(position.side) === "BUY" ? 1 : -1;
}

function openShadowPosition(ledger, { orderIntent, fillDetails, weekKey, level = 1 }) {
  ensureAccounting(ledger);
  if (orderIntent?.executable === false) return { opened: false, reason: orderIntent?.rejectionReason || "ORDER_NOT_EXECUTABLE" };
  if (!fillDetails || fillDetails.status !== "FILLED") return { opened: false, reason: fillDetails?.reason || "NO_CONFIRMED_FILL" };
  const intentSide = normalizeOrderSide(orderIntent.side);
  if (!intentSide || fillDetails.side !== intentSide) return { opened: false, reason: "INTENT_FILL_SIDE_MISMATCH" };
  if (String(orderIntent.contractSymbol) !== String(fillDetails.contractSymbol)) return { opened: false, reason: "INTENT_FILL_CONTRACT_MISMATCH" };

  const tradeId = computeTradeId(
    orderIntent.symbol,
    orderIntent.contractSymbol,
    weekKey,
    orderIntent.side,
    level,
    orderIntent.clientOrderId
  );
  const exists = ledger.positions.some((position) => position.tradeId === tradeId || position.entryOrderId === fillDetails.orderId)
    || ledger.closedTrades.some((trade) => trade.tradeId === tradeId || trade.entryOrderId === fillDetails.orderId);
  if (exists) return { opened: false, tradeId, reason: "Position already exists in ledger" };

  const marginRequired = Number(orderIntent.estMarginRequired) || round(fillDetails.fillPrice * fillDetails.quantity * 0.22);
  const entryCharges = Number(fillDetails.fees?.totalCharges || 0);
  if (!(marginRequired > 0)) return { opened: false, tradeId, reason: "MARGIN_OR_ENTRY_FEES_UNAVAILABLE" };
  if (ledger.availableMargin < marginRequired) return { opened: false, tradeId, reason: "Insufficient paper margin" };

  const position = {
    tradeId,
    entryOrderId: fillDetails.orderId,
    clientOrderId: orderIntent.clientOrderId,
    strategyVersion: orderIntent.strategyVersion,
    symbol: orderIntent.symbol,
    sector: orderIntent.sector,
    contractSymbol: orderIntent.contractSymbol,
    instrumentId: orderIntent.instrumentId || null,
    expiry: orderIntent.expiry,
    side: fillDetails.side,
    level,
    quantity: fillDetails.quantity,
    lotSize: fillDetails.lotSize,
    lots: fillDetails.lots,
    tickSize: Number(orderIntent.tickSize),
    contractNotional: round(fillDetails.fillPrice * fillDetails.quantity, 2),
    originalEntryPrice: fillDetails.fillPrice,
    weeklyReferencePrice: fillDetails.fillPrice,
    previousSettlementPrice: fillDetails.fillPrice,
    previousFridaySettlementPrice: null,
    targetPrice: Number(orderIntent.targetPrice || orderIntent.target),
    runnerTargetPrice: Number(orderIntent.runnerTargetPrice) || null,
    stopLossPrice: Number(orderIntent.stopLossPrice || orderIntent.stopLoss),
    marginBlocked: marginRequired,
    marginSource: orderIntent.marginSource || "UNKNOWN",
    slippagePaid: fillDetails.totalSlippageInr,
    entryFees: fillDetails.fees,
    entryFeesPaid: entryCharges,
    exitFeesPaid: 0,
    cumulativeVariationPnl: 0,
    lifetimeGrossPnl: 0,
    lifetimeNetPnl: round(-entryCharges, 2),
    holdingSessions: 0,
    lastSettledSession: null,
    weekendGapPnl: 0,
    completedWeeklyPnl: 0,
    weeklyPnl: 0,
    currentUnrealizedPnl: 0,
    enteredAt: fillDetails.timestamp,
    anchorWeek: weekKey,
    status: "OPEN",
    entryFill: fillDetails
  };

  ledger.positions.push(position);
  ledger.availableMargin = round(ledger.availableMargin - marginRequired, 2);
  appendAuditEvent(ledger, {
    type: "POSITION_OPENED",
    tradeId,
    orderId: fillDetails.orderId,
    symbol: position.symbol,
    side: position.side,
    quantity: position.quantity,
    price: position.originalEntryPrice,
    accountEquity: ledger.accountEquity
  });
  return { opened: true, tradeId, position };
}

function settleShadowPosition(ledger, { tradeId, settlementPrice, session, source = "NSE_DAILY_SETTLEMENT" }) {
  ensureAccounting(ledger);
  const position = ledger.positions.find((item) => item.tradeId === tradeId);
  if (!position) return { settled: false, reason: "Position not found" };
  const price = Number(settlementPrice);
  if (!(price > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(String(session || ""))) return { settled: false, reason: "INVALID_SETTLEMENT" };
  if (position.lastSettledSession === session) return { settled: false, reason: "ALREADY_SETTLED", idempotent: true };
  if (position.lastSettledSession && position.lastSettledSession > session) return { settled: false, reason: "OUT_OF_ORDER_SETTLEMENT" };

  const sign = positionSign(position);
  const previous = Number(position.previousSettlementPrice);
  const variationPnl = round((price - previous) * position.quantity * sign, 2);
  position.cumulativeVariationPnl = round(Number(position.cumulativeVariationPnl || 0) + variationPnl, 2);
  position.previousSettlementPrice = price;
  position.lastSettledSession = session;
  position.holdingSessions = Number(position.holdingSessions || 0) + 1;
  position.lifetimeGrossPnl = round((price - position.originalEntryPrice) * position.quantity * sign, 2);
  position.currentUnrealizedPnl = position.lifetimeGrossPnl;
  position.weeklyPnl = round((price - position.weeklyReferencePrice) * position.quantity * sign, 2);
  position.lifetimeNetPnl = round(position.lifetimeGrossPnl - Number(position.entryFeesPaid || 0), 2);
  ledger.accountEquity = round(Number(ledger.accountEquity) + variationPnl, 2);
  ledger.accounting.cumulativeVariationPnl = round(Number(ledger.accounting.cumulativeVariationPnl || 0) + variationPnl, 2);
  ledger.settlements.push({ tradeId, symbol: position.symbol, session, previousSettlementPrice: previous, settlementPrice: price, variationPnl, source });
  recomputeAvailableMargin(ledger);
  appendAuditEvent(ledger, { type: "DAILY_SETTLEMENT", tradeId, session, price, variationPnl, accountEquity: ledger.accountEquity });
  const positionCheck = positionReconciliation(position, price);
  const accountCheck = accountReconciliation(ledger);
  if (!positionCheck.reconciled || !accountCheck.reconciled) {
    triggerKillSwitch(ledger, `ACCOUNTING_RECONCILIATION_BREAK:${tradeId}:${session}`);
  }
  return { settled: true, tradeId, session, variationPnl, accountEquity: ledger.accountEquity, positionCheck, accountCheck };
}

// Monday changes reporting attribution only. No fill, quantity, original entry,
// variation margin, realized P&L, fees or account equity is changed.
function rebaseMondayPosition(position, mondayOpenPrice, newWeekKey) {
  const price = Number(mondayOpenPrice);
  if (!(price > 0) || !newWeekKey) return { rebased: false, reason: "INVALID_MONDAY_REFERENCE" };
  if (position.anchorWeek === newWeekKey) return { rebased: false, reason: "ALREADY_REBASED", idempotent: true };
  const fridayClose = Number(position.previousFridaySettlementPrice || position.previousSettlementPrice || position.weeklyReferencePrice || position.originalEntryPrice);
  const completedWeek = round((fridayClose - Number(position.weeklyReferencePrice)) * Number(position.quantity) * positionSign(position), 2);
  position.completedWeeklyPnl = round(Number(position.completedWeeklyPnl || 0) + completedWeek, 2);
  const weekendGap = round((price - fridayClose) * position.quantity * positionSign(position), 2);
  position.weekendGapPnl = round(Number(position.weekendGapPnl || 0) + weekendGap, 2);
  position.previousWeekClose = fridayClose;
  position.weeklyReferencePrice = price;
  position.weeklyPnl = 0;
  position.anchorWeek = newWeekKey;
  const positionCheck = positionReconciliation(position, price);
  return { rebased: true, tradeId: position.tradeId, completedWeek, weekendGap, weeklyReferencePrice: price, positionCheck };
}

function recordFridaySettlement(position, settlementPrice, session) {
  const price = Number(settlementPrice);
  if (!(price > 0)) return { recorded: false, reason: "INVALID_FRIDAY_SETTLEMENT" };
  position.previousFridaySettlementPrice = price;
  position.fridaySettlementSession = session || null;
  return { recorded: true, tradeId: position.tradeId, settlementPrice: price };
}

function closeShadowPosition(ledger, { tradeId, exitFill, contractNote, reason }) {
  ensureAccounting(ledger);
  const idx = ledger.positions.findIndex((position) => position.tradeId === tradeId);
  if (idx === -1) return { closed: false, reason: "Position not found" };
  const position = ledger.positions[idx];
  if (!exitFill || exitFill.status !== "FILLED" || !contractNote) return { closed: false, reason: "CONFIRMED_EXIT_FILL_AND_CONTRACT_NOTE_REQUIRED" };
  if (exitFill.side === position.side) return { closed: false, reason: "EXIT_SIDE_MUST_OFFSET_POSITION" };

  const sign = positionSign(position);
  const finalVariationPnl = round((exitFill.fillPrice - Number(position.previousSettlementPrice)) * position.quantity * sign, 2);
  const exitFees = Number(exitFill.fees?.totalCharges || 0);
  const lifetimeGrossPnl = round((exitFill.fillPrice - position.originalEntryPrice) * position.quantity * sign, 2);
  const totalFees = round(Number(position.entryFeesPaid || 0) + exitFees, 2);
  const netPnl = round(lifetimeGrossPnl - totalFees, 2);

  ledger.availableMargin = round(ledger.availableMargin + position.marginBlocked, 2);
  const alreadySettled = Number(position.cumulativeVariationPnl || 0);
  const remainingEquityChange = round(netPnl - alreadySettled, 2);
  ledger.accountEquity = round(Number(ledger.accountEquity) + remainingEquityChange, 2);
  const variationPnlToAdd = round(lifetimeGrossPnl - alreadySettled, 2);
  ledger.accounting.cumulativeVariationPnl = round(Number(ledger.accounting.cumulativeVariationPnl || 0) + variationPnlToAdd, 2);
  ledger.accounting.cumulativeChargesPaid = round(Number(ledger.accounting.cumulativeChargesPaid || 0) + totalFees, 2);
  ledger.positions.splice(idx, 1);

  const closedRecord = {
    ...position,
    status: "CLOSED",
    exitOrderId: exitFill.orderId,
    exitPrice: exitFill.fillPrice,
    exitTime: exitFill.timestamp,
    exitReason: reason,
    exitFees: exitFill.fees,
    exitFeesPaid: exitFees,
    contractNoteNumber: contractNote.contractNoteNumber,
    grossPnl: lifetimeGrossPnl,
    totalTaxesAndCharges: totalFees,
    netRealizedPnl: netPnl,
    cumulativeVariationPnl: round(Number(position.cumulativeVariationPnl || 0) + finalVariationPnl, 2),
    finalWeeklyPnl: round((exitFill.fillPrice - Number(position.weeklyReferencePrice)) * Number(position.quantity) * sign, 2),
    returnPct: contractNote.breakdown.returnOnTurnoverPct
  };
  closedRecord.positionReconciliation = positionReconciliation(position, exitFill.fillPrice);
  closedRecord.accountReconciliation = accountReconciliation(ledger);
  closedRecord.contractNoteDifference = round(Number(contractNote.breakdown.netRealizedPnl) - netPnl, 2);
  if (!closedRecord.positionReconciliation.reconciled || !closedRecord.accountReconciliation.reconciled || Math.abs(closedRecord.contractNoteDifference) > 0.01) {
    triggerKillSwitch(ledger, `CLOSE_RECONCILIATION_BREAK:${tradeId}`);
  }
  ledger.closedTrades.push(closedRecord);
  ledger.contractNotes.push(contractNote);
  appendAuditEvent(ledger, {
    type: "POSITION_CLOSED",
    tradeId,
    orderId: exitFill.orderId,
    reason,
    price: exitFill.fillPrice,
    netRealizedPnl: netPnl,
    accountEquity: ledger.accountEquity
  });
  return { closed: true, closedRecord };
}

function triggerKillSwitch(ledger, reason) {
  ledger.killSwitch = { triggered: true, reason: String(reason || "MANUAL"), triggeredAt: new Date().toISOString() };
  appendAuditEvent(ledger, { type: "KILL_SWITCH_TRIGGERED", reason: ledger.killSwitch.reason });
  return ledger.killSwitch;
}

module.exports = {
  LEDGER_PATH,
  appendAuditEvent,
  accountReconciliation,
  closeShadowPosition,
  computeTradeId,
  emptyShadowLedger,
  loadShadowLedger,
  normalizeLedger,
  openShadowPosition,
  positionReconciliation,
  rebaseMondayPosition,
  recomputeAvailableMargin,
  recordFridaySettlement,
  saveShadowLedger,
  settleShadowPosition,
  triggerKillSwitch
};
