const fs = require("node:fs");
const path = require("node:path");

let cached = null;

function universe() {
  if (cached) return cached;
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "watchlist-data.js"), "utf8");
  const json = source.replace(/^\s*window\.WATCHLIST\s*=\s*/, "").replace(/;\s*$/, "");
  cached = JSON.parse(json).map((item) => ({
    symbol: String(item.symbol || "").toUpperCase(),
    sector: item.sector || "Other",
    marketCapCategory: item.marketCapCategory || "Unclassified"
  })).filter((item) => /^[A-Z0-9&-]{1,30}$/.test(item.symbol));
  return cached;
}

function shardUniverse(shard, shardCount = 10) {
  return universe().filter((_, index) => index % shardCount === shard);
}

function symbolShard(symbol, shardCount = 10) {
  const index = universe().findIndex((item) => item.symbol === String(symbol || "").toUpperCase().replace(/\.NS$/, ""));
  return index < 0 ? null : index % shardCount;
}

module.exports = { shardUniverse, symbolShard, universe };
