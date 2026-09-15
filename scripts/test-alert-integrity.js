"use strict";

const assert = require("node:assert/strict");
const { buildEmailHtml, sendDailyTradeEmail } = require("../api/_lib/emailer");
const { checkDeduplication, dispatchKey, triageFuturesPositions } = require("./dispatch-daily-alert");

const asOf = new Date("2026-09-08T10:00:00.000Z");
const triage = triageFuturesPositions([
  {
    symbol: "LONG", side: "BUY", contractSymbol: "LONG26OCTFUT", expiry: "2026-10-27",
    quantity: 100, originalEntryPrice: 100, previousSettlementPrice: 110,
    targetPrice: 110, stopLossPrice: 98
  },
  {
    symbol: "SHORT", side: "SELL", contractSymbol: "SHORT26OCTFUT", expiry: "2026-10-27",
    quantity: 100, originalEntryPrice: 100, previousSettlementPrice: 90,
    targetPrice: 90, stopLossPrice: 102
  },
  {
    symbol: "SHORTHOLD", side: "SHORT", contractSymbol: "SHORTHOLD26OCTFUT", expiry: "2026-10-27",
    quantity: 100, originalEntryPrice: 100, previousSettlementPrice: 95,
    targetPrice: 90, stopLossPrice: 102
  },
  { symbol: "INCOMPLETE", buyAverage: 100, lastPrice: 90 }
].map((position) => ({ ...position, quoteAsOf: asOf.toISOString() })), asOf);

assert.equal(triage.exits.length, 2);
assert.equal(triage.exits.find((item) => item.symbol === "LONG").action, "SELL TO CLOSE");
assert.equal(triage.exits.find((item) => item.symbol === "SHORT").action, "BUY TO COVER");
assert.ok(triage.exits.every((item) => item.pnlPct > 0), "long and short P&L signs must both be correct");
assert.equal(triage.holds[0].target, 90, "a holding target stays fixed instead of moving away with mark price");
assert.equal(triage.holds[0].trailingStop, 102);
assert.equal(triage.holds[0].pnlPct, 5);
assert.equal(triage.unverified[0].status, "DATA UNAVAILABLE — NO AUTOMATED ACTION");
assert.equal(dispatchKey("MORNING_BRIEFING", "2026-09-08"), dispatchKey("MORNING_BRIEFING", "2026-09-08"));
assert.notEqual(dispatchKey("MORNING_BRIEFING", "2026-09-08"), dispatchKey("POST_MARKET_WRAP", "2026-09-08"));
assert.equal(checkDeduplication(true).slot, "MANUAL");

const html = buildEmailHtml({ radar: { severity: "DATA_UNAVAILABLE" }, sells: triage.exits, holds: triage.holds });
assert.match(html, /BROKER ACK REQUIRED/);
assert.doesNotMatch(html, /SELL AT OPEN/);
assert.doesNotMatch(html, /INDEX PUT HEDGES/);
assert.match(buildEmailHtml({ macroAssets: [{ price: "N/A", changePct: null }], holds: [{ pnlPct: null }] }), /MACRO DATA UNVERIFIED/);
assert.equal(triageFuturesPositions([{ side: "BUY", symbol: "OLD", contractSymbol: "OLD26OCTFUT", expiry: "2026-10-27", quantity: 100, originalEntryPrice: 100, markPrice: 110, targetPrice: 105, stopLossPrice: 98 }], asOf).exits.length, 0, "Untimestamped prices cannot create actionable exit alerts");

async function deliveryTests() {
  const originalFetch = global.fetch;
  const originalUrl = process.env.K2_EMAIL_WEBHOOK_URL;
  const originalSecret = process.env.K2_EMAIL_WEBHOOK_SECRET;
  try {
    delete process.env.K2_EMAIL_WEBHOOK_URL;
    delete process.env.K2_EMAIL_WEBHOOK_SECRET;
    const localOnly = await sendDailyTradeEmail({ radar: {} }, { writeLocal: false, idempotencyKey: "KEY" });
    assert.equal(localOnly.success, false);
    assert.equal(localOnly.delivered, false);

    process.env.K2_EMAIL_WEBHOOK_URL = "https://example.invalid/email";
    process.env.K2_EMAIL_WEBHOOK_SECRET = "test-secret";
    global.fetch = async () => ({ ok: false, status: 503, text: async () => "down" });
    await assert.rejects(() => sendDailyTradeEmail({ radar: {} }, { writeLocal: false, idempotencyKey: "KEY" }), /HTTP 503/);

    global.fetch = async () => ({ ok: true, status: 200, text: async () => "queued" });
    await assert.rejects(() => sendDailyTradeEmail({ radar: {} }, { writeLocal: false, idempotencyKey: "KEY" }), /structured JSON/);

    global.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, delivered: true, messageId: "MSG_1", idempotencyKey: "OTHER" })
    });
    await assert.rejects(() => sendDailyTradeEmail({ radar: {} }, { writeLocal: false, idempotencyKey: "KEY" }), /key mismatch/);

    global.fetch = async (_url, request) => {
      const sent = JSON.parse(request.body);
      assert.equal(sent.dispatchSecret, "test-secret");
      assert.equal(sent.idempotencyKey, "KEY");
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, delivered: true, messageId: "MSG_1", idempotencyKey: "KEY" })
      };
    };
    const delivered = await sendDailyTradeEmail({ radar: {} }, { writeLocal: false, idempotencyKey: "KEY" });
    assert.equal(delivered.success, true);
    assert.equal(delivered.delivered, true);
    assert.equal(delivered.messageId, "MSG_1");
  } finally {
    global.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.K2_EMAIL_WEBHOOK_URL;
    else process.env.K2_EMAIL_WEBHOOK_URL = originalUrl;
    if (originalSecret === undefined) delete process.env.K2_EMAIL_WEBHOOK_SECRET;
    else process.env.K2_EMAIL_WEBHOOK_SECRET = originalSecret;
  }
}

deliveryTests().then(() => {
  console.log("Alert-integrity tests passed: side-correct fixed-level triage, incomplete-data abstention, deterministic dispatch keys and authenticated delivery acknowledgements");
}).catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
