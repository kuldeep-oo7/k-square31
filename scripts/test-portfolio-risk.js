"use strict";

const assert = require("node:assert/strict");
const { evaluatePortfolioRisk, DEFAULT_PORTFOLIO_LIMITS } = require("../api/_lib/portfolio-risk");

function run() {
  const sampleOrder = {
    contractSymbol: "RELIANCE26SEPFUT",
    sector: "ENERGY",
    estMarginRequired: 160000,
    maxRiskInr: 15000
  };

  // 1. Clean order with empty book -> APPROVED
  const cleanRes = evaluatePortfolioRisk({ proposedOrder: sampleOrder, activePositions: [] });
  assert.equal(cleanRes.approved, true);
  assert.equal(cleanRes.reason, "APPROVED_BY_PORTFOLIO_RISK_ENGINE");

  // 2. Daily Loss Kill Switch -> REJECTED
  const killSwitchRes = evaluatePortfolioRisk({
    proposedOrder: sampleOrder,
    activePositions: [],
    dailyRealizedPnl: -55000 // Exceeds ₹50,000 daily loss limit
  });
  assert.equal(killSwitchRes.approved, false);
  assert.equal(killSwitchRes.killSwitch, true);
  assert.ok(killSwitchRes.reason.includes("KILL_SWITCH_ACTIVE"));

  // 3. Macro Shock Shield Lockdown -> REJECTED
  const macroRes = evaluatePortfolioRisk({
    proposedOrder: sampleOrder,
    activePositions: [],
    marketRegime: { regime: "BLOODBATH_DEFENSIVE", shieldState: "LOCKDOWN", shockReason: "Global market crash" }
  });
  assert.equal(macroRes.approved, false);
  assert.ok(macroRes.reason.includes("MACRO_SHOCK_SHIELD"));

  // 4. Maximum Open Positions Cap (5 max) -> REJECTED on 6th
  const activeFive = [
    { contractSymbol: "A", sector: "IT", estMarginRequired: 100000 },
    { contractSymbol: "B", sector: "BANK", estMarginRequired: 100000 },
    { contractSymbol: "C", sector: "AUTO", estMarginRequired: 100000 },
    { contractSymbol: "D", sector: "METALS", estMarginRequired: 100000 },
    { contractSymbol: "E", sector: "PHARMA", estMarginRequired: 100000 }
  ];
  const capRes = evaluatePortfolioRisk({ proposedOrder: sampleOrder, activePositions: activeFive });
  assert.equal(capRes.approved, false);
  assert.ok(capRes.reason.includes("PORTFOLIO_CONCENTRATION"));

  // 5. Sector Concentration Cap (2 max per sector) -> REJECTED on 3rd energy
  const activeSector = [
    { contractSymbol: "ONGC26SEPFUT", sector: "ENERGY", estMarginRequired: 100000 },
    { contractSymbol: "BPCL26SEPFUT", sector: "ENERGY", estMarginRequired: 100000 }
  ];
  const sectorRes = evaluatePortfolioRisk({ proposedOrder: sampleOrder, activePositions: activeSector });
  assert.equal(sectorRes.approved, false);
  assert.ok(sectorRes.reason.includes("SECTOR_CONCENTRATION"));

  // 6. Aggregate Margin Exceeded -> REJECTED
  const heavyPositions = [
    { contractSymbol: "A", sector: "IT", estMarginRequired: 700000 },
    { contractSymbol: "B", sector: "BANK", estMarginRequired: 650000 }
  ]; // Total = 1,350,000; Adding 160,000 = 1,510,000 > maxAllowed 1,400,000
  const marginRes = evaluatePortfolioRisk({ proposedOrder: sampleOrder, activePositions: heavyPositions });
  assert.equal(marginRes.approved, false);
  assert.ok(marginRes.reason.includes("MARGIN_EXCEEDED"));

  // 7. Single Name Risk Cap Exceeded -> REJECTED
  const oversizedOrder = { ...sampleOrder, maxRiskInr: 35000 }; // Exceeds ₹25,000 cap
  const riskRes = evaluatePortfolioRisk({ proposedOrder: oversizedOrder, activePositions: [] });
  assert.equal(riskRes.approved, false);
  assert.ok(riskRes.reason.includes("SINGLE_NAME_RISK_EXCEEDED"));

  console.log("Portfolio risk engine tests passed: aggregate margin, sector caps, position limits and kill switch verified!");
}

run();
