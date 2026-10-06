"use strict";
// api/_lib/freshness.js: a part older than the last finished NSE session is named; a current one is not.
const assert = require("node:assert");
const { staleParts, expectedSession } = require("../api/_lib/freshness");
const at = (iso) => Date.parse(iso);
// Tue 6 Oct 2026 13:50 IST: the last session that had closed 6 h before is Mon 5 Oct.
const now = at("2026-10-06T08:20:00Z");
assert.strictEqual(expectedSession(now), "2026-10-05");
// Mon 5 Oct 09:00 IST: Fri 2 Oct is a holiday (Gandhi Jayanti), so the last session is Thu 1 Oct.
assert.strictEqual(expectedSession(at("2026-10-05T03:30:00Z")), "2026-10-01");
// Tue 6 Oct 20:00 IST: still Mon 5 Oct (the evening grace), so no false alarm before the evening job.
assert.strictEqual(expectedSession(at("2026-10-06T14:30:00Z")), "2026-10-05");
const side = (to) => ({ available: true, to });
const fresh = { springyDip: { dataThrough: "2026-10-05" }, oiFlow: { dataThrough: "2026-10-05" }, forwardV2: { dataThrough: "2026-10-05" },
  forwardV3: { dataThrough: "2026-10-05" }, risk: { available: true, futures: side("2026-10-05") }, direction: { available: true, asOf: "2026-10-05" } };
assert.deepStrictEqual(staleParts(fresh, now).items, []);
// What the owner saw on 6 Oct: paper tests and the risk replay on 1 Oct.
const old = { ...fresh, springyDip: { dataThrough: "2026-10-01" }, risk: { available: true, futures: side("2026-10-01") }, forwardV3: null };
const parts = staleParts(old, now).items.map((x) => `${x.part}:${x.have}`);
assert.deepStrictEqual(parts, ["the springy-dip paper test:2026-10-01", "the cheap-vol and industry paper tests:null", "the bad-day risk replay:2026-10-01"]);
console.log("freshness tests passed");
