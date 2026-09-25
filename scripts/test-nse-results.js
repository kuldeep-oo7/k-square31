"use strict";

/**
 * RESULTS DATES READ FROM NSE'S FILINGS -- no network: rows in the exchange's
 * own shape (api/corporate-board-meetings, 2026-09-25).
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const R = require("../api/_lib/nse-results");

let passed = 0;
let failed = 0;
function check(label, condition, detail = "") {
  if (condition) { passed += 1; console.log("  ok    " + label); }
  else { failed += 1; console.log("  FAIL  " + label + (detail ? "  (" + detail + ")" : "")); }
}

const rows = [
  { bm_symbol: "HDFCBANK", bm_date: "17-Oct-2026", bm_purpose: "Financial Results", bm_desc: "To consider and approve the financial results for the period ended September 30, 2026", bm_timestamp: "22-Sep-2026 16:10:00" },
  // A generic intimation whose text says results: counted.
  { bm_symbol: "NAVINFLUOR", bm_date: "30-Oct-2026", bm_purpose: "Board Meeting Intimation", bm_desc: "has informed the Exchange about Board Meeting to be held on 30-Oct-2026 to inter-alia consider and approve the Unaudited Financial results", bm_timestamp: "24-Sep-2026 17:49:21" },
  // A fund-raising meeting: not results.
  { bm_symbol: "POWERGRID", bm_date: "26-Sep-2026", bm_purpose: "Fund Raising", bm_desc: "To consider raising of funds", bm_timestamp: "20-Sep-2026 10:00:00" },
  // Rescheduled: the LATER filing moves the date.
  { bm_symbol: "INFY", bm_date: "16-Oct-2026", bm_purpose: "Financial Results", bm_desc: "financial results", bm_timestamp: "10-Sep-2026 09:00:00" },
  { bm_symbol: "INFY", bm_date: "23-Oct-2026", bm_purpose: "Financial Results/Dividend", bm_desc: "financial results and interim dividend", bm_timestamp: "24-Sep-2026 12:00:00" },
  // Already past: dropped.
  { bm_symbol: "VIPULLTD", bm_date: "20-Sep-2026", bm_purpose: "Financial Results", bm_desc: "financial results for the period ended March 31, 2026", bm_timestamp: "15-Sep-2026 12:00:00" }
];

console.log("NSE results calendar:");
check("dates read in the exchange's format", R.isoDate("17-Oct-2026") === "2026-10-17" && R.isoDate("junk") === null);
check("filing times read as IST", R.filedMs("24-Sep-2026 17:49:21") === Date.parse("2026-09-24T17:49:21+05:30"));
const by = R.resultsBySymbol(rows, "2026-09-25");
check("a results meeting is found by its purpose", by.HDFCBANK?.date === "2026-10-17");
check("and by its text when the purpose is a generic intimation", by.NAVINFLUOR?.date === "2026-10-30");
check("a fund-raising meeting is not a results date", !by.POWERGRID);
check("a rescheduled meeting takes the LATEST filing's date", by.INFY?.date === "2026-10-23", by.INFY?.date);
check("a meeting already past is dropped", !by.VIPULLTD);

const cal = { ok: true, symbols: by };
check("three states: announced", JSON.stringify(R.resultsStatus(cal, "HDFCBANK")) === JSON.stringify({ status: "ANNOUNCED", date: "2026-10-17" }));
check("three states: read, and nothing filed", R.resultsStatus(cal, "LT").status === "NOT_ANNOUNCED");
check("three states: calendar unreadable claims nothing", R.resultsStatus(null, "LT").status === "UNKNOWN");

const ist = (day, hhmm) => Date.parse(`${day}T${hhmm}:00+05:30`);
check("TCS results Thu 8 Oct fall inside the trading week of Tue 6 Oct", R.insideTradingWeek("2026-10-08", ist("2026-10-06", "10:00")) === true);
check("but not inside the week of Fri 2 Oct (that is next week)", R.insideTradingWeek("2026-10-08", ist("2026-10-02", "10:00")) === false);
check("on the Saturday before, the coming week counts", R.insideTradingWeek("2026-10-08", ist("2026-10-03", "10:00")) === true);
check("a date already past is not inside the week", R.insideTradingWeek("2026-10-05", ist("2026-10-06", "10:00")) === false);
check("no date, no veto", R.insideTradingWeek(null, ist("2026-10-06", "10:00")) === false);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "k2-results-"));
const file = path.join(dir, "nse-results.json");
fs.writeFileSync(file, JSON.stringify({ ok: false, fetchedAt: new Date().toISOString(), reason: "HTTP 403" }));
check("a failed fetch is never loaded as an empty calendar", R.loadResultsCalendar({ file }) === null);
fs.writeFileSync(file, JSON.stringify({ ok: true, fetchedAt: new Date(Date.now() - 48 * 3600_000).toISOString(), symbols: {} }));
check("a stale calendar (48 h) is not trusted either", R.loadResultsCalendar({ file }) === null);
fs.writeFileSync(file, JSON.stringify({ ok: true, fetchedAt: new Date().toISOString(), symbols: by }));
check("a fresh, successful read is loaded", R.loadResultsCalendar({ file })?.symbols?.INFY?.date === "2026-10-23");
fs.rmSync(dir, { recursive: true, force: true });

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
