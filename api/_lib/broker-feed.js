"use strict";

/**
 * Live option chains from a broker, behind one interface.
 *
 * Every unauthenticated source was tested and closed:
 *
 *     NSE /api/option-chain-v3    HTTP 200, 2 bytes  blocked to servers
 *     NSE /api/quote-equity       HTTP 403
 *     Yahoo option chain .NS      HTTP 401           no Indian chains
 *     TradingView search_type=option HTTP 400        the category does not exist
 *
 * A broker login is therefore not a preference, it is the only remaining route
 * to a live premium. This module speaks to Upstox and Angel One and normalises
 * both to one shape, so nothing downstream needs to know which one is wired.
 *
 * TWO RULES HOLD FOR EVERY PROVIDER.
 *
 * 1. FAIL CLOSED. No credentials means NOT_CONFIGURED and no data. There is no
 *    model fallback and no table: a market-data client that degrades into an
 *    estimate is worse than one switched off, because the estimate still
 *    reaches a card carrying a one-tap order link.
 *
 * 2. A LAST TRADED PRICE IS NOT A FILL PRICE. Every leg carries bid, ask and
 *    depth, and a `tradeable` flag that is true only when both sides are
 *    standing. A print from an hour ago on a dead strike is a fact about the
 *    past, not a price you can transact at.
 *
 * Credentials live in the environment or in .private/brokers.json, which is
 * gitignored and never committed.
 */

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const PRIVATE_DIR = path.resolve(path.join(__dirname, "..", "..", ".private"));
const CREDENTIALS_FILE = path.join(PRIVATE_DIR, "brokers.json");

/**
 * Where the credential file can live.
 *
 * Locally it is .private/brokers.json, which git never sees. On Render the
 * repository has no .private at all, and the platform's own answer to secrets
 * is Secret Files -- uploaded once through the dashboard and mounted at
 * /etc/secrets/<name>, or placed at the project root. Reading only the local
 * path meant the supported way to give a host its credentials silently did
 * nothing, and the only route left was retyping four values by hand.
 *
 * Order matters: the local file wins, because that is the one a developer is
 * actively editing and rotating sessions into.
 */
const CREDENTIAL_PATHS = [
  CREDENTIALS_FILE,
  "/etc/secrets/brokers.json",
  path.resolve(process.cwd(), "brokers.json")
];

/** The first credential file that exists, or null when none do. */
function credentialFile() {
  for (const candidate of CREDENTIAL_PATHS) {
    try { if (fs.existsSync(candidate)) return candidate; } catch (error) { /* unreadable is absent */ }
  }
  return null;
}

const CACHE_DIR = path.join(PRIVATE_DIR, "cache");

const UPSTOX_ROOT = "https://api.upstox.com/v2";
const UPSTOX_INSTRUMENTS = "https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";
const ANGEL_ROOT = "https://apiconnect.angelone.in";
const ANGEL_INSTRUMENTS = "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json";

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

const num = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

function readCredentialsFile() {
  const file = credentialFile();
  if (!file) return {};
  try { return JSON.parse(fs.readFileSync(file, "utf8")) || {}; }
  catch (error) { return {}; }
}

/** Credentials for one provider, or null. Environment wins over file. */
function credentialsFor(provider) {
  const file = readCredentialsFile()[provider] || {};
  if (provider === "upstox") {
    const accessToken = process.env.UPSTOX_ACCESS_TOKEN || file.accessToken || file.access_token;
    return accessToken ? { accessToken: String(accessToken), source: process.env.UPSTOX_ACCESS_TOKEN ? "ENVIRONMENT" : "PRIVATE_FILE" } : null;
  }
  if (provider === "angelone") {
    const accessToken = process.env.ANGELONE_ACCESS_TOKEN || file.accessToken || file.access_token;
    const apiKey = process.env.ANGELONE_API_KEY || file.apiKey || file.api_key;
    return accessToken && apiKey
      ? { accessToken: String(accessToken), apiKey: String(apiKey), source: process.env.ANGELONE_ACCESS_TOKEN ? "ENVIRONMENT" : "PRIVATE_FILE" }
      : null;
  }
  return null;
}

