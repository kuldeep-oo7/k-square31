---
name: k2-rating-replay-2026-10-04
description: The desk's own rating was replayed for the first time on 6 years of NSE data. It FAILS, and the SELL/REDUCE shorts reliably LOSE. The page's old "t = 0.75" citation had come from a stand-in study and is now replaced.
metadata:
  type: project
---

**Discovery, 4 Oct 2026.** The page cited "the BUY signal failed its pre-registered test (1,205 trades,
t = 0.75)". That came from scripts/apex-panel-study.js, which never ran the rating: it tested a momentum
stand-in (5-day return >1%, 20-day >2%, volume >1.1x) and counted the target first on same-bar touches.

**The real test.** research/rating-replay-2026-10-04, prereg sha256 a7bcce9d..., protocol v2.
- It calls the live analyzeCandidate (candles neutral), ranks percentiles across the day and applies the
  live arbiter, the results-week veto and the ₹5 Cr turnover hurdle.
- The balance-sheet adjustment is NOT applied: today's fundamentals would be look-ahead on history.
- Universe: top 200 by traded value. 236,746 stock-days; the replay takes 21 seconds.

**Results:**

| Member | Mean / trade | t | Trades | Note |
|---|---|---|---|---|
| G1 BUY/ACC, desk geometry (the live futures/calls rule) | −0.028% | −0.44 | 32,725 | 36.7% winners vs 37.5% break-even. FAIL |
| G3 SELL/REDUCE, desk geometry short | **−0.139%** | **−3.31** | 35,236 | Reliably negative |
| G4 SELL/REDUCE, fixed 20d short, vs market | −0.394% | — | — | Those stocks slightly OUTPERFORM the market |
| G5 BUY only, fixed 20d, vs market | −0.306% | — | — | FAIL |

**What changed on the page:** the futures and calls text and the footer now quote the replay. The puts tab
warns that its stock puts rest on SELL/REDUCE ratings, which LOST as shorts.

**How to apply:** never cite apex-panel-study.js as a test of the rating. Any new rating change must beat
this replay (rerun study.js with a new registration). See [[k2-audit-protocol-v2-2026-10-04]].
