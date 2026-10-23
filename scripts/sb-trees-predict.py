"""The trees paper test's daily TAKE/SKIP (studies/sb-trees-forward-2026-10-23).

    python scripts/sb-trees-predict.py MODEL.pkl WORK     reads WORK/x.csv, writes WORK/take.csv (runner only)

The model file must match the sha256 recorded in studies/sb-trees-forward-2026-10-23/FIT.txt, or nothing is written.
TAKE when the predicted probability is above the recorded threshold. Python 3.12, scikit-learn 1.9.1, numpy 2.5.4.
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
    fit = open(os.path.join(os.path.dirname(__file__), "..", "studies", "sb-trees-forward-2026-10-23", "FIT.txt"), encoding="utf8").read()
    want = re.search(r"sha256 ([0-9a-f]{64})", fit).group(1)
    if hashlib.sha256(blob).hexdigest() != want:
        sys.exit("the model file does not match FIT.txt: nothing written")
    obj = pickle.loads(blob)
    model, thr, feats = obj["model"], obj["threshold"], obj["features"]
    ids, X = [], []
    with open(os.path.join(work, "x.csv"), newline="") as f:
        for r in csv.DictReader(f):
            ids.append(r["id"]); X.append([float(r[k]) if r[k] != "" else math.nan for k in feats])
    with open(os.path.join(work, "take.csv"), "w", newline="") as f:
        f.write("id,take\n")
        if X:
            p = model.predict_proba(np.array(X, dtype=float))[:, 1]
            for i, v in zip(ids, p):
                f.write(f"{i},{1 if v > thr else 0}\n")
    print(f"sb-trees: {len(ids)} decisions, threshold {thr:.4f}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
