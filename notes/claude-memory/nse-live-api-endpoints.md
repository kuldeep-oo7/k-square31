---
name: nse-live-api-endpoints
description: Which nseindia.com live endpoints work in Sep 2026 (option-chain-v3, NextApi GetQuoteApi) and which are dead (quote-derivative 404, quote-equity 403); NSE option-chain IV is not a clean benchmark
metadata:
  type: reference
---

Checked live on 2026-09-25 (market open), each with a browser User-Agent and
the cookie from first loading https://www.nseindia.com/option-chain:

- WORKS `api/option-chain-v3?type=Equity&symbol=LT&expiry=27-Oct-2026`: the
  full live chain, CE/PE with lastPrice, buyPrice1, sellPrice1,
  impliedVolatility; `records.timestamp` and `underlyingValue`.
- WORKS `api/NextApi/apiClient/GetQuoteApi?functionName=getSymbolData&marketType=N&series=EQ&symbol=LT`:
  the share, with `equityResponse[0].orderBook` (lastPrice, buy/sellPrice1..5).
- WORKS `api/NextApi/apiClient/GetQuoteApi?functionName=getSymbolDerivativesData&symbol=LT`:
  futures and the most active options, with open/high/low/last/prevClose per contract.
- WORKS `api/option-chain-contract-info?symbol=LT` (expiries, strikes) and
  `api/holiday-master?type=trading` (official holidays, per segment).
- DEAD `api/quote-derivative` (404), `api/quote-equity` (403), and
  `api/option-chain-equities` returns `{}`.
- Archives (no cookie needed): nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_YYYYMMDD_F_0000.csv.zip
  and .../content/cm/BhavCopy_NSE_CM_...; fo_secban.csv for the ban list.

**NSE's option-chain `impliedVolatility` is not a clean benchmark.** Where the
future sits well away from spot, its call and put IVs at the SAME strike split
by 13-20 points (HAVELLS 1080: call 16.0%, put 29.6%; future -0.88% vs spot),
which is what a spot-based calculation produces. Put-call parity on NSE's own
mids gives the FUTURES price as the forward (HAVELLS 1080.50 vs future 1080.00).
The desk's Black-76 on the live future stays parity-consistent. NSE does not
document its method; the spot-based reading is an inference from its data.
Live cross-check that day: Angel One vs NSE, 34 contracts seconds apart,
median gap 0.067%. See [[verify-against-the-internet]], [[k2-contract-identity-rules]].

**Field facts, measured 2026-09-25 after the close (these drive the per-build
check in api/_lib/nse-crosscheck.js, pushed as d24a241):**
- Previous close is an exact contract fingerprint: Angel One's `close` equals
  NSE's `prevClose` (futures), `metaData.previousClose` (share) and
  `lastPrice - change` (option-chain-v3 legs, which carry no prevClose or
  openPrice). 9 of 9 by hand, 8 of 8 on the GitHub runner. Sep and Oct futures of
  one stock differ (SBIN 981.30 vs 986.30), so a wrong expiry fails.
- After the close a share has two last prices: `orderBook.lastPrice` is the last
  continuous-session trade, `metaData.closePrice` the official close that Angel
  One shows as ltp (IPCALAB 1958.80 vs 1970.80). The futures `closePrice` is 0
  until the settlement file.
- getSymbolDerivativesData returns every future but only ~81 options (the most
  active), so options are read from option-chain-v3.
- NSE's APIs answered from a GitHub Actions runner (ban list, board meetings,
  allIndices, quotes). The first IN-SESSION run of the per-build check is Mon 28 Sep 2026.

**Listed symbols and renames (archive, no cookie):** content/equities/EQUITY_L.csv
(~2,585 symbols) and content/equities/symbolchange.csv (company, old, new, date;
read from the right -- names contain commas). Used every build by
api/_lib/nse-symbols.js to follow the user's workbook to current symbols:
AMARAJABAT->ARE&M (2023), LTIM->LTM (27 Feb 2026), GUJGASLTD->GUJENERGY (1 Jul
2026), IBULHSGFIN->SAMMAANCAP; PEL->PIRAMALFIN is a merger (no change record,
followed via the workbook's Yahoo column). GSPL is not listed.

