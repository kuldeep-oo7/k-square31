"use strict";
// US large caps for the out-of-sample replication (studies/oos-replication-2026-10-05), written in the
// NSE CM day-file format so the forward paper-test code reads them unchanged:
//   cm/YYYY-MM-DD.json = [["", SYMBOL, "EQ", open, high, low, close, prevClose, volume, close*volume], ...]
//   industries.json    = { SYMBOL: "GICS sub-industry" }
// Members: TODAY's S&P 500 list from Wikipedia's "List of S&P 500 companies" (secondary source; S&P's own
// list is not free) -- survivorship bias, stated in the registration. Prices: Yahoo Finance chart API v8,
// daily, split-adjusted OHLC (not dividend-adjusted), 2005-01-01 .. K2_US_TO.
//   K2_US_DIR=us node scripts/us-history.js
const fs = require("node:fs");
const path = require("node:path");
const OUT = path.resolve(process.env.K2_US_DIR || "us");
const FROM = "2005-01-01", TO = process.env.K2_US_TO || "2026-10-02";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => { fs.appendFileSync(path.join(OUT, "download.log"), s + "\n"); console.log(s); };
const strip = (h) => h.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#160;|&nbsp;/g, " ").trim();

(async () => {
  fs.mkdirSync(path.join(OUT, "sym"), { recursive: true }); fs.mkdirSync(path.join(OUT, "cm"), { recursive: true });
  const html = await (await fetch("https://en.wikipedia.org/wiki/List_of_S%26P_500_companies", { headers: { "User-Agent": UA } })).text();
  const tbl = html.slice(html.indexOf('id="constituents"')); const body = tbl.slice(0, tbl.indexOf("</table>"));
  const rows = body.split(/<tr[^>]*>/).slice(1).map((r) => r.split(/<t[dh][^>]*>/).slice(1).map(strip));
  log(`HEADER wikipedia: ${rows[0].join(" | ")}`);
  const head = rows[0], iSym = head.findIndex((h) => /^symbol/i.test(h)), iSub = head.findIndex((h) => /sub-industry/i.test(h));
  if (iSym < 0 || iSub < 0) throw new Error("unexpected Wikipedia table header");
  const members = rows.slice(1).filter((r) => r[iSym]).map((r) => ({ sym: r[iSym].replace(/\./g, "-"), sub: r[iSub] }));
  log(`${members.length} members, e.g. ${members.slice(0, 3).map((m) => `${m.sym}=${m.sub}`).join(", ")}`);
  if (members.length < 480) throw new Error(`only ${members.length} members parsed`);
  fs.writeFileSync(path.join(OUT, "industries.json"), JSON.stringify(Object.fromEntries(members.map((m) => [m.sym, m.sub]))));
  const p1 = Date.parse(FROM) / 1000, p2 = Date.parse(TO) / 1000; let fails = 0;
  for (const { sym } of members) {
    const file = path.join(OUT, "sym", `${sym}.json`); if (fs.existsSync(file)) continue;
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${p1}&period2=${p2}&interval=1d&events=split`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const res = (await r.json()).chart.result[0]; const q = res.indicators.quote[0];
      const bars = res.timestamp.map((t, i) => [new Date((t + res.meta.gmtoffset) * 1000).toISOString().slice(0, 10), q.open[i], q.high[i], q.low[i], q.close[i], q.volume[i]]).filter((b) => b.slice(1, 5).every((x) => x > 0));
      fs.writeFileSync(file, JSON.stringify(bars)); fails = 0;
      if (sym === members[0].sym) log(`sample ${sym}: ${bars.length} bars, first ${JSON.stringify(bars[0])}, last ${JSON.stringify(bars.at(-1))}`);
    } catch (e) { fails += 1; log(`${sym}: FAILED ${e.message}`); if (fails >= 10) { log("STOPPED: 10 failures in a row"); break; } await pause(5000); }
    await pause(400);
  }
  // per-day files
  const byDay = new Map(); let n = 0;
  for (const f of fs.readdirSync(path.join(OUT, "sym"))) { const sym = f.replace(/\.json$/, ""); let prev = null; n += 1;
    for (const [d, o, h, l, c, v] of JSON.parse(fs.readFileSync(path.join(OUT, "sym", f), "utf8"))) { if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(["", sym, "EQ", o, h, l, c, prev, v, c * (v || 0)]); prev = c; } }
  for (const [d, rs] of byDay) fs.writeFileSync(path.join(OUT, "cm", `${d}.json`), JSON.stringify(rs));
  log(`done: ${n} symbols, ${byDay.size} sessions ${[...byDay.keys()].sort()[0]} .. ${[...byDay.keys()].sort().at(-1)}`);
})().catch((e) => { log("fatal: " + e.message); process.exit(1); });
