"""reffuse.py — 多帧稠密点云融合：官方关卡 -> 可飞的 3D 场景

思路（不依赖 VGGT 的稀疏大场景）：
  1. 每帧 MoGe-2 出**稠密**点云（相机系，单位≈米）+ 地面平面 (n,d) + 水平轴 (r,f)；
  2. 帧间运动用 LK 光流 + estimateAffinePartial2D 在**地面系**上拟合 ->
     点的位移 t_a=(横,前) 与旋转 yaw；相机的位移 ≈ -t_a、偏航 ≈ -yaw（符号可配，用顶视图自检）；
  3. 链式累积出窗口内相机轨迹 (X_k, Y_k, Ψ_k)；
  4. 每帧点云 -> 地面系 (u,v,h) -> 世界系 (X+cosΨ·u-sinΨ·v, Y+sinΨ·u+cosΨ·v, h)；
  5. 体素降采样 -> <tag>-fused.ply + 顶视图（点云 + 轨迹）+ <tag>-traj.json。

用法：
  $env:PYTHONPATH="C:\\D\\DLnotebook\\tools"; python tools\\reffuse.py \
     --dir C:\\DLnotebook-media\\tmp\\seq\\desert-a --tag desert-a \
     --step 2 --max-frames 30 --fps 10 \
     --cache C:\\DLnotebook-media\\tmp\\fuse\\cache --out C:\\DLnotebook-media\\tmp\\fuse
自检：顶视图里相机轨迹应当**沿着路走**；符号选错会看到轨迹原地打转/反向。
"""
import argparse
import json
import math
import os
import sys
import time

import numpy as np
import cv2

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import refscene as rs          # noqa: E402
import refserve as rv          # noqa: E402
import refmotion as rm         # noqa: E402


def log(*a):
    print(*a, flush=True)


def load_bgr(path):
    b = np.fromfile(path, dtype=np.uint8)
    return cv2.imdecode(b, cv2.IMREAD_COLOR)


