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

function saveCachedBars(symbol, bars) {
  try {
    ensureCacheDir();
    const file = getCacheFilePath(symbol);
    const payload = {
      symbol,
      fetchedAt: new Date().toISOString(),
      provider: "YahooFinance",
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

module.exports = {
  getCachedBars,
  saveCachedBars,
  fetchAndCacheBars,
  StaggeredBarIngestor,
  CACHE_DIR
};
