"use strict";
// Public reference metadata ONLY. No account, order, email or Sheet mutation.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { buildCatalogue, directoryFromCatalogue } = require("../api/_lib/indian-instruments");
const { universe } = require("../api/_lib/universe");
async function run() {
  const sources = await Promise.all(["NSE", "BSE", "NFO", "BFO"].map(async (exchange) => {
    const url = `https://api.kite.trade/instruments/${exchange}`;
    const response = await fetch(url, { headers: { "X-Kite-Version": "3" }, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`${exchange} catalogue HTTP ${response.status}`);
    const csv = await response.text();
    if (!csv.startsWith("instrument_token,") || csv.length < 1000) throw new Error(`${exchange} catalogue schema/size invalid`);
    return { exchange, url, csv, sourceDate: null }; // HTTP receipt time is NOT an exchange as-of certificate.
  }));
  const catalogue = buildCatalogue(sources), directory = directoryFromCatalogue(catalogue, universe());
  for (const exchange of ["NSE", "BSE", "NFO", "BFO"]) {
    if (catalogue.instruments.filter((i) => i.exchange === exchange).length < 50) throw new Error(`${exchange} coverage unexpectedly small; previous snapshot preserved`);
  }
  const cache = path.resolve(__dirname, "../.cache/indian-instruments");
  fs.mkdirSync(cache, { recursive: true });
  for (const s of sources) {
    const digest = crypto.createHash("sha256").update(s.csv).digest("hex");
    try { fs.writeFileSync(path.join(cache, `${s.exchange}-${digest}.csv`), s.csv, { flag: "wx" }); }
    catch (e) { if (e.code !== "EEXIST") throw e; }
  }
  fs.writeFileSync(path.join(cache, "latest.json.tmp"), JSON.stringify(catalogue));
  fs.renameSync(path.join(cache, "latest.json.tmp"), path.join(cache, "latest.json"));
  const target = path.resolve(__dirname, "../data/indian-market-directory.json");
  fs.writeFileSync(`${target}.tmp`, JSON.stringify(directory));
  fs.renameSync(`${target}.tmp`, target);
  console.log(JSON.stringify({ fetchedAt: directory.fetchedAt, cashListings: directory.cashListings,
    derivativeContracts: directory.derivativeContracts, derivativeUnderlyingsByVenue: directory.derivatives.length,
    preservedResearchNames: directory.originalResearchNames, sourceTimestampVerified: false,
    scope: directory.coverageMeaning }, null, 2));
}
if (require.main === module) run().catch((e) => { console.error(`Reference refresh failed: ${e.message}`); process.exitCode = 1; });
module.exports = { run };
