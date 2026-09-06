// Balance-sheet and event overlay for the weekly futures cycle.
//
// This desk is trading, not investing, so fundamentals are not used to pick
// businesses to own. They do two jobs a price series cannot:
//
//   1. Event risk. A results date inside the trading week replaces the ladder's
//      2% mean-reversion assumption with a gap. That is a veto, not a tilt.
//   2. Balance-sheet asymmetry. Leverage and thin interest cover decide which
//      way a name gaps when the market turns, so they tilt long versus short.
//
// Yahoo's quoteSummary requires a cookie plus crumb handshake. Every failure
// degrades to "unavailable" so a fundamentals outage can never block a trade
// decision that the price history alone can support.

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const MODULES = "financialData,defaultKeyStatistics,calendarEvents";
const SESSION_TTL_MS = 30 * 60 * 1000;

let session = null;

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function raw(node) {
  const value = Number(node?.raw);
  return Number.isFinite(value) ? value : null;
}

function clamp(value, minimum = -1, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, Number(value) || 0));
}

async function yahooSession(timeoutMs = 12_000) {
  if (session && Date.now() - session.issuedAt < SESSION_TTL_MS) return session;
  // fc.yahoo.com answers 404 but sets the consent cookies the crumb is bound to.
  const seed = await fetch("https://fc.yahoo.com", {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs)
  }).catch(() => null);
  const cookies = (typeof seed?.headers?.getSetCookie === "function" ? seed.headers.getSetCookie() : [])
    .map((entry) => String(entry).split(";")[0])
    .filter(Boolean)
    .join("; ");
  if (!cookies) throw new Error("Yahoo did not issue a session cookie");
  const crumbResponse = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": USER_AGENT, Cookie: cookies, Accept: "*/*" },
    signal: AbortSignal.timeout(timeoutMs)
  });
  const crumb = (await crumbResponse.text()).trim();
  if (!crumbResponse.ok || !crumb || crumb.length > 32 || crumb.includes("<")) throw new Error("Yahoo did not issue a crumb");
  session = { cookies, crumb, issuedAt: Date.now() };
  return session;
}

function weekBounds(nowMs = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date(nowMs));
  const monday = new Date(`${parts}T00:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const saturday = new Date(monday);
  saturday.setUTCDate(saturday.getUTCDate() + 5);
  return { from: monday.toISOString().slice(0, 10), to: saturday.toISOString().slice(0, 10) };
}

function earningsWindow(calendarEvents, nowMs) {
  const dates = (calendarEvents?.earnings?.earningsDate || [])
    .map((entry) => raw(entry))
    .filter(Number.isFinite)
    .map((seconds) => new Date(seconds * 1000).toISOString().slice(0, 10))
    .sort();
  if (!dates.length) return { nextEarningsDate: null, insideTradingWeek: false };
  const { from, to } = weekBounds(nowMs);
  return {
    nextEarningsDate: dates[0],
    insideTradingWeek: dates.some((date) => date >= from && date < to)
  };
}

// One number in [-1, 1]: positive means the balance sheet supports being long
// through a weekly gap, negative means it is the better short.
function balanceSheetScore(metrics) {
  if (!metrics) return 0;
  const parts = [
    [0.3, Number.isFinite(Number(metrics.returnOnEquity)) ? clamp(Number(metrics.returnOnEquity) * 5) : null],
    [0.2, Number.isFinite(Number(metrics.profitMargin)) ? clamp(Number(metrics.profitMargin) * 8) : null],
    [0.2, Number.isFinite(Number(metrics.debtToEquity)) ? clamp((80 - Number(metrics.debtToEquity)) / 80) : null],
    [0.15, Number.isFinite(Number(metrics.currentRatio)) ? clamp((Number(metrics.currentRatio) - 1) / 1.2) : null],
    [0.15, Number.isFinite(Number(metrics.revenueGrowth)) ? clamp(Number(metrics.revenueGrowth) * 6) : null]
  ];
  // H-1: Filter out missing metrics so available weights renormalise accurately to 1.0
  const available = parts.filter(([, score]) => score !== null && Number.isFinite(score));
  const weight = available.reduce((sum, [share]) => sum + share, 0);
  if (!weight) return 0;
  return round(available.reduce((sum, [share, score]) => sum + share * score, 0) / weight, 4);
}

async function fundamentals(rawSymbol, options = {}) {
  const symbol = rawSymbol === "^NSEI" || String(rawSymbol).endsWith(".NS") ? String(rawSymbol) : `${rawSymbol}.NS`;
  try {
    const { cookies, crumb } = await yahooSession(options.timeout);
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${MODULES}&crumb=${encodeURIComponent(crumb)}`;
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Cookie: cookies, Accept: "application/json" },
      signal: AbortSignal.timeout(options.timeout || 12_000)
    });
    if (!response.ok) throw new Error(`Provider returned ${response.status}`);
    const payload = await response.json();
    const result = payload?.quoteSummary?.result?.[0];
    if (!result) throw new Error(payload?.quoteSummary?.error?.description || "No fundamentals returned");
    const financial = result.financialData || {};
    const statistics = result.defaultKeyStatistics || {};
    const metrics = {
      profitMargin: raw(statistics.profitMargins),
      returnOnEquity: raw(financial.returnOnEquity),
      returnOnAssets: raw(financial.returnOnAssets),
      operatingMargin: raw(financial.operatingMargins),
      debtToEquity: raw(financial.debtToEquity),
      currentRatio: raw(financial.currentRatio),
      quickRatio: raw(financial.quickRatio),
      totalDebt: raw(financial.totalDebt),
      totalCash: raw(financial.totalCash),
      revenueGrowth: raw(financial.revenueGrowth),
      earningsGrowth: raw(financial.earningsGrowth),
      forwardPE: raw(statistics.forwardPE),
      enterpriseValue: raw(statistics.enterpriseValue),
      beta: raw(statistics.beta),
      floatShares: raw(statistics.floatShares),
      sharesOutstanding: raw(statistics.sharesOutstanding)
    };
    const events = earningsWindow(result.calendarEvents, options.nowMs || Date.now());
    return {
      available: true,
      symbol,
      fetchedAt: new Date(options.nowMs || Date.now()).toISOString(),
      metrics,
      events,
      balanceSheetScore: balanceSheetScore(metrics),
      // A results date inside the week is a hard stop: the ladder's 2% steps are
      // sized for drift, not for an earnings gap.
      veto: events.insideTradingWeek ? "Results are scheduled inside this trading week" : null
    };
  } catch (error) {
    return { available: false, symbol, reason: String(error?.message || error).slice(0, 160), veto: null, balanceSheetScore: 0 };
  }
}

module.exports = { balanceSheetScore, earningsWindow, fundamentals, weekBounds, yahooSession };
