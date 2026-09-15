"use strict";

/**
 * K-Square Range Desk - Shadow Broker Simulation & Contract Note Engine
 *
 * Models conservative NSE equity-futures execution and dated estimated charges.
 * It is not a broker acknowledgement and deliberately refuses to invent fills.
 */

const crypto = require("node:crypto");

function round(value, digits = 2) {
  if (!Number.isFinite(Number(value))) return 0;
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

/**
 * Estimates itemized stock-futures charges. STT is date-aware; other rates and
 * brokerage/clearing assumptions require verification against the actual tariff.
 *
 * Current Statutory Rates (as of 2026):
 * - Brokerage: Flat ₹20 per executed order (or 0.03% if turnover is very small)
 * - STT (Securities Transaction Tax): 0.05% on SELL side notional turnover (Finance Act rate, rounded to nearest rupee)
 *   (Dated support: 0.0125% prior to Oct 2024, 0.02% from Oct 2024 to Apr 2026, 0.05% from Apr 2026 onward)
 * - Exchange Turnover Fee (NSE): 0.00183% (0.0000183 of turnover; INR 182.99/crore + INR 0.01/crore IPFT from 2026-03-01)
 * - Clearing Charges: 0.0002% of turnover
 * - IPFT (Investor Protection Fund Trust): INR 0.01/crore from 2026-03-01
 */
function normalizeOrderSide(side) {
  const value = String(side || "").trim().toUpperCase();
  if (value === "BUY" || value === "LONG") return "BUY";
  if (value === "SELL" || value === "SHORT") return "SELL";
  return null;
}

function calculateNseFuturesCharges({ side, price, quantity, customBrokerage = 20, asOfDate = null, clearingRate = 0.000002 }) {
  const normalizedSide = normalizeOrderSide(side);
  if (!normalizedSide) throw new TypeError(`Unsupported futures order side: ${String(side)}`);
  const isBuy = normalizedSide === "BUY";
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
      ipft: 0,
      sebiCharges: 0,
      stampDuty: 0,
      gst: 0,
      totalCharges: 0,
      netAmount: 0
    };
  }

  // Brokerage: ₹20 flat or 0.03%
  const brokerage = round(Math.min(customBrokerage, turnover * 0.0003), 2);

  // STT rate with date schedule:
  // Pre-Oct 2024: 0.0125%
  // Oct 2024 - Mar 2026: 0.02%
  // Apr 2026+: 0.05%
  let sttRate = 0.0005; // 0.05% default
  if (asOfDate) {
    const d = new Date(asOfDate).toISOString().slice(0, 10);
    if (d < "2024-10-01") sttRate = 0.000125;
    else if (d < "2026-04-01") sttRate = 0.0002;
    else sttRate = 0.0005;
  }

  // STT: levied only on sell side for futures, rounded to nearest rupee per Indian tax rules
  const stt = !isBuy ? Math.round(turnover * sttRate) : 0;

  // Exchange turnover fee. NSE's published equity-futures outflow is
  // INR 182.99 per crore, with IPFT charged separately at INR 0.01 per crore --
  // INR 183.00 per crore in total. Charging a flat INR 183 here AND an IPFT line
  // on top double-counts the IPFT component, so the transaction charge carries
  // only its own 182.99 and IPFT is billed once, below.
  const exchangeRate = 0.000018299; // INR 182.99 / crore = 0.0018299%
  const exchangeCharges = round(turnover * exchangeRate, 2);

  // Clearing charges: 0.0002%
  const clearingCharges = round(turnover * (clearingRate !== undefined ? Number(clearingRate) : 0.000002), 2);

  // IPFT: INR 0.01 per crore. One crore is 1e7, so the decimal rate is
  // 0.01 / 1e7 = 1e-9. The previous 1e-7 was a hundredfold overstatement.
  // This is INR 0.00074 (0.074 paise) on INR 7.4 lakh of turnover.
  const ipftRate = 0.000000001;
  const ipft = round(turnover * ipftRate, 4);

  // SEBI charges: ₹10 per crore = 0.0001%
  const sebiCharges = round(turnover * 0.000001, 2);

  // Stamp duty: 0.002% only on buy side, rounded to nearest rupee
  const stampDuty = isBuy ? Math.round(turnover * 0.00002) : 0;

  // GST: 18% on (brokerage + exchange + sebi + ipft)
  const gstTaxable = brokerage + exchangeCharges + sebiCharges + ipft;
  const gst = round(gstTaxable * 0.18, 2);

  const totalCharges = round(
    brokerage + stt + exchangeCharges + clearingCharges + ipft + sebiCharges + stampDuty + gst,
    2
  );

  // Futures do not exchange full notional cash. This is the fee debit only;
  // collateral and variation margin are separate ledger movements.
  const netAmount = -totalCharges;

  return {
    turnover,
    brokerage,
    stt,
    sttRate,
    exchangeRate,
    exchangeCharges,
    clearingCharges,
    ipftRate,
    ipft,
    sebiCharges,
    stampDuty,
    gst,
    totalCharges,
    netAmount,
    chargeStatus: "ESTIMATE_REQUIRES_BROKER_TARIFF_RECONCILIATION"
  };
}

