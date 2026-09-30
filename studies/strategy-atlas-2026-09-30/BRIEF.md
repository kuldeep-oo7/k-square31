# Strategy atlas: test every well-known trading strategy on NSE's own data

Handoff from the laptop session, Wed 30 Sep 2026, ~08:00 IST. You are a cloud session. Work
only on this branch (`claude/strategy-atlas-2026-09-30`), and only inside
`studies/strategy-atlas-2026-09-30/`. **Never push to `main`. Never edit `docs/`, `api/`,
`scripts/` or `.github/`.** The live desk rebuilds itself from `main`; nothing you do may
touch it.

## 1. Who this is for, and what they asked

The user runs the K² desk in this repo. It is a static NSE F&O page (`docs/`, mirrored to
kuldeep-oo7.github.io/k2-desk), rebuilt by `.github/workflows/desk.yml` on an outside
schedule. They read it on a phone at the office. They trade NSE futures by hand in a paper
competition among friends; that platform is **GM Global, and you must fetch, read and store
nothing from it**. They buy real calls and puts on Zerodha.

What the page does today: NIFTY has been in a downtrend since **2 Sep 2026** (NSE's own
history; 29 Sep close 22,716.2 < EMA20 23,377.78 < SMA50 23,932.93,
`api/_lib/market-direction.js`). In that state the page shows **puts only**, and the futures
and calls tabs are empty. The user is angry about the empty tabs.

Their words (verbatim, 29-30 Sep):
- "chart patterns and stock candles haven't been tested yet do it find the strategies of the
  best of the best traders all of the indicators and everything and back tested it"
- "you should not be building anything on your own ... warren buffett value ... technical
  analysis and all of the chart pattern and candle sticks every strategy advance and modern day
  data science and machine learning and all of the mathematics physics statistics are they are
  making any numbers or predictions or not then you need to show it on the screen"
- "not by making up everything on your own"
- "you need to give me only that pass from everything"
- "back test everything fail find new try it do it again and again"

So the job is to take strategies that **other people** published, with their own rules, test
them honestly on NSE's own data, and report PASS / FAIL / NOT TESTABLE for each. Nothing from
this session goes onto the live page. A PASS becomes a paper candidate for the desk's TRACK
ledger; that step happens later, on the laptop, with the user.

## 2. Hard rules

1. **No guarantees.** Never write "guarantee", "sure", "proven edge". A PASS on data that has
   been looked at before is a *paper candidate*, not a proof. (The user's own reference, the
   *Quantitative Finance Atlas*, p.10 says there is no guaranteed profit, and p.54 says new
   rules go to paper before money.)
2. **Every external fact from a primary source**, such as a strategy's rule, a data format or
   a charge. Open the original and quote it. If you can only find secondary sources, say so. If
   you can't source a rule, drop the strategy. Don't invent a version of it.
3. **Pre-register before touching real data.** Write `PREREGISTRATION.txt` with every rule,
   window, cost, family member and the PASS rule. Record its sha256 in `PREREGISTRATION.sha256`,
   then **commit and push both BEFORE computing any signal on real NSE data**. Until then, test
   code on synthetic bars only. After the run, change nothing in the registration. Any new idea
   gets its own new registration file.
4. Don't commit downloaded data (`cm/` is gitignored). Commit code, registration and results.
   Push progress often, because a cloud VM can be reclaimed.
5. Never ask for, print or store secrets.
6. Report in plain words for a phone reader: short sentences, every number with its window and
   trade count.

## 3. Already tested on this desk's panel (all pre-registered; don't re-run them as "new")

FAIL: the desk's composite rating (5-session study, final t 0.75), desk candlesticks on NIFTY
(t 0.13), the NIFTY trend reader, 12-1 momentum (paid 2022-24, reversed 2024-26), time-series
momentum, low volatility, the 10-month trend filter, US-overnight and crude-oil cues.
NOT TESTABLE (too few final trades): gap continuation, India-VIX spike.
**Never tested:** chart patterns, candlesticks on individual stocks, the classics in section 5.

## 4. Data: NSE's daily equity bhavcopy (checked from the laptop on 30 Sep 2026)

