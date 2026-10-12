# Whole-project audit, 12 Oct 2026 (after the close)

Rule 9 (CLAUDE.md): question every part; check it against its primary source, the logs and the data; trace
every fix through what it touches. Each problem below gives its **evidence**, what it **touches**, and its
**status**.

## A. Today's screen (12 Oct, 27 builds), checked against NSE's own 12 Oct F&O and CM files

| # | Problem | Evidence | Touches | Status |
|---|---|---|---|---|
| A1 | Options (index AND stock) vanished in the first builds and once mid-afternoon | 09:20/09:37/09:56/14:58: 0 index puts, 72-119 options vs ~250. indexScreen NIFTY: 569 examined, 237 "stale during session". The 120 s book window was shorter than the build's 60-190 s chain fetch | screener, freeze, TRACK fills, page counts | FIXED (bbde189): screener takes this build's books (10 min); test added |
| A2 | "All prices are from the 2026-10-09 settlement file" was false after the close | futures showed 12 Oct last trades; options 40/40 = 9 Oct file (NIFTY 22600 PE 288.45 vs NSE 12 Oct close 408.00). Calls/puts DID carry the "older file" warning | page text | FIXED (bbde189): says which price is from where |
| A3 | Short futures were missing from everything except the page, TRACK and health | NSE cross-check sample, evening NSE audit (16 futures checked, all longs), bad-day risk box, "if you take every row" totals, Google Sheet | risk-view, nse-crosscheck, audit-live-vs-nse, publish-to-sheet, page | FIXED (3e4a2a5): all five now include shorts; 4 risk tests. Evening NSE audit after the fixes: "No problem" (88 contracts incl. 45 futures) |
| A4 | After the close, NOW is the last trade, not NSE's official close (58 audit lines, max 0.29%) | e.g. PAGEIND 36,985 vs official 36,885. NSE posts the file ~19:00; GitHub's 19:43/21:13 schedule builds pick it up, late | page after hours | FIXED (9a58e46): once that session's NSE file is loaded, NOW is NSE's official close (label says so) |
| A5 | India VIX 15.24 vs NSE official 15.25 after the close | same timing as A4 | header | KNOWN (0.01; resolves on the evening build) |
| A6 | Ban list showed 12 Oct's list at 17:26 while NSE had posted 13 Oct's (adds KAYNES) | audit | ban gate | OK for trading: the 09:13 build reads 13 Oct's |
| A7 | 65 limit orders UNFILLED while NSE's day low went through the limit | ledger obs: the low was already the day's low when the row was first shown (e.g. BANKNIFTY 54100 PE shown 10:15, low 235.05 from before) | TRACK | CORRECT by design (no fill from before a level existed) |
| A8 | TRACK cannot see a dip between its 20-minute marks unless it is a new day low/high | ledger logic (observe) | TRACK fills AND stops | DISCLOSED on TRACK (3e4a2a5); measuring it needs an intraday recorder |

Verified correct today:
- every fill, stop and target TRACK recorded agreed with NSE's day high/low (0 contradictions in 432);
- the freeze held 43 futures (13 long + 30 short) from 09:20 all day;
- 27 of 27 builds succeeded;
- the paper job started at 07:50;
- order books (2.7 MB) and FII/DII (9 and 12 Oct) were recorded;
- NIFTY on the page equals NSE's official close.

## B. The rest of the project

| # | Problem | Evidence | Status |
|---|---|---|---|
| B1 | The "K2 upside model" workflow retrains every Saturday, but nothing on the desk reads it | no reference in desk.yml, prepare/publish/sheet or the screener; ~27 min of Actions minutes a week | FIXED (3e4a2a5): schedule off, still runnable by hand |
| B2 | GM Global code still in the repo (3 disabled workflows, api/gm-sync.js, scripts/gm-*.js) | CLAUDE.md: removal approved, by pull request | OPEN: PR after checking nothing on the desk path uses it |
| B3 | CLAUDE.md "Open work" lists the 30 Sep strategy atlas as pending | its folder holds only a downloader; the 3 Oct TA atlas tested the same families (all FAIL) | FIXED (3e4a2a5) |
| B4 | Insider filings: NSE moved them to a new feed (corporates-pit-gg) in ~May 2026; the old feed returns 0 | Sep 2026: old 0, new 895; the new one lists filings, details sit in one XBRL file each | OPEN: reader for the per-filing files |
| B5 | Options cost model uses today's 0.15% STT for every past year | NSE circular FATAX73524: 0.10% until 31 Mar 2026 | KNOWN: makes old option backtests slightly PESSIMISTIC; no verdict changes |
| B6 | The page's touch odds are far from what TRACK measures | futures said 69.8%, got 12.9%; calls 44% vs 17.2%; puts 42.6% vs 84% (11 sessions) | FIXED (d9ad08f): every card shows TRACK's measured rate for its kind beside the touch odds. Calibrating the odds themselves (conformal/isotonic): open, see the research report |
| B7 | `npm run check` stops at test-work-order-acceptance when the laptop's cached bars are >5 days old | an environment check, not code | FIXED (3e4a2a5): SKIPPED with the reason; `npm run check` exits 0 (187 steps) |
| B8 | Full NSE data: 16 datasets + insider filings collected; NSE lists 144 daily files | owner: "every data that nse publish" | DONE (1421d3e, ae5cbde): nse-all.yml collects every file on NSE's own list nightly at 20:45 IST; first run: 270 of 270 files, 0 failed, 287 MB, 5 min; release data-nse-all-2026, one tarball a day |
| B9 | The atlas history (laptop) is not yet uploaded to GitHub | release data-nse-atlas holds Sep-Oct 2026 only | IN PROGRESS: queued after the laptop download |
| B10 | The Google Sheet's Apps Script was not checked for SELL rows | it lives in the owner's Google account | UNVERIFIED |

## C. Found while fixing

| # | Problem | Evidence | Status |
|---|---|---|---|
| C1 | The red OUT OF DATE line fired every evening after 22:00 (a false alarm) | the 6 h grace ran out before the 07:50 paper job; the module's own comment promised no evening alarm | FIXED (d620e64): 17 h grace; 2 tests |
| C2 | The first nse-all GitHub run spent its whole hour on retries | sent the website cookie to the archive host; 120 s x 3 tries; no progress log | FIXED (ae5cbde): second run 5 min, 0 failed |
