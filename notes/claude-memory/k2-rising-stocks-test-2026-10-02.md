---
name: k2-rising-stocks-test-2026-10-02
description: The "stocks rising on their own while NIFTY falls" rule went live on 2 Oct 2026, then FAILED its pre-registered test the same night. Every member lost because the desk's geometry wins only 27-35% of trades.
metadata:
  type: project
---

**2 Oct 2026, the change.** The owner was angry that a falling NIFTY emptied FUTURES and CALLS.
`optionsView` (api/_lib/market-direction.js) now reads each stock's own trend on every build:
- rising stocks (not rated SELL/REDUCE) get futures and calls, even in a NIFTY downtrend;
- falling SELL/REDUCE stocks get puts in any market;
- index puts appear only in a NIFTY downtrend.

Live at commit 29a0ab9. The first build showed 10 rising names (COALINDIA, CYIENT, DELTACORP,
DRREDDY, KOTAKBANK, LALPATHLAB, LAURUSLABS, MANKIND, PHOENIXLTD, SUNTV).

**The test.** research/rising-stocks-2026-10-02 (not committed), prereg v2 sha256 2c64fd54...
- v1 stopped itself before computing anything: NSE's bhavcopy prevClose does NOT carry splits
  or bonuses (RELIANCE bonus day prevClose 2655.7 vs open 1337), and a split changes the ISIN.
  So key by symbol and treat |open/prevclose| >= 18% as a reset.
- Data: NSE CM bhavcopy 2020-09..2026-10 (release data-nse-cm), top 200 by traded value, desk
  geometry, dated charges.

**All three members FAIL:**

| Member | Final mean / trade | t | Trades | Win rate |
|---|---|---|---|---|
| H1: rising while NIFTY falls, long | −0.444% | −3.34 | 1,680 | 26.7% |
| H2: falling stocks shorted in a downtrend | −0.123% | −0.48 | 3,019 | n/a |
| H3: rising in a normal market, long | −0.105% | −1.83 | 8,632 | n/a |

The banner and calls note now say "Tested: FAILED", with these numbers (commit ead0acd). The rows
stay because the owner wants them shown.

**Why:** across every member, winners are 27-35% of trades against the 37.5% break-even of +2.5/−1.5.
The desk's ENTRY/EXIT GEOMETRY loses whichever stocks it is given. The 0.8%-under-open limit fills
mainly on down days (adverse selection). See [[k2-ladder-has-no-measured-edge]].

**How to apply:** don't look for a better stock filter on this geometry. The next candidates are
order flow / OI build-up on NSE F&O bhavcopies, and FII participant OI; pre-register each.
