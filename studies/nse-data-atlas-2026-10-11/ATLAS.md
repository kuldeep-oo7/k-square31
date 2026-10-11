# What NSE publishes, A to Z, and what each could do for the desk (11 Oct 2026)

**Primary source:** NSE's own "All Reports" list, `www.nseindia.com/api/daily-reports?key=CM|FO|INDEX|SLBS|CD|COM|NBF`, read 11 Oct 2026.
- It lists **144 daily files**: equities 39, F&O 34, indices 2, stock lending 5, currency 25, commodities 23, interest-rate 16.
- NSE's website also serves data that is not in files: FII/DII cash, insider trades, takeover disclosures, shareholding, announcements, results and the event calendar.
- **History:** each file was probed on 14 Jun 2021 and 14 Jun 2024 at NSE's own archive path. "2021" means NSE still serves it from 2021 or earlier.

**Rule (CLAUDE.md 4):** nothing here becomes a signal on the page until a pre-registered test passes. A dataset can be shown as information (like VWAP), or used for accuracy (a check that an order would be accepted), without a test.

## A. Already used by the desk

| Dataset (NSE file) | Used for | Tested as a signal |
|---|---|---|
| CM bhavcopy, UDiFF (`BhavCopy_NSE_CM_…`) | every price, every study | (base data) |
| F&O bhavcopy, UDiFF (`BhavCopy_NSE_FO_…`) | futures, options, OI, every study | (base data) |
| Full bhavcopy with delivery (`sec_bhavdata_full_…`) | delivery % | FAIL (families 4 Oct) |
| Participant-wise OI (`fao_participant_oi_…`) | GEX sign; FII positioning | FAIL (order flow 3 Oct, GEX 4 Oct) |
| Index snapshot (`ind_close_all_…`) | FINNIFTY/MIDCPNIFTY history, VIX official close | (base data) |
| F&O ban list (`fo_secban_…`) | page gate | leaving the ban: FAIL |
| Contract file (`NSE_FO_contract_…`) | expiries, strikes, lots | (accuracy) |
| Board meetings / results dates (API) | results gate, results-drift study | buying straddles into results LOSES (t −6.7) |
| Corporate actions (API) | split/bonus guard | (accuracy) |
| 52-week high/low | 52-week-high rule (George & Hwang) | FAIL (strategy atlas) |
| Option chain, quotes, VIX (API) | live checks, audit | (accuracy) |
| FII/DII cash (`api/fiidiiTradeReact`) | recorded daily from 11 Oct 2026; NSE keeps only the latest day | not testable until months of history exist |

## B. NOT used yet, history from 2021 or earlier: testable now

| Dataset (NSE file) | What it is | How it could help (hypothesis, untested) |
|---|---|---|
| Participant-wise trading volume (`fao_participant_vol_…`) | each day's buying and selling by Client / DII / FII / Pro, in index and stock futures and options | flow, not just stock: does FII or Pro net buying of index futures or calls predict NIFTY over the next 1-5 days? |
| FII derivatives statistics (`fii_stats_…xls`) | FII buy/sell contracts and ₹ value in index and stock futures and options, plus end-of-day OI | same idea, in rupees, split by instrument |
| Short selling (`shortselling_…`) | shares sold short per stock, per day (disclosed) | crowded shorts: do heavily shorted F&O stocks bounce (short squeeze) or keep falling? |
| SLB open positions (`slb_openpos_…`) | shares borrowed per stock (securities lending) | borrow demand is a cost of shorting; high open SLB = crowded short |
| Daily volatility (`CMVOLT_…`, `FOVOLT_…`) | NSE's own daily and annual volatility per stock and contract | accuracy: a second, exchange-made volatility for option pricing and touch odds |
| Combined OI across exchanges (`combineoi_…`) | OI per stock against its market-wide position limit (MWPL) | stocks close to the 95% ban line: forced unwinding before a ban |
| Clients ≥ 3% of MWPL (`mwpl_cli_…`) | stocks where single clients hold big F&O positions | concentration: does it precede big moves? |
| Category-wise turnover (`fo_cat_turnover_…`) | F&O turnover by participant category | activity share of retail vs institutions |
| Top 10 clearing members (`fao_top10cm_to_…`) | share of the 10 largest clearing members in F&O turnover | concentration of flow |
| Market activity report (`MA…csv`) | market-wide breadth, turnover, advances/declines | breadth as a NIFTY trend input |
| Insider trading, SEBI PIT (API `corporates-pit`) | promoter and insider buys and sells (June 2021 alone: 4,606 filings) | do insider BUYS in F&O stocks lead returns? |
| Takeover disclosures, SAST (API) | large holders crossing thresholds | stake building |
| Announcements (API) | every company filing | event days (orders, pledges, rating changes) |

## C. NOT used yet, history only from about 2024 (2 years: testable, but weaker)

| Dataset | What it is | How it could help |
|---|---|---|
| Margin trading disclosure (`mrg_trading_…`) | per stock, how much retail buying is on borrowed money (MTF) | leveraged crowding: forced selling in falls |
| Combined delta-equivalent OI (`combineoi_deleq_…`) | options OI converted to deltas | better order-flow and gamma inputs |
| Surveillance indicator (`REG_IND…`) | ASM/GSM and other exchange surveillance flags per stock | accuracy: flag stocks under surveillance (higher margins, trade limits) |
| PE ratio (`PE_…`) | P/E per stock | owner said no to value investing; information only |

## D. Accuracy, not signals: make the rows more correct

| Dataset | Use |
|---|---|
| Price bands / circuit (`sec_list_…`, `eq_band_changes_…`, `circuit_…`) | an order outside the day's band is rejected. **The desk does not read it today.** |
| NCL contract delta (`Contract_Delta_…`) | NSE's own option deltas, a check on ours (no 2021/2024 history: recent only) |
| SPAN / exposure margin files (`nsccl.*.zip`, `ael_…`, `F_AEL_OPT_CONTRACTS_…`) | the margin a futures row needs (Zerodha); not needed for buying options |
| Daily settlement prices (`FOSett_prce_…`) | official mark-to-market price |
| Security / contract master files (`NSE_CM_security_…`) | tick sizes, lots, series: already checked through the contract file |

## E. Published but not useful for this desk

- **Margin and collateral:** VaR files, haircuts for approved securities and mutual funds.
- **Tax and housekeeping:** STT non-applicability, settlement statistics, close-out prices, auction lists.
- **Exchange operations:** latency statistics.
- **Other segments:** SME bhavcopy and bands; corporate bonds.
- **Other markets:** the currency (25), commodity (23) and interest-rate (16) segments. The owner trades equity F&O only.

## Plan

1. **Download B and C's daily files from 2020-09** (raw, into `research/`, never committed). Collecting data computes nothing, so it can start before the rules are written.
2. **Pre-register one study** with a few members per dataset: rules hashed and committed BEFORE any number. Members:
   - participant volume and FII stats → NIFTY;
   - short selling and SLB → stocks;
   - MWPL closeness;
   - insider buys;
   - breadth.
3. **Run once, under protocol v2.** A PASS goes to TRACK as a paper rule first.
4. **Accuracy item D (price bands):** check whether any shown order would be outside NSE's band. If any is, add the gate. This needs no test.
