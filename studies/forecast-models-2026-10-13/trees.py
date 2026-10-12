"""Member M5 of ./PREREGISTRATION.txt: gradient-boosted trees on price/volume features (Gu, Kelly & Xiu, RFS 2020, in spirit),
walk-forward: for each rebalance i >= the start, train ONLY on rows whose rebalance index is <= i - 10 (their 5-session target
ended before the session before i), then predict the rows at i.
  python trees.py <fm-data>/features.csv <start YYYY-MM-DD> <out.csv>
"""
import csv, sys
import numpy as np
from sklearn.ensemble import HistGradientBoostingRegressor

FEATURES = ["r1", "r5", "r20", "r60", "vol20", "range20", "volratio", "dist52"]
src, start, out = sys.argv[1], sys.argv[2], sys.argv[3]
rows = list(csv.DictReader(open(src, encoding="utf8")))
I = np.array([int(r["i"]) for r in rows]); E = [r["e"] for r in rows]; SYM = [r["sym"] for r in rows]
X = np.array([[float(r[f]) for f in FEATURES] for r in rows]); Y = np.array([float(r["target"]) if r["target"] != "" else np.nan for r in rows])
targets = sorted({I[k] for k in range(len(rows)) if E[k] >= start})
with open(out, "w", encoding="utf8") as f:
    f.write("e,sym,pred\n")
    for i in targets:
        tr = (I <= i - 10) & np.isfinite(Y)
        m = HistGradientBoostingRegressor(max_iter=200, learning_rate=0.05, max_leaf_nodes=15, min_samples_leaf=50, random_state=0).fit(X[tr], Y[tr])
        te = np.where(I == i)[0]
        for k, p in zip(te, m.predict(X[te])):
            f.write(f"{E[k]},{SYM[k]},{p:.6f}\n")
print(f"trees: {len(targets)} rebalances -> {out}")
