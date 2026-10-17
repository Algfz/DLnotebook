# -*- coding: utf-8 -*-
"""A 路线：曼哈顿世界自标定 —— 从直线的灭点解出游戏相机（焦距 f、俯角 θ、滚转）。

原理（不需要任何深度、不需要知道关卡尺寸）：
  1. 三条互相垂直的世界方向各有一个灭点。竖直方向若在无穷远（图像里竖边保持竖直）⇒ 滚转=0。
  2. 地平面上的两条正交水平方向的灭点都落在地平线上 ⇒ 地平线 = 连这两个灭点的线。
  3. 两个正交方向的灭点 + 主点(取画面中心) ⇒ 焦距：f² = -(u1-cx)(u2-cx) - (v1-cy)(v2-cy)。
  4. 地平线行号 ⇒ 俯角：tanθ = (cy - y_h)/f。

用法: python tools/vp-calib.py <帧...> [--tau 0.6] [--min-len 60] [--out 目录] [--dump]
"""
import os
import sys
import json
import math
import argparse

import cv2
import numpy as np


def lines_of(img, min_len=40, max_gap=6, thresh=110, detector="lsd"):
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    g = cv2.GaussianBlur(g, (3, 3), 0)
    out = []
    segs = []
    if detector == "lsd" and hasattr(cv2, "createLineSegmentDetector"):
        lsd = cv2.createLineSegmentDetector(cv2.LSD_REFINE_STD)
        res = lsd.detect(g)[0]
        if res is not None:
            for x1, y1, x2, y2 in res[:, 0]:
                segs.append((float(x1), float(y1), float(x2), float(y2)))
    if not segs:
        e = cv2.Canny(g, 40, 130)
        ls = cv2.HoughLinesP(e, 1, np.pi / 720, threshold=thresh,
                             minLineLength=min_len, maxLineGap=max_gap)
        if ls is not None:
            for x1, y1, x2, y2 in ls[:, 0]:
                segs.append((float(x1), float(y1), float(x2), float(y2)))
    for x1, y1, x2, y2 in segs:
        dx, dy = x2 - x1, y2 - y1
        n = math.hypot(dx, dy)
        if n < min_len:
            continue
        a, b = dy / n, -dx / n
        c = -(a * x1 + b * y1)
        out.append({"a": a, "b": b, "c": c, "len": n,
                    "mid": np.array([(x1 + x2) / 2.0, (y1 + y2) / 2.0]),
                    "p1": np.array([x1, y1], float), "p2": np.array([x2, y2], float),
                    "ang": math.degrees(math.atan2(dy, dx)) % 180.0})
    return out, g


def intersect(l1, l2):
    det = l1["a"] * l2["b"] - l2["a"] * l1["b"]
    if abs(det) < 1e-9:
        return None
    x = (l1["b"] * l2["c"] - l2["b"] * l1["c"]) / det
    y = (l1["c"] * l2["a"] - l2["c"] * l1["a"]) / det
    return np.array([x, y])


def vp_resid(l, v):
    """直线的角残差（弧度）：直线方向与「直线中点 → 灭点」方向的夹角。"""
    d = v - l["mid"]
    nd = np.linalg.norm(d)
    if nd < 1e-6:
        return 0.0
    # 直线方向
    t = l["p2"] - l["p1"]
    t = t / np.linalg.norm(t)
    cosv = abs(float(np.dot(t, d / nd)))
    return math.acos(min(1.0, cosv))


def find_vps(L, tau_deg=0.5, iters=6000, min_inl=6, max_vps=4, seed=1):
    rng = np.random.default_rng(seed)
    tau = math.radians(tau_deg)
    rem = list(range(len(L)))
    vps = []
    for _ in range(max_vps):
        if len(rem) < min_inl:
            break
        best_vp, best_inl, best_w = None, [], 0.0
        for _ in range(iters):
            i, j = rng.choice(len(rem), 2, replace=False)
            l1, l2 = L[rem[i]], L[rem[j]]
            if abs(math.sin(math.radians(l1["ang"] - l2["ang"]))) < 0.12:
                continue
            v = intersect(l1, l2)
            if v is None or not np.all(np.isfinite(v)) or np.linalg.norm(v) > 5e5:
                continue
            inl = [k for k in rem if vp_resid(L[k], v) < tau]
            w = float(sum(L[k]["len"] for k in inl))
            if len(inl) >= min_inl and w > best_w:
                best_vp, best_inl, best_w = v, inl, w
        if best_vp is None:
            break
        # 用内点最小二乘精修灭点：最小化 Σ (n_k · v + c_k)²  → 线性最小二乘
        A = np.array([[L[k]["a"], L[k]["b"]] for k in best_inl])
        b = np.array([-L[k]["c"] for k in best_inl])
        v, *_ = np.linalg.lstsq(A, b, rcond=None)
        inl = [k for k in rem if vp_resid(L[k], v) < tau]
        vps.append({"vp": v, "inl": inl, "w": float(sum(L[k]["len"] for k in inl))})
        rem = [k for k in rem if k not in set(inl)]
    return vps


