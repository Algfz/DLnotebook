#!/usr/bin/env python
"""官方关卡"运动学"测量：相机在一个"地面平面"上的平移 + 偏航 (尺度以 MoGe 单位, 再除以路宽 W)。

思路
----
1. 每隔 K 帧取一帧跑 MoGe-2 -> 点云(P, MoGe 单位) + 内参 K_px；
2. 用地面法线 n 与平面距离 d（相机高）把点投到地面平面 -> (u,v) 米(MoGe 单位)；
3. 相邻采样帧之间用 LK 光流跟踪地面点 -> 同一地面点在两帧的 (u,v) -> RANSAC 拟合 2D 相似变换（只有旋转+平移，无缩放）
   => 平移向量 = 相机在地面上的移动；旋转角 = 偏航变化；
4. 速度 = |平移| / 时间间隔（MoGe 米/秒），**除以路宽 W** => 速度 (W/s)（尺度无关，MoGe 的绝对尺度误差抵消）；
   偏航率 (deg/s) 的峰值时刻 = 折点；折点间距 = 折点之间的行进距离。

产出: out/tmp/motion/<tag>-motion.jsonl（逐对）+ <tag>-motion.json（汇总分布）+ <tag>-yaw.png（偏航率/速度曲线）
用法: python tools/refmotion.py --dir <帧目录> --tag desert-a [--step 3] [--fps 10]
"""
import argparse
import glob
import json
import math
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
import refprops as rp  # noqa: E402


def ground_frame(fr):
    """返回 (n, d, r, f, K_px, W_m, valid)：地面法线/平面距离(相机高)/两个水平轴/内参/路宽."""
    H, W = fr["H"], fr["W"]
    P = fr["points"].reshape(-1, 3)
    n, agree = rf.ground_up(P, fr["normal"], fr["mask"], H)
    if n is None:
        return None
    img = fr.get("_img")
    rmk = None
    Wm = float("nan")
    if img is not None:
        m, rcol, sc = rf.road_mask_kmeans(img, k=6, tol=34.0)
        m = m & fr["mask"]
        if m.sum() >= 200:
            rmk = m
            Wm, _nr = rp.road_width_longest_run(fr, m)
    hm = fr["mask"].reshape(-1) if rmk is None else rmk.reshape(-1)
    d = float(np.median(P[hm] @ n)) if hm.sum() else float(np.median(P[fr["mask"].reshape(-1)] @ n))
    zax = np.array([0.0, 0.0, 1.0])
    f = zax - (zax @ n) * n
    f /= max(np.linalg.norm(f), 1e-9)
    r = np.cross(f, n)
    r /= max(np.linalg.norm(r), 1e-9)
    K = np.array([[fr["fx"], 0.0, fr.get("cx", W / 2.0)],
                  [0.0, fr.get("fy", fr["fx"]), fr.get("cy", H / 2.0)],
                  [0.0, 0.0, 1.0]], dtype=np.float64)
    return {"n": n, "d": d, "r": r, "f": f, "K": K, "W_m": Wm, "rmk": rmk, "agree": agree}


