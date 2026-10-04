"use strict";
// NSE's own daily equity bhavcopy, every trading day 2020-09-01 .. 2026-09-29, every stock
// (series EQ, BE, BZ), from NSE's archive. One file per day covers the whole market, including
// companies later delisted, so the study has no survivorship filter built into its data.
//   old format (to 2024-07-05): content/historical/EQUITIES/YYYY/MON/cmDDMONYYYYbhav.csv.zip
//   new format (from 2024-07-08): content/cm/BhavCopy_NSE_CM_0_0_0_YYYYMMDD_F_0000.csv.zip
// (switch measured 30 Sep 2026: old 200 on 05 Jul 2024, 404 from 08 Jul; new 200 throughout.)
// Output: cm/YYYY-MM-DD.json = [[isin, symbol, series, open, high, low, close, prevClose, volume, value], ...]
// Gentle: one file at a time, ~1 s apart; stops by itself at K2_STOP_IST (default 07:00 IST) or after 3 failures in a row
// (a 404 on a weekday is a holiday or a missing file and is logged, not a failure). Resumes.

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const OUT = path.join(__dirname, "cm");
const LOG = path.join(__dirname, "download.log");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const FROM = process.argv[2] || "2020-09-01", TO = process.argv[3] || "2026-09-29";
const SWITCH = "2024-07-08";
const SERIES = new Set(["EQ", "BE", "BZ"]);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => { fs.appendFileSync(LOG, s + "\n"); console.log(s); };
const istMinutes = () => { const t = new Date(Date.now() + 330 * 60_000); return t.getUTCHours() * 60 + t.getUTCMinutes(); };
const STOP = (process.env.K2_STOP_IST || "07:00").split(":").map(Number);
const pastDeadline = () => { const m = istMinutes(); return m >= STOP[0] * 60 + STOP[1] && m < 20 * 60; };

function unzipFirst(buf) {
  // End of central directory -> first central entry -> local header -> raw deflate data.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i -= 1) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a zip (no end record)");
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt32LE(cdOffset) !== 0x02014b50) throw new Error("bad central directory");
  const method = buf.readUInt16LE(cdOffset + 10);
  const compSize = buf.readUInt32LE(cdOffset + 20);
  const localOffset = buf.readUInt32LE(cdOffset + 42);
  if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("bad local header");
  const nameLen = buf.readUInt16LE(localOffset + 26), extraLen = buf.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + compSize);
  return method === 0 ? data : zlib.inflateRawSync(data);
}

function parse(text, iso) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const head = lines[0].split(",").map((h) => h.trim());
  const col = (name) => head.indexOf(name);
  const oldFmt = col("SYMBOL") >= 0;
  const c = oldFmt
    ? { isin: col("ISIN"), sym: col("SYMBOL"), ser: col("SERIES"), o: col("OPEN"), h: col("HIGH"), l: col("LOW"), cl: col("CLOSE"), pc: col("PREVCLOSE"), v: col("TOTTRDQTY"), val: col("TOTTRDVAL") }
    : { isin: col("ISIN"), sym: col("TckrSymb"), ser: col("SctySrs"), o: col("OpnPric"), h: col("HghPric"), l: col("LwPric"), cl: col("ClsPric"), pc: col("PrvsClsgPric"), v: col("TtlTradgVol"), val: col("TtlTrfVal") };
  if (Object.values(c).some((i) => i < 0)) throw new Error(`${iso}: unexpected columns ${head.slice(0, 14).join(",")}`);
  const rows = [];
  for (const line of lines.slice(1)) {
    const f = line.split(",");
    const series = (f[c.ser] || "").trim();
    if (!SERIES.has(series)) continue;
    const num = (i) => { const x = Number(f[i]); return Number.isFinite(x) ? x : null; };
    rows.push([(f[c.isin] || "").trim(), (f[c.sym] || "").trim(), series, num(c.o), num(c.h), num(c.l), num(c.cl), num(c.pc), num(c.v), num(c.val)]);
  }
  return rows;
}

function urlFor(iso) {
  const [y, m, d] = iso.split("-");
  return iso < SWITCH
    ? `https://nsearchives.nseindia.com/content/historical/EQUITIES/${y}/${MON[Number(m) - 1]}/cm${d}${MON[Number(m) - 1]}${y}bhav.csv.zip`
    : `https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_${y}${m}${d}_F_0000.csv.zip`;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const nseSessions = new Set(JSON.parse(fs.readFileSync(path.join(__dirname, "..", "gap-filter-2026-09-29", "nifty-50-nse.json"), "utf8")).rows.map((r) => r.date));
  const days = [];
  for (let t = Date.parse(`${FROM}T00:00:00Z`); t <= Date.parse(`${TO}T00:00:00Z`); t += 86_400_000) {
    const d = new Date(t);
    const iso = d.toISOString().slice(0, 10);
    // weekends only when NSE held a session (Muhurat, budget days, special Saturday sessions)
    if ((d.getUTCDay() === 0 || d.getUTCDay() === 6) && !nseSessions.has(iso)) continue;
    days.push(iso);
  }
  const todo = days.filter((iso) => !fs.existsSync(path.join(OUT, `${iso}.json`)) && !fs.existsSync(path.join(OUT, `${iso}.none`)));
  log(`=== ${new Date().toISOString()} ${todo.length} of ${days.length} days to fetch (${FROM} .. ${TO}), stop at ${STOP.join(":")} IST`);
  let failures = 0, got = 0, none = 0;
  for (const iso of todo) {
    if (pastDeadline()) { log(`STOPPED: ${STOP.join(":")} IST deadline`); break; }
    try {
      const res = await fetch(urlFor(iso), { headers: { "User-Agent": UA, Accept: "*/*" }, signal: AbortSignal.timeout(30_000) });
      if (res.status === 404) {
        fs.writeFileSync(path.join(OUT, `${iso}.none`), "");
        none += 1;
        if (nseSessions.has(iso)) log(`${iso}: 404 but NSE's NIFTY history has a session that day -- MISSING FILE`);
        failures = 0;
      } else if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      } else {
        const rows = parse(unzipFirst(Buffer.from(await res.arrayBuffer())).toString("utf8"), iso);
        if (rows.length < 500) throw new Error(`only ${rows.length} rows`);
        fs.writeFileSync(path.join(OUT, `${iso}.json`), JSON.stringify(rows));
        got += 1;
        failures = 0;
        if (got % 50 === 0) log(`${iso}: ${rows.length} rows (${got} files so far)`);
      }
    } catch (error) {
      failures += 1;
      log(`${iso}: FAILED ${error.message} (${failures} in a row)`);
      if (failures >= 3) { log("STOPPED: 3 failures in a row -- resume later"); break; }
      await pause(10_000);
    }
    await pause(1000);
  }
  log(`done: ${got} files saved, ${none} weekdays without a file (holidays), ${new Date().toISOString()}`);
})().catch((e) => { log("fatal: " + e.message); process.exit(1); });
