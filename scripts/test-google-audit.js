"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { auditLiveSheet } = require("./audit-live-google-sheet");

async function testAuditExecutionOffline() {
  // Offline / unconfigured test: must gracefully write report without crashing
  const result = await auditLiveSheet({ dryRun: true });
  assert.equal(result.ok, true);

  const reportPath = path.resolve(__dirname, "../LIVE_GOOGLE_SHEET_AUDIT_REPORT.txt");
  assert.ok(fs.existsSync(reportPath), "LIVE_GOOGLE_SHEET_AUDIT_REPORT.txt must be generated");
  const content = fs.readFileSync(reportPath, "utf8");
  assert.ok(content.includes("LIVE GOOGLE SHEET AUDIT REPORT"));
}

async function run() {
  await testAuditExecutionOffline();
  console.log("Google Sheets read-back audit tool tests passed successfully!");
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exitCode = 1;
});
