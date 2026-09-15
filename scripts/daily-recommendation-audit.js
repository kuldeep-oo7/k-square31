"use strict";
const fs = require("node:fs"), path = require("node:path");
const { dailyRecommendationAudit, sha256 } = require("../api/_lib/daily-recommendation-audit");
const { googleStoreConfigured, readGoogleDocument, writeGoogleDocument, GoogleStoreConflictError } = require("../api/_lib/google-store");
const root = path.resolve(__dirname, "..");
function read(file, fallback = null) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { if (e.code === "ENOENT") return fallback; throw e; } }
async function run() {
  // Local credentials never appear in output or HTML.
  if (fs.existsSync(path.join(root, ".env.local"))) process.loadEnvFile(path.join(root, ".env.local"));
  const privateDir = path.join(root, ".private", "daily-recommendation-audits"); fs.mkdirSync(privateDir, { recursive: true });
  let evidence = read(path.join(root, ".private", "recommendation-evidence.json")), source = evidence ? "LOCAL_EVIDENCE_FILE" : "NO_EVIDENCE_FILE";
  if (googleStoreConfigured()) {
    const result = await readGoogleDocument("k2/manual-recommendations/evidence-v1.json", null);
    if (result.data) { evidence = result.data; source = "GOOGLE_EVIDENCE_DOCUMENT"; }
    else source = evidence ? "LOCAL_EVIDENCE_GOOGLE_DOCUMENT_ABSENT" : "GOOGLE_EVIDENCE_DOCUMENT_ABSENT";
  }
  if (evidence && (evidence.schemaVersion !== "recommendation-evidence-v1" || !Array.isArray(evidence.recommendations) || !Array.isArray(evidence.outcomes))) throw new Error("Evidence schema invalid; no audit result published");
  const previous = read(path.join(privateDir, "latest.json"));
  const report = { ...dailyRecommendationAudit({ recommendations: evidence?.recommendations || [], outcomes: evidence?.outcomes || [], previous }),
    source, googleConfigured: googleStoreConfigured(), automatedLearning: "HYPOTHESES_ONLY_NO_AUTOMATIC_STRATEGY_PROMOTION" };
  const digest = sha256({ source, evidence });
  // Content-addressed snapshots preserve every observed version; no rewritten wins.
  const snapshotFile = path.join(privateDir, `${report.session}-${digest}.json`);
  try { fs.writeFileSync(snapshotFile, JSON.stringify({ observedAt: report.auditedAt, source, evidence }, null, 2), { flag: "wx" }); }
  catch (e) { if (e.code !== "EEXIST") throw e; }
  fs.writeFileSync(path.join(privateDir, "latest.json.tmp"), JSON.stringify(report, null, 2));
  fs.renameSync(path.join(privateDir, "latest.json.tmp"), path.join(privateDir, "latest.json"));
  const lines = ["K2 DAILY RECOMMENDATION AUDIT", `As of: ${report.auditedAt}`, `Status: ${report.status}`, `Source: ${source}`,
    `Recommendations: ${report.recommendationCount}; accepted closed outcomes: ${report.acceptedOutcomes}; excluded: ${report.excludedOutcomes.length}`,
    "Automatic strategy/model changes: DISABLED", "", ...report.proposals.map((p) => `${p.id}\nWHY: ${p.why}\nNEXT TEST: ${p.nextTest}\n`),
    ...report.limitations, "", "Full diagnostic JSON is private; private P&L is not embedded in the public portal."];
  fs.writeFileSync(path.join(privateDir, `${report.session}.txt`), lines.join("\n") + "\n");
  if (process.argv.includes("--sync-google")) {
    if (!googleStoreConfigured()) throw new Error("Google sync requested but credentials unavailable");
    const snapshotPath = `k2/manual-recommendations/snapshots/${report.session}/${digest}.json`;
    try { await writeGoogleDocument(snapshotPath, { source, evidence }, null); }
    catch (e) {
      if (!(e instanceof GoogleStoreConflictError)) throw e;
      const old = await readGoogleDocument(snapshotPath, null);
      if (sha256(old.data) !== sha256({ source, evidence })) throw new Error("Immutable Google snapshot conflict");
    }
    const latestPath = "k2/manual-recommendations/latest-audit.json";
    const old = await readGoogleDocument(latestPath, null);
    await writeGoogleDocument(latestPath, report, old.etag);
  }
  const summary = { schemaVersion: report.schemaVersion, auditedAt: report.auditedAt, session: report.session, source,
    status: report.status, recommendationCount: report.recommendationCount, acceptedOutcomes: report.acceptedOutcomes,
    excludedOutcomeCount: report.excludedOutcomes.length, proposals: report.proposals, automaticModelPromotion: false,
    unchangedInputs: report.unchangedInputs, googleConfigured: report.googleConfigured };
  const target = path.join(root, "data", "daily-recommendation-status.json");
  fs.writeFileSync(`${target}.tmp`, JSON.stringify(summary, null, 2)); fs.renameSync(`${target}.tmp`, target);
  console.log(JSON.stringify(summary, null, 2));
}
if (require.main === module) run().catch((e) => { console.error(`Daily audit failed: ${e instanceof GoogleStoreConflictError ? "CONCURRENT_AUDIT_CONFLICT" : "INPUT_OR_STORAGE_FAILURE"}. No trading authority is granted.`); process.exitCode = 1; });
module.exports = { run };
