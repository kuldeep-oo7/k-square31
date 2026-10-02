---
name: k2-risk-view
description: "Bad-day risk box (historical simulation, 2y) on futures+calls tabs, live 2026-09-28; demergers poison Yahoo history; phone folds notes; user chose no value investing"
metadata:
  node_type: memory
  type: project
  originSessionId: 5861e620-95f9-4ff4-94a8-989cf5f71ca8
  modified: 2026-09-28T02:57:58.027Z
---

Live since build 2026-09-28 07:49 IST (commits fb2f375, 1bbbadb, 1f62706). User chose on 2026-09-27: build the Aladdin-style risk view (yes), fold long notes on the phone so rows come first (yes), Buffett-style long-term value list (NO, stay with futures + calls).

- api/_lib/risk-view.js replays today's rows through 500 trading days of real OHLC (stop/target exits like the ledger; gap through stop exits at the open). Calls repriced Black-76 with IV HELD — the pessimistic end. Scaling IV by India VIX (+65.69% on 7 Apr 2025, NSE) cut the calls' worst day from 24.2 lakh to 2.3 lakh: a range too wide to print, so the page states direction only.
- Own 2y history (api/_lib/risk-history.js, .private/cache/risk-bars) — the technical read's 3-month bars are untouched (changing them would change every score). Fetched by the first build after 15:30; the am/pm Actions cache carries it.
- Yahoo NSE history does NOT adjust demergers (ABFRL -66.6%, VEDL -64.9%, TMPV -40.2%, STAR -54.0%) and put two bonuses on the wrong day (CONCOR 1 Jan 2025 = 4/5, TRENT 1 Jan 2026 = 2/3). Guard: NSE corporate-actions API (api/_lib/nse-corporate-actions.js) — exclude ex-dates and gaps equal to a bonus/split ratio. 11 real crashes >20% (INDUSINDBK, IEX, POLICYBZR -36% on 24 Sep 2026...) verified against NSE history and kept.
- First figures (27 Sep rows): futures 63x20u 1-in-20 -36,545, worst day 7 Apr 2025 -1,64,623 (61/62 stops gapped) vs -38,448 every-stop; calls 193 lots -8.9L / -24.2L; ~95% of stocks fall together on bad days.
- Header bug fixed 28 Sep: "no session today" fired every trading morning before 09:15; now only on non-trading days or after the close with no trades.

**Why:** the user trades real money on calls; "every stop hit" hid gap risk and correlation. **How to apply:** keep the call-IV caveat honest; re-verify any new corporate-action pattern by distribution ([[k2-find-defects-by-distribution]]); phone-first screenshots after every push ([[verify-live-page-with-screenshots]]).

**28 Sep follow-ups:** the user wants ONE pick that makes money and is fine with long processing; told plainly that compute is not the bottleneck and no tested signal beats chance. Pre-open NSE identity check now skipped (NSE's pages show the previous session until 09:15 — WIPRO FUT prev close 162.87 = Thursday's vs Angel/bhavcopy 162.35). Options after hours show LastPric (35.70) while brokers' "Prev. close" is ClsPric (35.40) — both NSE numbers.
