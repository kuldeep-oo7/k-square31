"use strict";

/**
 * THE DESK'S PRICES AGAINST THE EXCHANGE'S OWN, ON EVERY BUILD.
 *
 * "Reconcile a sample with independent source records" (Global Trading Atlas,
 * 30). Done by hand on 2026-09-25 -- Angel One against nseindia.com, 34
 * contracts, median gap 0.067% -- and from now on every build: a rotating
 * handful of the rows on the page are quoted again from Angel One and, seconds
 * later, read from NSE's own quote pages:
 *   share   NextApi getSymbolData             metaData.previousClose, orderBook.lastPrice
 *   future  NextApi getSymbolDerivativesData  prevClose, lastPrice
 *   option  option-chain-v3                   lastPrice - change, lastPrice
 *
 * TWO QUESTIONS, KEPT APART.
 *  1. Is it the same CONTRACT? This is the failure the check exists for.
 *     Angel One's instrument master is half BSE and MCX and shares names with
 *     NSE (test-contract-identity.js), and a wrong token prices a real,
 *     plausible, WRONG contract. The previous session's close answers it with
 *     no timing noise: it is fixed all day and both sources carry the
 *     exchange's own figure. Measured 2026-09-25 after the close: 9 of 9
 *     identical, while SBIN's September and October futures closed at 981.30
 *     and 986.30 -- so even the next expiry of the same stock does not pass.
 *  2. Is the price current? The last price, read seconds apart, within what a
 *     price can move in those seconds.
 *
 * Judged on the WORST contract, not the median: one wrong row in sixty is
 * exactly the bug. NSE unreachable is "not checked", never "failed" -- only a
 * measured disagreement may turn a build red.
 */

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const INDICES = new Set(["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50"]);
// How far a last price may move between two reads seconds apart. An option's
// band is wide and never under three ticks: one tick on a 2-rupee premium is
// already 2.5%.
const TOLERANCE = { EQ: { pct: 1, abs: 0 }, FUT: { pct: 1, abs: 0 }, OPT: { pct: 10, abs: 0.15 } };

// Missing is missing: Number(null) is 0, and an option leg without its
// "change" would otherwise put its previous close at its last price -- a false
// "different contract" and a red build.
const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const round2 = (v) => Math.round(v * 100) / 100;
const nseDate = (iso) => { const [y, m, d] = String(iso).slice(0, 10).split("-"); return `${d}-${MON[Number(m) - 1]}-${y}`; };

