"use strict";

/**
 * DhanHQ v2 live market data.
 *
 * The NSE bhavcopy gives the exchange's own end-of-day truth: real strikes,
 * real lot sizes, real settled prices. What it cannot give is a price during
 * the session. Every free alternative was tested and refused:
 *
 *     NSE /api/option-chain-v3   HTTP 200, 2 bytes   (blocked to servers)
 *     NSE /api/quote-equity      HTTP 403
 *     Yahoo option chain .NS     HTTP 401            (no Indian chains at all)
 *
 * Dhan is the remaining path, and it is a real one: the option chain endpoint
 * returns last traded price, best bid and ask with depth, open interest,
 * volume, implied volatility and greeks for every strike. It needs the user's
 * own credentials, which is the whole reason it works when the scraped
 * endpoints do not.
 *
 * CREDENTIALS ARE NEVER COMMITTED. They are read from the environment
 * (DHAN_CLIENT_ID, DHAN_ACCESS_TOKEN) or from .private/dhan.json, which is
 * gitignored. Without them this module reports NOT_CONFIGURED and returns no
 * data. It does not fall back to a model, a table or a guess -- the entire
 * point of this file is that a live price is either real or absent.
 */

const fs = require("node:fs");
const path = require("node:path");

const API_ROOT = "https://api.dhan.co/v2";
const SCRIP_MASTER_URL = "https://images.dhan.co/api-data/api-scrip-master.csv";
const PRIVATE_DIR = path.resolve(path.join(__dirname, "..", "..", ".private"));
const CREDENTIALS_FILE = path.join(PRIVATE_DIR, "dhan.json");
const SCRIP_CACHE = path.join(PRIVATE_DIR, "cache", "dhan-scrips.json");

// Dhan permits one unique option-chain request every three seconds. Exceeding
// it earns a rate-limit response, so the limiter is part of the client rather
// than the caller's problem.
const OPTION_CHAIN_MIN_INTERVAL_MS = 3100;
let lastOptionChainAt = 0;

const num = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Credentials, or null. Never throws, never invents. */
function loadCredentials() {
  const fromEnv = {
    clientId: process.env.DHAN_CLIENT_ID,
    accessToken: process.env.DHAN_ACCESS_TOKEN
  };
  if (fromEnv.clientId && fromEnv.accessToken) return { ...fromEnv, source: "ENVIRONMENT" };
  if (fs.existsSync(CREDENTIALS_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf8"));
      const clientId = parsed.clientId || parsed.client_id || parsed.DHAN_CLIENT_ID;
      const accessToken = parsed.accessToken || parsed.access_token || parsed.DHAN_ACCESS_TOKEN;
      if (clientId && accessToken) return { clientId: String(clientId), accessToken: String(accessToken), source: "PRIVATE_FILE" };
    } catch (error) { /* malformed file is the same as no file */ }
  }
  return null;
}

/** What a caller can rely on right now, and why not if not. */
function status() {
  const credentials = loadCredentials();
  const scripsReady = fs.existsSync(SCRIP_CACHE);
  return {
    configured: Boolean(credentials),
    credentialSource: credentials ? credentials.source : null,
    scripMasterCached: scripsReady,
    ready: Boolean(credentials) && scripsReady,
    reason: credentials
      ? (scripsReady ? null : "SCRIP_MASTER_NOT_CACHED")
      : "NOT_CONFIGURED_NO_CREDENTIALS",
    howToConfigure: "Set DHAN_CLIENT_ID and DHAN_ACCESS_TOKEN, or write .private/dhan.json as {\"clientId\":\"...\",\"accessToken\":\"...\"}"
  };
}

/**
 * Download and compact the public scrip master.
 *
 * The file is 26 MB and needs no authentication. It is parsed line by line and
 * reduced to what the desk needs, because holding the whole thing costs more
 * memory than this box has to spare.
 */
