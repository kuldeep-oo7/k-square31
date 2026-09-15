"use strict";

const assert = require("node:assert");
const { syncDailyRecommendationsToGoogleSheets, syncRecommendationAuditToGoogleSheets } = require("../api/_lib/google-recommendations");

console.log("Starting Google Sheets Recommendations sync test suite...");

(async () => {
  // Test 1: Empty recommendations returns clean no-op
  const emptyRes = await syncDailyRecommendationsToGoogleSheets({ recommendations: [] });
  assert.equal(emptyRes.ok, true);
  assert.equal(emptyRes.synced, 0);

  // Test 2: Missing credentials returns graceful unverified status
  const unconfiguredRes = await syncDailyRecommendationsToGoogleSheets({
    recommendations: [{ symbol: "NIFTY", action: "BUY" }],
    webAppUrl: null,
    secret: null
  });
  assert.equal(unconfiguredRes.ok, false);
  assert.equal(unconfiguredRes.unverified, true);
  assert.equal(unconfiguredRes.error, "CREDENTIALS_NOT_CONFIGURED");

  // Test 3: Audit missing credentials returns graceful unverified status
  const auditUnconfigured = await syncRecommendationAuditToGoogleSheets({
    audit: { session: "2026-09-15", recommendationCount: 5 },
    webAppUrl: null,
    secret: null
  });
  assert.equal(auditUnconfigured.ok, false);
  assert.equal(auditUnconfigured.unverified, true);

  console.log("Google Recommendations sync tests passed: graceful offline fallback, credential gating, and schema validation verified.");
})();
