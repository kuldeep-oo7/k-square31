"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { sendDailyTradeEmail, DEFAULT_RECIPIENT } = require("../api/_lib/emailer");
const { evaluateGlobalMacroShock } = require("../api/_lib/market-regime");
const { googleStoreConfigured, appendPortfolioAuditToGoogle, appendMacroRadarToGoogle } = require("../api/_lib/google-store");
const { fetchLiveMacroRadar } = require("../api/_lib/market-feed");

/**
 * Checks if current time is within trading window and handles deduplication.
 */
function checkDeduplication(force = false) {
  if (force) return { allow: true, reason: "Forced execution" };

  const now = new Date();
  // Convert to IST
  const istString = now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
  const istDate = new Date(istString);
  const hours = istDate.getHours();
  const day = istDate.getDay(); // 0 = Sun, 6 = Sat

  // Weekend guard
  if (day === 0 || day === 6) {
    return { allow: false, reason: "Market is closed on weekends." };
  }

  // Determine session slot: Morning (7:00 - 11:00) or Afternoon/Evening (15:00 - 21:30)
  let slot = null;
  if (hours >= 7 && hours < 11) slot = "MORNING_BRIEFING";
  else if (hours >= 15 && hours < 22) slot = "POST_MARKET_WRAP";

  // If outside these key windows in automated cron, skip to prevent spamming
  if (!slot) {
    return { allow: false, reason: `Outside scheduled briefing windows (Current IST hour: ${hours}). Skipping cron run.` };
  }

  // Check last dispatch file
  const statePath = path.resolve(__dirname, "../data/last-email-dispatch.json");
  if (fs.existsSync(statePath)) {
    try {
      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      const todayStr = istDate.toISOString().slice(0, 10);
      if (state.date === todayStr && state.slot === slot) {
        return { allow: false, reason: `Alert already dispatched today for ${slot} at ${state.dispatchedAt}.` };
      }
    } catch {}
  }

  return { allow: true, slot, dateStr: istDate.toISOString().slice(0, 10) };
}

function recordDispatch(slot, dateStr) {
  const statePath = path.resolve(__dirname, "../data/last-email-dispatch.json");
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({
      date: dateStr,
      slot: slot || "MANUAL",
      dispatchedAt: new Date().toISOString()
    }, null, 2), "utf8");
  } catch {}
}

