"use strict";

/**
 * The freshness contract.
 *
 * This desk had a defect where a quote fetched at 21:48 IST reported an age of
 * two seconds. The two seconds were real -- that was how long the REQUEST took.
 * The book itself carried the exchange's stamp of 15:40, six hours earlier, and
 * the contract had last traded six days before that. Retrieval time was being
 * presented as quote time, which is the same defect as any other invented
 * number: a figure the system MEASURED about itself, presented as a figure it
 * measured about the market.
 *
 * Everything below exists to keep that from coming back, and runs offline
 * against fixed instants so the answers cannot drift with the wall clock or
 * with the timezone of whatever machine happens to run it.
 */

const assert = require("node:assert/strict");
const {
  classifyBook,
  marketPhase,
  parseExchangeClock
} = require("../api/_lib/live-quotes");

// Instants are pinned so every assertion is reproducible. Thursday 17 Sep 2026.
const AT_2148_IST = Date.parse("2026-09-17T16:18:00Z"); // after the close
const AT_1130_IST = Date.parse("2026-09-17T06:00:00Z"); // mid-session
const AT_0800_IST = Date.parse("2026-09-17T02:30:00Z"); // before the open
const AT_SAT_IST = Date.parse("2026-09-19T06:00:00Z"); // Saturday

// --- 1. The exchange clock is read as IST, not as the host's timezone --------
// Angel sends "17-Sep-2026 15:40:00" with no offset. Date.parse would read that
// in local time: right on an IST laptop, five and a half hours out on a UTC
// server. During market hours that error puts the quote in the FUTURE, and a
// negative age passes every "older than" test, so a stale book would read as
// fresh on precisely the machine that serves real users.
const feed = parseExchangeClock("17-Sep-2026 15:40:00");
assert.equal(new Date(feed).toISOString(), "2026-09-17T10:10:00.000Z",
  "15:40 IST is 10:10 UTC; any other answer means the host timezone leaked in");
console.log("  ✓ Exchange timestamps are read as IST regardless of host timezone");

// 01-Jan-1970 05:30:00 is epoch zero written in IST: the exchange saying this
// contract has never traded. Returned as a date it would claim a 56-year-old
// quote, which is a sentinel wearing a timestamp's clothes.
assert.equal(parseExchangeClock("01-Jan-1970 05:30:00"), null,
  "the never-traded sentinel must not come back as a time");
for (const junk of ["", null, undefined, "not a date", "17/09/2026 15:40", "17-Xxx-2026 15:40:00"]) {
  assert.equal(parseExchangeClock(junk), null, `unparseable input must refuse: ${junk}`);
}
console.log("  ✓ The never-traded sentinel and unparseable stamps refuse rather than invent a time");

// --- 2. Session boundaries ----------------------------------------------------
assert.equal(marketPhase(AT_1130_IST).phase, "OPEN");
assert.equal(marketPhase(AT_1130_IST).open, true);
assert.equal(marketPhase(AT_2148_IST).phase, "CLOSED");
assert.equal(marketPhase(AT_0800_IST).phase, "PRE_OPEN");
assert.equal(marketPhase(AT_SAT_IST).phase, "WEEKEND");
// The boundaries themselves: 09:15:00 is in, 15:30:00 is in, 15:30:01 is not.
assert.equal(marketPhase(Date.parse("2026-09-17T03:45:00Z")).open, true, "09:15 IST is open");
assert.equal(marketPhase(Date.parse("2026-09-17T10:00:00Z")).open, true, "15:30 IST is still open");
assert.equal(marketPhase(Date.parse("2026-09-17T10:01:00Z")).open, false, "15:31 IST is closed");
console.log("  ✓ Session boundaries: 09:15-15:30 IST, weekends and pre-open excluded");

// --- 3. Three states, and what each one permits -------------------------------
// REALTIME: the exchange priced it inside the window while the market is open.
const realtime = classifyBook(parseExchangeClock("17-Sep-2026 11:29:30"), { now: AT_1130_IST });
assert.equal(realtime.kind, "REALTIME");
assert.equal(realtime.executable, true, "a current book during the session is executable");
assert.equal(realtime.exchangeAgeSeconds, 30, "age is measured on the exchange clock");

