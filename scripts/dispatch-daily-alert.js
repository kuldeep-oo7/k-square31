"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { sendDailyTradeEmail, DEFAULT_RECIPIENT } = require("../api/_lib/emailer");
const { normalizeOrderSide } = require("../api/_lib/shadow-broker");
const { evaluateGlobalMacroShock } = require("../api/_lib/market-regime");
const { macroInputFromRadar } = require("../api/_lib/market-feed");
const { planIsCurrent } = require("./plan-is-current");
const {
  GoogleStoreConflictError,
  googleStoreConfigured,
  appendPortfolioAuditToGoogle,
  appendMacroRadarToGoogle,
  readGoogleDocument,
  writeGoogleDocument
} = require("../api/_lib/google-store");
const { fetchLiveMacroRadar } = require("../api/_lib/market-feed");

function getDedupePaths() {
  return [
    path.resolve(__dirname, "../data/last-email-dispatch.json"),
    path.resolve(__dirname, "../publish/last-email-dispatch.json")
  ];
}

/**
 * Checks if current time is within trading window and handles persistent deduplication.
 */
function checkDeduplication(force = false) {
  const now = new Date();
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hourCycle: "h23", weekday: "short"
  }).formatToParts(now).map((part) => [part.type, part.value]));
  const hours = Number(parts.hour);
  const day = parts.weekday;
  const todayStr = `${parts.year}-${parts.month}-${parts.day}`;
  if (force) return { allow: true, reason: "Forced execution", slot: "MANUAL", dateStr: todayStr };

  // Weekend guard
  if (day === "Sat" || day === "Sun") {
    return { allow: false, reason: "Market is closed on weekends." };
  }

  // Determine session slot: Morning (7:00 - 11:00) or Afternoon/Evening (15:00 - 21:30)
  let slot = null;
  if (hours >= 7 && hours < 11) slot = "MORNING_BRIEFING";
  else if (hours >= 15 && hours < 22) slot = "POST_MARKET_WRAP";

  // If outside these key windows in automated cron, skip to prevent spamming
  if (!slot) {
    return { allow: false, reason: `Outside scheduled briefing windows (Current IST hour: ${hours}). Skipping cron run.` };
  }

  // Check all persistent dispatch locations
  for (const statePath of getDedupePaths()) {
    if (fs.existsSync(statePath)) {
      try {
        const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
        if (state.date === todayStr && state.slot === slot) {
          return { allow: false, reason: `Alert already dispatched today for ${slot} at ${state.dispatchedAt} (Recorded in ${path.basename(path.dirname(statePath))}).` };
        }
      } catch {}
    }
  }

  return { allow: true, slot, dateStr: todayStr };
}

function dispatchKey(slot, dateStr) {
  return `K2_EMAIL_${crypto.createHash("sha256").update(`${dateStr}:${slot}`).digest("hex").slice(0, 24).toUpperCase()}`;
}

async function acquireDispatchLease(slot, dateStr, now = new Date()) {
  if (!googleStoreConfigured()) throw new Error("Durable Google operational store is required for email idempotency");
  const idempotencyKey = dispatchKey(slot, dateStr);
  const pathname = `operations/email-dispatch/${idempotencyKey}.json`;
  const current = await readGoogleDocument(pathname, null);
  const state = current?.data;
  const nowMs = now.getTime();
  if (state?.status === "SENT") return { acquired: false, reason: `Remote dispatch ${idempotencyKey} is already SENT`, state };
  if (state?.status === "DELIVERY_UNCERTAIN") {
    return { acquired: false, reason: `Remote dispatch ${idempotencyKey} has uncertain delivery and requires manual reconciliation`, state };
  }
  if (state?.status === "DISPATCHING") {
    return { acquired: false, reason: `Remote dispatch ${idempotencyKey} is leased or delivery is uncertain; manual reconciliation required`, state };
  }
  const lease = {
    idempotencyKey,
    date: dateStr,
    slot,
    status: "DISPATCHING",
    leaseAcquiredAt: now.toISOString(),
    leaseExpiresAt: new Date(nowMs + 60 * 60 * 1000).toISOString(),
    attempt: Number(state?.attempt || 0) + 1
  };
  try {
    const written = await writeGoogleDocument(pathname, lease, current?.etag || null);
    return { acquired: true, pathname, etag: written.etag, lease };
  } catch (error) {
    if (error instanceof GoogleStoreConflictError || error?.status === 409) {
      return { acquired: false, reason: `Remote dispatch ${idempotencyKey} was claimed concurrently` };
    }
    throw error;
  }
}

