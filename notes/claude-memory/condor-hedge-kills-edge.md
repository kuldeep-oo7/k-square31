# Hedging the NIFTY strangle kills its edge (5 Oct 2026)

studies/condor-2026-10-05 (pre-registered, sha256 f075f21c..., run once, protocol v2): NIFTY weekly
iron condors (2%/4% fixed; ATM-straddle range; + vol-clustering brake) all FAIL: t 1.75 / 0.15 / 0.70.
Naked 2% strangle with the same costs: t 4.57, worst week -3.22% of NIFTY. The wings cost ~70% of
the premium. Don't re-run condors or IV/RV-filtered variants as "new"; the edge is paid for
crash risk.
