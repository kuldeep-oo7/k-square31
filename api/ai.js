const { CONFIG, emptySymbolState, summarizeSymbol } = require("./_lib/ai-engine");
const { googleArchiveConfigured } = require("./_lib/google-archive");
const { noStore, readSession } = require("./_lib/security");
const { operationalDatabase, readAiShards } = require("./_lib/store");
const { SHARD_COUNT, universe, universeMetadata } = require("./_lib/universe");

module.exports = async function handler(request, response) {
  noStore(response);
  if (request.method !== "GET") return response.status(405).json({ error: "Method not allowed" });
  const session = readSession(request);
  if (!session || session.username !== "ai") return response.status(403).json({ error: "AI account required" });

  try {
    const shards = await readAiShards(Array.from({ length: SHARD_COUNT }, (_, shard) => shard));
    const stored = Object.assign({}, ...shards.map((item) => item.data.symbols || {}));
    const stocks = universe().map((item) => summarizeSymbol({ ...emptySymbolState(item.symbol), ...stored[item.symbol], ...item }));
    const transactions = shards.flatMap((item) => item.data.transactions || []).sort((a, b) => b.time - a.time).slice(0, 150);
    const summary = stocks.reduce((total, stock) => {
      total.cash += Number(stock.cash) || 0;
      total.marketValue += stock.marketValue;
      total.invested += stock.invested;
      total.openPnl += stock.openPnl;
      total.realizedPnl += Number(stock.realizedPnl) || 0;
      total.openLots += stock.lots.length;
      if (stock.lots.length) total.activeStocks += 1;
      return total;
    }, { allocated: stocks.length * CONFIG.budgetPerStock, cash: 0, marketValue: 0, invested: 0, openPnl: 0, realizedPnl: 0, openLots: 0, activeStocks: 0 });
    const storedSessions = stocks.map((stock) => Number(stock.historySessions) || 0);
    const storage = {
      operationalDatabase: operationalDatabase(),
      minimumHistorySessions: storedSessions.length ? Math.min(...storedSessions) : 0,
      maximumHistorySessions: storedSessions.length ? Math.max(...storedSessions) : 0,
      totalHistoryRows: storedSessions.reduce((sum, value) => sum + value, 0),
      googleSheetsArchive: googleArchiveConfigured() ? "connected" : "not-configured"
    };
    const updatedAt = shards.map((item) => item.data.updatedAt).filter(Boolean).sort().at(-1) || null;
    return response.status(200).json({ config: CONFIG, universe: universeMetadata(), summary, storage, stocks, transactions, updatedAt });
  } catch (error) {
    console.error("AI dashboard failed", error);
    return response.status(503).json({ error: "AI paper ledger is temporarily unavailable" });
  }
};
