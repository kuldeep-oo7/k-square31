---
name: k2-microstructure-data-limits
description: What the desk has for heatmap, time & sales, footprint, delta, VWAP, gamma exposure, volume/market profile (checked 4 Oct 2026): daily NSE files plus 20-min book snapshots from 5 Oct; Angel feed is best-5 only; GitHub job max 6 h
metadata:
  type: reference
---
Checked 4 Oct 2026, when the owner asked whether we "have" heatmap, time and sales, gamma exposure,
footprint, delta, VWAP, order flow, auction market theory, and volume and market profile.

**What we have**
- Six years of daily data, from NSE's own files (releases data-nse-cm and data-research):
  - OHLC, volume and traded value (so daily VWAP = value / volume) and delivery;
  - F&O OI per contract and per option strike (so daily gamma exposure);
  - participant OI (FII/DII/Pro/Client).
- From Mon 5 Oct, one book snapshot per desk build (about every 20 min), saved to release
  orderflow-rec:
  - LTP, OI, volume, total buy and sell quantity;
  - ATP (the day's VWAP);
  - the best 5 bids and asks, with order counts.

**What we do NOT have**
- every trade (time and sales);
- which side started each trade (footprint, delta);
- a full-depth book history (heatmap);
- intraday bar history (volume profile, market profile/AMT, intraday VWAP).

**Outside limits (sources named)**
- Angel One:
  - The 20-level depth was withdrawn from WebSocket 2.0 on 25 Apr 2025, and the best 5 remain
    (admin notice, smartapi forum post 18147).
  - The V2 feed's fields, from Angel's own parser (angel-one/smartapi-python
    smartWebSocketV2.py): LTP, last traded quantity and time, ATP, day volume, total buy and sell
    quantity, OHLC, OI, and the best 5 (price, quantity, orders). There is NO aggressor side.
  - 1000 tokens per session (forum).
- Angel historical candles: ONE_MINUTE is at most 30 days per request (Angel's docs table, quoted on
  its forum). Users report 1-minute data back to Oct 2016. UNVERIFIED: check by fetching.
- GitHub-hosted jobs run at most 6 hours (docs.github.com/en/actions/reference/limits). NSE's
  session (09:15-15:30) is 6 h 15 min, so a full-day recorder needs two jobs.

**Already tested**
- OI build-up and unwinding: FAIL.
- FII cutting → short NIFTY: FAIL (t −1.02 and −0.59). FII adding: NOT TESTABLE.
- Max-OI pinning: prices move AWAY from the max-OI strike (t −3.88).

**Gamma theory:** Baltussen, Da, Lammers & Martens, JFE 142(1) 2021, pp. 377-403. Short-gamma
hedging leads to momentum in the last 30 minutes of the day; testing it needs intraday data.

**How to apply:** don't research these again.
- Testable now: daily gamma exposure and daily VWAP rules.
- Anything intraday needs Angel's 1-minute history (check how far back it really goes) or a tick
  recorder.

See [[k2-open-requests-2026-09-29]] and [[k2-audit-protocol-v2-2026-10-04]].
