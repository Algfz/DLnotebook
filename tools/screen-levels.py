#!/usr/bin/env python
"""官方关卡"几何型"筛选: 每关抽样若干帧, 用 MoGe-2 常驻模型算几何/配色指标, 排名.

  python tools/screen-levels.py --frames 8 --out out/tmp/screen

产出:
  out/tmp/screen/metrics.jsonl      每帧一行 (可增量续跑)
  out/tmp/screen/levels.json        每关聚合 (按 score 降序)
  out/tmp/screen/sheets/<关卡>.jpg  接触表: 原图|深度|法线 三列 × 抽样帧
"""
import argparse
import json
import math
import os
import statistics as st
import sys
import time

import numpy as np
import cv2

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import refscene as rs      # noqa: E402
import refserve as rv      # noqa: E402

DEFAULT_ROOT = r"C:\DLnotebook-media\ref_official2"


def list_levels(root):
    out = []
    for name in sorted(os.listdir(root)):
        d = os.path.join(root, name)
        if os.path.isdir(d):
            out.append((name, d))
    return out


def sample_frames(level_dir, k, margin=3):
    g = sorted([f for f in os.listdir(level_dir) if f.lower().startswith("g") and f.lower().endswith(".jpg")])
    if not g:
        return []
    if len(g) <= 2 * margin + k:
        idx = list(range(len(g)))
    else:
        lo, hi = margin, len(g) - 1 - margin
        step = (hi - lo) / float(k - 1) if k > 1 else 0
        idx = sorted({int(round(lo + i * step)) for i in range(k)})
    return [os.path.join(level_dir, g[i]) for i in idx]


def sheet_row(tag, fr, img, m, width=320):
    h, w = img.shape[:2]
    hh = int(round(h * width / float(w)))
    tiles = [cv2.resize(img, (width, hh), interpolation=cv2.INTER_AREA),
             cv2.resize(rs.colormap(fr["depth"], fr["mask"]), (width, hh), interpolation=cv2.INTER_AREA)]
    nor = rs.normals_to_rgb(fr["normal"], fr["mask"]) if fr["normal"] is not None else np.zeros_like(img)
    tiles.append(cv2.resize(nor, (width, hh), interpolation=cv2.INTER_AREA))
    row = np.hstack(tiles)
    bar = np.full((22, row.shape[1], 3), 255, np.uint8)
    lab = "%s sc=%.3f cov=%.2f ax=%.2f az=%.2f n=%d fov=%.0f" % (
        tag, m.get("score") or 0.0, m["plane_cov"], m["axis_score"], m["az_conc"],
        m["n_planes"], m["fov_x"] or 0.0)
    cv2.putText(bar, lab, (6, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (0, 0, 0), 1, cv2.LINE_AA)
    return np.vstack([bar, row])


def agg(vals):
    vals = [v for v in vals if v is not None]
    if not vals:
        return None, None
    return round(float(st.median(vals)), 4), round(float(np.percentile(vals, 25)), 4)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=DEFAULT_ROOT)
    ap.add_argument("--levels", default="all", help="all 或逗号分隔的关卡名")
    ap.add_argument("--frames", type=int, default=8)
    ap.add_argument("--out", default=os.path.join("out", "tmp", "screen"))
    ap.add_argument("--ckpt", default=rv.DEFAULT_CKPT)
    ap.add_argument("--max-side", type=int, default=1024)
    ap.add_argument("--num-tokens", type=int, default=2200)
    ap.add_argument("--no-sheet", action="store_true")
    ap.add_argument("--redo", action="store_true", help="忽略既有结果重算")
    args = ap.parse_args()

    out = os.path.abspath(args.out)
    sheets = os.path.join(out, "sheets")
    os.makedirs(sheets, exist_ok=True)
    metrics_path = os.path.join(out, "metrics.jsonl")
    levels_path = os.path.join(out, "levels.json")

    done = {}
    if os.path.exists(levels_path) and not args.redo:
        with open(levels_path, "r", encoding="utf-8") as f:
            for r in json.load(f):
                done[r["level"]] = r
        rs.log("[screen] resume: %d levels already done" % len(done))

    todo = list_levels(args.root)
    if args.levels != "all":
        want = {s.strip() for s in args.levels.split(",") if s.strip()}
        todo = [(n, d) for n, d in todo if n in want]
    rs.log("[screen] %d levels to consider; %d to run" % (len(todo), sum(1 for n, _ in todo if n not in done)))

    model, device = rv.load_model(args.ckpt)
    t_all = time.time()
    for name, d in todo:
        if name in done:
            continue
        imgs = sample_frames(d, args.frames)
        if not imgs:
            continue
        rows, recs = [], []
        for p in imgs:
            tag = "%s-%s" % (name, os.path.splitext(os.path.basename(p))[0])
            img = rs.load_image(p, args.max_side, None)
            fr = rv.infer_frame(model, device, img, args.num_tokens)
            m = rv.frame_metrics(fr, img)
            m.update({"level": name, "tag": tag, "image": p})
            recs.append(m)
            with open(metrics_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(m, ensure_ascii=False) + "\n")
            if not args.no_sheet:
                rows.append(sheet_row(os.path.basename(p), fr, img, m))
        if not rows:
            continue
        sheet = np.vstack(rows)
        rs.imwrite_u(os.path.join(sheets, "%s.jpg" % name), sheet)
        keys = ["score", "plane_cov", "axis_score", "az_conc", "edge_dens", "color_ent", "fov_x", "depth_med"]
        rec = {"level": name, "n_frames": len(recs), "sheet": os.path.join(sheets, "%s.jpg" % name)}
        for k in keys:
            med, p25 = agg([r.get(k) for r in recs])
            rec[k + "_med"] = med
            rec[k + "_p25"] = p25
        rec["plane_cov_mean"] = round(float(np.mean([r["plane_cov"] for r in recs])), 4)
        done[name] = rec
        with open(levels_path, "w", encoding="utf-8") as f:
            json.dump(sorted(done.values(), key=lambda r: -(r.get("score_med") or 0)), f,
                      ensure_ascii=False, indent=2)
        rs.log("[screen] %-22s score=%.3f cov=%.2f ax=%.2f az=%.2f edge=%.3f ent=%.2f  (%.0fs elapsed)"
               % (name, rec["score_med"] or 0, rec["plane_cov_med"] or 0, rec["axis_score_med"] or 0,
                  rec["az_conc_med"] or 0, rec["edge_dens_med"] or 0, rec["color_ent_med"] or 0,
                  time.time() - t_all))

    rs.log("[screen] done in %.0fs -> %s" % (time.time() - t_all, levels_path))
    with open(levels_path, "r", encoding="utf-8") as f:
        allr = json.load(f)
    rs.log("\n== 排名 (score_med = 平面覆盖 × 轴对齐 × 方位集中) ==")
    for i, r in enumerate(allr):
        rs.log("%2d. %-22s score=%.3f cov=%.2f ax=%.2f az=%.2f edge=%.3f ent=%.2f base_fov=%.0f"
               % (i + 1, r["level"], r.get("score_med") or 0, r.get("plane_cov_med") or 0,
                  r.get("axis_score_med") or 0, r.get("az_conc_med") or 0,
                  r.get("edge_dens_med") or 0, r.get("color_ent_med") or 0, r.get("fov_x_med") or 0))


if __name__ == "__main__":
    main()
