---
name: k2-published-strategies-2026-09-27
description: "Pre-registered test of 3 published strategies (time-series momentum, low volatility, market trend filter) on the panel: ALL FAIL, mostly negative"
metadata:
  type: project
---

research/published-strategies-2026-09-27/ (untracked, never commit): prereg sha256
6f9c28df..., Bonferroni t crit ~2.43 (alpha 0.05/3, df 11). Final-window monthly
excess, net 0.20%: T1 time-series momentum (Moskowitz-Ooi-Pedersen) -0.34% t -1.14
(dev t -3.48, val t -2.74); T2 low volatility (Frazzini-Pedersen) -1.32% t -2.94;
T3 Faber 10-month trend filter -1.03% t -1.02. All FAIL. Together with 12-1
momentum ([[k2-momentum-prereg-2026-09-25]]) and apex (t 0.75): every published
signal tried on this panel has failed. Context: McLean-Pontiff 2016 (97 anomalies,
-26% OOS, -58% post-publication); Harvey-Liu-Zhu 2016 (t > 3). The user asked to
test "every strategy in the world" -- answer: short pre-registered lists only,
multiple-testing corrected. Excluded as already profiled: reversal, relative
strength, 52-week high. See [[k2-ladder-has-no-measured-edge]].
