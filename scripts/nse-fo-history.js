"use strict";
// NSE's own F&O daily bhavcopy (FUTURES rows only) and the participant-wise open interest file,
// one session at a time, for every session that has an equity bhavcopy in K2_CM_DIR.
//   old format (to 2024-07-05): content/historical/DERIVATIVES/YYYY/MON/foDDMONYYYYbhav.csv.zip
//     INSTRUMENT,SYMBOL,EXPIRY_DT,STRIKE_PR,OPTION_TYP,OPEN,HIGH,LOW,CLOSE,SETTLE_PR,CONTRACTS,VAL_INLAKH,OPEN_INT,CHG_IN_OI,TIMESTAMP
//   new format (from 2024-07-08): content/fo/BhavCopy_NSE_FO_0_0_0_YYYYMMDD_F_0000.csv.zip
//     ...FinInstrmTp (STF/IDF),TckrSymb,XpryDt,...OpnPric,HghPric,LwPric,ClsPric,...SttlmPric,OpnIntrst,ChngInOpnIntrst,TtlTradgVol...
//   participant OI: content/nsccl/fao_participant_oi_DDMMYYYY.csv (Client/DII/FII/Pro, futures and options long/short)
// All three checked on NSE on 3 Oct 2026.
// Output: <K2_FO_DIR>/fut/YYYY-MM-DD.json = [[symbol, "STK"|"IDX", expiryISO, open, high, low, close, settle, oi, chgOi, contracts], ...]
//         <K2_FO_DIR>/part/YYYY-MM-DD.csv (as NSE serves it)
// Gentle: ~1 s apart, stops after 3 failures in a row or at K2_STOP_IST; resumes where it stopped.
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const CM = path.resolve(process.env.K2_CM_DIR || "nse-data/cm");
const OUT = path.resolve(process.env.K2_FO_DIR || "nse-fo");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const SWITCH = "2024-07-08";
const STOP = (process.env.K2_STOP_IST || "23:59").split(":").map(Number);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const LOG = path.join(OUT, "download.log");
const log = (s) => { fs.appendFileSync(LOG, s + "\n"); console.log(s); };
const pastDeadline = () => { const t = new Date(Date.now() + 330 * 60_000); const m = t.getUTCHours() * 60 + t.getUTCMinutes(); return m >= STOP[0] * 60 + STOP[1] && m < 20 * 60; };
const monIdx = Object.fromEntries(MON.map((m, i) => [m, String(i + 1).padStart(2, "0")]));
const isoFromOld = (s) => { const [d, m, y] = s.split("-"); return `${y}-${monIdx[m.toUpperCase()]}-${d.padStart(2, "0")}`; };

function unzipFirst(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i -= 1) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a zip");
  const cd = buf.readUInt32LE(eocd + 16);
  const method = buf.readUInt16LE(cd + 10), size = buf.readUInt32LE(cd + 20), local = buf.readUInt32LE(cd + 42);
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  const data = buf.subarray(start, start + size);
  return method === 0 ? data : zlib.inflateRawSync(data);
}
function parse(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const head = lines[0].split(",").map((h) => h.trim());
  const c = (n) => head.indexOf(n);
  const rows = [];
  if (c("INSTRUMENT") >= 0) {
    for (const l of lines.slice(1)) {
      const f = l.split(",");
      const kind = f[c("INSTRUMENT")] === "FUTSTK" ? "STK" : f[c("INSTRUMENT")] === "FUTIDX" ? "IDX" : null;
      if (!kind) continue;
      rows.push([f[c("SYMBOL")], kind, isoFromOld(f[c("EXPIRY_DT")]), +f[c("OPEN")], +f[c("HIGH")], +f[c("LOW")], +f[c("CLOSE")], +f[c("SETTLE_PR")], +f[c("OPEN_INT")], +f[c("CHG_IN_OI")], +f[c("CONTRACTS")]]);
    }
  } else {
    for (const l of lines.slice(1)) {
      const f = l.split(",");
      const kind = f[c("FinInstrmTp")] === "STF" ? "STK" : f[c("FinInstrmTp")] === "IDF" ? "IDX" : null;
      if (!kind) continue;
      rows.push([f[c("TckrSymb")], kind, f[c("XpryDt")], +f[c("OpnPric")], +f[c("HghPric")], +f[c("LwPric")], +f[c("ClsPric")], +f[c("SttlmPric")], +f[c("OpnIntrst")], +f[c("ChngInOpnIntrst")], +f[c("TtlTradgVol")]]);
    }
  }
  return rows;
}
const foUrl = (iso) => {
  const [y, m, d] = iso.split("-");
  return iso < SWITCH
    ? `https://nsearchives.nseindia.com/content/historical/DERIVATIVES/${y}/${MON[+m - 1]}/fo${d}${MON[+m - 1]}${y}bhav.csv.zip`
    : `https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_${y}${m}${d}_F_0000.csv.zip`;
};
const partUrl = (iso) => { const [y, m, d] = iso.split("-"); return `https://nsearchives.nseindia.com/content/nsccl/fao_participant_oi_${d}${m}${y}.csv`; };
const get = async (url) => fetch(url, { headers: { "User-Agent": UA, Accept: "*/*" }, signal: AbortSignal.timeout(40_000) });

(async () => {
  fs.mkdirSync(path.join(OUT, "fut"), { recursive: true });
  fs.mkdirSync(path.join(OUT, "part"), { recursive: true });
  const sessions = fs.readdirSync(CM).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, 10)).sort();
  const todo = sessions.filter((d) => !fs.existsSync(path.join(OUT, "fut", `${d}.json`)) || !fs.existsSync(path.join(OUT, "part", `${d}.csv`)) && !fs.existsSync(path.join(OUT, "part", `${d}.none`)));
  log(`=== ${new Date().toISOString()} ${todo.length} of ${sessions.length} sessions to fetch`);
  let fails = 0, got = 0;
  for (const d of todo) {
    if (pastDeadline()) { log("STOPPED: deadline"); break; }
    try {
      if (!fs.existsSync(path.join(OUT, "fut", `${d}.json`))) {
        const r = await get(foUrl(d));
        if (!r.ok) throw new Error(`F&O HTTP ${r.status}`);
        const rows = parse(unzipFirst(Buffer.from(await r.arrayBuffer())).toString("utf8"));
        if (rows.length < 100) throw new Error(`only ${rows.length} futures rows`);
        fs.writeFileSync(path.join(OUT, "fut", `${d}.json`), JSON.stringify(rows));
        await pause(700);
      }
      if (!fs.existsSync(path.join(OUT, "part", `${d}.csv`)) && !fs.existsSync(path.join(OUT, "part", `${d}.none`))) {
        const r = await get(partUrl(d));
        if (r.status === 404) fs.writeFileSync(path.join(OUT, "part", `${d}.none`), "");
        else if (!r.ok) throw new Error(`participant HTTP ${r.status}`);
        else fs.writeFileSync(path.join(OUT, "part", `${d}.csv`), await r.text());
      }
      fails = 0; got += 1;
      if (got % 100 === 0) log(`${d}: ${got} sessions done`);
    } catch (e) {
      fails += 1; log(`${d}: FAILED ${e.message} (${fails} in a row)`);
      if (fails >= 3) { log("STOPPED: 3 failures in a row -- run again to resume"); break; }
      await pause(15_000);
    }
    await pause(700);
  }
  log(`done: ${got} sessions this run, ${new Date().toISOString()}`);
})().catch((e) => { log("fatal: " + e.message); process.exit(1); });
