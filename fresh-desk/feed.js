"use strict";
// Reuse only existing credential/quote transport and exchange-calendar DATA.
// No former scanner, rating, paper-rule or market-direction module is imported.
const fs = require("node:fs"), path = require("node:path");
const brokers = require("../api/_lib/broker-feed");
const { parseExchangeClock } = require("../api/_lib/live-quotes");
const { isNseHoliday } = require("../api/_lib/nse-holidays");
const { dayAt } = require("./engine");
const ROOT = path.resolve(__dirname, "..");
const read = (file) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8")); } catch { return null; } };
function loadEnvironment() {
  const file = path.join(ROOT, ".private/production.env");
  if (fs.existsSync(file)) for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
function sessionAt(now) {
  const day = dayAt(now), weekday = new Date(day).getUTCDay(), holiday = isNseHoliday(day);
  return weekday === 0 || weekday === 6 || holiday === true ? false : holiday === null ? null : true;
}
async function candles({ contract, symbol, expiry, session, now, credentials, fetchImpl = fetch }) {
  const fail = (reason) => ({ ok: false, reason });
  if (!credentials) return fail("ANGEL_CREDENTIALS_UNAVAILABLE");
  try {
    const to = new Date(now + 330 * 60000).toISOString().slice(0, 16).replace("T", " ");
    const response = await fetchImpl(`${brokers.ANGEL_ROOT}/rest/secure/angelbroking/historical/v1/getCandleData`, {
      method: "POST", signal: AbortSignal.timeout(12000),
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-UserType": "USER", "X-SourceID": "WEB",
        "X-PrivateKey": credentials.apiKey, "X-ClientLocalIP": "127.0.0.1", "X-ClientPublicIP": "127.0.0.1", "X-MACAddress": "00:00:00:00:00:00", Authorization: `Bearer ${credentials.accessToken}` },
      body: JSON.stringify({ exchange: "NFO", symboltoken: String(contract.token), interval: "FIVE_MINUTE", fromdate: `${session} 09:15`, todate: to })
    });
    if (!response.ok) return fail(`ANGEL_HTTP_${response.status}`);
    const p = await response.json();
    if ((p.status === false || p.success === false) && (p.errorcode ?? p.errorCode) === "AG8001") return fail("ANGEL_SESSION_EXPIRED");
    if (p.status !== true || !Array.isArray(p.data)) return fail("ANGEL_CANDLES_UNAVAILABLE");
    if (p.data.some((r) => !Array.isArray(r) || r.length < 6)) return fail("INVALID_CANDLE_RESPONSE");
    return { ok: true, bars: p.data.map((r) => ({ symbol, expiry, at: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] })) };
  } catch (e) { return fail(e.cause?.code === "EACCES" ? "NETWORK_ACCESS_DENIED" : "ANGEL_CONNECTION_UNAVAILABLE"); }
}
async function collect(symbols, { now = Date.now(), readFile = read, candleFeed = candles, quoteFeed = brokers.futuresQuotes,
  masterFeed = async () => brokers.refreshInstruments("angelone", { timeoutMs: 12000 }), loadMaster = () => brokers.loadInstruments("angelone"),
  banFeed = async () => { const b = await require("../api/_lib/bhavcopy").fetchSecurityBanList(12000); return b.available ? { tradeDate: b.tradeDate, symbols: [...b.symbols], source: b.source } : null; },
  credentials = null, clockNow = Date.now, pauseMs = 25000,
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), ensureSession = () => require("../api/_lib/broker-auth").angelEnsureSession() } = {}) {
  loadEnvironment();
  const session = dayAt(now), tradingSession = sessionAt(now), inputs = [], errors = [];
  // Never replay yesterday's triggers as a fresh opening recommendation.
  if (tradingSession !== true || now < Date.parse(`${session}T09:15:00+05:30`) || now >= Date.parse(`${session}T15:30:00+05:30`)) return { tradingSession, inputs, errors, state: tradingSession === null ? "CALENDAR_UNVERIFIED" : "MARKET_CLOSED" };
  if (now >= Date.parse(`${session}T15:00:00+05:30`)) return { tradingSession, inputs, errors, state: "ENTRY_WINDOW_CLOSED" };
  const currentMaster = (m) => m?.futures && Number.isFinite(Date.parse(m.fetchedAt)) && dayAt(Date.parse(m.fetchedAt)) === session
    && now - Date.parse(m.fetchedAt) >= -60000 && now - Date.parse(m.fetchedAt) < 24 * 3600e3;
  let master = loadMaster();
  if (!currentMaster(master)) {
    try { master = await masterFeed(); } catch { return { tradingSession, inputs, errors: ["CURRENT_CONTRACT_MASTER_UNAVAILABLE"], state: "DATA_UNAVAILABLE" }; }
  }
  if (!currentMaster(master)) return { tradingSession, inputs, errors: ["CURRENT_CONTRACT_MASTER_UNAVAILABLE"], state: "DATA_UNAVAILABLE" };
  const nearest = new Map();
  for (const [key, c] of Object.entries(master.futures)) {
    const [symbol, expiry, extra] = key.split("|");
    if (extra || c.exchange !== "NFO" || !c.token || expiry < session || (symbols?.length && !symbols.includes(symbol))) continue;
    if (!nearest.has(symbol) || expiry < nearest.get(symbol).expiry) nearest.set(symbol, { symbol, expiry, contract: c });
  }
  const currentBan = (b) => b?.tradeDate === session && Array.isArray(b.symbols) && typeof b.source === "string" && b.source.length > 0;
  let ban = readFile(".private/fresh-desk/ban.json");
  if (!currentBan(ban)) ban = readFile(".private/cache/fo-ban.json");
  if (!currentBan(ban)) {
    try { ban = await banFeed(); } catch { ban = null; }
    if (currentBan(ban)) {
      const dir = path.join(ROOT, ".private/fresh-desk"); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "ban.json"), JSON.stringify(ban));
    }
  }
  if (!currentBan(ban)) return { tradingSession, inputs, errors: ["BAN_STATUS_UNVERIFIED"], state: "DATA_UNAVAILABLE" };
  let sessionRefreshed = false, attempted = 0;
  for (const { symbol, expiry, contract } of nearest.values()) {
    const started = Date.now();
    const observedNow = clockNow();
    if (dayAt(observedNow) !== session || observedNow >= Date.parse(`${session}T15:00:00+05:30`)) { errors.push("ENTRY_SESSION_ENDED_DURING_SCAN"); break; }
    attempted++;
    const request = () => candleFeed({ symbol, expiry, contract, session, now: clockNow(), credentials: credentials || brokers.credentialsFor("angelone") });
    let data = await request();
    // An AG8001 burst response can clear without invalidating the login. Retry
    // the same session after cooling down; refresh authentication only if needed.
    if (["ANGEL_SESSION_EXPIRED", "ANGEL_HTTP_429"].includes(data.reason)) { await pause(pauseMs); data = await request(); }
    if (data.reason === "ANGEL_SESSION_EXPIRED" && !sessionRefreshed) {
      sessionRefreshed = true; try { const auth = await ensureSession(); if (auth.ok) data = await request(); } catch { /* retain sanitized reason */ }
    }
    if (!data.ok) { errors.push(`${symbol}: ${data.reason}`); if (/NETWORK_ACCESS_DENIED|SESSION_EXPIRED|CREDENTIALS|HTTP_429/.test(data.reason)) break; continue; }
    // Quote AFTER the candle request. Timestamp determines whether it follows the signal.
    let q;
    try { q = (await quoteFeed([{ symbol, expiry }], { timeoutMs: 12000 })).quotes?.[`${symbol}|${expiry}`]; } catch { errors.push(`${symbol}: QUOTE_UNAVAILABLE`); }
    const at = parseExchangeClock(q?.exchangeFeedTime);
    const verifiedBan = ban?.tradeDate === session && Array.isArray(ban.symbols) && typeof ban.source === "string";
    inputs.push({ symbol, expiry, market: "NSE_FUTURES", currency: "INR", source: "ANGELONE_NFO", sourceUrl: "https://smartapi.angelbroking.com/docs/Historical", volumeKind: "EXCHANGE_VOLUME", intervalMinutes: 5, tickSize: contract.tickSize, bars: data.bars,
      eligibility: { session: verifiedBan ? session : null, state: verifiedBan ? ban.symbols.includes(symbol) ? "BANNED" : "CLEAR" : "UNKNOWN", source: ban?.source },
      quote: q ? { symbol, expiry, at: at === null ? null : new Date(at).toISOString(), bid: q.bid, ask: q.ask } : null });
    const delay = 500 - (Date.now() - started); if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  }
  return { tradingSession, inputs, errors, coverage: { requested: nearest.size, attempted, available: inputs.length },
    state: inputs.length ? errors.length || attempted < nearest.size ? "PARTIAL_SCAN" : "SCANNED" : errors.length ? "DATA_UNAVAILABLE" : "NO_CONTRACTS" };
}
module.exports = { collect, candles, sessionAt };
