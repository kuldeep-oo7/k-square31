"use strict";
// FPI DAILY FLOWS FROM NSDL (the official depository), for the macro pod: NSE's category-turnover file did not carry
// FPI rows before recent years (checked 20 Oct 2026: 2009/2015/2021/2022 files list BNK, DFI, PRO-TRADES, OTHERS only).
// NSDL's archive (www.fpi.nsdl.co.in/web/Reports/Archive.aspx) returns "Daily Trends in FPI Investments" for a month up
// to a chosen date. NSDL's note: a reporting date covers trades "on and up to the previous trading day(s)".
//   node scripts/nsdl-fpi-download.js <out-dir> [from YYYY-MM]
// Writes <out>/<YYYY-MM>.json = [{ date, equityExchangeNet, equityNet, debtNet, totalNet }] (Rs crore). Resumable.
const fs = require("node:fs");
const path = require("node:path");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
const URL = "https://www.fpi.nsdl.co.in/web/Reports/Archive.aspx";
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (s) => { const t = String(s).trim(); const neg = /^\(.*\)$/.test(t); const v = Number(t.replace(/[(),]/g, "")); return Number.isFinite(v) ? (neg ? -v : v) : null; };
const iso = (s) => { const m = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(s); return m ? `${m[3]}-${String(MON.indexOf(m[2]) + 1).padStart(2, "0")}-${m[1]}` : null; };

// The report text, flattened: "<date> Equity Stock Exchange b s net usd rate Primary market & others b s net usd Sub-total b s net usd Debt ... Total b s net usd"
// Split at each "<date> Equity" and read the equity rows of that block; the layout after the equity block changed
// in Sep 2024 (Debt-General Limit / Debt-VRR / Debt-FAR / Hybrid / Mutual Funds / AIFs), so only equity and the day's
// grand Total are read, never the debt rows by position.
function parse(text) {
  const out = []; const N = "\\(?-?[\\d,]+(?:\\.\\d+)?\\)?";
  const starts = [...text.matchAll(/(\d{2}-[A-Za-z]{3}-\d{4}) Equity /g)];
  for (let k = 0; k < starts.length; k += 1) {
    const block = text.slice(starts[k].index, k + 1 < starts.length ? starts[k + 1].index : undefined);
    const ex = new RegExp(`^\\S+ Equity Stock Exchange (${N}) (${N}) (${N})`).exec(block);
    const sub = new RegExp(`Equity Stock Exchange[\\s\\S]*?Sub-total (${N}) (${N}) (${N})`).exec(block);
    const tot = new RegExp(`(?:^|\\s)Total (${N}) (${N}) (${N})`).exec(block);
    out.push({ date: iso(starts[k][1]), equityExchangeNet: ex ? num(ex[3]) : null, equityNet: sub ? num(sub[3]) : null, totalNet: tot ? num(tot[3]) : null });
  }
  return out;
}

async function month(ym) {
  const g = await fetch(URL, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30_000) }); const html = await g.text();
  const cookie = (g.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  const val = (n) => (html.match(new RegExp(`id="${n}"[^>]*value="([^"]*)"`)) || html.match(new RegExp(`name="${n}"[^>]*value="([^"]*)"`)) || [])[1] || "";
  const [y, m] = ym.split("-").map(Number); const last = new Date(Date.UTC(y, m, 0)).getUTCDate(); const date = `${String(last).padStart(2, "0")}-${MON[m - 1]}-${y}`;
  const body = new URLSearchParams({ __EVENTTARGET: "btnSubmit1", __EVENTARGUMENT: "", __VIEWSTATE: val("__VIEWSTATE"), __VIEWSTATEGENERATOR: val("__VIEWSTATEGENERATOR"), __EVENTVALIDATION: val("__EVENTVALIDATION"), txtDate: date, hdnDate: date, hdnFlag: "" });
  const r = await fetch(URL, { method: "POST", headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie, Referer: URL }, body, signal: AbortSignal.timeout(60_000) });
  const text = (await r.text()).replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
  return parse(text).filter((x) => x.date && x.date.startsWith(ym));
}

if (require.main === module) {
  const [out, from = "2011-01"] = process.argv.slice(2); fs.mkdirSync(out, { recursive: true });
  (async () => {
    const now = new Date(); const end = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`; let ok = 0, empty = 0, err = 0;
    for (let ym = from; ym <= end; ) {
      const f = path.join(out, `${ym}.json`);
      if (!fs.existsSync(f) || ym >= end) {
        let rows = null; for (let i = 0; i < 3 && rows === null; i += 1) { try { rows = await month(ym); } catch { await sleep(3000 * (i + 1)); } }
        if (rows === null) err += 1; else if (!rows.length) empty += 1; else { fs.writeFileSync(f, JSON.stringify(rows)); ok += 1; }
        await sleep(1500);
      }
      const [y, m] = ym.split("-").map(Number); ym = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
    }
    const files = fs.readdirSync(out).filter((x) => x.endsWith(".json")).sort(); const days = files.reduce((a, x) => a + JSON.parse(fs.readFileSync(path.join(out, x), "utf8")).length, 0);
    console.log(`NSDL FPI: ${ok} months fetched, ${empty} empty, ${err} errors; on hand ${files.length} months (${files[0]} .. ${files.at(-1)}), ${days} reporting days`);
  })();
}
module.exports = { parse };
