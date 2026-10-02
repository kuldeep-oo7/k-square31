---
name: k2-apex-engine-runs-on-synthetic-data
description: "The deployed Apex desk (k-square31 on Render) prices most symbols from a hash or a stale table and computes every quant score from a sine wave"
metadata:
  node_type: memory
  type: project
---

The live desk is a SECOND system, separate from the weekly-ladder engine:
repo `github.com/kuldeep-oo7/k-square31`, deployed at
`https://k-square31.onrender.com`, entry point `server.js`, universe in
`api/_lib/universe-210.js`, UI in `site/live-desk.html`.

Audited 2026-09-17 (commits 90e3f66..84f9412). What was found and fixed:

- **Track record was seeded.** `db-sqlite.js seedDefaultData()` wrote 7 signals
  and 3 trades on first boot; that is where "71.4% win rate, +Rs 51,492.50,
  4.52 profit factor" came from. It was being served from `/api/state` in
  production. Purged; every statistic now returns null until real.
- **Arbitrary file read.** The static handler resolved request paths against the
  repo root, so `GET /.private/k2-trading.db` returned the whole ledger with
  HTTP 200. Fixed; static now confined to `site/`.
- **160 of 210 symbols have no real price** — 120 from a hash of the symbol
  name, 40 from a hand-written `BASELINE_PRICES` table that had TATASTEEL at
  152.40 against a traded 187.29.
- **`generateHistoricalSeries` is a sine wave on a linear ramp.** Those 30 bars
  feed the 1D-CNN, GARCH, Cornish-Fisher VaR, liquidity, candlestick and chart
  patterns. All those modules are correct and merely starved.
- **VPIN, Hurst, half-life were `(index*3)%18` style arithmetic on array
  position**, never computed.
- **Four math bugs** in `institutional-calculus.js`, worst being a 99% VaR of
  exactly 0.00% on fat-tailed series (Cornish-Fisher left its monotone domain
  and `Math.max(0, ...)` hid it).

**Why:** recommendations are now deliberately ZERO (205 NO_MARKET_HISTORY, 5
SEBI_FO_BAN) because no row has real market history. That is intentional, not a
regression — before the gate, 49 of 49 priced rows passed the conviction hurdle.

**How to apply:** signals come back as soon as a real bar feed replaces
`generateHistoricalSeries`; `api/_lib/market-feed.js fetchChart` already returns
genuine NSE bars and is what the research path uses. Delete `BASELINE_PRICES`
once that lands. The `1D-CNN` in `neural-quant-engine.js` is hand-written
kernels, NOT trained — do not describe it as trained. `fundamentals.js` is wired
into `recommendation.js` and `weekly-plan.js` but referenced nowhere in the Apex
desk. Full write-up: `K2_APEX_FORENSIC_COUNTER_AUDIT_2026-09-17.txt`.
Related: [[k2-ladder-has-no-measured-edge]], [[k2-trading-rules]].
