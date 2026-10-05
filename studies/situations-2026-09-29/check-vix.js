"use strict";
// Yahoo's India VIX history against NSE's own (historicalOR/vixhistory), for September 2026.
// Yahoo's LAST bar read 13.41 on 29 Sep while NSE's allIndices said 13.32.
const fs = require("node:fs");
const path = require("node:path");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
(async () => {
  const home = await fetch("https://www.nseindia.com/reports-indices-historical-vix", { headers: { "User-Agent": UA, Accept: "text/html" }, signal: AbortSignal.timeout(20_000) });
  const cookie = (home.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  const url = "https://www.nseindia.com/api/historicalOR/vixhistory?from=01-08-2026&to=29-09-2026";
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", Cookie: cookie, Referer: "https://www.nseindia.com/reports-indices-historical-vix" }, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  let j = null; try { j = JSON.parse(text); } catch { console.log(res.status, text.slice(0, 300)); return; }
  const rows = j.data || [];
  if (rows.length) console.log("fields:", Object.keys(rows[0]).join(", "));
  const yahoo = new Map(JSON.parse(fs.readFileSync(path.join(__dirname, "yahoo-indiavix.json"), "utf8")).rows);
  let same = 0, diff = [];
  for (const r of rows) {
    // "03-Aug-2026", read as a calendar date (Date.parse would read it at local midnight).
    const MON = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
    const m = String(r.EOD_TIMESTAMP).match(/^(\d{2})-([A-Za-z]{3})-(\d{4})$/);
    const mon = m ? MON[m[2].charAt(0).toUpperCase() + m[2].slice(1).toLowerCase()] : null;
    const day = m && mon ? `${m[3]}-${mon}-${m[1]}` : null;
    const nse = Number(r.EOD_CLOSE_INDEX_VAL ?? r.CLOSE ?? r.close);
    const y = yahoo.get(day);
    if (y === undefined) { diff.push(`${day}: NSE ${nse}, Yahoo none`); continue; }
    if (Math.abs(y - nse) < 0.011) same += 1; else diff.push(`${day}: NSE ${nse}, Yahoo ${y}`);
  }
  console.log(`${rows.length} NSE sessions; ${same} identical to Yahoo; ${diff.length} differ:`);
  for (const x of diff) console.log("  " + x);
})().catch((e) => console.error("failed:", e.message));
