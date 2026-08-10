"use strict";

const { runOnce } = require("./gm-cloud-sync");

const intervalMinutes = Math.max(5, Number(process.env.GM_SYNC_INTERVAL_MINUTES) || 30);
const intervalMs = intervalMinutes * 60 * 1000;
let stopping = false;

process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });

async function worker() {
  console.log(`K² GM read-only cloud worker started; interval ${intervalMinutes} minutes`);
  while (!stopping) {
    const started = Date.now();
    try {
      await runOnce();
    } catch (error) {
      console.error(`Scheduled GM sync failed: ${String(error?.message || error).slice(0, 240)}`);
    }
    const remaining = Math.max(1_000, intervalMs - (Date.now() - started));
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
  console.log("K² GM cloud worker stopped cleanly");
}

worker().catch((error) => {
  console.error(`K² GM cloud worker stopped unexpectedly: ${String(error?.message || error).slice(0, 240)}`);
  process.exitCode = 1;
});
