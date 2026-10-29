# What the internet teaches about chart trading, and what we built from it (29 Oct 2026)

Plain notes from the reading done before the chart lab was registered. Every figure names its source.
"Unverified" means I could not reach the source that owns the fact.

## 1. What the research says

| Study | Data | Finding |
|---|---|---|
| Lo, Mamaysky and Wang, *Journal of Finance* 55(4), 2000 ([MIT copy](https://web.mit.edu/Alo/www/Papers/techanal.html)) | US stocks, 1962-1996, patterns found by computer (kernel regression) | Several patterns (head and shoulders and others) change the distribution of the next returns: they carry *some* information. The paper says that information is not the same as trading profit. |
| Marshall, Young and Rose, *Journal of Banking & Finance* 30(8), 2006 ([RePEc](https://ideas.repec.org/a/sae/sagope/v7y2017i4p2158244017736799.html), [working paper](https://c.mql5.com/forextsd/forum/211/Market%20Timing%20with%20Candlestick%20Technical%20Analysis.pdf)) | 28 candlestick signals, DJIA stocks, 1992-2002 | Candlesticks are not profitable on large US stocks. |
| Park and Irwin, *Journal of Economic Surveys* 21(4), 2007 ([RePEc](https://ideas.repec.org/a/bla/jecsur/v21y2007i4p786-826.html); counts from their 2004 version, [AgEcon](https://ageconsearch.umn.edu/record/37487/files/AgMAS04_04.pdf)) | 92 modern studies | 58 positive, 24 negative, 10 mixed. Most positive results suffer from data snooping and understated costs, and profits shrink in later years. |
| Hurst, Ooi and Pedersen, AQR / *Journal of Portfolio Management*, 2017 ([AQR](https://www.aqr.com/Insights/Research/Journal-Article/A-Century-of-Evidence-on-Trend-Following-Investing?aqrPDF=1)) | 67 futures markets, 1880-2016 | Trend following across a *diversified futures portfolio* (1-12 month trends) was positive in every decade. This is the strongest evidence for any chart method. It is multi-month and across many markets, not one pattern in one stock. |
| Hudson and Urquhart, *Annals of Operations Research*, 2019 ([Springer](https://link.springer.com/article/10.1007/s10479-019-03357-1)) | ~15,000 rules on cryptocurrencies | Rules predict in-sample. Bitcoin shows no predictability out of sample. |
| SEBI press release 37/2024, 23 Sep 2024 ([SEBI](https://www.sebi.gov.in/media-and-notifications/press-releases/sep-2024/updated-sebi-study-reveals-93-of-individual-traders-incurred-losses-in-equity-fando-between-fy22-and-fy24-aggregate-losses-exceed-1-8-lakh-crores-over-three-years_86906.html)) | Indian equity F&O, FY22-FY24 | 93% of individual traders lost money, over Rs 1.8 lakh crore in total. Secondary reports say proprietary traders and FPIs profited, mostly through algorithms. |

**This desk, 3 Oct 2026 (studies/ta-atlas-2026-10-03):** 36 textbook rules failed on NSE 2020-2026. They were MA crosses, range breakouts, Turtle 20/55, RSI, MACD, Supertrend, Bollinger, Connors RSI(2), NR7, and the desk's candle and pattern detectors. No rule passed. Those are not re-run here.

## 2. The champions, verified where possible

- **Mark Minervini:** won the US Investing Championship 2021 $1M+ stock division with +334.8%, and finished first in 1997 with 155%. Source: the contest's own release, 25 Jan 2022 ([copy](https://kyodonewsprwire.jp/index.php/release/202201256538)). The release calls it "a real money verified competition".
- **J Law:** won the 2024 US Investing Championship with +353.9%. **Tanmay Khandelwal (India):** won 2023 with +129%. Source: BusinessWire releases ([2024](https://www.businesswire.com/news/home/20250127956815/en/2024-United-States-Investing-Championship-Final-Results), [2023](https://www.businesswire.com/news/home/20240126217806/en/United-States-Investing-Championship-2023-Final-Results)). The search summaries were read; the pages refused a direct fetch.
- **David Ryan:** won the US Investing Championship 1985-1987 using William O'Neil's method. *Unverified:* the source is secondary ([turtletrader.com](https://www.turtletrader.com/trader-ryan/)).
- **Robbins World Cup Championship of Futures Trading:**
  - Andrea Unger: 2008 672%, 2009 115%, 2010 240%.
  - Michael Cook: 2007 250%, 2014 366%.
  - Larry Williams: $10,000 to $1.1 million in 1987.
  - Source: an educator's page ([ireallytrade.com](https://ireallytrade.com/halloffame)). *Unverified:* the organiser's own site refused the fetch.
- **Kristjan Kullamägi (Qullamaggie):** not a contest winner. His three setups are below. *Unverified:* the rules come from third-party summaries, not his own pages.

## 3. What the winners have in common

1. **Trade leaders in the market's direction.** Minervini's *trend template*:
   - price above the 50, 150 and 200-day averages, stacked in that order;
   - the 200-day average rising for at least a month;
   - price at least 30% above its 52-week low and within 25% of its 52-week high;
   - relative strength at or above 70.

   Some copies say 25% for the low (TradingView scripts; *unverified* against his book).
   O'Neil's "M" and Kullamägi's filter (10-day average above a rising 20-day average) keep them out of falling markets.
2. **Buy a tight base breaking out on volume.** Minervini's VCP, O'Neil's cup with handle, and Kullamägi's breakout all do this.
3. **Episodic pivot.** A big gap on news with heavy volume often keeps going (Kullamägi: gaps of about 10% or more on heavy volume).
4. **Fade excess.** Two setups:
   - Kullamägi's parabolic short: a stock up very sharply in days, short on the first crack, target the 10/20-day averages.
   - Raschke and Connors' Turtle Soup: fade a failed 20-day breakout.
5. **Buy the pullback in a strong trend.** Raschke's Holy Grail: ADX(14) above 30, first pullback to the 20-period average, enter on the turn.
6. **Candles count only at a level and with the trend.** This is Nison's teaching. Unconditional candles failed here on 3 Oct.
7. **Small losses, big winners.** Each of them cuts losers fast and lets winners run with a trailing average. Position sizing is most of their edge. A signal test cannot measure that.

## 4. Our own strategies

Seven ideas, each in both directions, makes 14 members. The full rules are in PREREGISTRATION.txt.

| ID | Long | Short | Built from |
|---|---|---|---|
| A | Leader breakout | Laggard breakdown | trend template + tight base + volume + NIFTY filter |
| B | Gap-and-hold up | Gap-and-hold down | episodic pivot, daily version |
| C | Capitulation bounce | Parabolic fade | Kullamägi parabolic short and its mirror |
| D | Holy Grail up | Holy Grail down | Raschke |
| E | Turtle Soup +1 long | Turtle Soup +1 short | Raschke and Connors |
| F | Bullish candle at the 50-day, uptrend | Bearish candle at the 50-day, downtrend | Nison's location rule |
| G | Tight inside day in an uptrend | Tight inside day in a downtrend | Crabel's IDnr4 + trend |

Every trade is priced on the near-month **future**, the instrument the owner trades. Each is judged against the market (excess return), with NSE charges. The test uses the desk's standard: discovery 2005-2020, then confirmation 2020-2026.
