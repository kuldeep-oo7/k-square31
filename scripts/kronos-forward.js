"use strict";
// The Kronos forward paper watch (studies/kronos-forward-2026-10-16/PREREGISTRATION.txt), run by .github/workflows/kronos.yml.
//   K2_CM_DIR=nse-data/cm K2_FUT_DIR=nse-fo/fut node scripts/kronos-forward.js prepare <inputs.jsonl>   (exit 3: day already stored)
//   python scripts/kronos-forecast.py <inputs.jsonl> <preds.csv>
//   K2_CM_DIR=nse-data/cm K2_FUT_DIR=nse-fo/fut node scripts/kronos-forward.js store <preds.csv>
//   K2_CM_DIR=nse-data/cm node scripts/kronos-forward.js score
// The store is docs/paper-rules/kronos.json (K2_STORE). A stored day is never recomputed or overwritten.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { RULE, loadCm, inputsFor, makeDay, score } = require("../api/_lib/kronos-forward");
const { nextTradingDate } = require("./paper-ledger");

const PREREG = path.join(__dirname, "..", "studies", "kronos-forward-2026-10-16", "PREREGISTRATION.txt");
const STORE = path.resolve(process.env.K2_STORE || path.join(__dirname, "..", "docs", "paper-rules", "kronos.json"));
const readStore = () => { try { return JSON.parse(fs.readFileSync(STORE, "utf8")); } catch { return { days: {} }; } };
const futRows = (d) => { try { return JSON.parse(fs.readFileSync(path.join(path.resolve(process.env.K2_FUT_DIR || "nse-fo/fut"), `${d}.json`), "utf8")); } catch { return []; } };

function write(store, data) {
  const { books, summary } = score(store.days, data);
  const latest = Object.keys(store.days).sort().pop() || null;
  const doc = { preregistration: "studies/kronos-forward-2026-10-16/PREREGISTRATION.txt",
    preregSha256: crypto.createHash("sha256").update(fs.readFileSync(PREREG, "utf8").replace(/\r\n/g, "\n")).digest("hex"),
    rule: "Kronos-small forecasts each futures stock's close 5 sessions ahead from its last 512 daily NSE bars -> buy the top tenth, sell the bottom tenth at the next open, close both 5 sessions later",
    backtest: "FAILED: +0.135% a rebalance, t 1.35, Jul 2024 - Oct 2026 (needs t >= 3)",
    start: RULE.start, dataThrough: data.sessions[data.sessions.length - 1], builtAt: new Date().toISOString(), latest,
    days: store.days, books: books.slice(-60), summary };
  fs.mkdirSync(path.dirname(STORE), { recursive: true }); fs.writeFileSync(STORE, JSON.stringify(doc, null, 1));
  return doc;
}

if (require.main === module) {
  const [cmd, file] = process.argv.slice(2);
  const data = loadCm(path.resolve(process.env.K2_CM_DIR || "nse-data/cm")); const d = data.sessions[data.sessions.length - 1];
  const store = readStore(); store.days = store.days || {};
  if (cmd === "prepare") {
    if (store.days[d]) { console.log(`${d}: already stored, never recomputed`); process.exit(3); }
    const fut = futRows(d); if (!fut.length) { console.error(`${d}: no NSE F&O file yet`); process.exit(4); }
    const rows = inputsFor(data, d, new Set(fut.filter((r) => r[1] === "STK").map((r) => r[0])), nextTradingDate);
    fs.writeFileSync(file, rows.map((r) => JSON.stringify({ d, ...r })).join("\n") + "\n");
    console.log(`${d}: ${rows.length} names written to ${file}`);
  } else if (cmd === "store") {
    if (store.days[d]) { console.log(`${d}: already stored`); process.exit(3); }
    const preds = {}; for (const l of fs.readFileSync(file, "utf8").split(/\r?\n/).slice(1)) { const [sym, v] = l.split(","); if (sym && v !== "" && Number.isFinite(+v)) preds[sym] = +v; }
    let exit = nextTradingDate(d); const entry = exit; for (let k = 1; k < RULE.h; k += 1) exit = nextTradingDate(exit);
    const fut = futRows(d);
    const contractFor = (sym, x) => fut.filter((r) => r[0] === sym && r[1] === "STK" && r[2] >= x).map((r) => r[2]).sort()[0] || null;
    store.days[d] = makeDay({ d, entry, exit, preds, madeAt: new Date().toISOString(), contractFor });
    const doc = write(store, data);
    console.log(`${d}: stored ${store.days[d].long.length} long, ${store.days[d].short.length} short for ${entry} -> ${exit}; finished ${doc.summary.finished}, ${doc.summary.verdict}`);
  } else if (cmd === "score") {
    const doc = write(store, data); console.log(`scored: finished ${doc.summary.finished}, ${doc.summary.verdict}`);
  } else { console.error("usage: prepare <inputs.jsonl> | store <preds.csv> | score"); process.exit(2); }
}
module.exports = { write };
