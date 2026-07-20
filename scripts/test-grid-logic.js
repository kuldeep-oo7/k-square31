const assert = require("node:assert/strict");
const { exitLevels, levels, lotExit, weeklySignal } = require("../grid-logic");

assert.deepEqual(levels(500), [490, 480.2, 470.6, 461.18, 451.96]);
assert.deepEqual(exitLevels(500), [510, 520.2, 530.6, 541.22, 552.04]);
assert.deepEqual(exitLevels(500, 2, 2, "short"), [490, 480.2]);
assert.equal(exitLevels(1056.1)[0], 1077.22);
assert.equal(weeklySignal(500, 489).action, "buy");
assert.equal(weeklySignal(500, 480).reachedBuyLevel, 2);
assert.equal(weeklySignal(500, 510).action, "sell");
assert.equal(weeklySignal(500, 505).action, "wait");
assert.equal(lotExit([{ price: 500, quantity: 40 }, { price: 490, quantity: 20 }], 505).quantity, 20);
assert.equal(lotExit([{ price: 500, quantity: 35 }], 489, 2, "short").quantity, 35);
console.log("Personal 2% grid tests passed: five buys, weekly signal, long exits and short covers");
