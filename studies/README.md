# Studies: every test run on this desk (code, locked rules, results; no data)

Each folder holds:
- `PREREGISTRATION.txt` and its sha256, written before any result;
- `study.js`;
- `RESULT.txt` (and `result.json`).

The data lives on private releases. Run `bash scripts/restore-research-data.sh`, then run a study from
`research/<name>/`. The standard for judging is `audit-2026-10-04/PROTOCOL.txt` (protocol v2): the whole
sample, excess return over the market for stock trades, a monthly Newey-West t >= 3 to PASS, with Holm
and the Deflated Sharpe ratio reported. The older final-year-only verdicts were underpowered: their
FAIL means "unproven".

| Folder | What | Result |
|---|---|---|
| oos-replication-2026-10-05 | **The 8 TRACK rules on UNSEEN data**: NSE 2005-2020 + S&P 500 2005-2026 | Only short build-up holds (+0.28%/trade, every period); strangle fades; dip and cheap-vol fail per trade |
| condor-2026-10-05 | NIFTY iron condors (hedged strangle) | 0 PASS (best t 1.75); hedging removes the edge |
| rating-replay-2026-10-04 | **The desk's own rating, replayed** (236,746 stock-days) | BUY/ACC −0.03%/trade FAIL; SELL/REDUCE shorts LOSE (t −3.31) |
| audit-2026-10-04 | Protocol v2 re-score of 78 rules | NIFTY 2% strangle t 4.66 (selling) but DSR 0.39: NOT significant after deflation (review 14 Oct); labelled PASS at the time; 4 promising; desk candles LONG t −3.33 |
| options-2026-10-04 | Option buying on real prices, expiry pinning, ban list, industry | 0 PASS; straddles across results −5.6%/trade (t −6.7); near misses: cheap-vol straddle t 1.94, industry-adjusted reversal t 1.98 |
| results-vrp-2026-10-04 | Results-day drift; volatility premium | buyer's long straddle loses every period; 2% strangle closest |
| families-2026-10-04 | Delivery %, PCR, carry, pairs, calendar, short straddles | 0 PASS (old rule) |
| orderflow-2026-10-03 | OI build-up/covering/unwinding; FII positioning | 0 PASS; long unwinding and short build-up are forward tests |
| ta-atlas-2026-10-03 | 36 chart/indicator/candle rules (BLL, Turtle, TradingView, Connors, NR7, desk detectors) | 0 PASS |
| dip-ml-2026-10-04 | Dip/mean-reversion; OWN OU dip; walk-forward ridge ML | 0 PASS; OU dip became the springy-dip forward test |
| rising-stocks-2026-10-02 | Stocks rising on their own while NIFTY falls (live rule) | FAIL −0.44%/trade |
| situations / regime / gap-filter / momentum / published-strategies (Sep) | Earlier studies | all FAIL / not testable |
| springy-dip-forward, oi-flow-forward, forward-v2 (2026-10-04) | **Forward paper tests from 5 Oct 2026** (rules only) | judged on TRACK; docs/paper-rules/*.json |

Data assets (private releases):
- `data-nse-cm`: the CM bhavcopy;
- `data-research`: F&O futures with participant OI, delivery and option aggregates, stock options,
  board meetings, industries, the ban list and index history;
- `data-nse-idx`: index history for the build;
- `orderflow-rec`: order books recorded from 5 Oct 2026.
