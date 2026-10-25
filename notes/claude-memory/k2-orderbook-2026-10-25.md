---
name: k2-orderbook-2026-10-25
description: "25 Oct 2026 -- order book (demand vs supply) tested on the desk's own 20-min Angel best-5 recordings: total buy/sell qty predicts nothing; visible book leans right but ~1/6 of the cost; verdict re-run at 60 sessions (~31 Dec 2026)"
metadata:
  node_type: memory
  type: project
  originSessionId: 5861e620-95f9-4ff4-94a8-989cf5f71ca8
  modified: 2026-10-25T17:09:54.256Z
---

- Owner (25 Oct 2026): "it's all about demand and supply ... order flow ... make a perfect strategy ... we have all the
  data from the Angel One API". Tested on orderflow-rec (private k2-data release; one line per desk build, ~19 a day,
  207 near-month stock futures, best 5 bids/asks in UNITS (whole lots), total buy/sell qty). Branch
  claude/orderbook-2026-10-25: prereg 877af02e (fab6235, before any outcome), interim result cb7a2ce.
- Interim (15 sessions 5-23 Oct, 292 snapshots, ~11,000 trades a member; long top tenth / short bottom tenth; fills walk
  the recorded book; 0.104% charges = shadow-broker at Rs 1 lakh): S1 total buy/sell qty gross -0.004% (next 15-30 min)
  and +0.011% (to close), IC slightly NEGATIVE -> nothing. S2 5-level depth / S3 top of book: rank IC +0.016..+0.034
  (t 3.9-5.1), best gross +0.033% a trade (S3 to close) vs cost 0.19-0.21% a trade -> every member net -0.16..-0.20%,
  won 24-38%. Words: S2H1, S3H2 TOO SMALL TO TRADE; rest FAIL. Shuffled null hit gross t 2.86 once (15 sessions is thin).
- Literature checked (2 sources each): Cont, Kukanov & Stoikov 2014 (J. Fin. Econometrics 12(1)): order-flow imbalance
  explains price changes over short intervals; Gould & Bonart 2016: queue imbalance predicts the NEXT mid move (one tick).
- THE VERDICT: one re-run, code unchanged, `--first 60` (~31 Dec 2026). No look before then. Don't build a tick recorder
  for a hand trader: faster effects are for machines at the exchange; Angel TOTP reset (owner's to-do) comes first.

**How to apply:** when the owner says "use the order flow / buyers vs sellers", quote this: the totals predict nothing,
the book's lean is real but worth less than the spread. See [[k2-microstructure-data-limits]].
