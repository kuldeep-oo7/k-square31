const assert = require("node:assert/strict");
const { cleanPortfolio, replaceBrokerSnapshot } = require("../api/_lib/portfolio-model");
const { parseBrokerHtml } = require("./broker-html");

const source = { version: 1, lots: [{ symbol: "AUBANK", price: 1030.2, quantity: 70 }], transactions: [] };
const positions = [
  { symbol: "AUBANK", price: 1029.8, quantity: 70, position: "long", expiry: "2026-07-28", markPrice: 995.2, buyQuantity: 90, buyAverage: 1011.2, sellQuantity: 20, sellAverage: 1040, mtm: -2422 },
  { symbol: "NIFTY", price: 24321.7, quantity: 35, position: "short", expiry: "2026-07-28" }
];
const imported = replaceBrokerSnapshot(source, positions, "kamlesh-futures-test-v1", 7669.6);
assert.equal(imported.version, 2);
assert.equal(imported.lots.length, 2, "snapshot replaces old test lots rather than duplicating them");
assert.equal(imported.lots.find((lot) => lot.symbol === "AUBANK").price, 1029.8);
assert.equal(imported.lots.find((lot) => lot.symbol === "AUBANK").markPrice, 995.2);
assert.equal(imported.lots.find((lot) => lot.symbol === "AUBANK").markSource, "broker-close");
assert.equal(imported.lots.find((lot) => lot.symbol === "AUBANK").buyQuantity, 90);
assert.equal(imported.lots.find((lot) => lot.symbol === "AUBANK").sellQuantity, 20);
assert.equal(imported.lots.find((lot) => lot.symbol === "NIFTY").position, "short");
assert.equal(imported.lots.find((lot) => lot.symbol === "NIFTY").contractKey, "NIFTY|FUT|2026-07-28|short");
assert.equal(imported.realizedPnl, 7669.6);
assert.equal(imported.transactions[0].count, 2);
assert.deepEqual(replaceBrokerSnapshot(imported, positions, "kamlesh-futures-test-v1"), imported, "snapshot request is idempotent");
const markRefresh = replaceBrokerSnapshot(imported, [{ ...positions[0], markPrice: 1001, mtm: -2016 }, positions[1]], "kamlesh-futures-test-v1", undefined, { capturedAt: "2026-08-10T17:00:00.000Z", source: "gm-extension" });
assert.equal(markRefresh.transactions.length, imported.transactions.length, "mark-only refresh must not add an import event");
assert.equal(markRefresh.lots.find((lot) => lot.symbol === "AUBANK").markPrice, 1001, "same holdings snapshot still refreshes the broker mark");
assert.equal(markRefresh.realizedPnl, 7669.6, "automatic snapshots must preserve stored realized P&L");
assert.equal(markRefresh.brokerSync.source, "gm-extension");
assert.equal(cleanPortfolio({ lots: [{ symbol: "BAD!", price: 1, quantity: 1 }] }).lots.length, 0);
assert.throws(() => replaceBrokerSnapshot({}, [positions[0], positions[0]], "duplicate-test"), /Duplicate contract/);
assert.equal(replaceBrokerSnapshot(imported, [], "empty-broker-snapshot").lots.length, 0, "a confirmed empty GM portfolio must clear closed positions");
const parsed = parseBrokerHtml(`<table><tbody><tr><td>x</td><td>NSEFUT</td><td>M&amp;M<br>28JUL2026</td><td>10</td><td>3179.2</td><td>2</td><td>3200</td><td>8</td><td>3210.5</td><td>251.4</td><td>28-07-2026</td><td>x</td></tr></tbody></table>`);
assert.deepEqual(parsed[0], { symbol: "M&M", price: 3179.2, quantity: 8, position: "long", expiry: "2026-07-28", markPrice: 3210.5, mtm: 251.4, buyQuantity: 10, sellQuantity: 2 });
console.log("Portfolio model tests passed: futures metadata, shorts, replacement and idempotency");
