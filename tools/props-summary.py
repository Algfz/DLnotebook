#!/usr/bin/env python
"""把 refprops 的逐帧结果统一到"本窗口通道开口中位数"这个单位上, 并写 NaN 安全的 jsonl + 汇总。

用法: python tools/props-summary.py --dir C:\\DLnotebook-media\\tmp\\props --tags desert-a,desert-b,desert-c
"""
import argparse
import glob
import json
import math
import os
import sys

import numpy as np

KEYS = ("u", "v", "u_span", "v_span", "h")


def clean(o):
    """NaN/Inf -> None (浏览器 JSON.parse 不认 NaN)."""
    if isinstance(o, dict):
        return {k: clean(v) for k, v in o.items()}
    if isinstance(o, list):
        return [clean(v) for v in o]
    if isinstance(o, float) and not math.isfinite(o):
        return None
    return o


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=os.path.join("out", "tmp", "props"))
    ap.add_argument("--tags", default="desert-a,desert-b,desert-c")
    args = ap.parse_args()
    d = os.path.abspath(args.dir)
    index = {}
    for tag in [t.strip() for t in args.tags.split(",") if t.strip()]:
        fp = os.path.join(d, tag + "-props.jsonl")
        if not os.path.exists(fp):
            print("缺", fp)
            continue
        rows = [json.loads(l) for l in open(fp, encoding="utf-8") if l.strip()]
        ow = [r["open_m"] for r in rows
              if isinstance(r.get("open_m"), (int, float)) and math.isfinite(r["open_m"]) and r["open_m"] > 0.02]
        ww = [r["W_m"] for r in rows if math.isfinite(r.get("W_m", float("nan")))]
        unit = float(np.median(ow)) if len(ow) >= 5 else float(np.median(ww)) if ww else 1.0
        src = "open_m" if len(ow) >= 5 else "W_m(掩膜,偏小)"
        for r in rows:
            r["unit_m"] = unit
            r["unit_src"] = src
            for p in r.get("props", []):
                for k in KEYS:
                    mv = p.get(k + "_m")
                    if isinstance(mv, (int, float)):
                        p[k] = mv / unit
        allp = [p for r in rows for p in r.get("props", [])]
        summ = {"tag": tag, "frames": len(rows), "props": len(allp),
                "unit_m": unit, "unit_src": src,
                "open_frames": len(ow),
                "open_m": ({q: float(np.percentile(ow, q)) for q in (5, 25, 50, 75, 95)} if ow else None),
                "W_m": ({q: float(np.percentile(ww, q)) for q in (5, 25, 50, 75, 95)} if ww else None),
                "props_per_frame": float(len(allp) / max(1, len(rows)))}
        for k in KEYS + ("abs_u", "px"):
            v = np.array([p.get(k if k != "abs_u" else "u") for p in allp], dtype=float)
            if k == "abs_u":
                v = np.abs(v)
            v = v[np.isfinite(v)]
            if v.size:
                summ[k] = {q: float(np.percentile(v, q)) for q in (5, 25, 50, 75, 95)}
        gaps = []
        for r in rows:
            ps = sorted(r.get("props", []), key=lambda p: p["v_m"])
            for a, b in zip(ps, ps[1:]):
                if a["u_m"] * b["u_m"] > 0:
                    gaps.append(abs(b["v_m"] - a["v_m"]) / unit)
        if gaps:
            g = np.array(gaps, dtype=float)
            g = g[np.isfinite(g)]
            summ["gap_v"] = {q: float(np.percentile(g, q)) for q in (5, 25, 50, 75, 95)}
        with open(os.path.join(d, tag + "-summary.json"), "w", encoding="utf-8") as fh:
            json.dump(clean(summ), fh, ensure_ascii=False, indent=2)
        with open(os.path.join(d, tag + "-props.jsonl"), "w", encoding="utf-8") as fh:
            for r in rows:
                r.pop("unit_src", None)
                fh.write(json.dumps(clean(r), ensure_ascii=False) + "\n")
        index[tag] = {"overlays": [os.path.basename(p) for p in
                                   sorted(glob.glob(os.path.join(d, tag + "-overlay-*.png")))]}
        p50 = lambda k, q=50: (summ.get(k) or {}).get(str(q) if str(q) in (summ.get(k) or {}) else q)
        print("[sum] %-9s frames=%d props=%d unit=%.3fm(%s) 宽p50=%.2f 深p50=%.2f 高p50=%.2f |u|p50=%.2f 间距p50=%.2f" % (
            tag, summ["frames"], summ["props"], unit, src,
            (summ.get("u_span") or {}).get("50", float("nan")), (summ.get("v_span") or {}).get("50", float("nan")),
            (summ.get("h") or {}).get("50", float("nan")), (summ.get("abs_u") or {}).get("50", float("nan")),
            (summ.get("gap_v") or {}).get("50", float("nan"))))
    with open(os.path.join(d, "index.json"), "w", encoding="utf-8") as fh:
        json.dump(index, fh, ensure_ascii=False, indent=2)
    print("[sum] index ->", os.path.join(d, "index.json"))


if __name__ == "__main__":
    sys.exit(main())
