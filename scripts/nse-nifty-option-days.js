"use strict";
// NIFTY OPTIONS NEAR EXPIRY, EVERY SESSION, FROM NSE'S OWN F&O BHAVCOPY (owner, 20 Oct 2026: test a friend's
// expiry-day option selling). Keeps NIFTY index options whose expiry is within 8 calendar days of the session, with
// open/high/low/close/settle/OI/contracts, so expiry-day entries and stops can be tested. Counts only; no returns here.
//   node scripts/nse-nifty-option-days.js <out-dir> <from YYYY-MM-DD> <to YYYY-MM-DD>
// Formats (as scripts/nse-fo-history.js): old to 2024-07-05 content/historical/DERIVATIVES/YYYY/MON/foDDMONYYYYbhav.csv.zip,
// new from 2024-07-08 content/fo/BhavCopy_NSE_FO_0_0_0_YYYYMMDD_F_0000.csv.zip. Rows: [expiry, strike, type, open,
// high, low, close, settle, oi, contracts]; the new format also gives the underlying (NIFTY) price per row.
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const monIdx = Object.fromEntries(MON.map((m, i) => [m, String(i + 1).padStart(2, "0")]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const url = (iso) => { const [y, m, d] = iso.split("-"); return iso < "2024-07-08"
  ? `https://nsearchives.nseindia.com/content/historical/DERIVATIVES/${y}/${MON[+m - 1]}/fo${d}${MON[+m - 1]}${y}bhav.csv.zip`
  : `https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_${y}${m}${d}_F_0000.csv.zip`; };
function unzipFirst(buf) { let e = -1; for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i -= 1) if (buf.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error("not a zip"); const cd = buf.readUInt32LE(e + 16); const method = buf.readUInt16LE(cd + 10), size = buf.readUInt32LE(cd + 20), local = buf.readUInt32LE(cd + 42);
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28); const dd = buf.subarray(start, start + size); return method === 0 ? dd : zlib.inflateRawSync(dd); }
const isoOld = (s) => { const [d, m, y] = String(s).split("-"); return `${y}-${monIdx[(m || "").toUpperCase()]}-${String(d).padStart(2, "0")}`; };
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

function parse(text, iso) {
  const lines = text.split(/\r?\n/).filter(Boolean); const head = lines[0].split(",").map((h) => h.trim()); const c = (n) => head.indexOf(n);
  const rows = []; let underlying = null, lot = null;   // lot: NSE's own lot size (new format only)
  if (c("INSTRUMENT") >= 0) {
    for (const l of lines.slice(1)) { const f = l.split(","); if (f[c("INSTRUMENT")] !== "OPTIDX" || f[c("SYMBOL")] !== "NIFTY") continue;
      const exp = isoOld(f[c("EXPIRY_DT")]); if (days(iso, exp) < 0 || days(iso, exp) > 8) continue;
      rows.push([exp, +f[c("STRIKE_PR")], f[c("OPTION_TYP")], +f[c("OPEN")], +f[c("HIGH")], +f[c("LOW")], +f[c("CLOSE")], +f[c("SETTLE_PR")], +f[c("OPEN_INT")], +f[c("CONTRACTS")]]); }
  } else {
    for (const l of lines.slice(1)) { const f = l.split(","); if (f[c("FinInstrmTp")] !== "IDO" || f[c("TckrSymb")] !== "NIFTY") continue;
      const exp = f[c("XpryDt")]; if (days(iso, exp) < 0 || days(iso, exp) > 8) continue;
      if (underlying === null && +f[c("UndrlygPric")] > 0) underlying = +f[c("UndrlygPric")];
      if (lot === null && c("NewBrdLotQty") >= 0 && +f[c("NewBrdLotQty")] > 0) lot = +f[c("NewBrdLotQty")];
      rows.push([exp, +f[c("StrkPric")], f[c("OptnTp")], +f[c("OpnPric")], +f[c("HghPric")], +f[c("LwPric")], +f[c("ClsPric")], +f[c("SttlmPric")], +f[c("OpnIntrst")], +f[c("TtlTradgVol")]]); }
  }
  return { date: iso, underlying, lot, rows };
}

async function main(out, from, to) {
  fs.mkdirSync(out, { recursive: true }); let got = 0, none = 0, err = 0, had = 0;
  for (let d = from; d <= to; d = new Date(Date.parse(d) + 864e5).toISOString().slice(0, 10)) {
    const wd = new Date(`${d}T00:00:00Z`).getUTCDay(); if (wd === 0 || wd === 6) continue;
    const f = path.join(out, `${d}.json.gz`), fn = path.join(out, `${d}.none`); if (fs.existsSync(f) || fs.existsSync(fn)) { had += 1; continue; }
    let r = null; for (let i = 0; i < 3; i += 1) { try { r = await fetch(url(d), { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(60_000) }); break; } catch { await sleep(2000 * (i + 1)); } }
    if (!r) { err += 1; continue; }
    if (r.status === 404) { if (Date.parse(to) - Date.parse(d) > 10 * 864e5) fs.writeFileSync(fn, ""); none += 1; continue; }
    if (!r.ok) { err += 1; continue; }
    try { const p = parse(unzipFirst(Buffer.from(await r.arrayBuffer())).toString("utf8"), d); fs.writeFileSync(f, zlib.gzipSync(JSON.stringify(p))); got += 1; } catch { err += 1; }
    await sleep(300);
  }
  console.log(`nifty option days ${from}..${to}: ${got} saved, ${none} not published (holidays), ${err} errors, ${had} already here`);
}
if (require.main === module) { const [out, from, to] = process.argv.slice(2); main(out, from, to || new Date().toISOString().slice(0, 10)); }
module.exports = { parse };
