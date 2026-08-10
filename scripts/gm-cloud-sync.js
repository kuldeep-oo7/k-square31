"use strict";

const crypto = require("node:crypto");
const bridge = require("../extensions/gm-k2-bridge/core.js");

const GM_ORIGIN = "https://gmglobal.org";
const GM_LOGIN_URL = `${GM_ORIGIN}/ajaxfiles/logincheck.php`;
const GM_CHECK_URL = `${GM_ORIGIN}/ajaxfiles/check_login.php`;
const GM_LINKED_ACCOUNTS_URL = `${GM_ORIGIN}/ajaxfiles/view_login_map_account.php`;
const GM_LOGIN_LINKED_URL = `${GM_ORIGIN}/ajaxfiles/login_into_mapped_account.php`;
const GM_PORTFOLIO_URL = `${GM_ORIGIN}/datatables/position_book_list.php`;
const K2_SYNC_URL = process.env.K2_GM_SYNC_URL || "https://k-square31.vercel.app/api/gm-sync";

class CookieJar {
  constructor() { this.values = new Map(); }
  add(response) {
    const values = typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);
    values.forEach((entry) => {
      const pair = String(entry || "").split(";", 1)[0];
      const separator = pair.indexOf("=");
      if (separator > 0) this.values.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
    });
  }
  header() { return [...this.values].map(([name, value]) => `${name}=${value}`).join("; "); }
}

function gmHeaders(jar, extra = {}) {
  return {
    "Accept": "application/json, text/plain, */*",
    "Origin": GM_ORIGIN,
    "Referer": `${GM_ORIGIN}/#/Portfolio`,
    "User-Agent": "K2-GM-ReadOnly-Cloud-Sync/1.0",
    ...(jar.header() ? { "Cookie": jar.header() } : {}),
    ...extra
  };
}

function positionForm() {
  const form = new URLSearchParams({
    sEcho: "1",
    iColumns: "12",
    sColumns: "",
    iDisplayStart: "0",
    iDisplayLength: "-1",
    sSearch: "",
    bRegex: "false",
    iSortingCols: "1",
    iSortCol_0: "0",
    sSortDir_0: "asc",
    broker_id: "",
    master_user_id: "",
    user_id: "",
    script_id: "",
    market_type_id: "",
    all_outstanding: "1",
    group_by: "t.script_name",
    expiry_date: ""
  });
  for (let index = 0; index < 12; index += 1) {
    form.set(`mDataProp_${index}`, String(index));
    form.set(`sSearch_${index}`, "");
    form.set(`bRegex_${index}`, "false");
    form.set(`bSearchable_${index}`, "true");
    form.set(`bSortable_${index}`, index < 3 ? "true" : "false");
  }
  return form;
}

function fingerprint(positions) {
  const canonical = positions.map((item) => ({
    symbol: item.symbol,
    position: item.position,
    expiry: item.expiry,
    quantity: item.quantity,
    price: item.price,
    buyQuantity: item.buyQuantity || 0,
    buyAverage: item.buyAverage || 0,
    sellQuantity: item.sellQuantity || 0,
    sellAverage: item.sellAverage || 0
  })).sort((left, right) => `${left.symbol}|${left.expiry}|${left.position}`.localeCompare(`${right.symbol}|${right.expiry}|${right.position}`));
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

async function responseJson(response, label) {
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error(`${label} returned an unreadable response`); }
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
  return payload;
}

async function loginSession(username, password) {
  const jar = new CookieJar();
  const landing = await fetch(`${GM_ORIGIN}/#/Login`, {
    headers: { "Accept": "text/html", "User-Agent": "K2-GM-ReadOnly-Cloud-Sync/1.0" },
    redirect: "follow",
    signal: AbortSignal.timeout(45_000)
  });
  jar.add(landing);

  const loginResponse = await fetch(GM_LOGIN_URL, {
    method: "POST",
    headers: gmHeaders(jar, { "Content-Type": "application/json;charset=UTF-8", "X-Requested-With": "XMLHttpRequest" }),
    body: JSON.stringify({ username, password }),
    redirect: "manual",
    signal: AbortSignal.timeout(45_000)
  });
  jar.add(loginResponse);
  const login = await responseJson(loginResponse, "GM login");
  if (String(login?.status || "").toLowerCase() !== "ok") throw new Error("GM rejected the configured cloud credentials");

  const checkResponse = await fetch(GM_CHECK_URL, {
    headers: gmHeaders(jar, { "X-Requested-With": "XMLHttpRequest" }),
    signal: AbortSignal.timeout(45_000)
  });
  jar.add(checkResponse);
  if (!checkResponse.ok) throw new Error(`GM session verification returned HTTP ${checkResponse.status}`);
  return jar;
}

