---
name: k2-show-every-passing-row
description: "User decision 2026-09-25: no cap on rows -- every contract that clears every gate is shown; strikes of one stock are marked as one bet"
metadata:
  type: feedback
---

Show every futures row and option contract that clears every gate. No top-N cut.

**Why:** the user, 2026-09-25: "if it is passing all of this then it is a good
one ... why we have to force it to cut down to only 3 that does not make it
right". The page had kept 40 options / 25 futures while its header said 162 had
cleared every gate (fixed in c6d4b64). Accuracy is to come from the gates, not
from an arbitrary count.

**How to apply:** never reintroduce a display limit to make the page "shorter"
or "more selective"; tighten a gate instead, and say which. Several strikes of
one stock are one bet: keep them grouped, marked "another strike of X -- the same
bet", and count separate bets (symbol+day) on TRACK. Also no gate that empties
the page on an unproven premise (e.g. no-trend expectancy) -- state it on the
page and let the user decide. See [[k2-trading-rules]], [[k2-ladder-has-no-measured-edge]].
