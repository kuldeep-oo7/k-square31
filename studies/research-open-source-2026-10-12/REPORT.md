# Open-source models, tools and university research: what can make this desk better (12 Oct 2026)

Owner, 12 Oct: "TimesFM by Google ... open source ... someone made the Bloomberg terminal and open sourced it ...
maths, physics, statistics, machine learning ... from the top universities ... how you can implement it".

Every item below was checked on its own repository, publisher or authors' page on 12 Oct 2026. Nothing here
becomes a signal on the page until it passes a pre-registered test (CLAUDE.md rule 4). Several items are
*not* signals at all: they make the desk's numbers more correct, and need no test to be used.

## 1. Forecasting models (time-series "foundation models")

| Model | Owner | Facts (own page) | Licence | Fit for us |
|---|---|---|---|---|
| **TimesFM 2.5** | Google Research ([repo](https://github.com/google-research/timesfm); paper ICML 2024, arXiv 2310.10688) | 200M parameters, 16k context, covariates via XReg. 3.0 is the latest, but its weights are "restricted to non-commercial, non-production use" | 2.5: Apache-2.0 | test 2.5, not 3.0 |
| **Chronos-2 / Chronos-Bolt** | Amazon ([repo](https://github.com/amazon-science/chronos-forecasting)) | Chronos-2 (Oct 2025): 120M or 28M, multivariate and covariates. Bolt: 9-205M | Apache-2.0 | test |
| Moirai-2.0 | Salesforce | in the finance study below | open | optional |

**The evidence on stock returns** (opened and read: [arXiv 2606.27100](https://arxiv.org/abs/2606.27100),
Noguer i Alonso & Pereira Franklin, June 2026):
- they tested TimeGPT, TimesFM-2.5, Moirai-2.0, Chronos and Chronos-2 on five US stocks;
- "gains over the random-walk benchmark are small and sparse";
- they are "not universal engines for statistically reliable alpha generation".

**What we can still do:** one pre-registered test, the same way as every other rule.
- **What it forecasts:** TimesFM-2.5 and Chronos-2 forecast each F&O stock's next-5-day return, and NIFTY's.
- **The rule:** trade the top and bottom forecasts on the desk's geometry, scored under protocol v2.
- **The data:** 6 years from NSE (release data-nse-cm).
- **Where it runs:** on GitHub Actions or a cloud session, on the CPU; the small models (28-120M) are fine on a CPU. *Unverified:* their own pages show only GPU examples, so the run time is not yet known.
- Expect a FAIL, given the paper. It is still cheap and honest to check.

## 2. Platforms ("open-source Bloomberg terminal")

| Project | Facts (own page) | Licence | Fit |
|---|---|---|---|
| **OpenBB / Open Data Platform** ([repo](https://github.com/OpenBB-finance/OpenBB)) | integrates many data vendors into Python, Excel, REST and MCP | Apache-2.0 | low: no NSE data is stated, and our NSE feed is first-hand |
| Fincept Terminal | C++/Qt desktop terminal with many connectors | AGPL-3.0 (third-party pages; repo not opened) | low: a viewer, not a data source |
| **Qlib** (Microsoft, [repo](https://github.com/microsoft/qlib)) | research platform: Alpha158/360 factor sets, a model zoo (LightGBM, LSTM, Transformer), backtests, RD-Agent factor mining; last tagged release Dec 2022 | MIT | medium: feed it our NSE data; Alpha158 is a ready set of 158 factors to TEST |

## 3. Methods from university research, and where each fits

| Method | Source (verified) | What it does here | Kind |
|---|---|---|---|
| **Reality Check / SPA, StepM, Model Confidence Set** | `arch` library by Kevin Sheppard (Oxford) ([repo](https://github.com/bashtage/arch)) | the right test when many rules are tried on the same data (we have tried ~200) | testing standard |
| **Probability of Backtest Overfitting (PBO, CSCV)** | Bailey, Borwein, López de Prado & Zhu, *J. Computational Finance* 20(4), 2017 | estimates how likely the best backtest is just overfit; complements the Deflated Sharpe we already use | testing standard |
| **HAR-RV volatility** | Corsi, *J. Financial Econometrics* 7(2), 2009 | better volatility forecasts, so better option values, touch odds and stops; the touch odds are badly off today (problem B6) | accuracy |
| **GARCH family** | `arch` | the same, for volatility clustering | accuracy |
| **Conformal prediction / calibration** | Angelopoulos & Bates (Berkeley), *Foundations and Trends in ML* 16, 2023; MAPIE library | turn touch odds into CALIBRATED probabilities using TRACK's own outcomes (futures said 69.8%, got 12.9%) | accuracy |
| **Order-flow imbalance (OFI)** | Cont, Kukanov & Stoikov, *J. Financial Econometrics* 12(1), 2014 | price moves in short windows track best-bid/ask imbalance; we record best-5 books from 5 Oct (F24) | test, once history exists |
| **Kelly sizing (fractional)** | Kelly, Bell System Technical Journal 1956 (sources agree; volume/page not checked) | how much to stake given a MEASURED edge; with no edge it says stake nothing | sizing |

## 4. Recommended order

1. **Calibrate the touch odds** (conformal or isotonic on TRACK's outcomes) and show the calibrated
   number. This is accuracy, it fixes problem B6, and it needs no new signal.
2. **Add SPA/StepM (arch) and PBO to the testing protocol,** so a future "PASS" is believable after
   hundreds of tries.
3. **HAR-RV volatility** for option values and stops, compared on TRACK against today's measure.
4. **One pre-registered test of TimesFM-2.5 and Chronos-2** on NSE: forecasts as signals, under protocol v2.
5. **Qlib's Alpha158 factors on NSE,** as one pre-registered study (158 factors: SPA is a must).
6. **OFI on the recorded order books** once there are about 3 months of them.

---

# Part 2: the wider sweep (12 Oct 2026, late evening)

The owner: "i expect it more". Below are 25 more items across statistics, econometrics, finance,
physics and machine learning. Each was checked on its publisher, its authors' page or a repository index
(RePEc/IDEAS, NBER, SSRN, arXiv, GitHub) on 12 Oct 2026. Where only a secondary page confirmed a number,
it says so.

## 5. The fact that matters most for the owner's own money

**SEBI, "Profitability of Individual Traders in the Equity Derivatives Segment (FY25-FY26)", August 2026**
(Patankar & Rath, SEBI DEPA). The PDF was opened and read: sebi.gov.in/sebi_data/attachdocs/aug-2026/1787233506209.pdf.
- 87.7% of individual F&O traders made a net loss in FY26 (90.9% in FY25).
- Loss-makers: **87.7% in options vs 66.0% in futures.** Options caused **92%** of individuals' aggregate losses.
- Individuals' net loss in FY26 was Rs 91,685 crore, and the average loss per person was Rs 1.17 lakh.
- 99% of FPI and prop-trader profits went to "algo entities". The top 10 prop firms took ~75% of prop profits.
- 59% of index-option turnover in FY26 was on expiry day itself (0DTE), and 97% within a week of expiry.
- The earlier SEBI study (Sep 2024, FY22-FY24) found that 93% of individuals lost money, over Rs 1.8 lakh crore in all. The 2026 study restates this, and news reports agree.

What it means for the desk:
- Buying options is where Indian individuals lose most.
- This agrees with our own tests: buying straddles across results lost −5.6%/trade (t −6.7), and TRACK calls hit ~17%.
- The CALLS and PUTS tabs should keep saying so.
- No new test is needed for this: it is the regulator's own count.

## 6. Testing standard: how to know a "PASS" is real

| Item | Source (checked) | Use here |
|---|---|---|
| White's Reality Check -> **Hansen's SPA** | Hansen, *J. Business & Economic Statistics* 23, 365-380 (2005) | is the BEST of our ~220 tried rules better than nothing, once the search is counted? |
| **StepM** | Romano & Wolf, *Econometrica* 73(4), 1237-1282 (2005) | which rules, if any, survive the search (a set, not one p-value) |
| Model Confidence Set | Hansen, Lunde & Nason (Econometrica 2011), in Sheppard's `arch` | ranks volatility models (HAR vs GARCH vs today's) |
| **t > 3** | Harvey, Liu & Zhu, *Rev. Financial Studies* 29(1), 5-68 (2016) | already our bar (protocol v2) |
| **Deflated Sharpe** | Bailey & López de Prado, *J. Portfolio Management* 40(5), 94-107 (2014) | already reported in every v2 study |
| **Replication** | Hou, Xue & Zhang (RFS 2020): 64% of anomalies insignificant (NBER version); Jensen, Kelly & Pedersen, *J. Finance* 78(5), 2465-2518 (2023): most factors replicate, in 13 themes, across 93 countries | read both sides: broad factors replicate, single signals often do not |
| Purged cross-validation, triple-barrier labels | López de Prado, *Advances in Financial Machine Learning*, Wiley 2018, ch. 3 and 7 (table of contents checked; book text not opened) | the desk's buy/target/stop/20-session geometry IS a triple barrier, so any ML study must purge overlapping labels |

**Plan:** one script reads every study's per-trade results (studies/*/result.json) and reports SPA and StepM
across ALL of them. That puts one honest number on "we tried ~220 things".

## 7. Leads that fit data we already hold (each needs its own pre-registration)

| # | Lead | Primary source (checked) | Our data | Why test it |
|---|---|---|---|---|
| L1 | **Loan fee predicts returns (short high-fee stocks)** | Engelberg, Evans, Leonard, Reed & Ringgenberg, "The Loan Fee Anomaly", *Management Science* 71(7), 5529-5551 (2025): of 102 anomalies, the highest monthly long-short return (4.01%) and Sharpe (0.66) | **NSE's SLB bhavcopy carries the lending fee per contract.** Checked tonight: SLBM_BC_12102026.DAT exists, and SLBM_BC_01102021.DAT (2021) still downloads from nsearchives. nse-all now collects it nightly | atlas S2 (borrowing SURGE) was PROMISING (t 2.23); the fee is the better-sourced form of the same idea. Read NSE's file format for the column meanings before coding |
| L2 | Shorting demand predicts returns | Cohen, Diether & Malloy, *J. Finance* 62(5), 2061-2096 (2007): a rise in shorting demand is followed by −2.98% the next month | slb_openpos (atlas) + fee (L1) | the paper behind S2; it separates demand (fee up AND quantity up) from supply |
| L3 | Short-selling risk | Engelberg, Reed & Ringgenberg, *J. Finance* 73, 755-786 (2018): stocks with more short-selling risk have lower returns | fee volatility from L1 | a second cut of the same SLB data |
| L4 | **Implied minus realised volatility (stocks)** | Goyal & Saretto, *J. Financial Economics* 94(2), 310-326 (2009) | NSE F&O bhavcopy, 6 years | our cheap-vol straddle near miss (t 1.94) is this paper's long leg; the published form is long-short |
| L5 | NIFTY variance risk premium | Bollerslev, Tauchen & Zhou, *RFS* 22(11), 4463-4492 (2009). India: Sankar, Ramachandran & Lukose, *Int. Rev. Economics & Finance* 70 (2020): variance risk IS priced in India | India VIX + NIFTY | explains why our short NIFTY strangle PASSED (t 4.66): a known, priced premium that carries crash risk |
| L6 | Weekly reversal | Lehmann, *QJE* 105(1), 1-28 (1990): last week's losers bounce, and this survives spreads | CM bhavcopy | close to springy-dip and the OU dip (positive in all 3 windows, t 0.41); the published benchmark, not a new rule |
| L7 | Sector-neutral stat-arb residuals | Avellaneda & Lee, *Quantitative Finance* 10(7), 761-782 (2010): residuals as Ornstein-Uhlenbeck; Sharpe 1.44 after costs 1997-2007, only 0.9 in 2003-07 | CM bhavcopy + industries | the published form of our industry-reversal near miss (t 1.98); note its decay |
| L8 | Lottery stocks (MAX) | Bali, Cakici & Whitelaw, *J. Financial Economics* 99, 427-446 (2011): a high max daily return last month means lower returns, >1%/month spread | CM bhavcopy | a SHORT candidate list; retail-heavy India may show it more |
| L9 | Overnight vs intraday | Lou, Polk & Skouras, *J. Financial Economics* 134(1), 192-213 (2019): momentum earns overnight, reversal intraday | open/close in CM bhavcopy | tells the desk WHEN its 09:13 levels should be set; descriptive first |
| L10 | Intraday momentum | Gao, Han, Li & Zhou, *J. Financial Economics* (2018), 394-414: the first half-hour predicts the last half-hour (SPY) | NOT HELD: needs intraday bars (Angel gives 1-min, 30 days a request) | needs a recorder first; NIFTY futures only |
| L11 | Promoter pledging | Chauhan, Mishra & Spahr, *Financial Management* (2021) (secondary page; not opened): heavy pledging means more volatility and lower value | atlas pit (pledge filings) | our S5 near miss (t 1.89) fits this; it needs a registration and a fresh window |

## 8. Volatility and risk models (accuracy, not signals)

| Model | Source (checked) | Use |
|---|---|---|
| HAR-RV | Corsi, *J. Financial Econometrics* 7(2), 2009 | mixes daily, weekly and monthly volatility; better touch odds and option values |
| Realized GARCH | Hansen, Huang & Shek, *J. Applied Econometrics* 27(6), 877-906 (2012) | a joint model of returns and a realised measure (we can use the high-low range) |
| Regime switching | Hamilton, *Econometrica* 57(2), 357-384 (1989); its replication is fragile (Boldin 1996) | a testable replacement for "NIFTY close < EMA20 < SMA50", whose own test FAILED |
| Random-matrix cleaning of correlations | Laloux, Cizeau, Bouchaud & Potters, *Phys. Rev. Lett.* 83(7) (1999): most of a stock correlation matrix is noise | the bad-day risk view adds rows together; cleaned correlations make that total more honest |
| Market impact | Bouchaud, Bonart, Donier & Gould, *Trades, Quotes and Prices*, Cambridge UP 2018 (square-root law) | small for 1-lot trades; matters only if size grows |
| Variance ratio / long memory | Lo & MacKinlay, *RFS* 1, 41-66 (1988); DFA: Peng et al., *Phys. Rev. E* 49(2), 1685 (1994) | the desk's rating gives a Hurst term 25% weight with no tested value: test it or drop it |

## 9. Machine learning beyond TimesFM and Chronos

| Item | Source (checked) | Fit |
|---|---|---|
| **Kronos** (Tsinghua; AAAI 2026) | github.com/shiyu-coder/Kronos (opened). MIT licence. mini 4.1M, small 24.7M and base 102.3M parameters; large (499M) is not released. Trained on 12bn+ candles from 45 exchanges; has a fine-tuning pipeline for daily data | the only foundation model trained on candles (OHLCV). Probably small enough for a CPU (*unverified*: the page shows GPU only). Add it to the forecasting test of section 1 |
| Trees and nets on many signals | Gu, Kelly & Xiu, *RFS* 33(5), 2223-2273 (2020) | trees and nets beat linear models; the signals that matter are momentum, liquidity and volatility. Our ridge ML FAILED, so a tree test on the same panel is the published next step |
| Complexity | Kelly, Malamud & Zhou, *J. Finance* 79(1), 459-503 (2024) | argues that big models predict better; the counterweight is arXiv 2606.27100 (section 1) |
| Nixtla statsforecast | PyPI metadata: Apache-2.0; fast AutoARIMA, ETS and Theta | cheap baselines that any ML must beat |
| skfolio | github.com/skfolio/skfolio (opened): BSD-3; risk parity, CVaR, combinatorial purged CV | for when the desk holds several paper rules together |

## 10. Plan, in order

Each step ends in a pre-registration or an accuracy fix. None goes straight onto the page.

1. **S2 forward paper test on TRACK** (PROMISING, t 2.23): register it unchanged now, as with cheap-vol and INDREV.
2. **L1 loan-fee test:**
   - download the SLB bhavcopy history (2020-09 on) into a private release;
   - read NSE's file format;
   - register "short the top fee decile, 5 and 20 days" BEFORE computing anything.
3. **SPA and StepM across every study** (section 6).
4. **Touch-odds calibration** (section 4, item 1) and **HAR-RV** (section 8).
5. **One forecasting study:** TimesFM-2.5, Chronos-2 and Kronos-small on NSE, under protocol v2.
6. **Gu-Kelly-Xiu trees** on the same panel: one registration, with SPA mandatory.
7. **An intraday recorder** for NIFTY futures (L10); then OFI after ~3 months of order books.
8. **The Hamilton regime model** as a pre-registered replacement test for the failed market-direction rule.

---

# Part 3: the field-by-field sweep, and what was DONE (13 Oct 2026, night)

The owner asked for the top papers in mathematics, physics, statistics and economics. Parts 1-2 were mostly
finance and econometrics. This part goes field by field. It keeps only papers that fit data we hold, or that fix
something on the desk; the rest is marked as a reading list. Each paper was checked on its publisher, authors'
or repository page.

## Mathematics and probability

| Paper | Checked | What it does for the desk |
|---|---|---|
| Two-barrier exit of Brownian motion with drift: P(target first) = (e^{2μL} − 1)/(e^{2μL} − e^{−2μU}), which is L/(L+U) with no drift (the standard martingale result; Borodin & Salminen's handbook NOT opened) | derivation checked against two worked examples | **The desk already shows this:** TRACK's "IF RANDOM 37.5%" is 1.5/(1.5+2.5). The card's "touch odds" (69.8%) ignore the stop, so they mislead. Fix: show the two-barrier number as the main odds. No test is needed: it is arithmetic |
| Kelly, *Bell System Technical Journal* 1956 | part 1 | stake nothing without a measured edge |
| Ornstein-Uhlenbeck mean reversion (Avellaneda & Lee 2010, part 2 L7) | part 2 | the dip and reversal family |

## Physics (econophysics)

| Paper | Checked | Use |
|---|---|---|
| Gopikrishnan, Plerou, Amaral, Meyer & Stanley, *Phys. Rev. E* 60, 5305 (1999) | arXiv cond-mat/9905305 | returns have power-law tails, α ≈ 3, up to ~4 days. **Our stops assume normal moves; gaps through a stop are far likelier than normal.** The bad-day risk box already uses real history (not a normal), which is right |
| Laloux, Cizeau, Bouchaud & Potters, *PRL* 83 (1999) | part 2 | clean the correlation matrix before adding rows together |
| Bouchaud et al., *Trades, Quotes and Prices* (CUP 2018) | part 2 | impact: small at one lot |
| Peng et al., *PRE* 49 (1994) (DFA) | part 2 | test or drop the rating's Hurst term |

## Statistics

| Paper | Checked | Use |
|---|---|---|
| Politis & Romano, *JASA* 89(428), 1303-1313 (1994): stationary bootstrap | publisher record | p-values for dependent returns, needed by SPA/StepM; next to our Newey-West t |
| Benjamini & Hochberg, *JRSS B* 57(1), 289-300 (1995): false discovery rate | DOI record | report FDR beside Holm across ~230 tries |
| Hansen SPA (2005), Romano-Wolf StepM (2005), Harvey-Liu-Zhu t > 3 (2016), Deflated Sharpe (2014) | part 2 | the testing standard |
| Ledoit & Wolf, *J. Portfolio Management* 30(4), 110-119 (2004): covariance shrinkage | UPF working paper | the same use as random-matrix cleaning, simpler |

## Economics

| Paper | Checked | Use |
|---|---|---|
| **Barber & Odean, *J. Finance* 55(2), 773-806 (2000)**: the households that trade most earned 11.4% a year vs the market's 17.9% | abstract | trading often costs money: fewer, better trades |
| **Barber, Lee, Liu & Odean, *RFS* 22(2), 609-632 (2009)**: Taiwan individuals lose 3.8 points a year by trading, "virtually all" from aggressive orders | abstract | use LIMIT orders, never market orders. The desk's buy levels are limits, which is right |
| **SEBI FY25-26 study** (part 2, section 5) | PDF read | 87.7% of option traders lost money |
| Grossman & Stiglitz, *AER* 70(3), 393-408 (1980) | records | if anyone could see the edge for free, it would be gone. Expect small, costly edges, so t > 3 and costs matter |
| Engle, *Econometrica* 50(4), 987 (1982): ARCH (Nobel 2003) | ScienceOpen + Engle's page | volatility clusters; the HAR/GARCH item in part 2 |

Reading list only (no data fit or desk fix yet): Bachelier 1900; Black-Scholes-Merton 1973; Fama 1970; Shiller 1981;
Kyle 1985; Kahneman & Tversky 1979; Sornette's log-periodic crash model (contested); Mantegna & Stanley 1995.

## What was run tonight (all pre-registered: rules hashed and committed before any real-data number)

| Item | Status |
|---|---|
| **S2 borrowing surge** forward paper test | LIVE on TRACK from 13 Oct (studies/forward-v4-2026-10-12). Its code reproduces the study exactly: 2,085 trades, +0.256% |
| **Loan-fee study** (Engelberg et al. 2025, on NSE's own SLB fee file, 1,508 days) | one run, branch claude/loan-fee-2026-10-13: **0 PASS**. Short the highest-fee tenth for 5 days: +0.309% a trade over the market, t 1.90 (near miss, FAIL). 20 days: t 0.30. The long-short form: NOT TESTABLE (too few liquid F&O names on most days) |
| **TimesFM-2.5, Chronos-2, Kronos-small, their blend, boosted trees, 5-day reversal** | registered (branch claude/forecast-models-2026-10-13, sha256 b5914c71...); scored only from July 2024, because Kronos was trained on data to June 2024 including NSE. Running on the laptop |
