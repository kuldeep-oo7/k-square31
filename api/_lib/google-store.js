const { gzipSync, gunzipSync } = require("node:zlib");

const GOOGLE_STORE_TIMEOUT_MS = 30_000;

class GoogleStoreConflictError extends Error {
  constructor(message = "Google Sheets document changed") {
    super(message);
    this.name = "GoogleStoreConflictError";
    this.status = 409;
  }
}

function googleStoreConfigured() {
  return Boolean(process.env.K2_GOOGLE_SHEETS_WEB_APP_URL && process.env.K2_GOOGLE_SHEETS_ARCHIVE_SECRET);
}

function encodeDocument(data) {
  return gzipSync(Buffer.from(JSON.stringify(data), "utf8"), { level: 9 }).toString("base64");
}

function decodeDocument(encoded) {
  return JSON.parse(gunzipSync(Buffer.from(String(encoded || ""), "base64")).toString("utf8"));
}

async function requestGoogle(action, payload = {}) {
  if (!googleStoreConfigured()) throw new Error("Google Sheets operational store is not configured");
  const response = await fetch(process.env.K2_GOOGLE_SHEETS_WEB_APP_URL, {
    method: "POST",
    redirect: "follow",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({
      secret: process.env.K2_GOOGLE_SHEETS_ARCHIVE_SECRET,
      action,
      ...payload
    }),
    signal: AbortSignal.timeout(GOOGLE_STORE_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`Google Sheets store returned ${response.status}`);
  const result = await response.json();
  if (!result?.ok) {
    if (result?.code === "CONFLICT") throw new GoogleStoreConflictError(result.error);
    throw new Error(result?.error || "Google Sheets store rejected the request");
  }
  return result;
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

module.exports = {
  GoogleStoreConflictError,
  decodeDocument,
  encodeDocument,
  googleStoreConfigured,
  readGoogleDocument,
  readGoogleDocuments,
  writeGoogleDocument
};
