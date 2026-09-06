"use strict";

/**
 * K-Square Range Desk - Shadow Broker Simulation & Contract Note Engine
 *
 * Models authentic NSE Equity Futures execution, tick slippage, and exact
 * regulatory charges as published by SEBI, NSE, and leading Indian brokers (Zerodha/Groww).
 */

const crypto = require("node:crypto");

function round(value, digits = 2) {
  if (!Number.isFinite(Number(value))) return 0;
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

/**
 * Computes exact NSE F&O regulatory fees and broker charges for individual stock futures.
 *
 * Rates:
 * - Brokerage: Flat ₹20 per executed order (or 0.03% if turnover is very small)
 * - STT (Securities Transaction Tax): 0.02% on SELL side notional turnover (rounded to nearest rupee)
 * - Exchange Turnover Fee (NSE): 0.0019% of turnover
 * - Clearing Charges: 0.0002% of turnover
 * - GST: 18% on (Brokerage + Exchange Charges + SEBI Charges)
 * - SEBI Turnover Charges: ₹10 per crore (0.0001% of turnover)
 * - Stamp Duty: 0.002% on BUY side notional turnover (rounded to nearest rupee)
 */
function calculateNseFuturesCharges({ side, price, quantity, customBrokerage = 20 }) {
  const isBuy = String(side).toLowerCase() === "buy" || String(side).toLowerCase() === "long";
  const p = Number(price) || 0;
  const q = Number(quantity) || 0;
  const turnover = round(p * q, 2);

  if (turnover <= 0) {
    return {
      turnover: 0,
      brokerage: 0,
      stt: 0,
      exchangeCharges: 0,
      clearingCharges: 0,
      sebiCharges: 0,
      stampDuty: 0,
      gst: 0,
      totalCharges: 0,
      netAmount: 0
    };
  }

  // Brokerage: ₹20 flat or 0.03%
  const brokerage = round(Math.min(customBrokerage, turnover * 0.0003), 2);

  // STT: 0.02% only on sell side, rounded to nearest rupee per Indian tax rules
  const stt = !isBuy ? Math.round(turnover * 0.0002) : 0;

  // Exchange turnover fee: 0.0019%
  const exchangeCharges = round(turnover * 0.000019, 2);

  // Clearing charges: 0.0002%
  const clearingCharges = round(turnover * 0.000002, 2);

  // SEBI charges: ₹10 per crore = 0.0001%
  const sebiCharges = round(turnover * 0.000001, 2);

  // Stamp duty: 0.002% only on buy side, rounded to nearest rupee
  const stampDuty = isBuy ? Math.round(turnover * 0.00002) : 0;

  // GST: 18% on (brokerage + exchange + sebi)
  const gstTaxable = brokerage + exchangeCharges + sebiCharges;
  const gst = round(gstTaxable * 0.18, 2);

  const totalCharges = round(
    brokerage + stt + exchangeCharges + clearingCharges + sebiCharges + stampDuty + gst,
    2
  );

  // Net cash flow:
  // For BUY: you pay (turnover + totalCharges)
  // For SELL: you receive (turnover - totalCharges)
  const netAmount = isBuy
    ? round(turnover + totalCharges, 2)
    : round(turnover - totalCharges, 2);

  return {
    turnover,
    brokerage,
    stt,
    exchangeCharges,
    clearingCharges,
    sebiCharges,
    stampDuty,
    gst,
    totalCharges,
    netAmount
  };
}

/**
 * Simulates realistic fill price and slippage on an order intent.
 */
function simulateExecutionFill({ orderIntent, currentQuote = null, liquidityTier = "HIGH" }) {
  if (!orderIntent) return null;
  const side = orderIntent.side;
  const isBuy = side === "buy" || side === "long";
  const limitPrice = Number(orderIntent.entryPrice || orderIntent.entry || 0);
  const tickSize = Number(orderIntent.tickSize || 0.05);

  // Determine tick slippage based on liquidity
  let slippageTicks = 1;
  if (liquidityTier === "MID") slippageTicks = 2;
  if (liquidityTier === "LOW") slippageTicks = 4;

  const slippagePerShare = round(slippageTicks * tickSize, 2);
  const fillPrice = isBuy
    ? round(limitPrice + slippagePerShare, 2)
    : round(limitPrice - slippagePerShare, 2);

  const quantity = Number(orderIntent.quantity || (orderIntent.lots || 1) * (orderIntent.lotSize || 100));
  const fees = calculateNseFuturesCharges({
    side: isBuy ? "buy" : "sell",
    price: fillPrice,
    quantity
  });

  return {
    orderId: `ORD_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    status: "FILLED",
    contractSymbol: orderIntent.contractSymbol || orderIntent.symbol,
    side: isBuy ? "BUY" : "SELL",
    requestedPrice: limitPrice,
    fillPrice,
    slippagePerShare,
    totalSlippageInr: round(slippagePerShare * quantity, 2),
    quantity,
    lotSize: orderIntent.lotSize,
    lots: orderIntent.lots,
    fees,
    timestamp: Date.now(),
    exchange: "NSE",
    segment: "F&O"
  };
}

/**
 * Generates an institutional, broker-compliant contract note for an executed shadow trade.
 */
function generateContractNote({ tradeId, entryFill, exitFill, contract, settlementDate = null }) {
  if (!entryFill || !exitFill) return null;

  const noteNumber = `CN_${Date.now()}_${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
  const totalBrokerage = round(entryFill.fees.brokerage + exitFill.fees.brokerage, 2);
  const totalStt = round(entryFill.fees.stt + exitFill.fees.stt, 2);
  const totalExchange = round(entryFill.fees.exchangeCharges + exitFill.fees.exchangeCharges, 2);
  const totalClearing = round(entryFill.fees.clearingCharges + exitFill.fees.clearingCharges, 2);
  const totalSebi = round(entryFill.fees.sebiCharges + exitFill.fees.sebiCharges, 2);
  const totalStampDuty = round(entryFill.fees.stampDuty + exitFill.fees.stampDuty, 2);
  const totalGst = round(entryFill.fees.gst + exitFill.fees.gst, 2);

  const totalCharges = round(
    totalBrokerage + totalStt + totalExchange + totalClearing + totalSebi + totalStampDuty + totalGst,
    2
  );

  const isLong = entryFill.side === "BUY";
  const grossPnl = isLong
    ? round((exitFill.fillPrice - entryFill.fillPrice) * entryFill.quantity, 2)
    : round((entryFill.fillPrice - exitFill.fillPrice) * entryFill.quantity, 2);

  const netPnl = round(grossPnl - totalCharges, 2);
  const returnOnTurnoverPct = round((netPnl / entryFill.fees.turnover) * 100, 3);

  return {
    contractNoteNumber: noteNumber,
    tradeId: tradeId || entryFill.orderId,
    exchange: "NSE",
    segment: "F&O",
    settlementDate: settlementDate || new Date().toISOString().slice(0, 10),
    contractSymbol: entryFill.contractSymbol,
    expiry: contract?.expiry || "NEAR",
    lotSize: entryFill.lotSize,
    quantity: entryFill.quantity,
    entry: {
      orderId: entryFill.orderId,
      side: entryFill.side,
      price: entryFill.fillPrice,
      turnover: entryFill.fees.turnover,
      timestamp: entryFill.timestamp
    },
    exit: {
      orderId: exitFill.orderId,
      side: exitFill.side,
      price: exitFill.fillPrice,
      turnover: exitFill.fees.turnover,
      timestamp: exitFill.timestamp
    },
    breakdown: {
      grossPnl,
      brokerage: totalBrokerage,
      stt: totalStt,
      exchangeTurnoverCharges: totalExchange,
      clearingCharges: totalClearing,
      sebiTurnoverCharges: totalSebi,
      stampDuty: totalStampDuty,
      gst: totalGst,
      totalTaxesAndCharges: totalCharges,
      netRealizedPnl: netPnl,
      returnOnTurnoverPct
    }
  };
}

module.exports = {
  calculateNseFuturesCharges,
  generateContractNote,
  round,
  simulateExecutionFill
};
