"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { evaluateModelFitness } = require("../api/_lib/ml-model");
const { recommendation } = require("../api/_lib/recommendation");

function testModelFitnessEvaluator() {
  // 1. Test weak model (like current upside.json with negative R^2 and low IC)
  const weakModel = {
    ready: true,
    validation: {
      outOfSample: {
        informationCoefficient: 0.0203,
        rSquared: -0.0217
      },
      perFold: [
        { fold: 1, informationCoefficient: 0.0097, rSquared: -0.015 },
        { fold: 2, informationCoefficient: 0.0610, rSquared: -0.008 },
        { fold: 3, informationCoefficient: -0.0238, rSquared: -0.042 }, // Negative fold IC
        { fold: 4, informationCoefficient: 0.0342, rSquared: -0.021 }
      ]
    }
  };

  const fitness = evaluateModelFitness(weakModel);
  assert.strictEqual(fitness.status, "RESEARCH_ADVISORY_ONLY");
  assert.strictEqual(fitness.canGenerateTrades, false);
  assert.strictEqual(fitness.isAdvisoryOnly, true);
  assert(fitness.reason.includes("Demoted to secondary advisory"));

  // 2. Synthetic positive branch of research governance, not institutional evidence.
  const strongModel = {
    ready: true,
    validation: {
      ready: true,
      outOfSample: {
        informationCoefficient: 0.085,
        rSquared: 0.032,
        actedAverageWeeklyPct: 0.1
      },
      perFold: [
        { fold: 1, informationCoefficient: 0.072, rSquared: 0.025, trainLabelThrough: "2025-01-01", testLabelFrom: "2025-01-06" },
        { fold: 2, informationCoefficient: 0.091, rSquared: 0.041, trainLabelThrough: "2025-05-01", testLabelFrom: "2025-05-05" }
      ]
    }
  };

  const strongFitness = evaluateModelFitness(strongModel);
  assert.strictEqual(strongFitness.status, "VALIDATED_RESEARCH_FILTER");
  assert.strictEqual(strongFitness.canGenerateTrades, true);
  assert.strictEqual(strongFitness.isAdvisoryOnly, false);
  assert.strictEqual(evaluateModelFitness({ ...strongModel, validation: { ...strongModel.validation, perFold: [] } }).canGenerateTrades, false);
}

function testPotentialRouteAbstentionOnWeakModel() {
  const baseTs = Date.parse("2026-08-03T06:30:00Z") / 1000;
  const bars = [
    { timestamp: baseTs, open: 100, high: 105, low: 98, close: 102, volume: 10000 },
    { timestamp: baseTs + 86400, open: 102, high: 106, low: 100, close: 104, volume: 12000 },
    { timestamp: baseTs + 86400 * 2, open: 104, high: 108, low: 102, close: 107, volume: 15000 },
    { timestamp: baseTs + 86400 * 3, open: 107, high: 110, low: 105, close: 108, volume: 14000 },
    { timestamp: baseTs + 86400 * 4, open: 108, high: 112, low: 106, close: 111, volume: 16000 }
  ];

  const weakModel = {
    ready: true,
    validation: {
      outOfSample: {
        informationCoefficient: 0.0203,
        rSquared: -0.0217
      }
    }
  };

  // Run recommendation with a forced potential candidate and weak model
  const rec = recommendation({
    symbol: "TEST_SYM",
    bars,
    model: weakModel,
    cycle: { ready: true, verdict: { action: "stand-aside", side: "none", reason: "Ladder not viable" }, weeks: 20 },
    upside: {
      clearsFloor: true,
      side: "long",
      expectedMovePct: 4.5,
      floorPct: 2.0,
      typicalErrorPct: 1.2,
      model: weakModel,
      components: []
    }
  });

  // Must stand aside! Cannot trade on weak model
  assert.strictEqual(rec.action, "stand-aside");
  assert(rec.reasons.some((r) => r.includes("ML model unvalidated")));
}

function testGovernanceCardExists() {
  const cardPath = path.resolve(__dirname, "../models/model-governance.json");
  assert(fs.existsSync(cardPath), "model-governance.json must exist");
  const card = JSON.parse(fs.readFileSync(cardPath, "utf8"));
  assert.strictEqual(card.classification, "RESEARCH_ADVISORY_ONLY");
  assert.strictEqual(card.authorities.canGenerateStandaloneTrades, false);
}

function run() {
  testModelFitnessEvaluator();
  testPotentialRouteAbstentionOnWeakModel();
  testGovernanceCardExists();
  console.log("ML model governance tests passed: weak models strictly demoted to advisory-only; standalone trade generation prevented!");
}

run();
