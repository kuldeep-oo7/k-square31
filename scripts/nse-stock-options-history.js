"use strict";
// Stock-option prices from NSE's own F&O bhavcopy (same files as scripts/nse-fo-history.js), compact:
// for each underlying, the two nearest expiries and strikes within +/-12% of that day's CM close.
// Output: <K2_SOPT_DIR>/YYYY-MM-DD.json.gz = gzip(JSON [[sym, expiry, strike, "CE"|"PE", close, settle, oi, volume], ...])
// Needs K2_CM_DIR (the CM bhavcopy archive) for the share's close. Gentle: ~1 s apart; resumes; K2_FROM limits dates.
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const CM = path.resolve(process.env.K2_CM_DIR || "nse-data/cm"), OUT = path.resolve(process.env.K2_SOPT_DIR || "nse-sopt"), FROM = process.env.K2_FROM || "0000";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]; const monIdx = Object.fromEntries(MON.map((m, i) => [m, String(i + 1).padStart(2, "0")]));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
function unzipFirst(buf) { let e = -1; for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i -= 1) if (buf.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error("not a zip"); const cd = buf.readUInt32LE(e + 16); const method = buf.readUInt16LE(cd + 10), size = buf.readUInt32LE(cd + 20), local = buf.readUInt32LE(cd + 42);
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28); const data = buf.subarray(start, start + size); return method === 0 ? data : zlib.inflateRawSync(data); }
const foUrl = (iso) => { const [y, m, d] = iso.split("-"); return iso < "2024-07-08" ? `https://nsearchives.nseindia.com/content/historical/DERIVATIVES/${y}/${MON[+m - 1]}/fo${d}${MON[+m - 1]}${y}bhav.csv.zip` : `https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_${y}${m}${d}_F_0000.csv.zip`; };
function parse(text, spot) {
  const lines = text.split(/\r?\n/).filter(Boolean); const head = lines[0].split(",").map((h) => h.trim()); const c = (n) => head.indexOf(n); const oldF = c("INSTRUMENT") >= 0; const rows = [];
  for (const l of lines.slice(1)) { const f = l.split(",");
    if (oldF) { if (f[c("INSTRUMENT")] !== "OPTSTK") continue; const [dd, mm, yy] = f[c("EXPIRY_DT")].split("-");
      rows.push([f[c("SYMBOL")], `${yy}-${monIdx[mm.toUpperCase()]}-${dd.padStart(2, "0")}`, +f[c("STRIKE_PR")], f[c("OPTION_TYP")], +f[c("CLOSE")], +f[c("SETTLE_PR")], +f[c("OPEN_INT")], +f[c("CONTRACTS")]]); }
    else { if (f[c("FinInstrmTp")] !== "STO") continue; rows.push([f[c("TckrSymb")], f[c("XpryDt")], +f[c("StrkPric")], f[c("OptnTp")], +f[c("ClsPric")], +f[c("SttlmPric")], +f[c("OpnIntrst")], +f[c("TtlTradgVol")]]); } }
  const bySym = new Map(); for (const r of rows) { if (!bySym.has(r[0])) bySym.set(r[0], []); bySym.get(r[0]).push(r); }
  const out = [];
  for (const [sym, rs] of bySym) { const s = spot[sym]; if (!(s > 0)) continue; const ex = [...new Set(rs.map((r) => r[1]))].sort().slice(0, 2);
    for (const r of rs) if (ex.includes(r[1]) && Math.abs(r[2] / s - 1) <= 0.12) out.push(r); }
  return out;
}
(async () => {
  fs.mkdirSync(OUT, { recursive: true }); let fails = 0, done = 0;
  const sessions = fs.readdirSync(CM).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, 10)).filter((d) => d >= FROM).sort();
  console.log(`=== ${new Date().toISOString()} ${sessions.length} sessions`);
  for (const d of sessions) { const file = path.join(OUT, `${d}.json.gz`); if (fs.existsSync(file) || fs.existsSync(file + ".none")) continue;
    try { const r = await fetch(foUrl(d), { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(60000) });
      if (r.status === 404) { fs.writeFileSync(file + ".none", ""); continue; } if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const spot = {}; for (const x of JSON.parse(fs.readFileSync(path.join(CM, `${d}.json`), "utf8"))) if (x[2] === "EQ") spot[x[1]] = x[6];
      const rows = parse(unzipFirst(Buffer.from(await r.arrayBuffer())).toString("utf8"), spot); if (rows.length < 100) throw new Error(`only ${rows.length} rows`);
      fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(rows))); fails = 0; done += 1; if (done % 100 === 0) console.log(`${d}: ${done}`);
    } catch (e) { fails += 1; console.log(`${d}: FAILED ${e.message}`); if (fails >= 3) { console.log("STOPPED"); return; } await pause(15000); }
    await pause(900); }
  console.log(`done ${new Date().toISOString()}`);
})();
