(function expose(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.K2_GM_BRIDGE = api;
})(typeof globalThis === "object" ? globalThis : this, function bridgeFactory() {
  "use strict";

  const MONTHS = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };

  function text(value) {
    const holder = String(value ?? "")
      .replace(/<br\s*\/?\s*>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&nbsp;/gi, " ");
    return holder.replace(/\s+/g, " ").trim();
  }

  function number(value) {
    const parsed = Number(text(value).replace(/[₹,]/g, "").replace(/[^0-9.+-]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function expiry(value) {
    const match = String(value || "").toUpperCase().match(/(\d{2})([A-Z]{3})(\d{4})$/);
    return match && MONTHS[match[2]] ? `${match[3]}-${MONTHS[match[2]]}-${match[1]}` : null;
  }

  function normalizeRow(raw) {
    const cells = Array.from(raw || [], text);
    const marketIndex = cells.findIndex((cell) => cell.toUpperCase() === "NSEFUT");
    if (marketIndex < 0 || cells.length < marketIndex + 9) return null;
    // The API response can insert a hidden client/account column after NSEFUT.
    // Locate the contract by its expiry suffix so both DOM and API rows parse.
    const instrumentIndex = cells.findIndex((cell, index) => index > marketIndex && index <= marketIndex + 4 && /^(.+?)\s*(\d{2}[A-Z]{3}\d{4})$/i.test(cell));
    if (instrumentIndex < 0 || cells.length < instrumentIndex + 9) return null;
    const instrument = cells[instrumentIndex]?.toUpperCase().match(/^(.+?)\s*(\d{2}[A-Z]{3}\d{4})$/);
    if (!instrument) return null;
    const symbol = instrument[1].replace(/\s+/g, "").trim();
    const contractExpiry = expiry(instrument[2]);
    const buyQuantity = number(cells[instrumentIndex + 1]) || 0;
    const buyAverage = number(cells[instrumentIndex + 2]) || 0;
    const sellQuantity = number(cells[instrumentIndex + 3]) || 0;
    const sellAverage = number(cells[instrumentIndex + 4]) || 0;
    const netQuantity = number(cells[instrumentIndex + 5]) || 0;
    const balancePrice = number(cells[instrumentIndex + 6]) || 0;
    const mtm = number(cells[instrumentIndex + 7]) || 0;
    if (!/^[A-Z0-9&-]{1,30}$/.test(symbol) || !contractExpiry || !netQuantity) return null;
    const position = netQuantity < 0 ? "short" : "long";
    const sideAverage = position === "short" ? sellAverage : buyAverage;
    const price = sideAverage > 0 ? sideAverage : balancePrice;
    const markPrice = balancePrice > 0 ? balancePrice : null;
    if (!(price > 0)) return null;
    return {
      symbol,
      price,
      quantity: Math.abs(netQuantity),
      position,
      expiry: contractExpiry,
      ...(Number.isFinite(markPrice) && markPrice > 0 ? { markPrice: Math.round(markPrice * 100) / 100 } : {}),
      buyQuantity,
      buyAverage,
      sellQuantity,
      sellAverage,
      balancePrice: price,
      mtm
    };
  }

  function normalizeRows(rows) {
    const positions = Array.from(rows || [], normalizeRow).filter(Boolean);
    const seen = new Set();
    return positions.filter((position) => {
      const key = `${position.symbol}|${position.position}|${position.expiry}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((left, right) => left.symbol.localeCompare(right.symbol));
  }

  function rowsFromPayload(payload) {
    const found = [];
    const visited = new Set();
    const walk = (value, depth = 0) => {
      if (depth > 5 || value === null || value === undefined || typeof value !== "object" || visited.has(value)) return;
      visited.add(value);
      if (Array.isArray(value)) {
        if (value.some((cell) => text(cell).toUpperCase() === "NSEFUT")) found.push(value);
        else value.forEach((item) => walk(item, depth + 1));
        return;
      }
      ["aaData", "data", "rows", "positions", "result"].forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(value, key)) walk(value[key], depth + 1);
      });
    };
    walk(payload);
    return found;
  }

  return { expiry, normalizeRow, normalizeRows, number, rowsFromPayload, text };
});
