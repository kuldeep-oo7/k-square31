"use strict";
// Writes docs/paper-rules/forward-v4.json: the forward paper test of S2 "borrowing surge"
// (studies/forward-v4-2026-10-12/PREREGISTRATION.txt).
//   K2_CM_DIR=nse-data/cm K2_SLB_DIR=nse-slb/slb_openpos K2_FUT_DIR=nse-fo/fut node scripts/forward-v4.js
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { START, borrowingSurge, parseSlb } = require("../api/_lib/forward-v4");
const { loadCm } = require("./springy-dip-forward");

function loadSlb(dir, last) { const slb = new Map(); if (!fs.existsSync(dir)) return slb;
  for (const f of fs.readdirSync(dir).filter((x) => /^\d{4}-\d{2}-\d{2}\.csv$/.test(x)).sort()) { const d = f.slice(0, 10); if (d <= last) slb.set(d, parseSlb(fs.readFileSync(path.join(dir, f), "utf8"))); }
  return slb; }
// symbols with NSE stock futures, from the latest F&O futures file ([symbol, "STK"|"IDX", ...] rows); labels only
function futuresSymbols(dir) { if (!fs.existsSync(dir)) return null; const f = fs.readdirSync(dir).filter((x) => x.endsWith(".json")).sort().pop(); if (!f) return null;
  return new Set(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).filter((r) => r[1] === "STK").map((r) => r[0])); }

if (require.main === module) {
  const cm = path.resolve(process.env.K2_CM_DIR || "nse-data/cm"), slbDir = path.resolve(process.env.K2_SLB_DIR || "nse-slb/slb_openpos");
  const out = path.resolve(process.env.K2_OUT || path.join(__dirname, "..", "docs", "paper-rules", "forward-v4.json"));
  const prereg = path.join(__dirname, "..", "studies", "forward-v4-2026-10-12", "PREREGISTRATION.txt");
  const data = loadCm(cm); const last = data.sessions[data.sessions.length - 1];
  const slb = loadSlb(slbDir, last); const futSyms = futuresSymbols(path.resolve(process.env.K2_FUT_DIR || "nse-fo/fut"));
  const r = borrowingSurge({ ...data, slb, futSyms });
  const slbDays = [...slb.keys()];
  const doc = { preregistration: "studies/forward-v4-2026-10-12/PREREGISTRATION.txt", preregSha256: crypto.createHash("sha256").update(fs.readFileSync(prereg, "utf8").replace(/\r\n/g, "\n")).digest("hex"),
    start: START, dataThrough: last, slbThrough: slbDays[slbDays.length - 1] || null, slbFiles: slbDays.length, builtAt: new Date().toISOString(),
    S2: { rule: "When the shares out on loan in NSE's lending market (SLB) jump to at least 2x their 20-day average, and at least 1 lakh shares: short the stock at the open of the 2nd session after that day's file, cover at the close 5 sessions later",
      backtest: "+0.26% a trade over the market, 55% winners, t 2.23, 2,085 trades over 61 months (NSE data atlas study, 12 Oct 2026) — promising, not proven",
      trades: r.trades.slice(0, 300).map(({ netExact, ...t }) => t), pending: r.pending, summary: r.summary } };
  fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(doc, null, 1));
  console.log(`S2 borrowing surge: data through ${last}, SLB files ${slbDays.length} (to ${doc.slbThrough}); ${r.trades.length} counted trade(s) from ${START}, ${r.pending.length} signal(s) waiting for their entry; ${r.summary.verdict}`);
}
module.exports = { loadSlb, futuresSymbols };
