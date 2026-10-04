"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { fetchChart, resultBars } = require("./market-feed");

const CACHE_DIR = path.resolve(__dirname, "../../.private/cache/bars");

function ensureCacheDir() {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
  } catch (e) {
    // Non-fatal if read-only filesystem
  }
}

function getCacheFilePath(symbol) {
  const safeName = String(symbol).replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(CACHE_DIR, `${safeName}.json`);
}

function getCachedBars(symbol, maxAgeMs = 12 * 60 * 60 * 1000) {
  try {
    const file = getCacheFilePath(symbol);
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, "utf8");
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.bars) || data.bars.length === 0) return null;
    const age = Date.now() - new Date(data.fetchedAt || 0).getTime();
    return {
      bars: data.bars,
      fetchedAt: data.fetchedAt,
      isFresh: age <= maxAgeMs,
      ageMs: age
    };
  } catch (err) {
    return null;
  }
}

function saveCachedBars(symbol, bars, { provider = "YahooFinance" } = {}) {
  try {
    ensureCacheDir();
    const file = getCacheFilePath(symbol);
    const payload = {
      symbol,
      fetchedAt: new Date().toISOString(),
      provider,
      range: "3mo",
      interval: "1d",
      count: bars.length,
      bars
    };
    const tmpFile = `${file}.tmp.${Date.now()}`;
    fs.writeFileSync(tmpFile, JSON.stringify(payload), "utf8");
    fs.renameSync(tmpFile, file);
    return true;
  } catch (err) {
    return false;
  }
}

async function fetchAndCacheBars(symbol, options = {}) {
  const maxAgeMs = options.maxAgeMs ?? (4 * 60 * 60 * 1000); // 4 hours default
  const cached = getCachedBars(symbol, maxAgeMs);

  if (cached && cached.isFresh && !options.force) {
    return {
      symbol,
      bars: cached.bars,
      fetchedAt: cached.fetchedAt,
      fromCache: true,
      error: null
    };
  }

  try {
    const res = await fetchChart(symbol, {
      range: options.range || "3mo",
      interval: options.interval || "1d",
      timeout: options.timeout || 9000
    });
    const bars = resultBars(res);
    if (Array.isArray(bars) && bars.length >= 10) {
      saveCachedBars(symbol, bars);
      return {
        symbol,
        bars,
        fetchedAt: new Date().toISOString(),
        fromCache: false,
        error: null
      };
    }
    // If provider returned fewer than 10 valid bars
    if (cached && Array.isArray(cached.bars)) {
      return {
        symbol,
        bars: cached.bars,
        fetchedAt: cached.fetchedAt,
        fromCache: true,
        error: "Insufficient provider bars; served stale cache"
      };
    }
    return { symbol, bars: null, error: "Insufficient provider bars", fromCache: false };
  } catch (err) {
    if (cached && Array.isArray(cached.bars)) {
      return {
        symbol,
        bars: cached.bars,
        fetchedAt: cached.fetchedAt,
        fromCache: true,
        error: `Network error: ${err.message}; served stale cache`
      };
    }
    return { symbol, bars: null, error: err.message, fromCache: false };
  }
}

/**
 * Progressive staggered background ingestor
 * Ingests symbols in small concurrent chunks with pause between batches to prevent rate limiting.
 */
class StaggeredBarIngestor {
  constructor(symbols = [], options = {}) {
    this.symbols = [...symbols];
    this.batchSize = options.batchSize || 3;
    this.delayMs = options.delayMs || 300;
    this.isRunning = false;
    this.onBarUpdated = typeof options.onBarUpdated === "function" ? options.onBarUpdated : null;
    this.currentIndex = 0;
  }

  async runCycle() {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      while (this.currentIndex < this.symbols.length) {
        const batch = this.symbols.slice(this.currentIndex, this.currentIndex + this.batchSize);
        this.currentIndex += this.batchSize;

        await Promise.all(
          batch.map(async (symbol) => {
            try {
              const res = await fetchAndCacheBars(symbol);
              if (res && res.bars && this.onBarUpdated) {
                this.onBarUpdated(symbol, res.bars, res.fromCache);
              }
            } catch (e) {}
          })
        );

        if (this.currentIndex < this.symbols.length) {
          await new Promise((r) => setTimeout(r, this.delayMs));
        }
      }
    } finally {
      this.isRunning = false;
    }
  }

  reset() {
    this.currentIndex = 0;
  }
}