- The old format runs up to **2024-07-05**:
  `https://nsearchives.nseindia.com/content/historical/EQUITIES/{YYYY}/{MON}/cm{DD}{MON}{YYYY}bhav.csv.zip`
  (MON = JAN..DEC). Columns: SYMBOL, SERIES, OPEN, HIGH, LOW, CLOSE, LAST, PREVCLOSE,
  TOTTRDQTY, TOTTRDVAL, TIMESTAMP, TOTALTRADES, ISIN.
- The new UDiFF format starts on **2024-07-08**:
  `https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_{YYYYMMDD}_F_0000.csv.zip`
  Columns: TradDt, BizDt, Sgmt, Src, FinInstrmTp, FinInstrmId, ISIN, TckrSymb, SctySrs, ...,
  OpnPric, HghPric, LwPric, ClsPric, LastPric, PrvsClsgPric, ..., TtlTradgVol, TtlTrfVal, ...
  Both formats exist for 1-5 Jul 2024. The old format is 404 from 8 Jul 2024.
- `fetch-cm-bhavcopy.js` (in this folder) was tested on the laptop and handles both formats. It
  keeps series EQ/BE/BZ, writes `cm/YYYY-MM-DD.json` = `[isin, symbol, series, open, high, low,
  close, prevClose, volume, value]`, sleeps 1 s between files, stops after 3 failures in a row,
  and resumes where it stopped. Laptop speed was ~1.5 s per file, so 2020-09-01..2026-09-29
  (≈1,590 days) takes about 40 minutes. Run it with `K2_STOP_IST=23:59`, because its default
  stops at 07:00 IST. Sample: RELIANCE on 2026-09-29 was
  `["INE002A01018","RELIANCE","EQ",1193.8,1198.3,1181.8,1182,1197.6,24191416,28722913322.7]`.
- **First test whether this VM can reach nsearchives.nseindia.com.** NSE blocks some cloud IPs,
  and this environment's network may be limited to a trusted list. If it's blocked, don't try to
  get around it. Finish everything else (code, synthetic tests, registration, push), then stop
  and say exactly which command to run on the laptop, which already has the files in
  `research/strategy-atlas-2026-09-30/cm/` in the same format.
- The session calendar is the set of dates that have a file (a weekday 404 is a holiday).
- **Splits and bonuses:** the files are unadjusted. Check on known events whether
  `PREVCLOSE`/`PrvsClsgPric` on an ex-date is already adjusted, for example: RELIANCE bonus 1:1
  (ex 28 Oct 2024), TATASTEEL split 1:10 (ex 28 Jul 2022), IRCTC split 1:5 (ex 28 Oct 2021).
  Verify those dates against NSE rather than trusting this list. If it is adjusted, the
  factor = prevClose[t] / close[t-1]. Build indicators on the back-adjusted series. Simulate
  each trade on actual prices, and drop any trade whose holding window contains a factor ≠ 1
  (count them). Ordinary dividends are not adjusted: a share falls by its dividend and a future
  doesn't. State that limitation.
- Key stocks by ISIN, EQ series only (futures exist only for EQ names).
- **Universe (point in time):** on the first session of each month, the top 200 EQ stocks by
  median daily traded value over the previous 60 sessions, with at least 250 sessions of
  history. This stands in for the F&O list, and delisted names stay in, so there is no
  survivorship filter.

## 5. The strategies. Rules as found tonight; re-open each source and quote it in the registration

1. **Turtle System 1 and System 2.** Source: Curtis Faith, *The Original Turtle Trading Rules*,
   © 2003 OriginalTurtles.org (PDF, e.g. oxfordstrat.com/coasdfASD32/uploads/2016/01/turtle-rules.pdf).
   - "System 1 Entry - Turtles entered positions when the price exceeded by a single tick the
     high or low of the preceding 20 days."
   - "System 1 breakout entry signals would be ignored if the last breakout would have resulted
     in a winning trade ... considered a losing breakout if the price subsequent to the date of
     the breakout moved 2N against the position before a profitable 10-day exit occurred."
     (That is the p.19 filter, plus the 55-day failsafe.)
   - "System 2 Entry - Entered when the price exceeded by a single tick the high or low of the
     preceding 55 days."
   - "Turtles always traded at the breakout when it was exceeded during the day ... In the case
     of opening gaps, the Turtles would enter positions on the open if a market opened through
     the price of the breakout."
   - Stops: "Turtle stops were set at 2 N below the entry for long positions, and 2 N above the
     entry for short positions." N = (19 × PDN + TR) / 20, seeded with a 20-day average true
     range.
   - Exits: "The System 1 exit was a 10 day low for long positions and a 10 day high for short
     positions ... The System 2 exit was a 20 day low for long positions and a 20 day high for
     short positions."
