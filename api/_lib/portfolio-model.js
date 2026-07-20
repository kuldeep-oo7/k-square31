const crypto = require("node:crypto");

const SYMBOL = /^[A-Z0-9&-]{1,30}$/;
const EXPIRY = /^\d{4}-\d{2}-\d{2}$/;

function positive(value, maximum = 10_000_000) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= maximum ? number : null;
}

function contractKey({ symbol, assetType, expiry, position }) {
  return assetType === "future" ? `${symbol}|FUT|${expiry}|${position}` : `${symbol}|EQ|long`;
}

function cleanLot(raw) {
  const symbol = String(raw?.symbol || "").trim().toUpperCase();
  const price = positive(raw?.price);
  const quantity = positive(raw?.quantity);
  const assetType = raw?.assetType === "future" ? "future" : "equity";
  const position = raw?.position === "short" ? "short" : "long";
  const expiry = assetType === "future" && EXPIRY.test(String(raw?.expiry || "")) ? String(raw.expiry) : null;
  if (!SYMBOL.test(symbol) || !price || !quantity || (assetType === "future" && !expiry)) return null;
  const lot = {
    id: String(raw?.id || crypto.randomUUID()).slice(0, 100), symbol, price, quantity,
    time: Number(raw?.time) || Date.now(), assetType, position,
    market: assetType === "future" ? "NSEFUT" : "NSE",
    contractKey: contractKey({ symbol, assetType, expiry, position })
  };
  if (expiry) lot.expiry = expiry;
  if (raw?.source === "broker-snapshot") lot.source = "broker-snapshot";
  const markPrice = positive(raw?.markPrice);
  if (markPrice) lot.markPrice = markPrice;
  if (["broker-snapshot", "broker-close", "exchange-live"].includes(raw?.markSource)) lot.markSource = raw.markSource;
  return lot;
}

function cleanTransaction(raw) {
  if (!raw || typeof raw !== "object") return null;
  const symbol = String(raw.symbol || "").trim().toUpperCase();
  return {
    requestId: String(raw.requestId || "").slice(0, 100),
    action: ["buy", "sell", "import"].includes(raw.action) ? raw.action : "import",
    symbol: SYMBOL.test(symbol) ? symbol : "PORTFOLIO",
    price: Number(raw.price) || 0,
    quantity: Number(raw.quantity) || 0,
    time: Number(raw.time) || Date.now(),
    count: Number(raw.count) || undefined,
    snapshotId: raw.snapshotId ? String(raw.snapshotId).slice(0, 100) : undefined
  };
}

function cleanPortfolio(portfolio) {
  return {
    version: 2,
    lots: (Array.isArray(portfolio?.lots) ? portfolio.lots : []).map(cleanLot).filter(Boolean),
    realizedPnl: Number(portfolio?.realizedPnl) || 0,
    transactions: (Array.isArray(portfolio?.transactions) ? portfolio.transactions : []).map(cleanTransaction).filter(Boolean).slice(0, 100),
    updatedAt: portfolio?.updatedAt || null
  };
}

function brokerPosition(raw) {
  const symbol = String(raw?.symbol || "").trim().toUpperCase();
  const price = positive(raw?.price);
  const quantity = positive(raw?.quantity);
  const position = raw?.position === "short" ? "short" : raw?.position === "long" ? "long" : null;
  const expiry = String(raw?.expiry || "");
  if (!SYMBOL.test(symbol) || !price || !quantity || !position || !EXPIRY.test(expiry)) return null;
  return cleanLot({
    id: crypto.randomUUID(), symbol, price, quantity, position, expiry,
    assetType: "future", market: "NSEFUT", source: "broker-snapshot",
    markPrice: positive(raw?.markPrice) || price,
    markSource: positive(raw?.markPrice) ? "broker-close" : "broker-snapshot", time: Date.now()
  });
}

function replaceBrokerSnapshot(portfolio, positions, snapshotId, realizedPnl = 0) {
  const cleaned = positions.map(brokerPosition);
  if (!positions.length || positions.length > 100 || cleaned.some((item) => !item)) {
    const error = new Error("Invalid broker futures snapshot");
    error.code = "SNAPSHOT";
    throw error;
  }
  const duplicate = new Set();
  for (const lot of cleaned) {
    if (duplicate.has(lot.contractKey)) {
      const error = new Error(`Duplicate contract: ${lot.symbol}`);
      error.code = "SNAPSHOT";
      throw error;
    }
    duplicate.add(lot.contractKey);
  }
  const current = cleanPortfolio(portfolio);
  if (current.transactions.some((item) => item.snapshotId === snapshotId)) return current;
  current.lots = cleaned;
  current.realizedPnl = Number.isFinite(Number(realizedPnl)) ? Number(realizedPnl) : 0;
  current.transactions.unshift({
    requestId: snapshotId, snapshotId, action: "import", symbol: "PORTFOLIO",
    price: 0, quantity: 0, count: cleaned.length, time: Date.now()
  });
  return cleanPortfolio(current);
}

module.exports = { brokerPosition, cleanLot, cleanPortfolio, contractKey, replaceBrokerSnapshot };
