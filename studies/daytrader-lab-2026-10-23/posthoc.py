"""DESCRIPTIVE, AFTER THE RESULT (23 Oct 2026): the trees model retrained WITHOUT the two opening-gap inputs (GAP, NGAP),
same settings and walk-forward as ml.py, to see whether the day-trader's edge needs the open. Not a test.

    python posthoc.py DIR      reads DIR/real.csv, writes DIR/pred-nogap.csv (id, p) -- runner only
"""
import csv
import math
import sys

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier

FEATS = ["R1", "R5", "R20", "NRET", "OI1", "OI5", "VOLR", "VOL20", "BASIS", "TREND", "HL", "CLV", "DOW", "TOEXP", "LOGP", "LOGV"]
SPLIT = "2020-10-01"


def main(d):
    ids, period, date, X, y = [], [], [], [], []
    with open(f"{d}/real.csv", newline="") as f:
        for r in csv.DictReader(f):
            ids.append(r["id"]); period.append(r["period"]); date.append(r["date"])
            X.append([float(r[k]) if r[k] != "" else math.nan for k in FEATS]); y.append(1 if float(r["excess"]) > 0 else 0)
    period, date, X, y = np.array(period), np.array(date), np.array(X, dtype=float), np.array(y)
    year = np.array([int(x[:4]) for x in date]); ok = ((period == "D") & (date < SPLIT)) | ((period == "C") & (date >= SPLIT))
    P = np.full(len(ids), np.nan)
    for Y in range(2008, int(year.max()) + 1):
        tr = ok & (date < f"{Y}-01-01"); te = year == Y
        if te.sum() == 0 or tr.sum() < 5000:
            continue
        m = HistGradientBoostingClassifier(max_iter=200, learning_rate=0.05, max_leaf_nodes=15, min_samples_leaf=500,
                                           l2_regularization=1.0, early_stopping=False, random_state=0).fit(X[tr], y[tr])
        P[te] = m.predict_proba(X[te])[:, 1]
        print(f"no-gap trees {Y}: trained on {int(tr.sum())}", flush=True)
    with open(f"{d}/pred-nogap.csv", "w", newline="") as f:
        w = csv.writer(f); w.writerow(["id", "p"])
        for i, v in zip(ids, P):
            if not np.isnan(v):
                w.writerow([i, f"{v:.6f}"])


if __name__ == "__main__":
    main(sys.argv[1].rstrip("/"))
