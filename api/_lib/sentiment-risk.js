"use strict";

/**
 * News, Corporate Actions, and Sentiment Protection Shield for K² Range Desk.
 * Guards against holding positions into unpredictable binary events like
 * earnings announcements, board meetings, regulatory curbs, and negative sentiment shocks.
 */

const fs = require("node:fs");
const path = require("node:path");

// Mock / offline calendar store for known high-impact events when live feed is offline
const DEFAULT_CALENDAR_PATH = path.join(__dirname, "..", "..", "data", "corporate-events.json");

/**
 * Normalizes and parses dates to Unix timestamp in milliseconds.
 */
function parseTimestamp(dateVal) {
  if (typeof dateVal === "number" && Number.isFinite(dateVal)) return dateVal;
  if (typeof dateVal === "string" && dateVal.trim()) {
    const parsed = Date.parse(dateVal);
    if (Number.isFinite(parsed)) return parsed;
  }
  return NaN;
}

/**
 * Computes calendar days difference between two timestamps.
 */
function daysDifference(t1, t2) {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((t2 - t1) / msPerDay);
}

/**
 * Loads corporate events calendar safely.
 */
function loadCorporateCalendar(customPath = null) {
  const targetPath = customPath || DEFAULT_CALENDAR_PATH;
  try {
    if (fs.existsSync(targetPath)) {
      const content = fs.readFileSync(targetPath, "utf8");
      return JSON.parse(content);
    }
  } catch {
    // Ignore read failure and return empty store
  }
  return { events: [], news: [] };
}

/**
 * Evaluates event and sentiment risk for a given stock symbol.
 *
 * @param {Object} options
 * @param {string} options.symbol - NSE ticker symbol (e.g. 'APLAPOLLO', 'RELIANCE')
 * @param {number} [options.holdingSessions=5] - Planned holding duration in trading days
 * @param {number} [options.now=Date.now()] - Current timestamp
 * @param {Array} [options.events] - Explicit events calendar
 * @param {Array} [options.newsHeadlines] - Recent news headlines / sentiment items
 * @param {Array} [options.foBanList] - Current NSE F&O ban list
 * @param {number} [options.minEventBufferDays=3] - Minimum days clearance before an earnings event
 * @returns {Object} Structured risk evaluation
 */
