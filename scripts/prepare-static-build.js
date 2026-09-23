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
