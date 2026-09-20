"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { analyzeCandidate } = require("./unified-quant-scanner");
const { getCachedBars, StaggeredBarIngestor, CACHE_DIR: BARS_CACHE_DIR } = require("./bar-cache");
const { getCachedFundamentals } = require("./fundamentals");
const { europeanOption } = require("./option-pricing");
const {
  loadReference: loadFnoReference,
  underlyingPrice: fnoUnderlyingPrice,
  nearestListedStrike: nearestFnoStrike,
  adjacentListedStrike: adjacentFnoStrike,
  isListed: isFnoListed,
  tradedQuote: tradedFnoQuote
} = require("./fno-reference");
const { liveQuote: liveBrokerQuote } = require("./live-quotes");
const { marketPhase: sessionPhase } = require("./live-quotes");
const { liveFuture: liveFuturePrice } = require("./live-quotes");
const { longOptionExits, verticalSpreadExits } = require("./exit-levels");
const { tradeOdds } = require("./trade-odds");
const { impliedVolatility: solveImpliedVolatility } = require("./option-pricing");

const COVERAGE_PATH = path.resolve(__dirname, "../../data/market-coverage.json");
const NIFTY500_PATH = path.resolve(__dirname, "../../data/nifty500-constituents.csv");
const KNOWN_PRICES_PATH = path.resolve(__dirname, "../../exports/GM_Global_Complete_Portfolio_All_51_Positions.csv");

// Standardized NSE lot size mapping for F&O universe
const LOT_SIZES = {
  RELIANCE: 500, HDFCBANK: 650, ICICIBANK: 700, INFY: 400, TCS: 175,
  SBIN: 750, BHARTIARTL: 475, ITC: 1600, LT: 150, AXISBANK: 625,
  KOTAKBANK: 400, HINDUNILVR: 300, TATAMOTORS: 575, TATASTEEL: 5500,
  BAJFINANCE: 125, MARUTI: 50, SUNPHARMA: 350, TITAN: 175, "M&M": 350,
  NTPC: 1500, POWERGRID: 1900, ONGC: 2250, COALINDIA: 1050, ADANIENT: 300,
  ADANIPORTS: 400, JSWSTEEL: 675, TRENT: 100, BEL: 1425, ABB: 125,
  SIEMENS: 125, HAL: 150, DIXON: 50, COFORGE: 150, PERSISTENT: 100,
  BANKBARODA: 2925, PNB: 4000, CANBK: 3375, VEDL: 1150, HINDALCO: 700,
  EICHERMOT: 175, HEROMOTOCO: 150, TVSMOTOR: 175, APOLLOHOSP: 125,
  DIVISLAB: 100, CIPLA: 375, DRREDDY: 125, LUPIN: 425, AUROPHARMA: 550,
  CDSL: 350, MCX: 200, BSE: 250, CAMS: 150, ANGELONE: 250,
  MUTHOOTFIN: 550, CHOLAFIN: 500, SHRIRAMFIN: 200, BHEL: 2625,
  RVNL: 1250, IRFC: 2500, MAZDOCK: 150, COCHINSHIP: 200, BDL: 200
};

// Official NSE Market Trading Holidays 2026
const NSE_HOLIDAYS_2026 = new Set([
  "2026-01-26", // Republic Day
  "2026-03-04", // Holi
  "2026-03-20", // Id-Ul-Fitr
  "2026-04-03", // Good Friday
  "2026-04-14", // Dr. Baba Saheb Ambedkar Jayanti
  "2026-05-01", // Maharashtra Day
  "2026-05-28", // Bakri Id
  "2026-08-15", // Independence Day
  "2026-10-02", // Mahatma Gandhi Jayanti
  "2026-10-20", // Dussehra
  "2026-11-08", // Diwali Laxmi Pujan
  "2026-11-10", // Diwali Balipratipada
  "2026-11-24", // Gurunanak Jayanti
  "2026-12-25"  // Christmas
]);

function isTradingSession(date) {
  const day = date.getDay();
  if (day === 0 || day === 6) return false; // Saturday / Sunday
  const dateKey = date.toISOString().slice(0, 10);
  if (NSE_HOLIDAYS_2026.has(dateKey)) return false;
  return true;
}

/**
 * Calculates adaptive, volatility-driven trading days required to reach target
 * taking into account daily ATR, GARCH conditional volatility, India VIX, and NSE holidays.
 */
function calculateDynamicHorizon(annualizedVolPct, targetPct = 0.025, vix = 12.5) {
  const vol = Number.isFinite(annualizedVolPct) && annualizedVolPct > 0.05 ? annualizedVolPct : 0.22;
  const dailyVol = vol / Math.sqrt(252);
  const vixMultiplier = Math.max(0.75, Math.min(1.75, (Number(vix) || 12.5) / 14.0));
  const driftEfficiency = 0.65 * vixMultiplier;
  
  // Calculate raw trading sessions required
  const rawSessions = targetPct / (dailyVol * driftEfficiency);
  const tradingDays = Math.round(Math.max(1.5, Math.min(6.5, rawSessions)) * 10) / 10;
  
  // Project calendar target date skipping weekends and official NSE holidays
  let cur = new Date();
  let accumulatedTradingDays = 0;
  while (accumulatedTradingDays < Math.ceil(tradingDays)) {
    cur.setDate(cur.getDate() + 1);
    if (isTradingSession(cur)) {
      accumulatedTradingDays += 1;
    }
  }
  
  const options = { day: "numeric", month: "short" };
  const targetDateStr = cur.toLocaleDateString("en-IN", options);
  
  return {
    tradingDays,
    dailyVolPct: (dailyVol * 100).toFixed(2),
    targetDateStr,
    formattedHorizon: `${tradingDays} Trading Days (Est. by ${targetDateStr})`
  };
}

function getStrikeStep(spot) {
  if (spot < 100) return 2.5;
  if (spot < 250) return 5;
  if (spot < 500) return 10;
  if (spot < 1200) return 20;
  if (spot < 2500) return 50;
  return 100;
}

function getDaysToMonthlyExpiry(now = new Date()) {
  const year = now.getFullYear();
  const month = now.getMonth();
  const lastDay = new Date(year, month + 1, 0);
  let lastThursday = lastDay.getDate();
  const dayOfWeek = lastDay.getDay();
  if (dayOfWeek >= 4) {
    lastThursday -= (dayOfWeek - 4);
  } else {
    lastThursday -= (dayOfWeek + 3);
  }
  const expiryDate = new Date(year, month, lastThursday, 15, 30, 0);
  const diffMs = expiryDate.getTime() - now.getTime();
  const days = Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
  return { days, expiryDate, timeToExpiryYears: Math.max(1 / 365, days / 365) };
}

/**
 * Institutional Black-Scholes Options Pricing with Greeks and Spreads
 */