async function refreshScripMaster({ timeoutMs = 120_000 } = {}) {
  const response = await fetch(SCRIP_MASTER_URL, {
    headers: { "User-Agent": "Mozilla/5.0", Accept: "text/csv" },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`scrip master returned ${response.status}`);
  const text = await response.text();
  const lines = text.split("\n");
  const header = lines[0].split(",").map((name) => name.trim());
  const at = (name) => header.indexOf(name);
  const idExch = at("SEM_EXM_EXCH_ID");
  const idSeg = at("SEM_SEGMENT");
  const idSecurity = at("SEM_SMST_SECURITY_ID");
  const idInstrument = at("SEM_INSTRUMENT_NAME");
  const idSymbol = at("SEM_TRADING_SYMBOL");
  const idLot = at("SEM_LOT_UNITS");
  const idExpiry = at("SEM_EXPIRY_DATE");
  const idStrike = at("SEM_STRIKE_PRICE");
  const idOptionType = at("SEM_OPTION_TYPE");
  const idTick = at("SEM_TICK_SIZE");

  const underlyings = {};
  const derivativeLots = {};
  for (let i = 1; i < lines.length; i += 1) {
    const row = lines[i].split(",");
    if (row.length < header.length - 4) continue;
    const exchange = row[idExch];
    const instrument = row[idInstrument];
    if (exchange !== "NSE" && exchange !== "BSE") continue;

    // Underlyings the option chain endpoint can be asked about: cash equities
    // and indices. The option rows themselves are not needed -- Dhan returns
    // the whole chain from the underlying's id.
    if (instrument === "EQUITY" || instrument === "INDEX") {
      const symbol = String(row[idSymbol] || "").trim().toUpperCase();
      const securityId = num(row[idSecurity]);
      if (!symbol || securityId === null) continue;
      // Prefer NSE. The same ticker exists on both exchanges and BSE rows can
      // appear first in the file; resolving RELIANCE to its BSE id would ask
      // Dhan for a BSE chain when every F&O contract here is NSE.
      const existing = underlyings[symbol];
      if (existing && existing.exchange === "NSE" && exchange !== "NSE") continue;
      if (!existing || (existing.exchange !== "NSE" && exchange === "NSE")) {
        underlyings[symbol] = {
          symbol,
          securityId,
          exchange,
          // Dhan's segment codes for the option-chain request.
          segment: instrument === "INDEX" ? "IDX_I" : (exchange === "NSE" ? "NSE_EQ" : "BSE_EQ"),
          instrument,
          tickSize: num(row[idTick])
        };
      }
      continue;
    }
    // Lot size is a property of the derivative contract; captured per symbol and
    // expiry so it can cross-check the bhavcopy rather than replace it.
    if (instrument === "OPTSTK" || instrument === "OPTIDX" || instrument === "FUTSTK" || instrument === "FUTIDX") {
      const raw = String(row[idSymbol] || "");
      const base = raw.split("-")[0].trim().toUpperCase();
      const lot = num(row[idLot]);
      const expiry = String(row[idExpiry] || "").slice(0, 10);
      if (!base || !(lot > 0) || !expiry) continue;
      derivativeLots[`${base}|${expiry}`] = lot;
    }
  }

  const payload = {
    fetchedAt: new Date().toISOString(),
    underlyingCount: Object.keys(underlyings).length,
    lotCount: Object.keys(derivativeLots).length,
    underlyings,
    derivativeLots
  };
  fs.mkdirSync(path.dirname(SCRIP_CACHE), { recursive: true });
  fs.writeFileSync(SCRIP_CACHE, JSON.stringify(payload));
  memoScrips = payload;
  return payload;
}

let memoScrips = null;
function loadScripMaster() {
  if (memoScrips) return memoScrips;
  if (!fs.existsSync(SCRIP_CACHE)) return null;
  try {
    memoScrips = JSON.parse(fs.readFileSync(SCRIP_CACHE, "utf8"));
    return memoScrips;
  } catch (error) {
    return null;
  }
}

/** The security id and segment the option-chain endpoint needs for a symbol. */
function underlyingFor(symbol, scrips = loadScripMaster()) {
  if (!scrips) return null;
  const key = String(symbol || "").trim().toUpperCase();
  return scrips.underlyings[key] || null;
}

async function request(endpoint, body, { timeoutMs = 20_000 } = {}) {
  const credentials = loadCredentials();
  if (!credentials) return { ok: false, reason: "NOT_CONFIGURED_NO_CREDENTIALS", data: null };
  const response = await fetch(`${API_ROOT}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "access-token": credentials.accessToken,
      "client-id": credentials.clientId
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (error) { /* non-JSON body */ }
  if (!response.ok) {
    return {
      ok: false,
      reason: `HTTP_${response.status}`,
      // The token expires daily; saying so beats a generic failure.
      hint: response.status === 401 || response.status === 403
        ? "Access token rejected. Dhan tokens expire; regenerate it in the Dhan app."
        : null,
      body: parsed || text.slice(0, 200),
      data: null
    };
  }
  return { ok: true, data: parsed?.data ?? null, status: parsed?.status ?? null };
}

/** Expiries Dhan lists for an underlying. */
async function expiryList(symbol) {
  const underlying = underlyingFor(symbol);
  if (!underlying) return { ok: false, reason: "UNKNOWN_UNDERLYING", symbol, data: null };
  const result = await request("/optionchain/expirylist", {
    UnderlyingScrip: underlying.securityId,
    UnderlyingSeg: underlying.segment
  });
  return { ...result, symbol, securityId: underlying.securityId, segment: underlying.segment };
}

/**
 * The live option chain for one underlying and expiry.
 *
 * Rate-limited to Dhan's published one request per three seconds. Returns the
 * chain normalised to the shape the desk already speaks, with bid, ask and
 * depth carried through: a last traded price alone cannot tell you whether an
 * order would fill, and that is the question a card is implicitly answering.
 */
async function optionChain(symbol, expiry) {
  const underlying = underlyingFor(symbol);
  if (!underlying) return { ok: false, reason: "UNKNOWN_UNDERLYING", symbol, chain: null };
  const wait = OPTION_CHAIN_MIN_INTERVAL_MS - (Date.now() - lastOptionChainAt);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastOptionChainAt = Date.now();

  const result = await request("/optionchain", {
    UnderlyingScrip: underlying.securityId,
    UnderlyingSeg: underlying.segment,
    Expiry: String(expiry).slice(0, 10)
  });
  if (!result.ok) return { ...result, symbol, expiry, chain: null };

  const raw = result.data || {};
  const strikes = [];
  for (const [strikeKey, legs] of Object.entries(raw.oc || {})) {
    const strike = num(strikeKey);
    if (strike === null) continue;
    for (const side of ["ce", "pe"]) {
      const leg = legs?.[side];
      if (!leg) continue;
      const lastPrice = num(leg.last_price);
      const bid = num(leg.top_bid_price);
      const ask = num(leg.top_ask_price);
      strikes.push({
        strike,
        optionType: side.toUpperCase(),
        lastPrice,
        bid,
        ask,
        bidQuantity: num(leg.top_bid_quantity),
        askQuantity: num(leg.top_ask_quantity),
        // A quote nobody is standing behind is not a tradeable price.
        spread: bid !== null && ask !== null && ask > 0 ? Math.round((ask - bid) * 100) / 100 : null,
        spreadPct: bid > 0 && ask > 0 ? Math.round(((ask - bid) / ((ask + bid) / 2)) * 10000) / 100 : null,
        openInterest: num(leg.oi),
        volume: num(leg.volume),
        impliedVolatility: num(leg.implied_volatility),
        delta: num(leg.greeks?.delta),
        gamma: num(leg.greeks?.gamma),
        theta: num(leg.greeks?.theta),
        vega: num(leg.greeks?.vega),
        tradeable: Boolean(bid > 0 && ask > 0)
      });
    }
  }
  strikes.sort((a, b) => a.strike - b.strike || a.optionType.localeCompare(b.optionType));

  return {
    ok: true,
    symbol,
    expiry: String(expiry).slice(0, 10),
    securityId: underlying.securityId,
    segment: underlying.segment,
    underlyingPrice: num(raw.last_price),
    receivedAt: new Date().toISOString(),
    source: "DHAN_V2_OPTION_CHAIN_LIVE",
    strikeCount: strikes.length,
    chain: strikes
  };
}

/** One contract out of a live chain, or null. */
function quoteFromChain(chain, strike, optionType) {
  if (!chain?.chain) return null;
  const wanted = Number(strike);
  const side = String(optionType || "").toUpperCase();
  return chain.chain.find((row) => row.strike === wanted && row.optionType === side) || null;
}

module.exports = {
  API_ROOT,
  CREDENTIALS_FILE,
  OPTION_CHAIN_MIN_INTERVAL_MS,
  SCRIP_CACHE,
  SCRIP_MASTER_URL,
  expiryList,
  loadCredentials,
  loadScripMaster,
  optionChain,
  quoteFromChain,
  refreshScripMaster,
  status,
  underlyingFor
};
