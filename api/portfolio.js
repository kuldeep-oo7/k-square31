const crypto = require("node:crypto");
const { noStore, readSession, validCsrf, validOrigin } = require("./_lib/security");
const { mutatePortfolio, readPortfolio } = require("./_lib/store");
const { cleanPortfolio, replaceBrokerSnapshot } = require("./_lib/portfolio-model");

function validNumber(value, maximum) {
  return Number.isFinite(value) && value > 0 && value <= maximum;
}

module.exports = async function handler(request, response) {
  noStore(response);
  const session = readSession(request);
  if (!session) return response.status(401).json({ error: "Authentication required" });
  if (session.username === "ai") return response.status(403).json({ error: "The AI account is an automatic paper ledger and cannot accept manual portfolio changes" });

  if (request.method === "GET") {
    const stored = await readPortfolio(session.username);
    return response.status(200).json({ portfolio: cleanPortfolio(stored.data) });
  }
  if (request.method !== "POST") return response.status(405).json({ error: "Method not allowed" });
  if (!validOrigin(request) || !validCsrf(request, session)) return response.status(403).json({ error: "Forbidden" });

  let body = request.body || {};
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  if (body.action === "replace-broker-futures") {
    const snapshotId = String(body.snapshotId || "");
    if (session.username !== "shah@kamlesh" || !/^[a-zA-Z0-9-]{8,100}$/.test(snapshotId) || !Array.isArray(body.positions)) {
      return response.status(400).json({ error: "Invalid broker snapshot" });
    }
    try {
      const updated = await mutatePortfolio(session.username, (portfolio) => replaceBrokerSnapshot(portfolio, body.positions, snapshotId, body.realizedPnl));
      return response.status(200).json({ portfolio: cleanPortfolio(updated) });
    } catch (error) {
      if (error.code === "SNAPSHOT") return response.status(400).json({ error: error.message });
      console.error("Broker snapshot import failed", error);
      return response.status(503).json({ error: "The portfolio database is temporarily unavailable" });
    }
  }
  const action = body.action === "sell" ? "sell" : body.action === "buy" ? "buy" : null;
  const symbol = String(body.symbol || "").trim().toUpperCase();
  const price = Number(body.price);
  const quantity = Number(body.quantity);
  const requestId = String(body.requestId || "");
  if (!action || !/^[A-Z0-9&-]{1,30}$/.test(symbol) || !validNumber(price, 10_000_000) || !validNumber(quantity, 10_000_000) || !/^[a-zA-Z0-9-]{8,80}$/.test(requestId)) {
    return response.status(400).json({ error: "Invalid portfolio transaction" });
  }

  try {
    const updated = await mutatePortfolio(session.username, (portfolio) => {
      portfolio = cleanPortfolio(portfolio);
      if (portfolio.transactions.some((transaction) => transaction.requestId === requestId)) return portfolio;
      if (action === "buy") {
        portfolio.lots.push({ id: crypto.randomUUID(), symbol, price, quantity, time: Date.now(), assetType: "equity", position: "long", market: "NSE" });
      } else {
        const available = portfolio.lots.filter((lot) => lot.symbol === symbol && lot.assetType !== "future").reduce((sum, lot) => sum + Number(lot.quantity), 0);
        if (quantity > available + 0.0000001) {
          const error = new Error("Quantity is larger than the stored holding");
          error.code = "QUANTITY";
          throw error;
        }
        let remaining = quantity;
        let realized = 0;
        const nextLots = [];
        for (const lot of portfolio.lots) {
          if (lot.symbol !== symbol || lot.assetType === "future" || remaining <= 0) { nextLots.push(lot); continue; }
          const used = Math.min(remaining, Number(lot.quantity));
          realized += (price - Number(lot.price)) * used;
          remaining -= used;
          const left = Number(lot.quantity) - used;
          if (left > 0.0000001) nextLots.push({ ...lot, quantity: left });
        }
        portfolio.lots = nextLots;
        portfolio.realizedPnl += realized;
      }
      portfolio.transactions.unshift({ requestId, action, symbol, price, quantity, time: Date.now() });
      portfolio.transactions = portfolio.transactions.slice(0, 100);
      return portfolio;
    });
    return response.status(200).json({ portfolio: cleanPortfolio(updated) });
  } catch (error) {
    if (error.code === "QUANTITY") return response.status(409).json({ error: error.message });
    console.error("Portfolio mutation failed", error);
    return response.status(503).json({ error: "The portfolio database is temporarily unavailable" });
  }
};