2. **Connors RSI(2).** Source: StockCharts ChartSchool "RSI(2)", which does not name the book.
   The book is Connors & Alvarez, *Short Term Trading Strategies That Work* (2008); confirm it.
   - Trend filter: "Connors recommends the 200-day moving average".
   - Buy when "2-period RSI moves below 10" with price above the 200-day SMA.
   - Short when RSI(2) is above 90 with price below it.
   - Exit: "exiting long positions on a move above the 5-day SMA and short positions on a move
     below the 5-day SMA". Use the RSI thresholds 10/90 as the primary rule (5/95 was his better
     variant; report it descriptively only).
3. **52-week high.** Source: George & Hwang (2004), *The 52-Week High and Momentum Investing*,
   Journal of Finance 59(5), author PDF bauer.uh.edu/tgeorge/papers/gh4-paper.pdf. Portfolios
   are "based on the ratio of current price to the highest price achieved within the past 12
   months. All portfolios are held for 6 months." Winners are "the equally weighted portfolio of
   the 30% of stocks with the highest ... ratio", and losers the lowest 30%. Cohorts are formed
   monthly and overlap, as in Jegadeesh-Titman. The headline is about 0.45% per month on US
   stocks, 1963-2001.
4. **NR7 (Toby Crabel).** Source: StockCharts ChartSchool "Narrow Range Day NR7", citing Crabel,
   *Day Trading with Short Term Price Patterns & Opening Range Breakout* (1990). NR7 is "the
   narrowest range in seven days". Buy on a move above the NR7 day's high, and sell on a move
   below its low, on the next day. Crabel "took profits quite quickly, usually at the close of
   the first trading day or on the first profitable close."
5. **Minervini Trend Template.** Tonight's sources were secondary only (ChartMill, sharpely,
   Deepvue), so find a primary one: Minervini, *Trade Like a Stock Market Wizard* (2013), or his
   own site. All eight criteria must hold:
   - price above the 150- and 200-day MAs;
   - the 150-day MA above the 200-day;
   - the 200-day rising for at least 1 month;
   - the 50-day above the 150- and 200-day;
   - price above the 50-day;
   - price at least 30% above its 52-week low;
   - price within 25% of its 52-week high;
   - IBD RS rating at least 70. IBD's rating is proprietary: approximate it with the 12-month
     return percentile within the universe, and label it as an approximation.

   If you can't source an exit, test it in the DESK form only.
6. **The desk's own detectors, never tested per stock:**
   - `api/_lib/candlestick-engine.js` `identifyCandlestickPatterns` (bias BULLISH/BEARISH on the
     last bars);
   - `api/_lib/chart-patterns.js` `scanChartPatterns`, which uses pivots with a 4-bar window.
     **Check it for look-ahead**: a pivot needs bars after it, so the signal for day d may use
     bars ≤ d-1 only. Measure its speed on 200 stocks × 1,300 days before committing to daily
     scans.

Weinstein Stage 2 is dropped because its rules are judgement calls.

Not testable with this data, so say so in the result:
- value/Buffett (there are no point-in-time fundamentals; today's balance sheet on old prices is
  look-ahead);