def ground_uv(fr, gf, pts_xy):
    """把像素点 (x,y) 投到该帧的地面平面, 返回 (u,v) [MoGe 米] 与是否贴地."""
    H, W = fr["H"], fr["W"]
    P = fr["points"]
    uv, on = [], []
    for x, y in pts_xy:
        xi, yi = int(round(x)), int(round(y))
        if xi < 0 or yi < 0 or xi >= W or yi >= H:
            uv.append((np.nan, np.nan)); on.append(False); continue
        p = P[yi, xi]
        if not np.isfinite(p).all():
            uv.append((np.nan, np.nan)); on.append(False); continue
        q = p - gf["d"] * gf["n"]
        uv.append((float(q @ gf["r"]), float(q @ gf["f"])))
        on.append(abs(float(p @ gf["n"]) - gf["d"]) < 0.20)
    return np.array(uv, dtype=np.float64), np.array(on, dtype=bool)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--tag", required=True)
    ap.add_argument("--out", default=os.path.join("out", "tmp", "motion"))
    ap.add_argument("--step", type=int, default=3)
    ap.add_argument("--fps", type=float, default=10.0)
    ap.add_argument("--max-pairs", type=int, default=60)
    ap.add_argument("--num-tokens", type=int, default=3600)
    ap.add_argument("--ckpt", default=rs.DEFAULT_CKPT)
    args = ap.parse_args()
    out = os.path.abspath(args.out)
    os.makedirs(out, exist_ok=True)
    files = sorted(glob.glob(os.path.join(args.dir, "*.jpg")))
    if len(files) < args.step + 1:
        print("帧太少"); return 1
    model, device = rv.load_model(args.ckpt)
    dt = args.step / args.fps
    rows = []
    A = None
    for i in range(0, len(files) - args.step, args.step):
        fa, fb = files[i], files[i + args.step]
        ia, ib = rs.imread_u(fa), rs.imread_u(fb)
        if ia is None or ib is None:
            continue
        fra = rv.infer_frame(model, device, ia, num_tokens=args.num_tokens)
        frb = rv.infer_frame(model, device, ib, num_tokens=args.num_tokens)
        fra["_img"], frb["_img"] = ia, ib
        ga, gb = ground_frame(fra), ground_frame(frb)
        if ga is None or gb is None:
            continue
        H, W = fra["H"], fra["W"]
        y0 = int(0.45 * H)
        g1 = cv2.cvtColor(ia[y0:], cv2.COLOR_BGR2GRAY)
        g2 = cv2.cvtColor(ib[y0:], cv2.COLOR_BGR2GRAY)
        p1 = cv2.goodFeaturesToTrack(g1, maxCorners=400, qualityLevel=0.01, minDistance=8, blockSize=7)
        if p1 is None or len(p1) < 12:
            continue
        p2, st, err = cv2.calcOpticalFlowPyrLK(g1, g2, p1, None, winSize=(21, 21), maxLevel=3)
        if p2 is None:
            continue
        ok = st.reshape(-1).astype(bool)
        a = p1.reshape(-1, 2)[ok] + np.array([0.0, y0])
        b = p2.reshape(-1, 2)[ok] + np.array([0.0, y0])
        uva, ona = ground_uv(fra, ga, a)
        uvb, onb = ground_uv(frb, gb, b)
        m = ona & onb & np.isfinite(uva).all(1) & np.isfinite(uvb).all(1)
        if m.sum() < 12:
            continue
        M, inl = cv2.estimateAffinePartial2D(uva[m].astype(np.float32), uvb[m].astype(np.float32),
                                            method=cv2.RANSAC, ransacReprojThreshold=0.05, maxIters=5000)
        if M is None:
            continue
        t = M[:, 2]
        ang = math.degrees(math.atan2(M[1, 0], M[0, 0]))
        dist = float(np.hypot(t[0], t[1]))
        Wm = ga["W_m"] if np.isfinite(ga["W_m"]) else gb["W_m"]
        rows.append({"i": i, "fa": os.path.basename(fa), "fb": os.path.basename(fb),
                     "n_pts": int(m.sum()), "inl": int(inl.sum()) if inl is not None else 0,
                     "d_m": dist, "yaw_deg": ang, "dt": dt,
                     "speed_Ws": (dist / dt / Wm) if np.isfinite(Wm) and Wm > 1e-6 else None,
                     "yaw_dps": ang / dt,
                     "W_m": Wm, "cam_h": ga["d"], "up_agree": ga["agree"],
                     "t_ax": float(t[0]), "t_ay": float(t[1])})
        if len(rows) >= args.max_pairs:
            break
    # 汇总
    sp = np.array([r["speed_Ws"] for r in rows if r["speed_Ws"]], dtype=float)
    yw = np.array([r["yaw_dps"] for r in rows], dtype=float)
    dm = np.array([r["d_m"] for r in rows], dtype=float)
    Wm = np.array([r["W_m"] for r in rows if np.isfinite(r["W_m"])], dtype=float)
    summ = {"tag": args.tag, "pairs": len(rows), "step": args.step, "dt": dt,
            "speed_Ws": {q: float(np.percentile(sp, q)) for q in (5, 25, 50, 75, 95)} if sp.size else None,
            "yaw_dps": {q: float(np.percentile(yw, q)) for q in (5, 25, 50, 75, 95)} if yw.size else None,
            "yaw_abs_p95": float(np.percentile(np.abs(yw), 95)) if yw.size else None,
            "d_m": {q: float(np.percentile(dm, q)) for q in (5, 25, 50, 75, 95)} if dm.size else None,
            "W_m": {q: float(np.percentile(Wm, q)) for q in (5, 25, 50, 75, 95)} if Wm.size else None}
    # 折点: |yaw_dps| 的峰, 间距 = 峰间累计行进距离
    spikes, leg = [], 0.0
    thr = max(4.0, 2.5 * float(np.median(np.abs(yw)))) if yw.size else 6.0
    for r in rows:
        leg += r["d_m"]
        if abs(r["yaw_dps"]) > thr:
            spikes.append({**r, "leg_m": leg})
            leg = 0.0
    if spikes:
        lg = np.array([s["leg_m"] for s in spikes], dtype=float)
        summ["turn_thr_dps"] = thr
        summ["turns"] = len(spikes)
        summ["leg_m"] = {q: float(np.percentile(lg, q)) for q in (5, 25, 50, 75, 95)}
        if np.isfinite(Wm).any() and summ["W_m"]:
            w50 = summ["W_m"][50]
            summ["leg_W"] = {q: float(np.percentile(lg, q) / w50) for q in (5, 25, 50, 75, 95)}
    with open(os.path.join(out, args.tag + "-motion.jsonl"), "w", encoding="utf-8") as fh:
        for r in rows:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")
    with open(os.path.join(out, args.tag + "-motion.json"), "w", encoding="utf-8") as fh:
        json.dump(summ, fh, ensure_ascii=False, indent=2)
    print("[motion] " + json.dumps(summ, ensure_ascii=False)[:900])
    # 曲线图
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        fig, ax = plt.subplots(2, 1, figsize=(11, 6), sharex=True)
        xs = [r["i"] / args.fps for r in rows]
        ax[0].plot(xs, [r["speed_Ws"] or np.nan for r in rows], "o-", ms=3, color="#2f7d32")
        ax[0].set_ylabel("speed (W/s)"); ax[0].grid(alpha=.3)
        ax[0].set_title("%s  speed & yaw rate (step=%d, dt=%.2fs)" % (args.tag, args.step, dt))
        ax[1].plot(xs, [r["yaw_dps"] for r in rows], "o-", ms=3, color="#b3541e")
        ax[1].axhline(thr, ls="--", lw=.8, color="#888"); ax[1].axhline(-thr, ls="--", lw=.8, color="#888")
        ax[1].set_ylabel("yaw rate (deg/s)"); ax[1].set_xlabel("time (s)")
        ax[1].grid(alpha=.3)
        fig.tight_layout()
        fig.savefig(os.path.join(out, args.tag + "-yaw.png"), dpi=110)
        plt.close(fig)
        print("[motion] 曲线 ->", os.path.join(out, args.tag + "-yaw.png"))
    except Exception as e:  # noqa: BLE001
        print("[motion] 画图失败:", e)
    return 0


if __name__ == "__main__":
    sys.exit(main())
