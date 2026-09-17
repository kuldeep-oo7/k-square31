"use strict";

const assert = require("assert");
const { tokenize, Parser, executeK2Strategy } = require("../api/_lib/k2-lang");

console.log("Starting K²-Lang Quantitative Programming Language test suite...");

// 1. Script example
const script = `
  # K²-Lang Strategy Definition
  STRATEGY "ApexInstitutionalMomentum"

  REQUIRE MACRO_GATE == "NORMAL" AND INDIA_VIX < 20.0

  SIGNAL BUY WHEN HURST > 0.55 AND VPIN < 0.30 AND (PATTERN IN ["DOUBLE_BOTTOM", "INV_HEAD_SHOULDERS"]) AND NEURAL_ALPHA >= 70

  SET TARGET1 = SPOT * 1.025, TARGET2 = SPOT * 1.050, STOPLOSS = SPOT * 0.985, LOT_QTY = 125
`;

// 2. Tokenizer test
const tokens = tokenize(script);
assert(tokens.length > 20, "Should generate tokens");
console.log("  ✓ Tokenizer generated", tokens.length, "tokens successfully");

// 3. Parser test
const parser = new Parser(tokens);
const ast = parser.parse();
assert(ast.type === "Program", "AST root must be Program");
assert(ast.strategyName === "ApexInstitutionalMomentum", "Strategy name parsed");
assert(ast.requires !== null, "Requires clause parsed");
assert(ast.signals.length === 1, "Signal clause parsed");
assert(ast.assignments.TARGET1 !== undefined, "Assignments parsed");
console.log("  ✓ AST Parser built tree for strategy:", ast.strategyName);

// 4. Successful Execution Context
const bullishContext = {
  MACRO_GATE: "NORMAL",
  INDIA_VIX: 12.5,
  HURST: 0.62,
  VPIN: 0.16,
  PATTERN: "DOUBLE_BOTTOM",
  NEURAL_ALPHA: 82,
  SPOT: 7000
};

const execPass = executeK2Strategy(ast, bullishContext);
assert(execPass.requirementPassed === true, "Precondition must pass");
assert(execPass.passed === true, "Signal must trigger");
assert(execPass.assignments.TARGET1 === 7175, "TARGET1 = 7000 * 1.025 = 7175");
assert(execPass.assignments.STOPLOSS === 6895, "STOPLOSS = 7000 * 0.985 = 6895");
console.log("  ✓ Execution Pass verified: Action:", execPass.triggeredAction, "| Target1:", execPass.assignments.TARGET1, "| StopLoss:", execPass.assignments.STOPLOSS);

// 5. Precondition Rejection Context (e.g. VIX elevated / Macro gate failure)
const failedContext = {
  ...bullishContext,
  INDIA_VIX: 26.5 // Fails REQUIRE INDIA_VIX < 20.0
};
const execFail = executeK2Strategy(ast, failedContext);
assert(execFail.requirementPassed === false, "Elevated VIX must reject REQUIRE block");
assert(execFail.passed === false, "Strategy must not trigger when REQUIRE fails");
console.log("  ✓ Precondition Risk Gate verified (rejected on VIX 26.5)");

console.log("ALL K²-Lang tests passed successfully!\n");