async function finalizeDispatchLease(acquired, status, details = {}) {
  if (!acquired?.acquired) return null;
  const record = {
    ...acquired.lease,
    ...details,
    status,
    finalizedAt: new Date().toISOString()
  };
  const written = await writeGoogleDocument(acquired.pathname, record, acquired.etag);
  return { ...record, etag: written.etag };
}

function triageFuturesPositions(positions, asOfDate = new Date()) {
  const exits = [];
  const holds = [];
  const unverified = [];
  for (const position of Array.isArray(positions) ? positions : []) {
    const symbol = String(position?.symbol || "").toUpperCase();
    const side = normalizeOrderSide(position?.side);
    const contractSymbol = String(position?.contractSymbol || "").trim();
    const expiry = String(position?.expiry || "").slice(0, 10);
    const quantity = Number(position?.quantity);
    const mark = Number(position?.markPrice ?? position?.currentPrice ?? position?.lastPrice ?? position?.previousSettlementPrice);
    const entry = Number(position?.originalEntryPrice ?? position?.averagePrice ?? position?.buyAverage);
    const target = Number(position?.targetPrice);
    const stop = Number(position?.stopLossPrice);
    const markTime = Date.parse(position.quoteAsOf || position.capturedAt || (position.lastSettledSession ? `${position.lastSettledSession}T10:00:00Z` : ""));
    const fresh = Number.isFinite(markTime) && asOfDate.getTime() - markTime >= -60000 && asOfDate.getTime() - markTime <= 24 * 60 * 60_000;
    const complete = fresh && symbol && side && contractSymbol && /^\d{4}-\d{2}-\d{2}$/.test(expiry)
      && [quantity, mark, entry, target, stop].every((value) => Number.isFinite(value) && value > 0);
    if (!complete) {
      unverified.push({
        symbol: symbol || "UNKNOWN",
        status: "DATA UNAVAILABLE — NO AUTOMATED ACTION",
        current: mark > 0 ? mark : null,
        trailingStop: null,
        target: null,
        pnlPct: null,
        reason: "Side, exact futures contract, expiry, quantity, timestamped mark, entry, target and stop are all required"
      });
      continue;
    }
    const sign = side === "BUY" ? 1 : -1;
    const pnlPct = Number(((mark / entry - 1) * 100 * sign).toFixed(4));
    const stopBreached = side === "BUY" ? mark <= stop : mark >= stop;
    const targetReached = side === "BUY" ? mark >= target : mark <= target;
    const daysToExpiry = Math.ceil((Date.parse(`${expiry}T00:00:00Z`) - asOfDate.getTime()) / 86_400_000);
    if (stopBreached || targetReached || daysToExpiry <= 3) {
      const exitReason = stopBreached
        ? `Fixed stop breached at ${stop.toFixed(2)}`
        : targetReached
          ? `Fixed target reached at ${target.toFixed(2)}`
          : `Expiry/roll review required: ${daysToExpiry} calendar days remain`;
      exits.push({
        symbol,
        contractSymbol,
        action: side === "BUY" ? "SELL TO CLOSE" : "BUY TO COVER",
        price: mark,
        pnlPct,
        reason: `${exitReason}; require a fresh executable quote and broker acknowledgement`
      });
      continue;
    }
    holds.push({
      symbol,
      contractSymbol,
      status: "HOLD — FIXED EXIT LEVELS ACTIVE",
      current: mark,
      trailingStop: stop,
      target,
      pnlPct,
      daysToExpiry
    });
  }
  return { exits, holds, unverified };
}

