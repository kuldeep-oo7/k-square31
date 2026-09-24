"use strict";

/**
 * NSE TRADING HOLIDAYS, EXACTLY AS THE EXCHANGE PUBLISHES THEM.
 *
 * Source: NSE's own holiday master, F&O segment
 *   https://www.nseindia.com/api/holiday-master?type=trading
 * fetched 2026-09-24. Re-fetch it when a new year's list is published; until
 * then a year that is not here is reported as NOT COVERED, never guessed.
 *
 * This replaced a hand-typed 2026 list in universe-210.js that disagreed with
 * the exchange on seven dates: Holi on 4 Mar (NSE: 3 Mar), Id-Ul-Fitr on Fri
 * 20 Mar (NSE: Sat 21 Mar -- so the 20th was a trading day), and no entry for
 * 15 Jan, 26 Mar, 31 Mar, 26 Jun or 14 Sep, all weekday holidays.
 */

const HOLIDAYS = new Map([
  ["2026-01-15", "Thursday -- Municipal Corporation Election - Maharashtra"],
  ["2026-01-26", "Monday -- Republic Day"],
  ["2026-02-15", "Sunday -- Mahashivratri"],
  ["2026-03-03", "Tuesday -- Holi"],
  ["2026-03-21", "Saturday -- Id-Ul-Fitr (Ramadan Eid)"],
  ["2026-03-26", "Thursday -- Shri Ram Navami"],
  ["2026-03-31", "Tuesday -- Shri Mahavir Jayanti"],
  ["2026-04-03", "Friday -- Good Friday"],
  ["2026-04-14", "Tuesday -- Dr. Baba Saheb Ambedkar Jayanti"],
  ["2026-05-01", "Friday -- Maharashtra Day"],
  ["2026-05-28", "Thursday -- Bakri Id"],
  ["2026-06-26", "Friday -- Muharram"],
  ["2026-08-15", "Saturday -- Independence Day"],
  ["2026-09-14", "Monday -- Ganesh Chaturthi"],
  ["2026-10-02", "Friday -- Mahatma Gandhi Jayanti"],
  ["2026-10-20", "Tuesday -- Dussehra"],
  ["2026-11-08", "Sunday -- Diwali Laxmi Pujan*"],
  ["2026-11-10", "Tuesday -- Diwali-Balipratipada"],
  ["2026-11-24", "Tuesday -- Prakash Gurpurb Sri Guru Nanak Dev"],
  ["2026-12-25", "Friday -- Christmas"],
]);

const COVERED_YEARS = new Set([...HOLIDAYS.keys()].map((d) => d.slice(0, 4)));

/** true on a listed NSE holiday, false on a listed year's other days, null for a year NSE's list does not cover. */
function isNseHoliday(isoDate) {
  const key = String(isoDate).slice(0, 10);
  if (!COVERED_YEARS.has(key.slice(0, 4))) return null;
  return HOLIDAYS.has(key);
}

module.exports = { NSE_HOLIDAYS: HOLIDAYS, COVERED_YEARS, isNseHoliday };
