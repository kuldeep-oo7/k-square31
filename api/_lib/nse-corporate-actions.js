"use strict";

/**
 * DEMERGERS, BONUSES AND SPLITS, FROM NSE'S OWN FILINGS.
 *
 * The provider's price history is adjusted for most bonuses and splits and for
 * NO demerger. Measured 2026-09-27 on the 280 watched names over two years:
 * ABFRL "fell" 66.6% on 22 May 2025, VEDL 64.9% on 30 Apr 2026, TMPV 40.2% on
 * 14 Oct 2025 and STAR 54.0% on 6 Dec 2024 -- each an NSE demerger ex-date, not
 * a loss to anyone holding the share or the future (NSE adjusts futures for
 * corporate actions). And twice the provider put a bonus adjustment on the
 * wrong day: CONCOR's 1:4 bonus (NSE ex-date 4 Jul 2025) shows as a 20% drop on
 * 1 Jan 2025, TRENT's 1:2 (ex 4 Jun 2026) as a 33% drop on 1 Jan 2026 --
 * exactly 4/5 and 2/3. A risk figure built on that history names those days
 * as its worst.
 *
 * The real crashes in the same history -- INDUSINDBK -27.2% (11 Mar 2025), IEX
 * -29.6% (24 Jul 2025), POLICYBZR -36.0% (24 Sep 2026) and eight more -- match
 * NSE's own price history to the decimal and stay in.
 *
 *   https://www.nseindia.com/api/corporates-corporateActions?index=equities&from_date=DD-MM-YYYY&to_date=DD-MM-YYYY
 */

const fs = require("node:fs");
const path = require("node:path");

const CACHE_FILE = path.resolve(__dirname, "../../.private/cache/nse-corporate-actions.json");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const PAGE = "https://www.nseindia.com/companies-listing/corporate-filings-actions";
const MON = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };

// Actions that change the price of one share without anyone gaining or losing.
// Dividends are already in the adjusted history; a buyback moves no price.
const PRICE_ACTION = /bonus|split|sub-?division|consolidation|demerger|rights|scheme of arrangement|capital reduction|amalgamation|merger/i;

function isoDate(nseDate) {
  const m = String(nseDate || "").match(/^(\d{2})-([A-Za-z]{3})-(\d{4})$/);
  return m && MON[m[2]] ? `${m[3]}-${MON[m[2]]}-${m[1]}` : null;
}
const dmy = (ms) => {
  const d = new Date(ms + 330 * 60_000);
  return `${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${d.getUTCFullYear()}`;
};

/**
 * What one share's price is multiplied by on the ex-date, where the filing says:
 *   "Bonus 1:4"  -> 4 held become 5 -> 4/5
 *   "Face Value Split (Sub-Division) - From Rs 10/- Per Share To Rs 2/- Per Share" -> 2/10
 *   "Consolidation Of Equity Shares From Re 1 Per Share To Rs 10 Per Share" -> 10/1
 * null for everything else (a demerger's ratio is not in its filing).
 */
function priceRatio(subject) {
  const s = String(subject || "");
  if (/ncrps|preference|debenture/i.test(s)) return null;
  const bonus = s.match(/bonus\s+(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/i);
  if (bonus) {
    const [a, b] = [Number(bonus[1]), Number(bonus[2])];
    return a > 0 && b > 0 ? b / (a + b) : null;
  }
  const fv = s.match(/from\s+r[es]\.?\s*([\d.]+).*?to\s+r[es]\.?\s*([\d.]+)/i);
  if (fv && /split|sub-?division|consolidation/i.test(s)) {
    const [from, to] = [Number(fv[1]), Number(fv[2])];
    return from > 0 && to > 0 ? to / from : null;
  }
  return null;
}

async function refreshCorporateActions({ now = Date.now(), days = 800, file = CACHE_FILE, fetcher = fetch } = {}) {
  const page = await fetcher(PAGE, { headers: { "User-Agent": UA, Accept: "text/html" }, signal: AbortSignal.timeout(15_000) });
  const cookie = (page.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  const url = `https://www.nseindia.com/api/corporates-corporateActions?index=equities&from_date=${dmy(now - days * 86_400_000)}&to_date=${dmy(now)}`;
  const res = await fetcher(url, { headers: { "User-Agent": UA, Accept: "application/json", Cookie: cookie, Referer: PAGE }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) return { ok: false, reason: `NSE answered ${res.status}` };
  const body = await res.json();
  const all = Array.isArray(body) ? body : body?.data || [];
  const rows = all.filter((r) => PRICE_ACTION.test(r.subject || "") && isoDate(r.exDate))
    .map((r) => ({ symbol: String(r.symbol).trim(), exDate: isoDate(r.exDate), subject: String(r.subject).trim(), ratio: priceRatio(r.subject) }));
  // Two years of NSE filings hold hundreds of these (326 on 2026-09-27). A
  // handful means a truncated answer, and an empty list would wave every
  // demerger through as a crash: keep the last good file instead.
  if (all.length < 500 || rows.length < 50) return { ok: false, reason: `only ${all.length} filings, ${rows.length} price actions -- kept the previous file` };
  const record = { ok: true, fetchedAt: new Date(now).toISOString(), days, filings: all.length, rows };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(record));
  return record;
}

function loadCorporateActions({ file = CACHE_FILE } = {}) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return data?.ok && Array.isArray(data.rows) ? data : null;
  } catch {
    return null;
  }
}

module.exports = { refreshCorporateActions, loadCorporateActions, priceRatio, isoDate, CACHE_FILE };
