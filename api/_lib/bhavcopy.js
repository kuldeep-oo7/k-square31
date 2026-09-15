// NSE's public F&O bhavcopy: the futures price for every contract, published as
// a static archive rather than through the API that sits behind Akamai.
//
// It solves the problem GM could not. GM serves a contract price only for names
// already held — its market watch answers "Session Expired" even to its own UI —
// so carry could be measured on the book but not on the universe. The bhavcopy
// carries every contract, and carries the underlying price in the same row.
//
// That last detail matters more than it looks. Pairing a futures price from one
// feed with a spot price from another produced a 3.4% "basis" on a contract
// twelve days from expiry, which was really a day of price movement. Here both
// legs are struck at the same instant by construction, so the mismatch cannot
// happen.

const zlib = require("node:zlib");

const ARCHIVE = "https://nsearchives.nseindia.com/content/fo";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const FUTURES = new Set(["STF", "IDF"]);
const STOCK_FUTURES = new Set(["STF"]);
const SECURITY_BAN_URL = "https://archives.nseindia.com/content/fo/fo_secban.csv";

// NSE stock futures inherit the cash-market tick for the underlying. The current
// exchange schedule is INR 0.01 below INR 250 and INR 0.05 at/above INR 250.
// Prefer an explicit positive tick from an instrument master when one is present.
function stockFutureTickSize(underlyingPrice, suppliedTick = null) {
  const explicit = Number(suppliedTick);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const price = Number(underlyingPrice);
  if (!Number.isFinite(price) || price <= 0) return null;
  return price < 250 ? 0.01 : 0.05;
}

function stamp(date) {
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
}

// Minimal reader for the single-entry zip NSE publishes. Pulling in an archive
// library for one deflate stream is not worth the dependency.
function unzipSingle(buffer) {
  if (buffer.readUInt32LE(0) !== 0x04034b50) throw new Error("Not a zip archive");
  const method = buffer.readUInt16LE(8);
  const nameLength = buffer.readUInt16LE(26);
  const extraLength = buffer.readUInt16LE(28);
  const start = 30 + nameLength + extraLength;
  let compressedSize = buffer.readUInt32LE(18);
  if (!compressedSize) {
    // Streamed entries leave the size in the trailing central directory.
    const marker = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    compressedSize = marker > start ? marker - start : buffer.length - start;
  }
  const body = buffer.subarray(start, start + compressedSize);
  return method === 0 ? body : zlib.inflateRawSync(body);
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return [];
  const headers = lines[0].split(",").map((header) => header.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    return Object.fromEntries(headers.map((header, index) => [header, (cells[index] || "").trim()]));
  });
}

