"use strict";

/** Credentialed write/read-back canary for the Google operational store. */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const defaultStore = require("../api/_lib/google-store");
const {
  appendMacroRadarToGoogle,
  appendPortfolioAuditToGoogle,
  appendStockFundamentalsToGoogle,
  appendTradeSignalsToGoogle,
  googleStoreConfigured,
  queryGoogleCapabilities,
  readGoogleDocument,
  readTabRowsFromGoogle,
  writeGoogleDocument
} = defaultStore;

const REPORT_PATH = path.resolve(__dirname, "../LIVE_GOOGLE_SHEET_AUDIT_REPORT.txt");
const REQUIRED_CAPABILITIES = [
  "readDocuments", "writeDocument", "readTabRows", "appendTradeSignals",
  "appendPortfolioAudit", "appendMacroRadar", "appendStockFundamentals"
];

function writeReport(lines, reportPath = REPORT_PATH) {
  fs.writeFileSync(reportPath, [...lines, "=".repeat(80)].join("\n"), "utf8");
}

function offlineReport(now, reportPath, dryRun = false) {
  const lines = [
    "=".repeat(80),
    "LIVE GOOGLE SHEET AUDIT REPORT",
    "=".repeat(80),
    `Audit Timestamp : ${now.toISOString()}`,
    "Status          : BLOCKED / NOT VERIFIED",
    dryRun ? "Reason          : Dry run requested; no external calls or writes were made." : "Reason          : Required Google endpoint credentials are unavailable.",
    "Required        : K2_GOOGLE_SHEETS_WEB_APP_URL and K2_GOOGLE_SHEETS_ARCHIVE_SECRET",
    "Meaning         : No live write, read-back, durability, schema, or learning claim was tested."
  ];
  writeReport(lines, reportPath);
  return { ok: false, status: dryRun ? "DRY_RUN_NOT_VERIFIED" : "BLOCKED_CREDENTIALS_UNAVAILABLE", reportPath };
}

async function auditLiveSheet(options = {}) {
  const reportPath = options.reportPath || REPORT_PATH;
  try { return await performAudit(options); }
  catch {
    // Replace prior success even on transport failure; never print credentials.
    writeReport(["LIVE GOOGLE SHEET AUDIT REPORT", `Audit Timestamp : ${(options.now || new Date()).toISOString()}`,
      "Status : FAILED", "Reason : Endpoint handshake, transport, or document reconciliation failed.",
      "No live durability or learning claim is verified by this run."], reportPath);
    return { ok: false, status: "FAILED_ENDPOINT_OR_RECONCILIATION", reportPath };
  }
}