def calibrate_frame(img, tau_deg, min_len, dump_dir=None, name=""):
    H, W = img.shape[:2]
    cx, cy = W / 2.0, H / 2.0
    L, edge = lines_of(img, min_len=min_len)
    if len(L) < 12:
        return None
    vps = find_vps(L, tau_deg=tau_deg)
    out = {"frame": name, "W": W, "H": H, "n_lines": len(L),
           "vps": [{"vp": [float(v["vp"][0]), float(v["vp"][1])], "n_inl": len(v["inl"]),
                    "ang_med": float(np.median([L[k]["ang"] for k in v["inl"]]))} for v in vps]}
    # 竖直族：图像角度接近 90°（竖直边），且其灭点应在很远
    vert = None
    horiz = []
    for i, v in enumerate(vps):
        ang = float(np.median([L[k]["ang"] for k in v["inl"]]))
        x, y = v["vp"]
        if abs(ang - 90.0) < 12.0:
            vert = dict(v)
            vert["ang"] = ang
        else:
            horiz.append(dict(v, ang=ang))
    out["vert"] = None if vert is None else {
        "ang_med": vert["ang"], "vp": [float(vert["vp"][0]), float(vert["vp"][1])],
        "n_inl": len(vert["inl"]),
        "dist_inf": float(np.linalg.norm(vert["vp"] - np.array([cx, cy])))}
    out["horiz"] = [{"ang_med": h["ang"], "vp": [float(h["vp"][0]), float(h["vp"][1])],
                     "n_inl": len(h["inl"])} for h in horiz]
    if len(horiz) >= 2:
        v1, v2 = horiz[0]["vp"], horiz[1]["vp"]
        # 焦距（正交灭点）
        f2 = -(v1[0] - cx) * (v2[0] - cx) - (v1[1] - cy) * (v2[1] - cy)
        out["f2"] = float(f2)
        if f2 > 1e-6:
            f = math.sqrt(f2)
            # 地平线：过两灭点的直线，取其在 x=cx 处的行号
            k = (v2[1] - v1[1]) / (v2[0] - v1[0]) if abs(v2[0] - v1[0]) > 1e-9 else float("inf")
            yh = v1[1] + k * (cx - v1[0]) if np.isfinite(k) else float("nan")
            out["f"] = float(f)
            out["fov_x_deg"] = float(math.degrees(2 * math.atan(cx / f)))
            out["horizon_row"] = float(yh)
            out["horizon_slope"] = float(k) if np.isfinite(k) else None
            if np.isfinite(yh):
                out["pitch_deg"] = float(math.degrees(math.atan2(cy - yh, f)))
    if dump_dir:
        os.makedirs(dump_dir, exist_ok=True)
        vis = img.copy()
        for i, v in enumerate(vps):
            col = [(0, 0, 255), (0, 255, 0), (255, 0, 0), (0, 255, 255)][i % 4]
            for k in v["inl"]:
                p1 = tuple(np.int32(L[k]["p1"]))
                p2 = tuple(np.int32(L[k]["p2"]))
                cv2.line(vis, p1, p2, col, 2)
            x, y = v["vp"]
            if abs(x) < 3 * W and abs(y) < 3 * H:
                cv2.circle(vis, (int(x), int(y)), 6, col, -1)
        if "horizon_row" in out and np.isfinite(out["horizon_row"]):
            yh = int(out["horizon_row"])
            cv2.line(vis, (0, yh), (W - 1, yh), (255, 0, 255), 2)
        cv2.imwrite(os.path.join(dump_dir, "vp-%s.png" % name), vis)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("frames", nargs="+")
    ap.add_argument("--tau", type=float, default=0.6)
    ap.add_argument("--min-len", type=int, default=60)
    ap.add_argument("--dump", default="")
    ap.add_argument("--json", default="")
    a = ap.parse_args()
    allres = []
    for fp in a.frames:
        img = cv2.imread(fp)
        if img is None:
            print("[vp] 读不到 %s" % fp)
            continue
        nm = os.path.splitext(os.path.basename(fp))[0]
        r = calibrate_frame(img, a.tau, a.min_len, dump_dir=a.dump or None, name=nm)
        if r is None:
            print("[vp] %s: 直线太少" % nm)
            continue
        allres.append(r)
        print("\n[vp] %s  直线 %d" % (nm, r["n_lines"]))
        for i, v in enumerate(r["vps"]):
            print("   灭点%d  inl %3d  vp (%9.1f, %9.1f)  内点中位角 %6.1f°"
                  % (i, v["n_inl"], v["vp"][0], v["vp"][1], v["ang_med"]))
        if r.get("vert"):
            print("   竖直族: 中位角 %.1f°  灭点距画面中心 %.0f px  (滚转→0 时该族角度应≈90°, 灭点应≈无穷远)"
                  % (r["vert"]["ang_med"], r["vert"]["dist_inf"]))
        if "f" in r:
            print("   ⇒ f = %.1f px  fov_x = %.1f°  地平线行 %.1f（斜率 %s）  俯角 θ = %.1f°"
                  % (r["f"], r["fov_x_deg"], r["horizon_row"],
                     ("%.4f" % r["horizon_slope"]) if r["horizon_slope"] is not None else "inf",
                     r["pitch_deg"]))
        else:
            print("   ⇒ 只有 %d 个水平灭点，无法解焦距" % len(r["horiz"]))
    if a.json and allres:
        fs = [r["f"] for r in allres if "f" in r]
        ps = [r["pitch_deg"] for r in allres if "pitch_deg" in r]
        print("\n[vp] === 汇总 %d 帧 ===" % len(allres))
        if fs:
            print("   f: 中位 %.1f px（fov_x %.1f°）  散布 %.1f~%.1f"
                  % (np.median(fs), math.degrees(2 * math.atan(allres[0]["W"] / 2 / np.median(fs))),
                     min(fs), max(fs)))
            print("   俯角 θ: 中位 %.1f°  散布 %.1f~%.1f" % (np.median(ps), min(ps), max(ps)))
        with open(a.json, "w", encoding="utf-8") as fh:
            json.dump({"results": allres, "f_med": float(np.median(fs)) if fs else None,
                       "pitch_med": float(np.median(ps)) if ps else None}, fh, ensure_ascii=False)
        print("   写出 %s" % a.json)


if __name__ == "__main__":
    main()
