const { account, clearSessionCookie, clientIp, createSession, noStore, readSession, setSessionCookie, validCsrf, validOrigin, verifyPassword } = require("./_lib/security");
const { loginRate } = require("./_lib/store");

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

module.exports = async function handler(request, response) {
  noStore(response);
  response.setHeader("X-Content-Type-Options", "nosniff");

  if (request.method === "GET") {
    const session = readSession(request);
    if (!session) return response.status(401).json({ authenticated: false });
    return response.status(200).json({ authenticated: true, username: session.username, displayName: account(session.username).displayName, csrf: session.csrf });
  }

  if (request.method === "DELETE") {
    const session = readSession(request);
    if (!session || !validOrigin(request) || !validCsrf(request, session)) return response.status(403).json({ error: "Forbidden" });
    clearSessionCookie(response);
    return response.status(200).json({ ok: true });
  }

  if (request.method !== "POST") return response.status(405).json({ error: "Method not allowed" });
  if (!validOrigin(request)) return response.status(403).json({ error: "Forbidden" });

  const ip = clientIp(request);
  let body = request.body || {};
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const username = String(body.username || "").trim().toLowerCase().slice(0, 80);
  const password = String(body.password || "");
  const valid = verifyPassword(username, password);
  const rate = await loginRate(ip, !valid);
  if (!rate.allowed) {
    response.setHeader("Retry-After", String(rate.retryAfter));
    await delay(500);
    return response.status(429).json({ error: "Too many attempts. Try again later." });
  }
  await delay(400);
  if (!valid) return response.status(401).json({ error: "Username or password is incorrect." });

  const { token, session } = createSession(username);
  setSessionCookie(response, token);
  return response.status(200).json({ authenticated: true, username, displayName: account(username).displayName, csrf: session.csrf });
};
