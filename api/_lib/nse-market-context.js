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

const MON = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
// NSE's official closes for the session in an allIndices timestamp ("01-Oct-2026 15:30:00"), or null.
async function officialClose(timestamp, { fetcher = fetch } = {}) {
  const m = /^(\d{2})-([A-Za-z]{3})-(\d{4})/.exec(String(timestamp || "")); if (!m || !MON[m[2].toUpperCase()]) return null;
  try {
    const res = await fetcher(`https://nsearchives.nseindia.com/content/indices/ind_close_all_${m[1]}${MON[m[2].toUpperCase()]}${m[3]}.csv`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const out = {};
    for (const line of (await res.text()).split(/\r?\n/)) { const f = line.split(",");
      if (f[0] === "India VIX" && Number(f[5]) > 0) out.vix = { close: Number(f[5]), changePct: Number(f[7]) };
      if (f[0] === "Nifty 50" && Number(f[5]) > 0) out.nifty = { close: Number(f[5]), changePct: Number(f[7]) }; }
    return out.vix ? out : null;
  } catch { return null; }
}

async function refreshMarketContext({ file = CACHE_FILE } = {}) {
  let record;
  try {
    // NSE stalls some cloud addresses instead of refusing them; a stall must
    // cost seconds, not the build (Node's own wait is minutes).
    const home = await fetch("https://www.nseindia.com/market-data/live-market-indices", { headers: { "User-Agent": UA, Accept: "text/html" }, signal: AbortSignal.timeout(15_000) });
    const cookie = (home.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
    const res = await fetch("https://www.nseindia.com/api/allIndices", { headers: { "User-Agent": UA, Accept: "application/json", Cookie: cookie,
      Referer: "https://www.nseindia.com/market-data/live-market-indices" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`NSE answered HTTP ${res.status}`);
    const body = await res.json();
    const row = (name) => (body?.data || []).find((r) => r.index === name) || null;
    const vix = row("INDIA VIX"), nifty = row("NIFTY 50");
    if (!(Number(vix?.last) > 0)) throw new Error("INDIA VIX not in NSE's reply");
    record = { ok: true, fetchedAt: new Date().toISOString(), nseTimestamp: body.timestamp || null,
      indiaVix: Number(vix.last), indiaVixChangePct: Number(vix.percentChange),
      nifty: Number(nifty?.last) || null, niftyChangePct: Number.isFinite(Number(nifty?.percentChange)) ? Number(nifty.percentChange) : null,
      vixSource: "NSE allIndices" };
    // THE OFFICIAL CLOSE ONCE THERE IS ONE (audit F27). After the close, allIndices keeps India VIX's
    // 15:30 value (29 Sep 2026: 13.32), but NSE's official close is different (13.41). NSE publishes it
    // in content/indices/ind_close_all_DDMMYYYY.csv that evening (checked 4 Oct 2026: 1 Oct 2026
    // India VIX 14.46, Nifty 50 22,421.95). If that file exists for the session allIndices belongs
    // to, its closes are used. During a session it does not exist yet, so the live value stands.
    const official = await officialClose(body.timestamp);
    if (official?.vix) Object.assign(record, { indiaVix: official.vix.close, indiaVixChangePct: official.vix.changePct, vixSource: "NSE official close (ind_close_all)",
      ...(official.nifty ? { nifty: official.nifty.close, niftyChangePct: official.nifty.changePct } : {}) });
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

module.exports = { CACHE_FILE, refreshMarketContext, loadMarketContext, officialClose };
