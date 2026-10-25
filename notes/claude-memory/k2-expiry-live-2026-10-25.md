---
name: k2-expiry-live-2026-10-25
description: "25 Oct 2026 -- expiry-day paper trade shown live on TRACK + achievable fills recorded (amendment A1 18c0101); Zerodha facts checked (SL-M banned on index options, +2% ELM on expiry day, straddle margin ~Rs 2.03 lakh + Rs 58,760); option-archive holiday-marker bug fixed"
metadata:
  node_type: memory
  type: project
  originSessionId: 5861e620-95f9-4ff4-94a8-989cf5f71ca8
  modified: 2026-10-25T07:01:54.510Z
---

- Amendment A1 to studies/expiry-selling-forward-2026-10-21 (commit 18c0101, Sun 25 Oct 12:26 IST, sha 6d3d1803...):
  information only. On NIFTY expiry sessions each in-session desk build fetches the EXPIRING NIFTY options nearest NIFTY's
  open (NSE allIndices "open", = ind_close_all open, checked on 23 Oct: 22742.2). Before this, the desk never fetched
  expiring options (13 Oct recording held 27 Oct options only), so no achievable fill existed. Code: api/_lib/expiry-live.js,
  prepare-static-build step "expiry-day NIFTY options for the paper test", expiryLiveLine in publish-static-desk.js;
  broker-feed chain legs and the quote cache now carry open/high/low. The order-flow recorder keeps the books.
- Zerodha, checked 25 Oct 2026 on its own pages: SL-M orders are NOT allowed on index options (exchange discontinued);
  use SL (stop-limit), which stays unfilled if price jumps past the limit. Expiry day adds 2% x underlying x lot of
  margin per SHORT index option lot, hedged or not (SEBI circular 1 Oct 2024; NSE in force 20 Nov 2024). Zerodha SPAN
  calculator 25 Oct: NIFTY 27-Oct 22600 CE+PE sold, 65 each = Rs 2,02,864 (SPAN 1,40,471 + exposure 62,393); plus
  2 x Rs 29,380 on expiry day -> about Rs 2.6 lakh. POST to https://zerodha.com/margin-calculator/SPAN with
  action=calculate&exchange[]=NFO&product[]=OPT&scrip[]=NIFTY26OCT&option_type[]=CE&strike_price[]=K&qty[]=65&trade[]=sell.
- BUG fixed: scripts/nse-nifty-option-days.js wrote ".none" holiday markers measured from <to>; nifty-options.yml passes
  <year>-12-31, so release data-nifty-options nod-2026 marked 21 Oct .. 18 Dec 2026 as holidays (20 Oct = Dussehra, real).
  Now: marker only for a 404 > 10 days before the IST date; recent/future markers are removed and re-checked; no fetch
  after today. Test scripts/test-nifty-option-days.js. The forward test's nse-nod was not affected.
- NSE expiries move on holidays: Angel master listed NIFTY expiries 19 Oct (Mon), 9 Nov (Mon), 23 Nov (Mon) 2026.

- NSE allIndices answered on 22 of 22 Friday (23 Oct) in-session builds that ran the step: no fallback centre needed.
- NOT YET SEEN ON REAL DATA (25 Oct): Monday 26 Oct, check of-2026-10-26.jsonl.gz (release orderflow-rec) option rows carry
  open/high/low at positions 10-12 (non-null), the step's log names "next in the Angel master: 2026-10-27", and Angel's
  option `open` equals NSE's official open in Monday's F&O bhavcopy for a few contracts. Tuesday: read the 09:35 cloud
  page-check's track-paper photos for the live line; evening: node scripts/expiry-fills-report.js 2026-10-27
  <of-2026-10-27.jsonl.gz> <nse-nod> <nse-idx>.

**How to apply:** on an expiry evening, report the achievable sale (first recorded best bid after 09:15 per X2/X4 leg vs
its official open) from orderflow-rec, beside the registered result. See [[k2-expiry-selling-2026-10-21]].