async function fetchBhavcopy(date, timeoutMs = 45_000) {
  const url = `${ARCHIVE}/BhavCopy_NSE_FO_0_0_0_${stamp(date)}_F_0000.csv.zip`;
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`bhavcopy ${stamp(date)} returned ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 1000) throw new Error(`bhavcopy ${stamp(date)} was empty`);
  return { tradeDate: stamp(date), rows: parseCsv(unzipSingle(buffer).toString("utf8")) };
}

// Walks back from `from` until a session is found, so weekends and holidays need
// no calendar.
async function latestBhavcopy(from = new Date(), maxLookback = 7) {
  const errors = [];
  for (let back = 0; back <= maxLookback; back += 1) {
    const date = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() - back));
    const weekday = date.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    try {
      return await fetchBhavcopy(date);
    } catch (error) {
      errors.push(String(error?.message || error));
    }
  }
  throw new Error(`No bhavcopy in the last ${maxLookback} days: ${errors.slice(0, 3).join("; ")}`);
}

// One entry per symbol, using the front contract — the one this desk trades.
function frontFutures(rows, options = {}) {
  const allowed = options.stockOnly ? STOCK_FUTURES : FUTURES;
  const bySymbol = new Map();
  for (const row of rows) {
    if (!allowed.has(row.FinInstrmTp)) continue;
    const close = Number(row.ClsPric);
    const spot = Number(row.UndrlygPric);
    const symbol = String(row.TckrSymb || "").toUpperCase();
    if (!symbol || !(close > 0) || !(spot > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(row.XpryDt)) continue;
    const entry = {
      symbol,
      expiry: row.XpryDt,
      futures: close,
      spot,
      settlement: Number(row.SttlmPric) || close,
      // The contract's own session range, which is the honest daily high and low
      // for a futures position — the underlying's range is a different number.
      dayHigh: Number(row.HghPric) || null,
      dayLow: Number(row.LwPric) || null,
      dayOpen: Number(row.OpnPric) || null,
      previousClose: Number(row.PrvsClsgPric) || null,
      openInterest: Number(row.OpnIntrst) || 0,
      volume: Number(row.TtlTradgVol) || 0,
      lotSize: Number(row.NewBrdLotQty) || null,
      instrumentId: String(row.FinInstrmId || "").trim() || null,
      // Never synthesize a broker identifier. Missing exchange identity makes
      // the row usable for research/carry only, not for an order.
      contractSymbol: String(row.TradgSymbl || row.FinInstrmNm || "").trim() || null,
      tradeDate: String(row.TradDt || row.BizDt || "").slice(0, 10) || null,
      instrument: row.FinInstrmTp,
      segment: "NSE_FO",
      instrumentType: row.FinInstrmTp === "STF" ? "STOCK_FUTURE" : "INDEX_FUTURE",
      finInstrmTp: row.FinInstrmTp,
      tickSize: stockFutureTickSize(spot, row.TickSize || row.TckSz)
    };
    const existing = bySymbol.get(symbol);
    if (!existing || entry.expiry < existing.expiry) bySymbol.set(symbol, entry);
  }
  return bySymbol;
}

// NSE publishes this file for the next trade date. A failed download is not an
// empty ban list; callers receive `available:false` and must block fresh risk.
function parseSecurityBanList(text) {
  const lines = String(text).replace(/^\uFEFF/, "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const header = /^Securities in Ban For Trade Date (\d{2})-([A-Z]{3})-(\d{4}):$/i.exec(lines[0] || "");
  if (!header) throw new Error("UNRECOGNIZED_DATED_BAN_HEADER");
  const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const month = months.indexOf(header[2].toUpperCase()) + 1;
  const tradeDate = `${header[3]}-${String(month).padStart(2, "0")}-${header[1]}`;
  if (!month || !Number.isFinite(Date.parse(tradeDate)) || new Date(tradeDate).toISOString().slice(0, 10) !== tradeDate) throw new Error("INVALID_BAN_TRADE_DATE");
  const symbols = new Set();
  for (const [index, line] of lines.slice(1).entries()) {
    const row = /^(\d+),([A-Z0-9&-]{1,30})$/.exec(line);
    if (!row || Number(row[1]) !== index + 1 || symbols.has(row[2])) throw new Error("MALFORMED_BAN_SYMBOL_ROW");
    symbols.add(row[2]);
  }
  return { tradeDate, symbols };
}

function banStateForSession(state, session) {
  return state?.available === true && state.symbols instanceof Set && state.tradeDate === session;
}

async function fetchSecurityBanList(timeoutMs = 15_000) {
  try {
    const response = await fetch(SECURITY_BAN_URL, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/csv,*/*" },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    const { symbols, tradeDate } = parseSecurityBanList(text);
    return { available: true, symbols, tradeDate, source: SECURITY_BAN_URL, fetchedAt: new Date().toISOString() };
  } catch (error) {
    return { available: false, symbols: null, source: SECURITY_BAN_URL, fetchedAt: new Date().toISOString(), error: String(error?.message || error) };
  }
}

// Keeps the complete near/mid/far contract chain. The front-only map is enough
// for discovery, but a genuine roll requires both the expiring and next contract
// with their own prices, volume, OI, lot size and instrument identity.
function futuresBySymbol(rows, options = {}) {
  const allowed = options.stockOnly === false ? FUTURES : STOCK_FUTURES;
  const grouped = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!allowed.has(row.FinInstrmTp)) continue;
    const close = Number(row.ClsPric);
    const spot = Number(row.UndrlygPric);
    const symbol = String(row.TckrSymb || "").toUpperCase();
    if (!symbol || !(close > 0) || !(spot > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(row.XpryDt)) continue;
    const contract = {
      symbol,
      expiry: row.XpryDt,
      futures: close,
      spot,
      settlement: Number(row.SttlmPric) || close,
      dayHigh: Number(row.HghPric) || null,
      dayLow: Number(row.LwPric) || null,
      dayOpen: Number(row.OpnPric) || null,
      previousClose: Number(row.PrvsClsgPric) || null,
      openInterest: Number(row.OpnIntrst) || 0,
      volume: Number(row.TtlTradgVol) || 0,
      lotSize: Number(row.NewBrdLotQty) || null,
      instrumentId: String(row.FinInstrmId || "").trim() || null,
      contractSymbol: String(row.TradgSymbl || row.FinInstrmNm || "").trim() || null,
      tradeDate: String(row.TradDt || row.BizDt || "").slice(0, 10) || null,
      instrument: row.FinInstrmTp,
      segment: "NSE_FO",
      instrumentType: row.FinInstrmTp === "STF" ? "STOCK_FUTURE" : "INDEX_FUTURE",
      finInstrmTp: row.FinInstrmTp,
      tickSize: stockFutureTickSize(spot, row.TickSize || row.TckSz)
    };
    if (!grouped.has(symbol)) grouped.set(symbol, []);
    grouped.get(symbol).push(contract);
  }
  for (const contracts of grouped.values()) contracts.sort((left, right) => left.expiry.localeCompare(right.expiry));
  return grouped;
}

function stockFuturesBySymbol(rows) {
  return futuresBySymbol(rows, { stockOnly: true });
}

function frontStockFutures(rows) {
  return frontFutures(rows, { stockOnly: true });
}

module.exports = {
  banStateForSession,
  parseSecurityBanList,
  fetchBhavcopy,
  fetchSecurityBanList,
  frontFutures,
  frontStockFutures,
  futuresBySymbol,
  latestBhavcopy,
  parseCsv,
  stockFuturesBySymbol,
  stockFutureTickSize,
  unzipSingle
};
