"use strict";

/**
 * WHICH SYMBOLS NSE LISTS TODAY, AND WHAT THE OLD ONES BECAME.
 *
 * The watch list is the user's workbook, and a workbook ages: companies are
 * renamed, merged, re-listed. The desk priced every row by its workbook symbol,
 * so a renamed company silently had no price. Measured 2026-09-25: AMARAJABAT
 * (now ARE&M), GUJGASLTD (now GUJENERGY) and PEL (now PIRAMALFIN) were watched
 * under names NSE no longer lists -- three companies the user meant to watch
 * that the desk never looked at. The workbook even carried the right Yahoo
 * ticker for two of them; the desk read only the symbol column.
 *
 * Both files are NSE's own, served from its archive without a cookie:
 *   content/equities/EQUITY_L.csv      every listed equity symbol
 *   content/equities/symbolchange.csv  company, old symbol, new symbol, date
 * A symbol is followed to a new one only when NSE lists the new one today.
 */

const fs = require("node:fs");
const path = require("node:path");

const CACHE_FILE = path.resolve(__dirname, "../../.private/cache/nse-symbols.json");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const ARCHIVE = "https://nsearchives.nseindia.com/content/equities";
const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

/** EQUITY_L.csv -> the set of listed symbols (first column). */
function parseListed(csv) {
  return new Set(String(csv || "").split(/\r?\n/).slice(1).map((l) => l.split(",")[0].trim().toUpperCase()).filter(Boolean));
}

/**
 * symbolchange.csv -> { OLD: NEW }. Read from the right, because a company
 * name can itself contain a comma; where an old symbol was changed more than
 * once, the latest change wins.
 */
function parseChanges(csv) {
  const latest = {};
  for (const line of String(csv || "").split(/\r?\n/)) {
    const cells = line.split(",").map((c) => c.trim());
    if (cells.length < 4) continue;
    const [from, to, when] = cells.slice(-3);
    const m = String(when).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
    if (!from || !to || !m) continue;
    const date = `${m[3]}-${String(MONTHS[m[2].toUpperCase()] || 0).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    const key = from.toUpperCase();
    if (!latest[key] || latest[key].date < date) latest[key] = { to: to.toUpperCase(), date };
  }
  return Object.fromEntries(Object.entries(latest).map(([k, v]) => [k, v.to]));
}

/**
 * The symbol NSE trades this workbook row under today.
 *   entry  {symbol, yahoo} from data/watchlist.json
 *   nse    {listed: Set, changes: {OLD: NEW}}, or null when not read
 * Returns {symbol, from, how}. `from` is set only when the row was followed to
 * a new symbol; `unlisted` when NSE lists neither the row nor any successor.
 */
function resolveWatchSymbol(entry, nse) {
  const symbol = String(entry?.symbol || entry || "").trim().toUpperCase();
  if (!nse || !nse.listed || !nse.listed.size || nse.listed.has(symbol)) return { symbol, from: null, how: null };
  let s = symbol;
  const seen = new Set();
  while (nse.changes?.[s] && !seen.has(s)) { seen.add(s); s = nse.changes[s]; }
  if (s !== symbol && nse.listed.has(s)) return { symbol: s, from: symbol, how: "NSE_SYMBOL_CHANGE" };
  const ticker = String(entry?.yahoo || "").trim().toUpperCase().replace(/\.NS$/, "");
  if (ticker && ticker !== symbol && nse.listed.has(ticker)) return { symbol: ticker, from: symbol, how: "WORKBOOK_TICKER" };
  return { symbol, from: null, how: null, unlisted: true };
}

async function refreshNseSymbols({ file = CACHE_FILE, fetchImpl = fetch } = {}) {
  let record;
  try {
    const get = async (name) => {
      const res = await fetchImpl(`${ARCHIVE}/${name}`, { headers: { "User-Agent": UA, Accept: "text/csv,*/*" }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`${name}: NSE answered HTTP ${res.status}`);
      return { text: await res.text(), modified: res.headers?.get?.("last-modified") || null };
    };
    const listedFile = await get("EQUITY_L.csv");
    const changeFile = await get("symbolchange.csv");
    const listed = parseListed(listedFile.text);
    // A truncated or error page must not empty the list and unlist everything.
    if (listed.size < 1000) throw new Error(`EQUITY_L.csv held only ${listed.size} symbols`);
    record = { ok: true, fetchedAt: new Date().toISOString(), listedModified: listedFile.modified, changesModified: changeFile.modified,
      listed: [...listed].sort(), changes: parseChanges(changeFile.text) };
  } catch (error) {
    record = { ok: false, fetchedAt: new Date().toISOString(), reason: error.message };
  }
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(record)); } catch { /* reported by the caller */ }
  return record;
}

/** The cached lists if read successfully within `maxAgeMs` (default 8 days), as {listed: Set, changes}. */
function loadNseSymbols({ file = CACHE_FILE, now = Date.now(), maxAgeMs = 8 * 86_400_000 } = {}) {
  try {
    const r = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!r || r.ok !== true || now - Date.parse(r.fetchedAt) > maxAgeMs) return null;
    return { listed: new Set(r.listed || []), changes: r.changes || {}, fetchedAt: r.fetchedAt, listedModified: r.listedModified || null };
  } catch { return null; }
}

module.exports = { CACHE_FILE, parseListed, parseChanges, resolveWatchSymbol, refreshNseSymbols, loadNseSymbols };
