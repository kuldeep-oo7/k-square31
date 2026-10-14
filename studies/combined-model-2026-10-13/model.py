"""Section 5 of ./PREREGISTRATION.txt: walk-forward trees (T) and ridge (R) on the feature panel (features.js).

  python model.py <panel.csv> <preds.csv>                predictions, appended block by block (resumable)
  python model.py <panel.csv> <preds.csv> --importance   + permutation importance of the last trees model

Rebalance feature dates: every 5th session from the first on or after 2022-10-03. Retrained every 4th rebalance; a block
trains on every row with a finite label whose feature index j <= i_first - 5 (its exit is before the block's first entry).
"""
import os, sys
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor

START, EVERY, BLOCK, PURGE, ALPHA = "2022-10-03", 5, 4, 5, 10.0
STOCK = ["P%d" % k for k in range(1, 24)] + ["D1", "D2", "F1", "F2", "F3", "F4", "O1", "O2", "X1", "L1", "L2", "L3", "W1", "W2", "M1", "M2", "I1", "I2", "I3"]
MARKET = ["K%d" % k for k in range(1, 15)]
FEAT = STOCK + MARKET


def trees():
    return HistGradientBoostingRegressor(max_iter=200, learning_rate=0.05, max_leaf_nodes=15, min_samples_leaf=200, l2_regularization=1.0, random_state=0)


def fit_trees(X, y):
    # sklearn 1.9 HistGradientBoosting fails on a column that is ALL missing in the training rows (e.g. a family whose
    # files start later). Such a column carries no information: it is set to a constant, for training and prediction.
    dead = ~np.isfinite(X).any(axis=0)
    m = trees().fit(np.where(dead, 0.0, X), y)
    return lambda Xn: m.predict(np.where(dead, 0.0, Xn)), m, dead


def ridge_fit(X, y):
    Z = np.where(np.isfinite(X), X, 0.5) - 0.5
    A = Z.T @ Z + ALPHA * np.eye(Z.shape[1]); w = np.linalg.solve(A, Z.T @ (y - y.mean()))
    return lambda Xn: (np.where(np.isfinite(Xn), Xn, 0.5) - 0.5) @ w + y.mean()


def main():
    src, out = sys.argv[1], sys.argv[2]
    p = pd.read_csv(src, dtype={"d": str, "sym": str})
    I = p["i"].to_numpy(); X = p[FEAT].to_numpy(dtype=np.float64); XS = p[STOCK].to_numpy(dtype=np.float64); Y = p["label"].to_numpy(dtype=np.float64)
    dates = p.groupby("i")["d"].first()
    first = dates[dates >= START].index.min()
    reb = [i for i in sorted(dates.index) if i >= first and (i - first) % EVERY == 0]
    blocks = [reb[k:k + BLOCK] for k in range(0, len(reb), BLOCK)]
    done = set()
    if os.path.exists(out):
        done = set(pd.read_csv(out)["i"].unique())
    else:
        with open(out, "w", encoding="utf8") as f:
            f.write("i,d,sym,T,R\n")
    for b in blocks:
        if all(i in done for i in b):
            continue
        tr = (I <= b[0] - PURGE) & np.isfinite(Y)
        tf, _, dead = fit_trees(X[tr], Y[tr]); rf = ridge_fit(XS[tr], Y[tr])
        with open(out, "a", encoding="utf8") as f:
            for i in b:
                if i in done:
                    continue
                te = np.where(I == i)[0]
                pt, pr = tf(X[te]), rf(XS[te])
                f.writelines(f"{i},{p['d'].iat[k]},{p['sym'].iat[k]},{a:.6f},{c:.6f}\n" for k, a, c in zip(te, pt, pr))
        print(f"block {b[0]}..{b[-1]} ({dates[b[0]]}): trained on {int(tr.sum())} rows" + (f"; no data yet: {', '.join(FEAT[k] for k in np.where(dead)[0])}" if dead.any() else ""), flush=True)
    if "--importance" in sys.argv:
        from sklearn.inspection import permutation_importance
        last = blocks[-1][0]; tr = np.where((I <= last - PURGE) & np.isfinite(Y))[0]   # the last block's model, refitted
        _, model, dead = fit_trees(X[tr], Y[tr])
        rng = np.random.default_rng(0); s = rng.choice(tr[-60000:], size=min(20000, len(tr)), replace=False)
        imp = permutation_importance(model, np.where(dead, 0.0, X[s]), Y[s], n_repeats=3, random_state=0)
        order = np.argsort(-imp.importances_mean)
        with open(out.replace(".csv", "-importance.txt"), "w", encoding="utf8") as f:
            for k in order:
                f.write(f"{FEAT[k]} {imp.importances_mean[k]:.6f} {imp.importances_std[k]:.6f}\n")
        print("importance top 10: " + ", ".join(f"{FEAT[k]} {imp.importances_mean[k]:.5f}" for k in order[:10]))


if __name__ == "__main__":
    main()
