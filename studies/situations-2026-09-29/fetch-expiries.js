"use strict";
// NIFTY's expiry dates, 2021-2026, from NSE's own derivatives-history metadata
// (the list NSE's "F&O - contract-wise" report offers), for index options
// (weekly and monthly) and index futures (monthly). NSE moved the expiry
// weekday inside this window, so a weekday rule would be wrong. A listed date
// that is not an NSE session (a holiday that moved the expiry a day earlier)
// is kept here and dropped by the study against NSE's own session calendar.
// Output: nifty-expiries-nse.json = { OPTIDX: [...ISO], FUTIDX: [...ISO], fetchedAt }

const fs = require("node:fs");
const path = require("node:path");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const MON = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
const iso = (d) => { const m = String(d).match(/^(\d{2})-([A-Z]{3})-(\d{4})$/); return m ? `${m[3]}-${MON[m[2]]}-${m[1]}` : null; };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const home = await fetch("https://www.nseindia.com/report-detail/fo_eq_security", { headers: { "User-Agent": UA, Accept: "text/html" }, signal: AbortSignal.timeout(20_000) });
  const cookie = (home.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  const out = { source: "https://www.nseindia.com/api/historicalOR/meta/foCPV/expireDts", fetchedAt: new Date().toISOString(), OPTIDX: [], FUTIDX: [] };
  for (const instrument of ["OPTIDX", "FUTIDX"]) {
    for (const year of [2021, 2022, 2023, 2024, 2025, 2026]) {
      const url = `https://www.nseindia.com/api/historicalOR/meta/foCPV/expireDts?instrument=${instrument}&symbol=NIFTY&year=${year}`;
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", Cookie: cookie, Referer: "https://www.nseindia.com/report-detail/fo_eq_security" }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) { console.log(`${instrument} ${year}: HTTP ${res.status} -- stopping`); process.exit(1); }
      const dates = ((await res.json()).expiresDts || []).map(iso).filter(Boolean);
      out[instrument].push(...dates);
      console.log(`${instrument} ${year}: ${dates.length} dates (${dates[0]} .. ${dates[dates.length - 1]})`);
      await pause(3000);
    }
    out[instrument] = [...new Set(out[instrument])].sort();
  }
  fs.writeFileSync(path.join(__dirname, "nifty-expiries-nse.json"), JSON.stringify(out, null, 1));
  console.log(`saved: ${out.OPTIDX.length} option expiries, ${out.FUTIDX.length} futures expiries`);
})().catch((e) => { console.error("failed:", e.message); process.exit(1); });
