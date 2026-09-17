const { resultBars } = require("./market-feed");

function indiaSession(timestamp) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date(timestamp * 1_000));
}

function archiveRows(items) {
  return items.flatMap(({ item, result }) => resultBars(result).map((bar) => ({
    symbol: item.symbol,
    session: indiaSession(bar.timestamp),
    open: Number.isFinite(bar.open) ? bar.open : bar.close,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: Number.isFinite(bar.volume) ? Math.round(bar.volume) : null,
    sector: item.sector,
    marketCapCategory: item.marketCapCategory
  })));
}

function googleArchiveConfigured() {
  return require("./google-store").googleStoreConfigured();
}

async function syncGoogleArchive(shard, items) {
  if (!googleArchiveConfigured()) return { configured: false, synced: false, rows: 0 };
  // Each AI shard document already contains the complete deduplicated five-year
  // OHLCV history. Duplicating those observations into wide, human-readable
  // tabs wastes millions of Sheet cells and competes with ledger writes.
  return {
    configured: true,
    synced: false,
    rows: 0,
    candidateRows: items.reduce((sum, { result }) => sum + resultBars(result).length, 0),
    reason: "SHARD_WRITE_REQUIRES_SEPARATE_READBACK_VERIFICATION",
    mode: "compressed-operational-state-not-independently-verified",
    shard
  };
}

module.exports = { archiveRows, googleArchiveConfigured, syncGoogleArchive };
