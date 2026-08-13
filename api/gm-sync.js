const { BRIDGE_USERNAME, issueBridgeToken, bearerToken, readBridgeToken, readCloudBridgeToken } = require("./_lib/gm-bridge");
const { noStore, readSession, validCsrf, validOrigin } = require("./_lib/security");
const { applyBrokerSnapshot } = require("./_lib/gm-snapshot");

function bridgeHeaders(response) {
  noStore(response);
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-K2-CSRF");
  response.setHeader("Access-Control-Max-Age", "86400");
  response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}

function bodyOf(request) {
  if (request.body && typeof request.body === "object") return request.body;
  try { return JSON.parse(request.body || "{}"); } catch { return {}; }
}

module.exports = async function handler(request, response) {
  bridgeHeaders(response);
  if (request.method === "OPTIONS") return response.status(204).end();
  if (request.method !== "POST") return response.status(405).json({ error: "Method not allowed" });

  const body = bodyOf(request);
  if (body.action === "issue-device-token") {
    const session = readSession(request);
    if (!session || session.username !== BRIDGE_USERNAME) return response.status(403).json({ error: "Sign in to the Kamlesh K² account first" });
    if (!validOrigin(request) || !validCsrf(request, session)) return response.status(403).json({ error: "Forbidden" });
    return response.status(200).json({
      token: issueBridgeToken(session.username),
      username: session.username,
      intervalMinutes: 30
    });
  }

  const suppliedToken = bearerToken(request);
  const claims = readBridgeToken(suppliedToken) || readCloudBridgeToken(suppliedToken);
  if (!claims) return response.status(401).json({ error: "The GM bridge is not paired or its device token has expired" });
  if (body.action !== "sync-broker-portfolio") return response.status(400).json({ error: "Invalid bridge action" });

  try {
    const result = await applyBrokerSnapshot(claims.username, body, {
      source: claims.deviceId === "gm-cloud-worker" ? "gm-cloud" : "gm-extension",
      deviceId: claims.deviceId
    });
    return response.status(200).json({
      ok: true,
      username: claims.username,
      positions: result.positions,
      updatedAt: result.updatedAt,
      snapshotId: result.snapshotId,
      ignoredStale: result.ignoredStale
    });
  } catch (error) {
    if (error.code === "SNAPSHOT") return response.status(400).json({ error: error.message });
    console.error("Automatic GM portfolio sync failed", error);
    return response.status(503).json({ error: "K² could not store the GM portfolio snapshot" });
  }
};
