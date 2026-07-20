const fs = require("node:fs");

const file = process.argv[2];
const base = String(process.env.K2_IMPORT_URL || "https://k-square31.vercel.app").replace(/\/$/, "");
const username = process.env.K2_IMPORT_USERNAME;
const password = process.env.K2_IMPORT_PASSWORD;
if (!file || !username || !password) throw new Error("Provide a snapshot file plus K2_IMPORT_USERNAME and K2_IMPORT_PASSWORD");
const snapshot = JSON.parse(fs.readFileSync(file, "utf8"));

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
    if (!source || Number(lot.quantity) !== Number(source.quantity) || Number(lot.price) !== Number(source.price) || lot.expiry !== source.expiry || lot.assetType !== "future") {
      throw new Error(`Verification failed for ${lot.symbol}`);
    }
  }
}
