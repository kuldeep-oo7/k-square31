---
name: k2-open-requests-2026-09-29
description: "User's open asks from 29 Sep night -- backtest every strategy across every market situation; VWAP and order flow (both NOT used); whole-system buy/sell check"
metadata:
  node_type: memory
  type: project
  originSessionId: 5861e620-95f9-4ff4-94a8-989cf5f71ca8
  modified: 2026-09-29T17:35:45.906Z
---

Asked 29 Sep 2026 (late), still open:

1. **Backtest everything, by market situation** — "every strategy ... technical,
   fundamental, value, data science, ML, quant ... gap down, gap up, near expiry,
   expiry day, non-volatile, high volatile, bullish, bearish, every type of market
   situation from around the world". Told them: pre-registered, on NSE's own data,
   PASS/FAIL per strategy and per situation; options need NSE's historical F&O
   files (not on hand) or are only modelled (label it); value needs point-in-time
   fundamentals (today's balance sheet on old prices = look-ahead).
2. **VWAP** — NOT used. `advanced-quant.js calculateAnchoredVwap` exists (daily-bar,
   Monday-anchored), called only by a test. Offer: show the day's VWAP by NOW; test it.
3. **Order flow** — NOT used for any BUY/SELL: VPIN is a daily-volume proxy that
   resolves for 2/212 names (skipped); Kyle lambda (daily) does penalise the neural
   score; bid/ask only for the spread gate; OI only as a liquidity gate. Offer:
   record depth + OI change on every quote; backtest OI build-up on NSE F&O files.
4. **"Is it correctly saying buy and sell"** — the live TRACK answers it: see
   [[k2-paper-ledger]] (BUY side below break-even with 95% ranges excluding it).

**First backtest done (research/situations-2026-09-29, prereg sha256 03f93c90, run
29 Sep 17:30 UTC):** A1 US overnight ≥1% FAIL (validation pointed the other way, t −2.6,
final did not, t −0.6 — reversing it is a NEW untested idea; never offer it as a signal),
A2 crude ≥3% FAIL, A3 gap continuation NOT TESTABLE (17 final; no direction either way),
A4 VIX spike NOT TESTABLE (12), A5 desk candlesticks on NIFTY FAIL (t 0.13); P1 stock
candles waits for the NSE panel (history endpoint timed out after 18 requests; the
fetcher now stops itself, 3 s spacing, 07:00 IST deadline; NOT resumed). Descriptive: the
short mirror on NIFTY −0.21%/trade (−0.04% in downtrends); buy +0.13% (+0.38% in
downtrends); NIFTY open→close −0.08%/day after charges but only −0.04% before them
(post-hoc; charges 0.029/0.036/0.050% per round trip by window). The final window is
re-used (~9 tests): not clean. Next: replay the desk's own rating on the LIVE geometry
(20-session hold) on the NSE panel — the page's "t = 0.75" is a 5-session study (F26).

Also still open from the audit log (Downloads/K2-screenshots/2026-09-29/AUDIT-LOG.md):
F3 macro shield hard-coded NORMAL; F21 VWAP; F23 FINNIFTY/MIDCPNIFTY history
from NSE; the gap-filter study (panel fetch blocked by NSE at the time).

**Why:** the user trades real money on calls/puts (Zerodha) and paper futures (GM);
they are angry that months of work have not produced direction.
**How to apply:** never claim an edge a pre-registered test has not passed;
report each result with its numbers and photos in the dated folder.
See [[k2-market-direction]].
