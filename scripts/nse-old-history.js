"use strict";
// NSE's own OLD daily files (default 2005-01-01 .. 2020-10-31), fetched ONCE per day and written in the
// formats the forward paper-test code already reads (studies/oos-replication-2026-10-05):
//   cm/YYYY-MM-DD.json    = scripts/nse-cm-bhavcopy.js rows [isin, symbol, series, o, h, l, c, prevClose, volume, value]
//   fut/YYYY-MM-DD.json   = scripts/nse-fo-history.js rows  [symbol, STK|IDX, expiry, o, h, l, c, settle, oi, chgOi, contracts]
//   opt/YYYY-MM-DD.json   = scripts/nse-options-delivery-history.js { idx: { NIFTY: [[expiry, K, CE|PE, close, settle, oi]] } }
//   sopt/YYYY-MM-DD.json.gz = scripts/nse-stock-options-history.js rows (two nearest expiries, strikes within 12% of the CM close)
//   idx/YYYY-MM-DD.json   = scripts/nse-index-close-history.js { "Nifty 50": [o, h, l, c] } (when NSE has the file)
// URLs (NSE archive, old formats): content/historical/EQUITIES/YYYY/MON/cmDDMONYYYYbhav.csv.zip,
// content/historical/DERIVATIVES/YYYY/MON/foDDMONYYYYbhav.csv.zip, content/indices/ind_close_all_DDMMYYYY.csv.
// Every header seen is logged once per year (verification of NSE's columns). A weekday CM 404 = holiday (.none).
//   K2_OLD_DIR=nse-old node scripts/nse-old-history.js 2005-01-01 2020-10-31
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const OUT = path.resolve(process.env.K2_OLD_DIR || "nse-old");
const FROM = process.argv[2] || "2005-01-01", TO = process.argv[3] || "2020-10-31";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const monIdx = Object.fromEntries(MON.map((m, i) => [m, String(i + 1).padStart(2, "0")]));
const SERIES = new Set(["EQ", "BE", "BZ"]);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const LOG = path.join(OUT, "download.log");
const log = (s) => { fs.appendFileSync(LOG, s + "\n"); console.log(s); };
const isoOld = (s) => { const [d, m, y] = String(s).trim().split("-"); return `${y.length === 2 ? "20" + y : y}-${monIdx[m.toUpperCase()]}-${d.padStart(2, "0")}`; };
const seenHead = new Set();
const logHead = (kind, iso, head) => { const k = `${kind}|${iso.slice(0, 4)}|${head.join(",")}`; if (seenHead.has(k)) return; seenHead.add(k); log(`HEADER ${kind} ${iso}: ${head.join(",")}`); };

function unzipFirst(buf) {
  let e = -1; for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i -= 1) if (buf.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error("not a zip"); const cd = buf.readUInt32LE(e + 16);
  const method = buf.readUInt16LE(cd + 10), size = buf.readUInt32LE(cd + 20), local = buf.readUInt32LE(cd + 42);
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28); const data = buf.subarray(start, start + size);
  return method === 0 ? data : zlib.inflateRawSync(data);
}
const table = (text) => { const lines = text.split(/\r?\n/).filter((l) => l.trim()); const head = lines[0].split(",").map((h) => h.trim()); return { head, rows: lines.slice(1).map((l) => l.split(",").map((x) => x.trim())), c: (n) => head.indexOf(n) }; };

