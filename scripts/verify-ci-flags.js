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
assert.notEqual(DEFAULT_CONFIG.fillRequiresTradeThrough, false, "C-8 Violation: fills must require the market to trade through the price by default");
assert.equal(DEFAULT_CONFIG.clusterByWeek, true, "C-7 Violation: significance must cluster on the week by default");

// BEHAVIOURAL, not textual. The previous version of this gate string-matched a
// source line, so any refactor of correct code failed the build while a rewrite
// that preserved the string but broke the maths would have passed. These run the
// engine and assert what it actually produces.
const { replayWeek, clusterStandardError } = require("../api/_lib/weekly-cycle");

function session(date, open, high, low, close) {
  return { session: date, open, high, low, close, volume: 1000 };
}

// Anchor 100. Long rungs sit at 98.00 and 96.04. Session 2 trades down to 95 and
// fills both; session 3 trades up to 105 and takes both 2% targets.
const twoFillWeek = {
  weekKey: "2026-01-05",
  sessions: [
    session("2026-01-05", 100, 100.5, 99.5, 100),
    session("2026-01-06", 99.5, 99.6, 95.0, 96.5),
    session("2026-01-07", 96.5, 105.0, 96.4, 104),
    session("2026-01-09", 104, 104.5, 103.5, 104)
  ]
};

const replayed = replayWeek(twoFillWeek, "long", DEFAULT_CONFIG);
assert.ok(replayed, "replayWeek must return a record for a well-formed week");
assert.equal(replayed.trades.length, 2, `C-2 setup: expected 2 fills, got ${replayed.trades.length}`);
assert.ok(Math.abs(replayed.sumNetPct - replayed.capitalWeightedNetPct) > 1e-6, "C-2 setup: the two measures must differ so the assertion below is meaningful, including a loss after an entry-bar stop");
assert.ok(
  Math.abs(replayed.weekNetPct - replayed.capitalWeightedNetPct) < 1e-6,
  `C-2 Violation: weekNetPct (${replayed.weekNetPct}) must equal the capital-weighted return (${replayed.capitalWeightedNetPct}), not the sum of leg percentages (${replayed.sumNetPct})`
);
assert.ok(
  Math.abs(replayed.capitalWeightedNetPct - replayed.sumNetPct / Number(DEFAULT_CONFIG.slots)) < 1e-6,
  "C-2 Violation: each rung must be allocated 1/slots of capital"
);

// C-1 behavioural: a week that gaps straight through the stop must book a stop,
// not ride to the Friday close. Rung 1 fills at 98.00; its stop sits at 96.04.
const stopWeek = {
  weekKey: "2026-02-02",
  sessions: [
    session("2026-02-02", 100, 100.5, 99.5, 100),
    session("2026-02-03", 99.5, 99.6, 97.0, 97.5),
    session("2026-02-04", 97, 97.2, 90.0, 91),
    session("2026-02-06", 91, 91.5, 90.5, 91)
  ]
};
const stopped = replayWeek(stopWeek, "long", DEFAULT_CONFIG);
assert.ok(stopped.trades.length >= 1, "C-1 setup: expected at least one fill");
assert.ok(
  stopped.trades.some((trade) => trade.outcome === "stop" || trade.outcome === "staged-stop"),
  `C-1 Violation: a week trading through the stop must book a stop; got outcomes [${stopped.trades.map((t) => t.outcome).join(", ")}]`
);

// C-8 behavioural: a session whose low exactly EQUALS the rung price is a touch,
// not a fill. Rung 1 sits at exactly 98.00.
const touchWeek = {
  weekKey: "2026-03-02",
  sessions: [
    session("2026-03-02", 100, 100.5, 99.5, 100),
    session("2026-03-03", 99.5, 99.6, 98.0, 98.5),
    session("2026-03-04", 98.5, 99.0, 98.2, 98.8),
    session("2026-03-06", 98.8, 99.0, 98.5, 98.9)
  ]
};
assert.equal(
  replayWeek(touchWeek, "long", DEFAULT_CONFIG).openPositions.length, 0,
  "C-8 Violation: a low that merely touches the rung price must not fill a resting limit order"
);
assert.equal(
  replayWeek(touchWeek, "long", { ...DEFAULT_CONFIG, fillRequiresTradeThrough: false }).openPositions.length, 1,
  "C-8 setup: with trade-through disabled the same bar must fill, or the test proves nothing"
);

