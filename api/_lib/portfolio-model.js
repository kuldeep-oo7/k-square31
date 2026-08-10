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
  if (assetType === "future" && raw?.source === "broker-snapshot") {
    const buyQuantity = Number(raw.buyQuantity);
    const buyAverage = Number(raw.buyAverage);
    const sellQuantity = Number(raw.sellQuantity);
    const sellAverage = Number(raw.sellAverage);
    const mtm = Number(raw.mtm);
    if (Number.isFinite(buyQuantity) && buyQuantity >= 0) lot.buyQuantity = buyQuantity;
    if (Number.isFinite(buyAverage) && buyAverage >= 0) lot.buyAverage = buyAverage;
    if (Number.isFinite(sellQuantity) && sellQuantity >= 0) lot.sellQuantity = sellQuantity;
    if (Number.isFinite(sellAverage) && sellAverage >= 0) lot.sellAverage = sellAverage;
    if (Number.isFinite(mtm)) lot.mtm = mtm;
  }
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
  const cleaned = {
    version: 2,
    lots: (Array.isArray(portfolio?.lots) ? portfolio.lots : []).map(cleanLot).filter(Boolean),
    realizedPnl: Number(portfolio?.realizedPnl) || 0,
    transactions: (Array.isArray(portfolio?.transactions) ? portfolio.transactions : []).map(cleanTransaction).filter(Boolean).slice(0, 100),
    updatedAt: portfolio?.updatedAt || null
  };
  if (portfolio?.brokerSync && typeof portfolio.brokerSync === "object") {
    cleaned.brokerSync = {
      capturedAt: String(portfolio.brokerSync.capturedAt || "").slice(0, 40),
      source: portfolio.brokerSync.source === "gm-extension" ? "gm-extension" : "broker-import",
      snapshotId: String(portfolio.brokerSync.snapshotId || "").slice(0, 100),
      positionCount: Number(portfolio.brokerSync.positionCount) || cleaned.lots.filter((lot) => lot.assetType === "future").length
    };
  }
  return cleaned;
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
    markSource: positive(raw?.markPrice) ? "broker-close" : "broker-snapshot", time: Date.now(),
    buyQuantity: Number(raw?.buyQuantity) || 0,
    buyAverage: Number(raw?.buyAverage) || 0,
    sellQuantity: Number(raw?.sellQuantity) || 0,
    sellAverage: Number(raw?.sellAverage) || 0,
    mtm: Number(raw?.mtm) || 0
  });
}

function replaceBrokerSnapshot(portfolio, positions, snapshotId, realizedPnl, sync = null) {
  const cleaned = positions.map(brokerPosition);
  if (positions.length > 250 || cleaned.some((item) => !item)) {
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
  const alreadyRecorded = current.transactions.some((item) => item.snapshotId === snapshotId);
  const previousByContract = new Map(current.lots.map((lot) => [lot.contractKey, lot]));
  current.lots = cleaned.map((lot) => {
    const previous = previousByContract.get(lot.contractKey);
    return previous ? { ...lot, id: previous.id, time: previous.time } : lot;
  });
  if (realizedPnl !== undefined && Number.isFinite(Number(realizedPnl))) current.realizedPnl = Number(realizedPnl);
  if (!alreadyRecorded) {
    current.transactions.unshift({
      requestId: snapshotId, snapshotId, action: "import", symbol: "PORTFOLIO",
      price: 0, quantity: 0, count: cleaned.length, time: Date.now()
    });
  }
  if (sync) current.brokerSync = {
    capturedAt: sync.capturedAt,
    source: sync.source,
    snapshotId,
    positionCount: cleaned.length
  };
  return cleanPortfolio(current);
}

module.exports = { brokerPosition, cleanLot, cleanPortfolio, contractKey, replaceBrokerSnapshot };