/** "25-Sep-2026 15:39:28" -> "2026-09-25"; anything else -> null. */
function feedDay(stamp) {
  const m = String(stamp || "").match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  const mon = m ? MON.findIndex((x) => x.toLowerCase() === m[2].toLowerCase()) : -1;
  return mon < 0 ? null : `${m[3]}-${String(mon + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

function label(r) {
  if (r.kind === "EQ") return `${r.symbol} share`;
  if (r.kind === "FUT") return `${r.symbol} ${String(r.expiry).slice(0, 10)} FUT`;
  return `${r.symbol} ${String(r.expiry).slice(0, 10)} ${r.strike} ${r.optionType}`;
}

function urlFor(r) {
  const B = "https://www.nseindia.com/api";
  const s = encodeURIComponent(r.symbol);
  if (r.kind === "EQ") return `${B}/NextApi/apiClient/GetQuoteApi?functionName=getSymbolData&marketType=N&series=EQ&symbol=${s}`;
  if (r.kind === "FUT") return `${B}/NextApi/apiClient/GetQuoteApi?functionName=getSymbolDerivativesData&symbol=${s}`;
  return `${B}/option-chain-v3?type=${INDICES.has(r.symbol) ? "Indices" : "Equity"}&symbol=${s}&expiry=${nseDate(r.expiry)}`;
}

/** NSE's last price and previous close for one contract, from NSE's reply. */
function nseFigures(r, body) {
  if (!body || body.error) return null;
  if (r.kind === "EQ") {
    const e = body.equityResponse?.[0];
    // basePrice too: on an ex-date NSE's reference price is adjusted and a
    // feed may carry either figure. And closePrice: after the close a share
    // has two honest "last" prices -- the last trade of the continuous session
    // (NSE's orderBook.lastPrice) and the closing-session price that Angel One
    // shows. IPCALAB, 2026-09-25 16:00: 1958.80 and 1970.80; both are NSE's.
    return e ? { last: num(e.orderBook?.lastPrice), closePrice: num(e.metaData?.closePrice),
      prevClose: num(e.metaData?.previousClose), basePrice: num(e.metaData?.basePrice) } : null;
  }
  if (r.kind === "FUT") {
    const f = (body.data || []).find((x) => /^FUT/.test(x.instrumentType) && x.expiryDate === nseDate(r.expiry));
    return f ? { last: num(f.lastPrice), prevClose: num(f.prevClose) } : null;
  }
  const row = (body.records?.data || []).find((x) => Number(x.strikePrice) === Number(r.strike));
  const leg = row?.[r.optionType];
  if (!leg) return null;
  // The chain carries no previous close; its last price less its change is
  // that figure (HAVELLS OCT 1060 CE, 2026-09-25: 48.00 - 3.65 = 44.35, which
  // is what Angel One reports as the close).
  const last = num(leg.lastPrice), change = num(leg.change);
  return { last, prevClose: last > 0 && change !== null ? round2(last - change) : null };
}

/**
 * One contract, both sources. `ours` is Angel One's quote (ltp, previousClose,
 * exchangeTradeTime); `session` the newest exchange date the build saw.
 */
function compareOne(r, ours, nse, session, file = null) {
  const row = { contract: label(r), kind: r.kind, ours: num(ours?.ltp), nse: num(nse?.last),
    oursPrevClose: num(ours?.previousClose), nsePrevClose: num(nse?.prevClose), identity: null, gapPct: null, priceOff: false };
  if (!(row.ours > 0)) return { ...row, identity: "NO_QUOTE_FROM_ANGEL" };
  if (!nse) return { ...row, identity: "NOT_IN_NSE_REPLY" };
  // A contract that has not traded this session carries yesterday's figures
  // under today's stamp on Angel One (the 25 Sep pre-open replay); it proves
  // nothing either way.
  const tradedOn = feedDay(ours?.exchangeTradeTime);
  if (session && (!tradedOn || tradedOn < session)) return { ...row, identity: "NOT_TRADED_THIS_SESSION" };
  // NSE'S PAGE STILL ON THE LAST SESSION. Its last price and previous close
  // are then exactly the last settlement file's last trade and previous close,
  // while Angel One has moved on: at 09:13 on Mon 28 Sep NSE showed WIPRO OCT
  // FUT at 162.55 with a previous close of 162.87 -- Friday's last trade and
  // Thursday's close, both in NSE's own 25 Sep file -- beside Angel One's
  // Friday close, 162.35. Two different days, not two different contracts;
  // and its stale last price is no measure of ours either.
  const eq = (a, b) => a > 0 && b > 0 && Math.abs(a - b) <= 0.011;
  if (file && eq(num(nse.last), num(file.last)) && eq(row.nsePrevClose, num(file.prevClose))
      && !eq(row.oursPrevClose, num(file.prevClose))) {
    return { ...row, identity: "NSE_NOT_ROLLED_TO_TODAY" };
  }
  const refs = [row.nsePrevClose, num(nse.basePrice)].filter((v) => v > 0);
  row.identity = !(row.oursPrevClose > 0) || !refs.length ? "NO_PREVIOUS_CLOSE"
    : refs.some((v) => Math.abs(v - row.oursPrevClose) <= 0.011) ? "SAME" : "DIFFERENT";
  const nearest = [num(nse.last), num(nse.closePrice)].filter((v) => v > 0)
    .sort((a, b) => Math.abs(a - row.ours) - Math.abs(b - row.ours))[0];
  if (nearest > 0) {
    row.nse = nearest;
    const diff = Math.abs(row.ours - row.nse);
    const tol = TOLERANCE[r.kind] || TOLERANCE.OPT;
    row.gapPct = round2((100 * diff) / row.nse);
    row.priceOff = row.gapPct > tol.pct && diff > tol.abs;
  }
  return row;
}

function summarise(rows, extra = {}) {
  const judged = rows.filter((x) => x.identity === "SAME" || x.identity === "DIFFERENT");
  const priced = rows.filter((x) => x.gapPct !== null);
  const byKind = {};
  for (const k of ["EQ", "FUT", "OPT"]) {
    const g = priced.filter((x) => x.kind === k).map((x) => x.gapPct).sort((a, b) => a - b);
    if (g.length) byKind[k] = { compared: g.length, medianGapPct: g[Math.floor(g.length / 2)], worstGapPct: g[g.length - 1] };
  }
  const why = {};
  for (const x of rows) if (x.identity !== "SAME" && x.identity !== "DIFFERENT") why[x.identity] = (why[x.identity] || 0) + 1;
  const priceOff = priced.filter((x) => x.priceOff);
  return {
    checked: judged.length > 0,
    reason: judged.length ? null : `no contract could be compared (${Object.entries(why).map(([k, v]) => `${v} ${k}`).join(", ") || "none sampled"})`,
    sampled: rows.length,
    sameContract: judged.filter((x) => x.identity === "SAME").length,
    identityCompared: judged.length,
    wrongContract: judged.filter((x) => x.identity === "DIFFERENT")
      .map((x) => `${x.contract}: previous close ${x.oursPrevClose} on Angel One, ${x.nsePrevClose} on NSE`),
    priceOff: priceOff.map((x) => `${x.contract}: ${x.ours} on Angel One, ${x.nse} on NSE (${x.gapPct}%)`),
    // A price off on most of the sample is a stale or mis-scaled feed, not a
    // fast market.
    pricesMostlyOff: priced.length >= 3 && priceOff.length * 2 > priced.length,
    worstGapPct: priced.length ? Math.max(...priced.map((x) => x.gapPct)) : null,
    byKind,
    notComparable: why,
    ...extra,
    rows
  };
}

// A request that has not answered in `ms` has failed. NSE stalls some cloud
// addresses rather than refusing them, and Node's own wait for headers is five
// minutes: nine stalled reads would outlast the job's 10-minute limit, and a
// killed job is a red build -- the one thing an unreachable NSE must never
// cause. The signal tears the request down; the race covers a fetch that
// ignores it.
function timed(start, ms, what) {
  let timer;
  const signal = AbortSignal.timeout(ms);
  return Promise.race([
    Promise.resolve().then(() => start(signal)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: no answer in ${ms / 1000}s`)), ms); })
  ]).finally(() => clearTimeout(timer));
}

