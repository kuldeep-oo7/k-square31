---
name: k2-ladder-has-no-measured-edge
description: "Measured 2026-09-15: the fixed-percentage weekly ladder has no out-of-sample edge at any geometry; its backtest gains track a 153% bull market"
metadata: 
  node_type: memory
  type: project
  originSessionId: 5861e620-95f9-4ff4-94a8-989cf5f71ca8
  modified: 2026-09-15T06:24:15.145Z
---

Panel study run 2026-09-15 (commit 3b4dc4b), 97 NSE large caps, 5 years, current
continuous engine: **0 of 24 stop/target geometries survive validation, and all
24 validation cells are negative.** None of six standard cross-sectional
conditioners (12-1 momentum, 5-day reversal, relative strength, distance from
52-week high, ATR%, volume ratio) keeps its sign out of sample.

Buy-and-hold control (each name compounded separately) against the Nifty 500
over the same windows: development +105.9% median vs index **+59.1%**;
validation -1.1% median vs index **-1.7%**; final test -2.5% median vs index
**-3.4%**. The later windows track the index closely; development does not,
because the universe is **survivorship-biased** — `universe()` is TODAY's Nifty
500 list applied backwards five years, so every historical statistic in this
repo (weeklyCycle, rule-study, ML labels) is optimistic by an unmeasured amount.
Validation and final test were both slightly DOWN markets, so the honest claim
is "no confirmed edge at any geometry", NOT "the market rose and it still lost".

Short side is separately and much worse: 24 of 24 geometries negative in all
three splits, development t reaching -11.12. That is measured negative
expectancy, not absence of edge.

Reproduce: `node scripts/panel-study.js --fetch` then `node scripts/panel-study.js`.
Full write-up in `PANEL_STUDY_ROUND3.txt`.

**Why:** this retracts two earlier claims of mine that were carried across an
engine change without re-derivation — the 1% stop / 3% target geometry at
cluster-robust t=3.14 (does not replicate: validation -0.15%/fill), and the
hit-rate/P&L inversion that motivated a CVaR-based rung gate (an artifact of
Friday liquidation, which the engine no longer does). The tail gate was
therefore NOT restored, and volatility-normalising the entry grid (A-4) was
dropped: fill rate rises 7.9% -> 29.5% across ATR deciles while per-fill P&L
stays flat noise, so it buys participation in a rule with zero expectancy.

**How to apply:** do not tune the ladder geometry further — that surface is
measured and dead. Do not quote any backtest number for this strategy without
the buy-and-hold control beside it. The shipped per-symbol gate is genuinely
conservative (approves 3 of 194 symbol-sides, fewer than chance), so the absence
of edge has not cost money; the open question is whether the plan should refuse
to emit at all, which is Kuldeep's decision, not mine. The remaining untested
structural idea is cross-sectional residualisation plus a beta hedge.
Related: [[k2-trading-rules]].

**No trend = no edge, by arithmetic (added 2026-09-25).** At +2.5% / -1.5% a
price with no trend is a fair game, so the target comes first at most
(buy-stop)/(target-stop) = 37.5% of the time -- exactly the break-even -- for
any volatility or hold. Measured through the ledger's own rules
(scripts/test-no-trend.js, seeded): 36.9% target-first, mean -0.046% +/- 0.024%
before charges; a +150%/yr trend gives 59.9%. Calls at +/-50% lose about their
charges with no trend. Touch odds ("expected: target 57-80%", P(TOUCH)) IGNORE
THE STOP and always run higher; since 1ef9c24 the page labels them so, and TRACK
compares hit rates with IF RANDOM, not touch odds. Never present touch odds as a
win chance. See [[k2-paper-ledger]], [[k2-momentum-prereg-2026-09-25]].

