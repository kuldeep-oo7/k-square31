"use strict";

/**
 * Broker session management.
 *
 * The two brokers are not symmetric, and pretending otherwise would be the
 * kind of convenient fiction this codebase keeps having to remove.
 *
 * ANGEL ONE CAN BE FULLY UNATTENDED. Its login takes a client code, an MPIN and
 * a time-based one-time password, all of which a machine can produce from a
 * stored TOTP secret. The JWT it returns can then be rotated from the refresh
 * token indefinitely. Give it the secret once and it never needs a human again.
 *
 * UPSTOX CANNOT. It issues no refresh token -- Upstox staff say so plainly --
 * and every access token dies at 03:30 IST regardless of when it was minted. A
 * new one requires the OAuth consent dialog, which requires a browser and a
 * person. What this module does instead is know exactly when the token dies,
 * say so before it happens rather than after, and exchange an authorisation
 * code for a token in one command when you do log in.
 *
 * Automating the Upstox dialog with a headless browser would be possible and is
 * deliberately not done here: it means storing a full trading password, it
 * breaks silently on any login change, and it is the sort of thing that reads
 * as working right up until it authorises something nobody intended.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PRIVATE_DIR = path.resolve(path.join(__dirname, "..", "..", ".private"));
const CREDENTIALS_FILE = path.join(PRIVATE_DIR, "brokers.json");

/**
 * Where the credential file can live.
 *
 * Locally it is .private/brokers.json, which git never sees. On Render the
 * repository has no .private at all, and the platform's own answer to secrets
 * is Secret Files -- uploaded once through the dashboard and mounted at
 * /etc/secrets/<name>, or placed at the project root. Reading only the local
 * path meant the supported way to give a host its credentials silently did
 * nothing, and the only route left was retyping four values by hand.
 *
 * Order matters: the local file wins, because that is the one a developer is
 * actively editing and rotating sessions into.
 */
const CREDENTIAL_PATHS = [
  CREDENTIALS_FILE,
  "/etc/secrets/brokers.json",
  path.resolve(process.cwd(), "brokers.json")
];

/** The first credential file that exists, or null when none do. */
function credentialFile() {
  for (const candidate of CREDENTIAL_PATHS) {
    try { if (fs.existsSync(candidate)) return candidate; } catch (error) { /* unreadable is absent */ }
  }
  return null;
}

const ANGEL_ROOT = "https://apiconnect.angelone.in";
const UPSTOX_ROOT = "https://api.upstox.com/v2";

/**
 * RFC 6238 time-based one-time password.
 *
 * Implemented here rather than pulled in, because a dependency that can see a
 * TOTP secret is a dependency that can mint logins. It is thirty lines of HMAC.
 */
function base32Decode(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = String(secret || "").toUpperCase().replace(/[=\s-]/g, "");
  let bits = 0;
  let value = 0;
  const output = [];
  for (const character of clean) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error("TOTP secret is not valid base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

function totp(secret, { timestamp = Date.now(), step = 30, digits = 6 } = {}) {
  const key = base32Decode(secret);
  const counter = Math.floor(timestamp / 1000 / step);
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buffer.writeUInt32BE(counter >>> 0, 4);
  const digest = crypto.createHmac("sha1", key).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

function readStore() {
  const file = credentialFile();
  if (!file) return {};
  try { return JSON.parse(fs.readFileSync(file, "utf8")) || {}; }
  catch (error) { return {}; }
}

/** Persist a rotated token without disturbing anything else in the file. */
function writeSession(provider, session) {
  fs.mkdirSync(PRIVATE_DIR, { recursive: true });
  const store = readStore();
  store[provider] = { ...(store[provider] || {}), ...session };
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(store, null, 2));
  return store[provider];
}

function configFor(provider) {
  const store = readStore()[provider] || {};
  if (provider === "angelone") {
    return {
      apiKey: process.env.ANGELONE_API_KEY || store.apiKey || null,
      clientCode: process.env.ANGELONE_CLIENT_CODE || store.clientCode || null,
      mpin: process.env.ANGELONE_MPIN || store.mpin || store.password || null,
      totpSecret: process.env.ANGELONE_TOTP_SECRET || store.totpSecret || null,
      accessToken: process.env.ANGELONE_ACCESS_TOKEN || store.accessToken || null,
      refreshToken: store.refreshToken || null,
      issuedAt: store.issuedAt || null
    };
  }
  return {
    apiKey: process.env.UPSTOX_API_KEY || store.apiKey || null,
    apiSecret: process.env.UPSTOX_API_SECRET || store.apiSecret || null,
    redirectUri: process.env.UPSTOX_REDIRECT_URI || store.redirectUri || null,
    accessToken: process.env.UPSTOX_ACCESS_TOKEN || store.accessToken || null,
    issuedAt: store.issuedAt || null
  };
}

/**
 * Upstox tokens die at 03:30 IST, whenever they were minted. Knowing the exact
 * instant is what turns "it stopped working" into "it will stop working in two
 * hours", which is the difference between a warning and a postmortem.
 */
function upstoxTokenExpiry(now = new Date()) {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const expiry = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 3, 30, 0));
  if (expiry.getTime() <= ist.getTime()) expiry.setUTCDate(expiry.getUTCDate() + 1);
  return new Date(expiry.getTime() - IST_OFFSET_MS);
}