async function readNse(requests, { fetchImpl = fetch, pauseMs = 300, timeoutMs = 8_000, budgetMs = 30_000 } = {}) {
  const started = Date.now();
  const cookie = await timed(async (signal) => {
    const home = await fetchImpl("https://www.nseindia.com/option-chain", { headers: { "User-Agent": UA, Accept: "text/html" }, signal });
    return (home?.headers?.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  }, timeoutMs, "NSE home page");
  const replies = new Map();
  for (const r of requests) {
    const url = urlFor(r);
    if (replies.has(url)) continue;
    if (Date.now() - started > budgetMs) { replies.set(url, { error: `not asked: the ${budgetMs / 1000}s budget was spent` }); continue; }
    try {
      replies.set(url, await timed(async (signal) => {
        const res = await fetchImpl(url, { headers: { "User-Agent": UA, Accept: "application/json", Cookie: cookie, Referer: "https://www.nseindia.com/" }, signal });
        return res.ok ? res.json() : { error: `HTTP ${res.status}` };
      }, timeoutMs, "NSE"));
    } catch (error) {
      replies.set(url, { error: error.message });
    }
    if (pauseMs) await new Promise((done) => setTimeout(done, pauseMs));
  }
  return replies;
}

/**
 * requests: [{kind: EQ|FUT|OPT, symbol, expiry, strike, optionType}]
 * ours:     async (requests) => array of Angel One quotes, aligned with requests
 * session:  the newest exchange date among the build's quotes ("2026-09-25")
 */
async function crossCheck(requests, { ours, session = null, fileFor = () => null, fetchImpl = fetch, pauseMs = 300, timeoutMs = 8_000, budgetMs = 30_000, now = () => Date.now() } = {}) {
  const sample = (requests || []).filter((r) => r && r.symbol && ["EQ", "FUT", "OPT"].includes(r.kind));
  if (!sample.length) return { checked: false, reason: "nothing on the page to compare", sampled: 0 };
  let ourQuotes;
  try { ourQuotes = await timed(() => ours(sample), 3 * timeoutMs, "Angel One re-quote"); } catch (error) { return { checked: false, reason: `Angel One re-quote failed: ${error.message}`, sampled: sample.length }; }
  const angelAt = new Date(now()).toISOString();
  let replies;
  try { replies = await readNse(sample, { fetchImpl, pauseMs, timeoutMs, budgetMs }); } catch (error) { return { checked: false, reason: `NSE not reached: ${error.message}`, sampled: sample.length }; }
  const nseAt = new Date(now()).toISOString();
  const errors = [...new Set([...replies.values()].filter((b) => b && b.error).map((b) => b.error))];
  const rows = sample.map((r, i) => compareOne(r, ourQuotes?.[i] || null, nseFigures(r, replies.get(urlFor(r))), session, fileFor(r)));
  return summarise(rows, { angelAt, nseAt, nseErrors: errors });
}

/**
 * A rotating sample of the page's rows: `futuresPer` from the futures tab (the
 * instrument each level froze on) and `optionsPer` from the options tab, moved
 * on every 20-minute slot so a day of builds walks the whole page. Options get
 * more: with no row limit there are ~160 of them, and one NSE chain read
 * covers every strike of a stock, so twelve cost about as much as four.
 */
function sampleRows({ futures = [], options = [], futuresPer = 4, optionsPer = 12, nowMs = Date.now() } = {}) {
  const slot = Math.floor(nowMs / (20 * 60_000));
  const pick = (list, per) => {
    if (!list.length) return [];
    const start = (slot * per) % list.length;
    return Array.from({ length: Math.min(per, list.length) }, (_, i) => list[(start + i) % list.length]);
  };
  const fut = futures.map((f) => (f.priceBasis === "CONTRACT" && f.expiry
    ? { kind: "FUT", symbol: f.symbol, expiry: f.expiry } : { kind: "EQ", symbol: f.symbol }))
    .sort((a, b) => label(a).localeCompare(label(b)));
  const opt = options.map((o) => ({ kind: "OPT", symbol: o.symbol, expiry: o.expiry, strike: o.strike, optionType: o.right || o.optionType }))
    .sort((a, b) => label(a).localeCompare(label(b)));
  return [...pick(fut, futuresPer), ...pick(opt, optionsPer)];
}

module.exports = { TOLERANCE, feedDay, label, urlFor, nseFigures, compareOne, summarise, crossCheck, sampleRows };
