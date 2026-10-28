"use strict";

// Read-only NFO historical candles using the desk's existing Angel session.
// API contract: https://smartapi.angelbroking.com/docs/Historical
const brokers = require("./broker-feed");
const { validBar } = require("./gm-technical-research");

async function futuresHistory({ symbol, expiry, asOf, now = Date.now(), timeoutMs = 12000, fetchImpl = fetch,
  credentials = brokers.credentialsFor("angelone"), instruments = brokers.loadInstruments("angelone") } = {}) {
  const fail = (reason) => ({ ok: false, reason, bars: [] });
  if (!credentials) return fail("ANGEL_SESSION_NOT_CONFIGURED");
  // The expiry day's own bar is allowed: a paper exit at expiry needs it. The scan skips contracts expiring on asOf itself.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf || "") || !/^\d{4}-\d{2}-\d{2}$/.test(expiry || "") || expiry < asOf) return fail("INVALID_CONTRACT_OR_DATE");
  const contract = instruments?.futures?.[`${symbol}|${expiry}`];
  if (!contract?.token || contract.exchange !== "NFO" || !(contract.tickSize > 0)) return fail("NFO_CONTRACT_OR_TICK_MISSING");
  const fetched = Date.parse(instruments?.fetchedAt || "");
  if (!Number.isFinite(fetched) || now - fetched > 36 * 3600e3 || fetched > now + 60000) return fail("INSTRUMENT_MASTER_STALE");
  // Exclude an unfinished current-day bar even if the caller asks for it.
  if (Date.parse(`${asOf}T15:30:00+05:30`) > now) return fail("SESSION_NOT_CLOSED");
  const from = new Date(Date.parse(asOf) - 120 * 864e5).toISOString().slice(0, 10);
  try {
    const response = await fetchImpl(`${brokers.ANGEL_ROOT}/rest/secure/angelbroking/historical/v1/getCandleData`, {
      method: "POST", signal: AbortSignal.timeout(timeoutMs),
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-UserType": "USER", "X-SourceID": "WEB",
        "X-PrivateKey": credentials.apiKey, "X-ClientLocalIP": "127.0.0.1", "X-ClientPublicIP": "127.0.0.1",
        "X-MACAddress": "00:00:00:00:00:00", Authorization: `Bearer ${credentials.accessToken}` },
      body: JSON.stringify({ exchange: "NFO", symboltoken: String(contract.token), interval: "ONE_DAY", fromdate: `${from} 09:15`, todate: `${asOf} 15:30` })
    });
    if (response.status === 401 || response.status === 403) return fail("ANGEL_SESSION_REJECTED");
    if (!response.ok) return fail(`ANGEL_HTTP_${response.status}`);
    const payload = await response.json();
    // An expired session answers HTTP 200 {"success":false,"errorCode":"AG8001","message":"Invalid Token"} (seen 27 Oct 2026).
    if ((payload?.status === false || payload?.success === false) && (payload.errorcode ?? payload.errorCode) === "AG8001") return fail("ANGEL_SESSION_REJECTED");
    if (payload?.status !== true || !Array.isArray(payload.data)) return fail("ANGEL_CANDLES_REJECTED");
    const bars = [];
    for (const row of payload.data) {
      if (!Array.isArray(row) || row.length < 6 || typeof row[0] !== "string"
        || !Number.isFinite(Date.parse(row[0])) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(row[0])) return fail("INVALID_CANDLE_RESPONSE");
      // Convert the timestamp to the NSE/IST session, never the UTC date.
      const date = new Date(Date.parse(row[0]) + 330 * 60000).toISOString().slice(0, 10);
      const b = { symbol, expiry, date, open: row[1], high: row[2], low: row[3], close: row[4], volume: row[5] };
      if (date < from || date > asOf || !validBar(b)) return fail("INVALID_CANDLE_RESPONSE");
      bars.push(b);
    }
    bars.sort((a, b) => a.date.localeCompare(b.date));
    if (bars.some((b, i) => i && b.date === bars[i - 1].date)) return fail("DUPLICATE_SESSION_CANDLES");
    return { ok: true, source: "NSE_FUTURES", provider: "ANGELONE_NFO_HISTORICAL", symbol, expiry,
      tickSize: contract.tickSize, asOf, fetchedAt: new Date(now).toISOString(), bars };
  } catch (error) {
    // A fetch exception can contain request headers; retain only safe codes.
    return fail(error.cause?.code === "EACCES" ? "NETWORK_ACCESS_DENIED" : error.name === "TimeoutError" ? "ANGEL_TIMEOUT" : "ANGEL_NETWORK_FAILURE");
  }
}
module.exports = { futuresHistory };