const PROVIDERS = ["upstox", "angelone"];

/** Which providers are usable right now, and precisely why not if not. */
/**
 * Upstox cannot satisfy this desk's freshness contract, whatever credentials it
 * is given.
 *
 * Its option chain carries NO exchange feed time. The contract treats a book
 * with no exchange clock as STALE, because absent evidence must not read as
 * evidence of currency -- so an Upstox quote can never be classified REALTIME
 * and can never reach a card as executable. Configuring it would buy nothing.
 *
 * The code is left in place because it costs nothing dormant and documents the
 * comparison, but the status now SAYS this, so nobody -- including a future
 * agent reading "NOT_CONFIGURED" as an invitation -- spends an evening wiring
 * up a provider that is structurally unusable here.
 */
const UPSTOX_LIMITATION = "Sends no exchange feed time, so its quotes can never be classified REALTIME and never reach a card. Angel One is the supported live feed.";

function status() {
  const providers = {};
  for (const provider of PROVIDERS) {
    const credentials = credentialsFor(provider);
    const instruments = fs.existsSync(instrumentCachePath(provider));
    providers[provider] = {
      configured: Boolean(credentials),
      credentialSource: credentials ? credentials.source : null,
      instrumentsCached: instruments,
      ready: Boolean(credentials) && instruments,
      reason: credentials ? (instruments ? null : "INSTRUMENTS_NOT_CACHED") : "NOT_CONFIGURED_NO_CREDENTIALS"
    };
  }
  const active = PROVIDERS.find((provider) => providers[provider].ready) || null;
  if (providers.upstox) {
    providers.upstox.supported = false;
    providers.upstox.limitation = UPSTOX_LIMITATION;
  }
  return {
    providers,
    activeProvider: active,
    anyReady: Boolean(active),
    howToConfigure: {
      upstox: "UPSTOX_ACCESS_TOKEN, or .private/brokers.json {\"upstox\":{\"accessToken\":\"...\"}}",
      angelone: "ANGELONE_API_KEY + ANGELONE_ACCESS_TOKEN, or .private/brokers.json {\"angelone\":{\"apiKey\":\"...\",\"accessToken\":\"...\"}}"
    }
  };
}

function instrumentCachePath(provider) {
  return path.join(CACHE_DIR, `${provider}-instruments.json`);
}

/**
 * Instrument masters are PUBLIC for both brokers and need no token, so they are
 * fetched and reduced at boot. Only what the desk needs is kept: mapping a
 * symbol to the provider's own key, and the option contracts per expiry.
 */
/** True when the cached master predates the fields this code expects. */
function instrumentsAreStale(provider) {
  const cached = loadInstruments(provider);
  return !cached || cached.schemaStale === true;
}

