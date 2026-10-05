# Out-of-sample replication of the TRACK rules (5 Oct 2026)

studies/oos-replication-2026-10-05 (pre-registered b4669e42..., run once): the 8 forward-test rules'
own code on NSE 2005-2020 (release data-oos, scripts/nse-old-history.js) and today's S&P 500 2005-2026.
- Only SHORT BUILD-UP (SB) holds every way: +0.28%/trade, median +0.26%, positive every 5-yr period
  and in 2008; shrinking (+0.40 -> +0.31 -> +0.14).
- Strangle replicated (t 2.51) but ~0 since 2015. LU bounce mixed (lost 2015-20).
- Springy dip "STRONG" by monthly score but -0.10%/trade on NSE; cheap-vol straddle driven by stale
  old option prices (median -3.2%). MA150 shorts and industry reversal FAIL on NSE and US.
- NSE 2005-08 F&O headers alternate OPTIONTYPE / OPTION_TYP; ind_close_all exists only from ~2012.
- Lesson: always report the per-trade mean beside the monthly score; signals cluster in bad months.
