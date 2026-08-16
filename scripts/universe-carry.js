"use strict";

// Carry for every F&O name, from NSE's public bhavcopy.
//
//   node scripts/universe-carry.js                 latest session
//   node scripts/universe-carry.js --out carry.json

const fs = require("node:fs");
const { latestBhavcopy, frontFutures } = require("../api/_lib/bhavcopy");
const { carry } = require("../api/_lib/carry");

function argument(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function run() {
  const book = await latestBhavcopy();
  const front = frontFutures(book.rows);
  const asOf = Date.parse(`${book.tradeDate.slice(0, 4)}-${book.tradeDate.slice(4, 6)}-${book.tradeDate.slice(6, 8)}T10:00:00Z`);

  const rows = [];
  for (const entry of front.values()) {
    // Both sides are reported: the same basis is a cost to one and a credit to
    // the other, and the desk trades both ladders.
    const long = carry({ futures: entry.futures, spot: entry.spot, expiry: entry.expiry, side: "long", nowMs: asOf });
    if (!long.ready) continue;
    rows.push({
      symbol: entry.symbol,
      instrument: entry.instrument,
      expiry: entry.expiry,
      futures: entry.futures,
      spot: entry.spot,
      lotSize: entry.lotSize,
      openInterest: entry.openInterest,
      basisPct: long.basisPct,
      longWeeklyPct: long.weeklyPct,
      shortWeeklyPct: -long.weeklyPct,
      annualisedPct: long.annualisedPct,
      calendarDays: long.calendarDays,
      state: long.state
    });
  }
  rows.sort((left, right) => right.basisPct - left.basisPct);

  const median = rows.length ? rows[Math.floor(rows.length / 2)].basisPct : null;
  console.log(`NSE F&O bhavcopy ${book.tradeDate}: ${book.rows.length} contract rows, ${rows.length} front-month futures\n`);
  console.log(`Median basis ${median}%, ${rows.filter((row) => row.state === "premium").length} at a premium, ${rows.filter((row) => row.state === "discount").length} at a discount\n`);

  console.log("Richest futures — the short ladder is paid to wait:");
  rows.slice(0, 8).forEach((row) => console.log(`  ${row.symbol.padEnd(13)} basis ${String(row.basisPct).padStart(7)}%  short earns ${String(row.shortWeeklyPct).padStart(6)}%/wk  (${row.calendarDays}d)`));
  console.log("\nCheapest futures — the buy ladder is paid to wait:");
  rows.slice(-8).reverse().forEach((row) => console.log(`  ${row.symbol.padEnd(13)} basis ${String(row.basisPct).padStart(7)}%  long earns  ${String(row.longWeeklyPct).padStart(6)}%/wk  (${row.calendarDays}d)`));

  const out = argument("out");
  if (out) {
    fs.writeFileSync(out, JSON.stringify({ tradeDate: book.tradeDate, generatedAt: new Date().toISOString(), rows }, null, 2));
    console.log(`\nWritten to ${out}: ${rows.length} names`);
  }
  return rows;
}

if (require.main === module) {
  run().catch((error) => {
    console.error(`Universe carry failed: ${String(error?.message || error).slice(0, 200)}`);
    process.exitCode = 1;
  });
}

module.exports = { run };
