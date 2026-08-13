const crypto = require("node:crypto");
const { safeEqual } = require("./security");

const SCOPE = "gm-portfolio:write";
const TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
// Automatic GM synchronisation is authorised for this single K² account only.
const BRIDGE_USERNAME = "shah@kamlesh";

function signingKey() {
  const source = process.env.K2_BRIDGE_SIGNING_SECRET || process.env.K2_SESSION_SECRET || process.env.BLOB_READ_WRITE_TOKEN;
  if (!source && process.env.VERCEL) throw new Error("GM bridge signing secret is not configured");
  return crypto.createHash("sha256").update(source || "k2-local-gm-bridge-only").digest();
}

function signature(payload) {
  return crypto.createHmac("sha256", signingKey()).update(payload).digest("base64url");
}

function issueBridgeToken(username) {
  const claims = {
    username,
    scope: SCOPE,
    issuedAt: Date.now(),
    expires: Date.now() + TOKEN_LIFETIME_MS,
    deviceId: crypto.randomUUID()
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${signature(payload)}`;
}

function readBridgeToken(token) {
  const [payload, supplied] = String(token || "").split(".");
  if (!payload || !supplied || !safeEqual(supplied, signature(payload))) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (claims.scope !== SCOPE || claims.username !== BRIDGE_USERNAME || claims.expires <= Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

function bearerToken(request) {
  const match = String(request.headers?.authorization || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : "";
}

function readCloudBridgeToken(token) {
  const secret = String(process.env.K2_GM_CLOUD_SYNC_SECRET || "");
  if (secret.length < 32 || !safeEqual(String(token || ""), secret)) return null;
  return {
    username: BRIDGE_USERNAME,
    scope: SCOPE,
    issuedAt: Date.now(),
    expires: Date.now() + 5 * 60 * 1000,
    deviceId: "gm-cloud-worker"
  };
}

module.exports = { BRIDGE_USERNAME, bearerToken, issueBridgeToken, readBridgeToken, readCloudBridgeToken };
