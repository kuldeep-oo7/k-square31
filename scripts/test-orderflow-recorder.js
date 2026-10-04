"use strict";
// Tests for api/_lib/orderflow-recorder.js.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { snapshot, record } = require("../api/_lib/orderflow-recorder");
let passed = 0, failed = 0;
const check = (n, ok, d = "") => { (ok ? passed++ : failed++); console.log(`  ${ok ? "ok  " : "FAIL"}  ${n}${d ? `  (${d})` : ""}`); };
const now = Date.parse("2026-10-05T04:05:00Z");   // 09:35 IST
const book = { buy: [[1210, 500, 3], [1209.9, 250, 2]], sell: [[1210.2, 400, 4]], totBuy: 152000, totSell: 98000, avg: 1208.4, lastQty: 125, tradeTime: "05-Oct-2026 09:34:59" };
const store = {
  futures: { "DRREDDY|2026-10-27": { symbol: "DRREDDY", expiry: "2026-10-27", price: 1210.1, openInterest: 31186, volume: 2993, book, fetchedAt: new Date(now - 60_000).toISOString(), exchangeFeedTime: "05-Oct-2026 09:34:59" },
             "OLD|2026-10-27": { symbol: "OLD", expiry: "2026-10-27", price: 100, book, fetchedAt: new Date(now - 3 * 3600_000).toISOString() },
             "NOBOOK|2026-10-27": { symbol: "NOBOOK", expiry: "2026-10-27", price: 100, fetchedAt: new Date(now - 60_000).toISOString() } },
  quotes: { "KOTAKBANK|2026-10-27|420|CE": { lastPrice: 11.7, openInterest: 1e6, volume: 5000, book, fetchedAt: new Date(now - 120_000).toISOString() } }
};
const s = snapshot({ store, now });
check("this build's futures book is recorded, with all five levels and the totals", s.futures.length === 1 && s.futures[0][0] === "DRREDDY" && s.futures[0][5] === 152000 && s.futures[0][8].length === 2);
check("a quote fetched hours ago is not recorded as if it were now", !s.futures.some((r) => r[0] === "OLD"));
check("a quote with no order book is not recorded", !s.futures.some((r) => r[0] === "NOBOOK"));
check("option books are recorded under their contract key", s.options.length === 1 && s.options[0][0] === "KOTAKBANK|2026-10-27|420|CE");
check("the line carries the IST time", s.ist === "2026-10-05 09:35");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "of-")); record({ store, dir, now }); const r2 = record({ store, dir, now: now + 20 * 60_000 });
check("each build appends one line to that day's file", fs.readFileSync(path.join(dir, "2026-10-05.jsonl"), "utf8").trim().split("\n").length === 1 && r2.written === false, JSON.stringify(r2));
check("nothing fresh means nothing written", record({ store: { futures: {}, quotes: {} }, dir, now }).written === false);
console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
