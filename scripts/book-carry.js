"use strict";

// Computes carry for every position in a GM book dump.
//
// GM reports the contract price; the spot comes from the public chart feed. The
// gap between them has to close by expiry, so it is a known return or a known
// cost on every position already open — the cheapest edge on the board, because
// it needs no forecast.
//
//   node scripts/book-carry.js gm-positions.json

const fs = require("node:fs");
const { dailyBars } = require("./weekly-plan");
const { carry } = require("../api/_lib/carry");

const istDate = (ms) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"
}).format(new Date(ms));

// The basis is only the basis when both legs are read at the same moment. Taking
// the futures price from one session and spot from the next measures a day of
// price movement and labels it carry — which is how a 3% "premium" appears on a
// contract twelve days from expiry.
//
// Matching on the IST calendar date is not enough either: a capture at 19:22 UTC
// is already the next day in Kolkata, while the session it reflects closed nine
// hours earlier. The session that matches is the last one to have closed before
// the capture, so the bars are compared by timestamp.
async function spotFor(symbol, capturedMs) {
  const bars = await dailyBars(symbol);
  const match = [...bars].reverse().find((bar) => Number(bar.timestamp) * 1000 <= capturedMs);
  if (!match) throw new Error("no spot bar at or before the capture");
  return { spot: Number(match.close), session: istDate(Number(match.timestamp) * 1000) };
}

async function run() {
  const source = process.argv[2] || "gm-positions.json";
  const book = JSON.parse(fs.readFileSync(source, "utf8"));
  const capturedMs = Date.parse(book.capturedAt);
  let sessionDate = "unknown";
  const rows = [];
  let failed = 0;

  for (const position of book.positions || []) {
    const futures = Number(position.markPrice) || Number(position.price);
    try {
      const quote = await spotFor(position.symbol, capturedMs);
      const spot = quote.spot;
      sessionDate = quote.session;
      const result = carry({ futures, spot, expiry: position.expiry, side: position.position === "short" ? "short" : "long", nowMs: capturedMs });
      if (!result.ready) { failed += 1; continue; }
      rows.push({ symbol: position.symbol, quantity: Number(position.quantity), notional: futures * Number(position.quantity), ...result });
    } catch {
      failed += 1;
    }
  }

  rows.sort((left, right) => Number(left.weeklyPct) - Number(right.weeklyPct));
  const paid = rows.filter((row) => row.favourable);
  const paying = rows.filter((row) => !row.favourable);
  const weighted = rows.reduce((sum, row) => sum + Number(row.weeklyPct) * row.notional, 0)
    / Math.max(1, rows.reduce((sum, row) => sum + row.notional, 0));

  console.log(`Carry on ${rows.length} positions (${failed} without a spot quote), expiry ${rows[0]?.expiry}, ${rows[0]?.calendarDays} days out\n`);
  console.log("Costing the most this week:");
  rows.slice(0, 8).forEach((row) => console.log(`  ${row.symbol.padEnd(12)} ${row.side.padEnd(5)} basis ${String(row.basisPct).padStart(7)}%  week ${String(row.weeklyPct).padStart(7)}%  annualised ${String(row.annualisedPct).padStart(8)}%`));
  console.log("\nPaying the most this week:");
  rows.slice(-5).reverse().forEach((row) => console.log(`  ${row.symbol.padEnd(12)} ${row.side.padEnd(5)} basis ${String(row.basisPct).padStart(7)}%  week ${String(row.weeklyPct).padStart(7)}%  annualised ${String(row.annualisedPct).padStart(8)}%`));
  console.log(`\n${paid.length} positions are paid to wait, ${paying.length} pay to wait.`);
  console.log(`Notional-weighted carry for the book: ${weighted.toFixed(3)}% per week.`);
  console.log(`Against a ${2}% target, carry is ${Math.abs(weighted / 2 * 100).toFixed(1)}% of the trade before the price moves at all.`);

  const out = process.argv[3];
  if (out) {
    fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), weightedWeeklyPct: weighted, rows }, null, 2));
    console.log(`\nWritten to ${out}`);
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error(`Book carry failed: ${String(error?.message || error).slice(0, 200)}`);
    process.exitCode = 1;
  });
}

module.exports = { run };
