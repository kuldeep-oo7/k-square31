"use strict";

const assert = require("node:assert");
const { evaluateSentimentAndEventRisk } = require("../api/_lib/sentiment-risk");

console.log("Starting Sentiment and Corporate Event Risk Shield test suite...");

const now = Date.parse("2026-09-15T10:00:00.000Z");

// Test 1: Clean stock with no impending events or negative news
const cleanTest = evaluateSentimentAndEventRisk({
  symbol: "APLAPOLLO",
  holdingSessions: 5,
  now,
  events: [],
  newsHeadlines: ["APLAPOLLO reports capacity expansion on track"],
  foBanList: []
});
assert.equal(cleanTest.status, "CLEARED");
assert.equal(cleanTest.allowedToTrade, true);
assert.equal(cleanTest.sentimentLabel, "BULLISH");

// Test 2: Stock on F&O Ban list must be strictly VETOED
const banTest = evaluateSentimentAndEventRisk({
  symbol: "BANDHANBNK",
  holdingSessions: 3,
  now,
  events: [],
  newsHeadlines: [],
  foBanList: ["BANDHANBNK", "SAIL"]
});
assert.equal(banTest.status, "VETOED");
assert.equal(banTest.allowedToTrade, false);
assert.ok(banTest.riskFlags.includes("FO_BAN_ACTIVE"));

// Test 3: Earnings scheduled within holding horizon must trigger VETO
const earningsTest = evaluateSentimentAndEventRisk({
  symbol: "INFY",
  holdingSessions: 5, // 5 sessions ~ 7 calendar days
  now,
  events: [
    { symbol: "INFY", type: "EARNINGS_RESULTS", date: "2026-09-18T10:00:00.000Z" } // 3 days away
  ],
  newsHeadlines: [],
  foBanList: []
});
assert.equal(earningsTest.status, "VETOED");
assert.equal(earningsTest.allowedToTrade, false);
assert.equal(earningsTest.eventType, "EARNINGS_RESULTS");
assert.equal(earningsTest.eventProximityDays, 3);
assert.ok(earningsTest.riskFlags.some((f) => f.startsWith("EARNINGS_EVENT_IMMINENT")));

// Test 4: Event far beyond holding horizon should NOT block trade
const farEventTest = evaluateSentimentAndEventRisk({
  symbol: "TCS",
  holdingSessions: 5,
  now,
  events: [
    { symbol: "TCS", type: "BOARD_MEETING", date: "2026-10-25T10:00:00.000Z" } // 40 days away
  ],
  newsHeadlines: [],
  foBanList: []
});
assert.equal(farEventTest.status, "CLEARED");
assert.equal(farEventTest.allowedToTrade, true);

// Test 5: Severe negative fraud/investigation news triggers alert flag
const badNewsTest = evaluateSentimentAndEventRisk({
  symbol: "ADANIENT",
  holdingSessions: 5,
  now,
  events: [],
  newsHeadlines: [
    "SEBI probe expanded into offshore entities",
    "Auditor issues disclaimer of opinion over accounting irregularity"
  ],
  foBanList: []
});
assert.equal(badNewsTest.status, "WATCH");
assert.equal(badNewsTest.sentimentLabel, "BEARISH");
assert.ok(badNewsTest.sentimentScore < 0);
assert.ok(badNewsTest.riskFlags.includes("NEGATIVE_SENTIMENT_ALERT"));

// Test 6: Invalid symbol fail-safe
const invalidTest = evaluateSentimentAndEventRisk({ symbol: null });
assert.equal(invalidTest.status, "VETOED");
assert.equal(invalidTest.allowedToTrade, false);

console.log("Sentiment & Event Risk tests passed: ban vetoes, earnings proximity shields, sentiment boundaries, and fail-safe defaults verified.");
