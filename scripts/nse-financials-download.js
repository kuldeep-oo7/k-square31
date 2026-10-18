"use strict";
// NSE's own quarterly financial results, every filing with its publication time, for the value pod (point-in-time).
//   node scripts/nse-financials-download.js <symbols.txt> <out-dir> [shard k of n: "k/n"]
// Two NSE feeds, both found in NSE's own page script (sections/corporate-filings.js, read 18 Oct 2026):
//   /api/corporates-financial-results?index=equities&period=Quarterly&symbol=S   results to Dec 2024 (XBRL from Sep 2018)
//   /api/integrated-filing-results?index=equities&symbol=S&type=Integrated Filing- Financials   from Mar 2025
// Each XBRL file is parsed to its facts (element, context, value) and kept as <out>/<SYMBOL>.json; the raw XML is not kept.
// Resumable: a filing already in the symbol's file is not fetched again. Missing is missing, never 0.
const fs = require("node:fs");
const path = require("node:path");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
const PAGE = "https://www.nseindia.com/companies-listing/corporate-filings-financial-results";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cookie = "", cookieAt = 0;
async function session() {
  if (cookie && Date.now() - cookieAt < 10 * 60_000) return;
  const p = await fetch(PAGE, { headers: { "User-Agent": UA, Accept: "text/html" }, signal: AbortSignal.timeout(20_000) });
  cookie = (p.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; "); cookieAt = Date.now();
}
async function get(url, json = true) {
  for (let i = 0; i < 4; i += 1) {
    try { await session(); const r = await fetch(url, { headers: { "User-Agent": UA, Accept: json ? "application/json" : "*/*", Cookie: cookie, Referer: PAGE }, signal: AbortSignal.timeout(30_000) });
      if (r.status === 401 || r.status === 403) { cookie = ""; throw new Error(`HTTP ${r.status}`); }
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return json ? await r.json() : await r.text();
    } catch (e) { if (i === 3) throw e; await sleep(2000 * (i + 1)); }
  }
}
const MON = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
const iso = (s) => { const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:\s+(\d{2}:\d{2}(?::\d{2})?))?/.exec(String(s || "").trim()); return m ? `${m[3]}-${MON[m[2].toUpperCase()]}-${m[1].padStart(2, "0")}${m[4] ? "T" + (m[4].length === 5 ? m[4] + ":00" : m[4]) + "+05:30" : ""}` : null; };

// XBRL facts: <prefix:Element contextRef="X" ...>value</prefix:Element>, plus each context's period
function parseXbrl(t) {
  const ctx = {}; for (const m of t.matchAll(/<xbrli:context\s+id="([^"]+)"[\s\S]*?<\/xbrli:context>/g)) {
    const s = /<xbrli:startDate>([^<]+)</.exec(m[0]), e = /<xbrli:endDate>([^<]+)</.exec(m[0]), i = /<xbrli:instant>([^<]+)</.exec(m[0]);
    ctx[m[1]] = i ? { instant: i[1].trim() } : { start: s && s[1].trim(), end: e && e[1].trim() }; }
  const facts = []; for (const m of t.matchAll(/<([A-Za-z\-]+):([A-Za-z0-9_]+)\s[^>]*contextRef="([^"]+)"[^>]*>([^<]*)</g)) {
    if (m[1] === "xbrli" || m[1] === "link") continue; const v = m[4].trim(); if (v === "") continue; facts.push([m[2], m[3], /^-?\d+(\.\d+)?$/.test(v) ? +v : v.slice(0, 200)]); }
  return { contexts: ctx, facts };
}

async function one(sym, outDir) {
  const file = path.join(outDir, `${sym}.json`); const have = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { symbol: sym, filings: {} };
  const list = [];
  const old = await get(`https://www.nseindia.com/api/corporates-financial-results?index=equities&period=Quarterly&symbol=${encodeURIComponent(sym)}`);
  for (const r of (Array.isArray(old) ? old : old?.data) || []) list.push({ feed: "old", id: `o${r.seqNumber}`, period: iso(r.toDate), from: iso(r.fromDate), consolidated: r.consolidated, audited: r.audited, cumulative: r.cumulative, indAs: r.indAs, bank: r.bank, broadcast: iso(r.broadCastDate), xbrl: r.xbrl });
  const neu = await get(`https://www.nseindia.com/api/integrated-filing-results?index=equities&symbol=${encodeURIComponent(sym)}&type=${encodeURIComponent("Integrated Filing- Financials")}`);
  for (const r of neu?.data || []) list.push({ feed: "integrated", id: `i${r.seq_Id}`, period: iso(r.qe_Date), consolidated: r.consolidated, audited: r.audited, broadcast: iso(r.broadcast_Date), revised: r.revised_Date || null, typeSub: r.type_Sub || null, xbrl: r.xbrl });
  let fetched = 0, failed = 0;
  for (const f of list) {
    if (have.filings[f.id]?.facts || !/\.xml$/i.test(f.xbrl || "") || !f.period || f.period < "2018-01-01") { if (!have.filings[f.id]) have.filings[f.id] = { ...f, facts: null }; continue; }
    try { const t = await get(f.xbrl, false); have.filings[f.id] = { ...f, ...(t ? parseXbrl(t) : { facts: null, error: "404" }) }; fetched += 1; }
    catch (e) { have.filings[f.id] = { ...f, facts: null, error: String(e.message || e) }; failed += 1; }
    await sleep(350);
  }
  have.listedAt = new Date().toISOString(); fs.writeFileSync(file, JSON.stringify(have));
  return { n: list.length, fetched, failed };
}

if (require.main === module) {
  const [symFile, outDir, shard = "1/1"] = process.argv.slice(2); const [k, n] = shard.split("/").map(Number);
  const syms = fs.readFileSync(symFile, "utf8").split(/\s+/).filter(Boolean).sort().filter((_, i) => i % n === k - 1);
  fs.mkdirSync(outDir, { recursive: true }); const t0 = Date.now(); let tot = { n: 0, fetched: 0, failed: 0 }, bad = [];
  (async () => {
    for (const [i, s] of syms.entries()) {
      if (Date.now() - t0 > 5.3 * 3600_000) { console.log(`time limit: stopped before ${s} (${syms.length - i} left; rerun resumes)`); break; }
      try { const r = await one(s, outDir); tot.n += r.n; tot.fetched += r.fetched; tot.failed += r.failed; if (i % 10 === 0) console.log(`${i + 1}/${syms.length} ${s}: ${r.n} filings, ${r.fetched} fetched, ${r.failed} failed`); }
      catch (e) { bad.push(s); console.log(`${s}: FAILED ${e.message}`); }
      await sleep(500);
    }
    console.log(`shard ${shard}: ${syms.length} symbols, ${tot.n} filings listed, ${tot.fetched} XBRL fetched, ${tot.failed} failed; symbols failed: ${bad.join(" ") || "none"}`);
  })();
}
module.exports = { parseXbrl, iso };
