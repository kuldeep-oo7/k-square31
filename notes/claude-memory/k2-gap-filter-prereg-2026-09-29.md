---
name: k2-gap-filter-prereg-2026-09-29
description: "Pre-registered test of \"no futures buys on NIFTY gap-down mornings (<= -0.50%)\" on the desk's own futures rules; sha256 recorded before running; panel rebuilt from NSE's own history"
metadata:
  node_type: memory
  type: project
  originSessionId: 5861e620-95f9-4ff4-94a8-989cf5f71ca8
  modified: 2026-09-29T02:16:33.012Z
---

User approved on 2026-09-29 (after the 28 Sep sell-off, NIFTY -1.56%): "run the test" for a one-pick / money-making rule. The desk's own ranking cannot be replayed, so the test is a timing rule on the desk's futures geometry (buy 0.992 x open rounded down, +2.5% target, -1.5% stop, 20 sessions, ledger's conservative rules, NSE futures charges by date via shadow-broker.js).

research/gap-filter-2026-09-29/PREREGISTRATION.txt (untracked, like all research/):
sha256 05b439241e0613c62b77a4681ebe593f99ea027c7174a750989cf34d6f41324c, recorded 2026-09-29T02:13:15Z BEFORE any result.
Primary H1 = every entry day except NIFTY-open <= -0.50%; PASS = validation mean > 0 AND final mean > 0 AND final t >= one-sided 5% t-critical (weeks-1 df), day-level returns clustered by ISO week. A PASS = paper tracking only.

Data: the Yahoo 97-name panel had WRONG bars (IRFC 15 Jan 2024 flat 109.55; NSE 116.70->130.10; HINDZINC 21 May 2024 +25.6% vs NSE +19.6%), so the panel was rebuilt from NSE's generateSecurityWiseHistoricalData (series=EQ, max 70 rows/request, 80-day windows) — nse-panel/. NIFTY 50 from NSE indicesHistory (70-row cap; 80-day windows; 1,258 sessions). Corporate actions (12,724 filings, 47 price actions on panel names) and 727 dividends from NSE's corporates-corporateActions API. VEDL 2022-03-09 dividend has no amount in NSE's filing -> removed as a precaution (decided before the run).

**How to apply:** if the prereg hash no longer matches, the result is void. Report the verdict plainly either way. See [[k2-momentum-prereg-2026-09-25]], [[k2-published-strategies-2026-09-27]], [[k2-find-defects-by-distribution]].
