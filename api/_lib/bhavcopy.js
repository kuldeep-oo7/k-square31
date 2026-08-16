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
function frontFutures(rows) {
  const bySymbol = new Map();
  for (const row of rows) {
    if (!FUTURES.has(row.FinInstrmTp)) continue;
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
      openInterest: Number(row.OpnIntrst) || 0,
      volume: Number(row.TtlTradgVol) || 0,
      lotSize: Number(row.NewBrdLotQty) || null,
      instrument: row.FinInstrmTp
    };
    const existing = bySymbol.get(symbol);
    if (!existing || entry.expiry < existing.expiry) bySymbol.set(symbol, entry);
  }
  return bySymbol;
}

module.exports = { fetchBhavcopy, frontFutures, latestBhavcopy, parseCsv, unzipSingle };
