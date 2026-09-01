"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { sendDailyTradeEmail, DEFAULT_RECIPIENT } = require("../api/_lib/emailer");
const { evaluateGlobalMacroShock } = require("../api/_lib/market-regime");

async function run() {
  console.log("=== K² Daily Trade & Defense Alert Dispatcher ===");

  // 1. Evaluate Macro Threat Radar
  const radar = evaluateGlobalMacroShock({
    giftNiftyGapPct: 0.15,
    indiaVix: 11.19,
    brentCrudeSpikePct: 3.0,
    sp500FuturesGapPct: -0.47
  });

  // 2. Triage Open Holdings
  let sells = [];
  let holds = [];

  const positionsPath = path.resolve(__dirname, "../gm-dump-result/gm-positions.json");
  if (fs.existsSync(positionsPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(positionsPath, "utf8"));
      const positions = data.positions || [];
      // Flag NATIONALUM specifically if present
      sells.push({
        symbol: "NATIONALUM",
        price: 372.00,
        reason: "Breached ₹374.56 stop-loss on Tuesday. Cut at 9:15 AM open to protect capital."
      });
      // Flag extreme portfolio bleeders
      const bleeders = positions.filter(p => {
        const loss = ((p.markPrice - p.buyAverage) / p.buyAverage) * 100;
        return loss <= -3.5;
      });
      bleeders.slice(0, 4).forEach(b => {
        sells.push({
          symbol: b.symbol,
          price: b.markPrice || b.buyAverage,
          reason: `Down ${(((b.markPrice - b.buyAverage) / b.buyAverage) * 100).toFixed(1)}% from entry. Trim/Cut.`
        });
      });

      // Active holds
      holds.push({
        symbol: "GLENMARK",
        status: "HOLD STRONG",
        current: 2470.40,
        trailingStop: 2445.00,
        target: 2555.20
      });
      holds.push({
        symbol: "CHOLAFIN",
        status: "HOLD AT COST",
        current: 1814.70,
        trailingStop: 1794.00,
        target: 1858.80
      });
    } catch (e) {
      console.warn("Could not read gm-positions:", e.message);
    }
  }

  // 3. Top Buy Setups
  const buys = [
    { symbol: "CGPOWER", level: 1, entry: 832.15, maxCap: 838.80, target: 852.12, stop: 822.16 },
    { symbol: "SOLARINDS", level: 1, entry: 18816.31, maxCap: 18966.84, target: 19463.59, stop: 18492.67 },
    { symbol: "APLAPOLLO", level: 1, entry: 2127.09, maxCap: 2144.10, target: 2183.67, stop: 2098.80 },
    { symbol: "ABB", level: 1, entry: 7047.65, maxCap: 7104.00, target: 7219.61, stop: 6961.67 }
  ];

  // 4. Shorts and Put Option Hedging
  const shortsAndPuts = [
    { name: "SUPREMEIND (Equity Short)", action: "SHORT LADDER", entry: 3920.03, target: 3819.68, stop: 3970.21 },
    { name: "NIFTY 24000 PE (Index Put Hedge)", action: "BUY PUT OPTION", entry: 185.00, target: 320.00, stop: 110.00 }
  ];

  const payload = {
    dateStr: new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "long", year: "numeric", month: "long", day: "numeric" }),
    radar: {
      severity: radar.regime,
      summary: `GIFT Nifty at 24,055 (+0.15%), India VIX at 11.19 (Low panic). Brent crude at $93.27 (+3.0%). Shield status: ${radar.description}`
    },
    sells,
    buys,
    shortsAndPuts,
    holds
  };

  const result = await sendDailyTradeEmail(payload);
  console.log("Dispatch completed successfully to:", DEFAULT_RECIPIENT);
  return result;
}

if (require.main === module) {
  run().catch(console.error);
}

module.exports = { run };
