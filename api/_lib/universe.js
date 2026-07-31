const fs = require("node:fs");
const path = require("node:path");

let cached = null;
let cachedMetadata = null;
const SHARD_COUNT = 50;
const LEGACY_SHARDS = 10;

function readLegacyUniverse() {
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "watchlist-data.js"), "utf8");
  const json = source.replace(/^\s*window\.WATCHLIST\s*=\s*/, "").replace(/;\s*$/, "");
  return JSON.parse(json).map((item, index) => ({
    symbol: String(item.symbol || "").toUpperCase(),
    sector: item.sector || "Other",
    marketCapCategory: item.marketCapCategory || "Unclassified",
    legacyIndex: index
  })).filter((item) => /^[A-Z0-9&-]{1,30}$/.test(item.symbol));
}

function shardHash(symbol) {
  let value = 2166136261;
  for (const char of symbol) {
    value ^= char.charCodeAt(0);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

function universe() {
  if (cached) return cached;
  const official = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "ai-universe-data.json"), "utf8"));
  const legacy = readLegacyUniverse();
  const legacyBySymbol = new Map(legacy.map((item) => [item.symbol, item]));
  const officialSymbols = new Set(official.stocks.map((item) => item.symbol));
  const broad = official.stocks.map((item) => {
    const previous = legacyBySymbol.get(item.symbol);
    return {
      symbol: item.symbol,
      name: item.name,
      sector: item.sector || previous?.sector || "Other",
      marketCapCategory: item.marketCapCategory || previous?.marketCapCategory || "Unclassified",
      universeSource: official.name,
      shard: previous ? previous.legacyIndex % LEGACY_SHARDS : LEGACY_SHARDS + (shardHash(item.symbol) % (SHARD_COUNT - LEGACY_SHARDS))
    };
  });
  const continuity = legacy.filter((item) => !officialSymbols.has(item.symbol)).map((item) => ({
    symbol: item.symbol,
    sector: item.sector,
    marketCapCategory: item.marketCapCategory,
    universeSource: "Original watchlist continuity",
    shard: item.legacyIndex % LEGACY_SHARDS
  }));
  cached = [...broad, ...continuity];
  cachedMetadata = {
    name: official.name,
    source: official.source,
    sourceUrl: official.sourceUrl,
    generatedAt: official.generatedAt,
    officialStocks: broad.length,
    continuityStocks: continuity.length,
    totalStocks: cached.length,
    categories: cached.reduce((counts, item) => {
      const key = item.marketCapCategory === "Large Cap" ? "large" : item.marketCapCategory === "Mid Cap" ? "mid" : item.marketCapCategory === "Small Cap" ? "small" : "other";
      counts[key] = (counts[key] || 0) + 1;
      return counts;
    }, { large: 0, mid: 0, small: 0, other: 0 })
  };
  return cached;
}

function universeMetadata() {
  universe();
  return { ...cachedMetadata };
}

function shardUniverse(shard) {
  return universe().filter((item) => item.shard === shard);
}

function symbolShard(symbol) {
  const item = universe().find((candidate) => candidate.symbol === String(symbol || "").toUpperCase().replace(/\.NS$/, ""));
  return item ? item.shard : null;
}

module.exports = { SHARD_COUNT, shardUniverse, symbolShard, universe, universeMetadata };
