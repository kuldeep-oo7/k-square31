"use strict";

/**
 * PROVE THE LIMIT DOES NOT MOVE.
 *
 * The complaint this whole mechanism answers -- "you are constantly changing
 * the price of the futures ... it gives me 3 prices with variation" -- cannot be
 * checked by reading the code, because every one of those three prices WAS
 * computed correctly. The only thing that distinguishes a fixed limit from a
 * moving one is asking for it twice and comparing.
 *
 * So that is what this does. Nothing here asserts that a number is right; it
 * asserts that a number is the SAME number it was a minute ago.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { openSession, sessionDateFor, driftPct } = require("./session-freeze");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "k2-freeze-"));
const LEDGER = path.join(tmp, "levels.json");

let passed = 0;
let failed = 0;
function check(label, condition) {
  if (condition) { passed += 1; console.log("  ok    " + label); }
  else { failed += 1; console.log("  FAIL  " + label); }
}

console.log("session freeze:");

// 1. A level is computed once and then never again, however much the input moves.
{
  const first = openSession({ canFreeze: true, file: LEDGER });
  const a = first.level("options", "RELIANCE25SEP1400CE", () => ({ buy: 12.5, sell: 18.0, stop: 6.25 }));
  first.save();

  const second = openSession({ canFreeze: true, file: LEDGER });
  let recomputed = false;
  const b = second.level("options", "RELIANCE25SEP1400CE", () => { recomputed = true; return { buy: 31.0, sell: 44.0, stop: 15.5 }; });

  check("the compute function is not called a second time", recomputed === false);
  check("buy is unchanged after the market moved 148%", b.buy === 12.5 && b.buy === a.buy);
  check("sell and stop are unchanged too", b.sell === 18.0 && b.stop === 6.25);
  check("the carried level still reports its original freeze stamp", b.frozenAtIst === a.frozenAtIst);
  check("it is counted as carried, not as newly frozen", second.tally.carried === 1 && second.tally.frozenThisBuild === 0);
}

// 2. A contract that qualifies later in the day still gets a level -- and gets
//    its OWN stamp, not the session's opening stamp.
{
  const later = openSession({ canFreeze: true, file: LEDGER });
  const fresh = later.level("options", "TCS25SEP3200CE", () => ({ buy: 40, sell: 52, stop: 20 }));
  check("a contract seen for the first time mid-session is frozen now", fresh.frozen === true && fresh.fresh === true);
  check("and is counted as frozen on this build", later.tally.frozenThisBuild === 1);
  later.save();

  const again = openSession({ canFreeze: true, file: LEDGER });
  const old = again.level("options", "RELIANCE25SEP1400CE", () => ({ buy: 99 }));
  check("adding one contract did not disturb the other", old.buy === 12.5);
  check("both are now on file", Object.keys(again.ledger.options).length === 2);
}

// 3. Before the bell nothing is written down, so a pre-open build can never
//    pin the day's levels to yesterday's settlement price.
{
  const closedFile = path.join(tmp, "closed.json");
  const closed = openSession({ canFreeze: false, file: closedFile });
  const indicative = closed.level("futures", "ASHOKLEY", () => ({ buy: 241.2, target1: 247.2, stop: 237.6 }));
  const result = closed.save();
  check("a pre-open level is returned but marked not frozen", indicative.buy === 241.2 && indicative.frozen === false);
  check("it is counted as indicative", closed.tally.indicative === 1);
  check("and nothing reaches the disk", result.written === false && fs.existsSync(closedFile) === false);
}

// 4. A new trading day starts clean. Yesterday's limits must not leak into it.
{
  const tomorrow = Date.now() + 24 * 60 * 60 * 1000;
  const next = openSession({ canFreeze: true, now: tomorrow, file: LEDGER });
  let recomputed = false;
  const v = next.level("options", "RELIANCE25SEP1400CE", () => { recomputed = true; return { buy: 31.0 }; });
  check("the session date rolled", next.sessionDate === sessionDateFor(tomorrow) && next.sessionDate !== sessionDateFor());
  check("yesterday's level is gone and today's is computed fresh", recomputed === true && v.buy === 31.0);
  check("the previous day's other contract did not carry over", Object.keys(next.ledger.options).length === 1);
}

// 5. Drift is the one number that is meant to change.
{
  check("drift is zero when the market is at the limit", driftPct(100, 100) === 0);
  check("drift is +5% when the market is 5% above", driftPct(100, 105) === 5);
  check("drift is negative when the market has come below the limit", driftPct(100, 92) === -8);
  check("drift refuses to divide by zero", driftPct(0, 10) === null && driftPct(null, 10) === null);
}

// 6. The words on the page must match the arithmetic.
{
  const { fillState } = require("./publish-static-desk");
  check("at the limit reads as fillable", fillState(100, 100).word === "AT OR BELOW LIMIT");
  check("below the limit reads as fillable", fillState(100, 88).word === "AT OR BELOW LIMIT");
  check("half a percent above is still at the limit", fillState(100, 100.5).word === "AT THE LIMIT");
  check("twenty percent above says it will not fill", /WILL NOT FILL/.test(fillState(100, 120).word));
  check("a missing price says so instead of reading as fillable", fillState(100, null).word === "NO PRICE");
  check("an empty string is not a price of zero either", fillState(100, "").word === "NO PRICE");
  check("and drift refuses a missing current price", driftPct(100, null) === null && driftPct(100, "") === null);
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