/**
 * Simulates realistic fill price and mechanics on an order intent.
 * Handles limit order price certainty (never fill worse than limit)
 * and models market execution on stop-loss exits.
 */
function simulateExecutionFill({ orderIntent, currentQuote = null, liquidityTier = "HIGH", asOfDate = null }) {
  if (!orderIntent) return null;
  const side = normalizeOrderSide(orderIntent.side);
  if (!side) {
    return { status: "REJECTED", reason: "MISSING_OR_INVALID_SIDE", orderIntent };
  }
  if (orderIntent.executable === false) {
    return { status: "REJECTED", reason: orderIntent.rejectionReason || "ORDER_NOT_EXECUTABLE", orderIntent };
  }
  const isBuy = side === "BUY";
  const limitPrice = Number(orderIntent.entryPrice || orderIntent.entry || 0);
  const orderType = String(orderIntent.orderType || "LIMIT").toUpperCase();
  const tickSize = Number(orderIntent.tickSize || 0.05);
  const lotSize = Number(orderIntent.lotSize);
  const quantity = Number(orderIntent.quantity);

  if (!String(orderIntent.clientOrderId || "").trim()) {
    return { status: "REJECTED", reason: "MISSING_CLIENT_ORDER_ID", orderIntent };
  }
  if (!String(orderIntent.contractSymbol || "").trim()) {
    return { status: "REJECTED", reason: "MISSING_CONTRACT_SYMBOL", orderIntent };
  }
  if (!(limitPrice > 0) || !(tickSize > 0)) {
    return { status: "REJECTED", reason: "INVALID_PRICE_OR_TICK", orderIntent };
  }
  if (!(lotSize > 0) || !(quantity > 0) || quantity % lotSize !== 0) {
    return { status: "REJECTED", reason: "INVALID_WHOLE_LOT_QUANTITY", orderIntent };
  }
  if (!currentQuote || typeof currentQuote !== "object") {
    return { status: "UNFILLED", reason: "TIMESTAMPED_MARKET_EVIDENCE_REQUIRED", orderIntent };
  }
  let quoteTimestamp = Number(currentQuote.timestamp);
  if (quoteTimestamp > 0 && quoteTimestamp < 10_000_000_000) quoteTimestamp *= 1000;
  if (!Number.isFinite(quoteTimestamp) || quoteTimestamp <= 0) {
    return { status: "UNFILLED", reason: "QUOTE_TIMESTAMP_REQUIRED", orderIntent };
  }
  if (asOfDate) {
    const expectedSession = new Date(asOfDate).toISOString().slice(0, 10);
    const quoteSession = new Date(quoteTimestamp).toISOString().slice(0, 10);
    if (quoteSession !== expectedSession) {
      return { status: "UNFILLED", reason: `STALE_QUOTE_SESSION:${quoteSession};EXPECTED:${expectedSession}`, orderIntent };
    }
  }

  let slippageTicks = 1;
  if (liquidityTier === "MID") slippageTicks = 2;
  if (liquidityTier === "LOW") slippageTicks = 4;
  const slippagePerShare = round(slippageTicks * tickSize, 2);

  let fillPrice = limitPrice;
  let status = "FILLED";

  if (orderType === "MARKET" || orderType === "STOP_MARKET") {
    const reference = Number(isBuy
      ? (currentQuote.ask ?? currentQuote.current ?? currentQuote.open ?? currentQuote.close ?? currentQuote.settlement)
      : (currentQuote.bid ?? currentQuote.current ?? currentQuote.open ?? currentQuote.close ?? currentQuote.settlement));
    if (!(reference > 0)) return { status: "UNFILLED", reason: "EXECUTABLE_MARKET_REFERENCE_REQUIRED", orderIntent };
    fillPrice = isBuy ? round(reference + slippagePerShare, 4) : round(reference - slippagePerShare, 4);
  } else {
    const low = Number(currentQuote.low);
    const high = Number(currentQuote.high);
    const open = Number(currentQuote.open);
    if (![low, high].every(Number.isFinite)) {
      return { status: "UNFILLED", reason: "LIMIT_ORDER_RANGE_EVIDENCE_REQUIRED", orderIntent };
    }
    if (isBuy) {
      const opensThrough = Number.isFinite(open) && open <= limitPrice;
      if (!opensThrough && !(low < limitPrice)) {
        return { status: "UNFILLED", reason: low === limitPrice ? "LIMIT_TOUCHED_QUEUE_UNPROVEN" : `MARKET_LOW_ABOVE_BUY_LIMIT:${low}`, orderIntent };
      }
      fillPrice = opensThrough ? Math.min(open, limitPrice) : limitPrice;
    } else {
      const opensThrough = Number.isFinite(open) && open >= limitPrice;
      if (!opensThrough && !(high > limitPrice)) {
        return { status: "UNFILLED", reason: high === limitPrice ? "LIMIT_TOUCHED_QUEUE_UNPROVEN" : `MARKET_HIGH_BELOW_SELL_LIMIT:${high}`, orderIntent };
      }
      fillPrice = opensThrough ? Math.max(open, limitPrice) : limitPrice;
    }
  }

  const fees = calculateNseFuturesCharges({
    side,
    price: fillPrice,
    quantity,
    asOfDate
  });

  const contractSymbol = orderIntent.contractSymbol;
  const clientOrderId = String(orderIntent.clientOrderId);
  const orderSeed = `${clientOrderId}:${contractSymbol}:${side}:${fillPrice}:${quantity}:${orderIntent.expiry || ""}`;
  const orderId = `ORD_${crypto.createHash("sha256").update(orderSeed).digest("hex").slice(0, 12).toUpperCase()}`;

  return {
    orderId,
    clientOrderId,
    status,
    contractSymbol,
    orderType,
    side,
    requestedPrice: limitPrice,
    fillPrice,
    slippagePerShare: orderType === "MARKET" || orderType === "STOP_MARKET" ? slippagePerShare : 0,
    totalSlippageInr: orderType === "MARKET" || orderType === "STOP_MARKET" ? round(slippagePerShare * quantity, 2) : 0,
    quantity,
    lotSize: orderIntent.lotSize,
    lots: orderIntent.lots,
    fees,
    timestamp: quoteTimestamp,
    quoteTimestamp,
    exchange: "NSE",
    segment: "F&O"
  };
}