async function refreshInstruments(provider, { timeoutMs = 180_000 } = {}) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  if (provider === "angelone") {
    const response = await fetch(ANGEL_INSTRUMENTS, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`angel instruments returned ${response.status}`);
    // response.json() parses straight from the network buffer. The previous
    // JSON.parse(await response.text()) materialised a 35 MB JavaScript string
    // AND the object tree beside it. Measured peak for this call is 200 MB RSS;
    // on a 512 MB host already holding 260 MB that is the difference between a
    // refresh completing and a container that quietly keeps serving a master
    // with no futures in it.
    let rows = await response.json();
    const underlyings = {};
    const options = {};
    // FUTURES ARE A SEPARATE INSTRUMENT AND WERE BEING DISCARDED.
    //
    // The master was filtered to cash equities and options only, so the desk
    // had no live futures price and fell back to the end-of-day bhavcopy for
    // one. That matters because an Indian stock option is priced off its
    // FUTURE: measured on APOLLOHOSP, using the cash share (8944.38) instead of
    // the future (8865) understated at-the-money implied volatility by 7.72
    // points. A stale futures price is better than a cash price and worse than
    // a live one, and only the live one is a market price.
    const futures = {};
    for (const row of rows) {
      const type = row.instrumenttype;
      const name = String(row.name || "").trim().toUpperCase();
      if (!name) continue;
      if ((type === "" || type === undefined) && row.exch_seg === "NSE") {
        // Cash equity rows carry no instrumenttype on this feed.
        if (!underlyings[name]) underlyings[name] = { token: String(row.token), exchange: "NSE", symbol: row.symbol };
        continue;
      }
      if (type === "FUTSTK" || type === "FUTIDX") {
        const expiry = normaliseAngelExpiry(row.expiry);
        if (!expiry) continue;
        futures[`${name}|${expiry}`] = {
          token: String(row.token), symbol: row.symbol, lotSize: num(row.lotsize), exchange: row.exch_seg
        };
        continue;
      }
      if (type === "OPTSTK" || type === "OPTIDX") {
        // Angel publishes strikes in paise.
        const strike = num(row.strike) !== null ? num(row.strike) / 100 : null;
        const optionType = String(row.symbol || "").endsWith("PE") ? "PE" : String(row.symbol || "").endsWith("CE") ? "CE" : null;
        if (!strike || !optionType) continue;
        const expiry = normaliseAngelExpiry(row.expiry);
        if (!expiry) continue;
        options[`${name}|${expiry}|${strike}|${optionType}`] = {
          token: String(row.token), symbol: row.symbol, lotSize: num(row.lotsize), exchange: row.exch_seg
        };
      }
    }
    const payload = {
      provider, schemaVersion: INSTRUMENT_SCHEMA_VERSION, fetchedAt: new Date().toISOString(),
      underlyingCount: Object.keys(underlyings).length,
      optionCount: Object.keys(options).length,
      futuresCount: Object.keys(futures).length,
      underlyings, options, futures
    };
    // Release the 100k-row array before serialising the small result, so the
    // two never occupy the heap at the same moment.
    rows = null;
    fs.writeFileSync(instrumentCachePath(provider), JSON.stringify(payload));
    memo[provider] = payload;
    return payload;
  }

  if (provider === "upstox") {
    const response = await fetch(UPSTOX_INSTRUMENTS, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`upstox instruments returned ${response.status}`);
    const gz = Buffer.from(await response.arrayBuffer());
    const rows = JSON.parse(zlib.gunzipSync(gz).toString("utf8"));
    const underlyings = {};
    for (const row of rows) {
      const segment = row.segment || row.exchange;
      const name = String(row.trading_symbol || row.name || "").trim().toUpperCase();
      const key = row.instrument_key;
      if (!key || !name) continue;
      if (segment === "NSE_INDEX" || row.instrument_type === "INDEX") {
        if (!underlyings[name]) underlyings[name] = { instrumentKey: key, kind: "INDEX" };
      } else if (segment === "NSE_EQ" && (row.instrument_type === "EQ" || row.instrument_type === "EQUITY")) {
        if (!underlyings[name] || underlyings[name].kind !== "INDEX") underlyings[name] = { instrumentKey: key, kind: "EQUITY" };
      }
    }
    // Upstox builds its master on a separate path and needs the same version
    // stamp. Without it loadInstruments rejects this cache forever, which
    // silently disables the provider entirely -- a version check that is not
    // applied everywhere is worse than none, because it breaks the paths it
    // was never meant to touch.
    const payload = {
      provider, schemaVersion: INSTRUMENT_SCHEMA_VERSION, fetchedAt: new Date().toISOString(),
      underlyingCount: Object.keys(underlyings).length, underlyings
    };
    fs.writeFileSync(instrumentCachePath(provider), JSON.stringify(payload));
    memo[provider] = payload;
    return payload;
  }
  throw new Error(`unknown provider ${provider}`);
}

