"use strict";
// MACRO POD, STEP 0: HOW FAR BACK DOES EACH OFFICIAL SOURCE GO? (counts only; no returns are computed)
// For each candidate input, ask the publisher for sample days across the years and record status and size. Decides
// whether a macro rule can be backtested over ~15 years (needed for t >= 3) or can only be watched forward.
//   node scripts/macro-data-inventory.js > inventory.txt
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
const A = "https://nsearchives.nseindia.com";
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const parts = (iso) => { const [y, m, d] = iso.split("-"); return { y, yy: y.slice(2), m, dd: d, mon: MON[+m - 1], MON: MON[+m - 1].toUpperCase() }; };
// mid-month Wednesdays (trading days in most years); a 404 on one day is retried on the next two days
const DAYS = ["2008-01-16", "2010-01-13", "2012-01-18", "2014-01-15", "2016-01-13", "2018-01-17", "2020-01-15", "2022-01-12", "2024-01-17", "2026-01-14"];
const next = (iso, k) => new Date(Date.parse(iso) + k * 864e5).toISOString().slice(0, 10);

const NSE = {
  "F&O participant-wise open interest (FII/DII/PRO/CLIENT)": (p) => `${A}/content/nsccl/fao_participant_oi_${p.dd}${p.m}${p.y}.csv`,
  "F&O participant-wise volumes": (p) => `${A}/content/nsccl/fao_participant_vol_${p.dd}${p.m}${p.y}.csv`,
  "FII derivatives statistics": (p) => `${A}/content/fo/fii_stats_${p.dd}-${p.mon}-${p.y}.xls`,
  "Cash category-wise turnover (FPI/MF/retail)": (p) => `${A}/archives/equities/cat/cat_turnover_${p.dd}${p.m}${p.yy}.xls`,
  "Index closes incl. India VIX and NIFTY P/E": (p) => `${A}/content/indices/ind_close_all_${p.dd}${p.m}${p.y}.csv`
};
async function probe(url, opts = {}) {
  try { const r = await fetch(url, { headers: { "User-Agent": UA, ...(opts.headers || {}) }, signal: AbortSignal.timeout(25_000) });
    const b = r.ok ? Buffer.from(await r.arrayBuffer()) : null; return { status: r.status, bytes: b ? b.length : 0, head: b ? b.subarray(0, 120).toString("latin1").replace(/\s+/g, " ") : "" };
  } catch (e) { return { status: "ERR", bytes: 0, head: String(e.message || e).slice(0, 80) }; }
}

(async () => {
  console.log(`MACRO DATA INVENTORY, run ${new Date().toISOString()} (counts only; no returns)\n`);
  for (const [name, fn] of Object.entries(NSE)) {
    console.log(`== NSE: ${name}`);
    for (const day of DAYS) { let got = null, used = day;
      for (let k = 0; k < 3 && !(got && got.status === 200); k += 1) { used = next(day, k); got = await probe(fn(parts(used))); await new Promise((r) => setTimeout(r, 400)); }
      console.log(`  ${used}: ${got.status} ${got.bytes} B`); }
  }
  const OTHER = {
    "FRED US 10y Treasury yield (DGS10)": "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10",
    "FRED broad US dollar index (DTWEXBGS)": "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DTWEXBGS",
    "FRED INR per USD, daily (DEXINUS)": "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DEXINUS",
    "FRED India 10y bond yield, monthly (INDIRLTLT01STM)": "https://fred.stlouisfed.org/graph/fredgraph.csv?id=INDIRLTLT01STM",
    "NSDL FPI monitor, daily investment page": "https://www.fpi.nsdl.co.in/web/Reports/Latest.aspx",
    "NSDL FPI archive page": "https://www.fpi.nsdl.co.in/web/Reports/Archive.aspx",
    "RBI DBIE portal": "https://data.rbi.org.in/DBIE/",
    "RBI money market operations press releases": "https://www.rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx"
  };
  for (const [name, url] of Object.entries(OTHER)) {
    const r = await probe(url); let span = "";
    if (r.status === 200 && url.includes("fredgraph.csv")) { const t = await (await fetch(url, { headers: { "User-Agent": UA } })).text(); const rows = t.trim().split(/\r?\n/).slice(1).filter((l) => !/,\.?$/.test(l));
      span = ` rows ${rows.length}, ${rows[0]?.split(",")[0]} .. ${rows.at(-1)?.split(",")[0]}`; }
    console.log(`== ${name}: ${r.status} ${r.bytes} B${span}`);
  }
})();
