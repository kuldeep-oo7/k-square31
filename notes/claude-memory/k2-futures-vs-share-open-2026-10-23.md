---
name: k2-futures-vs-share-open-2026-10-23
description: "Desk tests price trades at the SHARE's official open; the owner trades FUTURES -- futures open->close beats the share by ~0.085%/day, so share-priced shorts look ~0.1% better than reality"
metadata:
  node_type: memory
  type: project
  originSessionId: 5861e620-95f9-4ff4-94a8-989cf5f71ca8
  modified: 2026-10-22T18:58:42.584Z
---

Found 23 Oct 2026 (post-hoc look after the 09:15 lab; studies/open-lab-2026-10-23/POST-HOC.txt, scripts gap-futures.js and
basis-all.js on branch claude/open-lab-2026-10-23). NSE 2021 .. 2026-10-01:
- Across 276,440 stock-days, the near-month FUTURE's official open->close beat the SHARE's by +0.085% on average (+0.136%
  when the share opened at/above its previous close, -0.027% when below). NSE's futures close = settlement price in every
  file checked, so the gap is at the open (the share's open is NSE's pre-open auction price).
- Short build-up priced on futures: +0.092%/trade (t 3.81) vs +0.218% on shares; by year on futures 2021 +0.25, 2022 +0.19,
  2023 -0.05, 2024 +0.10, 2025 -0.03, 2026 +0.01 (%).
- The 09:15 lab's "share does not gap down" filter: big on shares, NO advantage on futures.
- NSE started a pre-open auction for current-month futures only on 8 Dec 2025 (NSE circular 3 Nov 2025); the gap persisted in 2026.

**Why:** every desk test (SB, LU, springy dip, rating replay, TRACK) prices at the share's open, but the owner trades futures
on GM. Share pricing flatters shorts and penalises longs by roughly 0.1% a trade.

**How to apply:** price any rule meant for GM on the near-month future (open -> settlement close, roll at expiry);
the strong-SB TRACK test does (sb-strong-forward amendment A1). Quote futures-priced numbers to the owner. See
[[k2-night-lab-2026-10-23]], [[k2-focus-rule-2026-10-14]].
