"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { analyse, RULES, identity } = require("./engine");
const { render } = require("./view");
const ROOT = path.resolve(__dirname, "..");
function buildSnapshot(data, { now = Date.now(), demo = false, source = "import", symbols = null } = {}) {
  if (!data || !Array.isArray(data.inputs) || data.inputs.length > 1000) throw Error("INVALID_INPUT_DATASET");
  if (data.inputs.some((i) => !i || !Array.isArray(i.bars) || i.bars.length > 2000)) throw Error("INVALID_CANDLE_DATASET");
  const selected = data.inputs.filter((i) => !symbols?.length || symbols.includes(i.symbol));
  const results = selected.map((input) => analyse(input, { now, tradingSession: data.tradingSession }));
  const hash = crypto.createHash("sha256");
  for (const file of ["rules.json", "strategy-engine.js", "analysis.js", "feed.js", "crypto-feed.js"]) hash.update(file).update(fs.readFileSync(path.join(__dirname, file)));
  return { schemaVersion: 2, rulesVersion: RULES.version, builtAt: new Date(now).toISOString(), demo, source,
    mode: "UNVALIDATED_RESEARCH", state: data.state || "IMPORTED_DATA", errors: Array.isArray(data.errors) ? data.errors : [], coverage: data.coverage || null, results, codeSha256: hash.digest("hex") };
}
function saveSnapshot(snapshot, dir = path.join(ROOT, ".private/fresh-desk", snapshot.demo ? "demo" : "live")) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "snapshot.json.tmp"), JSON.stringify(snapshot, null, 2)); fs.renameSync(path.join(dir, "snapshot.json.tmp"), path.join(dir, "snapshot.json"));
  fs.writeFileSync(path.join(dir, "index.html"), render(snapshot));
  for (const name of ["app.css", "app.js"]) fs.copyFileSync(path.join(__dirname, name), path.join(dir, name));
  return dir;
}
function quotesFrom(data) { return Object.fromEntries((data.inputs || []).filter((i) => i.quote).map((i) => [identity(i), { ...i.quote, instrumentId: identity(i) }])); }
module.exports = { buildSnapshot, saveSnapshot, quotesFrom, ROOT };
