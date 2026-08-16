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

    // The underlying's medium-term range, for context on where the mark sits.
    // Labelled as the underlying because these are spot bars; the contract's own
    // high and low come from the bhavcopy below.
    try {
      const bars = await dailyBars(symbol);
      const window = (count) => bars.slice(-count);
      const lowOf = (list) => Math.min(...list.map((bar) => Number(bar.low)));
      const highOf = (list) => Math.max(...list.map((bar) => Number(bar.high)));
      if (bars.length >= 21) {
        entry.range = {
          monthLow: Math.round(lowOf(window(21)) * 100) / 100,
          monthHigh: Math.round(highOf(window(21)) * 100) / 100,
          yearLow: Math.round(lowOf(window(Math.min(252, bars.length))) * 100) / 100,
          yearHigh: Math.round(highOf(window(Math.min(252, bars.length))) * 100) / 100,
          spot: Math.round(Number(bars.at(-1).close) * 100) / 100
        };
      }
    } catch { /* the trend read above already reported the fetch failure */ }

    const contract = front.get(symbol);
    if (contract) {
      // GM reports no live mark once the session closes, which left the portal
      // showing the entry price as the mark and every P&L as zero. The bhavcopy
      // close is a real, dated contract price, so it is used whenever GM has
      // nothing live to offer.
      entry.mark = {
        price: contract.futures,
        source: "NSE close",
        dayHigh: contract.dayHigh,
        dayLow: contract.dayLow,
        previousClose: contract.previousClose,
        lotSize: contract.lotSize
      };
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
