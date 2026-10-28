"use strict";
// Publish generated files only. Credentials and source histories stay on the runner.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { buildSnapshot, quotesFrom, ROOT } = require("./runtime");
const { render } = require("./view");
function browserCore() {
  const modules = ["engine", "strategy-engine", "analysis", "rules.json", "paper", "view", "workbench-view", "playbook"];
  const definitions = modules.map((name) => {
    const code = fs.readFileSync(path.join(__dirname, name.endsWith(".json") ? name : name + ".js"), "utf8");
    // Explicit allow-list: no broker, filesystem, credentials or network code.
    for (const match of code.matchAll(/require\(["']([^"']+)["']\)/g)) {
      if (match[1] !== "node:crypto" && !modules.includes(match[1].replace(/^\.\//, ""))) throw Error("UNSAFE_BROWSER_DEPENDENCY");
    }
    return JSON.stringify("./" + name) + ":function(module,exports,require){\n" + (name.endsWith(".json") ? "module.exports=" + code + ";" : code) + "\n}";
  });
  return '"use strict";(()=>{const definitions={' + definitions.join(",\n") + '},cache={};function require(id){if(id==="node:crypto")return {randomUUID:()=>crypto.randomUUID()};if(!definitions[id])throw Error("UNKNOWN_BROWSER_MODULE");if(!cache[id]){const m=cache[id]={exports:{}};definitions[id](m,m.exports,require);}return cache[id].exports;}window.FreshCore={...require("./paper"),render:require("./view").render};})();\n';
}
function buildSite({ nse, cryptoData, now = Date.now(), output = path.join(ROOT, ".private/fresh-desk/pages") }) {
  fs.mkdirSync(output, { recursive: true });
  const { cases, demoNow } = require("./demo"), core = browserCore();
  for (const [folder, source, data, at, demo] of [
    ["", "nse", nse, now, false], ["crypto", "crypto", cryptoData, now, false],
    ["demo", "demo", { inputs: cases(), tradingSession: true, state: "SYNTHETIC_DEMO", errors: [] }, demoNow, true]
  ]) {
    if (!data) throw Error("EXPLICIT_MARKET_DATA_STATE_REQUIRED");
    const snapshot = buildSnapshot(data, { now: at, source, demo });
    snapshot.observedQuotes = quotesFrom(data);
    const dir = path.join(output, folder); fs.mkdirSync(dir, { recursive: true });
    const html = render(snapshot, { hosted: true });
    const assets = Object.fromEntries(["app.css", "app.js", "hosted.js"].map((name) => [name, fs.readFileSync(path.join(__dirname, name), "utf8")]));
    const hash = crypto.createHash("sha256").update(html).update(core);
    for (const value of Object.values(assets)) hash.update(value);
    const version = { schemaVersion: 1, builtAt: new Date(now).toISOString(), snapshotAt: snapshot.builtAt, source, demo, state: snapshot.state, revision: hash.digest("hex") };
    // The bootstrap has the same revision as version.json for cache-safe polling.
    fs.writeFileSync(path.join(dir, "index.html"), html.replace('"hosted":true', '"revision":' + JSON.stringify(version.revision) + ',"hosted":true'));
    fs.writeFileSync(path.join(dir, "core.js"), core);
    for (const [name, content] of Object.entries(assets)) fs.writeFileSync(path.join(dir, name), content);
    fs.writeFileSync(path.join(dir, "version.json"), JSON.stringify(version));
  }
  return output;
}
async function main(args = process.argv.slice(2)) {
  if (args.length !== 1 || !["--live", "--offline"].includes(args[0])) throw Error("CHOOSE_LIVE_OR_OFFLINE_BUILD");
  let nse, cryptoData;
  if (args[0] === "--live") {
    const feed = require("./feed"), brokers = require("../api/_lib/broker-feed");
    const { dayAt } = require("./engine"), now = Date.now(), day = dayAt(now);
    if (feed.sessionAt(now) === true && now >= Date.parse(day + "T09:15:00+05:30") && now < Date.parse(day + "T15:00:00+05:30")) {
      // A cold Actions runner needs the large public master. Give it the
      // transport's normal budget, not the interactive refresh's 12 seconds.
      const master = brokers.loadInstruments("angelone");
      if (!master?.fetchedAt || !Number.isFinite(Date.parse(master.fetchedAt)) || dayAt(Date.parse(master.fetchedAt)) !== day) {
        try { await brokers.refreshInstruments("angelone"); } catch { /* collector emits unavailable state */ }
      }
      // Existing secrets may contain login material without a current token.
      try { await require("../api/_lib/broker-auth").angelEnsureSession(); } catch { /* collector reports sanitized failure */ }
    }
    // Sequential requests keep broker authentication and quote pacing predictable.
    nse = await feed.collect();
    cryptoData = await require("./crypto-feed").collectCrypto(["BTCUSDT", "ETHUSDT"]);
  } else {
    nse = cryptoData = { inputs: [], errors: ["OFFLINE_BUILD_NO_MARKET_DATA"], state: "DATA_UNAVAILABLE" };
  }
  const output = buildSite({ nse, cryptoData });
  console.log(JSON.stringify({ output: path.relative(ROOT, output), nse: nse.state, crypto: cryptoData.state, deployed: false }));
}
if (require.main === module) main().catch(() => { console.error("Pages build failed; no deployment produced."); process.exitCode = 1; });
module.exports = { buildSite, browserCore, main };