function parseCm(text, iso) {
  const { head, rows, c } = table(text); logHead("CM", iso, head);
  const k = { isin: c("ISIN"), sym: c("SYMBOL"), ser: c("SERIES"), o: c("OPEN"), h: c("HIGH"), l: c("LOW"), cl: c("CLOSE"), pc: c("PREVCLOSE"), v: c("TOTTRDQTY"), val: c("TOTTRDVAL") };
  for (const [n, i] of Object.entries(k)) if (n !== "isin" && i < 0) throw new Error(`CM ${iso}: missing column ${n} in ${head.join(",")}`);
  const num = (f, i) => { const x = Number(f[i]); return Number.isFinite(x) ? x : null; };
  return rows.filter((f) => SERIES.has(f[k.ser])).map((f) => [k.isin >= 0 ? f[k.isin] : "", f[k.sym], f[k.ser], num(f, k.o), num(f, k.h), num(f, k.l), num(f, k.cl), num(f, k.pc), num(f, k.v), num(f, k.val)]);
}
function parseFo(text, iso, spot) {
  const { head, rows, c } = table(text); logHead("FO", iso, head);
  // NSE's own headers: 2005 files name the option type "OPTIONTYPE", later ones "OPTION_TYP" (seen 5 Oct 2026).
  const iTyp = c("OPTION_TYP") >= 0 ? c("OPTION_TYP") : c("OPTIONTYPE");
  for (const n of ["INSTRUMENT", "SYMBOL", "EXPIRY_DT", "STRIKE_PR", "OPEN", "HIGH", "LOW", "CLOSE", "SETTLE_PR", "CONTRACTS", "OPEN_INT", "CHG_IN_OI"]) if (c(n) < 0) throw new Error(`FO ${iso}: missing column ${n}`);
  if (iTyp < 0) throw new Error(`FO ${iso}: no option-type column`);
  const fut = [], idxRows = [], stk = new Map();
  for (const f of rows) {
    const ins = f[c("INSTRUMENT")], sym = f[c("SYMBOL")], E = isoOld(f[c("EXPIRY_DT")]);
    if (ins === "FUTSTK" || ins === "FUTIDX") fut.push([sym, ins === "FUTSTK" ? "STK" : "IDX", E, +f[c("OPEN")], +f[c("HIGH")], +f[c("LOW")], +f[c("CLOSE")], +f[c("SETTLE_PR")], +f[c("OPEN_INT")], +f[c("CHG_IN_OI")], +f[c("CONTRACTS")]]);
    else if (ins === "OPTIDX" && (sym === "NIFTY" || sym === "BANKNIFTY")) idxRows.push([sym, E, +f[c("STRIKE_PR")], f[iTyp], +f[c("CLOSE")], +f[c("SETTLE_PR")], +f[c("OPEN_INT")]]);
    else if (ins === "OPTSTK") { if (!stk.has(sym)) stk.set(sym, []); stk.get(sym).push([sym, E, +f[c("STRIKE_PR")], f[iTyp], +f[c("CLOSE")], +f[c("SETTLE_PR")], +f[c("OPEN_INT")], +f[c("CONTRACTS")]]); }
  }
  const idx = {}; for (const u of ["NIFTY", "BANKNIFTY"]) { const rs = idxRows.filter((r) => r[0] === u); const ex = [...new Set(rs.map((r) => r[1]))].sort().slice(0, 2); idx[u] = rs.filter((r) => ex.includes(r[1])).map((r) => r.slice(1)); }
  const sopt = []; for (const [sym, rs] of stk) { const s = spot[sym]; if (!(s > 0)) continue; const ex = [...new Set(rs.map((r) => r[1]))].sort().slice(0, 2); for (const r of rs) if (ex.includes(r[1]) && Math.abs(r[2] / s - 1) <= 0.12) sopt.push(r); }
  return { fut, opt: { idx }, sopt };
}
const get = (url) => fetch(url, { headers: { "User-Agent": UA, Accept: "*/*" }, signal: AbortSignal.timeout(60_000) });
const urls = (iso) => { const [y, m, d] = iso.split("-"); const M = MON[+m - 1];
  return { cm: `https://nsearchives.nseindia.com/content/historical/EQUITIES/${y}/${M}/cm${d}${M}${y}bhav.csv.zip`,
    fo: `https://nsearchives.nseindia.com/content/historical/DERIVATIVES/${y}/${M}/fo${d}${M}${y}bhav.csv.zip`,
    idx: `https://nsearchives.nseindia.com/content/indices/ind_close_all_${d}${m}${y}.csv` }; };