function normaliseAngelExpiry(value) {
  // Angel writes 29SEP2026; the desk speaks 2026-09-29.
  const text = String(value || "").trim().toUpperCase();
  const match = text.match(/^(\d{2})([A-Z]{3})(\d{4})$/);
  if (!match) return null;
  const months = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
  const month = months[match[2]];
  return month ? `${match[3]}-${month}-${match[1]}` : null;
}

const memo = {};
// Bumped whenever this file starts expecting a field the cache may not carry.
// A cached artifact that outlives the code reading it degrades SILENTLY: adding
// futures to the master did nothing in production for a full deploy cycle,
// because the container happily kept serving a file written before futures
// existed and every card quietly fell back to the end-of-day forward. Nothing
// errored. Nothing was logged. The desk simply got worse.
const INSTRUMENT_SCHEMA_VERSION = 2;

function loadInstruments(provider) {
  if (memo[provider]) return memo[provider];
  const file = instrumentCachePath(provider);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    // An out-of-date shape is DEGRADED, not unusable.
    //
    // Returning null here was a mistake that would have been severe in
    // production. The Angel master is 35 MB of JSON and takes about 35 seconds
    // to download; parsing it holds both the text and the object tree, which on
    // a 512 MB host already sitting at 260 MB frequently does not complete. If
    // a stale cache reads as ABSENT and the refresh then fails, the desk has no
    // instrument master at all -- no option chains, no strikes, nothing. Losing
    // the futures field is a degradation; losing the chain is a break.
    //
    // So an old cache is still served, marked stale, and the refresh is left to
    // upgrade it when it can.
    parsed.schemaStale = Number(parsed?.schemaVersion) !== INSTRUMENT_SCHEMA_VERSION;
    memo[provider] = parsed;
    return memo[provider];
  } catch (error) { return null; }
}

/** One normalised leg. `tradeable` is the field that matters. */
function normaliseLeg(strike, optionType, market, greeks) {
  const bid = num(market?.bid_price ?? market?.bidPrice);
  const ask = num(market?.ask_price ?? market?.askPrice);
  return {
    strike: num(strike),
    optionType,
    lastPrice: num(market?.ltp ?? market?.last_price ?? market?.ltP),
    bid,
    ask,
    bidQuantity: num(market?.bid_qty ?? market?.bidQty),
    askQuantity: num(market?.ask_qty ?? market?.askQty),
    spread: bid !== null && ask !== null ? Math.round((ask - bid) * 100) / 100 : null,
    spreadPct: bid > 0 && ask > 0 ? Math.round(((ask - bid) / ((ask + bid) / 2)) * 10000) / 100 : null,
    openInterest: num(market?.oi ?? market?.openInterest),
    previousOpenInterest: num(market?.prev_oi),
    volume: num(market?.volume),
    impliedVolatility: num(greeks?.iv ?? greeks?.impliedVolatility),
    delta: num(greeks?.delta),
    gamma: num(greeks?.gamma),
    theta: num(greeks?.theta),
    vega: num(greeks?.vega),
    // Both sides standing, or it is a print rather than a price.
    tradeable: Boolean(bid > 0 && ask > 0)
  };
}

