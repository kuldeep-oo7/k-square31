const { gzipSync, gunzipSync } = require("node:zlib");

const GOOGLE_STORE_TIMEOUT_MS = 30_000;

class GoogleStoreConflictError extends Error {
  constructor(message = "Google Sheets document changed") {
    super(message);
    this.name = "GoogleStoreConflictError";
    this.status = 409;
  }
}

/** Loopback only. Nothing else may drop TLS. */
function isLoopback(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}

function googleStoreConfigured() {
  try {
    const url = new URL(process.env.K2_GOOGLE_SHEETS_WEB_APP_URL);
    if (url.username || url.password) return false;
    if (!process.env.K2_GOOGLE_SHEETS_ARCHIVE_SECRET) return false;
    // The shared secret travels in the request body, so TLS is required for
    // anything that leaves this machine. Plain http is accepted ONLY for
    // loopback, where nothing is on the wire to intercept -- without that
    // exception the backup path cannot be exercised locally at all, which is
    // exactly why it shipped having never once run.
    return url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname));
  } catch { return false; }
}

function encodeDocument(data) {
  return gzipSync(Buffer.from(JSON.stringify(data), "utf8"), { level: 9 }).toString("base64");
}

function decodeDocument(encoded) {
  return JSON.parse(gunzipSync(Buffer.from(String(encoded || ""), "base64")).toString("utf8"));
}

/**
 * Strip the account selector from an Apps Script web app URL.
 *
 * Google shows a deployment as .../macros/u/1/s/<id>/exec while you are signed
 * in, where u/1 identifies WHICH signed-in account is viewing. Copied into a
 * server's configuration that URL returns 404 for every request: there is no
 * browser session, so there is no account 1. Measured, not assumed -- the two
 * forms were tested against the same live deployment and only the canonical one
 * answered.
 *
 * The failure is silent in the worst way. The deploy is green, the variable
 * looks right, and every backup fails with a 404 nobody reads, so the gap is
 * discovered on the day the ledger is needed back. Normalising here costs
 * nothing and removes the whole class.
 */
function canonicalWebAppUrl(raw) {
  return String(raw || "").replace(/\/macros\/u\/\d+\/s\//, "/macros/s/");
}

/**
 * RETRY THE TRANSPORT, NEVER THE REJECTION.
 *
 * Observed on the live host on 2026-09-22: the first real WRITE this archive had
 * ever been asked to do came back "fetch failed" -- Node's generic wrapper for a
 * network-layer failure, distinct from a timeout and distinct from anything the
 * Apps Script itself said. Reads had always worked, so the transport looked
 * proven when only half of it was.
 *
 * Apps Script bounces every POST through a redirect to a second host, and a
 * 512 MB container that has just computed two hundred volatility surfaces is not
 * always in a fit state to complete one. A single attempt turns a transient
 * hiccup into a lost session, and a lost session on a counter that needs thirty
 * of them is not recoverable later.
 *
 * So a transport failure is retried with backoff. A REJECTION is not: a conflict
 * or a refusal from the script is an answer, and asking again would either
 * duplicate a write or hammer a service that has already said no.
 */
async function requestGoogle(action, payload = {}, { attempts = 3 } = {}) {
  if (!googleStoreConfigured()) throw new Error("Google Sheets operational store is not configured");
  const body = JSON.stringify({
    secret: process.env.K2_GOOGLE_SHEETS_ARCHIVE_SECRET,
    action,
    ...payload
  });

  let lastError = null;
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
    try {
      const response = await fetch(canonicalWebAppUrl(process.env.K2_GOOGLE_SHEETS_WEB_APP_URL), {
        method: "POST",
        redirect: "follow",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body,
        signal: AbortSignal.timeout(GOOGLE_STORE_TIMEOUT_MS)
      });
      if (!response.ok) throw new Error(`Google Sheets store returned ${response.status}`);
      const result = await response.json();
      if (!result?.ok) {
        // An answer, not a transport fault. Do not try again.
        if (result?.code === "CONFLICT") throw new GoogleStoreConflictError(result.error);
        throw new Error(result?.error || "Google Sheets store rejected the request");
      }
      return result;
    } catch (error) {
      // Anything the script or the protocol SAID is final.
      if (error instanceof GoogleStoreConflictError) throw error;
      if (/returned \d{3}/.test(error.message) || /rejected the request/.test(error.message)) throw error;
      // "fetch failed" is Node's opaque wrapper. The reason it actually failed
      // -- ECONNRESET, ETIMEDOUT, EPROTO, a DNS fault -- is on error.cause, and
      // without it a diagnosis is guesswork. Three deploys were spent guessing.
      const cause = error?.cause;
      const detail = cause
        ? `${cause.code || cause.name || "cause"}${cause.message && cause.message !== error.message ? ": " + cause.message : ""}`
        : null;
      error.k2Detail = detail ? `${error.message} (${detail})` : error.message;
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
      }
    }
  }
  throw new Error(`${lastError?.k2Detail || lastError?.message || "unknown transport failure"} after ${attempts} attempts`);
}

