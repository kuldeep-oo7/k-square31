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
