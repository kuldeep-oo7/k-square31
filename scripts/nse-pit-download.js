"use strict";
// NSE insider-trading disclosures (SEBI PIT): www.nseindia.com/api/corporates-pit, one file per month,
// <dir>/pit/YYYY-MM.json = NSE's rows as served (who, buy/sell, mode incl. pledges, value, and "date" = when
// NSE broadcast it). Resumes; the current and previous month are always re-fetched (late filings).
//   K2_ATLAS_DIR=research/nse-atlas K2_FROM=2020-09 node scripts/nse-pit-download.js
const fs = require("node:fs");
const path = require("node:path");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, "0");

async function cookie() {
  const r = await fetch("https://www.nseindia.com/", { headers: { "User-Agent": UA } });
  return (r.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
}

async function main() {
  const dir = path.join(path.resolve(process.env.K2_ATLAS_DIR || "research/nse-atlas"), "pit"); fs.mkdirSync(dir, { recursive: true });
  const [fy, fm] = (process.env.K2_FROM || "2020-09").split("-").map(Number);
  const now = new Date(Date.now() + 330 * 60000); const ny = now.getUTCFullYear(), nm = now.getUTCMonth() + 1;
  const months = []; for (let y = fy, m = fm; y < ny || (y === ny && m <= nm); m === 12 ? (y += 1, m = 1) : (m += 1)) months.push([y, m]);
  const recent = new Set(months.slice(-2).map(([y, m]) => `${y}-${pad(m)}`));
  let ck = await cookie(), fails = 0;
  for (const [y, m] of months) {
    const key = `${y}-${pad(m)}`, file = path.join(dir, `${key}.json`);
    if (fs.existsSync(file) && !recent.has(key)) continue;
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const url = `https://www.nseindia.com/api/corporates-pit?index=equities&from_date=01-${pad(m)}-${y}&to_date=${last}-${pad(m)}-${y}`;
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", Referer: "https://www.nseindia.com/companies-listing/corporate-filings-insider-trading", Cookie: ck }, signal: AbortSignal.timeout(90000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json(); const rows = Array.isArray(j) ? j : j.data; if (!Array.isArray(rows)) throw new Error("no rows array");
      fs.writeFileSync(file, JSON.stringify(rows)); console.log(`pit ${key}: ${rows.length} filings`); fails = 0;
    } catch (e) { fails += 1; console.log(`pit ${key}: FAILED ${e.message}`); if (fails >= 4) { console.log("pit: STOPPED -- resume later"); return; } await pause(20000); ck = await cookie(); }
    await pause(3000);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
