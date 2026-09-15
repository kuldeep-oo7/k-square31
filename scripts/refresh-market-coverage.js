"use strict";

// Public exchange data only. Does not write a trading plan, Google row or order.
const fs = require("node:fs");
const path = require("node:path");
const { latestBhavcopy, frontStockFutures, fetchSecurityBanList, banStateForSession } = require("../api/_lib/bhavcopy");
const { universe } = require("../api/_lib/universe");
const { istToday } = require("./plan-is-current");

async function run() {
  const [book, ban] = await Promise.all([latestBhavcopy(new Date(), 3), fetchSecurityBanList()]);
  const session = `${book.tradeDate.slice(0, 4)}-${book.tradeDate.slice(4, 6)}-${book.tradeDate.slice(6, 8)}`;
  const front = frontStockFutures(book.rows);
  if (front.size < 50) throw new Error("Unexpectedly small exchange universe; existing coverage preserved");
  const futuresSymbols = [...front.keys()].sort();
  const directory = new Set([...universe().map((row) => row.symbol), ...futuresSymbols]);
  const snapshot = {
    fetchedAt: new Date().toISOString(), derivativesAsOf: session,
    source: "NSE_FO_UDIFF_BHAVCOPY", derivativesVerified: true,
    orderGeneratingStockFutures: front.size, futuresSymbols,
    broadEquitiesTracked: directory.size,
    researchOnlyEquities: [...directory].filter((symbol) => !front.has(symbol)).length,
    banStatusVerified: banStateForSession(ban, istToday()),
    banTradeDate: ban.tradeDate || null,
    bannedSymbols: ban.symbols ? [...ban.symbols].sort() : null,
    scope: "DISCOVERY_SNAPSHOT_ONLY_NOT_LIVE_EXECUTION_APPROVAL"
  };
  const target = path.resolve(__dirname, "../data/market-coverage.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(`${target}.tmp`, JSON.stringify(snapshot, null, 2) + "\n");
  fs.renameSync(`${target}.tmp`, target);
  console.log(JSON.stringify({ ...snapshot, futuresSymbols: undefined }, null, 2));
}
if (require.main === module) run().catch((error) => { console.error(`Coverage refresh failed; no snapshot replaced: ${error.message}`); process.exitCode = 1; });
module.exports = { run };
