---
name: k2-paper-ledger
description: "The track record the user demanded: every frozen level is a paper trade, marked every build, stored in git (docs/ledger/) and the Google Sheet; every ambiguity scored against the record"
metadata:
  node_type: memory
  type: project
  modified: 2026-09-29T17:21:53.886Z
  originSessionId: 5861e620-95f9-4ff4-94a8-989cf5f71ca8
---

**What the user asked for (2026-09-23), in their words:** "from the moment you
have showed everything ... hypothetical buy everything then you need to store
how long does it take to achieve the buy target to sell price hit ... expected
time ... achieved or not did we make the profit or not ... help you to audit
you and the whole system ... I also can see the track whenever I want."

**The serverless build had lost this entirely.** The old recorder
(`api/_lib/signal-record.js`, `signals_lifecycle` in SQLite) lives on a disk the
GitHub runner does not have. `scripts/paper-ledger.js` replaces it for the
static desk:

- Every level `session-freeze` FREEZES becomes a trade at `frozenAt`.
  `WAITING` → `OPEN` (buy limit filled) → `TARGET` / `STOP` / `EXPIRED` /
  `TIMED_OUT`, or `WAITING` → `UNFILLED` at 15:30 of its own session.
- Records `hoursToFill`, `hoursFillToExit`, `best`/`worst` since fill, P&L —
  options NET via `trade-costs.roundTripCost`, futures GROSS per unit (labelled).
- Stores the PREDICTION next to the outcome: options use the screener's
  `touchPct`/`daysToTarget` (calendar days); futures use `firstPassage()` with
  measured Yang-Zhang vol (`row.odds.realizedVolPct`), trading time.
- Files: `docs/ledger/open.json` (running) + `docs/ledger/closed-YYYY-MM.json`,
  committed every build; copied to the Sheet as `k2/ledger-*.json` and read back.
- Page tab **TRACK**; run summary has a track table first.

**Every ambiguity is resolved AGAINST the record** (35 tests in
`scripts/test-paper-ledger.js`): target+stop in one window = STOP; target in the
fill window not counted, stop in it counted; gap through stop exits at the open;
fill always at the limit; a day low from before the level was shown never fills
it (baseline = the quote at add time); tomorrow's low never fills today's limit.
Uses the day's HIGH/LOW from the quote, not just the last price, so a touch
between two 20-minute builds is not missed.

**`firstPassage()` fixes a direction bug the codebase had:** `trade-odds.js
timeToTarget()` assumes the level is ABOVE the price. For a buy limit BELOW it,
the martingale log-drift −σ²/2 points toward the barrier, so the drift sign
flips. At σ=25%, a 0.8% move in one session: up 61.0%, down 61.2%.

**Futures are anchored on the FUTURES contract, not the cash share.** Measured
2026-09-23: LT October future 3,946.40 vs the cash close 3,904.80 the page had
used beside the symbol `LT26OCTFUT` — the buy limit was 1.85% under the contract,
not the 0.8% claimed. `broker-feed.contractQuotes()` (Angel FULL mode, ≤50
tokens/call, returns `ltp/open/high/low/close`, where `close` is the PREVIOUS
session) now prices futures and options together; a futures level is frozen
only on a live same-session quote (`mayFreeze`), and a cash fallback is shown in
red. Level rules unchanged: `session-levels.js` 0.992 / ×1.025 / ×1.05 / ×0.985.

The `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING) ... src\win\async.c`
line after a build is Windows-only (libuv on exit after fetch); exit code is 0
and the Linux runner never prints it.

**The record, 29 Sep 2026 22:36 IST (live TRACK):** futures 60 finished (6
target, 54 stop), calls 111 (24/87), puts shown 24-25 Sep 34 (32 target, 2 stop).
BUT all of it was shown on only 4 sessions (24, 25, 28, 29 Sep) and 53 of 60
futures closed on 28-29 Sep: a falling market, ~4 independent days, NOT 60 bets.
The page's binomial 95% range ("below break-even") assumes independence and
OVERSTATES the certainty — audit F25, fix after the first in-session build.
Honest reading: direction dominated stock choice; too few days to judge the
rating. PUTS from 30 Sep are the direction rule's (see [[k2-market-direction]]).

See [[k2-serverless-desk]] and [[k2-session-freeze-in-git]].