(async () => {
  for (const s of ["cm", "fut", "opt", "sopt", "idx"]) fs.mkdirSync(path.join(OUT, s), { recursive: true });
  const days = []; for (let t = Date.parse(`${FROM}T00:00:00Z`); t <= Date.parse(`${TO}T00:00:00Z`); t += 864e5) { const d = new Date(t); if (d.getUTCDay() % 6) days.push(d.toISOString().slice(0, 10)); }
  log(`=== ${new Date().toISOString()} ${days.length} weekdays ${FROM} .. ${TO}`);
  let fails = 0, got = 0, hol = 0, noFo = 0, noIdx = 0;
  for (const d of days) {
    const f = (s, ext = ".json") => path.join(OUT, s, d + ext);
    if (fs.existsSync(f("cm", ".none")) || (fs.existsSync(f("cm")) && fs.existsSync(f("fut")) && (fs.existsSync(f("idx")) || fs.existsSync(f("idx", ".none"))))) continue;
    try {
      const u = urls(d);
      if (!fs.existsSync(f("cm"))) {
        const r = await get(u.cm);
        if (r.status === 404) { fs.writeFileSync(f("cm", ".none"), ""); hol += 1; await pause(500); continue; }
        if (!r.ok) throw new Error(`CM HTTP ${r.status}`);
        const rows = parseCm(unzipFirst(Buffer.from(await r.arrayBuffer())).toString("utf8"), d);
        if (rows.length < 300) throw new Error(`CM only ${rows.length} rows`);
        fs.writeFileSync(f("cm"), JSON.stringify(rows)); await pause(600);
      }
      if (!fs.existsSync(f("fut"))) {
        const r = await get(u.fo);
        if (r.status === 404) { log(`${d}: F&O 404 (CM exists)`); noFo += 1; fs.writeFileSync(f("fut"), "[]"); }
        else { if (!r.ok) throw new Error(`FO HTTP ${r.status}`);
          const spot = {}; for (const x of JSON.parse(fs.readFileSync(f("cm"), "utf8"))) if (x[2] === "EQ") spot[x[1]] = x[6];
          const p = parseFo(unzipFirst(Buffer.from(await r.arrayBuffer())).toString("utf8"), d, spot);
          fs.writeFileSync(f("fut"), JSON.stringify(p.fut)); fs.writeFileSync(f("opt"), JSON.stringify(p.opt)); fs.writeFileSync(f("sopt", ".json.gz"), zlib.gzipSync(JSON.stringify(p.sopt))); }
        await pause(600);
      }
      if (!fs.existsSync(f("idx")) && !fs.existsSync(f("idx", ".none"))) {
        const r = await get(u.idx);
        if (!r.ok) { fs.writeFileSync(f("idx", ".none"), String(r.status)); noIdx += 1; }
        else { const out = {}; const lines = (await r.text()).split(/\r?\n/); if (got < 3 || d.endsWith("-01-03")) log(`HEADER IDX ${d}: ${lines[0]}`);
          for (const line of lines.slice(1)) { const x = line.split(","); if (/^nifty 50$|^s&p cnx nifty$|^cnx nifty$/i.test((x[0] || "").trim())) out["Nifty 50"] = [+x[2], +x[3], +x[4], +x[5]]; }
          if (out["Nifty 50"]) fs.writeFileSync(f("idx"), JSON.stringify(out)); else { fs.writeFileSync(f("idx", ".none"), "no Nifty 50 row"); noIdx += 1; } }
        await pause(400);
      }
      fails = 0; got += 1; if (got % 100 === 0) log(`${d}: ${got} sessions, ${hol} holidays, ${noFo} without F&O, ${noIdx} without index file`);
    } catch (e) {
      fails += 1; log(`${d}: FAILED ${e.message} (${fails} in a row)`);
      if (fails >= 5) { log("STOPPED: 5 failures in a row -- run again to resume"); break; }
      await pause(20_000);
    }
  }
  log(`done: ${got} sessions, ${hol} holidays, ${noFo} without F&O, ${noIdx} without index file, ${new Date().toISOString()}`);
})().catch((e) => { log("fatal: " + e.message); process.exit(1); });
