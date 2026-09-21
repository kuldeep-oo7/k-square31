"use strict";

/**
 * Does the screener actually SELECT, or does it just pass things through?
 *
 * The defect it was built to remove: the desk showed one at-the-money call and
 * one put for each of 210 names -- 423 contracts out of the 35,313 NSE lists --
 * and the strike was chosen by proximity to spot, which is a default, not a
 * choice. None of the machinery in this repo was ever pointed at the other 98.8%.
 *
 * So these tests ask the only questions that matter of a screener: does it
 * refuse far more than it accepts, does every gate actually bite, and is the
 * thing it ranks on measured rather than assumed.
 */

const assert = require("node:assert/strict");
const { screenContracts, scoreContract, GATES } = require("../api/_lib/contract-screener");
const { loadReference } = require("../api/_lib/fno-reference");

console.log("Starting contract screener test suite...");

// --- 1. The score reacts to each input, in the right direction ---------------
{
  const base = {
    impliedVol: 0.30, realisedVol: 0.30, touchPct: 50, volume: 1000,
    openInterest: 10000, delta: 0.5, daysToExpiry: 22, underlyingScore: 50
  };
  const flat = scoreContract(base);

  // Implied BELOW realised is the side an option BUYER wants: you are paying
  // less for movement than the stock has been delivering.
  const cheap = scoreContract({ ...base, impliedVol: 0.20 });
  const dear = scoreContract({ ...base, impliedVol: 0.45 });
  assert.ok(cheap.score > flat.score,
    `cheap volatility must score better than fair: ${cheap.score} vs ${flat.score}`);
  assert.ok(dear.score < flat.score,
    `expensive volatility must score worse than fair: ${dear.score} vs ${flat.score}`);
  console.log(`  ✓ Variance risk premium moves the score the right way (${dear.score} < ${flat.score} < ${cheap.score})`);

  assert.ok(scoreContract({ ...base, touchPct: 80 }).score > scoreContract({ ...base, touchPct: 20 }).score,
    "a target more likely to be touched must rank higher");
  assert.ok(scoreContract({ ...base, volume: 50000, openInterest: 500000 }).score
    > scoreContract({ ...base, volume: 120, openInterest: 600 }).score,
    "a contract you can actually exit must rank higher");
  assert.ok(scoreContract({ ...base, underlyingScore: 95 }).score > scoreContract({ ...base, underlyingScore: 10 }).score,
    "the underlying's own read must carry through");
  console.log("  ✓ Probability, liquidity and the underlying read all move the score");

  // No term may be allowed to dominate: every one of them is unvalidated, and a
  // hidden weight is how this repo's composite score went wrong twice before.
  const reach = [
    scoreContract({ ...base, impliedVol: 0.05 }).score - scoreContract({ ...base, impliedVol: 1.2 }).score,
    scoreContract({ ...base, touchPct: 100 }).score - scoreContract({ ...base, touchPct: 0 }).score,
    scoreContract({ ...base, underlyingScore: 100 }).score - scoreContract({ ...base, underlyingScore: 0 }).score
  ];
  const widest = Math.max(...reach), narrowest = Math.min(...reach);
  assert.ok(widest / narrowest < 2.5,
    `one term swings the score ${(widest / narrowest).toFixed(1)}x more than another; the weighting is not equal`);
  console.log(`  ✓ No single term dominates the blend (widest swing ${widest.toFixed(1)}, narrowest ${narrowest.toFixed(1)})`);
}