/**
 * HISTORY THAT NEVER ADVANCES LOOKS EXACTLY LIKE HISTORY THAT DOES.
 *
 * Found 2026-09-24 in the build logs: the serverless build only ever fetched
 * names with NO history. The 210 names downloaded on the first run (23 Sep,
 * 07:54 IST) were carried in the Actions cache and never fetched again, so every
 * technical read on 24 Sep ran on bars that ended on 22 Sep, and a 36% crash
 * (POLICYBZR, 24 Sep) would not have reached the analysis at all. On Sunday the
 * bars would have crossed the five-day staleness gate and the futures tab would
 * have emptied itself, with a green build.
 *
 * The rule is now: history fetched before the most recent session CLOSED cannot
 * contain that session's bar, so it is fetched again.
 */
const IST_MS = 330 * 60_000;
const DAY_MS = 86_400_000;

/** The close (15:30 IST) of the latest weekday session at or before `now`. */
function latestSessionCloseMs(now = Date.now()) {
  const ist = new Date(now + IST_MS);
  let close = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 15, 30) - IST_MS;
  if (close > now) close -= DAY_MS;
  // A weekday holiday is treated as a session: the cost is one refresh that
  // finds nothing new, never a missed one.
  while ([0, 6].includes(new Date(close + IST_MS).getUTCDay())) close -= DAY_MS;
  return close;
}

function isBehindLatestSession(cached, now = Date.now()) {
  if (!cached || !Array.isArray(cached.bars) || cached.bars.length < 10) return true;
  return !(Date.parse(cached.fetchedAt || "") > latestSessionCloseMs(now));
}

/** The IST date of the last bar, or null. */
function lastBarDate(bars) {
  const ts = Number(bars?.[bars.length - 1]?.timestamp);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  return new Date((ts > 1e11 ? ts : ts * 1000) + IST_MS).toISOString().slice(0, 10);
}

/**
 * Fetch every symbol whose history is behind the latest session, inside a time
 * budget so a slow provider can never run a build into its timeout. A failed
 * fetch keeps the history it had (fetchAndCacheBars serves the cache on error).
 * Returns what the history ENDS on afterwards, across the whole list, so the
 * build log shows the answer rather than a count of attempts.
 */
async function refreshStaleBars(symbols, { now = Date.now(), budgetMs = 150_000, batchSize = 3, delayMs = 300 } = {}) {
  const started = Date.now();
  const due = symbols.filter((symbol) => isBehindLatestSession(getCachedBars(symbol), now));
  let refreshed = 0;
  let failed = 0;
  let notReached = 0;
  for (let i = 0; i < due.length; i += batchSize) {
    if (Date.now() - started > budgetMs) { notReached = due.length - i; break; }
    const results = await Promise.all(due.slice(i, i + batchSize)
      .map((symbol) => fetchAndCacheBars(symbol, { force: true }).catch((error) => ({ error: error.message }))));
    for (const r of results) {
      if (r && !r.error && !r.fromCache) refreshed += 1;
      else failed += 1;
    }
    if (i + batchSize < due.length) await new Promise((r) => setTimeout(r, delayMs));
  }
  const endsOn = {};
  for (const symbol of symbols) {
    const date = lastBarDate(getCachedBars(symbol)?.bars) || "none";
    endsOn[date] = (endsOn[date] || 0) + 1;
  }
  return { due: due.length, refreshed, failed, notReached, endsOn, seconds: Math.round((Date.now() - started) / 100) / 10 };
}

module.exports = {
  getCachedBars,
  saveCachedBars,
  fetchAndCacheBars,
  StaggeredBarIngestor,
  CACHE_DIR,
  latestSessionCloseMs,
  isBehindLatestSession,
  lastBarDate,
  refreshStaleBars
};
