const assert = require("node:assert/strict");
const bridge = require("../extensions/gm-k2-bridge/core.js");

const longRow = ["", "NSEFUT", "AUBANK 28JUL2026", "120", "1015.84", "0", "0", "120", "1015.84", "-2476.92", "28-07-2026", "X"];
const shortRow = ["", "NSEFUT", "NIFTY 28JUL2026", "0", "0", "35", "24321.70", "-35", "24321.70", "3500", "28-07-2026", "X"];
const closedRow = ["", "NSEFUT", "SBIN 28JUL2026", "55", "1045", "55", "1050", "0", "0", "275", "28-07-2026", "X"];

const positions = bridge.normalizeRows([longRow, shortRow, closedRow]);
assert.equal(positions.length, 2, "closed contracts must not appear as open positions");
assert.deepEqual(positions.map((item) => item.symbol), ["AUBANK", "NIFTY"]);
assert.equal(positions[0].position, "long");
assert.equal(positions[0].quantity, 120);
assert.equal(positions[0].buyQuantity, 120);
assert.equal(positions[0].markPrice, 995.2, "MTM should infer the current futures mark without pretending A/B P is LTP");
assert.equal(positions[1].position, "short");
assert.equal(positions[1].quantity, 35);
assert.equal(positions[1].sellAverage, 24321.7);
assert.equal(positions[1].markPrice, 24221.7);

const payloadRows = bridge.rowsFromPayload({ aaData: [longRow, shortRow], iTotalRecords: 2 });
assert.equal(payloadRows.length, 2, "DataTables aaData response should be discovered");
assert.equal(bridge.normalizeRows(payloadRows).length, 2);
assert.equal(bridge.rowsFromPayload({ user: { username: "must-not-be-read" } }).length, 0);

console.log("GM extension tests passed: allowlisted DataTables rows, longs, shorts, MTM marks and closed-position filtering");
