const MONTHS = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };

function decode(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&").replace(/&nbsp;/gi, " ").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&#39;/g, "'").replace(/&quot;/gi, '"');
}

function cellText(value) {
  return decode(String(value || "").replace(/<br\s*\/?\s*>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function number(value) {
  const parsed = Number(String(value || "").replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function expiry(value) {
  const match = String(value || "").match(/^(\d{2})([A-Z]{3})(\d{4})$/);
  return match && MONTHS[match[2]] ? `${match[3]}-${MONTHS[match[2]]}-${match[1]}` : null;
}

function parseBrokerHtml(html) {
  const positions = [];
  const rows = String(html || "").match(/<tr\b[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => cellText(match[1]));
    if (cells.length < 10 || cells[1] !== "NSEFUT") continue;
    const instrument = cells[2].match(/^(.+?)\s+(\d{2}[A-Z]{3}\d{4})$/);
    if (!instrument) continue;
    const symbol = instrument[1].replace(/\s+/g, "").toUpperCase();
    const contractExpiry = expiry(instrument[2]);
    const buyQuantity = number(cells[3]);
    const buyAverage = number(cells[4]);
    const sellQuantity = number(cells[5]);
    const sellAverage = number(cells[6]);
    const netQuantity = number(cells[7]);
    const markPrice = number(cells[8]);
    const mtm = number(cells[9]);
    if (!contractExpiry || !netQuantity) continue;
    const position = netQuantity < 0 ? "short" : "long";
    const price = position === "short" ? sellAverage : buyAverage;
    if (!(price > 0) || !(markPrice > 0)) throw new Error(`Missing entry or closing price for ${symbol}`);
    positions.push({ symbol, price, quantity: Math.abs(netQuantity), position, expiry: contractExpiry, markPrice, mtm, buyQuantity, sellQuantity });
  }
  if (!positions.length) throw new Error("No open NSE futures positions found in broker HTML");
  const keys = new Set();
  for (const item of positions) {
    const key = `${item.symbol}|${item.position}|${item.expiry}`;
    if (keys.has(key)) throw new Error(`Duplicate broker position: ${key}`);
    keys.add(key);
  }
  return positions;
}

module.exports = { parseBrokerHtml };
