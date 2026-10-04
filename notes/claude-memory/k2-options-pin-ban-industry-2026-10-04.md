---
name: k2-options-pin-ban-industry-2026-10-04
description: Option buying on real NSE stock-option prices, expiry pinning, the F&O ban list and industry effects were pre-registered and run 4 Oct 2026 under protocol v2. 0 PASS. Buying straddles across results LOSES −5.6%/trade (t −6.7). Two near-misses.
metadata:
  type: project
---

research/options-2026-10-04, prereg sha256 e2801c12..., protocol v2 (whole sample, monthly Newey-West t,
PASS at t ≥ 3).
- Data: NSE F&O OPTSTK (two nearest expiries, strikes ±12%; scripts/nse-stock-options-history.js),
  the ban archive fo_secban, and industries from board-meeting sm_indusrty.
- The run uses memory-safe loading, proven identical on synthetic data.

**Option returns are % of the premium paid:**

| Member | Mean / trade | t | Note |
|---|---|---|---|
| O1 buy ATM call, 3 days | −0.88% | −0.40 | FAIL |
| O2 buy ATM put, 3 days | −2.85% | −1.04 | FAIL |
| O3 buy straddle when IV < 0.8× realised, 5 days | +3.30% | 1.94 | Sharpe 1.01. NEAR MISS (just under PROMISING) |
| **O4 buy straddle across results** | **−5.62%** | **−6.70** | Reliably LOSES (the IV crush). The desk already refuses options whose results fall before the exit, and that is right |
| P1 sell the max-OI straddle into expiry | — | — | FAIL |
| P2 futures toward the max-OI strike on expiry day | −0.128% | −3.88 | Prices move AWAY from the max-OI strike |
| N1/N2 leaving the ban | — | — | FAIL |
| I1 industry momentum | — | — | FAIL |
| I2 industry-adjusted 5-day reversal, long-short | +0.150% | 1.98 | Sharpe 0.87. NEAR MISS |

**Synthetic checks caught two flaws in my own fake market before the real run:**
- volatility jumps that the fake option prices didn't reflect;
- calendar-day time in pricing while prices only move on trading days.

Lesson: an option bought and held over a weekend loses ~2 days of decay with no movement in return.

**How to apply:** O3 and I2 are candidates for forward paper tests, but each needs a new registration.
Warn the owner against buying options into results. See [[k2-audit-protocol-v2-2026-10-04]].
