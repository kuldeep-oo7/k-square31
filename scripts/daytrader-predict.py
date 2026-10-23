"""The AI day-trader paper test's daily probabilities (studies/daytrader-forward-2026-10-26).

    python scripts/daytrader-predict.py MODEL.pkl WORK     reads WORK/x.csv, writes WORK/p.csv (runner only)

The model file must match the sha256 recorded in studies/daytrader-forward-2026-10-26/FIT.txt, or nothing is written.
Python 3.12, scikit-learn 1.9.1, numpy 2.5.4.
"""
import csv
import hashlib
import math
import os
import pickle
import re
import sys

import numpy as np


def main(model_path, work):
    blob = open(model_path, "rb").read()
    fit = open(os.path.join(os.path.dirname(__file__), "..", "studies", "daytrader-forward-2026-10-26", "FIT.txt"), encoding="utf8").read()
    want = re.search(r"sha256 ([0-9a-f]{64})", fit).group(1)
    if hashlib.sha256(blob).hexdigest() != want:
        sys.exit("the model file does not match FIT.txt: nothing written")
    obj = pickle.loads(blob)
    model, feats = obj["model"], obj["features"]
    ids, X = [], []
    with open(os.path.join(work, "x.csv"), newline="") as f:
        for r in csv.DictReader(f):
            ids.append(r["id"]); X.append([float(r[k]) if r[k] != "" else math.nan for k in feats])
    with open(os.path.join(work, "p.csv"), "w", newline="") as f:
        f.write("id,p\n")
        if X:
            p = model.predict_proba(np.array(X, dtype=float))[:, 1]
            for i, v in zip(ids, p):
                f.write(f"{i},{v:.6f}\n")
    print(f"daytrader: {len(ids)} probabilities")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
