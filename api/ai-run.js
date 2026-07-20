const { processSymbol } = require("./_lib/ai-engine");
const { fetchChart } = require("./_lib/market-feed");
const { safeEqual } = require("./_lib/security");
const { mutateAiShard } = require("./_lib/store");
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
  const fetched = await Promise.allSettled(items.map(async (item) => ({ item, result: await fetchChart(item.symbol) })));
  const now = Date.now();
  const failures = [];
  const completed = [];

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
          const processed = processSymbol(previous, outcome.value.result, now);
          document.symbols[item.symbol] = { ...processed.state, sector: item.sector, marketCapCategory: item.marketCapCategory };
          if (processed.events.length) document.transactions.unshift(...processed.events);
          completed.push({ symbol: item.symbol, events: processed.events.length, price: processed.state.lastPrice });
        } catch (error) {
          failures.push({ symbol: item.symbol, error: String(error.message || error).slice(0, 120) });
        }
      });
      document.transactions = document.transactions.slice(0, 300);
      document.lastRun = { time: new Date(now).toISOString(), completed: completed.length, failed: failures.length };
      return document;
    });
    return response.status(failures.length === items.length ? 503 : 200).json({
      ok: failures.length < items.length, shard, symbols: items.length,
      completed: completed.length, trades: completed.reduce((sum, item) => sum + item.events, 0),
      failures, updatedAt: updated.updatedAt
    });
  } catch (error) {
    console.error("AI paper grid failed", error);
    return response.status(503).json({ error: "AI paper grid storage is temporarily unavailable" });
  }
};
