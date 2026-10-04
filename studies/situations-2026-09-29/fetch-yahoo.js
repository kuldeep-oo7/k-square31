"use strict";
// S&P 500 (^GSPC), Brent front month (BZ=F) and India VIX (^INDIAVIX), daily, 5 years,
// from Yahoo's chart API, saved raw-but-compact before the study runs:
// yahoo-<name>.json = { ticker, fetchedAt, timezone, rows: [[date(local exchange), close], ...] }
// The date is the bar's date in the EXCHANGE's own timezone (gmtoffset from Yahoo's meta),
// so a US session is dated as New York dates it.

const fs = require("node:fs");
const path = require("node:path");
const TICKERS = { sp500: "^GSPC", brent: "BZ=F", indiavix: "^INDIAVIX" };
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

(async () => {
  for (const [name, ticker] of Object.entries(TICKERS)) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=5y&interval=1d&includePrePost=false`;
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`${ticker}: HTTP ${res.status}`);
    const r = (await res.json()).chart.result[0];
    const offset = Number(r.meta.gmtoffset) || 0;
    const closes = r.indicators.quote[0].close;
    const rows = [];
    r.timestamp.forEach((ts, i) => {
      const c = closes[i];
      if (!(Number.isFinite(c) && c > 0)) return;
      const day = new Date((ts + offset) * 1000).toISOString().slice(0, 10);
      if (rows.length && rows[rows.length - 1][0] === day) rows[rows.length - 1] = [day, c];
      else rows.push([day, c]);
    });
    fs.writeFileSync(path.join(__dirname, `yahoo-${name}.json`), JSON.stringify({ ticker, fetchedAt: new Date().toISOString(), timezone: r.meta.exchangeTimezoneName, gmtoffset: offset, rows }));
    console.log(`${ticker}: ${rows.length} sessions ${rows[0][0]} .. ${rows[rows.length - 1][0]} (last close ${rows[rows.length - 1][1]}, ${r.meta.exchangeTimezoneName})`);
    await new Promise((ok) => setTimeout(ok, 800));
  }
})().catch((e) => { console.error("failed:", e.message); process.exit(1); });
