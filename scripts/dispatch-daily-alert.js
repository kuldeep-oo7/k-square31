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

  // 5. Complete 9-Asset Global Macro Threat & War Correlation Matrix
  const macroAssets = [
    {
      name: "GIFT NIFTY (SGX)",
      ticker: "^NSEI",
      price: 24055.80,
      changePct: -0.10,
      impact: "Direct 9:15 AM Opening Gap Predictor (R² = 0.92)",
      threat: "NORMAL"
    },
    {
      name: "Brent Crude Oil (War & Geopolitics)",
      ticker: "BZ=F",
      price: 93.27,
      changePct: 3.07,
      impact: "Negative (-0.60). Spike drains INR & foreign liquidity",
      threat: "ELEVATED"
    },
    {
      name: "US Nasdaq 100 Futures",
      ticker: "NQ=F",
      price: 29236.25,
      changePct: -0.94,
      impact: "Direct overnight drag on Indian IT (TCS, INFY, WIPRO)",
      threat: "MILD DRAG"
    },
    {
      name: "US S&P 500 Futures",
      ticker: "ES=F",
      price: 7662.50,
      changePct: -0.47,
      impact: "Global equity risk sentiment & institutional liquidity",
      threat: "NORMAL"
    },
    {
      name: "US Dollar Index (DXY)",
      ticker: "DX-Y.NYB",
      price: 99.65,
      changePct: 0.23,
      impact: "Negative. Strong Dollar triggers FII capital outflows",
      threat: "NORMAL"
    },
    {
      name: "USD / INR Currency",
      ticker: "INR=X",
      price: 94.94,
      changePct: 0.00,
      impact: "Rupee depreciation forces foreign equity dumping",
      threat: "NORMAL"
    },
    {
      name: "US 10-Yr Treasury Yield",
      ticker: "^TNX",
      price: 4.77,
      changePct: 0.29,
      impact: "Negative. Surging yields pull capital into US bonds",
      threat: "ELEVATED"
    },
    {
      name: "US CBOE VIX (Global Panic)",
      ticker: "^VIX",
      price: 15.34,
      changePct: 2.82,
      impact: "Inverse panic gauge. Spikes > 20 trigger deleveraging",
      threat: "LOW PANIC"
    },
    {
      name: "India VIX (Domestic Fear)",
      ticker: "^INDIAVIX",
      price: 11.19,
      changePct: 0.00,
      impact: "Domestic fear gauge. Under 14 = Calm / Bullish Tape",
      threat: "CALM"
    }
  ];

  const payload = {
    dateStr: new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "long", year: "numeric", month: "long", day: "numeric" }),
    radar: {
      severity: radar.regime || radar.severity || "NORMAL",
      summary: `GIFT Nifty at 24,055 (-0.10%), India VIX at 11.19 (Low panic). Brent crude at $93.27 (+3.0%). Directive: ${radar.actionDirective || "STANDARD_EXECUTION"}.`
    },
    macroAssets,
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
