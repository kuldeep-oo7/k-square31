const assert = require("node:assert/strict");
const { SHARD_COUNT, shardUniverse, symbolShard, universe, universeMetadata } = require("../api/_lib/universe");

const items = universe();
const metadata = universeMetadata();
assert.equal(SHARD_COUNT, 10);
assert.equal(metadata.officialStocks, 500);
assert.equal(metadata.continuityStocks, 2);
assert.equal(items.length, 502);
assert.equal(metadata.categories.large, 100);
assert.equal(metadata.categories.mid, 150);
assert.equal(metadata.categories.small, 252);
assert.equal(new Set(items.map((item) => item.symbol)).size, items.length);
assert.equal(items.filter((item) => item.shard < 0 || item.shard >= SHARD_COUNT).length, 0);
assert.equal(Array.from({ length: SHARD_COUNT }, (_, shard) => shardUniverse(shard).length).reduce((sum, value) => sum + value, 0), items.length);

// 100% of the universe is covered across the 10 scheduled Vercel crons (shards 0-9)
assert.equal(symbolShard("ICICIGI"), 0);
assert.ok(symbolShard("360ONE") >= 0 && symbolShard("360ONE") < 10);

console.log(`Broad AI universe tests passed: ${items.length} stocks across ${SHARD_COUNT} shards`);
