"use strict";

/**
 * Sector classification for the tradable NSE universe.
 *
 * WHY THIS EXISTS
 *   portfolio-risk.js enforces a sector concentration cap:
 *
 *     if (proposedOrder.sector) {
 *       const sectorCount = active.filter((p) => p.sector === proposedOrder.sector).length;
 *       if (sectorCount >= limits.maxSectorPositions) reject();
 *     }
 *
 *   Nothing in the repository ever populated `order.sector`, so that branch was
 *   unreachable and the cap was structurally dead: five simultaneous positions
 *   in Metals & Mining would have passed every risk check in the system. The
 *   classification already sat on disk in data/nifty500-constituents.csv, in the
 *   `Industry` column, unread.
 *
 * MISSING-DATA POLICY — a deliberate choice, not an accident
 *   A symbol absent from the constituent list resolves to UNCLASSIFIED rather
 *   than to null. Returning null would send the order back down the dead branch
 *   and let it escape the cap entirely; rejecting the order would punish a live
 *   trade for a stale CSV. UNCLASSIFIED is a real bucket that counts against the
 *   same per-sector limit, so an unknown name is constrained rather than exempt,
 *   and `unclassified()` lists them so the gap is visible instead of silent.
 */

const fs = require("node:fs");
const path = require("node:path");

const SOURCE = path.join(__dirname, "..", "..", "data", "nifty500-constituents.csv");
const UNCLASSIFIED = "UNCLASSIFIED";

let cache = null;
const misses = new Set();

function load() {
  if (cache) return cache;
  cache = new Map();
  let text;
  try {
    text = fs.readFileSync(SOURCE, "utf8");
  } catch {
    // A missing constituent file must not take the desk down. Every name then
    // resolves to UNCLASSIFIED, which is still subject to the concentration cap.
    return cache;
  }
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = lines[0].split(",").map((cell) => cell.trim());
  const symbolAt = header.indexOf("Symbol");
  const industryAt = header.indexOf("Industry");
  if (symbolAt < 0 || industryAt < 0) return cache;
  for (let index = 1; index < lines.length; index += 1) {
    const cells = lines[index].split(",");
    if (cells.length <= Math.max(symbolAt, industryAt)) continue;
    const symbol = String(cells[symbolAt] || "").trim().toUpperCase();
    const industry = String(cells[industryAt] || "").trim();
    if (symbol && industry) cache.set(symbol, industry);
  }
  return cache;
}

function sectorFor(rawSymbol) {
  const symbol = String(rawSymbol || "").trim().toUpperCase().replace(/\.NS$/, "");
  if (!symbol) return UNCLASSIFIED;
  const found = load().get(symbol);
  if (found) return found;
  misses.add(symbol);
  return UNCLASSIFIED;
}

function sectorCount() {
  return new Set(load().values()).size;
}

function unclassified() {
  return [...misses].sort();
}

module.exports = { UNCLASSIFIED, sectorCount, sectorFor, unclassified };
