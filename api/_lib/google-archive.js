const { resultBars } = require("./market-feed");

const GOOGLE_ARCHIVE_TIMEOUT_MS = 20_000;

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
  return Boolean(process.env.K2_GOOGLE_SHEETS_WEB_APP_URL && process.env.K2_GOOGLE_SHEETS_ARCHIVE_SECRET);
}

async function syncGoogleArchive(shard, items) {
  if (!googleArchiveConfigured()) return { configured: false, synced: false, rows: 0 };
  const rows = archiveRows(items);
  const response = await fetch(process.env.K2_GOOGLE_SHEETS_WEB_APP_URL, {
    method: "POST",
    redirect: "follow",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({
      secret: process.env.K2_GOOGLE_SHEETS_ARCHIVE_SECRET,
      shard,
      generatedAt: new Date().toISOString(),
      rows
    }),
    signal: AbortSignal.timeout(GOOGLE_ARCHIVE_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`Google archive returned ${response.status}`);
  const payload = await response.json();
  if (!payload?.ok) throw new Error(payload?.error || "Google archive rejected the payload");
  return { configured: true, synced: true, rows: Number(payload.rows) || rows.length };
}

module.exports = { archiveRows, googleArchiveConfigured, syncGoogleArchive };
