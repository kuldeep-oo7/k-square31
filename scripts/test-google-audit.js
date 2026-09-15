"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { auditLiveSheet, REQUIRED_CAPABILITIES } = require("./audit-live-google-sheet");

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "k2-google-audit-test-"));
  const reportPath = path.join(dir, "report.txt");
  const now = new Date("2026-09-15T10:00:00Z");
  const rows = new Map();
  let doc = null, calls = 0;
  const append = (tab, row) => { calls++; rows.set(tab, [row]); return { ok: true, appended: 1 }; };
  const store = {
    googleStoreConfigured: () => true,
    queryGoogleCapabilities: async () => { calls++; return { ok: true, capabilities: REQUIRED_CAPABILITIES }; },
    appendTradeSignalsToGoogle: async (data) => append("K2_TRADE_LEDGER", data[0]),
    appendPortfolioAuditToGoogle: async (data) => append("K2_PORTFOLIO_AUDIT", data[0]),
    appendMacroRadarToGoogle: async (data) => append("K2_MACRO_RADAR", data),
    appendStockFundamentalsToGoogle: async (data) => append("K2_FUNDAMENTALS_BALANCE_SHEET", data[0]),
    readTabRowsFromGoogle: async ({ tab }) => ({ ok: true, rows: rows.get(tab), count: 1, totalRows: 1 }),
    readGoogleDocument: async () => ({ data: doc, etag: doc ? "1" : null }),
    writeGoogleDocument: async (_path, data) => { doc = data; return { etag: "1" }; }
  };
  const opts = { reportPath, now, store };
  assert.equal((await auditLiveSheet({ ...opts, dryRun: true })).ok, false);
  assert.equal(calls, 0, "Dry run must not contact an endpoint even if credentials exist");
  assert.equal((await auditLiveSheet(opts)).status, "WRITE_READBACK_NOT_REQUESTED");
  assert.equal(rows.size, 0, "Default audit must not contaminate operational tabs");
  assert.equal((await auditLiveSheet({ ...opts, writeCanaries: true })).ok, true);
  assert.match(fs.readFileSync(reportPath, "utf8"), /TEST DOUBLE ONLY/);
  doc = null;
  const mismatch = await auditLiveSheet({ ...opts, writeCanaries: true,
    store: { ...store, readTabRowsFromGoogle: async () => ({ ok: true, rows: [{ id: "old-canary" }] }) } });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.auditResults.K2_TRADE_LEDGER.canaryFound, false);
  const error = await auditLiveSheet({ ...opts, store: { ...store, queryGoogleCapabilities: async () => { throw new Error("secret-url"); } } });
  assert.equal(error.ok, false);
  const report = fs.readFileSync(reportPath, "utf8");
  assert.match(report, /Status : FAILED/);
  assert.ok(!report.includes("secret-url"));
  assert.equal((await auditLiveSheet({ ...opts, store: { ...store, googleStoreConfigured: () => false } })).ok, false);
  console.log("Google audit tests passed: offline is unverified, opt-in canaries, exact read-back, failure replaces old status; no live calls.");
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exitCode = 1;
});