async function requestPortfolio(jar) {
  const portfolioResponse = await fetch(GM_PORTFOLIO_URL, {
    method: "POST",
    headers: gmHeaders(jar, { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest" }),
    body: positionForm(),
    signal: AbortSignal.timeout(45_000)
  });
  jar.add(portfolioResponse);
  const payload = await responseJson(portfolioResponse, "GM Portfolio");
  const rows = bridge.rowsFromPayload(payload);
  const hasPortfolioArray = [payload?.aaData, payload?.data, payload?.rows].some(Array.isArray);
  if (!rows.length && !hasPortfolioArray) throw new Error("GM Portfolio response did not contain a position table");
  return bridge.normalizeRows(rows);
}

async function linkedAccounts(jar) {
  const response = await fetch(GM_LINKED_ACCOUNTS_URL, {
    method: "POST",
    headers: gmHeaders(jar, { "Content-Type": "application/json;charset=UTF-8", "X-Requested-With": "XMLHttpRequest" }),
    body: "{}",
    signal: AbortSignal.timeout(45_000)
  });
  jar.add(response);
  const payload = await responseJson(response, "GM linked accounts");
  return String(payload?.status || "").toLowerCase() === "ok" && Array.isArray(payload?.data) ? payload.data.slice(0, 12) : [];
}

async function selectLinkedAccount(jar, userId) {
  const response = await fetch(GM_LOGIN_LINKED_URL, {
    method: "POST",
    headers: gmHeaders(jar, { "Content-Type": "application/json;charset=UTF-8", "X-Requested-With": "XMLHttpRequest" }),
    body: JSON.stringify({ user_id: userId }),
    signal: AbortSignal.timeout(45_000)
  });
  jar.add(response);
  const payload = await responseJson(response, "GM linked-account selection");
  return String(payload?.status || "").toLowerCase() === "ok";
}

async function fetchGmPortfolio(username, password) {
  const primaryJar = await loginSession(username, password);
  const primaryPositions = await requestPortfolio(primaryJar);
  if (process.env.GM_CLOUD_DRY_RUN === "1") console.log(`GM context diagnostic: primary=${primaryPositions.length}`);
  if (primaryPositions.length) return primaryPositions;

  const accounts = await linkedAccounts(primaryJar);
  if (process.env.GM_CLOUD_DRY_RUN === "1") console.log(`GM context diagnostic: linked=${accounts.length}`);
  let best = primaryPositions;
  for (const [index, account] of accounts.entries()) {
    const userId = account?.userId ?? account?.user_id ?? account?.id;
    if (userId === undefined || userId === null || String(userId).length > 40) continue;
    const jar = await loginSession(username, password);
    if (!await selectLinkedAccount(jar, userId)) {
      if (process.env.GM_CLOUD_DRY_RUN === "1") console.log(`GM context diagnostic: linked-${index + 1}=selection-rejected`);
      continue;
    }
    const positions = await requestPortfolio(jar);
    if (process.env.GM_CLOUD_DRY_RUN === "1") console.log(`GM context diagnostic: linked-${index + 1}=${positions.length}`);
    if (positions.length > best.length) best = positions;
  }
  return best;
}

async function uploadToK2(positions, secret) {
  const capturedAt = new Date().toISOString();
  const snapshotId = fingerprint(positions);
  const response = await fetch(K2_SYNC_URL, {
    method: "POST",
    headers: { "Authorization": `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "sync-broker-portfolio",
      snapshotId,
      capturedAt,
      sourceEndpoint: GM_PORTFOLIO_URL,
      reason: "cloud-schedule",
      positions
    }),
    signal: AbortSignal.timeout(45_000)
  });
  const result = await responseJson(response, "K² GM sync");
  return { ...result, capturedAt, snapshotId };
}

async function runOnce() {
  const username = String(process.env.GM_USERNAME || "");
  const password = String(process.env.GM_PASSWORD || "");
  const secret = String(process.env.K2_GM_CLOUD_SYNC_SECRET || "");
  if (!username || !password) throw new Error("GM_USERNAME and GM_PASSWORD cloud secrets are required");
  if (secret.length < 32) throw new Error("K2_GM_CLOUD_SYNC_SECRET must contain at least 32 characters");
  const positions = await fetchGmPortfolio(username, password);
  if (process.env.GM_CLOUD_DRY_RUN === "1") {
    console.log(`GM read-only cloud check succeeded: ${positions.length} open positions`);
    return;
  }
  const result = await uploadToK2(positions, secret);
  console.log(`GM → K² cloud sync succeeded: ${positions.length} Kamlesh positions at ${result.capturedAt}`);
}

if (require.main === module) runOnce().catch((error) => {
  console.error(`GM → K² cloud sync failed: ${String(error?.message || error).slice(0, 240)}`);
  process.exitCode = 1;
});

module.exports = { CookieJar, fetchGmPortfolio, fingerprint, linkedAccounts, positionForm, requestPortfolio, runOnce, selectLinkedAccount, uploadToK2 };
