"use strict";
// NSE's own bulk and block deal history, one calendar month per request, from
//   https://www.nseindia.com/api/historicalOR/bulk-block-short-deals?optionType=bulk_deals|block_deals&from=DD-MM-YYYY&to=DD-MM-YYYY
// (checked 4 Oct 2026: returns {"data":[{BD_DT_DATE, BD_SYMBOL, BD_CLIENT_NAME, BD_BUY_SELL, BD_QTY_TRD, BD_TP_WATP, ...}]}).
// Gentle: one request every 4 s with the page's cookie; stops after 3 failures; resumes.
// Output: <K2_DEALS_DIR>/<bulk|block>-YYYY-MM.json
const fs = require("node:fs");
const path = require("node:path");
const OUT = path.resolve(process.env.K2_DEALS_DIR || "nse-deals");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const REF = "https://www.nseindia.com/report-detail/display-bulk-and-block-deals";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, "0");

async function cookie() {
  const r = await fetch(REF, { headers: { "User-Agent": UA, Accept: "text/html" }, signal: AbortSignal.timeout(20000) });
  return (r.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
}
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const months = []; for (let y = 2020, m = 9; y < 2026 || (y === 2026 && m <= 10); m === 12 ? (y += 1, m = 1) : (m += 1)) months.push([y, m]);
  let ck = await cookie(), fails = 0;
  for (const kind of ["bulk", "block"]) for (const [y, m] of months) {
    const file = path.join(OUT, `${kind}-${y}-${pad(m)}.json`); if (fs.existsSync(file)) continue;
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const url = `https://www.nseindia.com/api/historicalOR/bulk-block-short-deals?optionType=${kind}_deals&from=01-${pad(m)}-${y}&to=${last}-${pad(m)}-${y}`;
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", Referer: REF, Cookie: ck }, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json(); if (!Array.isArray(j.data)) throw new Error("no data array");
      fs.writeFileSync(file, JSON.stringify(j.data)); console.log(`${kind} ${y}-${pad(m)}: ${j.data.length}`); fails = 0;
    } catch (e) { fails += 1; console.log(`${kind} ${y}-${pad(m)}: FAILED ${e.message}`); if (fails >= 3) { console.log("STOPPED"); return; } await pause(20000); ck = await cookie(); }
    await pause(4000);
  }
  console.log("done");
})();