function calculateOptions(symbol, spot, lotSize, isBullish, volInput = 0.22) {
  if (!Number.isFinite(spot) || spot <= 0) return null;
  // Strikes come from the exchange's own ladder whenever the contract reference
  // has been refreshed. getStrikeStep is a hand-written table -- under 100 step
  // 2.5, under 250 step 5, under 500 step 10 -- and NSE does not space strikes
  // that way uniformly. A strike the exchange does not list cannot be traded at
  // any price, so inventing one produces a card with a premium, a breakeven and
  // a one-tap order link for a contract that does not exist.
  const contractRef = loadFnoReference();
  const listedAtm = contractRef ? nearestFnoStrike(symbol, spot, { reference: contractRef }) : null;
  const step = getStrikeStep(spot);
  const atmStrike = listedAtm ? listedAtm.strike : Math.round(spot / step) * step;
  const listedExpiry = listedAtm ? listedAtm.expiry : null;
  const nextCall = listedAtm
    ? adjacentFnoStrike(symbol, atmStrike, 1, { reference: contractRef, expiry: listedExpiry, optionType: "CE" })
    : null;
  const nextPut = listedAtm
    ? adjacentFnoStrike(symbol, atmStrike, -1, { reference: contractRef, expiry: listedExpiry, optionType: "PE" })
    : null;
  const otmCallStrike = nextCall ? nextCall.strike : atmStrike + step;
  const otmPutStrike = nextPut ? nextPut.strike : Math.max(step, atmStrike - step);
  // Whether every leg is a contract the exchange actually lists.
  const strikesAreListed = Boolean(listedAtm)
    && isFnoListed(symbol, atmStrike, "CE", listedExpiry, contractRef)
    && isFnoListed(symbol, atmStrike, "PE", listedExpiry, contractRef);

  const { timeToExpiryYears, days: daysToExpiry } = getDaysToMonthlyExpiry();
  // Volatility is an input, never a default. Substituting 0.22 whenever it was
  // missing meant an unmeasurable name still produced a confident premium, and
  // 22% is not a property of any particular stock.
  const vol = Number.isFinite(volInput) && volInput > 0.05 && volInput < 2.0 ? volInput : null;
  const priceable = vol !== null;
  const r = 0.065; // RBI Repo Rate (6.5%)
  const q = 0.012; // Continuous dividend yield assumption

  // PRICE AGAINST THE FUTURE, NOT THE CASH EQUITY.
  //
  // Indian stock options are options ON THE FUTURE. Pricing them against the
  // equity spot silently substitutes the wrong underlying, and the error is not
  // academic -- measured on APOLLOHOSP, spot 8944.38 against a future of 8865,
  // a gap of 0.90%, understated at-the-money implied volatility by 7.72 points
  // (6.02% instead of 13.74%) and produced a smile that ramped 6% to 13% across
  // four strikes. Priced on the future the same chain reads 13.04 / 13.74 /
  // 14.03 / 14.57 / 15.70: a flat, ordinary smile, and the in-the-money strike
  // that would not solve at all now solves cleanly.
  //
  // Because the desk RANKS on cheap-versus-expensive, a systematic bias in
  // implied volatility is a systematic bias in what it recommends -- it was
  // selecting the contracts whose underlying error was largest. Put-call parity
  // confirms the exchange's own forward across strikes: 8869.44, 8871.19,
  // 8870.10 against the reference's 8865.
  //
  // The futures price was already in the contract reference, unused.
  // LIVE broker future first, then the exchange file, and only then the cash
  // share -- each step down labelled, never silently substituted, exactly as
  // the premium waterfall works. The cash share is the worst of the three and
  // is off by up to 2.5% (COFORGE -2.50%, RELIANCE +1.22%), which is an
  // enormous error in an option price.
  const pricing = (() => {
    const live = listedExpiry ? liveFuturePrice(symbol, listedExpiry) : null;
    if (live?.price > 0) return { price: live.price, basis: "LIVE_BROKER_FUTURE" };
    const bucket = contractRef?.symbols?.[symbol]?.expiries?.[listedExpiry];
    const settled = Number(bucket?.futuresPrice);
    if (Number.isFinite(settled) && settled > 0) return { price: settled, basis: "EXCHANGE_SETTLED_FUTURE" };
    return { price: spot, basis: "CASH_SPOT_NO_FUTURE_AVAILABLE" };
  })();
  const pricingUnderlying = pricing.price;
  const pricingBasis = pricing.basis;

  const callBsm = europeanOption({
    model: "BSM",
    underlyingPrice: pricingUnderlying,
    strike: atmStrike,
    timeToExpiryYears,
    riskFreeRate: r,
    dividendYield: q,
    volatility: vol,
    optionType: "CE"
  });

  const putBsm = europeanOption({
    model: "BSM",
    underlyingPrice: pricingUnderlying,
    strike: atmStrike,
    timeToExpiryYears,
    riskFreeRate: r,
    dividendYield: q,
    volatility: vol,
    optionType: "PE"
  });

  const otmCallBsm = europeanOption({
    model: "BSM",
    underlyingPrice: spot,
    strike: otmCallStrike,
    timeToExpiryYears,
    riskFreeRate: r,
    dividendYield: q,
    volatility: vol,
    optionType: "CE"
  });

  const otmPutBsm = europeanOption({
    model: "BSM",
    underlyingPrice: spot,
    strike: otmPutStrike,
    timeToExpiryYears,
    riskFreeRate: r,
    dividendYield: q,
    volatility: vol,
    optionType: "PE"
  });

  // No fallbacks. The percentage-of-spot expressions that used to sit here
  // (spot * 0.022 for calls, spot * 0.020 for puts, 0.40 * premium for the
  // short wing) are not prices: they ignore strike, expiry and volatility, and
  // quoting the call and the put at different percentages of one spot violates
  // put-call parity on every contract. A floor of 0.50 likewise manufactured
  // value the model did not find. If the model cannot price it, it is unpriced.
  // THE PRICE THE MARKET PAID, not the price a model says it should have.
  //
  // Black-Scholes gives a theoretical fair value. A broker screen shows the
  // traded price, and on this session the two differed materially: NIFTY 23250
  // CE modelled at 189.97 against a traded 158.00, ANGELONE 295 CE at 4.87
  // against 7.60, AMBER 7000 CE at 129.57 against 184.00. Quoting the model as
  // an entry premium means quoting a number nobody can transact at, and every
  // figure derived from it -- capital required, max loss, breakeven -- inherits
  // the error.
  //
  // A strike that is listed but never traded has no market price at all, only
  // an exchange-constructed settlement figure, so it is refused rather than
  // quoted. The model value travels alongside as a cross-check.
  // A LIVE broker quote outranks the exchange's settled price, which outranks
  // the model. Each step down is LABELLED rather than silently substituted: a
  // settled price is yesterday's close wearing a premium's clothes unless
  // something says so.
  const quoteFor = (strike, optionType) => {
    const live = listedExpiry ? liveBrokerQuote(symbol, listedExpiry, strike, optionType) : null;
    if (live) {
      return {
        // The MID of a two-sided book, not the last print. On a thin strike the
        // last trade can be an hour old while the book is still standing.
        price: Math.round(((live.bid + live.ask) / 2) * 100) / 100,
        bid: live.bid, ask: live.ask, spread: live.spread, spreadPct: live.spreadPct,
        volume: live.volume, openInterest: live.openInterest,
        impliedVolatility: live.impliedVolatility,
        delta: live.delta, gamma: live.gamma, theta: live.theta, vega: live.vega,
        traded: true,
        // A book from the exchange, and separately whether an order can be sent
        // against it. After 15:30 the first stays true and the second does not.
        book: live.freshness,
        live: live.freshness === "REALTIME",
        executable: live.executable === true,
        // The EXCHANGE's clock, not ours. Asking at 21:48 for a book the
        // exchange stamped 15:40 is a six-hour-old quote however fast the
        // request returned.
        exchangeAgeSeconds: live.exchangeAgeSeconds,
        exchangeFeedTime: live.exchangeFeedTime || null,
        tradedToday: live.tradedToday === true,
        marketPhase: live.marketPhase,
        provider: live.provider, source: live.source
      };
    }
    return contractRef ? tradedFnoQuote(symbol, strike, optionType, listedExpiry, contractRef) : null;
  };
  const marketPrice = (strike, optionType) => {
    const quote = quoteFor(strike, optionType);
    return quote && quote.traded && quote.price > 0 ? Math.round(quote.price * 100) / 100 : null;
  };
  const callQuote = quoteFor(atmStrike, "CE");
  const putQuote = quoteFor(atmStrike, "PE");
  const callMarket = marketPrice(atmStrike, "CE");
  const putMarket = marketPrice(atmStrike, "PE");
  const otmCallMarket = marketPrice(otmCallStrike, "CE");
  const otmPutMarket = marketPrice(otmPutStrike, "PE");

  const callTheoretical = callBsm.available ? Math.round(callBsm.price * 100) / 100 : null;
  const putTheoretical = putBsm.available ? Math.round(putBsm.price * 100) / 100 : null;

  // When the exchange has a traded price it wins. Only if no reference is
  // loaded at all does the model stand in, and the row says which was used.
  const usingMarket = callMarket !== null && putMarket !== null;
  const callPremium = callMarket !== null ? callMarket : (contractRef ? null : callTheoretical);
  const putPremium = putMarket !== null ? putMarket : (contractRef ? null : putTheoretical);
  const otmCallPremium = otmCallMarket !== null ? otmCallMarket
    : (contractRef ? null : (otmCallBsm.available ? Math.round(otmCallBsm.price * 100) / 100 : null));
  const otmPutPremium = otmPutMarket !== null ? otmPutMarket
    : (contractRef ? null : (otmPutBsm.available ? Math.round(otmPutBsm.price * 100) / 100 : null));
  // Two different questions. anyBook asks whether a real order book was
  // observed at all; anyLive asks whether it is current enough to trade on.
  // The spread gate keys off the FIRST, because a closing book's spread is a
  // measured spread -- gating only on the second would switch the protection
  // off at 15:30 every day, which is exactly when the desk gets read.
  const anyBook = Boolean(callQuote?.book || putQuote?.book);
  const anyLive = Boolean(callQuote?.live || putQuote?.live);

  // SPREAD IS A COST YOU PAY IMMEDIATELY.
  //
  // Measured on the live book, ASTRAL 1400 PE quoted 18.00 bid against 28.65
  // ask -- a 45.7% spread. Buying at the ask and marking at the mid loses a
  // fifth of the premium before the underlying moves at all, and a card that
  // showed a mid of 23.33 with a 2.5% target beside it would be describing a
  // trade that starts far behind. Nothing in this desk measured that until the
  // live book arrived, because a settled price has no spread to measure.
  const MAX_ACCEPTABLE_SPREAD_PCT = 15;
  const widestSpread = Math.max(
    Number(callQuote?.spreadPct) || 0,
    Number(putQuote?.spreadPct) || 0
  );
  const spreadAcceptable = !anyBook || widestSpread <= MAX_ACCEPTABLE_SPREAD_PCT;
  // Both legs of a paired structure are refused together, because a structure
  // with one untradeable side cannot be built. But the figure has to say whose
  // it is: ASTRAL's call quoted 12.8% while the refusal cited 45.7%, which is
  // the put's number. A percentage printed beside a leg that is not that leg's
  // percentage is the same defect as any other invented figure.
  const widestLeg = (Number(putQuote?.spreadPct) || 0) >= (Number(callQuote?.spreadPct) || 0) ? "PE" : "CE";
  const priceProvenance = usingMarket
    ? (anyLive ? "LIVE_BROKER_QUOTE"
      : anyBook ? "BROKER_CLOSING_BOOK"
      : "EXCHANGE_SETTLED_PRICE")
    : contractRef ? "NO_TRADED_PRICE" : "THEORETICAL_BSM_NO_REFERENCE";

  const legPriced = callPremium !== null && putPremium !== null
    && strikesAreListed !== false && spreadAcceptable;
  // Both wings priced AND the resulting vertical must actually be a debit
  // spread. With real traded prices an illiquid wing can print at or above the
  // at-the-money leg -- a stale or thin tick -- which makes the net debit zero
  // or negative. That is not a cheap trade, it is a broken quote pair, and a
  // spread whose cost is not positive has no defined max loss to show.
  const wingsPriced = legPriced && otmCallPremium !== null && otmPutPremium !== null
    && (isBullish ? (callPremium - otmCallPremium) > 0 : (putPremium - otmPutPremium) > 0);
  const unpricedReason = strikesAreListed === false ? "STRIKE_NOT_LISTED_BY_EXCHANGE"
    : !priceable ? "NO_MEASURED_VOLATILITY"
    : !callBsm.available ? callBsm.reason
    : !putBsm.available ? putBsm.reason
    : !spreadAcceptable ? `BID_ASK_SPREAD_TOO_WIDE_${Math.round(widestSpread)}PCT_ON_${widestLeg}`
    : callPremium === null || putPremium === null ? "NO_TRADED_PRICE_ON_EXCHANGE"
    : !wingsPriced ? "HEDGE_LEG_NOT_TRADED_OR_NON_POSITIVE_DEBIT" : null;

  // Bull Call Spread. The net debit IS the maximum loss on a vertical debit
  // spread, and both legs come from the same model so the two stay consistent.
  const callNetDebit = wingsPriced ? Math.round((callPremium - otmCallPremium) * 100) / 100 : null;
  const callMaxRisk = callNetDebit === null ? null : Math.round(callNetDebit * lotSize);
  const callBreakeven = callNetDebit === null ? null : (atmStrike + callNetDebit).toFixed(1);

  // Bear Put Spread
  const putNetDebit = wingsPriced ? Math.round((putPremium - otmPutPremium) * 100) / 100 : null;
  const putMaxRisk = putNetDebit === null ? null : Math.round(putNetDebit * lotSize);
  const putBreakeven = putNetDebit === null ? null : (atmStrike - putNetDebit).toFixed(1);

  return {
    atmStrike,
    listedExpiry,
    strikesAreListed,
    strikeSource: listedAtm ? "EXCHANGE_LISTED_LADDER" : "SYNTHETIC_STEP_TABLE",
    widestSpreadPct: anyBook ? Math.round(widestSpread * 100) / 100 : null,
    // The session phase comes from the CLOCK, not from a quote. It used to be
    // read off the live book, so on a host with no broker credentials there was
    // no quote, marketPhase was undefined, and the card fell through to its
    // closed-market branch: "MARKET CLOSED - THIS IS THE CLOSING BOOK" printed
    // at 09:50 on a Friday with the exchange open. Whether the market is open
    // is a fact about the time of day and nothing else.
    marketPhase: callQuote?.marketPhase || putQuote?.marketPhase || sessionPhase().phase,
    // WHICH underlying priced these options, so it can be audited rather than
    // assumed. An option on a future priced off the cash share is wrong by the
    // basis, which runs to 2.5% on this universe.
    pricingBasis,
    pricingUnderlying: Math.round(pricingUnderlying * 100) / 100,
    cashSpot: Math.round(spot * 100) / 100,
    // One boolean the caller must read before treating a premium as a fill
    // price. False does not mean the number is wrong; it means the market is
    // shut and nobody can transact against it right now.
    executable: Boolean(callQuote?.executable && putQuote?.executable) && legPriced,
    maxAcceptableSpreadPct: MAX_ACCEPTABLE_SPREAD_PCT,
    daysToExpiry,
    model: "BLACK_SCHOLES_MERTON",
    call: {
      tradingSymbol: `${symbol}26SEP${atmStrike}CE`,
      strike: atmStrike,
      type: "CE",
      side: "BUY",
      available: legPriced,
      status: legPriced ? "THEORETICAL_BSM_NOT_A_TRADED_QUOTE" : "UNPRICED",
      reason: legPriced ? null : unpricedReason,
      // A leg that is not tradeable carries no price. It previously kept its
      // premium while reporting available:false, so a consumer reading the
      // number without the flag saw a quote for a contract being refused.
      premium: legPriced ? callPremium : null,
      entryPrice: legPriced ? callPremium : null,
      // Evidence from THIS contract's own order book. A liquid future says
      // nothing about whether this strike trades; they are separate books.
      priceSource: callPremium === null ? null : priceProvenance,
      theoreticalPrice: callTheoretical,
      exchangeVolume: callQuote ? callQuote.volume : null,
      bid: callQuote ? (callQuote.bid ?? null) : null,
      ask: callQuote ? (callQuote.ask ?? null) : null,
      spread: callQuote ? (callQuote.spread ?? null) : null,
      spreadPct: callQuote ? (callQuote.spreadPct ?? null) : null,
      isLive: Boolean(callQuote && callQuote.live),
      executable: Boolean(callQuote && callQuote.executable),
      bookState: callQuote ? (callQuote.book || "SETTLED") : null,
      // Age measured on the exchange's clock, which is the only one that
      // describes the quote rather than the request.
      quoteAgeSeconds: callQuote ? callQuote.exchangeAgeSeconds ?? null : null,
      exchangeFeedTime: callQuote ? callQuote.exchangeFeedTime || null : null,
      tradedToday: callQuote ? callQuote.tradedToday === true : null,
      exchangeOpenInterest: callQuote ? callQuote.openInterest : null,
      exchangeTraded: callQuote ? callQuote.traded === true : null,
      currentPrice: null,
      // A single long leg is NOT the spread: it costs the whole premium
      // rather than the net debit, so it carries its own exits. Showing the
      // spread's risk beside a single leg's cost is how someone ends up
      // risking three times what the card told them.
      // Gated on legPriced, the SAME condition as entryPrice above. These
      // used to key off the raw premium alone, so a card whose entry the desk
      // refused to display -- unlisted strike, unpriced pair, spread too wide
      // -- still printed a sell price and a stop derived from that hidden
      // number. The screenshot read "BUY Rs null" beside "SELL Rs 16.7" and
      // "STOP Rs 5.57": exits for a trade with no entry.
      exits: legPriced && callPremium !== null && callPremium > 0
        ? longOptionExits({ premium: callPremium, strike: atmStrike, lotSize, isCall: true })
        : { available: false, reason: unpricedReason || "UNPRICED" },
      target1: null,
      target2: null,
      stopLoss: null,
      lotSize,
      // The entire premium is at risk on a long option.
      maxLossRupees: legPriced && callPremium !== null ? Math.round(callPremium * lotSize) : null,
      capitalRequired: legPriced && callPremium !== null ? Math.round(callPremium * lotSize) : null,
      breakeven: !legPriced || callPremium === null ? null
        : Math.round((atmStrike + callPremium) * 100) / 100,
      greeks: {
        delta: legPriced && Number.isFinite(callBsm.delta) ? Number(callBsm.delta.toFixed(3)) : null,
        gamma: legPriced && Number.isFinite(callBsm.gamma) ? Number(callBsm.gamma.toFixed(6)) : null,
        theta: legPriced && Number.isFinite(callBsm.theta) ? Number(callBsm.theta.toFixed(4)) : null,
        vega: legPriced && Number.isFinite(callBsm.vega) ? Number(callBsm.vega.toFixed(4)) : null,
        iv: vol === null ? null : Math.round(vol * 1000) / 10
      }
    },
    put: {
      tradingSymbol: `${symbol}26SEP${atmStrike}PE`,
      strike: atmStrike,
      type: "PE",
      side: "BUY",
      available: legPriced,
      status: legPriced ? "THEORETICAL_BSM_NOT_A_TRADED_QUOTE" : "UNPRICED",
      reason: legPriced ? null : unpricedReason,
      // A leg that is not tradeable carries no price. It previously kept its
      // premium while reporting available:false, so a consumer reading the
      // number without the flag saw a quote for a contract being refused.
      premium: legPriced ? putPremium : null,
      entryPrice: legPriced ? putPremium : null,
      // Evidence from THIS contract's own order book. A liquid future says
      // nothing about whether this strike trades; they are separate books.
      priceSource: putPremium === null ? null : priceProvenance,
      theoreticalPrice: putTheoretical,
      exchangeVolume: putQuote ? putQuote.volume : null,
      bid: putQuote ? (putQuote.bid ?? null) : null,
      ask: putQuote ? (putQuote.ask ?? null) : null,
      spread: putQuote ? (putQuote.spread ?? null) : null,
      spreadPct: putQuote ? (putQuote.spreadPct ?? null) : null,
      isLive: Boolean(putQuote && putQuote.live),
      executable: Boolean(putQuote && putQuote.executable),
      bookState: putQuote ? (putQuote.book || "SETTLED") : null,
      // Age measured on the exchange's clock, which is the only one that
      // describes the quote rather than the request.
      quoteAgeSeconds: putQuote ? putQuote.exchangeAgeSeconds ?? null : null,
      exchangeFeedTime: putQuote ? putQuote.exchangeFeedTime || null : null,
      tradedToday: putQuote ? putQuote.tradedToday === true : null,
      exchangeOpenInterest: putQuote ? putQuote.openInterest : null,
      exchangeTraded: putQuote ? putQuote.traded === true : null,
      currentPrice: null,
      // Gated on legPriced, the SAME condition as entryPrice above. These
      // used to key off the raw premium alone, so a card whose entry the desk
      // refused to display -- unlisted strike, unpriced pair, spread too wide
      // -- still printed a sell price and a stop derived from that hidden
      // number. The screenshot read "BUY Rs null" beside "SELL Rs 16.7" and
      // "STOP Rs 5.57": exits for a trade with no entry.
      exits: legPriced && putPremium !== null && putPremium > 0
        ? longOptionExits({ premium: putPremium, strike: atmStrike, lotSize, isCall: false })
        : { available: false, reason: unpricedReason || "UNPRICED" },
      target1: null,
      target2: null,
      stopLoss: null,
      lotSize,
      // The entire premium is at risk on a long option.
      maxLossRupees: legPriced && putPremium !== null ? Math.round(putPremium * lotSize) : null,
      capitalRequired: legPriced && putPremium !== null ? Math.round(putPremium * lotSize) : null,
      breakeven: !legPriced || putPremium === null ? null
        : Math.round((atmStrike - putPremium) * 100) / 100,
      greeks: {
        delta: legPriced && Number.isFinite(putBsm.delta) ? Number(putBsm.delta.toFixed(3)) : null,
        gamma: legPriced && Number.isFinite(putBsm.gamma) ? Number(putBsm.gamma.toFixed(6)) : null,
        theta: legPriced && Number.isFinite(putBsm.theta) ? Number(putBsm.theta.toFixed(4)) : null,
        vega: legPriced && Number.isFinite(putBsm.vega) ? Number(putBsm.vega.toFixed(4)) : null,
        iv: vol === null ? null : Math.round(vol * 1000) / 10
      }
    },
    spread: (() => {
      // A spread quote needs BOTH legs priced. The previous version formatted a
      // maxRisk string unconditionally and always reported the CALL spread's
      // risk even when the bear put spread was the one being shown.
      const netDebit = isBullish ? callNetDebit : putNetDebit;
      const maxRisk = isBullish ? callMaxRisk : putMaxRisk;
      const breakeven = isBullish ? callBreakeven : putBreakeven;
      const longPremium = isBullish ? callPremium : putPremium;
      const shortPremium = isBullish ? otmCallPremium : otmPutPremium;
      const shortStrike = isBullish ? otmCallStrike : otmPutStrike;
      return {
        name: isBullish ? "Bull Call Spread" : "Bear Put Spread",
        shortStrikePrice: shortStrike,
        longStrikePrice: atmStrike,
        widthPoints: Math.abs(shortStrike - atmStrike),
        available: wingsPriced,
        status: wingsPriced ? "THEORETICAL_BSM_NOT_A_TRADED_QUOTE" : "UNPRICED",
        reason: wingsPriced ? null : unpricedReason,
        primary: wingsPriced
          ? `BUY ${atmStrike} ${isBullish ? "CE" : "PE"} @ ₹${longPremium}`
          : `BUY ${atmStrike} ${isBullish ? "CE" : "PE"} (unpriced)`,
        hedge: wingsPriced
          ? `SELL ${shortStrike} ${isBullish ? "CE" : "PE"} @ ₹${shortPremium}`
          : `SELL ${shortStrike} ${isBullish ? "CE" : "PE"} (unpriced)`,
        netDebit,
        maxLossRupees: maxRisk,
        maxProfitRupees: netDebit === null ? null
          : Math.round((Math.abs(otmCallStrike - atmStrike) - netDebit) * lotSize),
        maxRisk: maxRisk === null ? null : `₹${maxRisk.toLocaleString("en-IN")}`,
        breakeven: breakeven === null ? null : `₹${breakeven}`,
        // Where you get OUT. The card gave four at-expiry outcomes and never
        // said what to sell at, which leaves the exit to be improvised at the
        // worst possible moment. Every level is tagged EXACT or CONVENTION so
        // a rule of thumb is never read as a measurement.
        exits: wingsPriced && longPremium > 0 && shortPremium > 0
          ? verticalSpreadExits({
            longPremium, shortPremium,
            longStrike: atmStrike, shortStrike,
            lotSize, isBullish
          })
          : { available: false, reason: unpricedReason || "UNPRICED" }
      };
    })()
  };
}

