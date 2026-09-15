"use strict";
const crypto = require("node:crypto");

// Instrument metadata is not a quote, a signal, or permission to trade.
function parseCsv(text) {
  const rows = [], row = [];
  let field = "", quoted = false, endedQuote = false;
  text = String(text).replace(/^\uFEFF/, "");
  for (let i = 0; i <= text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === undefined) throw new Error("Unterminated CSV quote");
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (c === '"') { quoted = false; endedQuote = true; }
      else field += c;
    } else if (c === ',' || c === '\n' || c === undefined) {
      row.push(field.replace(/\r$/, "")); field = ""; endedQuote = false;
      if (c !== ',') { if (row.some((v) => v !== "")) rows.push(row.splice(0)); else row.length = 0; }
    } else if (c === '"' && field === "" && !endedQuote) quoted = true;
    else {
      if (endedQuote && c !== '\r') throw new Error("Invalid CSV text after quote");
      field += c;
    }
  }
  const header = rows.shift();
  if (!header || new Set(header).size !== header.length) throw new Error("Invalid CSV header");
  return rows.map((cells) => {
    if (cells.length !== header.length) throw new Error("CSV column count mismatch");
    return Object.fromEntries(header.map((name, i) => [name.trim(), cells[i]]));
  });
}
function sessionDate(now = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
}
function isDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || "") && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
function normalizeInstrument(row) {
  const exchange = row.exchange, type = row.instrument_type;
  const cash = ["NSE", "BSE"].includes(exchange) && row.segment === exchange && type === "EQ";
  const index = ["NSE", "BSE"].includes(exchange) && row.segment === "INDICES";
  const derivative = ["NFO", "BFO"].includes(exchange) && ["FUT", "CE", "PE"].includes(type)
    && row.segment === `${exchange}-${type === "FUT" ? "FUT" : "OPT"}`;
  if (!cash && !derivative && !index) return null;
  const lotSize = Number(row.lot_size), tickSize = Number(row.tick_size), strike = Number(row.strike);
  if (!/^\d+$/.test(row.instrument_token || "") || !/^\d+$/.test(row.exchange_token || "")
      || !row.tradingsymbol?.trim() || (!index && (!Number.isSafeInteger(lotSize) || lotSize <= 0
      || !Number.isFinite(tickSize) || tickSize <= 0))) throw new Error("Invalid instrument identity, lot or tick");
  if (derivative && (!isDate(row.expiry) || !row.name?.trim())) throw new Error("Derivative expiry/underlying missing");
  if (["CE", "PE"].includes(type) && !(Number.isFinite(strike) && strike > 0)) throw new Error("Invalid option strike");
  return {
    key: `${exchange}:${row.tradingsymbol}`, exchange, tradingSymbol: row.tradingsymbol,
    instrumentToken: String(row.instrument_token), exchangeToken: String(row.exchange_token),
    name: row.name || row.tradingsymbol, underlying: derivative ? row.name : null,
    type: index ? "INDEX" : type, segment: row.segment, expiry: derivative ? row.expiry : null,
    strike: ["CE", "PE"].includes(type) ? strike : null, lotSize: index ? null : lotSize, tickSize: index ? null : tickSize
  };
}
function buildCatalogue(sources, now = Date.now()) {
  const instruments = [], keys = new Set();
  for (const source of sources) {
    for (const raw of parseCsv(source.csv)) {
      if (raw.exchange !== source.exchange) throw new Error("Catalogue source/exchange mismatch");
      const instrument = normalizeInstrument(raw);
      if (!instrument) continue;
      if (keys.has(instrument.key)) throw new Error(`Duplicate instrument ${instrument.key}`);
      keys.add(instrument.key); instruments.push(instrument);
    }
  }
  if (!["NSE", "BSE", "NFO", "BFO"].every((exchange) => sources.some((source) => source.exchange === exchange))) throw new Error("Incomplete four-segment catalogue");
  instruments.sort((a, b) => a.key.localeCompare(b.key));
  return { schemaVersion: "indian-catalogue-v1", fetchedAt: new Date(now).toISOString(),
    receivedSession: sessionDate(now), source: "ZERODHA_PUBLIC_INSTRUMENT_MASTER",
    sourceTimestampVerified: sources.every((s) => isDate(s.sourceDate) && s.sourceDate === sessionDate(now)),
    sources: sources.map((s) => ({ exchange: s.exchange, url: s.url,
      sourceDate: s.sourceDate || null, sha256: crypto.createHash("sha256").update(s.csv).digest("hex") })),
    scope: "REFERENCE_CATALOGUE_NOT_LIVE_QUOTES_OR_TRADE_APPROVAL", instruments };
}
function directoryFromCatalogue(catalogue, original = []) {
  const base = new Map(original.map((item) => [`NSE:${item.symbol}`, item]));
  const cash = catalogue.instruments.filter((i) => i.type === "EQ").map((i) => {
    const old = base.get(i.key); base.delete(i.key);
    return { key: i.key, symbol: i.tradingSymbol, name: i.name, exchange: i.exchange,
      sector: old?.sector || "Unclassified", marketCapCategory: old?.marketCapCategory || "Unclassified",
      classification: old ? "EXISTING_EQUITY_RESEARCH_UNIVERSE" : "BROKER_CASH_LISTING_TYPE_NOT_INDEPENDENTLY_CLASSIFIED" };
  });
  for (const [key, old] of base) cash.push({ ...old, key, exchange: "NSE", classification: "ORIGINAL_WATCHLIST_CONTINUITY_REVERIFY_LISTING" });
  const groups = new Map();
  for (const i of catalogue.instruments.filter((i) => ["FUT", "CE", "PE"].includes(i.type) && i.expiry >= catalogue.receivedSession)) {
    const key = `${i.exchange}:${i.underlying}`;
    const group = groups.get(key) || { key, exchange: i.exchange, underlying: i.underlying, FUT: 0, CE: 0, PE: 0, expiries: [] };
    group[i.type] += 1;
    if (!group.expiries.includes(i.expiry)) group.expiries.push(i.expiry);
    groups.set(key, group);
  }
  return { schemaVersion: catalogue.schemaVersion, fetchedAt: catalogue.fetchedAt, receivedSession: catalogue.receivedSession,
    source: catalogue.source, sourceTimestampVerified: catalogue.sourceTimestampVerified, sources: catalogue.sources,
    coverageMeaning: "Venue listings, not unique companies or fully analyzed stocks. Cash listings may include ETFs, debt or other securities. Current trade approval still requires fresh quotes and contract checks.",
    originalResearchNames: original.length, cashListings: cash.length,
    derivativeContracts: [...groups.values()].reduce((n, g) => n + g.FUT + g.CE + g.PE, 0),
    cash: cash.sort((a, b) => a.key.localeCompare(b.key)),
    indices: catalogue.instruments.filter((i) => i.type === "INDEX").map((i) => ({ key: i.key, name: i.name, exchange: i.exchange, symbol: i.tradingSymbol })),
    derivatives: [...groups.values()].map((g) => ({ ...g, expiries: g.expiries.sort() })).sort((a, b) => a.key.localeCompare(b.key)) };
}
module.exports = { parseCsv, normalizeInstrument, buildCatalogue, directoryFromCatalogue, sessionDate, isDate };