/** Angel One: mint a fresh session from the TOTP secret. Fully unattended. */
async function angelLogin({ timeoutMs = 20_000 } = {}) {
  const config = configFor("angelone");
  const missing = ["apiKey", "clientCode", "mpin", "totpSecret"].filter((field) => !config[field]);
  if (missing.length) {
    return { ok: false, provider: "angelone", reason: "INCOMPLETE_CREDENTIALS", missing, session: null };
  }
  let code;
  try { code = totp(config.totpSecret); }
  catch (error) { return { ok: false, provider: "angelone", reason: "BAD_TOTP_SECRET", detail: error.message, session: null }; }

  const response = await fetch(`${ANGEL_ROOT}/rest/auth/angelbroking/user/v1/loginByPassword`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json", Accept: "application/json",
      "X-UserType": "USER", "X-SourceID": "WEB", "X-PrivateKey": config.apiKey,
      "X-ClientLocalIP": "127.0.0.1", "X-ClientPublicIP": "127.0.0.1", "X-MACAddress": "00:00:00:00:00:00"
    },
    body: JSON.stringify({ clientcode: config.clientCode, password: config.mpin, totp: code }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch (error) { /* non-JSON */ }
  if (!response.ok || payload?.status === false) {
    return {
      ok: false, provider: "angelone", reason: `LOGIN_REJECTED_${response.status}`,
      message: payload?.message || text.slice(0, 200),
      // The commonest cause by far, and worth naming rather than guessing at.
      hint: "Check the MPIN and that the TOTP secret matches the authenticator enrolled on this account. TOTP is time-sensitive; a clock more than 30s out will fail.",
      session: null
    };
  }
  const data = payload?.data || {};
  if (!data.jwtToken) return { ok: false, provider: "angelone", reason: "NO_JWT_IN_RESPONSE", body: text.slice(0, 200), session: null };
  const session = {
    accessToken: data.jwtToken,
    refreshToken: data.refreshToken || null,
    feedToken: data.feedToken || null,
    issuedAt: new Date().toISOString()
  };
  writeSession("angelone", session);
  return { ok: true, provider: "angelone", rotated: "LOGIN", session };
}

/** Angel One: rotate the JWT from the refresh token, no TOTP needed. */
async function angelRefresh({ timeoutMs = 20_000 } = {}) {
  const config = configFor("angelone");
  if (!config.refreshToken || !config.apiKey) {
    return { ok: false, provider: "angelone", reason: "NO_REFRESH_TOKEN", session: null };
  }
  const response = await fetch(`${ANGEL_ROOT}/rest/auth/angelbroking/jwt/v1/generateTokens`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json", Accept: "application/json",
      "X-UserType": "USER", "X-SourceID": "WEB", "X-PrivateKey": config.apiKey,
      "X-ClientLocalIP": "127.0.0.1", "X-ClientPublicIP": "127.0.0.1", "X-MACAddress": "00:00:00:00:00:00",
      Authorization: `Bearer ${config.accessToken || ""}`
    },
    body: JSON.stringify({ refreshToken: config.refreshToken }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch (error) { /* non-JSON */ }
  if (!response.ok || !payload?.data?.jwtToken) {
    return { ok: false, provider: "angelone", reason: `REFRESH_REJECTED_${response.status}`, message: payload?.message || text.slice(0, 200), session: null };
  }
  const session = {
    accessToken: payload.data.jwtToken,
    feedToken: payload.data.feedToken || null,
    issuedAt: new Date().toISOString()
  };
  writeSession("angelone", session);
  return { ok: true, provider: "angelone", rotated: "REFRESH", session };
}

/**
 * Angel One: keep the session alive. Rotate from the refresh token when there
 * is one, fall back to a full TOTP login when there is not or when rotation is
 * rejected. This is genuinely unattended.
 */
async function angelEnsureSession() {
  const refreshed = await angelRefresh();
  if (refreshed.ok) return refreshed;
  return angelLogin();
}

/**
 * Upstox: exchange an authorisation code for an access token.
 *
 * The code comes from the consent dialog, which needs a browser once per day.
 * This is the whole of what can be automated; the dialog itself cannot be,
 * because Upstox issues no refresh token.
 */
async function upstoxExchangeCode(code, { timeoutMs = 20_000 } = {}) {
  const config = configFor("upstox");
  const missing = ["apiKey", "apiSecret", "redirectUri"].filter((field) => !config[field]);
  if (missing.length) return { ok: false, provider: "upstox", reason: "INCOMPLETE_CREDENTIALS", missing, session: null };
  if (!code) return { ok: false, provider: "upstox", reason: "NO_AUTHORIZATION_CODE", session: null };

  const body = new URLSearchParams({
    code: String(code),
    client_id: config.apiKey,
    client_secret: config.apiSecret,
    redirect_uri: config.redirectUri,
    grant_type: "authorization_code"
  });
  const response = await fetch(`${UPSTOX_ROOT}/login/authorization/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch (error) { /* non-JSON */ }
  if (!response.ok || !payload?.access_token) {
    return {
      ok: false, provider: "upstox", reason: `EXCHANGE_REJECTED_${response.status}`,
      message: payload?.errors?.[0]?.message || text.slice(0, 200),
      hint: "Authorisation codes expire in about five minutes. Generate a fresh one from the consent dialog.",
      session: null
    };
  }
  const session = { accessToken: payload.access_token, issuedAt: new Date().toISOString() };
  writeSession("upstox", session);
  return { ok: true, provider: "upstox", rotated: "AUTHORIZATION_CODE", session, expiresAt: upstoxTokenExpiry().toISOString() };
}

/** The consent URL a person opens once per day. */
function upstoxLoginUrl() {
  const config = configFor("upstox");
  if (!config.apiKey || !config.redirectUri) return null;
  return `${UPSTOX_ROOT}/login/authorization/dialog?client_id=${encodeURIComponent(config.apiKey)}&redirect_uri=${encodeURIComponent(config.redirectUri)}&response_type=code`;
}

/**
 * Session health for both providers, with the time remaining rather than a bare
 * boolean, so a warning can be raised before the desk goes quiet.
 */
function sessionStatus(now = new Date()) {
  const angel = configFor("angelone");
  const upstox = configFor("upstox");
  const expiry = upstoxTokenExpiry(now);
  const msLeft = expiry.getTime() - now.getTime();
  return {
    angelone: {
      hasToken: Boolean(angel.accessToken),
      canAutoRefresh: Boolean(angel.apiKey && angel.clientCode && angel.mpin && angel.totpSecret),
      hasRefreshToken: Boolean(angel.refreshToken),
      issuedAt: angel.issuedAt,
      mode: angel.totpSecret ? "UNATTENDED_TOTP" : "MANUAL",
      missing: ["apiKey", "clientCode", "mpin", "totpSecret"].filter((field) => !angel[field])
    },
    upstox: {
      hasToken: Boolean(upstox.accessToken),
      // Stated plainly so nobody builds a scheduler expecting one.
      canAutoRefresh: false,
      refreshTokenSupported: false,
      mode: "MANUAL_DAILY_OAUTH",
      expiresAt: expiry.toISOString(),
      hoursRemaining: Math.round((msLeft / 3_600_000) * 10) / 10,
      expiringSoon: msLeft < 2 * 3_600_000,
      loginUrl: upstoxLoginUrl(),
      note: "Upstox issues no refresh token; every access token dies at 03:30 IST and needs the consent dialog."
    }
  };
}

module.exports = {
  ANGEL_ROOT, CREDENTIALS_FILE, CREDENTIAL_PATHS, credentialFile, UPSTOX_ROOT,
  angelEnsureSession, angelLogin, angelRefresh,
  base32Decode, configFor, sessionStatus, totp,
  upstoxExchangeCode, upstoxLoginUrl, upstoxTokenExpiry, writeSession
};