async function performAudit(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const reportPath = options.reportPath || REPORT_PATH;
  const { googleStoreConfigured, queryGoogleCapabilities, appendTradeSignalsToGoogle,
    appendPortfolioAuditToGoogle, appendMacroRadarToGoogle, appendStockFundamentalsToGoogle,
    readTabRowsFromGoogle, readGoogleDocument, writeGoogleDocument } = options.store || defaultStore;
  console.log("Starting credentialed Google Sheets write/read-back audit...");
  if (options.dryRun) return offlineReport(now, reportPath, true);
  if (!googleStoreConfigured()) return offlineReport(now, reportPath);

  const capabilities = await queryGoogleCapabilities();
  if (capabilities?.ok !== true) throw new Error("Google endpoint capability handshake was not acknowledged");
  const advertised = new Set(capabilities.capabilities || []);
  const missingCapabilities = REQUIRED_CAPABILITIES.filter((name) => !advertised.has(name));
  if (missingCapabilities.length) throw new Error(`Missing Google capabilities: ${missingCapabilities.join(", ")}`);
  if (options.writeCanaries !== true) {
    writeReport(["LIVE GOOGLE SHEET AUDIT REPORT", `Audit Timestamp : ${now.toISOString()}`,
      "Status : HANDSHAKE ONLY / WRITE-READBACK NOT VERIFIED",
      "No operational rows were written. Use --write-canaries to explicitly append identifiable audit rows.",
      "This is not an audit of every row or proof of historical completeness."], reportPath);
    return { ok: false, status: "WRITE_READBACK_NOT_REQUESTED", reportPath };
  }

  const nonce = crypto.randomBytes(8).toString("hex").toUpperCase();
  const canaryId = `K2CANARY_${now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${nonce}`;
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  const payloadHash = crypto.createHash("sha256").update(`${canaryId}|${now.toISOString()}|${expiresAt}`).digest("hex");
  const marker = `${canaryId}|${payloadHash}|EXPIRES:${expiresAt}`;

  const writes = [
    {
      tab: "K2_TRADE_LEDGER",
      write: () => appendTradeSignalsToGoogle([{
        id: canaryId, weekKey: now.toISOString().slice(0, 10), symbol: "AUDITCANARY",
        side: "long", action: payloadHash, entryPrice: 1, targetPrice: 1.01,
        stopLossPrice: 0.99, outcome: "AUDIT_CANARY_EXPIRES_24H"
      }])
    },
    {
      tab: "K2_PORTFOLIO_AUDIT",
      write: () => appendPortfolioAuditToGoogle([{
        symbol: canaryId, current: 1, pnlPct: 0, trailingStop: 0.99, target: 1.01,
        status: "AUDIT_CANARY_EXPIRES_24H", reason: payloadHash
      }])
    },
    {
      tab: "K2_MACRO_RADAR",
      write: () => appendMacroRadarToGoogle({
        regime: "AUDIT_CANARY", actionDirective: canaryId, summary: marker
      })
    },
    {
      tab: "K2_FUNDAMENTALS_BALANCE_SHEET",
      write: () => appendStockFundamentalsToGoogle([{
        weekKey: payloadHash, symbol: canaryId, balanceSheetScore: 0,
        metrics: {}, events: { nextEarningsDate: "AUDIT_CANARY_EXPIRES_24H", insideTradingWeek: false }
      }])
    }
  ];

  const auditResults = {};
  for (const item of writes) {
    try {
    const acknowledgement = await item.write();
    if (acknowledgement?.ok !== true || Number(acknowledgement.appended) !== 1) {
      auditResults[item.tab] = { ok: false, reason: "WRITE_NOT_ACKNOWLEDGED", acknowledgement };
      continue;
    }
    const readback = await readTabRowsFromGoogle({ tab: item.tab, limit: 500 });
    const row = (readback.rows || []).find((candidate) => {
      const cells = Array.isArray(candidate) ? candidate : Object.values(candidate || {});
      return cells.includes(canaryId) && (cells.includes(payloadHash) || cells.includes(marker));
    });
    auditResults[item.tab] = {
      ok: Boolean(readback.ok === true && row),
      totalRows: readback.totalRows,
      readCount: readback.count,
      canaryFound: Boolean(row),
      reason: row ? null : "CANARY_ID_OR_HASH_NOT_FOUND_IN_READBACK"
    };
    } catch {
      auditResults[item.tab] = { ok: false, reason: "WRITE_OR_READ_TRANSPORT_FAILURE" };
    }
  }

  const documentPath = `audit/canaries/${canaryId}.json`;
  const initial = await readGoogleDocument(documentPath, null);
  if (initial.etag !== null || initial.data !== null) throw new Error(`Canary document already exists: ${documentPath}`);
  const documentPayload = { canaryId, payloadHash, writtenAt: now.toISOString(), expiresAt };
  const written = await writeGoogleDocument(documentPath, documentPayload, null);
  const documentReadback = await readGoogleDocument(documentPath, null);
  auditResults.DOCUMENT_STORE = {
    ok: Boolean(written.etag && documentReadback.etag === written.etag
      && documentReadback.data?.canaryId === canaryId
      && documentReadback.data?.payloadHash === payloadHash
      && documentReadback.data?.writtenAt === documentPayload.writtenAt
      && documentReadback.data?.expiresAt === documentPayload.expiresAt),
    version: documentReadback.etag,
    reason: null
  };
  if (!auditResults.DOCUMENT_STORE.ok) auditResults.DOCUMENT_STORE.reason = "DOCUMENT_WRITE_READBACK_MISMATCH";

  const failed = Object.entries(auditResults).filter(([, result]) => !result.ok);
  const endpointFingerprint = crypto.createHash("sha256").update(options.store ? "TEST_DOUBLE_NOT_LIVE" : process.env.K2_GOOGLE_SHEETS_WEB_APP_URL).digest("hex").slice(0, 16);
  const lines = [
    "=".repeat(80),
    "LIVE GOOGLE SHEET AUDIT REPORT",
    "=".repeat(80),
    `Audit Timestamp      : ${now.toISOString()}`,
    `Status               : ${failed.length ? "FAILED" : "VERIFIED WRITE/READ-BACK"}`,
    `Service Version      : ${capabilities.version || "UNKNOWN"}`,
    `Endpoint Fingerprint : SHA256:${endpointFingerprint}`,
    `Canary ID            : ${canaryId}`,
    `Payload SHA256       : ${payloadHash}`,
    `Canary Expires       : ${expiresAt} (informational label; no automatic deletion)`,
    "Audit rows are marked AUDITCANARY / K2CANARY_; exclude them from every analytics consumer.",
    "Read-back scope: last 500 rows per tab, plus one document. Not every historical row.",
    ...(options.store ? ["TEST DOUBLE ONLY - THIS REPORT IS NOT LIVE EVIDENCE."] : []),
    "",
    "RECONCILIATION:",
    ...Object.entries(auditResults).map(([name, result]) =>
      `  ${name.padEnd(34)} ${result.ok ? "VERIFIED" : `FAILED (${result.reason || "unknown"})`}`
    ),
    "",
    failed.length
      ? "CONCLUSION: One or more live writes did not read back exactly. Production learning/storage remains blocked."
      : "CONCLUSION: This canary verified this endpoint at this timestamp only; it does not prove historical completeness or model correctness."
  ];
  writeReport(lines, reportPath);
  return {
    ok: failed.length === 0,
    status: failed.length ? "FAILED_READBACK" : "VERIFIED_WRITE_READBACK",
    canaryId,
    payloadHash,
    expiresAt,
    auditResults,
    reportPath
  };
}

if (require.main === module) {
  auditLiveSheet({ dryRun: process.argv.includes("--dry-run"), writeCanaries: process.argv.includes("--write-canaries") }).then((result) => {
    if (!result.ok) process.exitCode = 2;
    console.log(`Google Sheet audit status: ${result.status}; report: ${result.reportPath}`);
  }).catch((error) => {
    console.error("FATAL AUDIT ERROR:", error);
    process.exitCode = 1;
  });
}

module.exports = { REQUIRED_CAPABILITIES, auditLiveSheet, offlineReport };
