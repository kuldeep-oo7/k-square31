"""The AI day-trader lab's three learning machines (PREREGISTRATION.txt section 4), walk-forward by calendar year from 2008.

    python ml.py DIR [names...]   reads DIR/{planted,null,real}.csv, writes DIR/pred-{name}.csv: id, p_trees, p_logistic, p_net

Each year Y: fit on every row before 1 Jan Y (discovery rows before 2020-10-01, confirmation rows from 2020-10-01), predict
year Y. The neural network trains on a 25% random sample of the training rows (numpy default_rng(0)), for time.
"""
import csv
import math
import sys

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.neural_network import MLPClassifier

FEATS = ["R1", "R5", "R20", "GAP", "NGAP", "NRET", "OI1", "OI5", "VOLR", "VOL20", "BASIS", "TREND", "HL", "CLV", "DOW", "TOEXP", "LOGP", "LOGV"]
SPLIT = "2020-10-01"


def load(path):
    ids, period, date, X, y = [], [], [], [], []
    with open(path, newline="") as f:
        for r in csv.DictReader(f):
            ids.append(r["id"]); period.append(r["period"]); date.append(r["date"])
            X.append([float(r[k]) if r[k] != "" else math.nan for k in FEATS]); y.append(1 if float(r["excess"]) > 0 else 0)
    return ids, np.array(period), np.array(date), np.array(X, dtype=float), np.array(y)


def walk(path, out):
    ids, period, date, X, y = load(path)
    year = np.array([int(d[:4]) for d in date])
    ok = ((period == "D") & (date < SPLIT)) | ((period == "C") & (date >= SPLIT))
    P = np.full((len(ids), 3), np.nan)
    for Y in range(2008, int(year.max()) + 1):
        tr = ok & (date < f"{Y}-01-01"); te = year == Y
        if te.sum() == 0 or tr.sum() < 5000 or len(set(y[tr])) < 2:
            continue
        med = np.nanmedian(X[tr], axis=0); med = np.where(np.isnan(med), 0.0, med)
        fill = lambda A: np.where(np.isnan(A), med, A)
        mu = fill(X[tr]).mean(axis=0); sd = fill(X[tr]).std(axis=0); sd[sd == 0] = 1.0
        std = lambda A: (fill(A) - mu) / sd
        trees = HistGradientBoostingClassifier(max_iter=200, learning_rate=0.05, max_leaf_nodes=15, min_samples_leaf=500,
                                               l2_regularization=1.0, early_stopping=False, random_state=0).fit(X[tr], y[tr])
        P[te, 0] = trees.predict_proba(X[te])[:, 1]
        logit = LogisticRegression(C=1.0, max_iter=2000).fit(std(X[tr]), y[tr])
        P[te, 1] = logit.predict_proba(std(X[te]))[:, 1]
        idx = np.where(tr)[0]; sample = np.sort(np.random.default_rng(0).choice(idx, size=max(1, len(idx) // 4), replace=False))
        net = MLPClassifier(hidden_layer_sizes=(32, 16), alpha=1e-3, learning_rate_init=1e-3, max_iter=50, early_stopping=True,
                            validation_fraction=0.1, random_state=0).fit(std(X[sample]), y[sample])
        P[te, 2] = net.predict_proba(std(X[te]))[:, 1]
        print(f"{path.split('/')[-1]} {Y}: trained on {int(tr.sum())}, predicted {int(te.sum())}", flush=True)
    with open(out, "w", newline="") as f:
        w = csv.writer(f); w.writerow(["id", "p_trees", "p_logistic", "p_net"])
        for i, row in zip(ids, P):
            if not np.isnan(row).any():
                w.writerow([i] + [f"{v:.6f}" for v in row])


if __name__ == "__main__":
    d = sys.argv[1].rstrip("/")
    for name in (sys.argv[2:] or ["planted", "null", "real"]):
        walk(f"{d}/{name}.csv", f"{d}/pred-{name}.csv")
