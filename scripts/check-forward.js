"use strict";
// The checks added on 2-4 Oct 2026, run as one step of `npm run check` (the full chain had grown past
// Windows' 8,191-character command-line limit). Each runs in its own process; the first failure stops it.
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const steps = [
  ["--check", "api/_lib/springy-dip.js"], ["scripts/test-springy-dip.js"],
  ["--check", "api/_lib/oi-flow-forward.js"], ["scripts/test-oi-flow-forward.js"],
  ["--check", "api/_lib/forward-v2.js"], ["scripts/test-forward-v2.js"],
  ["--check", "api/_lib/forward-v3.js"], ["scripts/test-forward-v3.js"],
  ["--check", "api/_lib/nse-index-history.js"], ["scripts/test-nse-index-history.js"],
  ["--check", "api/_lib/orderflow-recorder.js"], ["scripts/test-orderflow-recorder.js"],
  ["scripts/test-nse-official-close.js"], ["scripts/test-google-retry.js"],
  ["--check", "api/_lib/freshness.js"], ["scripts/test-freshness.js"],
  ["--check", "api/_lib/contract-screener.js"], ["scripts/test-screener-by-symbol.js"],
  ["scripts/test-live-worker.mjs"]
];
const root = path.resolve(__dirname, "..");
for (const args of steps) {
  const r = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
  if (r.status !== 0) { console.error(`check-forward: FAILED at node ${args.join(" ")}`); process.exit(r.status || 1); }
}
console.log(`check-forward: ${steps.length} steps passed`);
