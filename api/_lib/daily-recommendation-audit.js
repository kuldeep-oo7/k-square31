"use strict";
const crypto = require("node:crypto");
const { sessionDate } = require("./indian-instruments");
const number = (v) => typeof v === "number" && Number.isFinite(v);
const time = (v) => typeof v === "number" ? (Number.isFinite(v) ? v : NaN) : typeof v === "string" && v.trim() ? Date.parse(v) : NaN;
const round = (v) => number(v) ? Math.round(v * 10000) / 10000 : null;
function sha256(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function wilson(wins, n) {
  if (!n) return null;
  const z = 1.95996398454, p = wins / n, den = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / den;
  const radius = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den;
  return [round(Math.max(0, center - radius) * 100), round(Math.min(1, center + radius) * 100)];
}
function dailyRecommendationAudit({ recommendations = [], outcomes = [], now = Date.now(), previous = null } = {}) {
  if (!Array.isArray(recommendations) || !Array.isArray(outcomes) || !number(now)) throw new Error("Audit input schema invalid");
  const findings = [], byId = new Map(), excluded = [], accepted = [];
  const invalidIds = new Set();
  for (const r of recommendations) {
    if (!r?.id || !r.strategyVersion || !Number.isFinite(time(r.issuedAt)) || time(r.issuedAt) > now) {
      findings.push({ code: "INVALID_RECOMMENDATION", id: r?.id || null }); if (r?.id) invalidIds.add(r.id); continue;
    }
    if (byId.has(r.id)) { invalidIds.add(r.id); findings.push({ code: "DUPLICATE_RECOMMENDATION_ID", id: r.id }); }
    byId.set(r.id, r);
  }
  const counts = new Map();
  for (const o of outcomes) if (o?.recommendationId) counts.set(o.recommendationId, (counts.get(o.recommendationId) || 0) + 1);
  for (const o of outcomes) {
    const r = byId.get(o?.recommendationId), reasons = [];
    if (!r || invalidIds.has(o?.recommendationId)) reasons.push("NO_UNIQUE_ORIGINAL_RECOMMENDATION");
    if (counts.get(o?.recommendationId) > 1) reasons.push("DUPLICATE_OUTCOME_REQUIRES_RECONCILIATION");
    if (o?.status !== "CLOSED") reasons.push("NOT_CLOSED");
    if (!["USER_CONFIRMED", "BROKER_RECONCILED", "SHADOW_RECONCILED"].includes(o?.source)) reasons.push("UNCONFIRMED_OUTCOME");
    if (!o?.entryFillId || !o?.exitFillId) reasons.push("FILL_EVIDENCE_MISSING");
    const filled = time(o?.filledAt), exited = time(o?.exitAt);
    if (!Number.isFinite(filled) || !Number.isFinite(exited) || filled < time(r?.issuedAt) || exited < filled || exited > now) reasons.push("INVALID_OUTCOME_TIMELINE");
    if (![o?.grossPnlInr, o?.feesInr, o?.netPnlInr].every(number) || o.feesInr < 0 || Math.abs(o.grossPnlInr - o.feesInr - o.netPnlInr) > 0.02) reasons.push("AFTER_COST_PNL_DOES_NOT_RECONCILE");
    if (reasons.length) excluded.push({ recommendationId: o?.recommendationId || null, reasons }); else accepted.push(o);
  }
  // Keep paper and user-confirmed results distinct from broker-reconciled trades.
  const groups = {};
  for (const source of ["USER_CONFIRMED", "BROKER_RECONCILED", "SHADOW_RECONCILED"]) {
    const rows = accepted.filter((o) => o.source === source), n = rows.length;
    const returns = rows.map((o) => o.netPnlInr).sort((a, b) => a - b);
    const wins = returns.filter((pnl) => pnl > 0).length;
    const dates = new Set(rows.map((o) => sessionDate(time(o.exitAt))));
    groups[source] = { completedTrades: n, distinctExitSessions: dates.size, wins,
      losses: returns.filter((pnl) => pnl < 0).length, breakeven: returns.filter((pnl) => pnl === 0).length,
      netPnlInr: n ? round(returns.reduce((a, b) => a + b, 0)) : null,
      averageNetPnlPerTradeInr: n ? round(returns.reduce((a, b) => a + b, 0) / n) : null,
      winRatePct: n ? round(wins / n * 100) : null,
      descriptiveWilsonIntervalPct: wilson(wins, n),
      uncertaintyWarning: "Wilson interval assumes independent trials; correlated trades need date-block inference before promotion.",
      worstNetTradeInr: n ? returns[0] : null };
  }
  const proposals = [];
  if (!accepted.length) proposals.push({ id: "COLLECT_CONFIRMED_OUTCOMES", why: "No mature verified outcomes to learn from", nextTest: "Join issued signal to both fills and reconciled fees; do not guess execution from price touch" });
  if (excluded.length || findings.length) proposals.push({ id: "REPAIR_EVIDENCE_INTEGRITY", why: "Invalid, duplicate or unconfirmed evidence is excluded", nextTest: "Reconcile original record; preserve old versions and correction reason" });
  if (accepted.length) proposals.push({ id: "CHALLENGER_RESEARCH", why: "Completed outcomes can inform hypotheses, not automatic weight changes", nextTest: "Pre-register challenger; purged date-block validation, after-cost/tail/capacity comparison, new prospective holdout" });
  const inputHash = sha256({ recommendations, outcomes });
  return { schemaVersion: "daily-recommendation-audit-v1", auditedAt: new Date(now).toISOString(), session: sessionDate(now), inputHash,
    status: accepted.length ? "DESCRIPTIVE_REVIEW_ONLY" : "NO_MATURE_VERIFIED_OUTCOMES", automaticModelPromotion: false,
    recommendationCount: recommendations.length, validatedOriginalCount: byId.size - [...invalidIds].filter((id) => byId.has(id)).length,
    acceptedOutcomes: accepted.length, excludedOutcomes: excluded, findings, groups, proposals,
    unchangedInputs: previous?.inputHash === inputHash,
    newlyClosedCount: previous?.acceptedOutcomeIds ? accepted.filter((o) => !previous.acceptedOutcomeIds.includes(o.recommendationId)).length : accepted.length,
    acceptedOutcomeIds: accepted.map((o) => o.recommendationId).sort(),
    limitations: ["No retraining, code changes, orders, recommendation promotion or profit guarantee occurs in this audit.",
      "Open/unfilled trades are not losses or wins. Future/unconfirmed/duplicate outcomes do not train anything.",
      "Realized trade P&L is not full account drawdown. Open positions and capital cashflows require separate reconciliation.",
      "User-confirmed results are self-reported, not independently broker-verified."] };
}
module.exports = { dailyRecommendationAudit, sha256 };
