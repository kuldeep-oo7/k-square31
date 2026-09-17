"use strict";

/**
 * TradingView public scanner.
 *
 * The freshness contract is the point of these tests. A 15-minute-delayed price
 * is fine for ranking a universe and wrong for quoting a fill, and the only
 * thing preventing the second use is that the delay travels with the number.
 */

const assert = require("node:assert/strict");
const { freshnessFor, optionQuote, quotes } = require("../api/_lib/tradingview-quotes");

// --- freshness classification ------------------------------------------------
const realtime = freshnessFor("streaming");
assert.equal(realtime.kind, "REALTIME");
assert.equal(realtime.executable, true, "a streaming quote can be transacted against");

const delayed = freshnessFor("delayed_streaming_900");
assert.equal(delayed.kind, "DELAYED");
assert.equal(delayed.delaySeconds, 900, "the delay must be extracted, not rounded away");
assert.equal(delayed.executable, false, "a 15-minute-old price is not a fill price");

assert.equal(freshnessFor("end_of_day").kind, "END_OF_DAY");
assert.equal(freshnessFor("end_of_day").executable, false);
// Anything unrecognised is assumed stale, never assumed live.
assert.equal(freshnessFor("something_new").kind, "UNKNOWN");
assert.equal(freshnessFor("something_new").executable, false, "an unknown mode must not be treated as live");
assert.equal(freshnessFor(null).executable, false);
assert.equal(freshnessFor(undefined).kind, "UNKNOWN");
console.log("  ✓ Freshness classified from update_mode; unknown modes are never called live");

// --- options are refused, with evidence --------------------------------------
const option = optionQuote();
assert.equal(option.ok, false, "TradingView's public API has no Indian options");
assert.equal(option.quote, null, "a refusal carries no data");
assert.ok(option.reason.includes("OPTIONS_NOT_AVAILABLE"));
assert.ok(option.evidence.includes("search_type_not_found"),
  "the refusal must cite the evidence, so nobody re-tries it on a hunch");
assert.ok(option.useInstead.includes("bhavcopy"), "a refusal should name the working alternative");
console.log("  ✓ Option requests refuse with the evidence for why, and name the alternative");

// --- empty input --------------------------------------------------------------
(async () => {
  const none = await quotes([]);
  assert.equal(none.ok, false);
  assert.equal(none.reason, "NO_TICKERS");
  assert.deepEqual(none.quotes, {});

  // Network path: exercised only when reachable, so the suite stays green offline.
  const live = await quotes(["NSE:RELIANCE", "NSE:NOT_A_REAL_TICKER_XYZ"]);
  if (live.ok) {
    assert.ok(live.missing.includes("NSE:NOT_A_REAL_TICKER_XYZ"),
      "a symbol the scanner drops must be reported missing, never filled in");
    const reliance = live.quotes["NSE:RELIANCE"];
    if (reliance) {
      assert.ok(reliance.price > 0, "a returned quote needs a positive price");
      assert.equal(reliance.provider, "TRADINGVIEW_SCANNER");
      assert.equal(reliance.quoteAsOf, null,
        "the scanner gives no exchange timestamp, so none may be invented from retrieval time");
      assert.ok(typeof reliance.executable === "boolean", "every quote must state whether it is executable");
      console.log(`  ✓ Live bulk quote: RELIANCE ${reliance.price}, ${reliance.freshness} ${reliance.delaySeconds}s, executable ${reliance.executable}`);
    }
  } else {
    console.log(`  - scanner unreachable (${live.reason}); live path skipped`);
  }
  console.log("TradingView quote tests passed: freshness contract, option refusal with evidence, missing symbols reported rather than filled");
})();
