"use strict";

/**
 * INDIA VIX AND NIFTY, FROM NSE (api/allIndices), cached per build.
 *
 * The engine was handed a hard-coded India VIX of 12.5 on every build -- the
 * crash day included -- for its horizon estimate and its K2-Lang macro gate. A
 * number typed into the code is not a measurement. Unreadable = null, never a
 * default dressed as data.
 */

const fs = require("node:fs");
const path = require("node:path");

const CACHE_FILE = path.resolve(__dirname, "../../.private/cache/nse-market-context.json");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

async function refreshMarketContext({ file = CACHE_FILE } = {}) {
  let record;
  try {
    const home = await fetch("https://www.nseindia.com/market-data/live-market-indices", { headers: { "User-Agent": UA, Accept: "text/html" } });
    const cookie = (home.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
    const res = await fetch("https://www.nseindia.com/api/allIndices", { headers: { "User-Agent": UA, Accept: "application/json", Cookie: cookie,
      Referer: "https://www.nseindia.com/market-data/live-market-indices" } });
    if (!res.ok) throw new Error(`NSE answered HTTP ${res.status}`);
    const body = await res.json();
    const row = (name) => (body?.data || []).find((r) => r.index === name) || null;
    const vix = row("INDIA VIX"), nifty = row("NIFTY 50");
    if (!(Number(vix?.last) > 0)) throw new Error("INDIA VIX not in NSE's reply");
    record = { ok: true, fetchedAt: new Date().toISOString(), nseTimestamp: body.timestamp || null,
      indiaVix: Number(vix.last), indiaVixChangePct: Number(vix.percentChange),
      nifty: Number(nifty?.last) || null, niftyChangePct: Number.isFinite(Number(nifty?.percentChange)) ? Number(nifty.percentChange) : null };
  } catch (error) {
    record = { ok: false, fetchedAt: new Date().toISOString(), reason: error.message };
  }
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(record, null, 1)); } catch { /* reported by the caller */ }
  return record;
}

/** The cached context if read successfully within `maxAgeMs` (default 2 h), else null. */
function loadMarketContext({ file = CACHE_FILE, now = Date.now(), maxAgeMs = 2 * 3_600_000 } = {}) {
  try {
    const r = JSON.parse(fs.readFileSync(file, "utf8"));
    return r && r.ok === true && now - Date.parse(r.fetchedAt) <= maxAgeMs ? r : null;
  } catch { return null; }
}

module.exports = { CACHE_FILE, refreshMarketContext, loadMarketContext };
