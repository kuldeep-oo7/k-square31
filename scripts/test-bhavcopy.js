"use strict";

const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const { frontFutures, parseCsv, unzipSingle } = require("../api/_lib/bhavcopy");

const HEADERS = "TradDt,FinInstrmTp,TckrSymb,XpryDt,ClsPric,UndrlygPric,SttlmPric,OpnIntrst,TtlTradgVol,NewBrdLotQty";
const rows = parseCsv([
  HEADERS,
  "2026-08-14,STF,RELIANCE,2026-08-25,1410.50,1404.20,1410.50,12000,900,250",
  "2026-08-14,STF,RELIANCE,2026-09-29,1420.00,1404.20,1420.00,4000,200,250",
  "2026-08-14,STO,RELIANCE,2026-08-25,12.00,1404.20,12.00,500,50,250",
  "2026-08-14,IDF,NIFTY,2026-08-27,24500.00,24480.00,24500.00,90000,5000,75",
  "2026-08-14,STF,BROKEN,2026-08-25,0,1404.20,0,0,0,250",
  "2026-08-14,STF,NOSPOT,2026-08-25,100,0,100,0,0,250",
  "2026-08-14,STF,BADDATE,not-a-date,100,99,100,0,0,250"
].join("\n"));

assert.equal(rows.length, 7);
assert.equal(rows[0].TckrSymb, "RELIANCE");
assert.equal(rows[0].ClsPric, "1410.50");

const front = frontFutures(rows);
assert.equal(front.size, 2, "only the two valid symbols survive");
assert.ok(front.has("RELIANCE"));
assert.ok(front.has("NIFTY"));

// The front contract is the near expiry, which is the one this desk trades.
assert.equal(front.get("RELIANCE").expiry, "2026-08-25");
assert.equal(front.get("RELIANCE").futures, 1410.5);
assert.equal(front.get("RELIANCE").spot, 1404.2);
assert.equal(front.get("RELIANCE").lotSize, 250, "the lot size comes free with the contract");
assert.equal(front.get("NIFTY").instrument, "IDF");

// Options share the symbol and must not be mistaken for the future.
assert.notEqual(front.get("RELIANCE").futures, 12, "an option premium is not a futures price");

// Rows that cannot produce a basis are dropped rather than defaulted.
["BROKEN", "NOSPOT", "BADDATE"].forEach((symbol) => {
  assert.equal(front.has(symbol), false, `${symbol} should be rejected`);
});

// Expiry order must decide the front contract regardless of row order.
const reversed = frontFutures([...rows].reverse());
assert.equal(reversed.get("RELIANCE").expiry, "2026-08-25", "row order must not decide the front month");

// The zip reader handles both stored and deflated single entries.
function zipOf(name, payload, store) {
  const body = store ? Buffer.from(payload) : zlib.deflateRawSync(Buffer.from(payload));
  const nameBuffer = Buffer.from(name);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(store ? 0 : 8, 8);
  header.writeUInt32LE(body.length, 18);
  header.writeUInt16LE(nameBuffer.length, 26);
  return Buffer.concat([header, nameBuffer, body]);
}
assert.equal(unzipSingle(zipOf("a.csv", "hello,world", false)).toString(), "hello,world");
assert.equal(unzipSingle(zipOf("a.csv", "stored,entry", true)).toString(), "stored,entry");
const { frontStockFutures } = require("../api/_lib/bhavcopy");
const stfOnly = frontStockFutures(rows);
assert.equal(stfOnly.size, 1, "frontStockFutures must exclude IDF index futures and keep only STF");
assert.ok(stfOnly.has("RELIANCE"));
assert.equal(stfOnly.has("NIFTY"), false, "IDF index futures must be excluded from stock futures");

console.log("Bhavcopy tests passed: front-contract selection, options excluded, unusable rows dropped and single-entry unzip");
