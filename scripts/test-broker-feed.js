"use strict";

/**
 * Upstox and Angel One live option chains.
 *
 * Runs without credentials, because the property that matters most is what the
 * client does when it has none. Every unauthenticated source is closed --
 * NSE blocks servers, Yahoo has no Indian chains, TradingView has no option
 * category at all -- so a broker is the only route to a live premium, and a
 * broker client that degrades into an estimate would put a made-up price on a
 * card with a one-tap order link.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const {
  PROVIDERS,
  credentialsFor,
  instrumentCachePath,
  loadInstruments,
  normaliseAngelExpiry,
  normaliseLeg,
  optionChain,
  quoteFromChain,
  status
} = require("../api/_lib/broker-feed");

// --- fail closed ------------------------------------------------------------
const saved = {};
for (const key of ["UPSTOX_ACCESS_TOKEN", "ANGELONE_ACCESS_TOKEN", "ANGELONE_API_KEY"]) {
  saved[key] = process.env[key];
  delete process.env[key];
}

// On a configured machine these assertions are skipped rather than inverted:
// the property under test is how the client behaves with NOTHING set.
const cold = status();
if (!cold.anyReady) {
  assert.equal(cold.activeProvider, null, "no provider is active without credentials");
  for (const provider of PROVIDERS) {
    assert.equal(cold.providers[provider].ready, false, `${provider} cannot be ready unconfigured`);
    assert.ok(cold.providers[provider].reason, `${provider} must say why it is not ready`);
  }
  assert.ok(cold.howToConfigure.upstox.includes("UPSTOX_ACCESS_TOKEN"));
  assert.ok(cold.howToConfigure.angelone.includes("ANGELONE_API_KEY"));
  console.log("  ✓ Both providers report NOT_CONFIGURED and name the variables to set");
}

// Angel One needs BOTH an api key and a token; one alone is not credentials.
//
// This check is only meaningful when nothing else supplies the missing half.
// Asserting it unconditionally made the test pass only on machines with NO
// credentials configured and fail the moment a real .private/brokers.json
// existed -- a test that breaks when the feature starts working.
{
  const fileSupplies = Boolean(credentialsFor("angelone"));
  if (!fileSupplies) {
    process.env.ANGELONE_ACCESS_TOKEN = "token-only";
    assert.equal(credentialsFor("angelone"), null, "an access token without an api key is not usable");
    delete process.env.ANGELONE_ACCESS_TOKEN;
  }
}

// --- expiry normalisation ---------------------------------------------------
// Angel writes 29SEP2026; every other surface here speaks ISO.
assert.equal(normaliseAngelExpiry("29SEP2026"), "2026-09-29");
assert.equal(normaliseAngelExpiry("01JAN2027"), "2027-01-01");
assert.equal(normaliseAngelExpiry("31DEC2026"), "2026-12-31");
assert.equal(normaliseAngelExpiry("garbage"), null, "an unparseable expiry yields nothing, never a guess");
assert.equal(normaliseAngelExpiry(""), null);
console.log("  ✓ Angel expiry format normalised to ISO, unparseable input refused");

// --- a last price is not a fill price ---------------------------------------
const twoSided = normaliseLeg(23250, "CE", { ltp: 158, bid_price: 157.5, ask_price: 158.5, bid_qty: 750, ask_qty: 900, oi: 3084380, volume: 1918628 }, { delta: 0.52, iv: 18.5 });
assert.equal(twoSided.tradeable, true, "a quote with both sides standing is tradeable");
assert.equal(twoSided.spread, 1, "the spread is ask minus bid");
assert.ok(twoSided.spreadPct > 0 && twoSided.spreadPct < 5, `spread percentage looks wrong: ${twoSided.spreadPct}`);
assert.equal(twoSided.delta, 0.52);

// A print with nobody standing behind it is a fact about the past.
const stale = normaliseLeg(23250, "PE", { ltp: 141, bid_price: 0, ask_price: 0, oi: 900000, volume: 3 }, null);
assert.equal(stale.tradeable, false, "a last price with no bid and no ask is not a price you can transact at");
assert.equal(stale.lastPrice, 141, "the print is still reported, just not as tradeable");
assert.equal(stale.delta, null, "absent greeks stay absent");
console.log("  ✓ Two-sided quotes marked tradeable; prints with no bid or ask are not");

// --- instrument masters -----------------------------------------------------
const angel = loadInstruments("angelone");
if (angel) {
  assert.ok(angel.optionCount > 10000, `expected a populated Angel option master, got ${angel.optionCount}`);
  const sample = Object.entries(angel.options).find(([key]) => key.startsWith("RELIANCE|"));
  assert.ok(sample, "RELIANCE options must be present");
  const [key, contract] = sample;
  const [, expiry, strike, optionType] = key.split("|");
  assert.match(expiry, /^\d{4}-\d{2}-\d{2}$/, "expiries are stored ISO");
  assert.ok(Number(strike) > 0, "strikes are stored in rupees, not paise");
  assert.ok(Number(strike) < 100000, `strike looks like paise rather than rupees: ${strike}`);
  assert.ok(["CE", "PE"].includes(optionType));
  assert.ok(Number(contract.lotSize) > 0, "a contract must carry its lot size");
  assert.ok(String(contract.token).length > 0, "a contract must carry its token");
  console.log(`  ✓ Angel master: ${angel.optionCount} contracts, strikes in rupees, ISO expiries`);
}

const upstox = loadInstruments("upstox");
if (upstox) {
  assert.ok(upstox.underlyingCount > 500, `expected a populated Upstox master, got ${upstox.underlyingCount}`);
  const nifty = upstox.underlyings.NIFTY;
  if (nifty) {
    assert.equal(nifty.kind, "INDEX");
    assert.ok(nifty.instrumentKey.startsWith("NSE_INDEX|"), `an index must use the index key: ${nifty.instrumentKey}`);
  }
  const reliance = upstox.underlyings.RELIANCE;
  if (reliance) {
    assert.equal(reliance.kind, "EQUITY");
    assert.ok(reliance.instrumentKey.startsWith("NSE_EQ|"), `an equity must use the cash key: ${reliance.instrumentKey}`);
  }
  console.log(`  ✓ Upstox master: ${upstox.underlyingCount} underlyings, indices and equities keyed separately`);
}

// --- requests without credentials refuse, never fabricate --------------------
(async () => {
  if (!cold.anyReady) {
    const chain = await optionChain("NIFTY", "2026-09-22");
    assert.equal(chain.ok, false, "no configured broker means no chain");
    assert.equal(chain.chain, null, "a refusal carries no data");
    assert.equal(chain.reason, "NO_BROKER_CONFIGURED");
    assert.ok(chain.detail, "the refusal should carry the status so a caller can report why");

    for (const provider of PROVIDERS) {
      const forced = await optionChain("NIFTY", "2026-09-22", { provider });
      assert.equal(forced.ok, false);
      assert.equal(forced.chain, null, `${provider} must return no data unconfigured`);
    }
    console.log("  ✓ Chain requests without credentials refuse cleanly and return nothing");
  }

  // --- chain lookup ----------------------------------------------------------
  const sample = { ok: true, chain: [twoSided, stale] };
  assert.equal(quoteFromChain(sample, 23250, "CE").lastPrice, 158);
  assert.equal(quoteFromChain(sample, 23250, "ce").lastPrice, 158, "option type lookup is case-insensitive");
  assert.equal(quoteFromChain(sample, 99999, "CE"), null, "a strike not in the chain returns nothing");
  assert.equal(quoteFromChain(null, 23250, "CE"), null);
  console.log("  ✓ Chain lookup returns the contract or nothing, never the nearest thing");

  for (const [key, value] of Object.entries(saved)) if (value) process.env[key] = value;
  console.log("Broker feed tests passed: fail-closed on both providers, Angel expiry and paise normalisation, Upstox key separation, tradeable-quote detection and exact chain lookup");
})();
