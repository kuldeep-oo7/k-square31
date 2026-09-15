"use strict";

/**
 * Transport client to sync daily manual recommendations and audit outcomes
 * to the user's private Google Sheet via Apps Script Web App.
 */

/**
 * Synchronizes generated daily manual recommendations to Google Sheets.
 */
async function syncDailyRecommendationsToGoogleSheets({
  recommendations = [],
  webAppUrl = process.env.K2_GOOGLE_SHEETS_WEB_APP_URL,
  secret = process.env.K2_GOOGLE_SHEETS_ARCHIVE_SECRET
} = {}) {
  if (!Array.isArray(recommendations) || !recommendations.length) {
    return { ok: true, synced: 0, reason: "NO_RECOMMENDATIONS_TO_SYNC" };
  }

  if (!webAppUrl || !secret) {
    return {
      ok: false,
      unverified: true,
      synced: 0,
      error: "CREDENTIALS_NOT_CONFIGURED",
      message: "K2_GOOGLE_SHEETS_WEB_APP_URL or K2_GOOGLE_SHEETS_ARCHIVE_SECRET is not set."
    };
  }

  try {
    const response = await fetch(webAppUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "appendDailyRecommendations",
        secret,
        recommendations
      })
    });

    if (!response.ok) {
      return { ok: false, status: response.status, error: `HTTP_${response.status}` };
    }

    const data = await response.json();
    return { ok: Boolean(data && data.ok), ...data };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

/**
 * Synchronizes daily recommendation audit ledger to Google Sheets.
 */
async function syncRecommendationAuditToGoogleSheets({
  audit = null,
  webAppUrl = process.env.K2_GOOGLE_SHEETS_WEB_APP_URL,
  secret = process.env.K2_GOOGLE_SHEETS_ARCHIVE_SECRET
} = {}) {
  if (!audit) {
    return { ok: false, error: "AUDIT_RECORD_REQUIRED" };
  }

  if (!webAppUrl || !secret) {
    return {
      ok: false,
      unverified: true,
      error: "CREDENTIALS_NOT_CONFIGURED",
      message: "K2_GOOGLE_SHEETS_WEB_APP_URL or K2_GOOGLE_SHEETS_ARCHIVE_SECRET is not set."
    };
  }

  try {
    const response = await fetch(webAppUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "appendRecommendationAudit",
        secret,
        audit
      })
    });

    if (!response.ok) {
      return { ok: false, status: response.status, error: `HTTP_${response.status}` };
    }

    const data = await response.json();
    return { ok: Boolean(data && data.ok), ...data };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

module.exports = {
  syncDailyRecommendationsToGoogleSheets,
  syncRecommendationAuditToGoogleSheets
};