- intraday methods;
- option strategies (they would need NSE's F&O bhavcopies; propose that as the next round).

## 6. Two ways to trade each signal

Each signal is computed from bars up to d-1, and entries happen on day d.

**ORIGINAL:** the author's own entry and exit on daily bars. A stop or breakout order fills at
its level, or at the open when the open gaps through it. When a stop and a target could both
fill on the same bar, the stop comes first. Hold at most one open position per stock per
strategy.

**DESK:** the desk's futures geometry (`api/_lib/session-levels.js`,
`scripts/paper-ledger.js`), exactly as registered in the laptop's gap-filter study:
- anchor = open(d); buy = anchor × 0.992 rounded DOWN to 0.05.
- The order fills on d only if low(d) < buy; otherwise it is UNFILLED (a day order, not a trade).
- target = buy × 1.025 and stop = buy × 0.985, each rounded to the nearest 0.05.
- On the fill day, low(d) ≤ stop is a STOP at the stop (the ambiguity counts against the rule),
  and a target touched on the fill day is NOT counted.
- For each later session s, up to the 20th session counting d as the first:
  - open(s) ≤ stop → exit at open(s);
  - open(s) ≥ target → exit at open(s);
  - low(s) ≤ stop → exit at the stop (the stop comes first if both are touched);
  - high(s) ≥ target → exit at the target.
  - Otherwise exit at the close of the 20th session.
- A bearish signal uses the exact mirror (sell limit 0.8% above the open, target −2.5%, stop
  +1.5%). It is a stand-in for a put, and is flagged as such.

**Costs:** `api/_lib/shadow-broker.js` `calculateNseFuturesCharges` on both legs, dated,
quantity = ceil(500000 / price). A position held past a month-end pays one extra round trip
per month-end crossed, as a futures roll (an approximation; say so). Returns are NET, in % of
entry.

## 7. Windows, statistics, PASS

- Windows by entry day, the calendar every earlier study used:
  - development: before 2024-09-19;
  - validation: 2024-09-19..2025-09-17;
  - final: 2025-09-18..2026-09-15.

  The final window has already been used by about 10 earlier tests; say so.
- Unit: one trade. Report the mean net return, the share of winners and the trade count.
  Cluster standard errors by calendar month (`api/_lib/panel.js` `clusterRobustMean`), because
  stocks on one day move together. For the 52-week-high portfolio in ORIGINAL form, the unit is
  the monthly portfolio return (the overlapping-cohort average).
- **PASS** = validation mean > 0 AND final mean > 0 AND the final one-sided p-value survives
  Holm-Bonferroni across the **whole family** at 5% family-wise. p comes from Student-t with
  (final months − 1) degrees of freedom. Fewer than 30 final trades = NOT TESTABLE.
- Proposed family, with long and short legs as separate members:
  - ORIGINAL: Turtle S1 long/short, Turtle S2 long/short, RSI(2) long/short, NR7 long/short,
    52-week-high winners long, 52-week-high losers short, Minervini long (if an exit is sourced).
  - DESK: the same entries with desk geometry, plus the desk candlestick BULLISH→long and
    BEARISH→short, and chart-pattern bullish→long and bearish→short.

  You may drop a member you can't source before registering. You may not add one after seeing
  any real-data number.
- Also report, descriptively only (no verdicts): each member split by NIFTY regime
  (`api/_lib/market-regime.js` `classifyMarketRegime`, BEAR_HOSTILE vs other), since the user
  cares most about what works while NIFTY falls. Take NIFTY 50 daily bars from NSE's own
  index archive if reachable (find and verify the file on nsearchives), or skip the split and
  say so.

## 8. Order of work

1. Read the modules named above and `api/_lib/shadow-broker.js`.
2. Source each rule (section 5).
3. Write `study.js` and test it on synthetic bars, including a planted-edge test (it must find
   a known edge) and a no-edge test (it must not).
4. Write `PREREGISTRATION.txt`, compute the sha256, then commit and push.
5. Test NSE reachability. If reachable: download, check splits, run **once**, and write
   `RESULT.txt`, `result.json` and a plain-words `READ-THIS-FIRST.txt`, then commit and push.
6. Final message in this session: one line per family member (PASS / FAIL / NOT TESTABLE),
   with the validation and final mean, t and trade count. Then say plainly what, if anything,
   is worth putting on TRACK as paper.
7. If everything fails, propose the next round. Candidates: option strategies on NSE F&O
   bhavcopies; a published machine-learning method (e.g. Gu, Kelly & Xiu 2020) in strict
   walk-forward; the desk's own Hurst/GARCH components. Each needs a new registration, and
   because no untouched history is left, anything found becomes a forward paper test only.
