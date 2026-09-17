"use strict";

const assert = require("assert");
const { identifyCandlestickPatterns } = require("../api/_lib/candlestick-engine");

console.log("Starting Candlestick Pattern Engine test suite...");

// 1. Morning Star (Bullish 3-bar reversal)
const morningStarBars = [
  { open: 105, high: 106, low: 99, close: 100, volume: 10000 }, // tall red
  { open: 98, high: 99, low: 97, close: 97.5, volume: 5000 },    // small star
  { open: 98, high: 104, low: 97.8, close: 103.5, volume: 15000 } // strong green > 50%
];
const resMS = identifyCandlestickPatterns(morningStarBars);
assert(resMS.primaryPattern === "MORNING_STAR", "Should identify Morning Star, got: " + resMS.primaryPattern);
assert(resMS.bias === "BULLISH", "Morning Star bias must be BULLISH");
console.log("  ✓ Morning Star 3-bar bullish reversal verified:", resMS.primaryPattern, "(Score:", resMS.score + ")");

// 2. Evening Star (Bearish 3-bar reversal)
const eveningStarBars = [
  { open: 100, high: 106, low: 99.5, close: 105.5, volume: 10000 }, // tall green
  { open: 106.5, high: 108, low: 106, close: 107, volume: 5000 },    // small star top
  { open: 106, high: 106.2, low: 101, close: 101.5, volume: 16000 }  // strong red < 50%
];
const resES = identifyCandlestickPatterns(eveningStarBars);
assert(resES.primaryPattern === "EVENING_STAR", "Should identify Evening Star, got: " + resES.primaryPattern);
assert(resES.bias === "BEARISH", "Evening Star bias must be BEARISH");
console.log("  ✓ Evening Star 3-bar bearish reversal verified:", resES.primaryPattern, "(Score:", resES.score + ")");

// 3. Bullish Engulfing
const engulfingBars = [
  { open: 100, high: 101, low: 98, close: 99, volume: 8000 },
  { open: 99, high: 100, low: 96, close: 96.5, volume: 12000 },   // red
  { open: 96.2, high: 101, low: 96, close: 100.5, volume: 22000 } // green engulfing
];
const resEngulf = identifyCandlestickPatterns(engulfingBars);
const engulfFound = resEngulf.patterns.some(p => p.name === "BULLISH_ENGULFING");
assert(engulfFound, "Should detect Bullish Engulfing");
console.log("  ✓ Bullish Engulfing verified (Patterns:", resEngulf.patterns.map(p => p.name).join(", ") + ")");

// 4. Hammer (Bullish Pinbar)
const hammerBars = [
  { open: 100, high: 101, low: 99, close: 99.5, volume: 8000 },
  { open: 99, high: 99.5, low: 97, close: 97.2, volume: 9000 },
  { open: 97.5, high: 98, low: 92, close: 97.8, volume: 18000 } // Lower shadow 5.5, body 0.3
];
const resHammer = identifyCandlestickPatterns(hammerBars);
const hammerFound = resHammer.patterns.some(p => p.name === "HAMMER");
assert(hammerFound, "Should detect Hammer");
console.log("  ✓ Hammer Pinbar lower rejection verified");

// 5. Marubozu
const marubozuBars = [
  { open: 100, high: 101, low: 99, close: 100, volume: 8000 },
  { open: 100, high: 102, low: 99.5, close: 101, volume: 9000 },
  { open: 101.1, high: 109.9, low: 101.0, close: 109.8, volume: 25000 } // 98% body
];
const resMarubozu = identifyCandlestickPatterns(marubozuBars);
const marubozuFound = resMarubozu.patterns.some(p => p.name === "BULLISH_MARUBOZU");
assert(marubozuFound, "Should detect Bullish Marubozu");
console.log("  ✓ Bullish Marubozu expansion verified");

console.log("ALL Candlestick Pattern tests passed successfully!\n");