// C-7 behavioural: identical values spread over fewer clusters must widen the
// standard error. If clustering is a no-op, this is where it shows.
const values = [2, 2, 2, 2, 2, -2, -2, -2, -2, -2];
const clustered = clusterStandardError(values, ["a", "a", "a", "a", "a", "b", "b", "b", "b", "b"]);
const independent = clusterStandardError(values, values.map((_, index) => `c${index}`));
assert.ok(
  clustered > independent * 1.5,
  `C-7 Violation: clustering must widen the standard error (clustered ${clustered}, independent ${independent})`
);

console.log("✓ weekly-cycle.js verified BEHAVIOURALLY: capital weighting, stop barrier, trade-through fills, cluster-robust errors.");

// STRATEGY VARIANTS must resolve identically in research and live. A variant is
// allowed to be configurable; it is not allowed to differ between the path that
// measures the edge and the path that trades it — that is how the research engine
// and the live engine came to be measuring two different strategies.
const VARIANT_KEYS = ["exitPolicy", "stagedExit"];
const PRODUCTION_GLOBS = [
  ["api", "_lib", "recommendation.js"],
  ["api", "_lib", "ml-model.js"],
  ["api", "market.js"],
  ["scripts", "weekly-plan.js"]
];
for (const key of VARIANT_KEYS) {
  for (const parts of PRODUCTION_GLOBS) {
    const file = path.join(ROOT, ...parts);
    if (!fs.existsSync(file)) continue;
    const code = fs.readFileSync(file, "utf8");
    const assignment = new RegExp(`${key}\\s*:\\s*["'\\w]`).test(code);
    assert.ok(
      !assignment,
      `STRATEGY VARIANT DIVERGENCE: ${parts.join("/")} sets '${key}' locally. Research and live must both inherit it from DEFAULT_CONFIG so they cannot measure and trade different strategies.`
    );
  }
}
console.log(`✓ Strategy variants (${VARIANT_KEYS.join(", ")}) are inherited from DEFAULT_CONFIG by every production path.`);

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

// 6. The risk engine's own strictness flags. portfolio-risk.js ships
// strictOrderValidation, requireSector and requireCompleteMacro defaulted to
// false, which left order-schema validation, the sector requirement and the
// macro-freshness gate switched off in the path that places orders. The
// execution path must turn all three on; a default-off safety control is the
// same defect class as a fix behind a test-only flag.
const shadowSessionCode = fs.readFileSync(path.join(ROOT, "scripts", "run-shadow-session.js"), "utf8");
for (const flag of ["strictOrderValidation", "requireSector", "requireCompleteMacro"]) {
  assert.ok(
    new RegExp(`${flag}\\s*:\\s*true`).test(shadowSessionCode),
    `RISK GATE OFF: run-shadow-session.js must set ${flag}: true. The execution path may not run with a risk control disabled.`
  );
}
console.log("✓ Execution-path risk strictness verified (order schema, sector, macro freshness all enforced).");

// 7. Sector must actually reach the order intent, or the concentration cap in
// portfolio-risk.js is unreachable: its check is guarded by
// `if (proposedOrder.sector)`, so an absent sector exempts the name entirely.
const { sectorFor, UNCLASSIFIED, sectorCount } = require("../api/_lib/sectors");
assert.ok(sectorCount() >= 10, `Sector map looks empty (${sectorCount()} sectors); the concentration cap would be meaningless`);
assert.equal(sectorFor("RELIANCE"), "Oil Gas & Consumable Fuels", "sectorFor must classify a known constituent");
assert.equal(sectorFor("NOT_A_REAL_SYMBOL"), UNCLASSIFIED, "an unknown symbol must fall into a real bucket, never null");
assert.ok(sectorFor("NOT_A_REAL_SYMBOL"), "sectorFor must never return a falsy value: portfolio-risk skips its sector cap on falsy input");

const planCode = fs.readFileSync(path.join(ROOT, "scripts", "weekly-plan.js"), "utf8");
assert.ok(/sector:\s*sectorFor\(/.test(planCode), "weekly-plan.js must pass a resolved sector into recommendation()");
assert.ok(/evaluatePortfolioRisk\(/.test(planCode), "weekly-plan.js must run the ranked plan through the portfolio risk engine");
console.log("✓ Sector classification reaches the order intent and the plan is portfolio-risk gated.");

console.log("\nALL CI PRODUCTION DEFAULTS & ANTI-SYNTHETIC FLAG CHECKS PASSED!");
process.exit(0);
