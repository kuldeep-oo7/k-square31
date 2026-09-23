"use strict";

/**
 * FETCH WHAT A BRAND-NEW MACHINE DOES NOT HAVE.
 *
 * A GitHub Actions runner is destroyed after every job, so nothing is cached:
 * no exchange contract file, no price history, no broker session. The static
 * build needs all three, and each one degrades differently when it is missing.
 *
 * NOTHING HERE IS FATAL. If the contract file cannot be fetched the page is
 * built from whatever is committed and says so; if the broker will not
 * authenticate the prices come from the settlement file and the page says that
 * too. A snapshot that admits what it is beats a blank page, and beats a
 * confident page built on nothing.
 */

const fs = require("node:fs");
const path = require("node:path");

function loadEnvFile() {
  const file = path.resolve(__dirname, "..", ".private", "production.env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && !process.env[match[1]] && match[2]) process.env[match[1]] = match[2];
  }
}

async function step(label, fn) {
  const started = Date.now();
  try {
    const result = await fn();
    console.log(`  ok   ${label}  (${((Date.now() - started) / 1000).toFixed(1)}s)  ${result || ""}`);
    return true;
  } catch (error) {
    // Say what failed and carry on. The build downstream knows how to be honest
    // about missing inputs; stopping here would just produce nothing at all.
    console.log(`  SKIP ${label}  -- ${error.message}`);
    return false;
  }
}

(async () => {
  loadEnvFile();
  console.log("preparing a cold runner:");

  await step("exchange contract file", async () => {
    const { refreshReference } = require("../api/_lib/fno-reference");
    const reference = await refreshReference(new Date(), { maxLookbackDays: 7 });
    return `${reference.symbolCount} symbols, session ${reference.session}`;
  });

  // TODAY'S F&O BAN LIST, FROM NSE, EVERY BUILD.
  //
  // During a ban (open interest above 95% of the market-wide limit) NSE allows
  // only positions that REDUCE exposure -- a fresh buy is refused and penalised.
  // The desk read its ban list from data/market-coverage.json, which nothing on
  // the build server ever refreshed: measured on 2026-09-23 it was six days old
  // and missed LICHSGFIN, banned for the 24 September session. A banned stock on
  // the buy list is an order that cannot be placed.
  await step("F&O ban list for today", async () => {
    const { fetchSecurityBanList, banStateForSession } = require("../api/_lib/bhavcopy");
    const { sessionDateFor } = require("./session-freeze");
    const ban = await fetchSecurityBanList();
    if (!ban.available) throw new Error("NSE ban list unavailable: " + (ban.error || "unknown"));
    const session = sessionDateFor();
    const record = {
      tradeDate: ban.tradeDate || null,
      symbols: [...(ban.symbols || [])].sort(),
      verifiedForSession: banStateForSession(ban, session) === true ? session : null,
      source: ban.source, fetchedAt: ban.fetchedAt
    };
    const file = path.resolve(__dirname, "..", ".private", "cache", "fo-ban.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(record, null, 1));
    return record.symbols.length + " banned for " + (record.tradeDate || "?") + ": " + (record.symbols.join(", ") || "none");
  });

  await step("broker instrument master", async () => {
    const brokers = require("../api/_lib/broker-feed");
    const result = await brokers.refreshInstruments("angelone");
    return result?.optionCount ? `${result.optionCount} option contracts` : "cached";
  });

  await step("price history for the technical read", async () => {
    const { fnoUniverseEngine } = require("../api/_lib/universe-210");
    if (typeof fnoUniverseEngine.retryMissingBars !== "function") return "not available";
    const result = await fnoUniverseEngine.retryMissingBars({ limit: 210 });
    return `${result.retried} fetched, ${result.remaining} still missing`;
  });

  // THE LOGIN, ON EVERY BUILD, WHETHER OR NOT THE MARKET IS OPEN.
  //
  // Live quotes are only fetched in session, so without this the first time
  // anything logged in to Angel One from a GitHub server would have been 09:33
  // on a trading morning -- the worst possible moment to learn that it does not
  // work. The rules allow it (Angel One, from 1 April 2026: "For APIs other than
  // Orders & GTT, using a static IP is not mandatory"), but a rule is not a
  // measurement. One login and one four-leg quote settles it.
  //
  // The answer is written where the page can show it, because an empty options
  // table looks identical whether the login failed or the exchange is shut for
  // a holiday, and the two need completely different fixes.
  await step("broker login and one live quote", async () => {
    const checkFile = path.resolve(__dirname, "..", ".private", "cache", "broker-check.json");
    const record = (result) => {
      fs.mkdirSync(path.dirname(checkFile), { recursive: true });
      fs.writeFileSync(checkFile, JSON.stringify({ checkedAt: new Date().toISOString(), ...result }));
    };
    const auth = require("../api/_lib/broker-auth");
    if (!auth.credentialFile()) {
      record({ ok: false, stage: "CREDENTIALS", reason: "NO_BROKER_CREDENTIALS" });
      throw new Error("no broker credentials on this runner");
    }
    const session = await auth.angelEnsureSession();
    if (!session.ok) {
      const why = session.message || session.detail || null;
      record({ ok: false, stage: "LOGIN", reason: session.reason, message: why });
      throw new Error("login refused: " + session.reason + (why ? " -- " + why : ""));
    }
    const { tradableExpiry } = require("../api/_lib/fno-reference");
    const front = tradableExpiry("NIFTY", { minDays: 0 });
    const brokers = require("../api/_lib/broker-feed");
    const chain = front ? await brokers.angelOptionChain("NIFTY", front.expiry, { strikesEitherSide: 1 }) : null;
    if (!chain?.ok) {
      const why = chain?.reason || "NO_NIFTY_EXPIRY_IN_REFERENCE";
      record({ ok: false, stage: "QUOTE", reason: why, message: chain?.message || null });
      throw new Error("logged in, but the quote was refused: " + why);
    }
    const leg = chain.chain.find((l) => Number(l.lastPrice) > 0) || chain.chain[0] || null;
    record({
      ok: true, stage: "QUOTE", expiry: front.expiry, legs: chain.strikeCount,
      sample: leg ? { strike: leg.strike, type: leg.optionType, lastPrice: leg.lastPrice } : null
    });
    return "logged in from this runner and priced " + chain.strikeCount + " NIFTY " + front.expiry + " legs"
      + (leg ? " (" + leg.strike + leg.optionType + " last " + leg.lastPrice + ")" : "");
  });

  await step("live option quotes", async () => {
    const live = require("../api/_lib/live-quotes");
    const phase = live.marketPhase();
    if (!phase.open) return `market ${phase.phase}, settlement prices are the only prices there are`;
    const { RealtimeMarketEngine } = require("../api/_lib/realtime-market-engine");
    const engine = new RealtimeMarketEngine();
    const result = await engine.refreshLiveQuotes({ limit: 60 });
    try { engine.stop(); } catch (error) { /* nothing started */ }
    return result?.refreshed ? `${result.refreshed} chains` : "none";
  });

  console.log("prepared.");
  process.exit(0);
})().catch((error) => {
  console.error("preparation failed outright:", error.message);
  // Still zero: the build after this is designed to cope and to label itself.
  process.exit(0);
});
