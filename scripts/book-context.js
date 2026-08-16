"use strict";

// Per-holding trend and carry for the book.
//
// The portal derives each position's verdict from the weekly plan, but that plan
// rejects most names at the significance hurdle and never reaches the trend or
// carry checks — so a holding leaning hard against its own twelve-month trend
// was displayed as an unremarkable "no measured edge". These two readings do not
// depend on the ladder having an edge, so they are measured for every position
// directly.
//
// Carry comes from the bhavcopy rather than the GM mark, because the bhavcopy
// carries the futures price and its underlying in the same row and cannot drift
// apart in time.
//
//   node scripts/book-context.js gm-positions.json book-context.json

const fs = require("node:fs");
const { dailyBars } = require("./weekly-plan");
const { trendGate } = require("../api/_lib/trend");
const { carry } = require("../api/_lib/carry");
const { latestBhavcopy, frontFutures } = require("../api/_lib/bhavcopy");

async function run() {
  const source = process.argv[2] || "gm-positions.json";
  const destination = process.argv[3] || "book-context.json";
  const book = JSON.parse(fs.readFileSync(source, "utf8"));

  let front = new Map();
  let asOf = Date.parse(book.capturedAt) || Date.now();
  try {
    const bhav = await latestBhavcopy();
    front = frontFutures(bhav.rows);
    asOf = Date.parse(`${bhav.tradeDate.slice(0, 4)}-${bhav.tradeDate.slice(4, 6)}-${bhav.tradeDate.slice(6, 8)}T10:00:00Z`);
    console.log(`Contract prices from the ${bhav.tradeDate} bhavcopy: ${front.size} names`);
  } catch (error) {
    console.warn(`No bhavcopy (${String(error?.message || error).slice(0, 80)}); carry will be omitted.`);
  }

  const context = {};
  let blocked = 0;
  let costing = 0;
  for (const position of book.positions || []) {
    const symbol = String(position.symbol || "").toUpperCase();
    if (context[symbol]) continue;
    const side = position.position === "short" ? "short" : "long";
    const entry = { side };

    try {
      const gate = trendGate(await dailyBars(symbol), side);
      if (gate.ready) {
        entry.trend = {
          returnPct: gate.returnPct,
          scaled: gate.scaled,
          blocked: gate.blocked,
          // Stated from the position's point of view, which is what the reader
          // needs: "with" or "against", not a raw sign.
          label: gate.blocked ? "against the trend" : "with the trend"
        };
        if (gate.blocked) blocked += 1;
      }
    } catch (error) {
      entry.trend = { label: "trend unavailable", reason: String(error?.message || error).slice(0, 60) };
    }

    const contract = front.get(symbol);
    if (contract) {
      const basis = carry({ futures: contract.futures, spot: contract.spot, expiry: contract.expiry, side, nowMs: asOf });
      if (basis.ready) {
        entry.carry = {
          basisPct: basis.basisPct,
          weeklyPct: basis.weeklyPct,
          state: basis.state,
          favourable: basis.favourable,
          lotSize: contract.lotSize
        };
        if (!basis.favourable) costing += 1;
      }
    }
    context[symbol] = entry;
  }

  fs.writeFileSync(destination, JSON.stringify({ generatedAt: new Date().toISOString(), context }, null, 2));
  const total = Object.keys(context).length;
  console.log(`${total} holdings measured: ${blocked} against their twelve-month trend, ${costing} paying carry to wait.`);
  console.log(`Written to ${destination}`);
}

if (require.main === module) {
  run().catch((error) => {
    console.error(`Book context failed: ${String(error?.message || error).slice(0, 200)}`);
    process.exitCode = 1;
  });
}

module.exports = { run };
