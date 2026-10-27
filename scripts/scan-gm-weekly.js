"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { scan, RULE } = require("../api/_lib/gm-technical-research");
const { futuresHistory } = require("../api/_lib/gm-research-feed");
const { audit } = require("./audit-gm-goal");
const { isNseHoliday } = require("../api/_lib/nse-holidays");
const ROOT = path.resolve(__dirname, "..");

function loadPrivateEnvironment() {
  const file = path.join(ROOT, ".private", "production.env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
function lastClosedSession(now = Date.now()) {
  let day = new Date(now + 330 * 60000).toISOString().slice(0, 10);
  if (Date.parse(`${day}T15:30:00+05:30`) > now) day = new Date(Date.parse(day) - 864e5).toISOString().slice(0, 10);
  for (let i = 0; i < 15; i++) {
    const holiday = isNseHoliday(day), weekday = new Date(day).getUTCDay();
    if (holiday === null) throw new Error("NSE_CALENDAR_NOT_COVERED");
    if (!holiday && weekday !== 0 && weekday !== 6) return day;
    day = new Date(Date.parse(day) - 864e5).toISOString().slice(0, 10);
  }
  throw new Error("NSE_SESSION_UNAVAILABLE");
}
function parseArgs(args) {
  const options = { live: false, input: null, symbols: null, asOf: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--live") options.live = true;
    else if (["--input", "--symbols", "--as-of"].includes(a) && args[i + 1] && !args[i + 1].startsWith("--")) {
      const v = args[++i];
      if (a === "--input") options.input = v;
      if (a === "--as-of") options.asOf = v;
      if (a === "--symbols") {
        options.symbols = v.split(",").map((s) => s.trim().toUpperCase());
        if (options.symbols.some((s) => !/^[A-Z0-9&-]{1,30}$/.test(s))) throw new Error("INVALID_SYMBOL_FILTER");
      }
    } else throw new Error("Use --live OR --input file.json, with optional --symbols and --as-of.");
  }
  if (options.live === !!options.input) throw new Error("Choose exactly one of --live or --input.");
  return options;
}
async function run(options, { history = futuresHistory, refreshMaster = null, ensureSession = null, instruments, now = Date.now(), budgetMs = Infinity, pauseMs = 30000 } = {}) {
  const started = Date.now();
  const asOf = options.asOf || lastClosedSession(now);
  if (asOf > lastClosedSession(now) || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)
    || !Number.isFinite(Date.parse(asOf)) || new Date(asOf).toISOString().slice(0, 10) !== asOf) throw new Error("AS_OF_MUST_BE_A_COMPLETED_SESSION");
  const report = { builtAt: new Date(now).toISOString(), asOf, mode: RULE.mode, goal: audit().goal,
    validation: "UNVALIDATED; no historical profitability or weekly success rate established", evidence: audit(),
    configSha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, "config/gm-weekly-research.json"))).digest("hex"),
    engineSha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, "api/_lib/gm-technical-research.js"))).digest("hex"),
    examined: 0, rejected: {}, candidates: [] };
  const reject = (reason) => { report.rejected[reason] = (report.rejected[reason] || 0) + 1; };
  const consume = (data) => {
    report.examined++;
    if (data.ok === false) { reject(data.reason || "DATA_UNAVAILABLE"); return; }
    const evaluated = scan({ ...data, asOf });
    if (!evaluated.candidates.length) reject(evaluated.reason || evaluated.status);
    report.candidates.push(...evaluated.candidates);
  };
  if (options.input) {
    const input = JSON.parse(fs.readFileSync(path.resolve(options.input), "utf8"));
    if (!Array.isArray(input)) throw new Error("INPUT_MUST_BE_AN_ARRAY_OF_CONTRACT_HISTORIES");
    for (const data of input) if (!options.symbols || options.symbols.includes(data.symbol)) consume(data);
  } else {
    loadPrivateEnvironment();
    const brokers = require("../api/_lib/broker-feed");
    let master = instruments === undefined ? brokers.loadInstruments("angelone") : instruments;
    const masterAge = now - Date.parse(master?.fetchedAt || "");
    if (!Number.isFinite(masterAge) || masterAge > 36 * 3600e3 || masterAge < -60000) {
      try { master = await (refreshMaster || brokers.refreshInstruments)("angelone", { timeoutMs: 12000 }); }
      catch (error) { reject(error.cause?.code === "EACCES" ? "NETWORK_ACCESS_DENIED" : "INSTRUMENT_REFRESH_FAILED"); master = null; }
    }
    if (!master?.futures) reject("CURRENT_FUTURES_MASTER_UNAVAILABLE");
    else {
      const contracts = new Map();
      for (const [key, contract] of Object.entries(master.futures)) {
        const parts = key.split("|"), symbol = parts[0], expiry = parts[1];
        if (parts.length !== 2 || expiry <= asOf || contract.exchange !== "NFO" || (options.symbols && !options.symbols.includes(symbol))) continue;
        // The currently listed nearest contract, as on GM's watchlist. Never
        // substitute next month merely because the nearest history is thin.
        if (!contracts.has(symbol) || expiry < contracts.get(symbol).expiry) contracts.set(symbol, { symbol, expiry });
      }
      if (!contracts.size) reject("NO_MATCHING_FUTURES_CONTRACTS");
      let sessionRefreshed = false;
      for (const contract of contracts.values()) {
        if (Date.now() - started >= budgetMs) { reject("SCAN_BUDGET_EXHAUSTED"); report.partial = true; break; }
        let data = await history({ ...contract, asOf, instruments: master, now });
        if (data.reason === "ANGEL_SESSION_REJECTED" && !sessionRefreshed) {
          sessionRefreshed = true;
          try {
            const refreshed = await (ensureSession || require("../api/_lib/broker-auth").angelEnsureSession)();
            if (refreshed.ok) data = await history({ ...contract, asOf, instruments: master, now });
          } catch { /* retain the safe session-rejected reason */ }
        }
        // After ~80 quick history requests Angel answers AG8001 "Invalid Token" for ~20 s, then accepts the same
        // session again (measured 27 Oct 2026): pause and retry once instead of ending the scan there.
        if (["ANGEL_SESSION_REJECTED", "ANGEL_HTTP_429"].includes(data.reason) && Date.now() - started + pauseMs < budgetMs) {
          await new Promise((resolve) => setTimeout(resolve, pauseMs));
          data = await history({ ...contract, asOf, instruments: master, now });
        }
        consume(data);
        // A scan that stops early is partial, so the next desk build finishes it (cached histories are reused).
        if (["NETWORK_ACCESS_DENIED", "ANGEL_SESSION_REJECTED", "ANGEL_SESSION_NOT_CONFIGURED", "ANGEL_HTTP_429"].includes(data.reason)) { report.partial = true; break; }
        // Under SmartAPI's published historical request limit (3/s).
        if (!data.fromCache) await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
  }
  report.status = report.candidates.length ? "UNVALIDATED_PAPER_CANDIDATES" : report.examined ? "NO_QUALIFYING_SETUP_OR_DATA" : "DATA_UNAVAILABLE";
  return report;
}
async function main(args = process.argv.slice(2)) {
  const report = await run(parseArgs(args));
  const dir = path.join(ROOT, ".private", "gm-weekly");
  fs.mkdirSync(dir, { recursive: true });
  const output = path.join(dir, "latest.json");
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  // This repository is public. Predictions and prices stay in .private/.
  console.log(`GM 3% from entry, within a week: ${report.status}. ${report.examined} contracts examined; ${report.candidates.length} research candidates.`);
  console.log(`Data checks: ${JSON.stringify(report.rejected)}. Private report: .private/gm-weekly/latest.json`);
  return report;
}
if (require.main === module) main().catch(() => { console.error("GM scan failed; check the arguments and data connection. No picks issued."); process.exitCode = 1; });
module.exports = { main, run, parseArgs, lastClosedSession };
