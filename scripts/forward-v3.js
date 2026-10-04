"use strict";
// Writes docs/paper-rules/forward-v3.json: the forward paper tests of the cheap-vol straddle and the
// industry-adjusted reversal (studies/forward-v3-2026-10-04/PREREGISTRATION.txt).
//   K2_CM_DIR=nse-data/cm K2_SOPT_DIR=nse-sopt K2_INDUSTRY=industries.json node scripts/forward-v3.js
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const { START, context, cheapVol, indRev } = require("../api/_lib/forward-v3");
const { loadCm } = require("./springy-dip-forward");

// The registered industry file (PREREGISTRATION.txt). Any other file -> INDREV is NOT RUN, visibly.
const INDUSTRY_SHA256 = "47c3516eebd6ff1205794ddfd26391541bbe4e6796b6250d98a7bf1447826405";

function industryCheck(file, expected = INDUSTRY_SHA256) {
  if (!fs.existsSync(file)) return { ok: false, reason: "NOT RUN: the registered industry file is missing" };
  const buf = fs.readFileSync(file); const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  if (sha256 !== expected) return { ok: false, sha256, reason: `NOT RUN: the industry file changed (sha256 ${sha256.slice(0, 12)}..., registered ${expected.slice(0, 12)}...)` };
  return { ok: true, sha256, industry: JSON.parse(buf.toString("utf8")) };
}

function lazySopt(dir) {
  const have = new Set(fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.endsWith(".json.gz")).map((f) => f.slice(0, 10)) : []);
  const cache = new Map();
  return { get: (d) => { if (cache.has(d)) return cache.get(d); if (cache.size > 12) cache.delete(cache.keys().next().value);
    const v = have.has(d) ? JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, `${d}.json.gz`)))) : undefined; cache.set(d, v); return v; }, days: have };
}

if (require.main === module) {
  const cm = path.resolve(process.env.K2_CM_DIR || "nse-data/cm"), soptDir = path.resolve(process.env.K2_SOPT_DIR || "nse-sopt");
  const industryFile = path.resolve(process.env.K2_INDUSTRY || "industries.json");
  const out = path.resolve(process.env.K2_OUT || path.join(__dirname, "..", "docs", "paper-rules", "forward-v3.json"));
  const prereg = path.join(__dirname, "..", "studies", "forward-v3-2026-10-04", "PREREGISTRATION.txt");
  const data = loadCm(cm); const ctx = context(data);
  const ind = industryCheck(industryFile);
  const cv = cheapVol({ ...data, sopt: lazySopt(soptDir), ctx });
  const ir = ind.ok ? indRev({ ...data, industry: ind.industry, ctx }) : null;
  const noIndustry = ir && ir.pending ? [...ir.pending.long, ...ir.pending.short].filter((s) => ind.industry[s] === "-") : [];
  const doc = { preregistration: "studies/forward-v3-2026-10-04/PREREGISTRATION.txt", preregSha256: crypto.createHash("sha256").update(fs.readFileSync(prereg)).digest("hex"), start: START,
    dataThrough: data.sessions[data.sessions.length - 1], builtAt: new Date().toISOString(), industries: ind.ok ? Object.keys(ind.industry).length : 0, industrySha256: ind.sha256 || null,
    CHEAPVOL: { rule: "Buy the at-the-money stock straddle at the close when its implied volatility is below 0.8x the stock's 20-day realised volatility; sell at the close 5 sessions later", backtest: "+3.30% of premium a trade, t 1.94, 5,126 trades over 60 months — just short of the bar", trades: cv.trades.slice(0, 300), summary: cv.summary },
    INDREV: { rule: "Every 5th session: buy the 10% of stocks that lagged their industry group most over the last 5 sessions, short the 10% that led it most; close both 5 sessions later. Industry = NSE's own filings, which give none for about a third of the 200 stocks; those are compared with each other as one group, exactly as in the backtest", backtest: "+0.15% a rebalance, t 1.98, 248 rebalances over 60 months — just short of the bar",
      status: ind.ok ? "RUN" : ind.reason, rebalances: ir ? ir.rebalances.slice(0, 60) : [], pending: ir ? ir.pending : null, pendingNoIndustry: noIndustry, sessionsToNext: ir ? ir.sessionsToNext : null, summary: ir ? ir.summary : null } };
  fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(doc, null, 1));
  console.log(`data through ${doc.dataThrough}: cheap-vol ${cv.trades.length} trade(s); ` + (ir ? `industry reversal ${ir.rebalances.length} rebalance(s), next in ${ir.sessionsToNext} session(s)${ir.pending ? `, lists ready (${ir.pending.long.length} long / ${ir.pending.short.length} short, ${noIndustry.length} with no NSE industry)` : ""}; industries ${doc.industries}` : `industry reversal ${ind.reason}`));
}
module.exports = { lazySopt, industryCheck, INDUSTRY_SHA256 };
