#!/usr/bin/env python
"""官方关卡"道具关系"测量 (单位 = 路宽 W):
  逐帧: MoGe-2 点云 -> 路面掩膜(k-means 细长簇) -> 路宽 W -> 其它色簇连通域 = 道具
  每个道具: 3D 尺寸(沿 右/前/上 三个方向, 以自身底面为基准) / 离路中心横向偏移 / 前方距离 / 离地高
产出: out/tmp/props/<tag>-props.jsonl, <tag>-overlay-*.png, <tag>-summary.json
"""
import argparse
import glob
import json
import os
import sys

import numpy as np
import cv2

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import refscene as rs  # noqa: E402
import refserve as rv  # noqa: E402
import reffield as rf  # noqa: E402


def road_width_longest_run(fr, rm, rows=np.arange(0.62, 0.995, 0.02), min_px=6):
    """路宽: 逐行取最长连通段 (路面常被道具/暗线切成小段, 取最长段最稳)."""
    H, W = fr["H"], fr["W"]
    pts = fr["points"]
    fx = fr["fx"]
    est = []
    for rr in rows:
        y = min(int(round(H * float(rr))), H - 1)
        idx = np.flatnonzero(rm[y])
        if len(idx) < min_px:
            continue
        best = (0, 0, 0)
        for run in np.split(idx, np.flatnonzero(np.diff(idx) > 2) + 1):
            if len(run) > best[0]:
                best = (len(run), run[0], run[-1])
        if best[0] < min_px:
            continue
        seg = pts[y, best[1]:best[2] + 1]
        z = np.linalg.norm(seg, axis=1)
        m = np.isfinite(z) & (z > 1e-6)
        if m.sum() < min_px:
            continue
        est.append(float(np.median(z[m])) * best[0] / fx)
    est = [e for e in est if np.isfinite(e) and e > 0]
    if not est:
        return float("nan"), 0
    return float(np.median(est)), len(est)


