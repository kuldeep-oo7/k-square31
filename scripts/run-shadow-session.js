"use strict";

/**
 * Production-path shadow execution session.
 *
 * This file is deliberately dependency-injectable so the exact same runner can
 * be exercised with deterministic exchange fixtures. It never submits a real
 * broker order. A live adapter must remain disabled until broker, regulatory,
 * reconciliation and canary gates are independently approved.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  appendAuditEvent,
  closeShadowPosition,
  loadShadowLedger,
  openShadowPosition,
  rebaseMondayPosition,
  recordFridaySettlement,
  saveShadowLedger,
  settleShadowPosition,
  triggerKillSwitch
} = require("../api/_lib/shadow-ledger");
const {
  generateContractNote,
  normalizeOrderSide,
  round,
  simulateExecutionFill
} = require("../api/_lib/shadow-broker");
const { banStateForSession, fetchSecurityBanList, latestBhavcopy, stockFuturesBySymbol } = require("../api/_lib/bhavcopy");
const { evaluatePortfolioRisk, DEFAULT_PORTFOLIO_LIMITS } = require("../api/_lib/portfolio-risk");
const { evaluateGlobalMacroShock } = require("../api/_lib/market-regime");
const { fetchLiveMacroRadar, macroInputFromRadar } = require("../api/_lib/market-feed");
const { DEFAULT_CONFIG: STRATEGY_SPEC, weekKeyOf } = require("../api/_lib/weekly-cycle");

const RUNNER_VERSION = "shadow-session-v2.0.0";
const MAX_BOOK_AGE_DAYS = 4;
const ROLL_WINDOW_CALENDAR_DAYS = STRATEGY_SPEC.rollWindowCalendarDays;

function argument(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function isoTradeDate(value) {
  const raw = String(value || "");
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw.slice(0, 10))) return raw.slice(0, 10);
  return null;
}

function sessionTimestamp(session) {
  return Date.parse(`${session}T10:00:00.000Z`);
}

function calendarDaysBetween(from, to) {
  return Math.ceil((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function stableHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function loadPlan(planPath) {
  if (!fs.existsSync(planPath)) throw new Error(`Plan not found: ${planPath}`);
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  if (!plan || typeof plan !== "object") throw new Error("Plan JSON must be an object");
  return plan;
}

// The production plan schema stores recommendation rows in `best` and order
// intents inside every entry. Legacy top-level intents are read only so they can
// be rejected by the same strict validation instead of crashing the session.
function flattenPlanIntents(plan) {
  const recommendations = Array.isArray(plan?.best)
    ? plan.best
    : Array.isArray(plan?.recommendations)
      ? plan.recommendations
      : [];
  const rows = [];
  for (const recommendation of recommendations) {
    if (!recommendation || recommendation.action === "stand-aside") continue;
    const entries = Array.isArray(recommendation.entries) && recommendation.entries.length
      ? recommendation.entries
      : recommendation.orderIntent
        ? [{ level: recommendation.level || 1, orderIntent: recommendation.orderIntent }]
        : [];
    for (const entry of entries) {
      // Missing portfolio admission is a block, never implicit permission.
      if (entry?.portfolioRisk?.admitted !== true) continue;
      rows.push({ recommendation, entry, intent: entry?.orderIntent || null });
    }
  }
  return rows;
}

function macroInput(radar) {
  return macroInputFromRadar(radar);
}

function contractQuote(contract, session) {
  return {
    open: Number(contract?.dayOpen) || null,
    high: Number(contract?.dayHigh) || null,
    low: Number(contract?.dayLow) || null,
    close: Number(contract?.futures) || null,
    current: Number(contract?.settlement || contract?.futures) || null,
    settlement: Number(contract?.settlement || contract?.futures) || null,
    timestamp: sessionTimestamp(session),
    source: "NSE_FO_BHAVCOPY"
  };
}

function exactContract(positionOrIntent, chains) {
  const contracts = chains.get(String(positionOrIntent?.symbol || "").toUpperCase()) || [];
  if (!positionOrIntent?.instrumentId || !positionOrIntent?.contractSymbol || !positionOrIntent?.expiry) return null;
  return contracts.find((contract) => String(contract.instrumentId) === String(positionOrIntent.instrumentId)
    && contract.contractSymbol === positionOrIntent.contractSymbol
    && contract.expiry === positionOrIntent.expiry) || null;
}

function nextContract(current, chains) {
  const contracts = chains.get(String(current?.symbol || "").toUpperCase()) || [];
  return contracts.find((contract) => contract.expiry > current.expiry) || null;
}

// Daily OHLC cannot reveal target/stop ordering. Stop wins an ambiguous bar.
// Gaps use the opening price, so a stop is never back-filled at a stale level.
function exitDecision(position, quote) {
  const side = normalizeOrderSide(position?.side);
  const open = Number(quote?.open);
  const high = Number(quote?.high);
  const low = Number(quote?.low);
  const target = Number(position?.targetPrice);
  const stop = Number(position?.stopLossPrice);
  if (!side || ![open, high, low, target, stop].every((value) => Number.isFinite(value) && value > 0)
      || high < Math.max(open, low) || low > open) {
    return { exit: false, reason: "EXIT_INPUT_UNAVAILABLE" };
  }

  if (side === "BUY") {
    if (open <= stop) return { exit: true, reason: "STOP_GAP", referencePrice: open, orderType: "STOP_MARKET" };
    if (open >= target) return { exit: true, reason: "TARGET_GAP", referencePrice: open, orderType: "MARKET" };
    const hitStop = low <= stop;
    const hitTarget = high >= target;
    if (hitStop) return { exit: true, reason: hitTarget ? "STOP_FIRST_DAILY_AMBIGUITY" : "STOP_LOSS", referencePrice: stop, orderType: "STOP_MARKET" };
    if (hitTarget) return { exit: true, reason: "TARGET_HIT", referencePrice: target, orderType: "MARKET" };
  } else {
    if (open >= stop) return { exit: true, reason: "STOP_GAP", referencePrice: open, orderType: "STOP_MARKET" };
    if (open <= target) return { exit: true, reason: "TARGET_GAP", referencePrice: open, orderType: "MARKET" };
    const hitStop = high >= stop;
    const hitTarget = low <= target;
    if (hitStop) return { exit: true, reason: hitTarget ? "STOP_FIRST_DAILY_AMBIGUITY" : "STOP_LOSS", referencePrice: stop, orderType: "STOP_MARKET" };
    if (hitTarget) return { exit: true, reason: "TARGET_HIT", referencePrice: target, orderType: "MARKET" };
  }
  return { exit: false, reason: "HOLD" };
}

function exitIntent(position, decision, session, suffix = "EXIT") {
  return {
    executable: true,
    symbol: position.symbol,
    contractSymbol: position.contractSymbol,
    instrumentId: position.instrumentId,
    expiry: position.expiry,
    side: normalizeOrderSide(position.side) === "BUY" ? "sell" : "buy",
    orderType: decision.orderType || "MARKET",
    entryPrice: decision.referencePrice,
    lotSize: position.lotSize,
    lots: position.lots,
    quantity: position.quantity,
    tickSize: position.tickSize || 0.05,
    clientOrderId: `${position.tradeId}:${suffix}:${session}`
  };
}

function refreshEntryIntent(row, contract, session, banState = null) {
  const original = row.intent || {};
  const quantity = Number(original.quantity);
  const lotSize = Number(contract?.lotSize);
  const lots = Number(original.lots);
  const validationErrors = [];
  if (original.executable !== true) validationErrors.push(original.rejectionReason || "PLAN_INTENT_NOT_EXECUTABLE");
  if (!contract) validationErrors.push("CURRENT_CONTRACT_NOT_FOUND");
  if (contract && (String(original.instrumentId) !== String(contract.instrumentId)
      || original.contractSymbol !== contract.contractSymbol || original.expiry !== contract.expiry)) validationErrors.push("PLANNED_CONTRACT_IDENTITY_MISMATCH");
  if (original.strategyVersion !== "continuous-futures-v2") validationErrors.push("UNSUPPORTED_STRATEGY_VERSION");
  const decisionTime = Date.parse(original.decisionAt);
  if (!Number.isFinite(decisionTime) || decisionTime > Date.parse(`${session}T03:45:00Z`)) validationErrors.push("DECISION_NOT_BEFORE_DAILY_BAR");
  if (!contract?.instrumentId) validationErrors.push("MISSING_INSTRUMENT_ID");
  if (!(lotSize > 0)) validationErrors.push("MISSING_CURRENT_LOT_SIZE");
  if (!(lots > 0) || !Number.isInteger(lots)) validationErrors.push("INVALID_LOTS");
  if (!(quantity > 0) || quantity !== lotSize * lots) validationErrors.push("STALE_LOT_SIZE_OR_QUANTITY");
  if (!(Number(contract?.volume) > 0) || !(Number(contract?.openInterest) > 0)) validationErrors.push("NO_CURRENT_LIQUIDITY_EVIDENCE");
  const symbol = String(row.recommendation?.symbol || original.symbol || "").toUpperCase();
  const banAvailable = banStateForSession(banState, session);
  if (!banAvailable) validationErrors.push("FO_BAN_STATUS_UNAVAILABLE");
  else if (banState.symbols.has(symbol)) validationErrors.push("SECURITY_IN_FO_BAN");

  return {
    ...original,
    symbol,
    side: original.side || row.recommendation?.side,
    sector: original.sector || row.recommendation?.sector || row.recommendation?.evidence?.fundamentals?.sector || null,
    level: Number(row.entry?.level || original.level || 1),
    contractSymbol: contract?.contractSymbol || null,
    instrumentId: contract?.instrumentId || null,
    expiry: contract?.expiry || null,
    lotSize: lotSize || null,
    lots,
    quantity,
    tickSize: contract?.tickSize || original.tickSize,
    contractNotional: round(Number(original.entryPrice) * quantity, 2),
    sessionVolume: Number(contract?.volume) || null,
    openInterest: Number(contract?.openInterest) || null,
    dataAsOf: session,
    dataSource: "NSE_FO_BHAVCOPY",
    banStatus: banAvailable ? (banState.symbols.has(symbol) ? "BANNED" : "CLEAR") : "UNAVAILABLE",
    banStatusAsOf: banState?.fetchedAt || null,
    executable: validationErrors.length === 0,
    validationErrors,
    rejectionReason: validationErrors[0] || null,
    liveExecutable: false,
    executionMode: "SHADOW_ONLY"
  };
}

function riskDecision(ledger, intent, macro, session, dailyNetPnl, limits = DEFAULT_PORTFOLIO_LIMITS) {
  const effectiveLimits = {
    ...limits,
    strictOrderValidation: true,
    requireSector: true,
    requireCompleteMacro: true,
    requireBanClear: true,
    killSwitchTriggered: Boolean(ledger.killSwitch?.triggered)
  };
  const result = evaluatePortfolioRisk({
    proposedOrder: intent,
    activePositions: ledger.positions,
    dailyRealizedPnl: dailyNetPnl,
    dailyUnrealizedPnl: 0,
    accountEquity: ledger.accountEquity,
    marketRegime: macro,
    limits: effectiveLimits
  });
  appendAuditEvent(ledger, {
    type: "RISK_DECISION",
    session,
    runnerVersion: RUNNER_VERSION,
    ruleVersion: "portfolio-risk-v2",
    clientOrderId: intent?.clientOrderId || null,
    inputHash: stableHash({ intent, activeTradeIds: ledger.positions.map((item) => item.tradeId), macro, limits: effectiveLimits }),
    approved: result.approved,
    reason: result.reason
  });
  return result;
}

function closePositionAtDecision(ledger, position, contract, quote, decision, session, suffix = "EXIT") {
  const intent = exitIntent(position, decision, session, suffix);
  const fill = simulateExecutionFill({
    orderIntent: intent,
    currentQuote: { ...quote, current: decision.referencePrice },
    liquidityTier: "HIGH",
    asOfDate: session
  });
  if (fill?.status !== "FILLED") return { closed: false, reason: fill?.reason || "EXIT_NOT_FILLED", fill };
  const note = generateContractNote({
    tradeId: position.tradeId,
    entryFill: position.entryFill,
    exitFill: fill,
    contract: { ...contract, estMarginRequired: position.marginBlocked },
    settlementDate: session
  });
  return { ...closeShadowPosition(ledger, { tradeId: position.tradeId, exitFill: fill, contractNote: note, reason: decision.reason }), fill, note };
}

function openRolledPosition(ledger, oldPosition, next, macro, banState, session, dailyNetPnl, limits) {
  const quote = contractQuote(next, session);
  const side = normalizeOrderSide(oldPosition.side) === "BUY" ? "long" : "short";
  const sign = side === "long" ? 1 : -1;
  const entryReference = Number(next.settlement || next.futures);
  const remainingTargetDistance = Math.max(Number(next.tickSize || 0.05), (Number(oldPosition.targetPrice) - Number(oldPosition.previousSettlementPrice)) * sign);
  const stopDistance = Math.max(Number(next.tickSize || 0.05), (Number(oldPosition.previousSettlementPrice) - Number(oldPosition.stopLossPrice)) * sign);
  const quantity = Number(oldPosition.quantity);
  const lots = quantity / Number(next.lotSize);
  const banAvailable = banStateForSession(banState, session);
  const intent = {
    executable: Number.isInteger(lots) && lots > 0 && Boolean(next.instrumentId)
      && banAvailable && !banState.symbols.has(oldPosition.symbol),
    symbol: oldPosition.symbol,
    sector: oldPosition.sector,
    side,
    contractSymbol: next.contractSymbol,
    instrumentId: next.instrumentId,
    expiry: next.expiry,
    orderType: "MARKET",
    entryPrice: entryReference,
    targetPrice: round(entryReference + sign * remainingTargetDistance, 4),
    stopLossPrice: round(entryReference - sign * stopDistance, 4),
    lotSize: next.lotSize,
    lots,
    quantity,
    tickSize: next.tickSize,
    estMarginRequired: round(entryReference * quantity * (Number(oldPosition.marginBlocked) / Math.max(1, oldPosition.contractNotional)), 2),
    marginSource: "ROLLED_CONSERVATIVE_ESTIMATE",
    maxRiskInr: round(stopDistance * quantity, 2),
    contractNotional: round(entryReference * quantity, 2),
    sessionVolume: Number(next.volume),
    openInterest: Number(next.openInterest),
    dataAsOf: session,
    dataSource: "NSE_FO_BHAVCOPY",
    banStatus: banAvailable ? (banState.symbols.has(oldPosition.symbol) ? "BANNED" : "CLEAR") : "UNAVAILABLE",
    level: oldPosition.level,
    weekKey: weekKeyOf(session),
    strategyVersion: oldPosition.strategyVersion,
    clientOrderId: `${oldPosition.tradeId}:ROLL_OPEN:${session}`,
    executionMode: "SHADOW_ONLY",
    liveExecutable: false
  };
  const risk = riskDecision(ledger, intent, macro, session, dailyNetPnl, limits);
  if (!risk.approved) return { opened: false, reason: risk.reason, intent, risk };
  const fill = simulateExecutionFill({ orderIntent: intent, currentQuote: quote, liquidityTier: "HIGH", asOfDate: session });
  return { ...openShadowPosition(ledger, { orderIntent: intent, fillDetails: { ...fill, orderIntent: intent }, weekKey: weekKeyOf(session), level: oldPosition.level }), fill, intent, risk };
}

async function resolveInputs(options) {
  const book = options.book || await latestBhavcopy(options.now || new Date());
  const chains = options.chains || stockFuturesBySymbol(book.rows || []);
  const session = isoTradeDate(options.session || book.tradeDate);
  if (!session) throw new Error("NSE bhavcopy has no valid trade date");
  const nowDate = isoTradeDate((options.now || new Date()).toISOString());
  if (nowDate && session > nowDate) throw new Error("FUTURE_BHAVCOPY_SESSION");
  if (!options.allowHistoricalBook && nowDate && calendarDaysBetween(session, nowDate) > (options.maxBookAgeDays || MAX_BOOK_AGE_DAYS)) {
    throw new Error(`STALE_BHAVCOPY: ${session} is older than ${options.maxBookAgeDays || MAX_BOOK_AGE_DAYS} calendar days`);
  }
  const radar = options.radar === undefined ? await fetchLiveMacroRadar().catch(() => null) : options.radar;
  const macro = options.macro || evaluateGlobalMacroShock(macroInput(radar));
  const banState = options.banState || await fetchSecurityBanList();
  return { book, chains, session, macro, banState };
}

// EXECUTION-TIME risk limits. portfolio-risk.js ships three strictness flags
// defaulted to false -- strictOrderValidation, requireSector and
// requireCompleteMacro -- so the engine that owns the firm's risk controls was
// running with its order schema validation, its sector requirement and its
// macro-freshness gate all switched off. This is the path that actually places
// orders, so all three are on here and missing data fails closed.
//
// The weekly plan deliberately runs with requireCompleteMacro off, because it
// builds candidates before the open rather than placing orders; see the comment
// in scripts/weekly-plan.js.
const EXECUTION_LIMITS = Object.freeze({
  ...DEFAULT_PORTFOLIO_LIMITS,
  strictOrderValidation: true,
  requireSector: true,
  requireCompleteMacro: true
});

async function runShadowSession(options = {}) {
  const planPath = path.resolve(options.planPath || options.plan || argument("plan", "plan-full.json"));
  const plan = options.planObject || loadPlan(planPath);
  const ledger = options.ledger || loadShadowLedger(options.ledgerPath);
  // Callers may still override for tests or replays, but the default is strict.
  options = { ...options, limits: options.limits || EXECUTION_LIMITS };
  const { chains, session, macro, banState } = await resolveInputs(options);
  ledger.processedSessions ||= {};
  if (ledger.processedSessions[session]) return { ...ledger.processedSessions[session], idempotent: true, ledger };
  const priorSessions = Object.keys(ledger.processedSessions).sort();
  if (priorSessions.length && priorSessions.at(-1) > session) throw new Error("OUT_OF_ORDER_SHADOW_SESSION");
  const startingEquity = Number(ledger.accountEquity);
  const startingAuditIndex = ledger.auditEvents?.length || 0;
  const results = { opened: [], closed: [], settled: [], rebased: [], rolled: [], rejected: [], warnings: [] };
  let dailyNetPnl = 0;

  // Existing exposure is always managed, even when macro data blocks new risk.
  for (const position of [...ledger.positions]) {
    const contract = exactContract(position, chains);
    if (!contract) {
      results.warnings.push({ tradeId: position.tradeId, reason: "EXACT_OPEN_CONTRACT_NOT_FOUND" });
      appendAuditEvent(ledger, { type: "POSITION_DATA_LOCKDOWN", tradeId: position.tradeId, session, reason: "EXACT_OPEN_CONTRACT_NOT_FOUND" });
      triggerKillSwitch(ledger, `EXACT_OPEN_CONTRACT_NOT_FOUND:${position.tradeId}`);
      continue;
    }
    const quote = contractQuote(contract, session);
    const newWeekKey = weekKeyOf(session);
    if (position.anchorWeek !== newWeekKey && Number(quote.open) > 0) {
      const before = { equity: ledger.accountEquity, originalEntryPrice: position.originalEntryPrice, quantity: position.quantity };
      const rebased = rebaseMondayPosition(position, quote.open, newWeekKey);
      if (rebased.rebased) {
        results.rebased.push(rebased);
        appendAuditEvent(ledger, { type: "WEEKLY_REFERENCE_REBASED", session, ...rebased });
        if (before.equity !== ledger.accountEquity || before.originalEntryPrice !== position.originalEntryPrice || before.quantity !== position.quantity) {
          triggerKillSwitch(ledger, "MONDAY_REBASE_INVARIANT_BREACH");
          throw new Error("MONDAY_REBASE_INVARIANT_BREACH");
        }
      }
    }

    let decision = exitDecision(position, quote);
    if (decision.reason === "EXIT_INPUT_UNAVAILABLE") {
      triggerKillSwitch(ledger, `INVALID_OPEN_POSITION_QUOTE:${position.tradeId}`);
      results.warnings.push({ tradeId: position.tradeId, reason: decision.reason });
      continue;
    }
    if (!decision.exit && Number(position.holdingSessions || 0) + 1 >= Number(STRATEGY_SPEC.maxHoldingSessions)) {
      decision = {
        exit: true,
        reason: "MAX_HOLDING_RISK_CEILING",
        referencePrice: Number(contract.settlement || contract.futures),
        orderType: "MARKET"
      };
    }
    if (decision.exit) {
      const closed = closePositionAtDecision(ledger, position, contract, quote, decision, session);
      if (closed.closed) {
        results.closed.push(closed.closedRecord);
        dailyNetPnl += Number(closed.closedRecord.cumulativeVariationPnl || 0) - Number(position.cumulativeVariationPnl || 0) - Number(closed.closedRecord.exitFeesPaid || 0);
      } else results.warnings.push({ tradeId: position.tradeId, reason: closed.reason });
      continue;
    }

    const daysToExpiry = calendarDaysBetween(session, contract.expiry);
    if (daysToExpiry <= (options.rollWindowDays ?? ROLL_WINDOW_CALENDAR_DAYS)) {
      const next = nextContract(contract, chains);
      const rollCloseDecision = {
        exit: true,
        reason: next ? "MANDATORY_EXPIRY_ROLL" : "MANDATORY_EXPIRY_CLOSE_NO_NEXT_CONTRACT",
        referencePrice: Number(contract.settlement || contract.futures),
        orderType: "MARKET"
      };
      const closed = closePositionAtDecision(ledger, position, contract, quote, rollCloseDecision, session, "ROLL_CLOSE");
      if (!closed.closed) {
        results.warnings.push({ tradeId: position.tradeId, reason: `ROLL_CLOSE_FAILED:${closed.reason}` });
        triggerKillSwitch(ledger, `ROLL_CLOSE_FAILED:${position.tradeId}`);
        continue;
      }
      results.closed.push(closed.closedRecord);
      dailyNetPnl += Number(closed.closedRecord.cumulativeVariationPnl || 0) - Number(position.cumulativeVariationPnl || 0) - Number(closed.closedRecord.exitFeesPaid || 0);
      if (next) {
        position.previousSettlementPrice = Number(closed.fill.fillPrice);
        dailyNetPnl = Number(ledger.accountEquity) - startingEquity;
        const opened = openRolledPosition(ledger, position, next, macro, banState, session, dailyNetPnl, options.limits || DEFAULT_PORTFOLIO_LIMITS);
        const rollEvent = {
          type: "CONTRACT_ROLL",
          session,
          rootTradeId: position.rootTradeId || position.tradeId,
          oldTradeId: position.tradeId,
          oldContract: contract.contractSymbol,
          newContract: next.contractSymbol,
          closeOrderId: closed.fill?.orderId || null,
          openOrderId: opened.fill?.orderId || null,
          closedPrice: closed.fill?.fillPrice || null,
          openedPrice: opened.fill?.fillPrice || null,
          rollBasisPerUnit: opened.fill?.fillPrice && closed.fill?.fillPrice ? round(opened.fill.fillPrice - closed.fill.fillPrice, 4) : null,
          opened: Boolean(opened.opened),
          reason: opened.reason || null
        };
        if (opened.opened) {
          opened.position.rootTradeId = position.rootTradeId || position.tradeId;
          opened.position.holdingSessions = Number(position.holdingSessions || 0);
          opened.position.rootEnteredAt = position.rootEnteredAt || position.enteredAt;
          results.opened.push(opened.position);
        } else results.warnings.push({ tradeId: position.tradeId, reason: `ROLL_OPEN_FAILED:${opened.reason}` });
        results.rolled.push(rollEvent);
        appendAuditEvent(ledger, rollEvent);
      }
      continue;
    }

    const settled = settleShadowPosition(ledger, { tradeId: position.tradeId, settlementPrice: contract.settlement, session });
    if (settled.settled) {
      results.settled.push(settled);
      dailyNetPnl += Number(settled.variationPnl || 0);
    }
    if (new Date(`${session}T12:00:00Z`).getUTCDay() === 5) recordFridaySettlement(position, contract.settlement, session);
  }

  dailyNetPnl = Number(ledger.accountEquity) - startingEquity;
  if (dailyNetPnl <= -(options.limits?.dailyLossLimitInr || DEFAULT_PORTFOLIO_LIMITS.dailyLossLimitInr)) {
    triggerKillSwitch(ledger, `DAILY_NET_LOSS_LIMIT:${dailyNetPnl}`);
  }

  // Only a current, schema-valid plan can add exposure. A stale plan is not
  // silently reused into a new week.
  const currentWeek = weekKeyOf(session);
  if (new Date(`${session}T12:00:00Z`).getUTCDay() === 5) {
    results.rejected.push({ reason: "NO_NEW_FRIDAY_EXPOSURE" });
  } else if (plan.weekKey !== currentWeek && plan.generatedFor !== currentWeek) {
    results.rejected.push({ reason: `STALE_PLAN_WEEK:${plan.weekKey || plan.generatedFor || "UNKNOWN"};CURRENT:${currentWeek}` });
  } else {
    for (const row of flattenPlanIntents(plan)) {
      const plannedSymbol = String(row.recommendation?.symbol || row.intent?.symbol || "").toUpperCase();
      const front = exactContract(row.intent, chains);
      const intent = refreshEntryIntent(row, front, session, banState);
      if (!intent.executable) {
        results.rejected.push({ symbol: plannedSymbol, clientOrderId: intent.clientOrderId || null, reason: intent.rejectionReason });
        continue;
      }
      const entryQuote = contractQuote(front, session);
      const isLong = normalizeOrderSide(intent.side) === "BUY";
      if (!(entryQuote.open > 0) || (isLong ? entryQuote.open <= Number(intent.stopLossPrice) : entryQuote.open >= Number(intent.stopLossPrice))) {
        results.rejected.push({ symbol: plannedSymbol, reason: "ENTRY_GAP_INVALIDATES_STOP" });
        continue;
      }
      dailyNetPnl = Number(ledger.accountEquity) - startingEquity;
      const risk = riskDecision(ledger, intent, macro, session, dailyNetPnl, options.limits || DEFAULT_PORTFOLIO_LIMITS);
      if (!risk.approved) {
        results.rejected.push({ symbol: plannedSymbol, clientOrderId: intent.clientOrderId, reason: risk.reason });
        continue;
      }
      const fill = simulateExecutionFill({
        orderIntent: intent,
        currentQuote: contractQuote(front, session),
        liquidityTier: Number(front.volume) >= 100_000 ? "HIGH" : Number(front.volume) >= 10_000 ? "MID" : "LOW",
        asOfDate: session
      });
      if (fill?.status !== "FILLED") {
        results.rejected.push({ symbol: plannedSymbol, clientOrderId: intent.clientOrderId, reason: fill?.reason || "NO_FILL" });
        continue;
      }
      const opened = openShadowPosition(ledger, {
        orderIntent: intent,
        fillDetails: { ...fill, orderIntent: intent },
        weekKey: currentWeek,
        level: intent.level
      });
      if (opened.opened) {
        results.opened.push(opened.position);
        // A trade-through entry followed by a stop breach is charged on this
        // bar. A target-only high/low may have preceded entry, so is not assumed.
        const stopped = isLong ? entryQuote.low <= Number(intent.stopLossPrice) : entryQuote.high >= Number(intent.stopLossPrice);
        if (stopped) {
          const closed = closePositionAtDecision(ledger, opened.position, front, entryQuote,
            { reason: "ENTRY_SESSION_STOP_CONSERVATIVE", referencePrice: Number(intent.stopLossPrice), orderType: "STOP_MARKET" }, session);
          if (closed.closed) results.closed.push(closed.closedRecord);
          else triggerKillSwitch(ledger, "ENTRY_SESSION_STOP_FAILED");
        }
      }
      else results.rejected.push({ symbol: plannedSymbol, clientOrderId: intent.clientOrderId, reason: opened.reason });
    }
  }

  // Entries and rolls also receive the official entry-session settlement.
  for (const position of ledger.positions) {
    if (position.lastSettledSession === session) continue;
    const contract = exactContract(position, chains);
    const settled = settleShadowPosition(ledger, { tradeId: position.tradeId, settlementPrice: contract?.settlement, session });
    if (settled.settled) results.settled.push(settled);
    else triggerKillSwitch(ledger, `MISSING_DAILY_SETTLEMENT:${position.tradeId}`);
  }
  dailyNetPnl = Number(ledger.accountEquity) - startingEquity;
  if (dailyNetPnl <= -(options.limits?.dailyLossLimitInr || DEFAULT_PORTFOLIO_LIMITS.dailyLossLimitInr)) triggerKillSwitch(ledger, `DAILY_NET_LOSS_LIMIT:${dailyNetPnl}`);
  const sessionEvents = ledger.auditEvents.slice(startingAuditIndex);
  const report = {
    ok: !ledger.killSwitch?.triggered,
    mode: "SHADOW_ONLY",
    liveOrderSubmissionEnabled: false,
    runnerVersion: RUNNER_VERSION,
    session,
    planWeek: plan.weekKey || plan.generatedFor || null,
    macro,
    banStatus: { available: banState?.available === true, count: banState?.symbols instanceof Set ? banState.symbols.size : null, source: banState?.source || null },
    openedCount: results.opened.length,
    closedCount: results.closed.length,
    settledCount: results.settled.length,
    rebasedCount: results.rebased.length,
    rolledCount: results.rolled.length,
    rejectedCount: results.rejected.length,
    activeCount: ledger.positions.length,
    accountEquity: ledger.accountEquity,
    availableMargin: ledger.availableMargin,
    dailyNetPnl: round(dailyNetPnl, 2),
    killSwitch: ledger.killSwitch,
    results,
    auditEventHash: stableHash(sessionEvents)
  };

  appendAuditEvent(ledger, { type: "SESSION_COMPLETED", ...report, results: undefined });
  ledger.processedSessions[session] = { ...report, results: undefined };
  if (options.save !== false) saveShadowLedger(ledger, options.ledgerPath);
  return { ...report, ledger };
}

if (require.main === module) {
  runShadowSession().then((report) => {
    console.log(JSON.stringify({ ...report, ledger: undefined }, null, 2));
    if (!report.ok) process.exitCode = 2;
  }).catch((error) => {
    console.error(`Shadow session failed closed: ${String(error?.stack || error?.message || error)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  RUNNER_VERSION,
  calendarDaysBetween,
  contractQuote,
  exactContract,
  exitDecision,
  flattenPlanIntents,
  isoTradeDate,
  macroInput,
  refreshEntryIntent,
  runShadowSession
};
