"""Kronos forecasts for the forward paper watch (studies/kronos-forward-2026-10-16/PREREGISTRATION.txt).

  python scripts/kronos-forecast.py <inputs.jsonl> <preds.csv>

inputs.jsonl: one line per stock, sorted by symbol: {"d", "sym", "t", "ty", "o", "h", "l", "c", "v"} (scripts/kronos-forward.js).
Writes sym,pred with pred = Kronos's predicted close of the 5th future bar / close(d) - 1.
Model, settings and seeds exactly as registered. K2_KRONOS_REPO = the Kronos code (pinned commit).
"""
import json, os, sys
import numpy as np

H, CTX, BATCH = 5, 512, 32
SMALL, SMALL_REV = "NeoQuasar/Kronos-small", "901c26c1332695a2a8f243eb2f37243a37bea320"
TOK, TOK_REV = "NeoQuasar/Kronos-Tokenizer-base", "0e0117387f39004a9016484a186a908917e22426"


def batches(rows):
    """Names sorted by symbol, grouped by series length (shortest group first), batches of up to 32 in that order."""
    groups = {}
    for r in sorted(rows, key=lambda r: r["sym"]):
        groups.setdefault(len(r["c"]), []).append(r)
    out = []
    for n in sorted(groups):
        g = groups[n]
        out += [g[i:i + BATCH] for i in range(0, len(g), BATCH)]
    return out


def seed_for(d, b):
    return (int(d.replace("-", "")) * 100 + b) % (2 ** 31)


def main(inp, out):
    import pandas as pd, torch
    sys.path.insert(0, os.environ.get("K2_KRONOS_REPO", "Kronos"))
    from model import Kronos, KronosTokenizer, KronosPredictor
    with open(inp, encoding="utf8") as f:
        rows = [json.loads(x) for x in f if x.strip()]
    tok = KronosTokenizer.from_pretrained(TOK, revision=TOK_REV)
    mod = Kronos.from_pretrained(SMALL, revision=SMALL_REV)
    pr = KronosPredictor(mod, tok, device="cpu", max_context=CTX)
    preds = {}
    for b, batch in enumerate(batches(rows)):
        s = seed_for(batch[0]["d"], b); torch.manual_seed(s); np.random.seed(s)
        dfs, xs, ys = [], [], []
        for r in batch:
            df = pd.DataFrame({"open": r["o"], "high": r["h"], "low": r["l"], "close": r["c"], "volume": r["v"]})
            df["amount"] = df["close"] * df["volume"]
            dfs.append(df); xs.append(pd.Series(pd.to_datetime(r["t"]))); ys.append(pd.Series(pd.to_datetime(r["ty"])))
        res = pr.predict_batch(df_list=dfs, x_timestamp_list=xs, y_timestamp_list=ys, pred_len=H, T=1.0, top_p=0.9, sample_count=1, verbose=False)
        for j, r in enumerate(batch):
            preds[r["sym"]] = float(res[j]["close"].iloc[H - 1] / r["c"][-1] - 1)
    with open(out, "w", encoding="utf8") as f:
        f.write("sym,pred\n")
        for sym in sorted(preds):
            f.write(f"{sym},{preds[sym]:.6f}\n")
    print(f"kronos: {len(preds)} forecasts -> {out}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
