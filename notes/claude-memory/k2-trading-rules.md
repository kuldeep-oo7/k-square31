---
name: k2-trading-rules
description: "Kuldeep's K² trading regime — NSE futures only, Monday-open anchor ladder; the Friday forced book-out was superseded in code by a continuous 20-session hold"
metadata:
  node_type: memory
  type: project
  originSessionId: 19be2213-a4d7-4db0-b6e5-1f38bf2164c1
  modified: 2026-09-15T06:24:00.857Z
---

K² is a **pure trading** desk, not investment. Rules as stated 2026-08-13:

- **Instrument: NSE futures only** — every position is a futures contract, long
  or short. Not equity. (Still true. Note the research path still backtests on
  cash bars, which is an open gap.)
- **Target: 2-3% profit on a single name is a satisfying, complete trade.**
- **Ladder entries step 2% from the Monday-open anchor.**

**SUPERSEDED as of commit 86467f8 (before 2026-09-15): the Friday forced
book-out is gone.** The engine is now continuous — `DEFAULT_CONFIG` in
`api/_lib/weekly-cycle.js` carries `fridayLiquidation: false`,
`strategyId: "K2_CONTINUOUS_NSE_STOCK_FUTURES"`, `maxHoldingSessions: 20` and
`maxConcurrentPositions: 5`; positions carry across weeks with the Monday open
rebasing the weekly reference price, and `scripts/verify-ci-flags.js` asserts
the continuous policy is canonical. Do not "restore" Friday liquidation from
this memory — three independent commitments in code say otherwise, and the
20-session time stop is what replaced the risk ceiling Friday used to provide.

**Why:** the original engine carried lots across weeks with no bound at all,
which was the real problem; a finite holding ceiling solves it without forcing
a book-out at an arbitrary hour. Measurement also showed the forced Friday exit
was distorting results — it booked losers before mean reversion could act, which
is what produced the (now retracted) finding that hit rate moved inversely to
P&L. See [[k2-ladder-has-no-measured-edge]].

**How to apply:** score candidates on the continuous rule — enter on a ladder
level, exit on first touch of target or stop, otherwise time-stop at 20
sessions. Never on Friday-flat or on generic 3/5/10-session holds. Related:
[[k2-hosting-and-store]].
