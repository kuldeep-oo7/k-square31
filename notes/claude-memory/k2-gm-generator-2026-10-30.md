---
name: k2-gm-generator-2026-10-30
description: The GM strategy generator (930 weekly chart rules re-picked each January from the past only) was PROMISING 2008-2020 but not confirmed 2020-2026; shown live on FUTURES as WATCH ONLY from 30 Oct at the owner's request
metadata:
  type: project
---

**The ask (owner, 29-30 Oct 2026):** "why don't you generate on your own new strategies", then "it should be live before I
reach the office and show me the stocks".

**The study:** studies/gm-generator-2026-10-29 on branch claude/gm-generator-2026-10-29.
- Prereg 0a053cf5... (22:11 IST) and amendment A1 db41da48... (22:23 IST), both before data.
- A1 replaced the within-stock shift null, which keeps each stock's mean, with a within-week permutation. It also took the
  DSR spread from the 930 searched rules; with 2 members the old spread made a PASS impossible.
- One run: Actions 40916027827.

**Result: 0 PASS.**
- 2008-2020: G-LONG t 4.74, G-SHORT t 3.25, both PROMISING (DSR 0.06 / 0.02).
- 2020-2026: t -0.33 and 0.90, so NOT confirmed.
- The rule it picked first every year is the futures basis: long the lowest premium to the share, short the highest. Its
  training t peaked at 9.3 in 2020 and has fallen every year since.

**Live (30 Oct):**
- live.js applies the current year's rules (from result.json) to the latest COMPLETE week (a Friday close).
- It writes docs/paper-rules/gm-generator.json, and the page shows a WATCH ONLY box on FUTURES.
- January 2027 needs a re-run to pick the 2027 rules; until then the box shows no rules for 2027.

**How to apply:** never present it as proven. See [[k2-gm-weekly-lab-2026-10-29]] and [[k2-chart-lab-2026-10-29]].