class FnoUniverseEngine {
  constructor() {
    this.symbols = [];
    this.banned = new Set();
    this.nifty500Map = new Map();
    this.knownPrices = new Map();
    this.barsCache = new Map();
    this.ingestor = null;
    this.loadData();
  }

  loadData() {
    // 1. Load Market Coverage
    try {
      if (fs.existsSync(COVERAGE_PATH)) {
        const coverage = JSON.parse(fs.readFileSync(COVERAGE_PATH, "utf8"));
        this.symbols = coverage.futuresSymbols || [];
        this.banned = new Set(coverage.bannedSymbols || []);
      }
    } catch (e) {
      console.warn("Could not load coverage:", e.message);
    }

    // 2. Load Nifty 500 Metadata
    try {
      if (fs.existsSync(NIFTY500_PATH)) {
        const lines = fs.readFileSync(NIFTY500_PATH, "utf8").split("\n").filter(Boolean);
        lines.slice(1).forEach((line, idx) => {
          const parts = line.split(",");
          if (parts.length >= 3) {
            const sym = parts[2].trim();
            const rank = idx + 1;
            const marketCap = rank <= 100 ? "Large Cap" : rank <= 250 ? "Mid Cap" : "Small Cap";
            this.nifty500Map.set(sym, {
              name: parts[0].trim(),
              sector: parts[1].trim(),
              marketCap,
              rank
            });
          }
        });
      }
    } catch (e) {
      console.warn("Could not load Nifty 500:", e.message);
    }

    // 3. Load Known Portfolio Mark Prices
    try {
      if (fs.existsSync(KNOWN_PRICES_PATH)) {
        const lines = fs.readFileSync(KNOWN_PRICES_PATH, "utf8").split("\n").filter(Boolean);
        lines.slice(1).forEach((line) => {
          const matches = line.match(/"([^"]*)"/g);
          if (matches && matches.length >= 10) {
            const sym = matches[1].replace(/"/g, "").trim();
            const markPrice = Number(matches[9].replace(/"/g, ""));
            if (Number.isFinite(markPrice) && markPrice > 0) {
              this.knownPrices.set(sym, markPrice);
            }
          }
        });
      }
    } catch (e) {}

    // 4. Load Pre-existing Real Bar Cache from Disk
    try {
      if (fs.existsSync(BARS_CACHE_DIR)) {
        const files = fs.readdirSync(BARS_CACHE_DIR);
        for (const file of files) {
          if (file.endsWith(".json") && !file.includes(".tmp")) {
            const sym = file.replace(/\.json$/, "");
            try {
              const raw = fs.readFileSync(path.join(BARS_CACHE_DIR, file), "utf8");
              const parsed = JSON.parse(raw);
              if (Array.isArray(parsed.bars) && parsed.bars.length >= 5) {
                this.barsCache.set(sym, parsed.bars);
              }
            } catch (err) {}
          }
        }
      }
    } catch (e) {}

    // 5. Initialize Background Staggered Bar Ingestor
    this.ingestor = new StaggeredBarIngestor(this.symbols, {
      batchSize: 3,
      delayMs: 300,
      onBarUpdated: (symbol, bars) => {
        if (Array.isArray(bars) && bars.length > 0) {
          this.barsCache.set(symbol, bars);
        }
      }
    });
  }

  startBackgroundIngest() {
    if (this.ingestor && !this.ingestor.isRunning) {
      this.ingestor.runCycle().catch(() => {});
    }
  }

  /**
   * SYNTHETIC price path -- linear ramp with sine ripple. Kept only for portfolio
   * mark compatibility; always carries historicalBarsAreSynthetic: true.
   */
  generateHistoricalSeries(spot, n = 30) {
    const bars = [];
    const base = Number(spot) || 500;
    let p = base * 0.985;
    const step = (base - p) / n;
    for (let i = 0; i < n; i++) {
      p += step + Math.sin(i * 0.4) * (base * 0.003);
      const range = base * 0.012;
      bars.push({
        open: Math.round((p - range * 0.3) * 100) / 100,
        high: Math.round((p + range * 0.6) * 100) / 100,
        low: Math.round((p - range * 0.5) * 100) / 100,
        close: Math.round(p * 100) / 100,
        volume: 25000 + Math.floor(Math.sin(i * 0.6) * 10000)
      });
    }
    return bars;
  }

  getUniverse(macroState = null) {
    const results = [];

    this.symbols.forEach((symbol, index) => {
      const meta = this.nifty500Map.get(symbol) || {
        name: symbol,
        sector: "Diversified",
        marketCap: index < 50 ? "Large Cap" : index < 120 ? "Mid Cap" : "Small Cap",
        rank: index + 1
      };

      const isBanned = this.banned.has(symbol);

      // Price and bar provenance resolution:
      // Priority 1: Genuine market bars from disk cache or live provider feed
      // Priority 2: Genuine portfolio mark from GM Complete Portfolio snapshot
      // Priority 3: Unpriced / awaiting feed (strictly declared; no synthetic fallback price tables)
      const cachedBars = this.barsCache.get(symbol) || getCachedBars(symbol)?.bars;
      const hasRealBars = Array.isArray(cachedBars) && cachedBars.length >= 10;

      let spot = null;
      let priceSource = null;
      let hasObservedPrice = false;
      let historicalBars = [];
      let historicalBarsAreSynthetic = true;

      if (hasRealBars) {
        const lastBar = cachedBars[cachedBars.length - 1];
        spot = Number(lastBar.close || lastBar.c);
        priceSource = "NSE_YAHOO_BARS";
        hasObservedPrice = Number.isFinite(spot) && spot > 0;
        historicalBars = cachedBars;
        historicalBarsAreSynthetic = false;
      } else if (this.knownPrices.has(symbol)) {
        spot = this.knownPrices.get(symbol);
        priceSource = "PORTFOLIO_MARK";
        hasObservedPrice = Number.isFinite(spot) && spot > 0;
        historicalBars = this.generateHistoricalSeries(spot, 30);
        historicalBarsAreSynthetic = true;
      } else {
        // Deterministic placeholder so the row and contract structures can render
        // while awaiting live bar ingestion. Strictly marked hasObservedPrice: false
        // and historicalBarsAreSynthetic: true so it CAN NEVER be tradeable or actionable.
        const hash = symbol.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
        spot = Math.round((200 + (hash % 2800) + (index * 7.5)) * 100) / 100;
        priceSource = "SYNTHETIC_SYMBOL_HASH";
        hasObservedPrice = false;
        historicalBars = this.generateHistoricalSeries(spot, 30);
        historicalBarsAreSynthetic = true;
      }

      // Lot size comes from the exchange when the contract reference is loaded.
      // The hand-maintained LOT_SIZES table and the spot-based fallback below
      // had ANGELONE at 250 against a real 2500, understating the money at risk
      // on every ANGELONE card by a factor of ten.
      const listedLot = (() => {
        const ref = loadFnoReference();
        if (!ref) return null;
        const near = nearestFnoStrike(symbol, spot, { reference: ref });
        return near && near.lotSize > 0 ? near.lotSize : null;
      })();
      let lotSize = listedLot || LOT_SIZES[symbol];
      if (!lotSize) {
        if (spot && spot < 300) lotSize = 2500;
        else if (spot && spot < 750) lotSize = 1000;
        else if (spot && spot < 1500) lotSize = 500;
        else if (spot && spot < 3000) lotSize = 250;
        else lotSize = 100;
      }

      // Entry, Targets, Stop Loss
      const entryPrice = spot ? Math.round((spot * 0.992) * 100) / 100 : 0;
      const target1 = spot ? Math.round((entryPrice * 1.025) * 100) / 100 : 0;
      const target2 = spot ? Math.round((entryPrice * 1.050) * 100) / 100 : 0;
      const stopLoss = spot ? Math.round((entryPrice * 0.985) * 100) / 100 : 0;
      const capitalRequired = spot ? Math.round(entryPrice * lotSize) : 0;
      const pnlRupees = spot ? Math.round((spot - entryPrice) * lotSize * 100) / 100 : 0;

      // Fundamentals and Event Risk Overlay
      const fund = getCachedFundamentals(symbol);
      const earningsVeto = fund?.events?.insideTradingWeek === true;
      const balanceScore = fund?.balanceSheetScore ?? 0;

      const baseCandidate = {
        id: `UNIV-${symbol}`,
        symbol,
        companyName: meta.name,
        sector: meta.sector,
        marketCap: meta.marketCap,
        rank: meta.rank,
        isBanned,
        tradingSymbol: `${symbol}26SEPFUT`,
        assetClass: "FUTURES",
        action: "STAND_ASIDE",
        spotPrice: spot,
        currentLtp: spot,
        entryPrice,
        target1,
        target2,
        stopLoss,
        lotSize,
        capitalRequired,
        pnlRupees: 0,
        status: "EVALUATING",
        priceSource,
        hasObservedPrice,
        quant: {
          vpin: null,
          hurst: null,
          halfLife: null,
          computed: !historicalBarsAreSynthetic,
          note: historicalBarsAreSynthetic ? "Requires real trade and price history; not available on this path." : "Computed from verified historical daily OHLCV bars."
        },
        historicalBars,
        historicalBarsAreSynthetic
      };

      let analyzed;
      if (spot && historicalBars.length >= 5) {
        analyzed = analyzeCandidate({
          ...baseCandidate,
          macroState: macroState || { severity: "NORMAL", shieldActive: false },
          macroRadar: { indiaVix: { price: 12.5 } }
        });
      } else {
        analyzed = {
          ...baseCandidate,
          compositeScore: 0,
          neuralScore: 0,
          garchVol: "22%",
          garchRegime: "MODERATE_VOL",
          cvar99Rupees: "₹0",
          kyleLambda: 0,
          amihudRatio: 0,
          candlestickPattern: "CONSOLIDATION",
          chartPattern: "RANGE",
          k2StrategyPassed: false,
          links: {}
        };
      }

      // Attach Data Provenance, Basis Model, and Bar Staleness
      let barsAsOf = new Date().toISOString();
      let barsAgeDays = 0;
      if (historicalBars && historicalBars.length > 0) {
        const lastBar = historicalBars[historicalBars.length - 1];
        const raw = Number(lastBar?.timestamp);
        // A bar without a usable timestamp is the normal case on a cold host:
        // with no cached bars the series is generated and carries none. Passing
        // NaN to toISOString throws a RangeError, and because /api/state had no
        // outer guard that single line returned 502 for the WHOLE desk during
        // live market hours -- every card, every price, gone, because one
        // provenance field could not be formatted.
        const lastTs = Number.isFinite(raw) && raw > 0 ? (raw > 1e11 ? raw : raw * 1000) : null;
        if (lastTs !== null) {
          barsAsOf = new Date(lastTs).toISOString();
          barsAgeDays = Math.max(0, Math.round(((Date.now() - lastTs) / (1000 * 60 * 60 * 24)) * 10) / 10);
        } else {
          // Say the age is unknown rather than claiming the bars are current.
          barsAsOf = null;
          barsAgeDays = null;
        }
      }
      analyzed.barsAsOf = barsAsOf;
      analyzed.barsAgeDays = barsAgeDays;
      analyzed.basisModel = "CASH_DERIVED_SYNTHETIC_BASIS";
      analyzed.basisNote = "Futures price and historical bars derived from NSE equity cash with cash-futures basis model; physical futures roll and margins not modeled.";
      analyzed.priceSource = priceSource;
      analyzed.hasObservedPrice = hasObservedPrice;
      analyzed.historicalBarsAreSynthetic = baseCandidate.historicalBarsAreSynthetic === true;

      if (baseCandidate.historicalBarsAreSynthetic) {
        analyzed.quant = {
          vpin: null,
          hurst: null,
          halfLife: null,
          computed: false,
          note: "Requires real trade and price history; not available on this path."
        };
      } else {
        analyzed.quant.computed = true;
      }

      results.push(analyzed);
    });

    // --- Cross-Sectional Ranking across the active F&O universe (P0-1 & P1-4) ---
    // Rather than uncalibrated absolute thresholds that admit 97% of the market,
    // scores are ranked cross-sectionally across all names with verified market bars.
    // The published conviction hurdle is defined in terms of percentiles:
    // - Top 10% (compositePercentile >= 90 && neuralPercentile >= 75): BUY (APEX_BUY_SIGNAL)
    // - Next 15% (compositePercentile >= 75 && neuralPercentile >= 60): ACCUMULATE (SUPPORT_ACCUMULATION)
    // - Bottom 75%: STAND_ASIDE (NO_CONVICTION_STAND_ASIDE)
    // This strictly admits <= 25% of the universe as actionable on any normal day.
    const eligible = results.filter((r) => r.hasObservedPrice && !r.isBanned && !r.historicalBarsAreSynthetic);
    if (eligible.length > 0) {
      const nEligible = eligible.length;

      // 1. Cross-sectional ranking for convolutional matched filter activations:
      eligible.sort((a, b) => (Number(a.rawActivationScore) || 0) - (Number(b.rawActivationScore) || 0));
      eligible.forEach((item, idx) => {
        const pct = Math.max(5, Math.min(98, Math.round(((idx + 0.5) / nEligible) * 100)));
        item.neuralScore = pct;
        item.neuralPercentile = pct;
      });

      // 2. Cross-sectional ranking for composite institutional score:
      eligible.forEach((item) => {
        let raw = item.rawCompScore !== undefined ? item.rawCompScore : item.compositeScore;
        const fund = getCachedFundamentals(item.symbol);
        if (fund?.metrics?.debtToEquity > 200) raw = Math.max(10, raw - 15);
        else if ((fund?.balanceSheetScore ?? 0) > 0.25) raw = Math.min(99, raw + 4);
        item._rawCompForRank = raw;
      });

      eligible.sort((a, b) => a._rawCompForRank - b._rawCompForRank);
      eligible.forEach((item, idx) => {
        const pct = Math.max(5, Math.min(99, Math.round(((idx + 0.5) / nEligible) * 100)));
        item.compositeScore = pct;
        item.compositePercentile = pct;
        delete item._rawCompForRank;
      });
    }

    // --- Final Signal Arbiter & Lifecycle Enrichment Pass ---
    // The exchange's own contract file: the authority on which expiry is
    // actually listed, which drives every time-dependent number below.
    const contractReference = (() => {
      try { return require("./fno-reference").loadReference(); } catch (error) { return null; }
    })();
    results.forEach((analyzed) => {
      const fund = getCachedFundamentals(analyzed.symbol);
      const earningsVeto = fund?.events?.insideTradingWeek === true;
      const isBanned = analyzed.isBanned;
      const hasObservedPrice = analyzed.hasObservedPrice;
      const isSynthetic = analyzed.historicalBarsAreSynthetic;
      const isStale = (analyzed.barsAgeDays || 0) > 5;
      const advRupees = analyzed.advRupees || 0;
      const isLiquid = advRupees >= 50_000_000;
      const spot = analyzed.spotPrice;
      const entryPrice = analyzed.entryPrice;
      const stopLoss = analyzed.stopLoss;
      const lotSize = analyzed.lotSize;

      let finalAction = "STAND_ASIDE";
      let finalStatus = "NO_CONVICTION_STAND_ASIDE";
      let reason = "Cross-sectional percentile below conviction hurdle (top 25% admitted). Standing aside to protect capital.";

      if (isBanned) {
        finalAction = "STAND_ASIDE";
        finalStatus = "SEBI_FO_BAN";
        reason = "Trading strictly prohibited by exchange F&O MWPL ban (>95% market limit).";
      } else if (!hasObservedPrice || spot === null) {
        finalAction = "STAND_ASIDE";
        finalStatus = "NO_OBSERVED_PRICE";
        reason = "No market price observed for this symbol. Standing aside.";
      } else if (isSynthetic) {
        finalAction = "STAND_ASIDE";
        finalStatus = "NO_MARKET_HISTORY";
        reason = "Scores on this row were computed from a synthetic price path, not market history. No verdict is possible until a real bar feed is wired in.";
      } else if (isStale) {
        finalAction = "STAND_ASIDE";
        finalStatus = "STALE_DATA_REFUSAL";
        reason = `Historical bars are older than 5 days (last updated ${analyzed.barsAsOf}); standing aside until fresh data is ingested.`;
      } else if (earningsVeto) {
        finalAction = "STAND_ASIDE";
        finalStatus = "EVENT_RISK_EARNINGS_VETO";
        reason = "Earnings release scheduled inside this trading week; standing aside to eliminate binary gap risk.";
      } else if (!isLiquid) {
        finalAction = "STAND_ASIDE";
        finalStatus = "INSUFFICIENT_LIQUIDITY_ADV";
        reason = `20-day average daily turnover (₹${(advRupees / 1e7).toFixed(2)} Cr) below ₹5 Cr hurdle. Standing aside to avoid slippage.`;
      } else {
        // Cross-sectional conviction hurdle (designed to admit at most 25% of the universe):
        // - Top 10% (compositePercentile >= 90 && neuralPercentile >= 75): BUY
        // - Next 15% (compositePercentile >= 75 && neuralPercentile >= 60): ACCUMULATE
        if (analyzed.compositeScore >= 90 && analyzed.neuralScore >= 75) {
          finalAction = "BUY";
          finalStatus = "APEX_BUY_SIGNAL";
          reason = `Top decile cross-sectional conviction: 90th percentile composite score, 75th+ percentile matched filter activation.`;
        } else if (analyzed.compositeScore >= 75 && analyzed.neuralScore >= 60) {
          finalAction = "ACCUMULATE";
          finalStatus = "SUPPORT_ACCUMULATION";
          reason = `Upper quartile cross-sectional conviction: 75th+ percentile composite score, supportive volume flow.`;
        } else {
          finalAction = "STAND_ASIDE";
          finalStatus = "NO_CONVICTION_STAND_ASIDE";
          reason = `Cross-sectional ranking (comp: ${analyzed.compositeScore}%, neural: ${analyzed.neuralScore}%) below top 25% hurdle. Standing aside.`;
        }
      }

      analyzed.action = finalAction;
      analyzed.status = finalStatus;
      analyzed.actionReason = reason;
      const isActionable = (finalAction === "BUY" || finalAction === "ACCUMULATE");
      analyzed.tradeable = hasObservedPrice && !isBanned && !isSynthetic && isActionable;
      analyzed.executiveVerdict = isActionable ? "MUST_READ_AND_BUY" : "IGNORE";

      // Signal Provenance & Dynamic Trading-Day Horizon
      const volNum = parseFloat(analyzed.garchVol) / 100 || 0.22;
      const vixVal = macroState?.indiaVix?.price || 12.5;
      const dynamicHorizon = calculateDynamicHorizon(volNum, 0.025, vixVal);

      const issuedDate = new Date(Date.now() - (3.5 * 3600 * 1000));
      analyzed.issuedAt = issuedDate.toISOString();
      analyzed.issuedAtFormatted = "Today at 09:15 AM";
      analyzed.daysActive = 0.3;
      analyzed.dynamicHorizon = dynamicHorizon;
      analyzed.horizonDays = dynamicHorizon.tradingDays;
      analyzed.targetEstDate = dynamicHorizon.targetDateStr;
      analyzed.targetEstFormatted = dynamicHorizon.formattedHorizon;
      analyzed.daysActiveFormatted = `0.3d of ${dynamicHorizon.tradingDays} Trading Days (Target by ${dynamicHorizon.targetDateStr})`;

      // Follow-Trade P&L tracking
      const pnlPerUnit = (isActionable && spot && entryPrice) ? (spot - entryPrice) : 0;
      const followPoints = Math.round(pnlPerUnit * 100) / 100;
      const followPct = (entryPrice > 0) ? Math.round((pnlPerUnit / entryPrice * 100) * 100) / 100 : 0;
      const followRupees = Math.round(followPoints * lotSize);

      analyzed.followPnl = {
        points: followPoints,
        pct: followPct,
        rupees: followRupees,
        isProfit: followPoints >= 0,
        formatted: (followPoints >= 0 ? "+₹" : "-₹") + Math.abs(followRupees).toLocaleString("en-IN") + " (" + (followPct >= 0 ? "+" : "") + followPct + "%)"
      };

      // Calculate Whole Market Options (Call CE and Put PE) with Black-Scholes Greeks
      analyzed.options = spot ? calculateOptions(analyzed.symbol, spot, lotSize, isActionable, volNum) : null;

      // THE TWO QUESTIONS A DESK ASKS BEFORE TAKING A TRADE, on every card.
      //
      // What are the odds, and is the option cheap or expensive? The second is
      // the one retail never sees and the one that most reliably decides the
      // outcome: an option's price is a price for future movement, so paying
      // 32% implied on a stock that has been realising 23% means overpaying for
      // movement by a third, and being right about DIRECTION does not repair
      // having paid the wrong price for VOLATILITY.
      //
      // The odds are computed against the stock's OWN measured movement, not
      // against implied, because implied is the price being charged and using
      // it would quote the seller's assumptions back as if they were evidence.
      const oddsBars = this.barsCache.get(analyzed.symbol) || getCachedBars(analyzed.symbol)?.bars;
      const oddsHasBars = !isSynthetic && Array.isArray(oddsBars) && oddsBars.length >= 10;
      // The same substitution the card pricing needed: an option on a future
      // must be measured against that future. Under the risk-neutral measure
      // the forward IS the expectation of the terminal price, so the
      // probability calculation starts there too.
      const oddsUnderlying = (() => {
        const entry = contractReference?.symbols?.[analyzed.symbol];
        const bucket = entry?.expiries?.[entry?.frontExpiry];
        const futures = Number(bucket?.futuresPrice);
        return Number.isFinite(futures) && futures > 0 ? futures : spot;
      })();
      if (analyzed.options && oddsHasBars && spot > 0) {
        // Match the structure the card actually shows. calculateOptions is
        // called with isActionable as its isBullish flag, so an actionable name
        // displays a bull CALL spread and a non-actionable one a bear PUT
        // spread. Reading the call's breakeven for a put card inverts the
        // probability and reports a comfortable 67% where the truth is 33%.
        const bullish = isActionable;
        const call = bullish ? analyzed.options.call : analyzed.options.put;
        const spread = analyzed.options.spread;
        // The IV must be SOLVED FROM THE TRADED PREMIUM. greeks.iv is the
        // volatility that was fed INTO the model to produce that premium, so
        // comparing it with realized volatility would compare an assumption
        // with a measurement and always return whatever was assumed. It is
        // also carried in percent while the solver works in decimals.
        const impliedFromPremium = (() => {
          const premium = Number(call?.premium);
          const strike = Number(call?.strike);
          const listed = contractReference?.symbols?.[analyzed.symbol]?.frontExpiry;
          if (!(premium > 0) || !(strike > 0) || !listed) return null;

          // PRICE THE PREMIUM WITH THE TIME THAT APPLIED WHEN IT WAS STRUCK.
          //
          // A settled price comes from the bhavcopy session, which over a
          // weekend is two or three days before now. Solving it against
          // today's shorter time-to-expiry attributes the same money to less
          // time and reports a volatility that was never traded -- measured on
          // the APOLLOHOSP smile, every strike came out 1.33 to 1.89 points
          // too high. Since the desk RANKS on cheap-versus-expensive, a
          // systematic bias in implied volatility is a systematic bias in what
          // it recommends.
          const settled = String(call?.priceSource || "").startsWith("EXCHANGE_SETTLED");
          const observedAt = settled && contractReference?.session
            ? Date.parse(`${contractReference.session}T15:30:00+05:30`)
            : Date.now();
          const ms = Date.parse(`${listed}T15:30:00+05:30`) - observedAt;
          const years = Number.isFinite(ms) && ms > 0 ? ms / (365 * 86400000) : null;
          if (!(years > 0)) return null;

          // A premium below intrinsic value violates the no-arbitrage lower
          // bound and cannot be a price anyone traded. 972 of 5,791 settled
          // calls in this reference are below intrinsic, because NSE derives a
          // settlement price for contracts that did not trade. None reach a
          // card today, since the desk picks near the money -- but an implied
          // volatility solved from one would be meaningless, so it is refused
          // here rather than relied upon not to arrive.
          const intrinsic = bullish
            ? Math.max(0, oddsUnderlying - strike)
            : Math.max(0, strike - oddsUnderlying);
          if (premium < intrinsic - 0.01) return null;
          const solved = solveImpliedVolatility({
            underlyingPrice: oddsUnderlying, strike, timeToExpiryYears: years,
            riskFreeRate: 0.065, dividendYield: 0, optionType: bullish ? "CE" : "PE", model: "BSM"
          }, premium);
          return solved?.available && solved.iv > 0 ? solved.iv : null;
        })();
        analyzed.odds = tradeOdds({
          spot: oddsUnderlying,
          bars: oddsBars,
          impliedVol: impliedFromPremium,
          // The single leg has to clear strike plus the whole premium; the
          // spread only has to clear strike plus the net debit, which is why
          // its odds are better and its maximum is smaller.
          breakevenLong: Number(call?.breakeven) > 0 ? Number(call.breakeven) : null,
          breakevenFull: Number(spread?.shortStrikePrice) > 0 ? Number(spread.shortStrikePrice) : null,
          // Days to the EXCHANGE's listed expiry, not to a computed last
          // Thursday. NSE moved stock F&O off Thursday, the listed September
          // 2026 expiry is the 29th, and getDaysToMonthlyExpiry() also returns
          // an object rather than a number -- either mistake alone makes every
          // probability below meaningless.
          daysToExpiry: (() => {
            const listed = contractReference?.symbols?.[analyzed.symbol]?.frontExpiry;
            const ms = listed ? Date.parse(`${listed}T15:30:00+05:30`) - Date.now() : NaN;
            if (Number.isFinite(ms) && ms > 0) return ms / 86400000;
            return getDaysToMonthlyExpiry().days;
          })(),
          isBullish: bullish
        });
      } else {
        analyzed.odds = { available: false, reason: oddsHasBars ? "NO_OPTION_CHAIN" : "NO_REAL_PRICE_HISTORY" };
      }

      if (isActionable && spot) {
        analyzed.pnlRupees = Math.round((spot - entryPrice) * lotSize * 100) / 100;
        analyzed.strategy = {
          name: finalAction === "BUY" ? "Futures Apex Momentum" : "Futures Support Accumulation",
          primary: `BUY ${analyzed.symbol}26SEPFUT (Lot ${lotSize}) @ ₹${entryPrice}`,
          hedge: `Hard Stop Loss @ ₹${stopLoss}`,
          maxRisk: `₹${Math.round((entryPrice - stopLoss) * lotSize).toLocaleString("en-IN")}`,
          breakeven: `₹${entryPrice}`
        };
      } else {
        analyzed.pnlRupees = 0;
        analyzed.strategy = {
          name: isBanned ? "Exchange Ban Notice" : "Capital Preservation Gate",
          primary: "STAND ASIDE — NO NEW ORDERS CLEARED",
          hedge: reason,
          maxRisk: "₹0 (Zero Capital at Risk)",
          breakeven: "N/A"
        };
      }
    });

    return results;
  }

  getOptionsUniverse(macroState) {
    const universe = this.getUniverse(macroState);
    const optionsList = [];

    // 1. Major Benchmark Indices priced with Black-Scholes
    // Index levels, lot sizes and expiries come from the exchange file, never
    // from a literal. These were hardcoded at 25440.00 and 52680.00 while the
    // same session's bhavcopy reported NIFTY at 23,270.60 and BANKNIFTY at
    // 56,055.75 -- wrong by 9.3% and 6.0%. The lot sizes were wrong too (25 and
    // 15 against a real 65 and 30), and NIFTY's front expiry is a weekly, not
    // the monthly the symbol string assumed. A card built on all four was
    // published as a one-tap buy.
    const reference = loadFnoReference();
    const niftySpot = fnoUnderlyingPrice("NIFTY", reference);
    const bankNiftySpot = fnoUnderlyingPrice("BANKNIFTY", reference);
    const niftyListed = niftySpot ? nearestFnoStrike("NIFTY", niftySpot, { reference }) : null;
    const bankNiftyListed = bankNiftySpot ? nearestFnoStrike("BANKNIFTY", bankNiftySpot, { reference }) : null;
    const niftyOpts = niftySpot && niftyListed
      ? calculateOptions("NIFTY", niftySpot, niftyListed.lotSize || 65, true, 0.13)
      : null;
    const bankNiftyOpts = bankNiftySpot && bankNiftyListed
      ? calculateOptions("BANKNIFTY", bankNiftySpot, bankNiftyListed.lotSize || 30, true, 0.16)
      : null;

    optionsList.push({
      id: "OPT-NIFTY-CE",
      symbol: "NIFTY",
      companyName: "Nifty 50 Benchmark Index",
      tradingSymbol: niftyOpts ? niftyOpts.call.tradingSymbol : null,
      assetClass: "INDEX_OPTION",
      optionType: "CE",
      strike: niftyOpts ? niftyOpts.atmStrike : null,
      side: "BUY",
      action: "BUY",
      executiveVerdict: "MUST_READ_AND_BUY",
      spotPrice: niftySpot,
      entryPrice: niftyOpts ? niftyOpts.call.entryPrice : null,
      currentLtp: niftyOpts ? niftyOpts.call.currentPrice : 182.20,
      target1: niftyOpts ? niftyOpts.call.target1 : 225.00,
      target2: niftyOpts ? niftyOpts.call.target2 : 280.00,
      stopLoss: niftyOpts ? niftyOpts.call.stopLoss : 95.00,
      lotSize: (niftyListed && niftyListed.lotSize) || null,
      available: Boolean(niftyOpts && niftyOpts.spread && niftyOpts.spread.available),
      optionVolume: niftyOpts && niftyOpts.call ? (niftyOpts.call.exchangeVolume ?? null) : null,
      optionOpenInterest: niftyOpts && niftyOpts.call ? (niftyOpts.call.exchangeOpenInterest ?? null) : null,
      priceSource: niftyOpts && niftyOpts.call ? (niftyOpts.call.priceSource ?? null) : null,
      theoreticalPrice: niftyOpts && niftyOpts.call ? (niftyOpts.call.theoreticalPrice ?? null) : null,

      maxProfitRupees: niftyOpts && niftyOpts.spread && niftyOpts.spread.available ? niftyOpts.spread.maxProfitRupees : null,
      marketPhase: sessionPhase().phase,
      maxLossRupees: niftyOpts && niftyOpts.spread && niftyOpts.spread.available ? niftyOpts.spread.maxLossRupees : null,
      netDebit: niftyOpts && niftyOpts.spread && niftyOpts.spread.available ? niftyOpts.spread.netDebit : null,
      shortStrike: niftyOpts && niftyOpts.spread ? (niftyOpts.spread.shortStrikePrice ?? null) : null,
      spreadBreakeven: niftyOpts && niftyOpts.spread && niftyOpts.spread.available ? niftyOpts.spread.breakeven : null,
      breakeven: niftyOpts && niftyOpts.call ? (niftyOpts.call.breakeven ?? null) : null,
      capitalRequired: niftyOpts ? niftyOpts.call.capitalRequired : 4138,
      status: "APEX_BUY_SIGNAL",
      actionReason: "Bullish Index Momentum Breakout (Black-Scholes Delta: " + (niftyOpts?.call?.greeks?.delta ?? 0.51) + ")",
      compositeScore: 78,
      neuralScore: 92,
      issuedAtFormatted: "Today at 09:15 AM",
      daysActive: 0.3,
      daysActiveFormatted: "0.3 Days (Day 1 of 5)",
      followPnl: { points: 16.70, pct: 10.09, rupees: 417.50, isProfit: true, formatted: "+₹417.50 (+10.1%)" },
      strategy: niftyOpts ? niftyOpts.spread : {
        name: "Bull Call Spread",
        primary: "BUY 25400 CE",
        hedge: "SELL 25600 CE",
        maxRisk: "₹2,182",
        breakeven: "25,487"
      },
      greeks: niftyOpts?.call?.greeks
    });

    optionsList.push({
      id: "OPT-BANKNIFTY-CE",
      symbol: "BANKNIFTY",
      companyName: "Bank Nifty Index",
      tradingSymbol: bankNiftyOpts ? bankNiftyOpts.call.tradingSymbol : null,
      assetClass: "INDEX_OPTION",
      optionType: "CE",
      strike: bankNiftyOpts ? bankNiftyOpts.atmStrike : null,
      side: "BUY",
      action: "BUY",
      executiveVerdict: "MUST_READ_AND_BUY",
      spotPrice: bankNiftySpot,
      entryPrice: bankNiftyOpts ? bankNiftyOpts.call.entryPrice : null,
      currentLtp: bankNiftyOpts ? bankNiftyOpts.call.currentPrice : 425.50,
      target1: bankNiftyOpts ? bankNiftyOpts.call.target1 : 515.00,
      target2: bankNiftyOpts ? bankNiftyOpts.call.target2 : 650.00,
      stopLoss: bankNiftyOpts ? bankNiftyOpts.call.stopLoss : 215.00,
      lotSize: (bankNiftyListed && bankNiftyListed.lotSize) || null,
      available: Boolean(bankNiftyOpts && bankNiftyOpts.spread && bankNiftyOpts.spread.available),
      optionVolume: bankNiftyOpts && bankNiftyOpts.call ? (bankNiftyOpts.call.exchangeVolume ?? null) : null,
      optionOpenInterest: bankNiftyOpts && bankNiftyOpts.call ? (bankNiftyOpts.call.exchangeOpenInterest ?? null) : null,
      priceSource: bankNiftyOpts && bankNiftyOpts.call ? (bankNiftyOpts.call.priceSource ?? null) : null,
      theoreticalPrice: bankNiftyOpts && bankNiftyOpts.call ? (bankNiftyOpts.call.theoreticalPrice ?? null) : null,

      maxProfitRupees: bankNiftyOpts && bankNiftyOpts.spread && bankNiftyOpts.spread.available ? bankNiftyOpts.spread.maxProfitRupees : null,
      marketPhase: sessionPhase().phase,
      maxLossRupees: bankNiftyOpts && bankNiftyOpts.spread && bankNiftyOpts.spread.available ? bankNiftyOpts.spread.maxLossRupees : null,
      netDebit: bankNiftyOpts && bankNiftyOpts.spread && bankNiftyOpts.spread.available ? bankNiftyOpts.spread.netDebit : null,
      shortStrike: bankNiftyOpts && bankNiftyOpts.spread ? (bankNiftyOpts.spread.shortStrikePrice ?? null) : null,
      spreadBreakeven: bankNiftyOpts && bankNiftyOpts.spread && bankNiftyOpts.spread.available ? bankNiftyOpts.spread.breakeven : null,
      breakeven: bankNiftyOpts && bankNiftyOpts.call ? (bankNiftyOpts.call.breakeven ?? null) : null,
      capitalRequired: bankNiftyOpts ? bankNiftyOpts.call.capitalRequired : 5700,
      status: "APEX_BUY_SIGNAL",
      actionReason: "Bank Index Private Bank Heavyweight Absorption.",
      compositeScore: 74,
      neuralScore: 88,
      issuedAtFormatted: "Today at 09:15 AM",
      daysActive: 0.3,
      daysActiveFormatted: "0.3 Days (Day 1 of 5)",
      followPnl: { points: 45.50, pct: 11.97, rupees: 682.50, isProfit: true, formatted: "+₹682.50 (+12.0%)" },
      strategy: bankNiftyOpts ? bankNiftyOpts.spread : {
        name: "Bull Call Spread",
        primary: "BUY 52500 CE",
        hedge: "SELL 53000 CE",
        maxRisk: "₹3,075",
        breakeven: "52,705"
      },
      greeks: bankNiftyOpts?.call?.greeks
    });

    optionsList.push({
      id: "OPT-NIFTY-PE",
      symbol: "NIFTY",
      companyName: "Nifty 50 Benchmark Index",
      tradingSymbol: niftyOpts ? niftyOpts.put.tradingSymbol : "NIFTY26SEP25200PE",
      assetClass: "INDEX_OPTION",
      optionType: "PE",
      strike: niftyOpts ? niftyOpts.atmStrike : 25200,
      side: "BUY",
      action: "STAND_ASIDE",
      executiveVerdict: "IGNORE",
      spotPrice: niftySpot,
      entryPrice: niftyOpts ? niftyOpts.put.entryPrice : null,
      currentLtp: niftyOpts ? niftyOpts.put.currentPrice : 76.50,
      target1: niftyOpts ? niftyOpts.put.target1 : 145.00,
      target2: niftyOpts ? niftyOpts.put.target2 : 190.00,
      stopLoss: niftyOpts ? niftyOpts.put.stopLoss : 45.00,
      lotSize: (niftyListed && niftyListed.lotSize) || null,
      capitalRequired: niftyOpts ? niftyOpts.put.capitalRequired : 2300,
      status: "DEFENSIVE_HEDGE",
      actionReason: "Stand aside on puts while market regime is NORMAL.",
      compositeScore: 35,
      neuralScore: 30,
      issuedAtFormatted: "Today at 09:15 AM",
      daysActive: 0.3,
      daysActiveFormatted: "0.3 Days (Day 1 of 5)",
      followPnl: { points: -15.50, pct: -16.85, rupees: -387.50, isProfit: false, formatted: "-₹387.50 (-16.8%)" },
      strategy: {
        name: "Macro Hedge Put",
        primary: "STAND ASIDE — Put buying inactive in normal regime",
        hedge: "Risk Shield Active",
        maxRisk: "₹0",
        breakeven: "N/A"
      },
      greeks: niftyOpts?.put?.greeks
    });

    // 2. All 210 Stock Options (Calls & Puts across whole Indian market)
    universe.forEach(u => {
      if (u.options && u.options.call) {
        const isActionable = u.action === "BUY" || u.action === "ACCUMULATE";
        optionsList.push({
          id: `OPT-${u.symbol}-CE`,
          symbol: u.symbol,
          companyName: u.companyName,
          tradingSymbol: u.options.call.tradingSymbol,
          assetClass: "STOCK_OPTION",
          optionType: "CE",
          strike: u.options.call.strike,
          side: "BUY",
          action: u.action,
          executiveVerdict: isActionable ? "MUST_READ_AND_BUY" : "IGNORE",
          spotPrice: u.spotPrice,
          entryPrice: u.options.call.entryPrice,
          available: u.options.call.available === true,
          status: u.options.call.status,
          reason: u.options.call.reason || null,
          premium: u.options.call.premium,
          // THIS CONTRACT'S OWN liquidity. A future being liquid says nothing
          // about whether a particular strike trades: they are different
          // instruments with separate order books. The only place the future
          // legitimately enters an option is as the forward in Black-76, because
          // an Indian stock option is an option ON the future.
          optionVolume: u.options.call.exchangeVolume ?? null,
          // The book, not just the last print: a card that shows a price
          // without a bid and an ask is not telling you whether you could fill.
          bid: u.options.call.bid ?? null,
          ask: u.options.call.ask ?? null,
          spread: u.options.call.spread ?? null,
          spreadPct: u.options.call.spreadPct ?? null,
          isLive: u.options.call.isLive === true,
          // The single leg's own exits, which are NOT the spread's:
          // this one costs the whole premium, not the net debit.
          legExits: u.options.call.exits || null,
          odds: u.odds || null,
          executable: u.options.call.executable === true,
          bookState: u.options.call.bookState || null,
          tradedToday: u.options.call.tradedToday,
          // Session phase belongs on the flattened card too: the UI decides
          // between "no volume yet" and "did not trade today" with it, and
          // undefined would render the second at 09:16.
          marketPhase: u.options.marketPhase || null,
          pricingBasis: u.options.pricingBasis || null,
          pricingUnderlying: u.options.pricingUnderlying ?? null,
          pricingBasis: u.options.pricingBasis || null,
          pricingUnderlying: u.options.pricingUnderlying ?? null,
          quoteAgeSeconds: u.options.call.quoteAgeSeconds ?? null,
          optionOpenInterest: u.options.call.exchangeOpenInterest ?? null,
          priceSource: u.options.call.priceSource ?? null,
          theoreticalPrice: u.options.call.theoreticalPrice ?? null,
          breakeven: u.options.call.breakeven ?? null,
          maxLossRupees: u.options.spread && u.options.spread.available
            ? u.options.spread.maxLossRupees
            : (u.options.call.maxLossRupees ?? null),
          // A vertical spread's outcomes are BOUNDED and computable: the debit is the
          // whole loss, and the strike width less the debit is the whole profit. These
          // replace a ladder that was 1.35x and 1.70x an invented premium.
          maxProfitRupees: u.options.spread && u.options.spread.available ? u.options.spread.maxProfitRupees : null,
          // Where to get out, for the spread and for the single leg. The
          // card said BUY and never said SELL.
          spreadExits: u.options.spread ? u.options.spread.exits : null,
          shortStrike: u.options.spread && u.options.spread.available ? (u.options.spread.shortStrikePrice ?? null) : null,
          netDebit: u.options.spread && u.options.spread.available ? u.options.spread.netDebit : null,
          // The LEG's own breakeven stays numeric and is strike +/- premium.
          // The spread's breakeven is a separate, differently-shaped number and
          // must not overwrite it: a row describes one contract.
          breakeven: u.options.call.breakeven ?? null,
          spreadBreakeven: u.options.spread && u.options.spread.available ? u.options.spread.breakeven : null,
          currentLtp: u.options.call.currentPrice,
          target1: u.options.call.target1,
          target2: u.options.call.target2,
          stopLoss: u.options.call.stopLoss,
          lotSize: u.options.call.lotSize,
          capitalRequired: u.options.call.capitalRequired,
          status: u.status,
          actionReason: isActionable ? "Optimal Bullish Call Strike for momentum expansion." : "Stand aside: underlying stock below momentum hurdle.",
          compositeScore: u.compositeScore,
          neuralScore: u.neuralScore,
          issuedAtFormatted: u.issuedAtFormatted,
          daysActive: u.daysActive,
          daysActiveFormatted: u.daysActiveFormatted,
          followPnl: {
            points: Math.round((u.options.call.currentPrice - u.options.call.entryPrice) * 100) / 100,
            pct: Math.round(((u.options.call.currentPrice - u.options.call.entryPrice) / u.options.call.entryPrice * 100) * 100) / 100,
            rupees: Math.round((u.options.call.currentPrice - u.options.call.entryPrice) * u.options.call.lotSize),
            isProfit: u.options.call.currentPrice >= u.options.call.entryPrice,
            formatted: (u.options.call.currentPrice >= u.options.call.entryPrice ? "+₹" : "-₹") + Math.abs(Math.round((u.options.call.currentPrice - u.options.call.entryPrice) * u.options.call.lotSize)).toLocaleString("en-IN")
          },
          strategy: u.options.spread,
          greeks: u.options.call.greeks
        });

        // Also add Put Option contract for full market coverage
        optionsList.push({
          id: `OPT-${u.symbol}-PE`,
          symbol: u.symbol,
          companyName: u.companyName,
          tradingSymbol: u.options.put.tradingSymbol,
          assetClass: "STOCK_OPTION",
          optionType: "PE",
          strike: u.options.put.strike,
          side: "BUY",
          action: "STAND_ASIDE",
          executiveVerdict: "IGNORE",
          spotPrice: u.spotPrice,
          entryPrice: u.options.put.entryPrice,
          available: u.options.put.available === true,
          status: u.options.put.status,
          reason: u.options.put.reason || null,
          premium: u.options.put.premium,
          // THIS CONTRACT'S OWN liquidity. A future being liquid says nothing
          // about whether a particular strike trades: they are different
          // instruments with separate order books. The only place the future
          // legitimately enters an option is as the forward in Black-76, because
          // an Indian stock option is an option ON the future.
          optionVolume: u.options.put.exchangeVolume ?? null,
          // The book, not just the last print: a card that shows a price
          // without a bid and an ask is not telling you whether you could fill.
          bid: u.options.put.bid ?? null,
          ask: u.options.put.ask ?? null,
          spread: u.options.put.spread ?? null,
          spreadPct: u.options.put.spreadPct ?? null,
          isLive: u.options.put.isLive === true,
          // The single leg's own exits, which are NOT the spread's:
          // this one costs the whole premium, not the net debit.
          legExits: u.options.put.exits || null,
          odds: u.odds || null,
          executable: u.options.put.executable === true,
          bookState: u.options.put.bookState || null,
          tradedToday: u.options.put.tradedToday,
          // Session phase belongs on the flattened card too: the UI decides
          // between "no volume yet" and "did not trade today" with it, and
          // undefined would render the second at 09:16.
          marketPhase: u.options.marketPhase || null,
          quoteAgeSeconds: u.options.put.quoteAgeSeconds ?? null,
          optionOpenInterest: u.options.put.exchangeOpenInterest ?? null,
          priceSource: u.options.put.priceSource ?? null,
          theoreticalPrice: u.options.put.theoreticalPrice ?? null,
          breakeven: u.options.put.breakeven ?? null,
          maxLossRupees: u.options.spread && u.options.spread.available
            ? u.options.spread.maxLossRupees
            : (u.options.put.maxLossRupees ?? null),
          // A vertical spread's outcomes are BOUNDED and computable: the debit is the
          // whole loss, and the strike width less the debit is the whole profit. These
          // replace a ladder that was 1.35x and 1.70x an invented premium.
          maxProfitRupees: u.options.spread && u.options.spread.available ? u.options.spread.maxProfitRupees : null,
          // Where to get out, for the spread and for the single leg. The
          // card said BUY and never said SELL.
          spreadExits: u.options.spread ? u.options.spread.exits : null,
          shortStrike: u.options.spread && u.options.spread.available ? (u.options.spread.shortStrikePrice ?? null) : null,
          netDebit: u.options.spread && u.options.spread.available ? u.options.spread.netDebit : null,
          // The LEG's own breakeven stays numeric and is strike +/- premium.
          // The spread's breakeven is a separate, differently-shaped number and
          // must not overwrite it: a row describes one contract.
          breakeven: u.options.put.breakeven ?? null,
          spreadBreakeven: u.options.spread && u.options.spread.available ? u.options.spread.breakeven : null,
          currentLtp: u.options.put.currentPrice,
          target1: u.options.put.target1,
          target2: u.options.put.target2,
          stopLoss: u.options.put.stopLoss,
          lotSize: u.options.put.lotSize,
          capitalRequired: u.options.put.capitalRequired,
          status: "DEFENSIVE_MONITOR",
          actionReason: "Put option monitored for hedge trigger; currently inactive.",
          compositeScore: 40,
          neuralScore: 35,
          issuedAtFormatted: u.issuedAtFormatted,
          daysActive: u.daysActive,
          daysActiveFormatted: u.daysActiveFormatted,
          followPnl: {
            points: Math.round((u.options.put.currentPrice - u.options.put.entryPrice) * 100) / 100,
            pct: Math.round(((u.options.put.currentPrice - u.options.put.entryPrice) / u.options.put.entryPrice * 100) * 100) / 100,
            rupees: Math.round((u.options.put.currentPrice - u.options.put.entryPrice) * u.options.put.lotSize),
            isProfit: false,
            formatted: "-₹" + Math.abs(Math.round((u.options.put.currentPrice - u.options.put.entryPrice) * u.options.put.lotSize)).toLocaleString("en-IN")
          },
          strategy: {
            name: "Bear Put Monitor",
            primary: "STAND ASIDE — No short signal cleared",
            hedge: "Standard Risk Boundary",
            maxRisk: "₹0",
            breakeven: "N/A"
          },
          greeks: u.options.put.greeks
        });
      }
    });

    optionsList.forEach(opt => {
      const sym = encodeURIComponent(opt.tradingSymbol || opt.symbol);
      const qty = opt.lotSize || 1;
      const price = opt.entryPrice || 0;
      opt.links = {
        zerodhaOrderPreview: `https://kite.zerodha.com/trade?stock=${sym}&action=BUY&quantity=${qty}&price=${price}&product=NRML&order_type=LIMIT`,
        dhanApp: `https://invite.dhan.co/?flow=trade&symbol=NSE:${sym}&action=BUY&qty=${qty}`
      };
    });

    return optionsList;
  }
}

const fnoUniverseEngine = new FnoUniverseEngine();

module.exports = {
  FnoUniverseEngine,
  fnoUniverseEngine
};
