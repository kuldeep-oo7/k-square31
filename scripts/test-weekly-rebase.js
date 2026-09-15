"use strict";

const assert = require("node:assert/strict");
const { accountReconciliation, emptyShadowLedger, positionReconciliation } = require("../api/_lib/shadow-ledger");
const { runShadowSession } = require("./run-shadow-session");
const { buildOrderIntent } = require("../api/_lib/recommendation");
const { evaluatePortfolioRisk } = require("../api/_lib/portfolio-risk");

const macro = { dataComplete: true, severity: "NORMAL", actionDirective: "NORMAL_OPERATION", missingFields: [] };
const banState = { available: true, symbols: new Set(), source: "TEST_FIXTURE", fetchedAt: "2026-08-24T06:00:00Z" };

function contract(symbol, session, quote, overrides = {}) {
  return {
    symbol,
    contractSymbol: `${symbol}26OCTFUT`,
    instrumentId: `NSE-FO-${symbol}-OCT`,
    expiry: "2026-10-27",
    lotSize: 100,
    tickSize: 0.01,
    volume: 100000,
    openInterest: 500000,
    tradeDate: session,
    segment: "NSE_FO",
    spot: quote.settlement,
    futures: quote.settlement,
    dayOpen: quote.open,
    dayHigh: quote.high,
    dayLow: quote.low,
    settlement: quote.settlement,
    ...overrides
  };
}

function plan(symbol, side, weekKey, values) {
  const long = side === "long";
  const intent = buildOrderIntent({ symbol, side, weekKey, level: 1, sector: "TEST_SECTOR",
    entry: values.entry, target: values.target, stopLoss: values.stop,
    targetPct: 2, stopLossPct: 2, riskReward: 1,
    sizeMultiplier: (Math.abs(values.entry - values.stop) * 100 + 1) / 25000,
    decisionAt: `${weekKey}T03:45:00Z`,
    contract: contract(symbol, weekKey, { open: values.entry, high: values.entry, low: values.entry, settlement: values.entry }, { banStatus: "CLEAR" })
  });
  const admission = evaluatePortfolioRisk({ proposedOrder: intent, accountEquity: 1_000_000, marketRegime: macro });
  assert.equal(admission.approved, true, admission.reason);
  return {
    generatedAt: `${weekKey}T03:45:00.000Z`,
    weekKey,
    best: [{
      symbol,
      side,
      sector: "TEST_SECTOR",
      action: long ? "buy-ladder" : "sell-ladder",
      entries: [{
        level: 1,
        entry: values.entry,
        target: values.target,
        stopLoss: values.stop,
        portfolioRisk: { admitted: admission.approved, reason: admission.reason },
        orderIntent: intent
      }]
    }]
  };
}

function options(session, planObject, ledger, chain) {
  return {
    planObject,
    ledger,
    book: { tradeDate: session.replaceAll("-", ""), rows: [] },
    chains: new Map([[chain.symbol, [chain]]]),
    macro,
    banState: { ...banState, tradeDate: session },
    now: new Date(`${session}T12:00:00.000Z`),
    allowHistoricalBook: true,
    save: false
  };
}

