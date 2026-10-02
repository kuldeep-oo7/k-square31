---
name: k2-find-defects-by-distribution
description: "On this desk, defects are found by measuring the distribution of an output across the whole universe, not by reading code — a lopsided or low-cardinality distribution names the bug"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 5861e620-95f9-4ff4-94a8-989cf5f71ca8
  modified: 2026-09-21T02:41:00.271Z
---

Every significant defect found on the K² desk was caught the same way: compute
an output for all ~210 symbols, then look at its **distribution** — how many
distinct values, how lopsided, how it compares to an outside number.

**Why:** these defects never throw, never crash and never fail a test. The code
runs and produces a plausible number. Only the shape across a universe reveals
that the number was invented. Reading code for bugs has repeatedly missed them;
measuring has never failed.

**How to apply — the signatures, each of which caught a real defect:**

- **A component reports NOTHING universe-wide** → the wire is cut, not the
  detector. 2026-09-21: `chart-patterns.js` returns `primaryPattern`;
  the scanner read `dominantPattern`, so 309 lines of working geometry resolved
  to NONE forever. *Feed the detector a textbook shape you drew yourself* — it
  returned `patterns: [DOUBLE_BOTTOM]` and `dominantPattern: NONE` in the same
  object, separating a broken detector from a severed wire in one run.
- **Low cardinality on a weighted term** → a step function or a constant. 202
  distinct GARCH forecasts collapsed onto a 3-valued label driving 61% of the
  spread on a 25% weight.
- **A saturated score** (median 97, min 62, clamped at 98) → an unbounded
  non-negative term summed into a sigmoid.
- **A workaround is evidence someone already hit the bug.** The neural
  percentile had been repointed at a direction-free magnitude *because* the
  alpha score was saturated. Follow a workaround back to what it avoided.
- **A lopsided verdict across a universe** → suspect the INPUT, not the market.
  CHEAP 154 vs EXPENSIVE 122 revealed options priced off the cash share.
- **An outside number already on screen** settles it fastest: India VIX at 12.4
  caught an 8% implied volatility.

Also: **check you are testing against the right null before touching the
statistic.** The Hurst estimator looked broken because it was being driven with
drift; classical R/S de-means each window, so drift is invisible to it by
design. Driven with AR(1) increments it separated cleanly and needed no change.

See [[k2-apex-engine-runs-on-synthetic-data]] and [[k2-live-path-is-narrow]].

**The recurring defect class is Number(null) === 0 (found 7 times on 2026-09-25).**
`Number.isFinite(Number(x))`, `(x || 0) > 5`, `round(null)` and `money(null)`
all turn an UNKNOWN into a real zero. Found this way: 154/154 calls claiming a
known 0% spread after the close; balance-sheet score scoring missing ROE/current
ratio (257 of 277 names -- Yahoo omits both for NSE stocks) so 95 names lost the
+4; "FILL -> TARGET 0 h" with no targets; a would-be false wrong-contract alarm
in nse-crosscheck; unknown bar age read as fresh. Use numeric()
(scripts/session-freeze.js) or an explicit null check. A distribution that is
100% one value ("spreadKnown: true 154/154") is the tell.

