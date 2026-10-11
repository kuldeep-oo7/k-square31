"use strict";
// NSE's daily FII/FPI and DII cash-market buy, sell and net (Rs crore), from www.nseindia.com/api/fiidiiTradeReact
// (checked 11 Oct 2026: 9 Oct FII/FPI net -3568.9, DII net +4743.26). NSE serves ONLY the latest day, so
// springy-dip.yml keeps one file per day in release data-paper-inputs (nse-flows/YYYY-MM-DD.json): the
// history starts on the day this ran first. Information for now; nothing decides on it until it is tested.
//   K2_FLOWS_DIR=nse-flows node scripts/nse-fii-dii.js
const fs = require("node:fs");
const path = require("node:path");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const MON = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };

function parse(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const out = {}; let date = null;
  for (const r of rows) {
    const m = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(String(r.date || "")); if (!m || !MON[m[2]]) return null;
    const d = `${m[3]}-${MON[m[2]]}-${m[1]}`; if (date && d !== date) return null; date = d;
    const key = /FII|FPI/i.test(r.category) ? "FII" : /DII/i.test(r.category) ? "DII" : null; if (!key) continue;
    const buy = Number(r.buyValue), sell = Number(r.sellValue), net = Number(r.netValue);
    if (![buy, sell, net].every(Number.isFinite) || Math.abs(buy - sell - net) > 0.05) return null;   // NSE's own arithmetic must hold
    out[key] = { buy, sell, net };
  }
  return out.FII && out.DII ? { date, unit: "Rs crore", source: "NSE api/fiidiiTradeReact", ...out } : null;
}

async function main() {
  const dir = path.resolve(process.env.K2_FLOWS_DIR || "nse-flows"); fs.mkdirSync(dir, { recursive: true });
  const home = await fetch("https://www.nseindia.com/", { headers: { "User-Agent": UA } });
  const cookie = (home.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  const r = await fetch("https://www.nseindia.com/api/fiidiiTradeReact", { headers: { "User-Agent": UA, Accept: "application/json", Referer: "https://www.nseindia.com/", Cookie: cookie }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const rec = parse(await r.json()); if (!rec) throw new Error("NSE's reply did not parse");
  const file = path.join(dir, `${rec.date}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...rec, fetchedAt: new Date().toISOString() }));
  console.log(`FII/DII ${rec.date}: FII net ${rec.FII.net}, DII net ${rec.DII.net} (Rs crore) -> ${file}`);
}
if (require.main === module) main().catch((e) => { console.error("FII/DII:", e.message); process.exit(1); });
module.exports = { parse };
