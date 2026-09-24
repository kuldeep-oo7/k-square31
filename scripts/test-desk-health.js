"use strict";

/**
 * THE GATE MUST RING FOR AN OUTAGE AND STAY QUIET FOR A HOLIDAY.
 *
 * checkLivePath decides whether a build in market hours turns red. The case
 * that matters most is the one that looks innocent: a feed frozen on
 * yesterday's prints looks exactly like an exchange holiday, so the gate asks
 * NSE's own calendar as well as the feed.
 */

const { checkLivePath } = require("./check-desk-health");
const { isNseHoliday } = require("../api/_lib/nse-holidays");

let passed = 0;
let failed = 0;
function check(label, condition, detail = "") {
  if (condition) { passed += 1; console.log("  ok    " + label); }
  else { failed += 1; console.log("  FAIL  " + label + (detail ? "  (" + detail + ")" : "")); }
}

const ist = (day, hhmm) => Date.parse(`${day}T${hhmm}:00+05:30`);
const live = { marketPhase: "OPEN", brokerCheck: { ok: true }, pricedLive: 202, levelsFrozen: true, quoteStatus: { lastExchangeDate: "2026-09-24" } };
const dead = { ...live, pricedLive: 0, levelsFrozen: false };

console.log("desk health gate:");

const run = (data, day, hhmm) => checkLivePath(data, ist(day, hhmm));

check("a healthy session is green", run(live, "2026-09-24", "11:13").problems.length === 0);
check("a failed Angel One login is red",
  run({ ...live, brokerCheck: { ok: false, stage: "LOGIN", reason: "bad TOTP" } }, "2026-09-24", "11:13").problems.length === 1);
check("a dead feed on a trading day, prints dated today, is red", run(dead, "2026-09-24", "11:13").problems.length === 1);
check("no quotes at all proves nothing and is red", run({ ...dead, quoteStatus: { lastExchangeDate: null } }, "2026-09-24", "11:13").problems.length === 1);

// Friday 2 Oct 2026 is Gandhi Jayanti on NSE's own list.
check("NSE's calendar is the exchange's: 2 Oct 2026 is a holiday, 25 Sep is not",
  isNseHoliday("2026-10-02") === true && isNseHoliday("2026-09-25") === false);
const holiday = run({ ...dead, quoteStatus: { lastExchangeDate: "2026-10-01" } }, "2026-10-02", "11:13");
check("on a real NSE holiday, yesterday's prints are green", holiday.problems.length === 0 && holiday.exchangeShut === true,
  holiday.problems[0] || "");
const frozen = run({ ...dead, quoteStatus: { lastExchangeDate: "2026-09-24" } }, "2026-09-25", "11:13");
check("the SAME picture on a trading day is a frozen feed, and red", frozen.problems.length === 1 && /frozen, not a holiday/.test(frozen.problems[0]),
  frozen.problems[0] || "no alarm");
const uncovered = run({ ...dead, quoteStatus: { lastExchangeDate: "2027-01-25" } }, "2027-01-26", "11:13");
check("a year NSE's list does not cover yet trusts the feed rather than guessing", isNseHoliday("2027-01-26") === null && uncovered.problems.length === 0);

check("09:33 is before the window: the first freeze has not had its chance yet", run(dead, "2026-09-24", "09:33").problems.length === 0);
check("after the close nothing live is expected", run({ ...dead, marketPhase: "CLOSED" }, "2026-09-24", "15:53").problems.length === 0);
check("live books seen but no freeze is a build defect, and red",
  /did not freeze/.test(run({ ...live, levelsFrozen: false }, "2026-09-24", "11:13").problems[0] || ""));

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