def props_in_frame(fr, img, min_px=150, road_tol=34.0, k=6, max_props=40, obst_h=0.05, fill_min=0.30):
    H, W = fr["H"], fr["W"]
    P = fr["points"].reshape(-1, 3)
    valid = fr["mask"].reshape(-1)
    n, agree = rf.ground_up(P, fr["normal"], fr["mask"], H)
    if n is None:
        return None
    rmk, rcol, rscore = rf.road_mask_kmeans(img, k=k, tol=road_tol)
    rmk = rmk & fr["mask"]
    # 注: 试过"更宽容差并集"扩路面掩膜, 会把大片地面/道具吞进路面 -> 弃用, 只用紧掩膜
    # (路宽绝对值因此偏小, 统一改用下方"通道开口 open_m"作为单位)
    if rmk.sum() < 200:
        return None
    Wroad, nrows = road_width_longest_run(fr, rmk)
    if not np.isfinite(Wroad) or Wroad <= 1e-6:
        return None
    hmask = rmk.reshape(-1)
    d = float(np.median(P[hmask] @ n))
    # 地面系基: f=相机 z 的水平投影, r=右
    zax = np.array([0.0, 0.0, 1.0])
    f = zax - (zax @ n) * n
    f /= max(np.linalg.norm(f), 1e-9)
    r = np.cross(f, n)
    r /= max(np.linalg.norm(r), 1e-9)
    q = P - d * n
    U = (q @ r) / Wroad
    V = (q @ f) / Wroad
    Hh = (q @ n) / Wroad
    Um, Vm, Hm = (q @ r), (q @ f), (q @ n)        # 米
    # 道具检测 = **几何优先**: 高出"局部地面"的点 (阴影/地面色块高度≈0, 自动排除)
    # 早期版本用"色簇 != 地面色/路面色"的连通域当道具, 在这个美术风格下会把**阴影**当成道具
    # (道具本身与地面同色系、且投影很重), 尺寸被合并成 9W×8W 的巨块 -> 作废。
    hgt = np.where(valid.reshape(H, W), Hm.reshape(H, W).astype(np.float32), np.nan)
    med = np.nan_to_num(hgt, nan=0.0)
    cnt = valid.reshape(H, W).astype(np.float32)
    kk = 41                                            # ~1.5 个路面宽的窗口
    sm_h = cv2.boxFilter(med, -1, (kk, kk), normalize=True, borderType=cv2.BORDER_REPLICATE)
    sm_c = cv2.boxFilter(cnt, -1, (kk, kk), normalize=True, borderType=cv2.BORDER_REPLICATE)
    ground_h = sm_h / np.maximum(sm_c, 1e-6)           # 局部地面(含残留倾斜)
    hrel = hgt - ground_h
    fin = np.isfinite(hrel)
    mad = float(np.median(np.abs(hrel[fin] - np.median(hrel[fin])))) if fin.any() else 0.0
    thr = max(obst_h, 3.0 * mad)
    m = ((hrel > thr) & valid.reshape(H, W)).astype(np.uint8)
    # MoGe 在深度跳变处会生成"把前景与背景连起来的薄墙"(1~2px 厚、很长) -> 形态学开运算杀掉薄结构,
    # 再用"填充率"过滤: 薄墙 area/bbox 很小, 真道具是实心的.
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    road_center_u = float(np.median(U[hmask]))          # 路面中心(世界横向)
    props = []
    flat = 0
    vis = img.copy()
    vis[rmk] = (0.55 * vis[rmk] + 0.45 * np.array([255, 0, 0])).astype(np.uint8)
    vis[m > 0] = (0.45 * vis[m > 0] + 0.55 * np.array([80, 220, 80])).astype(np.uint8)

    def measure(idx, knd, bbox):
        hh = Hh[idx]
        base = float(np.percentile(hh, 3))
        hm = Hm[idx]
        ku, kv = U[idx], V[idx]
        um = Um[idx]
        vm = Vm[idx]
        return {"kind": knd, "px": int(len(idx)),
                "u": float(np.median(ku)), "v": float(np.median(kv)),
                "u0": float(np.percentile(ku, 3)), "u1": float(np.percentile(ku, 97)),
                "v0": float(np.percentile(kv, 3)), "v1": float(np.percentile(kv, 97)),
                "u_span": float(np.percentile(ku, 97) - np.percentile(ku, 3)),
                "v_span": float(np.percentile(kv, 97) - np.percentile(kv, 3)),
                "h": float(np.percentile(hh - base, 97)),
                "u_m": float(np.median(um)), "v_m": float(np.median(vm)),
                "u0_m": float(np.percentile(um, 3)), "u1_m": float(np.percentile(um, 97)),
                "u_span_m": float(np.percentile(um, 97) - np.percentile(um, 3)),
                "v_span_m": float(np.percentile(vm, 97) - np.percentile(vm, 3)),
                "h_m": float(np.percentile(hm - np.percentile(hm, 3), 97)),
                "idx": idx, "bbox": [int(v) for v in bbox]}

    raw = []
    nlab, lbl, stats, cent = cv2.connectedComponentsWithStats(m, 8)
    for li in range(1, nlab):
        area = int(stats[li, 4])
        if area < min_px:
            continue
        bw, bh = int(stats[li, 2]), int(stats[li, 3])
        if area / max(1.0, float(bw * bh)) < fill_min:      # 薄墙/边缘锯齿: 填充率低
            continue
        idx = np.flatnonzero((lbl == li).reshape(-1))
        rec = measure(idx, "solid", stats[li][:4])
        if not all(np.isfinite([rec["u"], rec["v"], rec["u_span"], rec["v_span"], rec["h"]])):
            continue
        if rec["h_m"] < 0.04:                     # 高度≈0 -> 噪声/地面残差, 不是道具
            flat += 1
            continue
        raw.append(rec)
    # 世界空间合并: 同一物件常被切成多块(受光面/背光面/阴影分开的色簇)
    raw.sort(key=lambda p: -p["px"])
    merged = []
    for p in raw:
        hit = None
        for q in merged:
            ox = min(p["u1_m"], q["u1_m"]) - max(p["u0_m"], q["u0_m"])
            oy = min(p["v1"], q["v1"]) - max(p["v0"], q["v0"])
            if ox > -0.25 and oy > -0.25:
                hit = q
                break
        if hit is None:
            merged.append(p)
            continue
        idx = np.union1d(hit["idx"], p["idx"])
        b0, b1 = hit["bbox"], p["bbox"]
        bb = [min(b0[0], b1[0]), min(b0[1], b1[1]), 0, 0]
        bb[2] = max(b0[0] + b0[2], b1[0] + b1[2]) - bb[0]
        bb[3] = max(b0[1] + b0[3], b1[1] + b1[3]) - bb[1]
        nm = measure(idx, hit["kind"], bb)
        nm["parts"] = hit.get("parts", 1) + 1
        merged[merged.index(hit)] = nm
    # 通道开口(米): 同一帧内右侧道具左内缘 - 左侧道具右内缘  (道具内侧贴路 -> 即"可走宽度")
    lefts = [p for p in merged if p["u_m"] <= -0.02]
    rights = [p for p in merged if p["u_m"] >= 0.02]
    open_m = float("nan")
    if len(lefts) >= 1 and len(rights) >= 1:
        open_m = float(min(p["u0_m"] for p in rights) - max(p["u1_m"] for p in lefts))
    unit = open_m if np.isfinite(open_m) and open_m > 0.02 else Wroad
    for rec in sorted(merged, key=lambda p: p["v"]):
        x, y, w0, h0 = rec["bbox"]
        cv2.rectangle(vis, (x, y), (x + w0, y + h0), (0, 200, 0), 2)
        cv2.putText(vis, "%.1fx%.1fx%.1fW" % (rec["u_span_m"] / unit, rec["v_span_m"] / unit, rec["h_m"] / unit),
                    (x, max(y - 4, 10)), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (0, 90, 0), 1)
        cv2.putText(vis, "u%+.1fW" % (rec["u_m"] / unit), (x, min(y + h0 + 12, H - 4)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.42, (0, 90, 0), 1)
        rec.pop("idx", None)
        rec["u"] = rec["u_m"] / unit
        rec["v"] = rec["v_m"] / unit
        rec["u_span"] = rec["u_span_m"] / unit
        rec["v_span"] = rec["v_span_m"] / unit
        rec["h"] = rec["h_m"] / unit
        props.append(rec)
    props.sort(key=lambda p: p["v"])
    return {"W_m": Wroad, "open_m": open_m, "unit_m": unit, "rows": nrows,
            "up": n.tolist(), "up_agree": agree,
            "road_px": int(rmk.sum()), "road_center_u": road_center_u,
            "props": props[:max_props], "n_props": len(props), "flat": flat, "vis": vis}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--tag", required=True)
    ap.add_argument("--out", default=os.path.join("out", "tmp", "props"))
    ap.add_argument("--stride", type=int, default=5)
    ap.add_argument("--max-frames", type=int, default=40)
    ap.add_argument("--num-tokens", type=int, default=3600)
    ap.add_argument("--save-overlays", type=int, default=6)
    ap.add_argument("--ckpt", default=rs.DEFAULT_CKPT)
    args = ap.parse_args()

    out = os.path.abspath(args.out)
    os.makedirs(out, exist_ok=True)
    files = sorted(glob.glob(os.path.join(args.dir, "*.jpg")))[:: args.stride][: args.max_frames]
    model, device = rv.load_model(args.ckpt)
    rows, saved = [], 0
    for k, fp in enumerate(files):
        img = rs.imread_u(fp)
        if img is None:
            continue
        fr = rv.infer_frame(model, device, img, num_tokens=args.num_tokens)
        r = props_in_frame(fr, img)
        if r is None:
            rs.log("[props] %s: 失败(路面/地面不足)" % os.path.basename(fp))
            continue
        vis = r.pop("vis")
        r["frame"] = os.path.basename(fp)
        r["i"] = k
        rows.append(r)
        if saved < args.save_overlays:
            fn = "%s-overlay-%s.png" % (args.tag, os.path.splitext(os.path.basename(fp))[0])
            rs.imwrite_u(os.path.join(out, fn), vis)
            r["overlay"] = fn
            saved += 1
        rs.log("[props] %-12s W=%.3f 道具 %2d 路面 %5d px" % (os.path.basename(fp), r["W_m"], r["n_props"], r["road_px"]))
    with open(os.path.join(out, "%s-props.jsonl" % args.tag), "w", encoding="utf-8") as fh:
        for r in rows:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")
    # 汇总: 以 W 为单位的分布
    allp = [p for r in rows for p in r["props"]]
    summ = {"frames": len(rows), "props": len(allp)}
    if allp:
        for key in ("u_span", "v_span", "h", "px"):
            v = np.array([p[key] for p in allp], dtype=float)
            summ[key] = {q: float(np.percentile(v, q)) for q in (5, 25, 50, 75, 95)}
        au = np.array([abs(p["u"]) for p in allp], dtype=float)
        summ["abs_u"] = {q: float(np.percentile(au, q)) for q in (5, 25, 50, 75, 95)}
        # 沿路间距: 同帧内相邻道具的 |Δv| (只取同侧)
        gaps = []
        for r in rows:
            ps = sorted(r["props"], key=lambda p: p["v"])
            for a, b in zip(ps, ps[1:]):
                if a["u"] * b["u"] > 0:
                    gaps.append(abs(b["v"] - a["v"]))
        if gaps:
            g = np.array(gaps, dtype=float)
            summ["gap_v"] = {q: float(np.percentile(g, q)) for q in (5, 25, 50, 75, 95)}
        Wm = np.array([r["W_m"] for r in rows], dtype=float)
        summ["W_m"] = {"p25": float(np.percentile(Wm, 25)), "p50": float(np.median(Wm)),
                       "p75": float(np.percentile(Wm, 75))}
    with open(os.path.join(out, "%s-summary.json" % args.tag), "w", encoding="utf-8") as fh:
        json.dump(summ, fh, ensure_ascii=False, indent=2)
    rs.log("[props] 汇总: " + json.dumps(summ, ensure_ascii=False)[:1200])
    rs.log("[props] done -> %s" % out)


if __name__ == "__main__":
    main()