/**
 * Generates an institutional, broker-compliant contract note for an executed shadow trade.
 */
function generateContractNote({ tradeId, entryFill, exitFill, contract, settlementDate = null }) {
  if (!entryFill || !exitFill || entryFill.status !== "FILLED" || exitFill.status !== "FILLED") return null;

  const noteNumber = `CN_${crypto.createHash("sha256").update(`${tradeId || entryFill.orderId}:${entryFill.orderId}:${exitFill.orderId}`).digest("hex").slice(0, 10).toUpperCase()}`;
  const totalBrokerage = round(entryFill.fees.brokerage + exitFill.fees.brokerage, 2);
  const totalStt = round(entryFill.fees.stt + exitFill.fees.stt, 2);
  const totalExchange = round(entryFill.fees.exchangeCharges + exitFill.fees.exchangeCharges, 2);
  const totalClearing = round(entryFill.fees.clearingCharges + exitFill.fees.clearingCharges, 2);
  const totalIpft = round(entryFill.fees.ipft + exitFill.fees.ipft, 4);
  const totalSebi = round(entryFill.fees.sebiCharges + exitFill.fees.sebiCharges, 2);
  const totalStampDuty = round(entryFill.fees.stampDuty + exitFill.fees.stampDuty, 2);
  const totalGst = round(entryFill.fees.gst + exitFill.fees.gst, 2);

  const totalCharges = round(
    totalBrokerage + totalStt + totalExchange + totalClearing + totalIpft + totalSebi + totalStampDuty + totalGst,
    2
  );

  const isLong = entryFill.side === "BUY";
  const grossPnl = isLong
    ? round((exitFill.fillPrice - entryFill.fillPrice) * entryFill.quantity, 2)
    : round((entryFill.fillPrice - exitFill.fillPrice) * entryFill.quantity, 2);

  const netPnl = round(grossPnl - totalCharges, 2);
  const returnOnTurnoverPct = round((netPnl / entryFill.fees.turnover) * 100, 3);
  const estMarginRequired = Number(contract?.currentMarginRequired || contract?.estMarginRequired)
    || round(entryFill.fees.turnover * (Number(contract?.marginPct) || 0.22), 2);
  const marginPct = round(estMarginRequired / Math.max(1, entryFill.fees.turnover), 6);
  const returnOnMarginPct = round((netPnl / Math.max(1, estMarginRequired)) * 100, 2);

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
    marginPct,
    estMarginRequired,
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
      ipft: totalIpft,
      sebiTurnoverCharges: totalSebi,
      stampDuty: totalStampDuty,
      gst: totalGst,
      totalTaxesAndCharges: totalCharges,
      netRealizedPnl: netPnl,
      estMarginRequired,
      returnOnMarginPct,
      returnOnTurnoverPct
    }
  };
}

module.exports = {
  calculateNseFuturesCharges,
  generateContractNote,
  normalizeOrderSide,
  round,
  simulateExecutionFill
};
