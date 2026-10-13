"""Forecasts for the foundation-model study (./PREREGISTRATION.txt). Runs ONE model at a time (8 GB laptop).

  python forecast.py --model timesfm|chronos2|kronos --inputs inputs.jsonl --out forecasts-<model>.csv
  python forecast.py --model all --synthetic          (smoke test: synthetic random walks only, timing and RAM)

inputs.jsonl: one line per (date, symbol): {"d": "YYYY-MM-DD", "sym": "...", "o": [...], "h": [...], "l": [...],
"c": [...], "v": [...]} -- the last 512 daily bars up to and including d (written by prepare.js).
Output: e,sym,pred = the model's median forecast, made from bars up to d (the session before e), of the close 5 bars
ahead / close(d) - 1.
"""
import argparse, json, os, sys, time
import numpy as np

H = 5
CTX = 512


def load_inputs(path):
    with open(path, encoding="utf8") as f:
        return [json.loads(x) for x in f if x.strip()]


def synthetic(n=int(os.environ.get("K2_SYN_N", "200")), length=CTX, seed=7):
    rng = np.random.default_rng(seed)
    out = []
    for k in range(n):
        r = rng.normal(0, 0.015, length)
        c = 100 * np.exp(np.cumsum(r))
        o = c * (1 + rng.normal(0, 0.003, length))
        h = np.maximum(o, c) * 1.005
        l = np.minimum(o, c) * 0.995
        v = rng.lognormal(12, 0.3, length)
        out.append({"d": "2099-01-01", "sym": f"S{k}", "o": o.tolist(), "h": h.tolist(), "l": l.tolist(), "c": c.tolist(), "v": v.tolist()})
    return out


def run_timesfm(rows):
    import timesfm, torch
    torch.manual_seed(0)
    m = timesfm.TimesFM_2p5_200M_torch.from_pretrained("google/timesfm-2.5-200m-pytorch")
    m.compile(timesfm.ForecastConfig(max_context=CTX, max_horizon=128, normalize_inputs=True, use_continuous_quantile_head=True,
                                     force_flip_invariance=True, infer_is_positive=True, fix_quantile_crossing=True))
    preds = []
    for i in range(0, len(rows), 64):
        batch = rows[i:i + 64]
        point, quant = m.forecast(horizon=H, inputs=[np.asarray(r["c"], dtype=np.float32) for r in batch])
        med = quant[:, H - 1, 5]   # quantile head: [mean, q10..q90] -> index 5 = q50
        preds += [float(med[j] / batch[j]["c"][-1] - 1) for j in range(len(batch))]
    return preds


def run_chronos2(rows):
    import torch
    from chronos import Chronos2Pipeline
    torch.manual_seed(0)
    p = Chronos2Pipeline.from_pretrained("amazon/chronos-2", device_map="cpu")
    preds = []
    for i in range(0, len(rows), 64):
        batch = rows[i:i + 64]
        q, _ = p.predict_quantiles([np.asarray(r["c"], dtype=np.float32)[None, :] for r in batch], prediction_length=H, quantile_levels=[0.5])
        preds += [float(q[j][0, H - 1, 0] / batch[j]["c"][-1] - 1) for j in range(len(batch))]
    return preds


def run_kronos(rows):
    import pandas as pd, torch
    sys.path.insert(0, os.environ.get("K2_KRONOS_REPO", os.path.join(os.path.expanduser("~"), "k2-ml-venv", "Kronos")))
    from model import Kronos, KronosTokenizer, KronosPredictor
    torch.manual_seed(0); np.random.seed(0)
    tok = KronosTokenizer.from_pretrained("NeoQuasar/Kronos-Tokenizer-base")
    mod = Kronos.from_pretrained("NeoQuasar/Kronos-small")
    pr = KronosPredictor(mod, tok, device="cpu", max_context=CTX)
    # predict_batch needs equal-length series in one batch: group by length (a few names have < 512 bars), keep order.
    # Each finished batch is appended to K2_KRONOS_PART (if set), so a stopped run resumes where it left off.
    part = os.environ.get("K2_KRONOS_PART")
    preds = [None] * len(rows)
    if part and os.path.exists(part):
        with open(part, encoding="utf8") as f:
            for x in f:
                k, v = x.split(","); preds[int(k)] = float(v)
    groups = {}
    for k, r in enumerate(rows):
        if preds[k] is None:
            groups.setdefault(len(r["c"]), []).append(k)
    for n, ks in sorted(groups.items()):
        for i in range(0, len(ks), 32):
            idx = ks[i:i + 32]
            batch = [rows[k] for k in idx]
            dfs, xs, ys = [], [], []
            for r in batch:
                df = pd.DataFrame({"open": r["o"], "high": r["h"], "low": r["l"], "close": r["c"], "volume": r["v"]})
                df["amount"] = df["close"] * df["volume"]
                dfs.append(df)
                xs.append(pd.Series(pd.bdate_range(end="2030-01-01", periods=n)))
                ys.append(pd.Series(pd.bdate_range(start="2030-01-02", periods=H)))
            out = pr.predict_batch(df_list=dfs, x_timestamp_list=xs, y_timestamp_list=ys, pred_len=H, T=1.0, top_p=0.9, sample_count=int(os.environ.get("K2_KRONOS_SAMPLES", "1")), verbose=False)
            got = [float(out[j]["close"].iloc[H - 1] / batch[j]["c"][-1] - 1) for j in range(len(batch))]
            for k, v in zip(idx, got):
                preds[k] = v
            if part:
                with open(part, "a", encoding="utf8") as f:
                    f.writelines(f"{k},{v!r}\n" for k, v in zip(idx, got))
    return preds


RUN = {"timesfm": run_timesfm, "chronos2": run_chronos2, "kronos": run_kronos}

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--inputs")
    ap.add_argument("--out")
    ap.add_argument("--synthetic", action="store_true")
    a = ap.parse_args()
    if a.synthetic:
        rows = synthetic()
        for name in (RUN if a.model == "all" else [a.model]):
            t = time.time(); p = RUN[name](rows); dt = time.time() - t
            p = np.asarray(p)
            print(f"{name}: {len(p)} synthetic series in {dt:.1f}s ({1000 * dt / len(p):.0f} ms each); forecast 5-day mean {p.mean():+.4f}, sd {p.std():.4f}, finite {np.isfinite(p).all()}")
        sys.exit(0)
    rows = load_inputs(a.inputs)
    t = time.time(); p = RUN[a.model](rows)
    with open(a.out, "w", encoding="utf8") as f:
        f.write("e,sym,pred\n")
        for r, v in zip(rows, p):
            f.write(f"{r['e']},{r['sym']},{v:.6f}\n")
    print(f"{a.model}: {len(p)} forecasts in {time.time() - t:.0f}s -> {a.out}")