function evaluateSentimentAndEventRisk({
  symbol,
  holdingSessions = 5,
  now = Date.now(),
  events = null,
  newsHeadlines = [],
  foBanList = [],
  minEventBufferDays = 3
} = {}) {
  if (!symbol || typeof symbol !== "string") {
    return {
      symbol: String(symbol || "UNKNOWN"),
      status: "VETOED",
      allowedToTrade: false,
      reason: "INVALID_SYMBOL",
      eventProximityDays: null,
      eventType: null,
      sentimentScore: 0,
      sentimentLabel: "NEUTRAL",
      riskFlags: ["INVALID_SYMBOL"]
    };
  }

  const cleanSymbol = symbol.trim().toUpperCase();
  const riskFlags = [];
  const calendar = events ? { events } : loadCorporateCalendar();
  const currentTime = parseTimestamp(now) || Date.now();

  // 1. Check F&O Regulatory Ban List
  const isBanned = Array.isArray(foBanList) && foBanList.some((s) => String(s).toUpperCase() === cleanSymbol);
  if (isBanned) {
    riskFlags.push("FO_BAN_ACTIVE");
  }

  // 2. Scan Corporate Events (Earnings, Board Meetings, Dividends, AGMs)
  let nearestEventDays = null;
  let nearestEventType = null;
  let nearestEventDate = null;

  if (Array.isArray(calendar.events)) {
    const symbolEvents = calendar.events.filter(
      (e) => String(e.symbol || "").toUpperCase() === cleanSymbol
    );

    for (const ev of symbolEvents) {
      const evTime = parseTimestamp(ev.date || ev.timestamp);
      if (Number.isFinite(evTime) && evTime >= currentTime) {
        const diffDays = daysDifference(currentTime, evTime);
        if (nearestEventDays === null || diffDays < nearestEventDays) {
          nearestEventDays = diffDays;
          nearestEventType = ev.type || "CORPORATE_ACTION";
          nearestEventDate = new Date(evTime).toISOString().slice(0, 10);
        }
      }
    }
  }

  // Check event collision with holding horizon
  const horizonDays = Math.ceil(holdingSessions * 1.4); // Convert trading sessions to calendar buffer
  const safetyBuffer = Math.max(minEventBufferDays, horizonDays);

  if (nearestEventDays !== null && nearestEventDays <= safetyBuffer) {
    const isCritical = /earnings|results|financials|board_meeting/i.test(nearestEventType);
    if (isCritical) {
      riskFlags.push(`EARNINGS_EVENT_IMMINENT_${nearestEventDays}D`);
    } else {
      riskFlags.push(`CORPORATE_EVENT_NEAR_${nearestEventDays}D`);
    }
  }

  // 3. News Sentiment Scoring
  // Simple deterministic keyword-based lexicon for financial news sentiment
  const BEARISH_KEYWORDS = [
    /fraud/i, /investigation/i, /sebi probe/i, /ed raid/i, /cbi/i,
    /default/i, /insolvency/i, /nclt/i, /pledge/i, /accounting irregularity/i,
    /resignation of auditor/i, /downgrade/i, /missed payment/i, /strike/i
  ];
  const BULLISH_KEYWORDS = [
    /record profit/i, /upgrade/i, /order win/i, /capacity expansion/i,
    /debt free/i, /buyback/i, /patent grant/i, /fda approval/i, /bonus issue/i
  ];

  let positiveScore = 0;
  let negativeScore = 0;
  const matchedBearish = [];
  const matchedBullish = [];

  if (Array.isArray(newsHeadlines)) {
    for (const item of newsHeadlines) {
      const text = typeof item === "string" ? item : (item.title || item.headline || item.summary || "");
      if (!text) continue;

      for (const rx of BEARISH_KEYWORDS) {
        if (rx.test(text)) {
          negativeScore += 1;
          matchedBearish.push(rx.source);
        }
      }
      for (const rx of BULLISH_KEYWORDS) {
        if (rx.test(text)) {
          positiveScore += 1;
          matchedBullish.push(rx.source);
        }
      }
    }
  }

  // Net sentiment bounded between -1.0 and +1.0
  const totalSignals = positiveScore + negativeScore;
  let netSentiment = 0;
  if (totalSignals > 0) {
    netSentiment = Math.round(((positiveScore - negativeScore) / totalSignals) * 100) / 100;
  }

  let sentimentLabel = "NEUTRAL";
  if (netSentiment >= 0.3) sentimentLabel = "BULLISH";
  else if (netSentiment <= -0.3) sentimentLabel = "BEARISH";

  if (negativeScore >= 2 || netSentiment <= -0.5) {
    riskFlags.push("NEGATIVE_SENTIMENT_ALERT");
  }

  // 4. Determine Final Clearance & Status
  let status = "CLEARED";
  let allowedToTrade = true;
  let primaryReason = "CLEARED_FOR_EXECUTION";

  if (riskFlags.some((f) => f.startsWith("FO_BAN_ACTIVE") || f.startsWith("EARNINGS_EVENT_IMMINENT"))) {
    status = "VETOED";
    allowedToTrade = false;
    primaryReason = riskFlags.includes("FO_BAN_ACTIVE")
      ? "Stock is currently under regulatory NSE F&O ban"
      : `High-risk event (${nearestEventType}) scheduled within ${nearestEventDays} days`;
  } else if (riskFlags.length > 0) {
    status = "WATCH";
    allowedToTrade = true;
    primaryReason = `Event or sentiment flag active: ${riskFlags.join(", ")}`;
  }

  return {
    symbol: cleanSymbol,
    status,
    allowedToTrade,
    reason: primaryReason,
    riskFlags,
    eventProximityDays: nearestEventDays,
    eventType: nearestEventType,
    eventDate: nearestEventDate,
    sentimentScore: netSentiment,
    sentimentLabel,
    sentimentSignals: {
      bullishCount: positiveScore,
      bearishCount: negativeScore,
      matchedBearish: [...new Set(matchedBearish)],
      matchedBullish: [...new Set(matchedBullish)]
    },
    evaluatedAt: new Date(currentTime).toISOString()
  };
}

module.exports = {
  evaluateSentimentAndEventRisk,
  loadCorporateCalendar,
  parseTimestamp,
  daysDifference
};