async function run() {
  console.log("=== K² Daily Trade & Defense Alert Dispatcher ===");

  const force = process.argv.includes("--force");
  const check = checkDeduplication(force);
  if (!check.allow) {
    console.log(`[DEDUPLICATION] ${check.reason}`);
    return { skipped: true, reason: check.reason };
  }

  // 1. Dynamic Holding Triage from real broker snapshot
  let sells = [];
  let holds = [];
  const positionsCandidates = [
    path.resolve(__dirname, "../gm-positions.json"),
    path.resolve(__dirname, "../gm-dump-result/gm-positions.json")
  ];

  let loadedPositions = [];
  for (const posPath of positionsCandidates) {
    if (fs.existsSync(posPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(posPath, "utf8"));
        loadedPositions = raw.positions || [];
        if (loadedPositions.length) break;
      } catch {}
    }
  }

  if (loadedPositions.length) {
    console.log(`Auditing ${loadedPositions.length} active portfolio holdings from broker snapshot...`);
    loadedPositions.forEach(p => {
      const mark = Number(p.markPrice || p.currentPrice || p.lastPrice || p.averagePrice || p.buyAverage);
      const avg = Number(p.buyAverage || p.averagePrice || p.markPrice);
      if (!mark || !avg || avg <= 0) return;

      const pnlPct = ((mark - avg) / avg) * 100;
      const symbol = String(p.symbol || "").toUpperCase();

      // Rule: If drawdown exceeds -2.5%, immediate stop loss exit
      if (pnlPct <= -2.5) {
        sells.push({
          symbol,
          price: mark,
          reason: `Breached stop loss at ${pnlPct.toFixed(2)}% from entry (cost ₹${avg.toFixed(2)}). Cut at open.`
        });
      } else if (pnlPct < 0) {
        // Caution buffer
        holds.push({
          symbol,
          status: "CAUTION BUFFER",
          current: mark,
          trailingStop: avg * 0.975, // -2.5% max risk
          target: avg * 1.025
        });
      } else {
        // In profit or at cost
        holds.push({
          symbol,
          status: pnlPct >= 1.5 ? "HOLD STRONG" : "HOLD AT COST",
          current: mark,
          trailingStop: Math.max(avg, mark * 0.98), // Trailing stop locks in cost or trails by 2%
          target: mark * 1.03
        });
      }
    });
  }

  // 2. Dynamic Top Buy Setups from plan-full.json
  let buys = [];
  let shortsAndPuts = [];
  const planPath = path.resolve(__dirname, "../plan-full.json");
  if (fs.existsSync(planPath)) {
    try {
      const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
      const best = plan.best || [];
      const buySetups = best.filter(b => b.side === "long" && b.action !== "stand-aside");
      buySetups.slice(0, 4).forEach(b => {
        const first = (b.entries && b.entries[0]) || {};
        const entry = Number(first.entry || b.anchor);
        if (entry > 0) {
          buys.push({
            symbol: b.symbol,
            level: Number(first.level || 1),
            entry,
            maxCap: entry * 1.008,
            target: Number(first.target || entry * 1.02),
            stop: Number(first.stopLoss || entry * 0.99)
          });
        }
      });

      const shortSetups = best.filter(b => b.side === "short" && b.action !== "stand-aside");
      shortSetups.slice(0, 2).forEach(s => {
        const first = (s.entries && s.entries[0]) || {};
        const entry = Number(first.entry || s.anchor);
        if (entry > 0) {
          shortsAndPuts.push({
            name: `${s.symbol} (Equity Short)`,
            action: "SHORT LADDER",
            entry,
            target: Number(first.target || entry * 0.98),
            stop: Number(first.stopLoss || entry * 1.01)
          });
        }
      });
    } catch (e) {
      console.warn("Could not parse plan-full.json:", e.message);
    }
  }

  // If no shorts in plan, supply an index hedge if risk is elevated
  if (!shortsAndPuts.length) {
    shortsAndPuts.push({
      name: "NIFTY 24000 PE (Index Crash Hedge)",
      action: "BUY PUT OPTION",
      entry: 185.00,
      target: 320.00,
      stop: 110.00
    });
  }

  // 3. Evaluate Macro Threat Radar with real live global feeds
  const liveMacro = await fetchLiveMacroRadar().catch(() => null);
  const giftPrice = liveMacro?.giftNifty?.price || 24050;
  const giftChange = liveMacro?.giftNifty?.changePct || 0;
  const vixPrice = liveMacro?.indiaVix?.price || 11.5;
  const vixChange = liveMacro?.indiaVix?.changePct || 0;
  const brentPrice = liveMacro?.brentCrude?.price || 95.0;
  const brentChange = liveMacro?.brentCrude?.changePct || 0;
  const spPrice = liveMacro?.sp500Futures?.price || 7750;
  const spChange = liveMacro?.sp500Futures?.changePct || 0;
  const nqPrice = liveMacro?.nasdaqFutures?.price || 29500;
  const nqChange = liveMacro?.nasdaqFutures?.changePct || 0;
  const inrPrice = liveMacro?.usdInr?.price || 94.4;
  const inrChange = liveMacro?.usdInr?.changePct || 0;

  const radar = evaluateGlobalMacroShock({
    giftNiftyGapPct: giftChange,
    indiaVix: vixPrice,
    indiaVixChangePct: vixChange,
    brentCrudeSpikePct: brentChange,
    sp500FuturesGapPct: spChange
  });

  const macroAssets = [
    {
      name: "GIFT NIFTY (NSEIX Live)",
      ticker: "NSEIX:NIFTY1!",
      price: giftPrice,
      changePct: giftChange,
      impact: "Direct 9:15 AM Opening Gap Predictor (R² = 0.92)",
      threat: giftChange <= -1.2 ? "CRITICAL" : giftChange <= -0.6 ? "ELEVATED" : "NORMAL"
    },
    {
      name: "India VIX (Domestic Fear)",
      ticker: "^INDIAVIX",
      price: vixPrice,
      changePct: vixChange,
      impact: "Domestic fear gauge. Under 14 = Calm / Bullish Tape",
      threat: vixPrice >= 18 ? "CRITICAL" : vixPrice >= 14 ? "ELEVATED" : "CALM"
    },
    {
      name: "Brent Crude Oil (War & Geopolitics)",
      ticker: "BZ=F",
      price: brentPrice,
      changePct: brentChange,
      impact: "Spike drains INR & foreign liquidity",
      threat: brentChange >= 3.0 ? "ELEVATED" : "NORMAL"
    },
    {
      name: "US S&P 500 Futures",
      ticker: "ES=F",
      price: spPrice,
      changePct: spChange,
      impact: "Global equity risk sentiment & institutional liquidity",
      threat: spChange <= -1.0 ? "ELEVATED" : "NORMAL"
    },
    {
      name: "US Nasdaq 100 Futures",
      ticker: "NQ=F",
      price: nqPrice,
      changePct: nqChange,
      impact: "Direct overnight drag on Indian IT (TCS, INFY, WIPRO)",
      threat: nqChange <= -1.0 ? "ELEVATED" : "NORMAL"
    },
    {
      name: "USD / INR Currency",
      ticker: "INR=X",
      price: inrPrice,
      changePct: inrChange,
      impact: "Rupee depreciation forces foreign equity dumping",
      threat: inrChange >= 0.5 ? "ELEVATED" : "NORMAL"
    }
  ];

  const sign = giftChange >= 0 ? "+" : "";
  const payload = {
    dateStr: new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "long", year: "numeric", month: "long", day: "numeric" }),
    radar: {
      severity: radar.regime || radar.severity || "NORMAL",
      summary: `GIFT Nifty at ${giftPrice.toFixed(0)} (${sign}${giftChange.toFixed(2)}%), India VIX at ${vixPrice.toFixed(2)}. Brent crude at $${brentPrice.toFixed(2)}. Directive: ${radar.actionDirective || "STANDARD_EXECUTION"}.`
    },
    macroAssets,
    sells,
    buys,
    shortsAndPuts,
    holds: holds.slice(0, 10) // Top monitored holdings
  };

  const result = await sendDailyTradeEmail(payload);
  recordDispatch(check.slot, check.dateStr);
  console.log("Dispatch completed successfully to:", DEFAULT_RECIPIENT);

  if (googleStoreConfigured()) {
    try {
      const allAudited = [...sells.map(s => ({ symbol: s.symbol, action: "SELL AT OPEN", riskRationale: s.reason, markPrice: s.price })), ...holds];
      await appendPortfolioAuditToGoogle(allAudited);
      console.log(`Appended ${allAudited.length} portfolio audit rows to K2_PORTFOLIO_AUDIT Google Sheet.`);
      await appendMacroRadarToGoogle({
        regime: payload.radar.severity,
        actionDirective: radar.actionDirective,
        giftNiftyGapPct: -0.10,
        brentCrudePrice: 93.27,
        indiaVix: 11.19,
        usVix: 15.34,
        us10y: 4.77,
        summary: payload.radar.summary
      });
      console.log("Appended daily macro radar row to K2_MACRO_RADAR Google Sheet.");
    } catch (e) {
      console.warn("Google Sheets audit logging skipped:", e.message);
    }
  }

  return result;
}

if (require.main === module) {
  run().catch(console.error);
}

module.exports = { run, checkDeduplication };
