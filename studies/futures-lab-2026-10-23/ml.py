"""The futures lab's U5-U7: the 09:15 lab's three learning machines unchanged (label = FUTURES EXCESS > 0, from the table).

    python ml.py DIR      reads DIR/{real,null,planted}.csv, writes DIR/pred-{real,null,planted}.csv

Each year Y from 2008: fit on every trade entering before 1 Jan Y (discovery rows before 2020-10-01, confirmation rows from
2020-10-01, so no trade twice), predict year Y's rows; TAKE when the predicted probability of EXCESS > 0 is above the median
predicted probability on that year's training rows. Output: id, p1, take1, p2, take2, p3, take3 (runner only).
"""
import csv
import math
import sys

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.neural_network import MLPClassifier

FEATS = ["R", "OI", "GAP", "NGAP", "NRET", "VOLR", "TREND", "VOL20", "BASIS", "NSIG", "DOW", "TOEXP", "LOGP", "LOGV", "OIREL", "PREV", "R2"]
SPLIT = "2020-10-01"


def load(path):
    ids, period, date, X, y = [], [], [], [], []
    with open(path, newline="") as f:
        for r in csv.DictReader(f):
            ids.append(r["id"]); period.append(r["period"]); date.append(r["date"])
            X.append([float(r[k]) if r[k] != "" else math.nan for k in FEATS]); y.append(1 if float(r["excess"]) > 0 else 0)
    return ids, np.array(period), np.array(date), np.array(X, dtype=float), np.array(y)


def models():
    return [HistGradientBoostingClassifier(max_iter=200, learning_rate=0.05, max_leaf_nodes=15, min_samples_leaf=200,
                                           l2_regularization=1.0, early_stopping=False, random_state=0),
            LogisticRegression(C=1.0, max_iter=2000),
            MLPClassifier(hidden_layer_sizes=(32, 16), alpha=1e-3, learning_rate_init=1e-3, max_iter=200,
                          early_stopping=True, validation_fraction=0.1, random_state=0)]


def walk(path, out):
    ids, period, date, X, y = load(path)
    year = np.array([int(d[:4]) for d in date])
    ok = ((period == "D") & (date < SPLIT)) | ((period == "C") & (date >= SPLIT))
    rows = {}
    for Y in range(2008, int(year.max()) + 1):
        tr = ok & (date < f"{Y}-01-01"); te = year == Y
        if te.sum() == 0 or tr.sum() < 500 or len(set(y[tr])) < 2:
            continue
        med = np.nanmedian(X[tr], axis=0); med = np.where(np.isnan(med), 0.0, med)
        fill = lambda A: np.where(np.isnan(A), med, A)
        mu = fill(X[tr]).mean(axis=0); sd = fill(X[tr]).std(axis=0); sd[sd == 0] = 1.0
        std = lambda A: (fill(A) - mu) / sd
        res = []
        for k, m in enumerate(models()):
            Xtr, Xte = (X[tr], X[te]) if k == 0 else (std(X[tr]), std(X[te]))
            m.fit(Xtr, y[tr])
            thr = float(np.median(m.predict_proba(Xtr)[:, 1])); p = m.predict_proba(Xte)[:, 1]
            res.append((p, p > thr))
        for j, i in enumerate(np.where(te)[0]):
            rows[ids[i]] = [f"{res[0][0][j]:.6f}", int(res[0][1][j]), f"{res[1][0][j]:.6f}", int(res[1][1][j]), f"{res[2][0][j]:.6f}", int(res[2][1][j])]
        print(f"{path.split('/')[-1]} {Y}: trained on {int(tr.sum())}, predicted {int(te.sum())}", flush=True)
    with open(out, "w", newline="") as f:
        w = csv.writer(f); w.writerow(["id", "p1", "take1", "p2", "take2", "p3", "take3"])
        for i in ids:
            if i in rows:
                w.writerow([i] + rows[i])


if __name__ == "__main__":
    d = sys.argv[1].rstrip("/")
    for name in (sys.argv[2:] or ["planted", "null", "real"]):
        walk(f"{d}/{name}.csv", f"{d}/pred-{name}.csv")
