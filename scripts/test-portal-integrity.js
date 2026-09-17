"use strict";
const assert = require("node:assert/strict");
const { document_, bookPayload, macroView } = require("./build-portal");
const { verify } = require("./verify-portal");
const { sealPayload } = require("../api/_lib/portal-crypto");
const { macroInputFromRadar } = require("../api/_lib/market-feed");
const { universe } = require("../api/_lib/universe");
const { istToday } = require("./plan-is-current");
const { weekKeyOf } = require("../api/_lib/weekly-cycle");

function fixturePlan(nowMs = Date.now()) {
  return { generatedAt: new Date(nowMs - 1000).toISOString(), weekKey: weekKeyOf(istToday(nowMs)),
    strategyVersion: "continuous-futures-v2", marketCoverage: { derivativesVerified: true, futuresSymbols: ["UI_TEST"] },
    best: ["long", "short"].map((side) => ({ symbol: "UI_TEST", side, weekKey: weekKeyOf(istToday(nowMs)), expectedWeeklyPct: 0.1, convictionPct: 50,
      entries: [{ entry: 999, target: 1111, stopLoss: 888, portfolioRisk: { admitted: true },
        orderIntent: { executable: true, weekKey: weekKeyOf(istToday(nowMs)), decisionAt: new Date(nowMs - 2000).toISOString(), strategyVersion: "continuous-futures-v2", entryPrice: 100, targetPrice: side === "long" ? 102 : 98, stopLossPrice: side === "long" ? 98 : 102 } }]
    })) };
}
function run() {
  const meta = { builtAt: "TEST", nowMs: Date.now() };
  const broad = { stocks: universe() };
  const html = document_(fixturePlan(meta.nowMs), null, meta, null, broad);
  assert.equal(verify(html).scriptsChecked, 2);
  assert.ok(html.includes('value="UI_TEST:short"'));
  assert.ok(html.includes('data-entry="100"'), "Display actual raw exchange-rounded intent, not stale adjusted entry");
  assert.ok(!html.includes('data-entry="999"'));
  assert.ok((html.match(/data-public-symbol=/g) || []).length >= 502);
  const stale = document_({ ...fixturePlan(), weekKey: "2020-01-06" }, null, meta, null, broad);
  assert.match(stale, /id="plan-stale"/);
  assert.ok(!stale.includes('data-symbol="UI_TEST"'), "Old plan must not populate calculator");
  assert.equal(macroView({ giftNifty: { price: null, changePct: null } }).state.dataComplete, false);
  assert.equal(macroInputFromRadar({ indiaVix: { quoteAsOf: "2020-01-01T00:00:00Z", price: 12 } }).indiaVix, null);
  assert.throws(() => verify('<script>function (</script>'), /Unexpected token|Function statements/);
  assert.throws(() => verify(html, null, { expectSealed: true }), /missing/);
  const book = { positions: [{ symbol: "PRIVATEONLY", quantity: 1137, mtm: -47631.29 }], totalMtm: -47631.29 };
  const encrypted = document_(fixturePlan(), sealPayload(book, "test-passphrase-only"), meta, null, broad);
  assert.equal(verify(encrypted, book, { expectSealed: true }).privateBookIncluded, true);
  assert.throws(() => verify(encrypted + " PRIVATEONLY ", book), /in the clear/);
  assert.equal(bookPayload({ positions: [{ symbol: "TEST", buyAverage: 100, markPrice: 105, quantity: 10 }] }, []).positions[0].unrealised, null);
  console.log("Portal integrity tests passed: 502+ coverage, stale-plan abstention, raw contract levels, null/freshness checks, JS compilation and encrypted-book leak rejection.");
}
if (require.main === module) run();
module.exports = { fixturePlan, run };
