"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { analyse, RULES } = require("./engine");
const { render } = require("./view");
const ROOT = path.resolve(__dirname, "..");
function parseArgs(args) {
  const result = { demo: false, live: false, input: null, symbols: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--demo") result.demo = true;
    else if (a === "--live") result.live = true;
    else if ((a === "--input" || a === "--symbols") && args[i + 1] && !args[i + 1].startsWith("--")) {
      const value = args[++i]; if (a === "--input") result.input = value;
      else { result.symbols = value.split(",").map((s) => s.trim().toUpperCase()); if (result.symbols.some((s) => !/^[A-Z0-9&-]{1,30}$/.test(s))) throw Error("INVALID_SYMBOLS"); }
    } else throw Error("Use --live, --demo, or --input private-file.json; optional --symbols NAME,NAME");
  }
  if (Number(result.live) + Number(result.demo) + Number(Boolean(result.input)) !== 1) throw Error("CHOOSE_ONE_DATA_MODE");
  return result;
}
async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  let data, now = Date.now();
  if (options.demo) { const { cases, demoNow } = require("./demo"); now = demoNow; data = { inputs: cases(), tradingSession: true, errors: [], state: "SYNTHETIC_DEMO" }; }
  else if (options.input) {
    data = JSON.parse(fs.readFileSync(path.resolve(ROOT, options.input), "utf8"));
    if (!Array.isArray(data.inputs)) throw Error("INPUTS_ARRAY_REQUIRED");
    // An import is evaluated against the ACTUAL clock; it cannot pretend an old quote is live.
    data.tradingSession = require("./feed").sessionAt(now); data.errors ||= []; data.state = "IMPORTED_DATA";
  } else { data = await require("./feed").collect(options.symbols); now = Date.now(); }
  const { buildSnapshot, saveSnapshot } = require("./runtime");
  const snapshot = buildSnapshot(data, { now, demo: options.demo, source: options.demo ? "demo" : options.input ? "import" : "nse", symbols: options.symbols });
  const results = snapshot.results, dir = saveSnapshot(snapshot);
  console.log(JSON.stringify({ state: snapshot.state, contracts: results.length, buy: results.flatMap((r) => r.plans).filter((p) => p.side === "BUY").length,
    sell: results.flatMap((r) => r.plans).filter((p) => p.side === "SELL").length, output: path.relative(ROOT, dir), validated: false }));
  return snapshot;
}
if (require.main === module) main().catch(() => { console.error("Fresh desk failed; no trade issued. Check local inputs and data access."); process.exitCode = 1; });
module.exports = { main, parseArgs };
