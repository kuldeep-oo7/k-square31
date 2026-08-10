const { issueBridgeToken, bearerToken, readBridgeToken } = require("./_lib/gm-bridge");
const { noStore, readSession, validCsrf, validOrigin } = require("./_lib/security");
const { mutatePortfolio } = require("./_lib/store");
const { cleanPortfolio, replaceBrokerSnapshot } = require("./_lib/portfolio-model");

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
    if (!session || session.username !== "shah@kamlesh") return response.status(403).json({ error: "Sign in to the Kamlesh K² account first" });
    if (!validOrigin(request) || !validCsrf(request, session)) return response.status(403).json({ error: "Forbidden" });
    return response.status(200).json({
      token: issueBridgeToken(session.username),
      username: session.username,
      intervalMinutes: 30
    });
  }

  const claims = readBridgeToken(bearerToken(request));
  if (!claims) return response.status(401).json({ error: "The GM bridge is not paired or its device token has expired" });
  if (body.action !== "sync-broker-portfolio") return response.status(400).json({ error: "Invalid bridge action" });

  const snapshotId = String(body.snapshotId || "");
  const positions = Array.isArray(body.positions) ? body.positions : [];
  const capturedAt = Date.parse(body.capturedAt || "");
  if (!/^[a-f0-9]{64}$/.test(snapshotId) || positions.length > 250 || !Number.isFinite(capturedAt) || capturedAt > Date.now() + 5 * 60 * 1000 || capturedAt < Date.now() - 7 * 24 * 60 * 60 * 1000) {
    return response.status(400).json({ error: "Invalid GM portfolio snapshot" });
  }

  try {
    let ignoredStale = false;
    const updated = await mutatePortfolio(claims.username, (portfolio) => {
      const previousCapture = Date.parse(portfolio?.brokerSync?.capturedAt || "");
      if (Number.isFinite(previousCapture) && previousCapture > capturedAt) {
        ignoredStale = true;
        return cleanPortfolio(portfolio);
      }
      return replaceBrokerSnapshot(portfolio, positions, snapshotId, undefined, {
        capturedAt: new Date(capturedAt).toISOString(),
        source: "gm-extension",
        deviceId: claims.deviceId
      });
    });
    const clean = cleanPortfolio(updated);
    return response.status(200).json({
      ok: true,
      username: claims.username,
      positions: clean.lots.length,
      updatedAt: clean.updatedAt,
      snapshotId: clean.brokerSync?.snapshotId || snapshotId,
      ignoredStale
    });
  } catch (error) {
    if (error.code === "SNAPSHOT") return response.status(400).json({ error: error.message });
    console.error("Automatic GM portfolio sync failed", error);
    return response.status(503).json({ error: "K² could not store the GM portfolio snapshot" });
  }
};