function recordDispatch(slot, dateStr) {
  const payload = JSON.stringify({
    date: dateStr,
    slot: slot || "MANUAL",
    dispatchedAt: new Date().toISOString()
  }, null, 2);

  for (const statePath of getDedupePaths()) {
    try {
      if (fs.existsSync(path.dirname(statePath))) {
        fs.writeFileSync(statePath, payload, "utf8");
      }
    } catch {}
  }
}

async function run() {
  console.log("=== K² Daily Trade & Defense Alert Dispatcher ===");

  const force = process.argv.includes("--force");
  const check = checkDeduplication(force);
  if (!check.allow) {
    console.log(`[DEDUPLICATION] ${check.reason}`);
    return { skipped: true, reason: check.reason };
  }

  // 1. Dynamic Holding Triage from real broker snapshot
  let sells = [];
  let holds = [];
  const positionsCandidates = [
    path.resolve(__dirname, "../data/shadow-ledger.json"),
    path.resolve(__dirname, "../gm-positions.json"),
    path.resolve(__dirname, "../gm-dump-result/gm-positions.json")
  ];

  let loadedPositions = [];
  for (const posPath of positionsCandidates) {
    if (fs.existsSync(posPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(posPath, "utf8"));
        loadedPositions = (raw.positions || []).map((position) => ({ ...position, capturedAt: position.capturedAt || raw.capturedAt }));
        if (loadedPositions.length) break;
      } catch {}
    }
  }

  if (loadedPositions.length) {
    console.log(`Auditing ${loadedPositions.length} active futures positions...`);
    const triage = triageFuturesPositions(loadedPositions);
    sells = triage.exits;
    holds = [...triage.holds, ...triage.unverified];
  }

  // 2. Dynamic Top Buy Setups from plan-full.json
  let buys = [];
  let shortsAndPuts = [];
  const planPath = path.resolve(__dirname, "../plan-full.json");
  if (fs.existsSync(planPath)) {
    try {
      const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
      const best = planIsCurrent(plan) ? plan.best || [] : [];
      const buySetups = best.filter(b => b.side === "long" && b.action !== "stand-aside");
      buySetups.slice(0, 4).forEach(b => {
        const first = (b.entries || []).find((entry) => entry?.portfolioRisk?.admitted === true && entry?.orderIntent?.executable === true) || {};
        const entry = Number(first.orderIntent?.entryPrice);
        if (entry > 0 && first.orderIntent?.executable === true) {
          buys.push({
            symbol: b.symbol,
            level: Number(first.level || 1),
            entry,
            maxCap: entry,
            target: Number(first.orderIntent.targetPrice),
            stop: Number(first.orderIntent.stopLossPrice)
          });
        }
      });

      const shortSetups = best.filter(b => b.side === "short" && b.action !== "stand-aside");
      shortSetups.slice(0, 2).forEach(s => {
        const first = (s.entries || []).find((entry) => entry?.portfolioRisk?.admitted === true && entry?.orderIntent?.executable === true) || {};
        const entry = Number(first.orderIntent?.entryPrice);
        if (entry > 0 && first.orderIntent?.executable === true) {
          shortsAndPuts.push({
            name: `${s.symbol} (Stock Future)`,
            action: "SHORT CANDIDATE",
            entry,
            target: Number(first.orderIntent.targetPrice),
            stop: Number(first.orderIntent.stopLossPrice)
          });
        }
      });
    } catch (e) {
      console.warn("Could not parse plan-full.json:", e.message);
    }
  }

  // Pure Stock Futures scope: if no short setups qualified, do NOT inject unverified index options
  // shortsAndPuts remains empty if no short qualified

  // 3. Evaluate Macro Threat Radar with real live global feeds
  const liveMacro = await fetchLiveMacroRadar().catch((err) => {
    console.warn("Live macro radar error:", err.message);
    return null;
  });

  const giftPrice = liveMacro?.giftNifty?.price ?? null;
  const giftChange = liveMacro?.giftNifty?.changePct ?? null;
  const vixPrice = liveMacro?.indiaVix?.price ?? null;
  const vixChange = liveMacro?.indiaVix?.changePct ?? null;
  const brentPrice = liveMacro?.brentCrude?.price ?? null;
  const brentChange = liveMacro?.brentCrude?.changePct ?? null;
  const spPrice = liveMacro?.sp500Futures?.price ?? null;
  const spChange = liveMacro?.sp500Futures?.changePct ?? null;
  const nqPrice = liveMacro?.nasdaqFutures?.price ?? null;
  const nqChange = liveMacro?.nasdaqFutures?.changePct ?? null;
  const inrPrice = liveMacro?.usdInr?.price ?? null;
  const inrChange = liveMacro?.usdInr?.changePct ?? null;

  const radar = evaluateGlobalMacroShock(macroInputFromRadar(liveMacro));
  if (!radar.dataComplete || radar.actionDirective === "FULL_DEFENSE") { buys = []; shortsAndPuts = []; }
  else buys = buys.filter((row) => radar.allowedLongLevels.includes(row.level));

  const macroAssets = [
    {
      name: "GIFT NIFTY (NSEIX Live)",
      ticker: "NSEIX:NIFTY1!",
      price: giftPrice !== null ? Math.round(giftPrice) : "N/A",
      changePct: giftChange !== null ? Number(giftChange.toFixed(2)) : null,
      impact: "Overnight gap indicator for domestic opening sentiment",
      threat: giftChange !== null && giftChange <= -1.2 ? "CRITICAL" : giftChange !== null && giftChange <= -0.6 ? "ELEVATED" : "NORMAL"
    },
    {
      name: "India VIX (Domestic Fear)",
      ticker: "^INDIAVIX",
      price: vixPrice !== null ? Number(vixPrice.toFixed(2)) : "N/A",
      changePct: vixChange !== null ? Number(vixChange.toFixed(2)) : null,
      impact: "Domestic fear gauge. Under 14 = Calm / Bullish Tape",
      threat: vixPrice !== null && vixPrice >= 18 ? "CRITICAL" : vixPrice !== null && vixPrice >= 14 ? "ELEVATED" : "CALM"
    },
    {
      name: "Brent Crude Oil (War & Geopolitics)",
      ticker: "BZ=F",
      price: brentPrice !== null ? Number(brentPrice.toFixed(2)) : "N/A",
      changePct: brentChange !== null ? Number(brentChange.toFixed(2)) : null,
      impact: "Spike drains INR & foreign liquidity",
      threat: brentChange !== null && brentChange >= 3.0 ? "ELEVATED" : "NORMAL"
    },
    {
      name: "US S&P 500 Futures",
      ticker: "ES=F",
      price: spPrice !== null ? Math.round(spPrice) : "N/A",
      changePct: spChange !== null ? Number(spChange.toFixed(2)) : null,
      impact: "Global equity risk sentiment & institutional liquidity",
      threat: spChange !== null && spChange <= -1.0 ? "ELEVATED" : "NORMAL"
    },
    {
      name: "US Nasdaq 100 Futures",
      ticker: "NQ=F",
      price: nqPrice !== null ? Math.round(nqPrice) : "N/A",
      changePct: nqChange !== null ? Number(nqChange.toFixed(2)) : null,
      impact: "Direct overnight drag on Indian IT (TCS, INFY, WIPRO)",
      threat: nqChange !== null && nqChange <= -1.0 ? "ELEVATED" : "NORMAL"
    },
    {
      name: "USD / INR Currency",
      ticker: "INR=X",
      price: inrPrice !== null ? Number(inrPrice.toFixed(2)) : "N/A",
      changePct: inrChange !== null ? Number(inrChange.toFixed(2)) : null,
      impact: "Rupee depreciation forces foreign equity dumping",
      threat: inrChange !== null && inrChange >= 0.5 ? "ELEVATED" : "NORMAL"
    }
  ];

  const sign = giftChange !== null && giftChange >= 0 ? "+" : "";
  const giftDisplay = giftPrice !== null ? `${Math.round(giftPrice)} (${sign}${Number(giftChange || 0).toFixed(2)}%)` : "UNAVAILABLE";
  const vixDisplay = vixPrice !== null ? Number(vixPrice).toFixed(2) : "UNAVAILABLE";
  const brentDisplay = brentPrice !== null ? `$${Number(brentPrice).toFixed(2)}` : "UNAVAILABLE";

  const payload = {
    dateStr: new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "long", year: "numeric", month: "long", day: "numeric" }),
    radar: {
      severity: radar.regime || radar.severity || "NORMAL",
      summary: `GIFT Nifty at ${giftDisplay}, India VIX at ${vixDisplay}. Brent crude at ${brentDisplay}. Directive: ${radar.actionDirective || "STANDARD_EXECUTION"}.`
    },
    macroAssets,
    sells,
    buys,
    shortsAndPuts,
    holds: holds.slice(0, 10) // Top monitored holdings
  };

  if (!process.env.K2_EMAIL_WEBHOOK_URL || !process.env.K2_EMAIL_WEBHOOK_SECRET) {
    throw new Error("Authenticated email delivery is not configured (K2_EMAIL_WEBHOOK_URL and K2_EMAIL_WEBHOOK_SECRET are required)");
  }
  const lease = await acquireDispatchLease(check.slot, check.dateStr);
  if (!lease.acquired) {
    console.log(`[REMOTE DEDUPLICATION] ${lease.reason}`);
    return { skipped: true, reason: lease.reason };
  }

  let result;
  try {
    result = await sendDailyTradeEmail(payload, { idempotencyKey: lease.lease.idempotencyKey });
    if (result?.success !== true || result?.delivered !== true || !result?.messageId) {
      throw new Error(result?.reason || "Delivery was not acknowledged");
    }
    await finalizeDispatchLease(lease, "SENT", {
      deliveredAt: new Date().toISOString(),
      messageId: result.messageId,
      recipient: DEFAULT_RECIPIENT
    });
    recordDispatch(check.slot, check.dateStr);
    console.log("Dispatch acknowledged successfully to:", DEFAULT_RECIPIENT);
  } catch (error) {
    await finalizeDispatchLease(lease, "DELIVERY_UNCERTAIN", {
      failureAt: new Date().toISOString(),
      error: String(error?.message || error).slice(0, 300)
    }).catch((leaseError) => console.error("Could not persist delivery uncertainty:", leaseError.message));
    throw error;
  }

  if (googleStoreConfigured()) {
    try {
      const allAudited = [...sells.map(s => ({ symbol: s.symbol, status: s.action, reason: s.reason, current: s.price })), ...holds];
      await appendPortfolioAuditToGoogle(allAudited);
      console.log(`Appended ${allAudited.length} portfolio audit rows to K2_PORTFOLIO_AUDIT Google Sheet.`);
      await appendMacroRadarToGoogle({
        regime: payload.radar.severity,
        actionDirective: radar.actionDirective,
        giftNiftyGapPct: giftChange,
        brentCrudePrice: brentPrice,
        indiaVix: vixPrice,
        usVix: null,
        us10y: null,
        summary: payload.radar.summary
      });
      console.log("Appended daily macro radar row to K2_MACRO_RADAR Google Sheet.");
    } catch (e) {
      console.warn("Google Sheets audit logging skipped:", e.message);
    }
  }

  return result;
}

if (require.main === module) {
  run().catch((err) => {
    console.error("FATAL dispatch failure:", err);
    process.exitCode = 1;
  });
}

module.exports = {
  acquireDispatchLease,
  checkDeduplication,
  dispatchKey,
  finalizeDispatchLease,
  run,
  triageFuturesPositions
};
