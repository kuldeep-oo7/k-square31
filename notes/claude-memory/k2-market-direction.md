---
name: k2-market-direction
description: LIVE 29 Sep 2026 -- NIFTY downtrend (close<EMA20<SMA50) turns the page to puts only; one shared optionsView picks page rows AND live chains; its own test FAILED
metadata:
  node_type: memory
  type: project
  originSessionId: 5861e620-95f9-4ff4-94a8-989cf5f71ca8
  modified: 2026-09-29T17:18:41.927Z
---

**What it does (api/_lib/market-direction.js, live from the 29 Sep 22:36 IST build):**
NIFTY's regime from COMPLETED daily closes (risk-history `^NSEI`, cannot flip in
session). BEAR_HOSTILE = close < EMA20 < SMA50 → no futures, no calls; puts on
NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, NIFTYNXT50 and on stocks rated SELL/REDUCE
that are ALSO in their own downtrend (the composite is half non-directional:
Hurst 25% + vol band 25%). `optionsView()` is called by BOTH
prepare-static-build.js (which live chains to fetch) and publish-static-desk.js —
in session a contract with no live book is refused, so they must agree.

**Verified:** BEAR_HOSTILE every session since **Wed 2 Sep 2026**, recomputed on
NSE's own NIFTY history (29 Sep: close 22,716.2, EMA20 23,377.78, SMA50 23,932.93 —
identical to the build). I first told the user "since 21 Sep"; that was wrong
(I had only checked 21–28 Sep).

**Its own test FAILED** (research/regime-2026-09-29, pre-registered): shorts in
these downtrends final year +0.286%/trade, t 0.205, 18 trades; longs outside
−0.26%. The page says so in the banner. Stock puts are untested.

**First live build (29 Sep 22:36):** 295 puts on 38 names (3 indices, 35 stocks),
0 futures, 0 calls; audit-live-vs-nse.js clean (NOW = NSE last on 38; all 295
Zerodha names in Zerodha's own list; lots = fo_mktlots). Live index-chain fetch
proven against Angel after hours (centred on the live front future).

**Why:** the user, 29 Sep: "the market is falling ... you should know it and give
me the put option"; TRACK showed calls −₹4.9 lakh while buys kept coming.

**How to apply:** verify the FIRST IN-SESSION build (09:36) — pricedLive > 0,
PE levels frozen, health gate green. Yahoo has NO history for FINNIFTY
(NIFTY_FIN_SERVICE.NS) or MIDCPNIFTY (NIFTY_MID_SELECT.NS): 1 row only; their
rv/touch show "—" until NSE's index history is wired. NSE quotes index option IV
against SPOT; the desk solves against the traded future (Oct futures were
+0.7% to +1.8% over spot on 29 Sep) — IVs differ by convention, not a defect.
See [[k2-paper-ledger]], [[k2-open-requests-2026-09-29]].