/** Live option chain from Upstox. */
async function upstoxOptionChain(symbol, expiry, { timeoutMs = 20_000 } = {}) {
  const credentials = credentialsFor("upstox");
  if (!credentials) return { ok: false, provider: "upstox", reason: "NOT_CONFIGURED_NO_CREDENTIALS", chain: null };
  const instruments = loadInstruments("upstox");
  const entry = instruments?.underlyings?.[String(symbol).toUpperCase()];
  if (!entry) return { ok: false, provider: "upstox", reason: "UNKNOWN_UNDERLYING", symbol, chain: null };

  const url = `${UPSTOX_ROOT}/option/chain?instrument_key=${encodeURIComponent(entry.instrumentKey)}&expiry_date=${encodeURIComponent(String(expiry).slice(0, 10))}`;
  const response = await fetch(url, {
    headers: { Accept: "application/json", Authorization: `Bearer ${credentials.accessToken}` },
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  if (!response.ok) {
    return {
      ok: false, provider: "upstox", reason: `HTTP_${response.status}`,
      hint: response.status === 401 ? "Upstox access tokens expire daily; regenerate it." : null,
      body: text.slice(0, 200), chain: null
    };
  }
  const payload = JSON.parse(text);
  const legs = [];
  let underlyingPrice = null;
  for (const row of payload.data || []) {
    underlyingPrice = num(row.underlying_spot_price) ?? underlyingPrice;
    if (row.call_options) legs.push({ ...normaliseLeg(row.strike_price, "CE", row.call_options.market_data, row.call_options.option_greeks), instrumentKey: row.call_options.instrument_key });
    if (row.put_options) legs.push({ ...normaliseLeg(row.strike_price, "PE", row.put_options.market_data, row.put_options.option_greeks), instrumentKey: row.put_options.instrument_key });
  }
  legs.sort((a, b) => a.strike - b.strike || a.optionType.localeCompare(b.optionType));
  return {
    // Upstox v2 sends no exchange feed time with the chain. The freshness
    // contract treats an absent exchange clock as STALE rather than as fresh,
    // so these books are read for reference but never reach a card claiming to
    // be executable. That is deliberate: absent evidence must not read as
    // evidence of currency. Angel One does send exchFeedTime and is preferred.
    ok: true, provider: "upstox", source: "UPSTOX_V2_OPTION_CHAIN_LIVE",
    symbol, expiry: String(expiry).slice(0, 10), underlyingPrice,
    receivedAt: new Date().toISOString(), strikeCount: legs.length, chain: legs
  };
}

/**
 * Live quotes from Angel One.
 *
 * Angel has no single option-chain call, so the chain is assembled from the
 * instrument master and quoted in one batched market-data request. The batch
 * limit is 50 tokens, which is why the strike window is bounded.
 */
async function angelOptionChain(symbol, expiry, { timeoutMs = 20_000, strikesEitherSide = 12, referencePrice = null } = {}) {
  const credentials = credentialsFor("angelone");
  if (!credentials) return { ok: false, provider: "angelone", reason: "NOT_CONFIGURED_NO_CREDENTIALS", chain: null };
  const instruments = loadInstruments("angelone");
  if (!instruments) return { ok: false, provider: "angelone", reason: "INSTRUMENTS_NOT_CACHED", chain: null };

  const wanted = String(symbol).toUpperCase();
  const targetExpiry = String(expiry).slice(0, 10);
  const contracts = [];
  for (const [key, value] of Object.entries(instruments.options || {})) {
    const [name, contractExpiry, strike, optionType] = key.split("|");
    if (name !== wanted || contractExpiry !== targetExpiry) continue;
    contracts.push({ strike: Number(strike), optionType, ...value });
  }
  if (!contracts.length) return { ok: false, provider: "angelone", reason: "NO_CONTRACTS_FOR_EXPIRY", symbol, expiry: targetExpiry, chain: null };

  // Angel's quote endpoint takes at most 50 tokens, so the window is centred on
  // the reference price rather than fetching a whole ladder that will be
  // truncated arbitrarily.
  const centre = num(referencePrice);
  const ordered = centre
    ? contracts.sort((a, b) => Math.abs(a.strike - centre) - Math.abs(b.strike - centre))
    : contracts.sort((a, b) => a.strike - b.strike);
  const selected = ordered.slice(0, Math.min(50, strikesEitherSide * 2 * 2));

  const response = await fetch(`${ANGEL_ROOT}/rest/secure/angelbroking/market/v1/quote`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json", Accept: "application/json",
      "X-UserType": "USER", "X-SourceID": "WEB",
      "X-PrivateKey": credentials.apiKey,
      "X-ClientLocalIP": "127.0.0.1", "X-ClientPublicIP": "127.0.0.1", "X-MACAddress": "00:00:00:00:00:00",
      Authorization: `Bearer ${credentials.accessToken}`
    },
    body: JSON.stringify({ mode: "FULL", exchangeTokens: { NFO: selected.map((contract) => contract.token) } }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  if (!response.ok) {
    return {
      ok: false, provider: "angelone", reason: `HTTP_${response.status}`,
      hint: response.status === 401 || response.status === 403 ? "Angel One JWTs expire daily; regenerate via loginByPassword with TOTP." : null,
      body: text.slice(0, 200), chain: null
    };
  }
  const payload = JSON.parse(text);
  const fetched = payload?.data?.fetched || [];
  const byToken = new Map(selected.map((contract) => [String(contract.token), contract]));
  const legs = [];
  for (const row of fetched) {
    const contract = byToken.get(String(row.symbolToken));
    if (!contract) continue;
    legs.push({
      ...normaliseLeg(contract.strike, contract.optionType, {
        ltp: row.ltp, volume: row.tradeVolume, oi: row.opnInterest,
        bid_price: row.depth?.buy?.[0]?.price, ask_price: row.depth?.sell?.[0]?.price,
        bid_qty: row.depth?.buy?.[0]?.quantity, ask_qty: row.depth?.sell?.[0]?.quantity
      }, null),
      // Angel's quote carries no greeks; the separate optionGreek endpoint does.
      greeksAvailable: false,
      // The exchange's own clock. When we asked is not when the exchange
      // priced it, and after the close those differ by hours.
      exchangeFeedTime: row.exchFeedTime || null,
      exchangeTradeTime: row.exchTradeTime || null,
      token: contract.token, lotSize: contract.lotSize, tradingSymbol: contract.symbol
    });
  }
  legs.sort((a, b) => a.strike - b.strike || a.optionType.localeCompare(b.optionType));
  return {
    ok: true, provider: "angelone", source: "ANGELONE_SMARTAPI_QUOTE_LIVE",
    symbol: wanted, expiry: targetExpiry, underlyingPrice: null,
    receivedAt: new Date().toISOString(), strikeCount: legs.length,
    requested: selected.length, chain: legs
  };
}

/** Whichever provider is configured, normalised the same way. */
/**
 * LIVE futures prices, straight from the broker.
 *
 * Black-Scholes prices off the FORWARD, and for an F&O name the market's own
 * forward is the futures price. (NSE single-stock options are physically
 * settled into shares, so they are not options on the future -- but the future
 * is still where the market publishes its forward, and an assumed cost-of-carry
 * from spot does not reproduce it.) The desk was taking that number from the end-of-day bhavcopy
 * because the instrument master discarded futures entirely, which meant that
 * during a live session every implied volatility, every probability and every
 * cheap-versus-expensive verdict rested on yesterday's forward.
 *
 * Measured on APOLLOHOSP: the cash share at 8944.38 against a future of 8865 --
 * a gap of 0.90% -- understated at-the-money implied volatility by 7.72 points
 * and produced a smile that ramped from 6% to 13% across four strikes. On the
 * future the same chain reads 13.04 / 13.74 / 14.03 / 14.57 / 15.70.
 *
 * Batched, because Angel caps a quote request at 50 tokens and 210 names would
 * otherwise be 210 round trips.
 */
async function futuresQuotes(requests, { timeoutMs = 20_000, batchSize = 50 } = {}) {
  const credentials = credentialsFor("angelone");
  if (!credentials) return { ok: false, reason: "NOT_CONFIGURED_NO_CREDENTIALS", quotes: {} };
  const instruments = loadInstruments("angelone");
  if (!instruments?.futures) return { ok: false, reason: "NO_FUTURES_IN_INSTRUMENT_MASTER", quotes: {} };

  const wanted = [];
  for (const request of Array.isArray(requests) ? requests : []) {
    const symbol = String(request?.symbol || "").toUpperCase();
    const expiry = String(request?.expiry || "").slice(0, 10);
    const contract = instruments.futures[`${symbol}|${expiry}`];
    // Spread FIRST: the instrument row carries its own `symbol` (the trading
    // symbol, APOLLOHOSP29SEP26FUT) and would otherwise overwrite the
    // underlying name the caller asked for, so every key came back unmatched.
    if (contract?.token) wanted.push({ ...contract, symbol, expiry, tradingSymbol: contract.symbol });
  }
  if (!wanted.length) return { ok: false, reason: "NO_MATCHING_FUTURES", quotes: {} };

  const quotes = {};
  const failures = [];
  for (let i = 0; i < wanted.length; i += batchSize) {
    const batch = wanted.slice(i, i + batchSize);
    try {
      const response = await fetch(`${ANGEL_ROOT}/rest/secure/angelbroking/market/v1/quote`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json", Accept: "application/json",
          "X-UserType": "USER", "X-SourceID": "WEB",
          "X-PrivateKey": credentials.apiKey,
          "X-ClientLocalIP": "127.0.0.1", "X-ClientPublicIP": "127.0.0.1", "X-MACAddress": "00:00:00:00:00:00",
          Authorization: `Bearer ${credentials.accessToken}`
        },
        body: JSON.stringify({ mode: "FULL", exchangeTokens: { NFO: batch.map((c) => c.token) } }),
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) { failures.push(`HTTP_${response.status}`); continue; }
      const payload = await response.json();
      const byToken = new Map(batch.map((c) => [String(c.token), c]));
      for (const row of payload?.data?.fetched || []) {
        const contract = byToken.get(String(row.symbolToken));
        if (!contract) continue;
        const last = num(row.ltp);
        // A future with no last price is not a forward anybody quoted.
        if (!(last > 0)) continue;
        quotes[`${contract.symbol}|${contract.expiry}`] = {
          symbol: contract.symbol, expiry: contract.expiry,
          tradingSymbol: contract.tradingSymbol,
          price: last,
          bid: num(row.depth?.buy?.[0]?.price),
          ask: num(row.depth?.sell?.[0]?.price),
          openInterest: num(row.opnInterest),
          volume: num(row.tradeVolume),
          lotSize: contract.lotSize,
          // The exchange's own clock, so staleness is measurable.
          exchangeFeedTime: row.exchFeedTime || null,
          provider: "angelone", source: "ANGELONE_SMARTAPI_FUTURES_LIVE"
        };
      }
    } catch (error) {
      failures.push(error.message);
    }
  }
  return { ok: Object.keys(quotes).length > 0, provider: "angelone", quotes, failures, requested: wanted.length };
}

async function optionChain(symbol, expiry, options = {}) {
  const preferred = options.provider || status().activeProvider;
  if (!preferred) return { ok: false, reason: "NO_BROKER_CONFIGURED", detail: status(), chain: null };
  if (preferred === "upstox") return upstoxOptionChain(symbol, expiry, options);
  if (preferred === "angelone") return angelOptionChain(symbol, expiry, options);
  return { ok: false, reason: `UNKNOWN_PROVIDER_${preferred}`, chain: null };
}

/** One contract out of a chain, or null. */
function quoteFromChain(chain, strike, optionType) {
  if (!chain?.chain) return null;
  const wanted = Number(strike);
  const side = String(optionType || "").toUpperCase();
  return chain.chain.find((leg) => leg.strike === wanted && leg.optionType === side) || null;
}

module.exports = {
  futuresQuotes,
  instrumentsAreStale,
  CREDENTIAL_PATHS, credentialFile,
  ANGEL_INSTRUMENTS, ANGEL_ROOT, CREDENTIALS_FILE, PROVIDERS, UPSTOX_INSTRUMENTS, UPSTOX_ROOT,
  angelOptionChain, credentialsFor, instrumentCachePath, loadInstruments,
  normaliseAngelExpiry, normaliseLeg, optionChain, quoteFromChain, refreshInstruments, status, upstoxOptionChain
};
