"use strict";
// NSE's own daily index file, content/indices/ind_close_all_DDMMYYYY.csv (checked 4 Oct 2026: "Nifty 50" closed
// 22,421.95 on 1 Oct 2026), for every session in K2_CM_DIR on or after K2_FROM.
// Output: <K2_IDX_DIR>/YYYY-MM-DD.json = { "Nifty 50": [open, high, low, close], "Nifty Bank": [...] }
const fs = require("node:fs");
const path = require("node:path");
const CM = path.resolve(process.env.K2_CM_DIR || "nse-data/cm"), OUT = path.resolve(process.env.K2_IDX_DIR || "nse-idx"), FROM = process.env.K2_FROM || "0000";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  fs.mkdirSync(OUT, { recursive: true }); let fails = 0;
  for (const d of fs.readdirSync(CM).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, 10)).filter((x) => x >= FROM).sort()) {
    const file = path.join(OUT, `${d}.json`); if (fs.existsSync(file)) continue; const [y, m, dd] = d.split("-");
    try { const r = await fetch(`https://nsearchives.nseindia.com/content/indices/ind_close_all_${dd}${m}${y}.csv`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`); const out = {};
      for (const line of (await r.text()).split(/\r?\n/).slice(1)) { const f = line.split(","); if (["Nifty 50", "Nifty Bank", "Nifty Financial Services", "Nifty Midcap Select", "Nifty Next 50"].includes(f[0])) out[f[0]] = [+f[2], +f[3], +f[4], +f[5]]; }
      if (!out["Nifty 50"]) throw new Error("no Nifty 50 row"); fs.writeFileSync(file, JSON.stringify(out)); fails = 0;
    } catch (e) { fails += 1; console.log(`${d}: FAILED ${e.message}`); if (fails >= 3) { console.log("STOPPED"); return; } }
    await pause(800);
  }
  console.log("index closes done");
})();