async function readGoogleDocuments(entries) {
  if (!entries.length) return [];
  const result = await requestGoogle("readDocuments", {
    paths: entries.map((entry) => entry.pathname)
  });
  const documents = new Map((result.documents || []).map((document) => [document.path, document]));
  return entries.map(({ pathname, fallback }) => {
    const document = documents.get(pathname);
    if (!document?.found) return { data: structuredClone(fallback), etag: null };
    return { data: decodeDocument(document.encoded), etag: String(document.version) };
  });
}

async function readGoogleDocument(pathname, fallback) {
  return (await readGoogleDocuments([{ pathname, fallback }]))[0];
}

async function writeGoogleDocument(pathname, data, etag) {
  const result = await requestGoogle("writeDocument", {
    path: pathname,
    expectedVersion: etag ? Number(etag) : 0,
    encoding: "gzip-base64",
    encoded: encodeDocument(data)
  });
  return { etag: String(result.version) };
}

async function appendTradeSignalsToGoogle(signals) {
  if (!googleStoreConfigured() || !Array.isArray(signals) || !signals.length) return { ok: false, appended: 0 };
  return requestGoogle("appendTradeSignals", { signals });
}

async function appendPortfolioAuditToGoogle(holdings) {
  if (!googleStoreConfigured() || !Array.isArray(holdings) || !holdings.length) return { ok: false, appended: 0 };
  return requestGoogle("appendPortfolioAudit", { holdings });
}

async function appendMacroRadarToGoogle(radar) {
  if (!googleStoreConfigured() || !radar) return { ok: false, appended: 0 };
  return requestGoogle("appendMacroRadar", { radar });
}

async function appendStockFundamentalsToGoogle(fundamentals) {
  if (!googleStoreConfigured() || !fundamentals) return { ok: false, appended: 0 };
  return requestGoogle("appendStockFundamentals", { fundamentals });
}

/**
 * The order tickets for the day, appended to the tab the phone reads.
 *
 * The Apps Script has supported this action since it was written; nothing on
 * this side ever called it, so the tab it fills has been empty the whole time.
 * That is the gap this closes -- no redeploy of the script is needed, only a
 * caller.
 */
async function appendDailyRecommendationsToGoogle(recommendations) {
  if (!googleStoreConfigured() || !Array.isArray(recommendations) || !recommendations.length) {
    return { ok: false, appended: 0 };
  }
  return requestGoogle("appendDailyRecommendations", { recommendations });
}

async function appendRecommendationAuditToGoogle(audit) {
  if (!googleStoreConfigured() || !audit) return { ok: false, appended: 0 };
  return requestGoogle("appendRecommendationAudit", { audit });
}

/**
 * Does the DEPLOYED Apps Script know this action?
 *
 * The .gs file in this repository is not necessarily the .gs that is deployed;
 * a web app serves the version that was published, and publishing is a manual
 * step somebody has to remember. appendDailyRecommendations has existed in the
 * source since it was written and has never once been called, so there is no
 * evidence either way about the live deployment.
 *
 * An empty payload settles it without writing anything: a current deployment
 * answers ok with nothing appended, a stale one answers "Invalid action".
 */
async function probeGoogleAction(action) {
  if (!googleStoreConfigured()) return { supported: false, reason: "not configured" };
  try {
    await requestGoogle(action, { recommendations: [], signals: [], holdings: [] }, { attempts: 1 });
    return { supported: true, reason: null };
  } catch (error) {
    if (/Invalid action/i.test(error.message)) return { supported: false, reason: "the deployed Apps Script does not have this action" };
    return { supported: null, reason: error.message };
  }
}

async function listGoogleTabs() {
  if (!googleStoreConfigured()) throw new Error("Google Sheets operational store is not configured");
  return requestGoogle("listTabs", {});
}

async function queryGoogleCapabilities() {
  if (!process.env.K2_GOOGLE_SHEETS_WEB_APP_URL) return { ok: false, error: "URL not configured" };
  const response = await fetch(canonicalWebAppUrl(process.env.K2_GOOGLE_SHEETS_WEB_APP_URL), {
    method: "GET",
    redirect: "follow",
    signal: AbortSignal.timeout(GOOGLE_STORE_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`Google Sheets capabilities query returned ${response.status}`);
  return response.json();
}

async function readTabRowsFromGoogle({ tab, limit = 100, offset }) {
  if (!googleStoreConfigured()) throw new Error("Google Sheets operational store is not configured");
  return requestGoogle("readTabRows", { tab, limit, ...(offset === undefined ? {} : { offset }) });
}

module.exports = {
  canonicalWebAppUrl,
  GoogleStoreConflictError,
  appendMacroRadarToGoogle,
  appendPortfolioAuditToGoogle,
  appendDailyRecommendationsToGoogle,
  appendRecommendationAuditToGoogle,
  appendStockFundamentalsToGoogle,
  appendTradeSignalsToGoogle,
  listGoogleTabs,
  probeGoogleAction,
  decodeDocument,
  encodeDocument,
  googleStoreConfigured,
  queryGoogleCapabilities,
  readGoogleDocument,
  readGoogleDocuments,
  readTabRowsFromGoogle,
  writeGoogleDocument
};
