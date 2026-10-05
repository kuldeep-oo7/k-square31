"use strict";
// NSE's own daily F&O ban list: archives/fo/sec_ban/fo_secban_DDMMYYYY.csv (checked 4 Oct 2026; "NIL" when empty).
// Output: <K2_BAN_DIR>/bans.json = { "YYYY-MM-DD": ["SYM", ...] } for every session in K2_CM_DIR. Resumes.
const fs = require("node:fs");
const path = require("node:path");
const CM = path.resolve(process.env.K2_CM_DIR || "nse-data/cm"), OUT = path.resolve(process.env.K2_BAN_DIR || "nse-ban");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  fs.mkdirSync(OUT, { recursive: true }); const file = path.join(OUT, "bans.json"); const bans = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {}; let fails = 0, n = 0;
  for (const d of fs.readdirSync(CM).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, 10)).sort()) { if (d in bans) continue; const [y, m, dd] = d.split("-");
    try { const r = await fetch(`https://nsearchives.nseindia.com/archives/fo/sec_ban/fo_secban_${dd}${m}${y}.csv`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30000) });
      if (r.status === 404) { bans[d] = null; } else if (!r.ok) throw new Error(`HTTP ${r.status}`);
      else { const t = await r.text(); bans[d] = /:\s*NIL/i.test(t) ? [] : t.split(/\r?\n/).slice(1).map((l) => l.split(",")[1]).filter(Boolean).map((s) => s.trim()); }
      fails = 0; n += 1; if (n % 100 === 0) { fs.writeFileSync(file, JSON.stringify(bans)); console.log(`${d}: ${n}`); }
    } catch (e) { fails += 1; console.log(`${d}: FAILED ${e.message}`); if (fails >= 3) break; await pause(10000); }
    await pause(400); }
  fs.writeFileSync(file, JSON.stringify(bans)); console.log(`done ${Object.keys(bans).length} sessions`);
})();
