"use strict";
// Two NSE archives per session (every session with a CM file in K2_CM_DIR), checked on NSE 4 Oct 2026:
//  1. Delivery: products/content/sec_bhavdata_full_DDMMYYYY.csv
//     (SYMBOL, SERIES, ..., TTL_TRD_QNTY, ..., DELIV_QTY, DELIV_PER)  -> deliv/YYYY-MM-DD.json = {SYM: [qty, delivQty, delivPct]} (EQ only)
//  2. F&O options (same files as scripts/nse-fo-history.js), aggregated:
//     opt/YYYY-MM-DD.json = { oi: {UNDERLYING: [callOI, putOI, callVolume, putVolume]},
//                             idx: {NIFTY|BANKNIFTY: [[expiry, strike, "CE"|"PE", close, settle, oi], ...] for the two nearest expiries} }
// Gentle: ~1 s apart, stops after 3 failures in a row, resumes.
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const CM = path.resolve(process.env.K2_CM_DIR || "nse-data/cm");
const OUT = path.resolve(process.env.K2_OUT_DIR || "nse-extra");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const monIdx = Object.fromEntries(MON.map((m, i) => [m, String(i + 1).padStart(2, "0")]));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (u) => fetch(u, { headers: { "User-Agent": UA, Accept: "*/*" }, signal: AbortSignal.timeout(40000) });
function unzipFirst(buf) { let e = -1; for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i -= 1) if (buf.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error("not a zip"); const cd = buf.readUInt32LE(e + 16); const method = buf.readUInt16LE(cd + 10), size = buf.readUInt32LE(cd + 20), local = buf.readUInt32LE(cd + 42);
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28); const data = buf.subarray(start, start + size); return method === 0 ? data : zlib.inflateRawSync(data); }
const foUrl = (iso) => { const [y, m, d] = iso.split("-"); return iso < "2024-07-08" ? `https://nsearchives.nseindia.com/content/historical/DERIVATIVES/${y}/${MON[+m - 1]}/fo${d}${MON[+m - 1]}${y}bhav.csv.zip` : `https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_${y}${m}${d}_F_0000.csv.zip`; };
const delivUrl = (iso) => { const [y, m, d] = iso.split("-"); return `https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_${d}${m}${y}.csv`; };

function parseOptions(text) {
  const lines = text.split(/\r?\n/).filter(Boolean); const head = lines[0].split(",").map((h) => h.trim()); const c = (n) => head.indexOf(n);
  const oldF = c("INSTRUMENT") >= 0; const rows = [];
  for (const l of lines.slice(1)) { const f = l.split(",");
    if (oldF) { const ins = f[c("INSTRUMENT")]; if (ins !== "OPTIDX" && ins !== "OPTSTK") continue;
      const [dd, mm, yy] = f[c("EXPIRY_DT")].split("-"); rows.push([f[c("SYMBOL")], `${yy}-${monIdx[mm.toUpperCase()]}-${dd.padStart(2, "0")}`, +f[c("STRIKE_PR")], f[c("OPTION_TYP")], +f[c("CLOSE")], +f[c("SETTLE_PR")], +f[c("OPEN_INT")], +f[c("CONTRACTS")]]); }
    else { const t = f[c("FinInstrmTp")]; if (t !== "IDO" && t !== "STO") continue;
      rows.push([f[c("TckrSymb")], f[c("XpryDt")], +f[c("StrkPric")], f[c("OptnTp")], +f[c("ClsPric")], +f[c("SttlmPric")], +f[c("OpnIntrst")], +f[c("TtlTradgVol")]]); } }
  const oi = {}; for (const [u, , , typ, , , o, v] of rows) { const a = (oi[u] ||= [0, 0, 0, 0]); if (typ === "CE") { a[0] += o; a[2] += v; } else { a[1] += o; a[3] += v; } }
  const idx = {}; for (const u of ["NIFTY", "BANKNIFTY"]) { const ex = [...new Set(rows.filter((r) => r[0] === u).map((r) => r[1]))].sort().slice(0, 2);
    idx[u] = rows.filter((r) => r[0] === u && ex.includes(r[1])).map((r) => [r[1], r[2], r[3], r[4], r[5], r[6]]); }
  return { oi, idx };
}
function parseDeliv(text) { const lines = text.split(/\r?\n/).filter(Boolean); const head = lines[0].split(",").map((h) => h.trim()); const c = (n) => head.indexOf(n); const out = {};
  for (const l of lines.slice(1)) { const f = l.split(",").map((x) => x.trim()); if (f[c("SERIES")] !== "EQ") continue; out[f[c("SYMBOL")]] = [+f[c("TTL_TRD_QNTY")], +f[c("DELIV_QTY")], +f[c("DELIV_PER")]]; } return out; }

(async () => {
  for (const sub of ["deliv", "opt"]) fs.mkdirSync(path.join(OUT, sub), { recursive: true });
  const FROM = process.env.K2_FROM || "0000";   // only sessions on or after this date (the daily job needs the last few)
  const sessions = fs.readdirSync(CM).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, 10)).filter((d) => d >= FROM).sort();
  let fails = 0, done = 0;
  console.log(`=== ${new Date().toISOString()} ${sessions.length} sessions`);
  for (const d of sessions) {
    try {
      const df = path.join(OUT, "deliv", `${d}.json`);
      if (!fs.existsSync(df) && !fs.existsSync(df + ".none")) { const r = await get(delivUrl(d));
        if (r.status === 404) fs.writeFileSync(df + ".none", ""); else if (!r.ok) throw new Error(`deliv HTTP ${r.status}`); else fs.writeFileSync(df, JSON.stringify(parseDeliv(await r.text())));
        await pause(800); }
      const of = path.join(OUT, "opt", `${d}.json`);
      if (!fs.existsSync(of) && !fs.existsSync(of + ".none")) { const r = await get(foUrl(d));
        if (r.status === 404) fs.writeFileSync(of + ".none", ""); else if (!r.ok) throw new Error(`fo HTTP ${r.status}`); else fs.writeFileSync(of, JSON.stringify(parseOptions(unzipFirst(Buffer.from(await r.arrayBuffer())).toString("utf8"))));
        await pause(800); }
      fails = 0; done += 1; if (done % 100 === 0) console.log(`${d}: ${done}`);
    } catch (e) { fails += 1; console.log(`${d}: FAILED ${e.message}`); if (fails >= 3) { console.log("STOPPED"); return; } await pause(15000); }
  }
  console.log(`done ${new Date().toISOString()}`);
})();
