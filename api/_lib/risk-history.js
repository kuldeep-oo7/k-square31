"use strict";

/**
 * TWO YEARS OF DAILY PRICES, FOR THE RISK VIEW ONLY.
 *
 * The technical read keeps its own three months of bars (bar-cache.js). Giving
 * it two years would change what it computes, and with it every score and every
 * BUY on the page -- a model change, not a data change. So the risk view reads
 * its own copy: the same Yahoo series (split- and dividend-adjusted, as
 * resultBars() builds it), two years long, stored compactly as
 * [IST date, open, high, low, close] per session.
 *
 * Fetched in prepare-static-build.js, only for names whose copy was taken
 * before the latest session closed. build() READS the cache and never the
 * network, so a test can drive it offline.
 */

const fs = require("node:fs");
const path = require("node:path");
const { fetchChart, resultBars } = require("./market-feed");
const { latestSessionCloseMs } = require("./bar-cache");

const DIR = path.resolve(__dirname, "../../.private/cache/risk-bars");
const RANGE = "2y";
const IST_MS = 330 * 60_000;
const MARKET = "^NSEI";
// India VIX: how much the market's implied volatility moved each day, for the
// calls' second figure on their worst day (risk-view.js).
const VIX = "^INDIAVIX";

const istDate = (ms) => new Date(ms + IST_MS).toISOString().slice(0, 10);
const fileFor = (symbol, dir = DIR) => path.join(dir, `${String(symbol).replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);

function compact(bars) {
  const rows = [];
  for (const b of bars || []) {
    const ts = Number(b.timestamp);
    if (!Number.isFinite(ts) || ts <= 0) continue;
    const row = [istDate(ts > 1e11 ? ts : ts * 1000), b.open, b.high, b.low, b.close];
    if (!row.slice(1).every((n) => Number.isFinite(n) && n > 0)) continue;
    // One row per date: a provider occasionally sends the live bar twice.
    if (rows.length && rows[rows.length - 1][0] === row[0]) rows[rows.length - 1] = row;
    else rows.push(row);
  }
  return rows;
}

function readHistory(symbol, { dir = DIR } = {}) {
  try {
    const data = JSON.parse(fs.readFileSync(fileFor(symbol, dir), "utf8"));
    return Array.isArray(data?.rows) && data.rows.length ? data : null;
  } catch {
    return null;
  }
}

function saveHistory(symbol, rows, { dir = DIR, now = Date.now() } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = fileFor(symbol, dir);
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ symbol, fetchedAt: new Date(now).toISOString(), provider: "YahooFinance", range: RANGE, rows }));
  fs.renameSync(tmp, file);
}

/**
 * THE SESSIONS THAT ARE OVER. A copy taken during a session ends in that
 * session's bar so far -- a part of a day, which would enter the history as a
 * quiet day that never happened. A bar counts from 16:00 IST on its own date.
 */
function completedRows(rows, now = Date.now()) {
  const today = istDate(now);
  const settled = new Date(now + IST_MS).getUTCHours() >= 16;
  return (rows || []).filter((r) => r[0] < today || (r[0] === today && settled));
}

/** Fetch every symbol whose copy predates the latest session close, inside a time budget. */
async function refreshRiskHistory(symbols, { now = Date.now(), budgetMs = 120_000, batchSize = 4, delayMs = 250, dir = DIR, fetcher = fetchChart } = {}) {
  const started = Date.now();
  const wanted = [...new Set([MARKET, VIX, ...symbols])];
  const close = latestSessionCloseMs(now);
  const due = wanted.filter((symbol) => !(Date.parse(readHistory(symbol, { dir })?.fetchedAt || "") > close));
  let fetched = 0, failed = 0, notReached = 0;
  const failures = [];
  for (let i = 0; i < due.length; i += batchSize) {
    if (Date.now() - started > budgetMs) { notReached = due.length - i; break; }
    await Promise.all(due.slice(i, i + batchSize).map(async (symbol) => {
      try {
        const rows = compact(resultBars(await fetcher(symbol, { range: RANGE, interval: "1d", timeout: 12_000 })));
        if (rows.length < 20) throw new Error(`only ${rows.length} sessions`);
        saveHistory(symbol, rows, { dir, now });
        fetched += 1;
      } catch (error) {
        failed += 1;
        if (failures.length < 8) failures.push(`${symbol}: ${error.message}`);
      }
    }));
    if (i + batchSize < due.length) await new Promise((r) => setTimeout(r, delayMs));
  }
  const have = wanted.filter((symbol) => readHistory(symbol, { dir })).length;
  return { wanted: wanted.length, due: due.length, fetched, failed, notReached, have, failures, seconds: Math.round((Date.now() - started) / 100) / 10 };
}

module.exports = { readHistory, saveHistory, refreshRiskHistory, completedRows, compact, istDate, MARKET, VIX, RANGE, DIR };
