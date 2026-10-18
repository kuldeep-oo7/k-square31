# Open-source tools for the K² paper fund (checked 18 Oct 2026)

Stars, licence and last push read from the GitHub API on 18 Oct 2026. This repo is PUBLIC, so code is only ever
used as a pinned package (`studies/requirements-quant.txt`), never copied in. A tool gives speed and checks, not an edge.

## In use
| Tool | Stars | Licence | What it does here |
|---|---|---|---|
| shiyu-coder/Kronos | 40,984 | MIT | Kronos forward watch (FUTURES), forecast-models study |
| google-research/timesfm | 34,593 | Apache-2.0 | forecast-models study (FAIL) |
| amazon-science/chronos-forecasting | 6,136 | Apache-2.0 | forecast-models study (FAIL) |
| scikit-learn (trees) | - | BSD-3 | combined model (cocktail) |
| stefan-jansen/alphalens-reloaded 0.5.0 | 670 | Apache-2.0 | factor checks for the value pod: IC, quantile returns, turnover |
| ranaroussi/quantstats 0.0.86 | 7,722 | Apache-2.0 | the paper fund's report: drawdown, monthly table, Sharpe vs NIFTY |
| skfolio/skfolio 1.9.4 | 2,517 | BSD-3 | the fund's risk layer: risk parity / HRP across pods, with walk-forward validation |

## Looked at, not used (and why)
| Tool | Stars | Licence | Why not |
|---|---|---|---|
| OpenBB-finance/OpenBB | 74,391 | not stated by the API | data terminal; our data is NSE's own files |
| freqtrade/freqtrade | 55,560 | GPL-3.0 | crypto trading bot |
| microsoft/qlib | 49,474 | MIT | candidate for the quant pod later (Alpha158 features); its features overlap the cocktail model's |
| nautechsystems/nautilus_trader | 30,299 | LGPL-3.0 | automatic order execution; the owner trades by hand |
| mementum/backtrader | 23,510 | GPL-3.0 | no push since Aug 2024; GPL |
| stefan-jansen/machine-learning-for-trading | 21,446 | MIT | a book's notebooks: reference, not a library |
| AI4Finance-Foundation/FinRL | 16,733 | MIT | reinforcement learning; needs far more data than daily NSE bars |
| TA-Lib/ta-lib-python | 12,302 | BSD-2 | 36 chart/indicator rules already tested on NSE: all FAIL (TA atlas) |
| polakowo/vectorbt | 9,420 | not stated by the API (Apache-2.0 + Commons Clause) | our own backtests already exist |
| kernc/backtesting.py | 9,066 | AGPL-3.0 | AGPL |
| hudson-and-thames/mlfinlab | 4,945 | not stated by the API | no push since Oct 2023 |
| BennyThadikaran/NseIndiaApi | 160 | GPL-3.0 | NSE's own endpoints were read from NSE's page script instead |
