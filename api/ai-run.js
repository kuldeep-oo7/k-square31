const { processSymbol } = require("./_lib/ai-engine");
const { syncGoogleArchive } = require("./_lib/google-archive");
const { fetchChart } = require("./_lib/market-feed");
const { calculate, mergeStoredHistory } = require("./market")._test;
const { safeEqual } = require("./_lib/security");
const { mutateAiShard, readAiShard } = require("./_lib/store");
const { shardUniverse } = require("./_lib/universe");

function authorized(request) {
  const supplied = String(request.headers?.authorization || "");
  const secret = process.env.CRON_SECRET || process.env.AI_AUTOMATION_SECRET;
  return Boolean(secret) && safeEqual(supplied, `Bearer ${secret}`);
}

module.exports = async function handler(request, response) {
  response.setHeader("Cache-Control", "private, no-store, max-age=0");
  if (request.method !== "GET") return response.status(405).json({ error: "Method not allowed" });
  if (!authorized(request)) return response.status(401).json({ error: "Unauthorized" });
  const shard = Number(request.query?.shard);
  if (!Number.isInteger(shard) || shard < 0 || shard > 9) return response.status(400).json({ error: "Invalid shard" });

  const items = shardUniverse(shard);
  let snapshot;
  try {
    snapshot = (await readAiShard(shard)).data;
  } catch (error) {
    console.error("AI history snapshot failed", error);
    return response.status(503).json({ error: "Historical market database is temporarily unavailable" });
  }
  const fetched = await Promise.allSettled(items.map(async (item) => {
    const savedSessions = Array.isArray(snapshot.symbols?.[item.symbol]?.observations)
      ? snapshot.symbols[item.symbol].observations.length : 0;
    const range = savedSessions >= 1_000 ? "3mo" : "5y";
    return { item, result: await fetchChart(item.symbol, { range }), range };
  }));
  const benchmark = await fetchChart("^NSEI", { range: "5y" }).catch(() => null);
  const now = Date.now();
  const failures = [];
  const completed = [];
  const archiveItems = [];

  try {
    const updated = await mutateAiShard(shard, (document) => {
      document.symbols ||= {};
      document.transactions ||= [];
      fetched.forEach((outcome, index) => {
        const item = items[index];
        if (outcome.status !== "fulfilled") {
          failures.push({ symbol: item.symbol, error: String(outcome.reason?.message || "Market feed failed").slice(0, 120) });
          return;
        }
        try {
          const previous = document.symbols[item.symbol] || { symbol: item.symbol };
          const enrichedResult = mergeStoredHistory(outcome.value.result, previous.observations);
          let quantContext = {};
          try {
            const analytics = calculate(item.symbol, enrichedResult, benchmark);
            quantContext = {
              signals: analytics.signals,
              empirical: analytics.empirical,
              analogModel: analytics.analogModel,
              window: analytics.window,
              quarter: analytics.quarter
            };
          } catch (error) {
            console.error(`Quant snapshot failed for ${item.symbol}`, error);
          }
          const processed = processSymbol(previous, enrichedResult, now, quantContext);
          document.symbols[item.symbol] = { ...processed.state, sector: item.sector, marketCapCategory: item.marketCapCategory };
          if (processed.events.length) document.transactions.unshift(...processed.events);
          archiveItems.push(outcome.value);
          completed.push({
            symbol: item.symbol, events: processed.events.length, price: processed.state.lastPrice,
            historySessions: processed.state.observations.length, fetchedRange: outcome.value.range
          });
        } catch (error) {
          failures.push({ symbol: item.symbol, error: String(error.message || error).slice(0, 120) });
        }
      });
      document.transactions = document.transactions.slice(0, 300);
      document.lastRun = {
        time: new Date(now).toISOString(), completed: completed.length, failed: failures.length,
        minimumHistorySessions: completed.length ? Math.min(...completed.map((item) => item.historySessions)) : 0
      };
      return document;
    });
    let googleArchive = { configured: false, synced: false, rows: 0 };
    try {
      googleArchive = await syncGoogleArchive(shard, archiveItems);
    } catch (error) {
      googleArchive = { configured: true, synced: false, rows: 0, error: String(error.message || error).slice(0, 120) };
      console.error("Google Sheets archive sync failed", error);
    }
    return response.status(failures.length === items.length ? 503 : 200).json({
      ok: failures.length < items.length, shard, symbols: items.length,
      completed: completed.length, trades: completed.reduce((sum, item) => sum + item.events, 0),
      history: {
        minimumSessions: completed.length ? Math.min(...completed.map((item) => item.historySessions)) : 0,
        maximumSessions: completed.length ? Math.max(...completed.map((item) => item.historySessions)) : 0,
        backfilledSymbols: completed.filter((item) => item.fetchedRange === "5y").length
      },
      googleArchive, failures, updatedAt: updated.updatedAt
    });
  } catch (error) {
    console.error("AI paper grid failed", error);
    return response.status(503).json({ error: "AI paper grid storage is temporarily unavailable" });
  }
};