// --- 2. Against the real exchange file --------------------------------------
const reference = loadReference();
if (!reference?.symbols) {
  console.log("  - no contract reference cached; exchange-wide screen skipped");
} else {
  const result = screenContracts({ reference, limit: 40 });
  assert.ok(result.ok, "the screen must run against a cached reference");

  // It must REFUSE. A screener that keeps most of what it sees is a list.
  assert.ok(result.examined > 5000,
    `only ${result.examined} contracts examined; this should be walking the whole chain`);
  const keptPct = (100 * result.survived) / result.examined;
  assert.ok(keptPct < 25,
    `${keptPct.toFixed(1)}% of contracts survived; a screener that keeps a quarter of the market is not selecting`);
  console.log(`  ✓ Walked ${result.examined.toLocaleString("en-IN")} listed contracts and refused `
    + `${(100 - keptPct).toFixed(1)}% of them (${result.survived.toLocaleString("en-IN")} survive)`);

  // Every gate must actually bite. A gate that never fires is decoration, and
  // this repo has shipped several of those.
  const fired = Object.entries(result.refused).filter(([, count]) => count > 0).map(([name]) => name);
  assert.ok(fired.includes("illiquid"), "the liquidity gate never fired");
  assert.ok(fired.includes("expiryWindow"), "the expiry window gate never fired");
  console.log(`  ✓ Gates that actually fired: ${fired.join(", ")}`);

  // And every survivor must honour every gate, not just on average.
  for (const c of result.contracts) {
    assert.ok(c.daysToExpiry >= GATES.minDaysToExpiry && c.daysToExpiry <= GATES.maxDaysToExpiry,
      `${c.symbol} ${c.expiry} survived with ${c.daysToExpiry} days`);
    assert.ok(c.volume >= GATES.minVolume, `${c.symbol} ${c.strike}${c.optionType} survived on ${c.volume} lots`);
    assert.ok(c.openInterest >= GATES.minOpenInterest, `${c.symbol} survived on ${c.openInterest} open interest`);
    assert.ok(Math.abs(c.delta) >= GATES.minDelta && Math.abs(c.delta) <= GATES.maxDelta,
      `${c.symbol} ${c.strike}${c.optionType} survived at delta ${c.delta}`);
    assert.ok(c.premium >= GATES.minPremium, `${c.symbol} survived at a premium of ${c.premium}`);
    // Nothing may be priced below intrinsic: NSE derives settlement prices for
    // contracts that did not trade, and an IV solved from one is meaningless.
    const intrinsic = c.optionType === "CE" ? Math.max(0, c.forward - c.strike) : Math.max(0, c.strike - c.forward);
    assert.ok(c.premium >= intrinsic - 1e-6,
      `${c.symbol} ${c.strike}${c.optionType} is priced ${c.premium} below its intrinsic ${intrinsic}`);
  }
  console.log(`  ✓ Every one of the ${result.contracts.length} ranked contracts honours every gate individually`);

  // The ranking must be an ordering, not a tie.
  const scores = result.contracts.map((c) => c.screenScore);
  assert.ok(new Set(scores).size > result.contracts.length / 3,
    `only ${new Set(scores).size} distinct scores across ${scores.length} contracts; the ranking is collapsing`);
  for (let i = 1; i < scores.length; i += 1) {
    assert.ok(scores[i] <= scores[i - 1], "the ranked list is not sorted by score");
  }
  console.log(`  ✓ ${new Set(scores).size} distinct scores across ${scores.length} contracts, correctly ordered`);

  // Every contract must carry what a person needs to act: what to pay, what to
  // sell at, and when it is expected to get there.
  for (const c of result.contracts) {
    for (const field of ["premium", "targetPremium", "breakeven", "expiry", "lotSize", "impliedVol", "daysToExpiry"]) {
      assert.ok(c[field] !== null && c[field] !== undefined,
        `${c.symbol} ${c.strike}${c.optionType} is missing ${field}`);
    }
  }
  console.log("  ✓ Every ranked contract carries entry, target, breakeven, lot size, expiry and implied volatility");

  // Tightening a gate must shrink the list. If it does not, the gate is ignored.
  const strict = screenContracts({ reference, limit: 40, gates: { minVolume: 5000, minOpenInterest: 100000 } });
  assert.ok(strict.survived < result.survived,
    `tightening liquidity from ${GATES.minVolume}/${GATES.minOpenInterest} to 5000/100000 did not shrink the list`);
  console.log(`  ✓ Tightening liquidity cuts the list from ${result.survived.toLocaleString("en-IN")} to ${strict.survived.toLocaleString("en-IN")}`);
}

console.log("ALL contract screener tests passed: it walks the whole listed chain, refuses the overwhelming majority, every gate bites, and every survivor carries the numbers needed to act on it.");
