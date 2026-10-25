---
name: k2-expiry-legs-2026-10-25
description: "25 Oct 2026 -- call side vs put side of the expiry-selling PASS (X2): NO DIFFERENCE FOUND (t -1.48, low power); call +15.0 vs put +2.6 points an expiry follows NIFTY's direction; SEBI FY26: option sellers lose less often but bigger; TRACK shows the split + each leg"
metadata:
  node_type: memory
  type: project
  originSessionId: 5861e620-95f9-4ff4-94a8-989cf5f71ca8
  modified: 2026-10-25T16:39:33.422Z
---

- Owner asked 25 Oct 2026: "options selling ... call put both are same or not?" Answered with a pre-registered split of X2
  (branch claude/expiry-legs-2026-10-25; prereg 8a6be362 committed 4834c2d BEFORE data; result e5263ec). The split first
  reproduced the study exactly (402 sessions, 351 expiries, C2 + P2 = X2 each expiry, +17.59 points, t 4.43).
- MAIN D2 = put leg - call leg: -0.045% of NIFTY an expiry, t -1.48 -> NO DIFFERENCE FOUND. Never say "same": in the
  synthetic calibration a put sold 20% rich at the open was found on only 1 seed of 3 (D2 carries NIFTY's whole move).
- Legs (information only): call +15.0 pts (stopped 31%, worst -148), put +2.6 (stopped 42%, worst -287 on 2026-02-03).
  NIFTY settled below its open on 194 of 351 expiries. Up days: call -27.3, put +47.6, X2 +20.3; down days: call +49.3,
  put -33.9, X2 +15.4. Put-call parity: one strike's call minus put = minus NIFTY's move, so one side alone = a direction
  bet. From 2 Sep 2025 (Tuesday expiry): call +35.1, put -3.0.
- Synthetic lesson: a plant that scales an option's open AND high leaves a 2x stop on the same paths (barely moves the
  result; the original study's X2 plant t 0.02 had the same cause). Plant a rich OPEN with the rest of the day fair.
- SEBI FY26 behavioural study (20 Aug 2026; PDF on sebi.gov.in resets this laptop's connections, so read via Zerodha's
  tradingqna post and The Policy Edge): ~93% only option buyers, ~2% mostly sellers; ~90% of buyers vs ~44% of major sellers
  lost; losing major sellers averaged ~Rs 51.7 lakh loss (bigger accounts); sample 5,050, indicative. Profitability study:
  87.7% of individuals lost in FY26, Rs 91,685 crore, options 92% of losses.
- Page (72017a4): TRACK expiry box shows the split line, each leg's live result, "CE x / PE y" per finished expiry, worst
  expiry priced at NIFTY's last close (d.direction.close), and "about Rs 2.6 lakh a lot on expiry day (Zerodha, 25 Oct)".

**How to apply:** if the owner asks to sell one side only, the answer is: not tested as a rule; it adds a NIFTY bet, and
every NIFTY direction rule failed. See [[k2-expiry-selling-2026-10-21]] and [[k2-expiry-live-2026-10-25]].
