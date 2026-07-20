const crypto = require("node:crypto");

const USERS = {
  "shah@kamlesh": {
    displayName: "Shah",
    salt: "d5adf8b0c82da869edfd2121d37ed530",
    hash: "6a5b2451e493dbe633d85317f2394a809698c52a8c32249ec1594718e66d3a67d3e433297f751b1a3816ede559de43ec162b9929c74fbfcf36973bddbc65a541"
  },
  "kuldeepoo7": {
    displayName: "Kuldeep",
    salt: "f14db2f0252d517ad308ced0dc940e90",
    hash: "9a930f85047c0a529997a1300d938ffda40127a78f4f4fc999ad049b18dfbdb08ea70aeacabd1a59691e18b537275ba49c6e552fa515c392216f786e0b87c750"
  },
  "ai": {
    displayName: "K² AI",
    salt: "3240bf8043bc50092ab98ee82fe808a3",
    hash: "5208137a95d9a7ec9cf332fc4b427ca47df5be342b13a07554a35387c347aab75cc1997502e68d2c7faccf97ceff5c45c2ef41b44d8d92f42c16f7a54dbf5001"
  }
};
const COOKIE = "__Host-k2_session";
const SESSION_MS = 24 * 60 * 60 * 1000;

function secret() {
  const source = process.env.K2_SESSION_SECRET || process.env.BLOB_READ_WRITE_TOKEN;
  if (!source && process.env.VERCEL) throw new Error("Server session secret is not configured");
  return crypto.createHash("sha256").update(source || "k2-local-development-only").digest();
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyPassword(username, password) {
  const account = USERS[username];
  if (!account || typeof password !== "string" || password.length > 128) return false;
  const source = process.env.K2_AUTH_PEPPER || process.env.BLOB_READ_WRITE_TOKEN;
  if (!source && process.env.VERCEL) throw new Error("Server authentication pepper is not configured");
  const pepper = crypto.createHash("sha256").update(source || "k2-local-development-only").digest("hex");
  const candidate = crypto.scryptSync(`${password}:${pepper}`, account.salt, 64).toString("hex");
  return safeEqual(candidate, account.hash);
}

function signature(payload) {
  return crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
}

function createSession(username) {
  const data = {
    username,
    expires: Date.now() + SESSION_MS,
    sessionId: crypto.randomUUID(),
    csrf: crypto.randomBytes(24).toString("base64url")
  };
  const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
  return { token: `${payload}.${signature(payload)}`, session: data };
}

function parseCookies(request) {
  const result = {};
  for (const part of String(request.headers?.cookie || "").split(";")) {
    const position = part.indexOf("=");
    if (position > 0) result[part.slice(0, position).trim()] = part.slice(position + 1).trim();
  }
  return result;
}

function readSession(request) {
  const [payload, supplied] = String(parseCookies(request)[COOKIE] || "").split(".");
  if (!payload || !supplied || !safeEqual(supplied, signature(payload))) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return session.expires > Date.now() && USERS[session.username] ? session : null;
  } catch {
    return null;
  }
}

function setSessionCookie(response, token) {
  response.setHeader("Set-Cookie", `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`);
}

function clearSessionCookie(response) {
  response.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
}

function validOrigin(request) {
  const origin = String(request.headers?.origin || "");
  const host = String(request.headers?.host || "");
  if (!origin) return false;
  return origin === `https://${host}` || ((host.startsWith("127.0.0.1") || host.startsWith("localhost")) && origin === `http://${host}`);
}

function validCsrf(request, session) {
  return Boolean(session?.csrf) && safeEqual(request.headers?.["x-k2-csrf"] || "", session.csrf);
}

function clientIp(request) {
  return String(request.headers?.["x-forwarded-for"] || request.socket?.remoteAddress || "unknown").split(",")[0].trim();
}

function account(username) {
  return USERS[username] || null;
}

function noStore(response) {
  response.setHeader("Cache-Control", "private, no-store, max-age=0");
  response.setHeader("Pragma", "no-cache");
}

module.exports = { account, clearSessionCookie, clientIp, createSession, noStore, readSession, safeEqual, setSessionCookie, validCsrf, validOrigin, verifyPassword };
