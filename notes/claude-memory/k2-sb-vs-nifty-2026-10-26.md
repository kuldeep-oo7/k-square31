---
name: k2-sb-vs-nifty-2026-10-26
description: "26 Oct 2026 -- owner: SB 'works' only because the market falls. Live record confirms it: SB moves ~1-for-1 against NIFTY's same-day open->close; leftover -0.17% a day (t -0.45); 26 Oct lost Rs 41,098 and wiped out 3 weeks"
metadata:
  node_type: memory
  type: project
  originSessionId: 5861e620-95f9-4ff4-94a8-989cf5f71ca8
  modified: 2026-10-26T15:16:08.805Z
---

- Owner (26 Oct 2026, angry): "we are just lucky because markets are in the down direction ... do it properly".
- Mon 26 Oct, NIFTY open->close +1.02% (index; Oct future +0.92%): SB 1 of 8 won, -2.50% a trade on futures,
  -Rs 41,098 at 20 units (NSE official open/close). The record went from +Rs 35,553 (85 trades) to -Rs 5,545 (93).
- The 93 live trades (5-26 Oct, futures-priced, NSE files), split by NIFTY's same-day open->close:
  - down days (7, 32 trades): +1.50% a trade, won 75%, +Rs 15,817;
  - 22 Oct, flat (19 trades): +0.33%, +Rs 10,274;
  - up days (7, 42 trades): -0.96% a trade, won 36%, -Rs 31,636.
  - Per-day regression: b -0.99 against NIFTY, leftover -0.17% a day (t -0.45), R2 0.31. 15 days prove nothing either
    way, but nothing points to skill. NIFTY's mean open->close over the 15 days was +0.01%: SB rides each DAY's
    intraday direction (it never holds overnight), not the month's downtrend.
- History says the same: plain SB on futures never passed (2005-20 t 1.92; since 2020 t -0.14); SB after a NIFTY down day
  (~2/3 of trades) vs the market: t -0.78, then 0.20 (night lab S5). Plain SB's own excess over the market was never
  measured -- don't claim it was.
- Script (scratchpad, not committed): sb-vs-nifty.js reproduces the desk's futuresRecord exactly (93, +0.152%, -Rs 5,545).
- Same evening: springy-dip.yml (19:30 IST) failed on a GitHub HTTP 504 at `gh release upload data-paper-inputs`;
  `gh run rerun <id> --failed` fixed it. If the SB list or TRACK looks stale after 20:00 IST, check that run first.

**Why:** the owner judged the desk by SB's live wins; those were NIFTY's intraday falls.
**How to apply:** whenever SB's record is quoted, give the NIFTY up/down split with it. Don't suggest hedging SB with
NIFTY (the hedged result is about zero). The direction-neutral rule is the expiry-day straddle
([[k2-expiry-legs-2026-10-25]]: +20.3 points on up days, +15.4 on down days). Whether SB stays the focus is the
owner's call ([[k2-focus-rule-2026-10-14]]).