async function testLongLifecycle() {
  const ledger = emptyShadowLedger(1_000_000);
  const weeklyPlan = plan("TESTLONG", "long", "2026-08-24", { entry: 100, target: 102, stop: 98 });

  const monday = await runShadowSession(options(
    "2026-08-24", weeklyPlan, ledger,
    contract("TESTLONG", "2026-08-24", { open: 100.5, high: 101, low: 99.99, settlement: 100.2 })
  ));
  assert.equal(monday.openedCount, 1, "the untouched production plan shape must reach the runner");
  assert.equal(monday.ledger.positions[0].side, "BUY");
  assert.equal(monday.ledger.positions[0].originalEntryPrice, 100);
  const approvedAudit = monday.ledger.auditEvents.find((event) => event.type === "RISK_DECISION" && event.approved === true);
  assert.ok(approvedAudit, "no order may open without a hashed approved risk decision");
  assert.equal(monday.settledCount, 1, "An entry must be settled on its first session");
  const equity = ledger.accountEquity;
  const repeated = await runShadowSession(options("2026-08-24", weeklyPlan, ledger,
    contract("TESTLONG", "2026-08-24", { open: 100.5, high: 110, low: 90, settlement: 100.2 })));
  assert.equal(repeated.idempotent, true, "A second run cannot reinterpret the already processed daily range");
  assert.equal(ledger.accountEquity, equity);

  const friday = await runShadowSession(options(
    "2026-08-28", weeklyPlan, ledger,
    contract("TESTLONG", "2026-08-28", { open: 100.4, high: 101.2, low: 99.5, settlement: 100.8 })
  ));
  assert.equal(friday.closedCount, 0, "Friday is not an exit event");
  assert.equal(friday.ledger.positions.length, 1);
  assert.equal(friday.ledger.positions[0].previousFridaySettlementPrice, 100.8);
  const fridayQuantity = friday.ledger.positions[0].quantity;
  const fridayEquity = friday.ledger.accountEquity;

  const nextMonday = await runShadowSession(options(
    "2026-08-31", weeklyPlan, ledger,
    contract("TESTLONG", "2026-08-31", { open: 101.2, high: 101.6, low: 100.7, settlement: 101.3 })
  ));
  assert.equal(nextMonday.rebasedCount, 1);
  assert.equal(nextMonday.ledger.positions[0].originalEntryPrice, 100);
  assert.equal(nextMonday.ledger.positions[0].weeklyReferencePrice, 101.2);
  assert.equal(nextMonday.ledger.positions[0].quantity, fridayQuantity);
  assert.ok(nextMonday.ledger.accountEquity > fridayEquity, "Monday variation margin records the gap; the rebase itself does not erase it");
  assert.equal(positionReconciliation(nextMonday.ledger.positions[0], 101.3).reconciled, true);

  const tuesday = await runShadowSession(options(
    "2026-09-01", weeklyPlan, ledger,
    contract("TESTLONG", "2026-09-01", { open: 102.5, high: 103, low: 102.2, settlement: 102.7 })
  ));
  assert.equal(tuesday.closedCount, 1);
  assert.equal(tuesday.ledger.positions.length, 0);
  assert.equal(tuesday.ledger.closedTrades[0].exitReason, "TARGET_GAP");
  assert.equal(tuesday.ledger.closedTrades[0].exitPrice, 102.49, "market exit pays adverse one-tick slippage");
  assert.equal(accountReconciliation(tuesday.ledger).reconciled, true);
  assert.equal(tuesday.liveOrderSubmissionEnabled, false);
}

async function testShortDirection() {
  const ledger = emptyShadowLedger(1_000_000);
  const shortPlan = plan("TESTSHORT", "short", "2026-09-07", { entry: 102, target: 99.96, stop: 104.04 });
  const opened = await runShadowSession(options(
    "2026-09-07", shortPlan, ledger,
    contract("TESTSHORT", "2026-09-07", { open: 101, high: 102.01, low: 100.8, settlement: 101.2 })
  ));
  assert.equal(opened.openedCount, 1);
  assert.equal(opened.ledger.positions[0].side, "SELL", "short direction must survive plan, broker and ledger boundaries");
  const closed = await runShadowSession(options(
    "2026-09-08", shortPlan, ledger,
    contract("TESTSHORT", "2026-09-08", { open: 99, high: 99.4, low: 98.8, settlement: 99.1 })
  ));
  assert.equal(closed.closedCount, 1);
  assert.equal(closed.ledger.closedTrades[0].exitReason, "TARGET_GAP");
  assert.equal(closed.ledger.contractNotes[0].exit.side, "BUY");
  assert.ok(closed.ledger.closedTrades[0].grossPnl > 0);
  assert.equal(accountReconciliation(closed.ledger).reconciled, true);
}

async function run() {
  await testLongLifecycle();
  await testShortDirection();
  console.log("Production-path lifecycle tests passed: untouched plan shape, mandatory risk audit, quote fill, Friday carry, Monday rebase, long/short direction, gap target and reconciliation");
}

run().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
