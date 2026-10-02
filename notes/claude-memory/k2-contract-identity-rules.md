---
name: k2-contract-identity-rules
description: NSE expiry is TUESDAY not Thursday; Zerodha and Angel One name the same contract differently; and the Angel instrument master is 52% BSE/MCX rows that collide with NSE
metadata: 
  node_type: memory
  type: reference
  originSessionId: 5861e620-95f9-4ff4-94a8-989cf5f71ca8
  modified: 2026-09-21T15:24:31.341Z
---

Facts about Indian F&O contract identity, each verified against a broker's own
data on 2026-09-21 after the desk published an unfillable NIFTY card.

**NSE F&O expiry is TUESDAY.** Code computing "last Thursday of the month" (the
old convention) returns a date on which nothing is listed — for September 2026 it
gave 24 Sep when the real expiry was 29 Sep. Never compute the expiry; read it
from the exchange contract file (`fno-reference.js`, `entry.expiryList`).

**NIFTY has weeklies, stocks do not.** NIFTY's *front* expiry is usually a weekly
a few days out (22 Sep, 29 Sep, 6 Oct, 13 Oct, 19 Oct, 27 Oct…); BANKNIFTY and
all stocks list monthlies only. The front contract is therefore **not** the right
one for a multi-day hold — use `tradableExpiry(symbol, { minDays })`.

**One contract, three names.** For the 29 Sep 2026 ASIANPAINT 2460 call:

| where | form | example |
|---|---|---|
| Zerodha / Dhan, monthly | `SYM + YY + MMM + strike + CE/PE` | `ASIANPAINT26SEP2460CE` |
| Zerodha, **weekly** | `SYM + YY + M + DD + strike` (M = 1-9, then O/N/D) | `NIFTY2692223400CE` |
| Angel One | `SYM + DD + MMM + YY + strike + CE/PE` | `ASIANPAINT29SEP262460CE` |

Angel futures are `SYM + DD + MMM + YY + FUT`. `angelTradingSymbol()` in
`fno-reference.js` reproduces all 35,226 cached NSE contracts exactly — if it
ever disagrees, the master changed, not the format.

**The Angel instrument master is mostly NOT NSE.** It ships NFO, **BFO** (BSE)
and MCX rows in one file: 35,226 NSE options against 38,270 BSE and 636 MCX. BSE
lists different expiries (24-Sep vs NSE 29-Sep) and different lot sizes. Any map
keyed without the exchange lets BFO overwrite NFO, because BFO is parsed last.
Always filter `exch_seg === "NFO"`.

**How this surfaces:** the user pastes the desk's symbol into their broker and
finds nothing, or the premium is ~2x off the broker's screen. Both are contract
identity, not pricing. See [[k2-find-defects-by-distribution]] and
[[k2-live-path-is-narrow]].

**Angel One's quote open interest can be a day old (measured 2026-09-24).**
RBLBANK 395 CE read 19,050 at 15:40 -- exactly NSE's 23-Sep end-of-day figure --
against 209,550 in NSE's 24-Sep file; INDUSINDBK 980 PE likewise. Never use the
broker's `openInterest` for a decision; the desk's liquidity gate reads NSE's
`OpnIntrst` (fno-reference.js). For identity checks compare OI only where 50+
lots are open (97.9% agree there; a 3-lot contract moves 50% on one trade).

**Put-call parity only holds within ONE expiry at ONE moment.** The quote cache
mixes expiries and days (29-Sep books stamped 19 Sep beside 27-Oct books from 24
Sep); pairing across them gave ADANIENSOL a slope of -0.83. Pair a call and put
only on the same expiry and within 5 minutes on the exchange clock.

**Angel One quote TIMES mean different things (measured live 2026-09-25).**
`exchangeFeedTime` = when the quote was SENT; `exchangeTradeTime` = the contract's
LAST TRADE. At 09:13 pre-open, option quotes carried the PREVIOUS day's full
open/high/low under a today-dated feed stamp; in session, a contract that has
not traded today sends open/high/low 0 and a last trade from an earlier day, or
the never-traded stamp 01-Jan-1970 05:30:00. Treating the feed stamp as the
trade date replayed yesterday's range and faked a -64.8% STOP (BAJFINANCE 1000
PE). paper-ledger observe() now marks only quotes whose last trade is in the
current session.
