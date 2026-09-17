"use strict";
const fs = require("node:fs"), path = require("node:path");
const finite = n => typeof n === "number" && Number.isFinite(n);
function parseTimestamp(value) { return finite(value) ? value : typeof value === "string" && value.trim() ? Date.parse(value) : NaN; }
function daysDifference(a, b) { return (b - a) / 86400000; }
function loadCorporateCalendar(customPath) {
  try { return JSON.parse(fs.readFileSync(customPath || path.join(__dirname, "../../data/corporate-events.json"), "utf8")); }
  catch { return { events: [], coverage: null, status: "UNAVAILABLE" }; }
}
function evaluateSentimentAndEventRisk({ symbol, assetClass = "DERIVATIVE", holdingSessions = 5, now = Date.now(),
  events = null, newsHeadlines = [], foBanList = [], coverage = {}, minEventBufferDays = 3 } = {}) {
  const clean = typeof symbol === "string" ? symbol.trim().toUpperCase() : "", flags = [];
  const t = parseTimestamp(now);
  if (!clean || !finite(t) || !Number.isInteger(holdingSessions) || holdingSessions < 1) flags.push("INVALID_INPUT");
  const validNow = finite(t) ? t : 0;
  const horizon = Math.max(minEventBufferDays, Math.ceil(holdingSessions * 7 / 5) + 2);
  for (const kind of ["events", "news", ...(assetClass === "CASH" ? [] : ["foBan"])]) {
    const c = coverage[kind], asOf = parseTimestamp(c?.asOf);
    const ageLimit = kind === "news" ? 15 * 60000 : 24 * 3600000;
    if (!c?.source || c.verified !== true || !finite(asOf) || asOf > validNow || validNow - asOf > ageLimit
        || (kind !== "foBan" && !c.symbols?.includes(clean))
        || (kind === "events" && !(parseTimestamp(c.completeThrough) >= validNow + horizon * 86400000))) flags.push(`${kind.toUpperCase()}_COVERAGE_UNVERIFIED`);
  }
  if (assetClass !== "CASH" && Array.isArray(foBanList) && foBanList.some(s => String(s).toUpperCase() === clean)) flags.push("FO_BAN_ACTIVE");
  const calendar = Array.isArray(events) ? events : loadCorporateCalendar().events || [];
  let nearest = null;
  for (const ev of calendar) {
    if (String(ev.symbol || "").toUpperCase() !== clean) continue;
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(ev.date || "");
    const at = parseTimestamp(dateOnly ? ev.date + "T23:59:59+05:30" : ev.date || ev.timestamp);
    const published = parseTimestamp(ev.publishedAt);
    if (!ev.source || !finite(at) || !finite(published) || published > validNow) { flags.push("EVENT_EVIDENCE_UNVERIFIED"); continue; }
    if (at >= validNow && (!nearest || at < nearest.at)) nearest = { at, type: ev.type || "CORPORATE_ACTION" };
    if (at >= validNow && at - validNow <= horizon * 86400000) flags.push("CORPORATE_EVENT_WITHIN_HOLDING_BUFFER");
  }
  let positive = 0, negative = 0, ignored = 0;
  const seen = new Set();
  for (const item of Array.isArray(newsHeadlines) ? newsHeadlines : []) {
    if (!item || typeof item !== "object") { ignored++; continue; }
    const at = parseTimestamp(item.publishedAt), id = item.id || item.url;
    if (!id || seen.has(id) || !item.source || !item.symbols?.includes(clean) || !finite(at) || at > validNow || validNow - at > 86400000) { ignored++; continue; }
    seen.add(id);
    const text = String(item.title || item.headline || "");
    if (/\b(fraud|investigation|default|insolvency|downgrade|probe|raid)\b/i.test(text)) negative++;
    if (/\b(record profit|upgrade|order win|capacity expansion|buyback)\b/i.test(text)) positive++;
  }
  if (negative) flags.push("NEGATIVE_NEWS_REQUIRES_REVIEW");
  const unverified = flags.some(f => /UNVERIFIED|INVALID/.test(f)), blocked = flags.length > 0;
  return { symbol: clean, status: unverified ? "UNKNOWN" : blocked ? "VETOED" : "CHECKED_NO_LISTED_FLAGS",
    allowedToTrade: !blocked, reason: blocked ? [...new Set(flags)].join(", ") : "No listed flags in supplied verified coverage; not a safety guarantee",
    riskFlags: [...new Set(flags)], eventProximityDays: nearest ? daysDifference(validNow, nearest.at) : null,
    eventType: nearest?.type || null, sentimentScore: positive + negative ? (positive - negative) / (positive + negative) : null,
    sentimentLabel: negative ? "RISK_REVIEW" : positive ? "POSITIVE_KEYWORD_OBSERVATION" : "NO_SCORED_NEWS",
    ignoredHeadlines: ignored, evaluatedAt: finite(t) ? new Date(t).toISOString() : null,
    limitations: ["Lexicon is a conservative review flag, not an ML model or calibrated return predictor.",
      "Calendar buffer approximates sessions; verified exchange holidays are needed for exact holding windows."] };
}
module.exports = { evaluateSentimentAndEventRisk, loadCorporateCalendar, parseTimestamp, daysDifference };
