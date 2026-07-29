const assert = require("node:assert/strict");
const { archiveRows, googleArchiveConfigured } = require("../api/_lib/google-archive");

const item = {
  item: { symbol: "TEST", sector: "Testing", marketCapCategory: "Small Cap" },
  result: {
    timestamp: [Math.floor(Date.parse("2026-07-28T10:00:00Z") / 1000)],
    indicators: { quote: [{ open: [100], high: [105], low: [98], close: [103], volume: [123456] }] }
  }
};
const rows = archiveRows([item]);
assert.equal(rows.length, 1);
assert.deepEqual(rows[0], {
  symbol: "TEST", session: "2026-07-28", open: 100, high: 105, low: 98,
  close: 103, volume: 123456, sector: "Testing", marketCapCategory: "Small Cap"
});
assert.equal(googleArchiveConfigured(), false);

console.log("Google archive payload tests passed");
