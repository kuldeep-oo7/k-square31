"use strict";
// IS ANYTHING ON THIS BUILD OLDER THAN IT SHOULD BE?
//
// Some parts of the page are not rebuilt by the desk build itself: the forward paper tests come from a
// separate morning job (springy-dip.yml), and the bad-day risk box from a price cache that is refreshed
// a little at a time. On 6 Oct 2026 the owner found both still on 1 Oct data -- GitHub had skipped the
// morning job, and the cache kept losing each build's refresh -- while the page looked current.
// This compares every such date with the last NSE session that should be in it, and the page shows a
// red line naming whatever is behind, so a stale part can never pass for a fresh one.
//
// "Should be in it" is lenient on purpose: the session that had closed at least 6 hours before this
// build (lastCompletedSession counts a session from 16:00 IST). So the evening between the close and the
// next morning's jobs never raises a false alarm, and a whole missed day always does.
const { lastCompletedSession } = require("./risk-history");

// 17 h, not 6 (audit 12 Oct 2026): the paper tests are rebuilt by the 07:50 morning job, so from 16:00 to
// about 09:00 the next day the previous session is what they SHOULD hold. With 6 h the page showed a red
// OUT OF DATE line every evening after 22:00 -- a false alarm, against this file's own stated intent.
const GRACE_MS = 17 * 3600_000;

function expectedSession(now = Date.now()) { return lastCompletedSession(now - GRACE_MS); }

/** d: the build's data (data.json). Returns { expected, items: [{ part, have, want }] }. */
function staleParts(d, now = Date.now()) {
  const want = expectedSession(now);
  const items = [];
  const check = (part, have) => { if (!have || String(have).slice(0, 10) < want) items.push({ part, have: have ? String(have).slice(0, 10) : null, want }); };
  const paper = [["the springy-dip paper test", d.springyDip], ["the open-interest paper tests", d.oiFlow],
    ["the strangle and 150-day paper tests", d.forwardV2], ["the cheap-vol and industry paper tests", d.forwardV3], ["the borrowing-surge paper test", d.forwardV4]];
  for (const [part, doc] of paper) check(part, doc?.dataThrough);
  if (d.risk?.available) {
    const side = [d.risk.futures, d.risk.calls, d.risk.puts].find((s) => s?.available && s.to);
    if (side) check("the bad-day risk replay", side.to);
  }
  if (d.direction?.available) check("the market direction (NIFTY's trend)", d.direction.asOf);
  return { expected: want, items };
}

module.exports = { staleParts, expectedSession, GRACE_MS };
