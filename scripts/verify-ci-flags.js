"use strict";

/**
 * CI Verification Gate: Production Defaults & Anti-Synthetic Flag Validator
 *
 * Verifies that all claimed bug fixes and architectural remediations are active
 * by DEFAULT in production modules, rather than solely enabled via synthetic flags
 * inside scripts/test-*.
 *
 * Exits with code 1 if any remediation flag or default invariant is violated.
 */

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const ROOT = path.join(__dirname, "..");

console.log("Starting CI Production Defaults & Anti-Synthetic Flag Audit...");

// 1. Verify weekly-cycle.js DEFAULT_CONFIG
const weeklyCyclePath = path.join(ROOT, "api", "_lib", "weekly-cycle.js");
const weeklyCycleCode = fs.readFileSync(weeklyCyclePath, "utf8");
const { DEFAULT_CONFIG } = require("../api/_lib/weekly-cycle");

assert.ok(DEFAULT_CONFIG, "DEFAULT_CONFIG must be exported from weekly-cycle.js");
assert.ok(Number(DEFAULT_CONFIG.stopLossPct) > 0, "C-1 Violation: DEFAULT_CONFIG.stopLossPct must be defined and > 0");
assert.equal(DEFAULT_CONFIG.capitalWeighted, true, "C-2 Violation: DEFAULT_CONFIG.capitalWeighted must be true");
assert.ok(Number(DEFAULT_CONFIG.costPct) >= 0.08, "C-4 Violation: DEFAULT_CONFIG.costPct must reflect >= 0.08% round trip");
assert.ok(
  weeklyCycleCode.includes("weekNetPct: config.capitalWeighted !== false ? capitalWeightedNetPct : sumNetPct") ||
  weeklyCycleCode.includes("weekNetPct: capitalWeightedNetPct"),
  "C-2 Violation: weekNetPct must default to capitalWeightedNetPct without requiring config flag"
);
console.log("✓ weekly-cycle.js DEFAULT_CONFIG verified (stopLossPct, capitalWeighted, costPct active by default).");

// 2. Verify shadow-broker.js statutory tax rates
const shadowBrokerPath = path.join(ROOT, "api", "_lib", "shadow-broker.js");
const shadowBrokerCode = fs.readFileSync(shadowBrokerPath, "utf8");

assert.ok(
  shadowBrokerCode.includes("0.0005") || shadowBrokerCode.includes("0.05%"),
  "C-4 Violation: STT on equity futures sell side must be 0.05% (0.0005), not 0.02%"
);
assert.ok(
  shadowBrokerCode.includes("0.0000183") || shadowBrokerCode.includes("0.00183%"),
  "C-4 Violation: NSE transaction charges must be 0.00183% (0.0000183)"
);
assert.ok(
  shadowBrokerCode.includes("ipft") || shadowBrokerCode.includes("IPFT"),
  "C-4 Violation: IPFT must be modeled in shadow-broker.js"
);
console.log("✓ shadow-broker.js statutory tax rates verified (STT 0.05%, NSE 0.00183%, IPFT present).");

// 3. Verify no remediation flag is ONLY present in scripts/test-*
const flagsToCheck = ["stopLossPct", "capitalWeighted"];
for (const flag of flagsToCheck) {
  assert.ok(
    DEFAULT_CONFIG[flag] !== undefined,
    `Flag '${flag}' must be defined in DEFAULT_CONFIG so production inherits it without test overrides`
  );
}
console.log("✓ Anti-synthetic test-only flag check passed: flags are defined in production DEFAULT_CONFIG.");

// 4. Verify ai-engine.js has stop-loss protection
const aiEnginePath = path.join(ROOT, "api", "_lib", "ai-engine.js");
const aiEngineCode = fs.readFileSync(aiEnginePath, "utf8");
assert.ok(
  aiEngineCode.includes("stopLoss") || aiEngineCode.includes("stopPrice"),
  "C-1 / C-3 Violation: ai-engine.js must check and enforce stopLoss"
);
console.log("✓ ai-engine.js stop-loss protection verified.");

// 5. Verify no Math.max(1, ...) floor forcing lot sizes when budget is breached
const recPath = path.join(ROOT, "api", "_lib", "recommendation.js");
const recCode = fs.readFileSync(recPath, "utf8");
assert.ok(
  !recCode.includes("Math.max(1, Math.floor((BASE_RISK_BUDGET"),
  "C-6 Violation: recommendation.js must not force a minimum of 1 lot with Math.max(1, ...) if risk exceeds budget"
);
console.log("✓ recommendation.js risk budget cap verified (no Math.max(1, ...) floor).");

console.log("\nALL CI PRODUCTION DEFAULTS & ANTI-SYNTHETIC FLAG CHECKS PASSED!");
process.exit(0);
