"use strict";
// MACRO POD DATA (owner, 19 Oct 2026: "make it like Duquesne"; inventory 19 Oct: scripts/macro-data-inventory.js).
// Official sources only. One source per run, so the GitHub workflow runs them side by side:
//   node scripts/macro-download.js <source> <out-dir> [from YYYY-MM-DD]
//   sources: cat_turnover (NSE cash turnover by category, from 2008) | part_oi | part_vol (NSE F&O participant OI and
//   volumes, from 2012) | fii_stats (NSE FII derivatives statistics, from 2016) | ind_close_all (NSE index closes with
//   India VIX and NIFTY P/E, from 2014) | fred (US Fed FRED series) | nifty_hist (NIFTY 50 and India VIX daily history
//   from niftyindices.com / NSE, for the years before the archive files)
// Daily files land as <out>/<source>/<date>.<ext>; a 404 is saved as <date>.none (holiday or not published) and not
// fetched again. Resumable: files already present are skipped. Nothing here computes a return.
const fs = require("node:fs");
const path = require("node:path");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
const A = "https://nsearchives.nseindia.com";
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const P = (iso) => { const [y, m, d] = iso.split("-"); return { y, yy: y.slice(2), m, dd: d, mon: MON[+m - 1] }; };
const DAILY = {
  cat_turnover: { from: "2008-01-01", ext: "xls", url: (p) => `${A}/archives/equities/cat/cat_turnover_${p.dd}${p.m}${p.yy}.xls` },
  part_oi: { from: "2012-01-01", ext: "csv", url: (p) => `${A}/content/nsccl/fao_participant_oi_${p.dd}${p.m}${p.y}.csv` },
  part_vol: { from: "2012-01-01", ext: "csv", url: (p) => `${A}/content/nsccl/fao_participant_vol_${p.dd}${p.m}${p.y}.csv` },
  fii_stats: { from: "2016-01-01", ext: "xls", url: (p) => `${A}/content/fo/fii_stats_${p.dd}-${p.mon}-${p.y}.xls` },
  ind_close_all: { from: "2014-01-01", ext: "csv", url: (p) => `${A}/content/indices/ind_close_all_${p.dd}${p.m}${p.y}.csv` }
};
const FRED = { DGS10: "US 10-year Treasury yield", DTWEXBGS: "broad US dollar index", DEXINUS: "rupees per US dollar",
  INDIRLTLT01STM: "India 10-year government bond yield (monthly)", DFF: "US federal funds effective rate", VIXCLS: "CBOE VIX" };

async function get(url, opts = {}) {
  for (let i = 0; i < 4; i += 1) {
    try { const r = await fetch(url, { ...opts, headers: { "User-Agent": UA, ...(opts.headers || {}) }, signal: AbortSignal.timeout(30_000) });
      if (r.status === 404) return { status: 404 };
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return { status: 200, buf: Buffer.from(await r.arrayBuffer()), headers: r.headers };
    } catch (e) { if (i === 3) return { status: "ERR", error: String(e.message || e) }; await sleep(1500 * (i + 1)); }
  }
}

async function daily(src, out, fromArg) {
  const s = DAILY[src]; const dir = path.join(out, src); fs.mkdirSync(dir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10); let d = fromArg || s.from; let got = 0, none = 0, err = 0, had = 0;
  for (; d <= today; d = new Date(Date.parse(d) + 864e5).toISOString().slice(0, 10)) {
    const wd = new Date(`${d}T00:00:00Z`).getUTCDay(); if (wd === 0 || wd === 6) continue;
    const f = path.join(dir, `${d}.${s.ext}`), fn = path.join(dir, `${d}.none`); if (fs.existsSync(f) || fs.existsSync(fn)) { had += 1; continue; }
    const r = await get(s.url(P(d)));
    // NSE posts some files days late (cat_turnover for 16 and 19 Oct 2026 was 404 on 20 Oct), so a missing day in the
    // last 10 is tried again on the next run instead of being marked "not published".
    const recent = Date.parse(today) - Date.parse(d) < 10 * 864e5;
    if (r.status === 200) { fs.writeFileSync(f, r.buf); got += 1; } else if (r.status === 404) { if (!recent) fs.writeFileSync(fn, ""); none += 1; } else { err += 1; }
    await sleep(250);
  }
  console.log(`${src}: ${got} downloaded, ${none} not published (holiday or missing), ${err} errors, ${had} already here`);
}

async function fred(out) {
  const dir = path.join(out, "fred"); fs.mkdirSync(dir, { recursive: true });
  for (const [id, name] of Object.entries(FRED)) {
    const r = await get(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`);
    if (r.status !== 200) { console.log(`fred ${id} (${name}): ${r.status} ${r.error || ""}`); continue; }
    fs.writeFileSync(path.join(dir, `${id}.csv`), r.buf); const rows = r.buf.toString("utf8").trim().split(/\r?\n/);
    console.log(`fred ${id} (${name}): ${rows.length - 1} rows, ${rows[1]?.split(",")[0]} .. ${rows.at(-1)?.split(",")[0]}`);
  }
}

// NIFTY 50 and India VIX daily history before the 2014 archive files: NSE's own historical APIs, year by year.
async function niftyHist(out) {
  const dir = path.join(out, "nifty_hist"); fs.mkdirSync(dir, { recursive: true });
  const home = await fetch("https://www.nseindia.com/reports-indices-historical-index-data", { headers: { "User-Agent": UA } });
  const cookie = (home.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  const H = { Accept: "application/json", Cookie: cookie, Referer: "https://www.nseindia.com/reports-indices-historical-index-data" };
  const fmt = (iso) => { const [y, m, d] = iso.split("-"); return `${d}-${m}-${y}`; };
  for (let y = 2008; y <= new Date().getUTCFullYear(); y += 1) {
    for (const [name, url] of [["nifty", (a, b) => `https://www.nseindia.com/api/historical/indicesHistory?indexType=NIFTY%2050&from=${a}&to=${b}`],
                               ["vix", (a, b) => `https://www.nseindia.com/api/historical/vixhistory?from=${a}&to=${b}`]]) {
      for (const [a, b] of [[`${y}-01-01`, `${y}-06-30`], [`${y}-07-01`, `${y}-12-31`]]) {
        const f = path.join(dir, `${name}-${a}.json`); if (fs.existsSync(f)) continue;
        const r = await get(url(fmt(a), fmt(b)), { headers: H });
        if (r.status === 200) fs.writeFileSync(f, r.buf); else console.log(`nifty_hist ${name} ${a}: ${r.status} ${r.error || ""}`);
        await sleep(800);
      }
    }
  }
  console.log(`nifty_hist: ${fs.readdirSync(dir).length} files`);
}

if (require.main === module) {
  const [src, out = "macro", from] = process.argv.slice(2);
  (async () => {
    if (DAILY[src]) await daily(src, out, from);
    else if (src === "fred") await fred(out);
    else if (src === "nifty_hist") await niftyHist(out);
    else { console.error(`unknown source ${src}`); process.exit(2); }
  })();
}
