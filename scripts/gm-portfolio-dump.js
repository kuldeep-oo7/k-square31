"use strict";

// Reads the GM portfolio and writes it to a file instead of publishing it.
//
// Used when the operational store is unavailable and the book still has to be
// looked at: the scheduled sync needs somewhere to write, this does not. The
// output is a build artifact, never console output, so positions do not end up
// in a run log.
//
//   GM_USERNAME=... GM_PASSWORD=... node scripts/gm-portfolio-dump.js positions.json

const fs = require("node:fs");
const { fetchPortfolioWithBrowser } = require("./gm-browser-sync");

async function run() {
  const destination = process.argv[2] || "gm-positions.json";
  const username = String(process.env.GM_USERNAME || "");
  const password = String(process.env.GM_PASSWORD || "");
  if (!username || !password) throw new Error("GM_USERNAME and GM_PASSWORD are required");

  let snapshot = null;
  let lastError = null;
  for (let attempt = 1; attempt <= 3 && !snapshot; attempt += 1) {
    try {
      snapshot = await fetchPortfolioWithBrowser(username, password);
    } catch (error) {
      lastError = error;
      if (attempt < 3) console.warn(`GM read attempt ${attempt} failed; retrying a fresh session.`);
    }
  }
  if (!snapshot) throw lastError || new Error("GM portfolio could not be read");

  fs.writeFileSync(destination, JSON.stringify({
    capturedAt: new Date().toISOString(),
    recordCount: snapshot.recordCount,
    totalQuantity: snapshot.totalQuantity,
    totalMtm: snapshot.totalMtm,
    endpoint: snapshot.endpoint,
    positions: snapshot.positions
  }, null, 2));

  // Counts and totals only: the holdings themselves stay in the artifact.
  console.log(`Wrote ${snapshot.recordCount} positions, signed quantity ${snapshot.totalQuantity}, MTM ${snapshot.totalMtm.toFixed(2)} to ${destination}`);
}

if (require.main === module) {
  run().catch((error) => {
    console.error(`GM portfolio dump failed: ${String(error?.message || error).slice(0, 300)}`);
    process.exitCode = 1;
  });
}

module.exports = { run };
