---
name: k2-gm-weekly-lab-2026-10-29
description: 10 weekly-chart strategies scored by GM Global's own rule (Monday open -> Friday close, weekend gap not counted, cut at expiry), 2005-2026 futures: 0 PASS
metadata:
  type: project
---

**Owner, 29 Oct 2026:**
- "we want to do it in the GM Global ... earn money in 1 month before expiry".
- The rule: after Friday's close the loss is booked, and Monday's open is the new buying price for the week. This is the
  same as the 20 Oct record: the week's P&L is booked and the price re-bases at Monday's open.

**The study:** studies/gm-weekly-lab-2026-10-29 on branch claude/gm-weekly-lab-2026-10-29 (built on the chart-lab
branch). Prereg sha256 c6065d9f..., committed 21:57 IST before data. One run: Actions 40912563154.

**Members:**
- W1 Weinstein stage 2/4 (30-week SMA);
- W2 weekly Donchian 20/10;
- W3 relative strength top/bottom tenth (25-week return, skipping the last week);
- W4 weekly candle at the 30-week line;
- W5 NIFTY near-month futures trend.

Each runs long and short. W1-W4 are judged on GM excess; W5 on net.

**Result: 0 PASS.**
- PROMISING: W1S stage-4 short (t 3.89, then 0.31) and W3S RS bottom short (2.66, then 0.78).
- Expiry months up: 43-60% for every member, i.e. a coin flip for a one-month goal.
- Raw GM rupees at 20u, 2020-2026: longs positive (W1L +Rs 4.3 lakh, W3L +3.4 lakh), shorts negative (W1S -9.4 lakh).
  That is market direction. These totals take EVERY signal (dozens of stocks at once).

**Mechanics learned:**
- The NIFTY near-month future comes from the IDX rows of the F&O files for the whole of 2005-2026.
- Futures got their own pre-open auction from 8 Dec 2025 (NSE circular 4 Nov 2025, via Business Standard). So a
  Monday-gap rule cannot be timed from daily files; it was dropped before data.

**How to apply:** don't re-run these as new. See [[k2-chart-lab-2026-10-29]] and [[gm-global-manual-only]].
