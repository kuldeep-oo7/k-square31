---
name: k2-momentum-prereg-2026-09-25
description: "Pre-registered test of 12-1 cross-sectional momentum (futures/calls long leg, puts short leg) on the 97-name panel; sha256 recorded BEFORE running"
metadata:
  node_type: memory
  type: project
  originSessionId: 5861e620-95f9-4ff4-94a8-989cf5f71ca8
  modified: 2026-09-25T05:48:13.257Z
---

On 2026-09-25 at 11:16 IST the user asked to apply the trading map's "universal"
methods to their three instruments only (stock futures, calls, puts). The rules
were written to `research/momentum-2026-09-25/PREREGISTRATION.txt` (untracked)
BEFORE any result was computed:

sha256 8018767c949b3c313102e0fdc749694ff6fe39096f589437bb8df01618654f60

One rule only: 12-1 momentum, monthly rebalance, top/bottom 10 of the 97-name
panel, benchmark = equal-weight panel (survivorship-biased universe), 0.20% cost
per month per leg. H1 (long leg) decides futures/calls, H2 (short leg) decides
whether puts return. PASS = final-test mean > 0 AND t >= 1.6648 AND validation
mean > 0. A pass means PAPER TRACKING only (the data was profiled before), not
live suggestions.

**How to apply:** if the file's hash no longer matches, the result is void.
Results, once run, belong in the same folder. See
[[k2-ladder-has-no-measured-edge]], [[k2-find-defects-by-distribution]].

**RESULT (run 2026-09-25 11:17 IST, prereg hash verified by the script): BOTH FAIL.**
H1 long winners - equal-weight, net: development +2.25%/mo (t 2.14), validation
-1.61%/mo (t -1.92), final -1.68%/mo (t -1.53). H2 short losers: -0.57%, -0.80%,
+1.06% (t 0.97). Momentum paid on these stocks Oct 2022 - Aug 2024, then REVERSED
Sep 2024 - Aug 2026. Nothing goes to the desk or to paper tracking. One coding
error surfaced IN the first run's output (13 final-window months instead of the
registered 12: the partial month Sep 2026 had been included); the code was
corrected to the registered rule and rerun. The verdict was FAIL both times.
Output: research/momentum-2026-09-25/RESULT.txt (untracked).
