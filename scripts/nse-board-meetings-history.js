"use strict";
// NSE's own board-meeting history, one calendar month per request:
//   https://www.nseindia.com/api/corporate-board-meetings?index=equities&from_date=DD-MM-YYYY&to_date=DD-MM-YYYY
// Checked 4 Oct 2026: not row-capped (Oct 2021: 732 rows; Jul-Aug 2025: 4,952), fields bm_symbol, bm_date,
// bm_purpose, bm_desc, bm_timestamp. Gentle: 4 s apart with the page's cookie; resumes.
// Output: <K2_BM_DIR>/YYYY-MM.json
const fs = require("node:fs");
const path = require("node:path");
const OUT = path.resolve(process.env.K2_BM_DIR || "nse-board-meetings");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const REF = "https://www.nseindia.com/companies-listing/corporate-filings-board-meetings";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, "0");
const cookie = async () => { const r = await fetch(REF, { headers: { "User-Agent": UA, Accept: "text/html" }, signal: AbortSignal.timeout(20000) }); return (r.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; "); };
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const months = []; for (let y = 2020, m = 8; y < 2026 || (y === 2026 && m <= 10); m === 12 ? (y += 1, m = 1) : (m += 1)) months.push([y, m]);
  let ck = await cookie(), fails = 0;
  for (const [y, m] of months) {
    const file = path.join(OUT, `${y}-${pad(m)}.json`); if (fs.existsSync(file)) continue;
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    try {
      const r = await fetch(`https://www.nseindia.com/api/corporate-board-meetings?index=equities&from_date=01-${pad(m)}-${y}&to_date=${last}-${pad(m)}-${y}`, { headers: { "User-Agent": UA, Accept: "application/json", Referer: REF, Cookie: ck }, signal: AbortSignal.timeout(40000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`); const j = await r.json(); const d = Array.isArray(j) ? j : j.data; if (!Array.isArray(d)) throw new Error("no array");
      fs.writeFileSync(file, JSON.stringify(d.map((x) => [x.bm_symbol, x.bm_date, x.bm_purpose, x.bm_timestamp, x.sm_indusrty]))); console.log(`${y}-${pad(m)}: ${d.length}`); fails = 0;
    } catch (e) { fails += 1; console.log(`${y}-${pad(m)}: FAILED ${e.message}`); if (fails >= 3) { console.log("STOPPED"); return; } await pause(20000); ck = await cookie(); }
    await pause(4000);
  }
  console.log("done");
})();
