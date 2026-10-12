"use strict";
// Raw NSE daily files for the data-atlas study (studies/nse-data-atlas-2026-10-11/ATLAS.md, sections B and C).
// One request at a time (NSE throttles parallel downloads), skips what it has, 404 -> <date>.none, resumes.
//   K2_ATLAS_DIR=research/nse-atlas K2_FROM=2020-09-01 K2_TO=2026-10-09 node scripts/nse-atlas-download.js [name ...]
const fs = require("node:fs");
const path = require("node:path");
const A = "https://nsearchives.nseindia.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const parts = (d) => { const [y, m, dd] = d.split("-"); return { y, m, dd, yy: y.slice(2), mon: MON[+m - 1] }; };
// name -> [url for date, extension]; paths are the ones NSE's own daily-reports list gives (11 Oct 2026)
const SETS = {
  part_vol: [(p) => `${A}/content/nsccl/fao_participant_vol_${p.dd}${p.m}${p.y}.csv`, "csv"],
  fii_stats: [(p) => `${A}/content/fo/fii_stats_${p.dd}-${p.mon}-${p.y}.xls`, "xls"],
  shortselling: [(p) => `${A}/archives/equities/shortSelling/shortselling_${p.dd}${p.m}${p.y}.csv`, "csv"],
  slb_openpos: [(p) => `${A}/archives/slbs/open_pos/slb_openpos_${p.dd}${p.m}${p.y}.csv`, "csv"],
  // SLB bhavcopy: each lending series' fee (Rs per share for the contract's remaining tenure, NSE Clearing SLB FAQ),
  // quantity, value and trades; for the loan-fee study (studies/research-open-source-2026-10-12, L1). Checked 12 Oct 2026:
  // the 2021 files are still served.
  slbm_bc: [(p) => `${A}/archives/slbs/bhavcopy/SLBM_BC_${p.dd}${p.m}${p.y}.DAT`, "dat"],
  combineoi: [(p) => `${A}/archives/nsccl/mwpl/combineoi_${p.dd}${p.m}${p.y}.zip`, "zip"],
  cmvolt: [(p) => `${A}/archives/nsccl/volt/CMVOLT_${p.dd}${p.m}${p.y}.CSV`, "csv"],
  fovolt: [(p) => `${A}/archives/nsccl/volt/FOVOLT_${p.dd}${p.m}${p.y}.csv`, "csv"],
  market_activity: [(p) => `${A}/archives/equities/mkt/MA${p.dd}${p.m}${p.yy}.csv`, "csv"],
  mwpl_cli: [(p) => `${A}/content/nsccl/mwpl_cli_${p.dd}${p.m}${p.y}.xls`, "xls"],
  cat_turnover: [(p) => `${A}/archives/fo/cat/fo_cat_turnover_${p.dd}${p.m}${p.yy}.xls`, "xls"],
  top10cm: [(p) => `${A}/content/nsccl/fao_top10cm_to_${p.dd}${p.m}${p.y}.csv`, "csv"],
  mrg_trading: [(p) => `${A}/content/equities/mrg_trading_${p.dd}${p.m}${p.yy}.zip`, "zip"],
  deleq: [(p) => `${A}/archives/nsccl/mwpl/combineoi_deleq_${p.dd}${p.m}${p.y}.csv`, "csv"],
  reg_ind: [(p) => `${A}/content/cm/REG_IND${p.dd}${p.m}${p.yy}.csv`, "csv"],
  // cash-market buy/sell by category (FPI, MF, insurance, banks, retail, AIF, PMS...), from 2020-09; found 11 Oct
  // in NSE's archived-report list (api/merged-daily-reports?key=favCapital), not in the daily-reports list
  cm_cat_turnover: [(p) => `${A}/archives/equities/cat/cat_turnover_${p.dd}${p.m}${p.yy}.xls`, "xls"],
  // every NSE index, every column: open/high/low/close, volume, turnover, P/E, P/B, dividend yield (from 2020)
  ind_close_all: [(p) => `${A}/content/indices/ind_close_all_${p.dd}${p.m}${p.y}.csv`, "csv"]
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const root = path.resolve(process.env.K2_ATLAS_DIR || "research/nse-atlas");
  const FROM = process.env.K2_FROM || "2020-09-01", TO = process.env.K2_TO || new Date(Date.now() + 330 * 60000 - 864e5).toISOString().slice(0, 10);
  const days = []; for (let t = Date.parse(`${FROM}T00:00:00Z`); t <= Date.parse(`${TO}T00:00:00Z`); t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) days.push(d.toISOString().slice(0, 10)); }
  const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SETS);
  for (const name of names) {
    const [url, ext] = SETS[name]; const dir = path.join(root, name); fs.mkdirSync(dir, { recursive: true });
    const todo = days.filter((d) => !fs.existsSync(path.join(dir, `${d}.${ext}`)) && !fs.existsSync(path.join(dir, `${d}.none`)));
    console.log(`=== ${new Date().toISOString()} ${name}: ${todo.length} of ${days.length} days to fetch`);
    let got = 0, none = 0, fails = 0;
    for (const d of todo) {
      let ok = false;
      for (let attempt = 1; attempt <= 3 && !ok; attempt += 1) {
        try {
          const r = await fetch(url(parts(d)), { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(45000) });
          if (r.status === 404) { fs.writeFileSync(path.join(dir, `${d}.none`), ""); none += 1; ok = true; break; }
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const buf = Buffer.from(await r.arrayBuffer()); if (buf.length === 0) throw new Error("empty");   // NSE's "No records." (12 bytes) is a real answer: kept
          fs.writeFileSync(path.join(dir, `${d}.${ext}`), buf); got += 1; ok = true;
        } catch (e) { if (attempt === 3) console.log(`${name} ${d}: FAILED ${e.message}`); await pause(5000 * attempt); }
      }
      fails = ok ? 0 : fails + 1; if (fails >= 10) { console.log(`${name}: STOPPED after 10 failures in a row -- resume later`); break; }
      await pause(600);
    }
    console.log(`${name}: ${got} saved, ${none} not on NSE (404)`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
