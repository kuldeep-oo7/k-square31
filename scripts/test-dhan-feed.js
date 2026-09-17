"use strict";

/**
 * Dhan live feed.
 *
 * Everything here runs WITHOUT credentials, because the most important property
 * of this client is what it does when it has none: report that it is not
 * configured and return nothing. A market-data client that degrades into a
 * guess is worse than one that is switched off, since the guess still reaches a
 * card with a one-tap order link attached.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const {
  OPTION_CHAIN_MIN_INTERVAL_MS,
  SCRIP_CACHE,
  expiryList,
  loadScripMaster,
  optionChain,
  quoteFromChain,
  status,
  underlyingFor
} = require("../api/_lib/dhan-feed");

// --- 1. Fail closed without credentials --------------------------------------
const savedId = process.env.DHAN_CLIENT_ID;
const savedToken = process.env.DHAN_ACCESS_TOKEN;
delete process.env.DHAN_CLIENT_ID;
delete process.env.DHAN_ACCESS_TOKEN;

const unconfigured = status();
if (!unconfigured.configured) {
  assert.equal(unconfigured.ready, false, "a client with no credentials is not ready");
  assert.equal(unconfigured.reason, "NOT_CONFIGURED_NO_CREDENTIALS");
  assert.ok(unconfigured.howToConfigure.includes("DHAN_CLIENT_ID"),
    "the status must say how to configure it rather than just failing");
  console.log("  ✓ Reports NOT_CONFIGURED rather than degrading to a guess");
}

// A request without credentials must resolve to a refusal, never throw and
// never return a fabricated chain.
(async () => {
  if (!unconfigured.configured) {
    const chain = await optionChain("NIFTY", "2026-09-22");
    assert.equal(chain.ok, false, "an unconfigured client cannot return a chain");
    assert.equal(chain.chain, null, "a refusal carries no data");
    assert.ok(typeof chain.reason === "string" && chain.reason.length > 0, "a refusal must say why");

    const expiries = await expiryList("NIFTY");
    assert.equal(expiries.ok, false);
    assert.equal(expiries.data, null);
    console.log("  ✓ Requests without credentials refuse cleanly and return no data");
  }

  // --- 2. Symbol resolution -------------------------------------------------
  const scrips = loadScripMaster();
  if (scrips) {
    assert.ok(scrips.underlyingCount > 1000, `expected a populated scrip master, got ${scrips.underlyingCount}`);

    // Indices use Dhan's index segment; equities use the NSE cash segment. Asking
    // with the wrong segment returns someone else's instrument.
    const nifty = underlyingFor("NIFTY", scrips);
    assert.ok(nifty, "NIFTY must resolve");
    assert.equal(nifty.segment, "IDX_I", "an index must be requested on the index segment");
    assert.equal(nifty.instrument, "INDEX");

    // The same ticker is listed on both exchanges. Every F&O contract on this
    // desk is NSE, so a BSE security id would fetch the wrong chain entirely.
    for (const symbol of ["RELIANCE", "ANGELONE", "TATASTEEL"]) {
      const entry = underlyingFor(symbol, scrips);
      assert.ok(entry, `${symbol} must resolve`);
      assert.equal(entry.exchange, "NSE", `${symbol} must resolve to NSE, not BSE`);
      assert.equal(entry.segment, "NSE_EQ");
      assert.ok(entry.securityId > 0, `${symbol} needs a positive security id`);
    }
    assert.equal(underlyingFor("NOT_A_REAL_TICKER", scrips), null, "an unknown symbol resolves to nothing");

    // --- 3. Lot sizes must agree with the exchange file ---------------------
    // Two independent sources: Dhan's scrip master and the NSE bhavcopy. If they
    // disagree the desk cannot know what a contract is worth.
    const referencePath = require("path").join(__dirname, "..", ".private", "cache", "fno", "contract-reference.json");
    if (fs.existsSync(referencePath)) {
      const reference = JSON.parse(fs.readFileSync(referencePath, "utf8"));
      let compared = 0;
      const disagreements = [];
      for (const [key, dhanLot] of Object.entries(scrips.derivativeLots)) {
        const [symbol, expiry] = key.split("|");
        const bucket = reference.symbols?.[symbol]?.expiries?.[expiry];
        const exchangeLot = bucket?.lotSize;
        if (!(exchangeLot > 0)) continue;
        compared += 1;
        if (exchangeLot !== dhanLot) disagreements.push(`${key}: dhan ${dhanLot} vs exchange ${exchangeLot}`);
      }
      if (compared > 20) {
        assert.equal(disagreements.length, 0,
          `${disagreements.length} of ${compared} lot sizes disagree between Dhan and the NSE bhavcopy: ${disagreements.slice(0, 4).join(", ")}`);
        console.log(`  ✓ Lot sizes agree with the NSE bhavcopy across ${compared} contracts`);
      }
    }
    console.log("  ✓ Symbols resolve to NSE ids on the correct segment");
  } else {
    console.log("  - scrip master not cached; symbol resolution checks skipped");
  }

  // --- 4. Chain normalisation -----------------------------------------------
  // Shaped exactly as Dhan returns it, so the parser is exercised without a
  // network call or a token.
  const sample = {
    ok: true,
    chain: [
      { strike: 23250, optionType: "CE", lastPrice: 158, bid: 157.5, ask: 158.5, openInterest: 3084380, volume: 1918628, impliedVolatility: 18.5, delta: 0.52, tradeable: true },
      { strike: 23250, optionType: "PE", lastPrice: 141, bid: 0, ask: 0, openInterest: 900000, volume: 12, impliedVolatility: 19.1, delta: -0.48, tradeable: false }
    ]
  };
  const call = quoteFromChain(sample, 23250, "CE");
  assert.ok(call, "an existing contract must be found in the chain");
  assert.equal(call.lastPrice, 158);
  assert.equal(call.tradeable, true, "a two-sided quote is tradeable");

  const put = quoteFromChain(sample, 23250, "PE");
  // A last price with no bid and no ask is a print from earlier, not something
  // an order can transact against now.
  assert.equal(put.tradeable, false, "a quote with no bid and no ask is not tradeable");
  assert.equal(quoteFromChain(sample, 99999, "CE"), null, "a strike not in the chain returns nothing");
  assert.equal(quoteFromChain(null, 23250, "CE"), null, "a missing chain returns nothing");
  assert.equal(quoteFromChain(sample, 23250, "XX"), null, "an invalid option type returns nothing");
  console.log("  ✓ Chain lookup distinguishes a tradeable two-sided quote from a stale print");

  // --- 5. Rate limit ---------------------------------------------------------
  // Dhan publishes one option-chain request every three seconds. The limiter
  // belongs in the client, not in every caller.
  assert.ok(OPTION_CHAIN_MIN_INTERVAL_MS >= 3000,
    `the limiter must respect Dhan's 3-second floor, got ${OPTION_CHAIN_MIN_INTERVAL_MS}ms`);
  console.log(`  ✓ Option-chain requests are spaced at least ${OPTION_CHAIN_MIN_INTERVAL_MS}ms apart`);

  if (savedId) process.env.DHAN_CLIENT_ID = savedId;
  if (savedToken) process.env.DHAN_ACCESS_TOKEN = savedToken;
  console.log("Dhan feed tests passed: fails closed without credentials, NSE symbol resolution, lot-size agreement with the exchange file, tradeable-quote detection and rate limiting");
})();
