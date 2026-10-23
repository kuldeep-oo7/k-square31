"""The one fit of the AI day-trader's trees model for the forward paper test (./PREREGISTRATION.txt).

    python fit.py DIR      reads DIR/real.csv (the day-trader lab's run.js --features), writes DIR/daytrader-model.pkl and
                           DIR/fit.json (summary only: rows, sha256, library versions)

HistGradientBoostingClassifier on every row of the lab's tables (discovery rows before 2020-10-01, confirmation rows from
2020-10-01 to 2026-10-01), label FUTURES EXCESS > 0. The model file stays private (it is derived from market data).
"""
import csv
import hashlib
import json
import math
import pickle
import sys

import numpy as np
import sklearn
from sklearn.ensemble import HistGradientBoostingClassifier

FEATS = ["R1", "R5", "R20", "GAP", "NGAP", "NRET", "OI1", "OI5", "VOLR", "VOL20", "BASIS", "TREND", "HL", "CLV", "DOW", "TOEXP", "LOGP", "LOGV"]
SPLIT, END = "2020-10-01", "2026-10-01"


def main(d):
    X, y, first, last = [], [], None, None
    with open(f"{d}/real.csv", newline="") as f:
        for r in csv.DictReader(f):
            if not ((r["period"] == "D" and r["date"] < SPLIT) or (r["period"] == "C" and SPLIT <= r["date"] <= END)):
                continue
            X.append([float(r[k]) if r[k] != "" else math.nan for k in FEATS]); y.append(1 if float(r["excess"]) > 0 else 0)
            first = r["date"] if first is None or r["date"] < first else first; last = r["date"] if last is None or r["date"] > last else last
    X, y = np.array(X, dtype=float), np.array(y)
    model = HistGradientBoostingClassifier(max_iter=200, learning_rate=0.05, max_leaf_nodes=15, min_samples_leaf=500,
                                           l2_regularization=1.0, early_stopping=False, random_state=0).fit(X, y)
    blob = pickle.dumps({"model": model, "features": FEATS}, protocol=4)
    with open(f"{d}/daytrader-model.pkl", "wb") as f:
        f.write(blob)
    out = {"rows": int(len(y)), "positives": int(y.sum()), "first": first, "last": last, "sha256": hashlib.sha256(blob).hexdigest(),
           "sklearn": sklearn.__version__, "numpy": np.__version__, "python": sys.version.split()[0]}
    with open(f"{d}/fit.json", "w") as f:
        json.dump(out, f)
    print(json.dumps(out))


if __name__ == "__main__":
    main(sys.argv[1].rstrip("/"))
