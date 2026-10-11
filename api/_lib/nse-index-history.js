"use strict";
// NSE'S OWN INDEX HISTORY, WHERE YAHOO HAS NONE (audit F23, fixed 4 Oct 2026).
// Yahoo returns ONE row for NIFTY_FIN_SERVICE.NS (FINNIFTY) and NIFTY_MID_SELECT.NS (MIDCPNIFTY), so their
// puts showed no realised volatility, no touch odds and no bad-day risk. NSE publishes every index's
// daily open/high/low/close in content/indices/ind_close_all_DDMMYYYY.csv (checked 4 Oct 2026: Nifty
// Financial Services closed 24,556.10 on 1 Oct 2026, 24,477.45 on 1 Oct 2024). The release asset
// data-nse-idx/nse-idx.json keeps that history ({ name: [[date, o, h, l, c], ...] }); this module writes it
// into the two caches the desk reads (bar-cache: 3 months; risk-history: 2 years) for any index whose
// Yahoo copy is too thin. An index Yahoo covers well (NIFTY, BANKNIFTY) is left untouched.
const fs = require("node:fs");
const NAME_FOR_TICKER = {
  "^NSEI": "Nifty 50", "^NSEBANK": "Nifty Bank", "NIFTY_FIN_SERVICE.NS": "Nifty Financial Services",
  "NIFTY_MID_SELECT.NS": "Nifty Midcap Select", "^NSMIDCP": "Nifty Next 50"
};
const MIN_RISK_ROWS = 250, MIN_BARS = 50;

function loadArchive(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }

// rows: [[date, o, h, l, c]] sorted; a missing open/high/low ("-" in NSE's file) falls back to the close
function clean(rows) {
  return (rows || []).filter((r) => Number(r[4]) > 0).map(([d, o, h, l, c]) => { const C = +c; const O = +o > 0 ? +o : C, H = +h > 0 ? +h : Math.max(O, C), L = +l > 0 ? +l : Math.min(O, C); return [d, O, H, L, C]; })
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
}
const toBar = ([d, o, h, l, c]) => ({ timestamp: Date.parse(`${d}T03:45:00Z`) / 1000, open: o, high: h, low: l, close: c, rawOpen: o, rawHigh: h, rawLow: l, rawClose: c,
  dividendAdjFactor: 1, priceBasis: "RAW", source: "NSE ind_close_all", volume: 0 });

// Fills thin caches from the archive. Returns what it did, per ticker.
function fillThinIndices({ archive, tickers = Object.keys(NAME_FOR_TICKER), barCache = require("./bar-cache"), riskHistory = require("./risk-history"), now = Date.now() }) {
  const done = {};
  if (!archive) return { error: "no NSE index archive" };
  for (const t of tickers) {
    const rows = clean(archive[NAME_FOR_TICKER[t]]); if (!rows.length) { done[t] = "not in NSE archive"; continue; }
    const notes = [];
    // TOO SHORT, OR OLDER THAN NSE'S OWN ARCHIVE (11 Oct 2026). Yahoo's refresh of FINNIFTY and MIDCPNIFTY
    // fails every build ("only 1 sessions"), so a copy filled from NSE once was never extended: it froze on
    // the day it was filled while the page kept using it. Refill whenever NSE's archive is newer.
    const lastNse = rows[rows.length - 1][0];
    const rh = riskHistory.readHistory(t);
    const rhLast = rh && rh.rows.length && /^\d{4}-\d\d-\d\d/.test(String(rh.rows[rh.rows.length - 1][0])) ? String(rh.rows[rh.rows.length - 1][0]).slice(0, 10) : null;
    if (!rh || rh.rows.length < MIN_RISK_ROWS || (rhLast !== null && rhLast < lastNse)) { riskHistory.saveHistory(t, rows.slice(-520), { now, provider: "NSE ind_close_all" }); notes.push(`2-year history from NSE (${Math.min(rows.length, 520)} sessions to ${lastNse}; the copy had ${rh ? rh.rows.length : 0}${rhLast ? ` to ${rhLast}` : ""})`); }
    const bc = barCache.getCachedBars(t, Number.MAX_SAFE_INTEGER);
    const ts = bc && bc.bars.length ? Number(bc.bars[bc.bars.length - 1].timestamp) : NaN;
    const bcLast = ts > 0 ? new Date(ts * 1000 + 330 * 60000).toISOString().slice(0, 10) : null;   // null: date unknown
    if (!bc || bc.bars.length < MIN_BARS || (bcLast !== null && bcLast < lastNse)) { barCache.saveCachedBars(t, rows.slice(-66).map(toBar), { provider: "NSE ind_close_all" }); notes.push(`3-month bars from NSE (66; Yahoo had ${bc ? bc.bars.length : 0})`); }
    done[t] = notes.length ? notes.join("; ") : "Yahoo history sufficient, left as is";
  }
  return done;
}

// Merges daily files ({ "Nifty 50": [o,h,l,c], ... } per date) into the archive.
function mergeDaily(archive, daily) {
  const out = archive ? JSON.parse(JSON.stringify(archive)) : {};
  for (const [date, byName] of Object.entries(daily)) for (const [name, ohlc] of Object.entries(byName)) {
    if (!Object.values(NAME_FOR_TICKER).includes(name)) continue; const rows = (out[name] ||= []); const i = rows.findIndex((r) => r[0] === date); const row = [date, ...ohlc];
    if (i >= 0) rows[i] = row; else rows.push(row); }
  for (const k of Object.keys(out)) out[k].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return out;
}

module.exports = { NAME_FOR_TICKER, loadArchive, fillThinIndices, mergeDaily, clean };
