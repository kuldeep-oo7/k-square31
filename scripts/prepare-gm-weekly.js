"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { run, lastClosedSession, pipelineSha256 } = require("./scan-gm-weekly");
const { futuresHistory } = require("../api/_lib/gm-research-feed");
const { project } = require("../api/_lib/gm-weekly-screen");
const ROOT = path.resolve(__dirname, "..");
const DIR = path.join(ROOT, ".private", "cache", "gm-weekly");
const read = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + ".tmp", JSON.stringify(value)); fs.renameSync(file + ".tmp", file); }
async function prepare({ dir = DIR, now = Date.now(), scanRun = run, history = futuresHistory,
  quotesFor = require("../api/_lib/broker-feed").futuresQuotes, marketOpen = require("../api/_lib/live-quotes").marketPhase(now).open } = {}) {
  const asOf = lastClosedSession(now), reportFile = path.join(dir, "report.json");
  const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, file))).digest("hex");
  let report = read(reportFile);
  if (!report || report.asOf !== asOf || report.partial || report.status === "DATA_UNAVAILABLE"
    || report.configSha256 !== hash("config/gm-weekly-research.json") || report.engineSha256 !== hash("api/_lib/gm-technical-research.js")
    || report.pipelineSha256 !== pipelineSha256()) {
    const cachedHistory = async (args) => {
      const name = crypto.createHash("sha256").update(`${args.symbol}|${args.expiry}|${args.asOf}`).digest("hex");
      const file = path.join(dir, "history", name + ".json"), cached = read(file);
      if (cached?.ok && cached.symbol === args.symbol && cached.expiry === args.expiry && cached.asOf === args.asOf) return { ...cached, fromCache: true };
      const data = await history(args); if (data.ok) write(file, data); return data;
    };
    try { report = await scanRun({ live: true, asOf }, { now, history: cachedHistory, budgetMs: 130000 }); }
    catch { report = { asOf, mode: "PAPER_RESEARCH_ONLY", status: "DATA_UNAVAILABLE", candidates: [], examined: 0, rejected: { SCAN_FAILED: 1 } }; }
    write(reportFile, report);
  }
  const state = read(path.join(dir, "state.json")) || {};
  const requests = new Map();
  for (const c of [...(report.candidates || []), ...Object.values(state.positions || {})]) {
    if (c.expiry >= new Date(now + 330 * 60000).toISOString().slice(0, 10)) requests.set(`${c.symbol}|${c.expiry}`, { symbol: c.symbol, expiry: c.expiry });
  }
  let quotes = {}, quotesUnavailable = false;
  if (marketOpen && requests.size) {
    try { const response = await quotesFor([...requests.values()], { timeoutMs: 12000 }); quotes = response.quotes || {}; quotesUnavailable = response.ok === false; }
    catch { quotesUnavailable = true; }
  }
  const projected = project({ report, state, quotes, now, marketOpen });
  if (quotesUnavailable) projected.view.dataReason = "LIVE_QUOTES_UNAVAILABLE";
  write(path.join(dir, "state.json"), projected.state); write(path.join(dir, "screen.json"), projected.view);
  return projected.view;
}
if (require.main === module) prepare().then((v) => console.log(`GM weekly screen: ${v.status}; ${v.rows.length} paper/preview rows. Raw histories remain private.`)).catch(() => {
  write(path.join(DIR, "screen.json"), { date: new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10), status: "DATA_UNAVAILABLE", rows: [], mode: "PAPER_RESEARCH_ONLY" });
  console.error("GM weekly data preparation failed; the screen will show unavailable data."); process.exitCode = 1;
});
module.exports = { prepare, DIR };
