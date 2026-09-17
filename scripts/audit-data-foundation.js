"use strict";
// Read-only external audit. Reports aggregate integrity, never credentials or holdings.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const store = require("../api/_lib/google-store");
const root = path.resolve(__dirname, "..");
const hash = (x) => crypto.createHash("sha256").update(JSON.stringify(x)).digest("hex");
async function run() {
  const healthPath = path.join(root, ".private", "audit-2026-09-17"); fs.mkdirSync(healthPath, { recursive: true });
  const report = { auditedAt: new Date().toISOString(), externalWrites: false,
    googleConfigured: store.googleStoreConfigured(), allSheetCellsRead: false, tabs: [], documents: [], limitations: [] };
  if (!report.googleConfigured) report.limitations.push("GOOGLE_CREDENTIALS_UNAVAILABLE");
  else {
    let capability;
    try { capability = await store.queryGoogleCapabilities(); }
    catch { report.limitations.push("LIVE_GOOGLE_ENDPOINT_HANDSHAKE_FAILED"); fs.writeFileSync(path.join(healthPath,"data-foundation.json"),JSON.stringify(report,null,2)); throw Error("Endpoint handshake failed"); }
    report.capabilities = { ok: capability.ok, version: capability.version, capabilities: capability.capabilities };
    const paths = new Set(Array.from({ length: 10 }, (_, i) => `ai-grid/v1/shard-${i}.json`));
    paths.add("k2/manual-recommendations/evidence-v1.json");
    for (const tab of ["K2_STATE", "K2_TRADE_LEDGER", "K2_PORTFOLIO_AUDIT", "K2_MACRO_RADAR", "K2_FUNDAMENTALS_BALANCE_SHEET", "K2_DAILY_RECOMMENDATIONS", "K2_RECOMMENDATION_AUDIT"]) {
      try {
        const data = await store.readTabRowsFromGoogle({ tab, limit: 500 });
        const rows = data.rows || [];
        report.tabs.push({ tab, totalRows: data.totalRows ?? null, sampledRows: rows.length, sampleSha256: hash(rows),
          fullTabRead: Number.isInteger(data.totalRows) && data.totalRows === rows.length,
          headers: data.headers, firstSampleTimestamp: rows[0]?.Timestamp || rows[0]?.["Updated At"] || null,
          lastSampleTimestamp: rows.at(-1)?.Timestamp || rows.at(-1)?.["Updated At"] || null });
        if (tab === "K2_STATE") for (const row of rows) if (/^(ai-grid\/|k2\/|weekly-|market\/)/.test(row.Path)) paths.add(row.Path);
      } catch { report.tabs.push({ tab, status: "READ_FAILED_OR_TAB_ABSENT" }); }
    }
    // Old readDocuments creates K2_STATE if absent. Do not call it unless the
    // preceding read-only tab request proved the state sheet already exists.
    const stateExists = report.tabs.some(tab => tab.tab === "K2_STATE" && Array.isArray(tab.headers));
    if (!stateExists) report.limitations.push("DOCUMENT_READS_SKIPPED_TO_AVOID_IMPLICIT_STATE_SHEET_CREATION");
    for (const pathname of stateExists ? [...paths].slice(0, 120) : []) {
      try {
        const record = await store.readGoogleDocument(pathname, null), data = record.data;
        if (!data) { report.documents.push({ path: pathname, found: false }); continue; }
        const symbols = Object.values(data.symbols || {});
        let observations = 0, invalid = 0, duplicates = 0, latest = null, earliest = null;
        for (const symbol of symbols) {
          const seen = new Set();
          for (const bar of symbol.observations || []) {
            observations++;
            const date = bar.session || bar.date;
            if (seen.has(date)) duplicates++; seen.add(date);
            if (date) { if (!latest || date > latest) latest = date; if (!earliest || date < earliest) earliest = date; }
            if (![bar.open, bar.high, bar.low, bar.close].every(x => typeof x === "number" && Number.isFinite(x) && x > 0)
                || bar.high < Math.max(bar.open, bar.close, bar.low) || bar.low > Math.min(bar.open, bar.close)) invalid++;
          }
        }
        report.documents.push({ path: pathname, found: true, etag: record.etag, sha256: hash(data), keys: Object.keys(data),
          symbolCount: symbols.length, observations, invalidOhlc: invalid, duplicateSessions: duplicates, earliest, latest,
          updatedAt: data.updatedAt || data.generatedAt || null,
          recommendationCount: Array.isArray(data.recommendations) ? data.recommendations.length : null,
          outcomeCount: Array.isArray(data.outcomes) ? data.outcomes.length : null });
      } catch { report.documents.push({ path: pathname, status: "READ_OR_DECODE_FAILED" }); }
    }
    report.limitations.push("Legacy endpoint samples at most 500 rows per tab. No full spreadsheet inventory API was assumed.",
      "Complete known shard documents were decoded, but stored values are not independently verified against exchange ticks.",
      "Hashes detect subsequent changes; they do not prove original observation time, accuracy or valid execution.");
  }
  const target = path.join(root, ".private", "audit-2026-09-17"); fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "data-foundation.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
if (require.main === module) run().catch(e => { console.error(JSON.stringify({ status: "READ_FAILED", externalWrites: false,
  errorType: e.name, code: e.cause?.code || e.code || null,
  category: /Unauthorized|401|403/.test(e.message) ? "AUTHORIZATION" : /JSON|Unexpected token/.test(e.message) ? "NON_JSON_ENDPOINT_RESPONSE" : /timeout/i.test(e.message) ? "TIMEOUT" : "TRANSPORT_OR_ENDPOINT" })); process.exitCode = 1; });
module.exports = { run };