// CLOSING_BOOK: today's book, market shut. Not executable -- but NOT discarded,
// because its spread is the only measured spread available, and throwing it
// away would switch the spread gate off at 15:30 every day, which is exactly
// when this desk gets read.
const closing = classifyBook(feed, { now: AT_2148_IST });
assert.equal(closing.kind, "CLOSING_BOOK");
assert.equal(closing.executable, false, "nothing is executable when the market is shut");
assert.equal(closing.exchangeAgeSeconds, 22_080, "six hours and eight minutes, stated plainly");
assert.equal(closing.phase, "CLOSED");

// STALE: not from today at all.
const yesterday = classifyBook(parseExchangeClock("16-Sep-2026 15:40:00"), { now: AT_2148_IST });
assert.equal(yesterday.kind, "STALE", "a book from a previous session is stale, not a closing book");
assert.equal(yesterday.executable, false);

// No exchange clock at all. Upstox sends none, so its books can never claim to
// be realtime -- absent evidence must never read as fresh evidence.
const noClock = classifyBook(null, { now: AT_1130_IST });
assert.equal(noClock.kind, "STALE");
assert.equal(noClock.executable, false);
assert.equal(noClock.reason, "NO_EXCHANGE_TIMESTAMP");
console.log("  ✓ REALTIME, CLOSING_BOOK and STALE are distinguished, and only REALTIME is executable");

// --- 4. A book older than the window, while the market is open ----------------
// This is the case the original bug hid. The request may have completed in
// milliseconds; the quote is still stale and cannot be executable.
const laggy = classifyBook(parseExchangeClock("17-Sep-2026 11:20:00"), { now: AT_1130_IST });
assert.equal(laggy.kind, "CLOSING_BOOK", "same session but past the window: a book, not a live quote");
assert.equal(laggy.executable, false, "600 seconds old is not executable however fast we fetched it");
assert.equal(laggy.exchangeAgeSeconds, 600);
assert.equal(laggy.reason, "EXCHANGE_FEED_OLDER_THAN_WINDOW");
console.log("  ✓ A slow feed during the session is never executable, whatever the fetch latency was");

// --- 5. The answer must not depend on where the server runs -------------------
// Render runs UTC; this laptop runs IST. The same input has to produce the same
// verdict on both, or the bug returns in production only.
const savedTz = process.env.TZ;
const verdicts = [];
for (const zone of ["UTC", "Asia/Kolkata", "America/New_York"]) {
  process.env.TZ = zone;
  const parsed = parseExchangeClock("17-Sep-2026 15:40:00");
  const verdict = classifyBook(parsed, { now: AT_2148_IST });
  verdicts.push(`${parsed}|${verdict.kind}|${verdict.exchangeAgeSeconds}`);
}
if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz;
assert.equal(new Set(verdicts).size, 1,
  `the verdict changed with the host timezone: ${verdicts.join(" vs ")}`);
console.log("  ✓ Identical verdict under UTC, IST and US/Eastern hosts");

// --- 6. A future-dated stamp is not treated as infinitely fresh ---------------
// A negative age passes any "older than" comparison, so this needs its own
// guard rather than relying on the window.
const future = classifyBook(AT_1130_IST + 10 * 60 * 1000, { now: AT_1130_IST });
assert.equal(future.executable, false, "a stamp from the future cannot be executable");
console.log("  ✓ A future-dated exchange stamp is rejected rather than read as fresh");

// 12 Oct 2026: a book stamped 5 minutes before screening is stale under the default 2-minute window
// (which emptied the 09:20-09:56 builds) and live under the screener's 10-minute build window.
{
  const fiveMin = classifyBook(parseExchangeClock("17-Sep-2026 11:25:00"), { now: AT_1130_IST });
  const screener = classifyBook(parseExchangeClock("17-Sep-2026 11:25:00"), { now: AT_1130_IST, maxAgeMs: 10 * 60_000 });
  assert.equal(fiveMin.executable, false); assert.equal(screener.executable, true);
  console.log("  ✓ A 5-minute-old book is refused by the 2-minute window and accepted by the screener's build window");
}

console.log("Live-quote tests passed: IST exchange clock independent of host timezone, never-traded sentinel refused, session boundaries, three-state freshness with only REALTIME executable, and a future stamp rejected");
