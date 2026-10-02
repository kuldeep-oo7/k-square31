# Handover from the laptop Claude (2 Oct 2026)

Read this together with `CLAUDE.md`. This note covers what lived only on the laptop: the
`research/` study results, the owner's rules from chat, and known problems. There are no
secrets in it. `research/` itself stays on the laptop (owner's rule: never commit it), so the
numbers are copied here.

## Every study run so far (all on the desk's NSE panel; all FAIL or NOT TESTABLE)

Unless noted, every study was pre-registered: the rules were sha256-hashed before any result
existed. The windows were development < 2024-09-19, validation 2024-09-19..2025-09-17 and
final 2025-09-18..2026-09-15. The final window has now been reused about 10 times, so it is
no longer clean.

| Date | Study | Result |
|---|---|---|
| 15 Sep | Ladder geometries (stop/target), 97 large caps, 5 years (not pre-registered; commit 3b4dc4b) | **0 of 24 geometries survive validation; all 24 validation cells negative.** Shorts: 24/24 negative in every split (dev t to −11.1). Six conditioners (12-1 momentum, 5-day reversal, RS, distance from 52w high, ATR%, volume ratio) none keep their sign. At no trend, +2.5/−1.5 needs **37.5% wins to break even**. |
| 17 Sep | APEX composite rating, 5-session hold | FAIL, final t 0.75 (1,205 trades). The page cites this, but the live rule holds 20 sessions (finding F26). |
| 25 Sep | 12-1 momentum, monthly, top/bottom 10 (sha256 8018767c…) | **FAIL** both legs. Paid in 2022-24, reversed in 2024-26. |
| 27 Sep | Published: time-series momentum, low vol, Faber 10-month (sha256 6f9c28df…) | **FAIL**. Final monthly excess: TS-mom −0.34% (t −1.14), low vol −1.32% (t −2.94), 10-month −1.03% (t −1.02). |
| 29 Sep | NIFTY trend reader as a filter (sha256 f729272a…) | **FAIL**. H1 shorts in downtrends: final +0.286%/trade, t 0.205, 18 trades. H2 longs outside downtrends: final −0.26%, t −0.43, 24 trades. |
| 29 Sep | Situations (sha256 03f93c90…) | US overnight ≥1%: FAIL (validation pointed the *other* way, t −2.6; final t −0.6; reversing it is a new, untested idea). Crude ≥3%: FAIL. Gap continuation: NOT TESTABLE (17 final trades). India VIX spike: NOT TESTABLE (12). Desk candlesticks on NIFTY: FAIL (t 0.13). Stock candles per stock: waits for the panel. |
| 29 Sep | Gap-down filter: no futures buys when NIFTY opens ≤ −0.5% (sha256 05b43924…) | **Not run yet.** The panel fetch from NSE's security-wise history was throttled after 18 requests. It can now use the `data-nse-cm` release, but its registration names the security-wise files: note the data change, or re-register. |

Descriptive only, not a test: on NIFTY the desk's short mirror made −0.21%/trade (−0.04% in
downtrends). Buys made +0.13% (+0.38% in downtrends). Open→close was −0.08%/day after charges.

What the owner has been told, plainly: no tested signal beats chance yet, and compute is not
the bottleneck. **Research context:** McLean & Pontiff (2016) found published anomalies lose
about 58% after publication. Harvey, Liu & Zhu (2016) argue for t > 3.

## Rules the owner gave in chat (not all in CLAUDE.md)

- **Answer in chat as plain text.** "Don't create an artifact", "just text".
- **Upgrade only, never downgrade.** Verify everything before saying or doing it. "This is not
  a joke or timepass."
- **Show every passing row, with no cap.** Several strikes of one stock count as one bet.
- **No value investing on the page** (owner said NO on 27 Sep). Today's balance sheet on old
  prices is look-ahead anyway.
- **"Don't build anything on your own / not by making up everything."** Use strategies other
  people published, with their own rules, tested honestly. Show only what PASSES, labelled as
  paper-tested. Never use the word guarantee.
- **The owner's anger on 29 Sep:** the downtrend switch emptied FUTURES and CALLS. "We are here
  to make money even when the market is down." "When you say call or put it should happen."
  Don't empty a tab on an untested premise without saying so on the page. Any fix must come
  from a passing test, not from loosening gates.
- **Photos after every push:** the phone first, every tab, top and scrolled. On the laptop
  they are saved to `Downloads\K2-screenshots\<date>\`; in the cloud use `page-check`.
- **GM Global:** nothing fetched or stored. It is a paper competition among friends, and the
  weakest pays the bills, so the owner cares a lot. Futures there are 20 units (not an NSE
  lot). GM quotes the NSE near-month future exactly. Don't raise regulator questions about
  GM.
- **Zerodha:** real money, options only. Every option shown must be an order Zerodha accepts.
- **Never kill processes by name, only by PID.**
- **Never commit `.private/` or `research/`.**

## Known problems not written elsewhere

- **TRACK shows the desk losing.** As of 2 Oct: futures hit rate 12.2% of 90 finished
  (break-even 37.5%), average −1.02%. Calls 12% of 332 finished (116 separate bets). These
  trades cluster on few sessions (F25), so the "95% range" understates the uncertainty. They
  are still the honest live record.
- **Yahoo bars are wrong on some days** (IRFC 15 Jan 2024; HINDZINC 21 May 2024), and Yahoo
  misses demergers. Prefer NSE's own files for any study.
- **NSE's option-chain `impliedVolatility` is quoted against spot.** Call and put IV differ for
  that reason, so it is not a clean benchmark.
- **The ratings composite is about half non-directional** (Hurst 25%, vol band 25%). A low score
  does not mean "going down".
- **The ml-model and boosted trees exist but never run on the desk.** The live path reaches
  only part of `api/_lib`.
- **The laptop's local NSE download stopped at 2024-01-29** after timeouts. The `nse-data`
  workflow continues it on GitHub.

## Owner's own to-dos (remind them; never do these yourself)

- Reset the Angel One TOTP secret. It was pasted in chat on 29 Sep, so treat it as exposed.
  Then update GitHub secret `K2_BROKERS_JSON` and Cloudflare `ANGEL_TOTP_SECRET`.
- Merge pull requests from the GitHub app. Never between 09:13 and 09:40 IST.
