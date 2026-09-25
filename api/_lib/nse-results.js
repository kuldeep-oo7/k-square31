"use strict";

/**
 * RESULTS DATES, FROM THE EXCHANGE.
 *
 * A results announcement is a known date on which a stock can gap, and on
 * which an option's implied volatility collapses the moment the news is out --
 * a structural loss for an option BUYER that has nothing to do with direction.
 * The desk had an earnings veto, fed by Yahoo's fundamentals; the serverless
 * build never refreshed that cache, so on 2026-09-25 not one of 285 watched
 * names had a date and the veto could not fire.
 *
 * The source now is NSE's own record of board-meeting intimations
 *   https://www.nseindia.com/api/corporate-board-meetings?index=equities&from_date=DD-MM-YYYY&to_date=DD-MM-YYYY
 * Listed companies must file that intimation at least two working days before
 * the meeting that considers financial results (SEBI LODR Regulation 29, as
 * SEBI's own review of the Regulations, Sep 2021, restates it). So a date that
 * has not been filed yet is NOT a clear window -- it can appear two working
 * days ahead -- and the three states are kept apart:
 *   ANNOUNCED      a filing names the date
 *   NOT_ANNOUNCED  the calendar was read and holds no results meeting
 *   UNKNOWN        the calendar could not be read: nothing is claimed
 */

const fs = require("node:fs");
const path = require("node:path");

const CACHE_FILE = path.resolve(__dirname, "../../.private/cache/nse-results.json");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const MONTHS = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
const IST_MS = 330 * 60_000;

/** "17-Oct-2026" -> "2026-10-17"; anything else -> null. */
function isoDate(text) {
  const m = String(text || "").match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  if (!m || !MONTHS[m[2].toUpperCase()]) return null;
  return `${m[3]}-${MONTHS[m[2].toUpperCase()]}-${m[1].padStart(2, "0")}`;
}
/** "24-Sep-2026 17:49:21" (IST) -> epoch ms; anything else -> null. */
function filedMs(text) {
  const d = isoDate(text);
  const t = String(text || "").match(/(\d{2}):(\d{2}):(\d{2})\s*$/);
  if (!d) return null;
  return Date.parse(`${d}T${t ? `${t[1]}:${t[2]}:${t[3]}` : "00:00:00"}+05:30`);
}
function ddmmyyyy(ms) {
  const d = new Date(ms + IST_MS).toISOString().slice(0, 10);
  return `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}`;
}
const isResults = (row) => /financial result/i.test(`${row.bm_purpose || ""} ${row.bm_desc || ""}`);

/**
 * NSE rows -> { SYMBOL: { date, filedAt, purpose, desc } }. Only results
 * meetings; per symbol the LATEST filing wins, because a rescheduled meeting is
 * a new intimation with a new date; and only meetings on or after `today`.
 */
function resultsBySymbol(rows, today) {
  const latest = {};
  for (const row of rows || []) {
    if (!row || !row.bm_symbol || !isResults(row)) continue;
    const date = isoDate(row.bm_date);
    const filed = filedMs(row.bm_timestamp);
    if (!date) continue;
    const cur = latest[row.bm_symbol];
    if (!cur || (filed ?? 0) > (cur.filed ?? 0)) {
      latest[row.bm_symbol] = { date, filed, filedAt: row.bm_timestamp || null, purpose: row.bm_purpose || null, desc: String(row.bm_desc || "").slice(0, 200) };
    }
  }
  const out = {};
  for (const [symbol, r] of Object.entries(latest)) {
    if (r.date >= today) out[symbol] = { date: r.date, filedAt: r.filedAt, purpose: r.purpose, desc: r.desc };
  }
  return out;
}

async function nseCookie() {
  const res = await fetch("https://www.nseindia.com/companies-listing/corporate-filings-event-calendar",
    { headers: { "User-Agent": UA, Accept: "text/html" } });
  return (res.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
}

/**
 * Fetch the next `days` of board-meeting intimations and cache the results
 * meetings. On any failure the cache records ok:false and the reason, so a
 * reader can never mistake "could not read" for "no results".
 */
async function refreshResultsCalendar({ now = Date.now(), days = 60, file = CACHE_FILE } = {}) {
  const today = new Date(now + IST_MS).toISOString().slice(0, 10);
  const from = ddmmyyyy(now);
  const to = ddmmyyyy(now + days * 86_400_000);
  let record;
  try {
    const cookie = await nseCookie();
    const url = `https://www.nseindia.com/api/corporate-board-meetings?index=equities&from_date=${from}&to_date=${to}`;
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", Cookie: cookie,
      Referer: "https://www.nseindia.com/companies-listing/corporate-filings-event-calendar" } });
    if (!res.ok) throw new Error(`NSE answered HTTP ${res.status}`);
    const body = await res.json();
    const rows = Array.isArray(body) ? body : body?.data;
    if (!Array.isArray(rows)) throw new Error("NSE's reply was not a list of meetings");
    record = { ok: true, fetchedAt: new Date(now).toISOString(), from: today, days, rows: rows.length,
      source: "NSE corporate-board-meetings (board-meeting intimations)", symbols: resultsBySymbol(rows, today) };
  } catch (error) {
    record = { ok: false, fetchedAt: new Date(now).toISOString(), reason: error.message };
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(record, null, 1));
  } catch { /* the caller reports the record either way */ }
  return record;
}

/** The cached calendar if it was read successfully within `maxAgeMs`, else null. */
function loadResultsCalendar({ file = CACHE_FILE, now = Date.now(), maxAgeMs = 36 * 3_600_000 } = {}) {
  try {
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!record || record.ok !== true) return null;
    if (now - Date.parse(record.fetchedAt) > maxAgeMs) return null;
    return record;
  } catch { return null; }
}

/** One stock's state: ANNOUNCED (with date), NOT_ANNOUNCED, or UNKNOWN. */
function resultsStatus(calendar, symbol) {
  if (!calendar) return { status: "UNKNOWN" };
  const hit = calendar.symbols?.[symbol];
  return hit ? { status: "ANNOUNCED", date: hit.date } : { status: "NOT_ANNOUNCED" };
}

/**
 * Is a results date inside the current trading week (today through Friday,
 * IST)? On a weekend the coming week counts: results on Tuesday matter on the
 * Saturday before.
 */
function insideTradingWeek(date, now = Date.now()) {
  if (!date) return false;
  const ist = new Date(now + IST_MS);
  const today = ist.toISOString().slice(0, 10);
  const toFriday = (5 - ist.getUTCDay() + 7) % 7;
  const friday = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + toFriday)).toISOString().slice(0, 10);
  return date >= today && date <= friday;
}

module.exports = { CACHE_FILE, isoDate, filedMs, resultsBySymbol, refreshResultsCalendar, loadResultsCalendar, resultsStatus, insideTradingWeek };
