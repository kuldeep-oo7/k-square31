const fs = require("node:fs");
const crypto = require("node:crypto");
const { parseBrokerHtml } = require("./broker-html");

const file = process.argv[2];
const base = String(process.env.K2_IMPORT_URL || "https://k-square31.vercel.app").replace(/\/$/, "");
const username = process.env.K2_IMPORT_USERNAME;
const password = process.env.K2_IMPORT_PASSWORD;
if (!file) throw new Error("Provide a broker HTML/text file or JSON snapshot");
const source = fs.readFileSync(file, "utf8");
const isBrokerHtml = /<table\b/i.test(source) && /NSEFUT/i.test(source);
const htmlPositions = isBrokerHtml ? parseBrokerHtml(source) : null;
const openPnl = htmlPositions ? htmlPositions.reduce((sum, item) => sum + (item.markPrice - item.price) * item.quantity * (item.position === "short" ? -1 : 1), 0) : 0;
const brokerMtm = htmlPositions ? htmlPositions.reduce((sum, item) => sum + (Number(item.mtm) || 0), 0) : 0;
const snapshot = isBrokerHtml
  ? { snapshotId: `kamlesh-close-${crypto.createHash("sha256").update(source).digest("hex").slice(0, 16)}`, positions: htmlPositions, realizedPnl: Math.round((brokerMtm - openPnl) * 100) / 100 }
  : JSON.parse(source);
if (process.argv.includes("--preview")) {
  const longs = snapshot.positions.filter((item) => item.position === "long").length;
  const shorts = snapshot.positions.filter((item) => item.position === "short").length;
  const totalMtm = snapshot.positions.reduce((sum, item) => sum + (Number(item.mtm) || 0), 0);
  console.log(JSON.stringify({ snapshotId: snapshot.snapshotId, positions: snapshot.positions.length, longs, shorts, openPnl: Math.round(openPnl * 100) / 100, realizedPnl: snapshot.realizedPnl, totalMtm: Math.round(totalMtm * 100) / 100, first: snapshot.positions.slice(0, 3), last: snapshot.positions.slice(-3) }, null, 2));
  process.exit(0);
}
if (!username || !password) throw new Error("Provide K2_IMPORT_USERNAME and K2_IMPORT_PASSWORD");

async function json(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

(async () => {
  const origin = new URL(base).origin;
  const loginResponse = await fetch(`${base}/api/auth`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ username, password })
  });
  const login = await json(loginResponse);
  const setCookie = loginResponse.headers.get("set-cookie");
  if (!setCookie) throw new Error("Login did not return a session cookie");
  const cookie = setCookie.split(";")[0];
  const imported = await json(await fetch(`${base}/api/portfolio`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, Cookie: cookie, "X-K2-CSRF": login.csrf },
    body: JSON.stringify({ action: "replace-broker-futures", ...snapshot })
  }));
  const verified = await json(await fetch(`${base}/api/portfolio`, { headers: { Cookie: cookie } }));
  const expected = new Map(snapshot.positions.map((item) => [`${item.symbol}|${item.position}`, item]));
  assertSnapshot(verified.portfolio.lots, expected);
  const longs = verified.portfolio.lots.filter((lot) => lot.position === "long").length;
  const shorts = verified.portfolio.lots.filter((lot) => lot.position === "short").length;
  console.log(JSON.stringify({ imported: imported.portfolio.lots.length, verified: verified.portfolio.lots.length, longs, shorts, snapshotId: snapshot.snapshotId }));
})().catch((error) => { console.error(error.message); process.exit(1); });

function assertSnapshot(lots, expected) {
  if (lots.length !== expected.size) throw new Error(`Verification count mismatch: ${lots.length} != ${expected.size}`);
  for (const lot of lots) {
    const source = expected.get(`${lot.symbol}|${lot.position}`);
    if (!source || Number(lot.quantity) !== Number(source.quantity) || Number(lot.price) !== Number(source.price) || Number(lot.markPrice) !== Number(source.markPrice || source.price) || lot.expiry !== source.expiry || lot.assetType !== "future") {
      throw new Error(`Verification failed for ${lot.symbol}`);
    }
  }
}
