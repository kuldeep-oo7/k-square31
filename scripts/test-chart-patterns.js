"use strict";

const assert = require("node:assert/strict");
const {
  findPivots,
  detectDoublePivots,
  detectHeadAndShoulders,
  detectCupAndHandle,
  scanChartPatterns
} = require("../api/_lib/chart-patterns");

console.log("Starting Chart Patterns & Classical Structure test suite...");

function makeBar(timestamp, open, high, low, close, volume = 100000) {
  return { timestamp, open, high, low, close, volume };
}

// 1. Double Bottom (W-Pattern) Test
const mockPivotsW = [
  { type: "TROUGH", price: 100, index: 5 },
  { type: "PEAK", price: 115, index: 12 },
  { type: "TROUGH", price: 101, index: 19 }
];
const doubleBottom = detectDoublePivots(mockPivotsW, 114);
assert.ok(doubleBottom, "Should detect double bottom");
assert.equal(doubleBottom.pattern, "DOUBLE_BOTTOM");
assert.equal(doubleBottom.bias, "BULLISH");
assert.equal(doubleBottom.neckline, 115);
assert.equal(doubleBottom.targetPrice, 130);
console.log("  ✓ Double Bottom (W-Pattern) detected and target calculated:", doubleBottom.targetPrice);

// 2. Double Top (M-Pattern) Test
const mockPivotsM = [
  { type: "PEAK", price: 200, index: 5 },
  { type: "TROUGH", price: 180, index: 12 },
  { type: "PEAK", price: 199, index: 19 }
];
const doubleTop = detectDoublePivots(mockPivotsM, 181);
assert.ok(doubleTop, "Should detect double top");
assert.equal(doubleTop.pattern, "DOUBLE_TOP");
assert.equal(doubleTop.bias, "BEARISH");
assert.equal(doubleTop.targetPrice, 160);
console.log("  ✓ Double Top (M-Pattern) detected and target calculated:", doubleTop.targetPrice);

// 3. Inverse Head & Shoulders Test
const mockPivotsInvHS = [
  { type: "TROUGH", price: 100, index: 5 }, // Left Shoulder
  { type: "PEAK", price: 115, index: 10 },   // Neckline 1
  { type: "TROUGH", price: 90, index: 15 },   // Head (Lowest)
  { type: "PEAK", price: 115, index: 20 },   // Neckline 2
  { type: "TROUGH", price: 99, index: 25 }    // Right Shoulder
];
const invHS = detectHeadAndShoulders(mockPivotsInvHS, 114.5);
assert.ok(invHS, "Should detect Inverse Head & Shoulders");
assert.equal(invHS.pattern, "INVERSE_HEAD_AND_SHOULDERS");
assert.equal(invHS.bias, "BULLISH");
assert.equal(invHS.head, 90);
assert.equal(invHS.neckline, 115);
assert.equal(invHS.targetPrice, 140); // 115 + (115 - 90) = 140
console.log("  ✓ Inverse Head & Shoulders detected and target calculated:", invHS.targetPrice);

// 4. Full Scan Pattern Confluence on Synthetic Series
const syntheticBars = [];
let base = 100;
for (let i = 0; i < 45; i++) {
  let move = (i < 10) ? -1 : (i < 20) ? 1.5 : (i < 30) ? -1.4 : 1.2;
  base += move;
  syntheticBars.push(makeBar(1700000000 + i * 86400, base - 0.5, base + 1, base - 1, base));
}
const scanResult = scanChartPatterns(syntheticBars);
assert.ok(typeof scanResult.detected === "boolean");
assert.ok(Array.isArray(scanResult.patterns));
console.log("  ✓ Master Chart Pattern Scanner successfully scanned series (Pivots found:", scanResult.pivotsCount, ")");

console.log("ALL Chart Pattern tests passed successfully!\n");
