"use strict";

/**
 * PRICE HISTORY MUST ADVANCE WITH THE MARKET.
 *
 * 2026-09-24: the build fetched only names with no history, so the whole watch
 * list sat on the bars of its first run. These pin the rule that replaced it:
 * history fetched before the latest session closed is behind, and is fetched.
 */

const { latestSessionCloseMs, isBehindLatestSession, lastBarDate } = require("../api/_lib/bar-cache");

let passed = 0;
let failed = 0;
function check(label, condition, detail = "") {
  if (condition) { passed += 1; console.log("  ok    " + label); }
  else { failed += 1; console.log("  FAIL  " + label + (detail ? "  (" + detail + ")" : "")); }
}

const ist = (day, hhmm) => Date.parse(`${day}T${hhmm}:00+05:30`);
const closeOf = (day) => ist(day, "15:30");
const bars = (n, lastDay) => Array.from({ length: n }, (_, i) => ({ close: 100 + i, timestamp: Math.floor(ist(lastDay, "09:15") / 1000) - (n - 1 - i) * 86400 }));

console.log("price history refresh:");

check("Thursday night: the latest close is Thursday 15:30", latestSessionCloseMs(ist("2026-09-24", "21:33")) === closeOf("2026-09-24"));
check("Friday pre-open: still Thursday's close", latestSessionCloseMs(ist("2026-09-25", "09:13")) === closeOf("2026-09-24"));
check("exactly 15:30 is that day's close", latestSessionCloseMs(ist("2026-09-25", "15:30")) === closeOf("2026-09-25"));
check("Saturday: Friday's close", latestSessionCloseMs(ist("2026-09-26", "12:00")) === closeOf("2026-09-25"));
check("Monday 09:13: Friday's close, not Sunday's", latestSessionCloseMs(ist("2026-09-28", "09:13")) === closeOf("2026-09-25"));

const firstRun = { bars: bars(60, "2026-09-22"), fetchedAt: new Date(ist("2026-09-23", "07:54")).toISOString() };
check("the bars from the first run (23 Sep 07:54) are behind on Friday morning",
  isBehindLatestSession(firstRun, ist("2026-09-25", "09:13")) === true);
const evening = { bars: bars(60, "2026-09-24"), fetchedAt: new Date(ist("2026-09-24", "19:43")).toISOString() };
check("bars fetched after Thursday's close are current on Friday morning",
  isBehindLatestSession(evening, ist("2026-09-25", "09:13")) === false);
check("and behind again once Friday has closed", isBehindLatestSession(evening, ist("2026-09-25", "19:43")) === true);
check("no history at all is behind", isBehindLatestSession(null, ist("2026-09-25", "09:13")) === true);
check("fewer than ten bars is behind", isBehindLatestSession({ bars: bars(5, "2026-09-24"), fetchedAt: new Date(ist("2026-09-24", "20:00")).toISOString() }, ist("2026-09-25", "09:13")) === true);
check("a missing fetch time is behind, never assumed current", isBehindLatestSession({ bars: bars(60, "2026-09-24") }, ist("2026-09-25", "09:13")) === true);
check("the last bar's date is read in IST", lastBarDate(bars(60, "2026-09-24")) === "2026-09-24");

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