def frame_cache(args, fr, img, path, cf):
    """跑一次 MoGe 并把"够用"的东西落盘（后续换符号 / 换阈值都不用重跑）。"""
    H, W = img.shape[:2]
    gf = rm.ground_frame(fr)
    if gf is None:
        return None
    P = fr["points"]
    step = args.px_step
    sub = (slice(None, None, step), slice(None, None, step))
    pts = P[sub].reshape(-1, 3).astype(np.float32)
    pts_full = pts
    mask = fr["mask"][sub].reshape(-1)
    keep = mask & np.isfinite(pts).all(1)
    pts = pts[keep]
    rgb = img[sub].reshape(-1, 3)[keep][:, ::-1].astype(np.uint8)   # BGR -> RGB
    n, d, r, f = gf["n"], gf["d"], gf["r"], gf["f"]
    q = pts - d * n
    uv = np.stack([q @ r, q @ f], 1).astype(np.float32)
    h = (pts @ n - d).astype(np.float32)
    # 光流查表用的**栅格**版 uv（保持行列下标 = 像素//step，无效处 NaN）
    qf = pts_full - d * n
    uvf = np.full((H // step * (W // step), 2), np.nan, np.float32)
    mf = fr["mask"][sub].reshape(-1) & np.isfinite(pts_full).all(1)
    if mf.any():
        uvf[mf, 0] = qf[mf] @ r
        uvf[mf, 1] = qf[mf] @ f
    np.savez_compressed(cf, uv=uv, h=h, rgb=rgb, uvf=uvf, n=n, d=d, r=r, f=f,
                        fx=fr["fx"], fy=fr["fy"], H=H, W=W,
                        fname=os.path.basename(path) if path else (fr.get("fname") or ""))
    return cf


def voxel_down(P, C, v):
    # 注意：np.unique(..., axis=0) 在千万级点上是分钟~十分钟级（实测 44 分钟 CPU 没跑完），
    # 必须把三个体素坐标打包成一个 int64 标量再 unique（21 bit/轴，±100 万格，够用）。
    k = np.floor(P / v).astype(np.int64) + (1 << 20)
    key = (k[:, 0] << 42) | (k[:, 1] << 21) | k[:, 2]
    _, idx = np.unique(key, return_index=True)
    return P[idx], C[idx]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--tag", required=True)
    ap.add_argument("--step", type=int, default=2, help="每隔几帧取一帧")
    ap.add_argument("--max-frames", type=int, default=30)
    ap.add_argument("--fps", type=float, default=10.0, help="抽帧时的 fps（算 dt 用）")
    ap.add_argument("--px-step", type=int, default=2, help="点云像素抽稀")
    ap.add_argument("--cache", default=None)
    ap.add_argument("--out", required=True)
    ap.add_argument("--ckpt", default=rs.DEFAULT_CKPT if hasattr(rs, "DEFAULT_CKPT") else None)
    ap.add_argument("--num-tokens", type=int, default=2200)
    ap.add_argument("--voxel", type=float, default=0.03)
    ap.add_argument("--max-radius", type=float, default=4.0, help="融合时只保留相机周围这么多单位内的点（0=全留）")
    ap.add_argument("--start", type=int, default=0, help="从第几帧开始（配合 --max-frames 取一段窗口）")
    ap.add_argument("--max-h", type=float, default=3.0, help="只保留离地面这么高的点（滤掉天空/远平面）")
    ap.add_argument("--sign-t", type=float, default=-1.0, help="相机位移 = sign_t * 点位移")
    ap.add_argument("--sign-yaw", type=float, default=-1.0, help="相机偏航 = sign_yaw * 点旋转")
    ap.add_argument("--max-pts", type=int, default=900000)
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    cache = args.cache or os.path.join(args.out, "cache")
    os.makedirs(cache, exist_ok=True)

    files = sorted(f for f in os.listdir(args.dir) if f.lower().endswith((".jpg", ".png")))
    files = files[::args.step]
    if args.start:
        files = files[args.start:]
    if args.max_frames:
        files = files[:args.max_frames]
    log("[fuse] %d 帧 (step=%d)  %s" % (len(files), args.step, args.dir))

    model = device = None
    cfs, frames = [], []
    for i, name in enumerate(files):
        path = os.path.join(args.dir, name)
        cf = os.path.join(cache, "%s-%s.npz" % (args.tag, name.rsplit(".", 1)[0]))
        img = load_bgr(path)
        if os.path.exists(cf):
            pass
        else:
            if model is None:
                model, device = rv.load_model(args.ckpt, None)
            t0 = time.time()
            fr = rv.infer_frame(model, device, img, args.num_tokens)
            fr["_img"] = img
            frame_cache(args, fr, img, path, cf)
            log("  [%2d/%d] %s  MoGe %.1fs" % (i + 1, len(files), name, time.time() - t0))
        z = np.load(cf, allow_pickle=False)
        # 一次性物化：NpzFile 是惰性的，循环里下标访问会每点重解压整段（实测卡死）
        cfs.append({"uv": z["uv"], "h": z["h"], "rgb": z["rgb"], "uvf": z["uvf"],
                    "n": z["n"], "d": float(z["d"]), "r": z["r"], "f": z["f"],
                    "fx": float(z["fx"]), "fy": float(z["fy"]),
                    "H": int(z["H"]), "W": int(z["W"])})
        frames.append({"file": name, "img": img})

    # 地面系 (u,v,h) + 每帧的地面参数
    gf = [{"n": z["n"], "d": float(z["d"]), "r": z["r"], "f": z["f"]} for z in cfs]

    # ---- 链式累积轨迹 ----
    dt = 1.0 / args.fps * args.step
    X, Y, PSI = [0.0], [0.0], [0.0]
    pairs = []
    for k in range(len(cfs) - 1):
        fa = {"_img": frames[k]["img"], "H": int(cfs[k]["H"]), "W": int(cfs[k]["W"]),
              "points": None, "fx": float(cfs[k]["fx"]), "fy": float(cfs[k]["fy"])}
        fb = {"_img": frames[k + 1]["img"], "H": int(cfs[k + 1]["H"]), "W": int(cfs[k + 1]["W"]),
              "points": None, "fx": float(cfs[k + 1]["fx"]), "fy": float(cfs[k + 1]["fy"])}
        # ground_uv 需要 points 栅格：用缓存里的 uv 无法反查，直接就地用 MoGe 重新算一遍太贵 ->
        # 这里改用一个轻量代理：把像素点投到地面用的是一次性计算的 P/uv，故直接在缓存里查表。
        pr = _pair_motion_cached(cfs[k], cfs[k + 1], frames[k]["img"], frames[k + 1]["img"])
        if pr is None:
            log("  [链] %d->%d 光流不足，跳过" % (k, k + 1))
            continue
        t_ax, t_ay, yaw, npts, ninl = pr
        # 相机在当前帧地面系里的位移
        dx = args.sign_t * t_ax
        dy = args.sign_t * t_ay
        psi = PSI[-1]
        X.append(X[-1] + math.cos(psi) * dx - math.sin(psi) * dy)
        Y.append(Y[-1] + math.sin(psi) * dx + math.cos(psi) * dy)
        PSI.append(psi + math.radians(args.sign_yaw * yaw))
        pairs.append({"i": k, "fa": frames[k]["file"], "fb": frames[k + 1]["file"],
                      "d_m": float(math.hypot(dx, dy)), "yaw_applied_deg": args.sign_yaw * yaw,
                      "yaw_meas_deg": yaw, "n_pts": npts, "inl": ninl,
                      "t_ax": t_ax, "t_ay": t_ay})
    while len(X) < len(cfs):                     # 光流不足时保持位置
        X.append(X[-1]); Y.append(Y[-1]); PSI.append(PSI[-1])
    path_len = float(np.sum(np.hypot(np.diff(X), np.diff(Y))))
    log("[fuse] 轨迹 %d 点  长度 %.2f m  (dt=%.2fs, 平均 %.2f m/s)"
        % (len(X), path_len, dt, path_len / max(1e-9, dt * (len(X) - 1))))

    # ---- 融合 ----
    # 每帧的稠密点云里有一大片"远处地面/天空"的楔形（相机只有 2~3 单位高，地面能望到 10+ 单位），
    # 直接拼起来顶视图全是扇骨 ⇒ 默认只保留相机周围 --max-radius 单位内的点（车道及其邻居）。
    Ps, Cs = [], []
    for k, z in enumerate(cfs):
        uv, h, rgb = z["uv"], z["h"], z["rgb"]
        r2 = uv[:, 0] ** 2 + uv[:, 1] ** 2
        R = args.max_radius if args.max_radius > 0 else float("inf")
        keep = (r2 <= R * R) & (np.abs(h) <= args.max_h)
        uv, h, rgb = uv[keep], h[keep], rgb[keep]
        c, s = math.cos(PSI[k]), math.sin(PSI[k])
        x = X[k] + c * uv[:, 0] - s * uv[:, 1]
        y = Y[k] + s * uv[:, 0] + c * uv[:, 1]
        Ps.append(np.stack([x, y, h], 1).astype(np.float32))
        Cs.append(rgb)
    P = np.concatenate(Ps); C = np.concatenate(Cs)
    log("[fuse] 原始 %d 点" % len(P))
    P, C = voxel_down(P, C, args.voxel)
    if len(P) > args.max_pts:
        sel = np.random.RandomState(0).choice(len(P), args.max_pts, replace=False)
        P, C = P[sel], C[sel]
    log("[fuse] 体素降采样(%.3fm) 后 %d 点" % (args.voxel, len(P)))

    ply = os.path.join(args.out, "%s-fused.ply" % args.tag)
    rs.write_ply(ply, P, C)
    log("[fuse] 点云 ->", ply)

    traj = {"tag": args.tag, "frames": len(cfs), "step": args.step, "fps": args.fps, "dt": dt,
            "sign_t": args.sign_t, "sign_yaw": args.sign_yaw,
            "path_len_m": path_len, "speed_mps": path_len / max(1e-9, dt * max(1, len(X) - 1)),
            "X": X, "Y": Y, "psi_deg": [math.degrees(p) for p in PSI],
            "pairs": pairs}
    with open(os.path.join(args.out, "%s-traj.json" % args.tag), "w", encoding="utf-8") as fh:
        json.dump(traj, fh, ensure_ascii=False, indent=1)

    # ---- 顶视图 ----
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(figsize=(8, 8), dpi=110)
    hh = P[:, 2]
    ax.scatter(P[:, 0], P[:, 1], c=np.clip(hh, -0.1, 3.0), s=0.4, cmap="turbo", linewidths=0)
    ax.plot(X, Y, "-o", color="red", ms=3, lw=1.4, label="camera path")
    ax.set_aspect("equal"); ax.legend(loc="upper right", fontsize=8)
    ax.set_title("%s  fused cloud (%.2f m path, sign_t=%g sign_yaw=%g)" % (args.tag, path_len, args.sign_t, args.sign_yaw))
    fig.tight_layout(); fig.savefig(os.path.join(args.out, "%s-top.png" % args.tag))
    log("[fuse] 顶视图 ->", os.path.join(args.out, "%s-top.png" % args.tag))


def _pair_motion_cached(za, zb, ia, ib, y0f=0.45):
    """与 refmotion 同法，但地形点用缓存 uv 在像素上查表（不重跑 MoGe）。"""
    H = ia.shape[0]
    y0 = int(H * y0f)
    g1 = cv2.cvtColor(ia[y0:], cv2.COLOR_BGR2GRAY)
    g2 = cv2.cvtColor(ib[y0:], cv2.COLOR_BGR2GRAY)
    p1 = cv2.goodFeaturesToTrack(g1, maxCorners=400, qualityLevel=0.01, minDistance=8, blockSize=7)
    if p1 is None or len(p1) < 12:
        return None
    p2, st, _ = cv2.calcOpticalFlowPyrLK(g1, g2, p1, None, winSize=(21, 21), maxLevel=3)
    if p2 is None:
        return None
    ok = st.reshape(-1).astype(bool)
    a = (p1.reshape(-1, 2)[ok] + np.array([0.0, y0]))
    b = (p2.reshape(-1, 2)[ok] + np.array([0.0, y0]))
    step = 2                                    # 与 --px-step 一致（缓存时的抽稀）
    W = ia.shape[1]
    uva, uvb, keep = [], [], []
    Ha, Wa = int(za["H"]), int(za["W"])
    Hb, Wb = int(zb["H"]), int(zb["W"])
    for (x1, y1), (x2, y2) in zip(a, b):
        xi1, yi1 = int(round(x1)), int(round(y1))
        xi2, yi2 = int(round(x2)), int(round(y2))
        # 最近栅格（不要求整除：误差 ≤ step/2 像素）
        i1 = (yi1 // step) * (Wa // step) + (xi1 // step)
        i2 = (yi2 // step) * (Wb // step) + (xi2 // step)
        if xi1 < 0 or yi1 < 0 or xi2 < 0 or yi2 < 0:
            continue
        if i1 < 0 or i1 >= len(za["uvf"]) or i2 < 0 or i2 >= len(zb["uvf"]):
            continue
        uva.append(za["uvf"][i1]); uvb.append(zb["uvf"][i2])
    if len(uva) < 12:
        return None
    uva = np.asarray(uva, dtype=np.float32).reshape(-1, 2)
    uvb = np.asarray(uvb, dtype=np.float32).reshape(-1, 2)
    good = np.isfinite(uva).all(1) & np.isfinite(uvb).all(1)
    if good.sum() < 12:
        return None
    M, inl = cv2.estimateAffinePartial2D(uva[good], uvb[good], method=cv2.RANSAC,
                                         ransacReprojThreshold=0.05, maxIters=5000)
    if M is None:
        return None
    t = M[:, 2]
    ang = math.degrees(math.atan2(M[1, 0], M[0, 0]))
    return float(t[0]), float(t[1]), float(ang), int(good.sum()), int(inl.sum() if inl is not None else 0)


if __name__ == "__main__":
    main()
