#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""world-stitch.py —— 用 DA3 逐窗结果拼出"世界模型"（v2）。

数据实况（实测，见 probe 结论）：
  · 每个窗是**独立归一化**的：尺度不同、位姿 gauge 不同、相机在窗内位移很小（0.1~1.3）。
  · 共享帧（相邻窗重叠 8 帧）的**朝向**一致性好（中位 ~1°）⇒ 旋转可靠。
  · 共享帧的**相机中心**间距很小 ⇒ 用中心距离估尺度会爆炸（v1 的错误，尺度在 0.8~2.5 间乱跳）。
    ⇒ 改用「**相机高度恒定**」先验估尺度：s = |median(d_ground_A)| / |median(d_ground_B)|。
  · 平移用共享帧点云做 ICP 精修（共享区就是两窗共同看到的区域，天然重叠）。

输出：<out>/<tag>-world.ply、<tag>-world.json（诊断）、<tag>-traj.json（X/Y/Z 数组）
"""
import argparse
import glob
import json
import os

import numpy as np


def ortho(M):
    U, _, Vt = np.linalg.svd(M)
    R = U @ Vt
    if np.linalg.det(R) < 0:
        U = U.copy()
        U[:, -1] *= -1.0
        R = U @ Vt
    return R


def load_win(path):
    z = np.load(path, allow_pickle=True)
    return {
        "path": path,
        "c2w": np.asarray(z["c2w"], float),
        "idx": np.asarray(z["idxs"]).astype(int),
        "pts": np.asarray(z["pts"], np.float32),
        "rgb": np.asarray(z["prgb"], np.uint8),
        "dg": np.ravel(np.asarray(z["d_ground"], float)).astype(float),
        "pc": np.asarray(z["pcount"]).astype(int),
    }


def vox_down(P, C, vox):
    if len(P) == 0:
        return P, C
    k = np.floor(P / vox).astype(np.int64)
    _, f = np.unique(k, axis=0, return_index=True)
    return P[f], C[f]


def shared_pts(W, frames, vox):
    """取该窗里来自给定帧号的点（点按帧顺序排列，pcount 切分）。"""
    off = np.concatenate([[0], np.cumsum(W["pc"])])
    sel = [k for k, f in enumerate(W["idx"]) if int(f) in frames]
    if not sel:
        return np.zeros((0, 3)), np.zeros((0, 3), np.uint8)
    ii = np.concatenate([np.arange(off[k], off[k + 1]) for k in sel])
    return vox_down(W["pts"][ii].astype(float), W["rgb"][ii], vox)


def icp3(Psrc, Pdst, T0, iters=25, max_corr=0.05, min_inl=200, cap=120000):
    """手写 3D **相似变换** ICP（含尺度）：open3d 0.18 的 registration 在本机会 0xC0000005 崩，弃用。
    返回 (s, R, t, fit, rms)，语义 p -> s R p + t。
    """
    from scipy.spatial import cKDTree
    rng = np.random.default_rng(0)
    A0 = Psrc if len(Psrc) <= cap else Psrc[rng.choice(len(Psrc), cap, replace=False)]
    B0 = Pdst if len(Pdst) <= cap else Pdst[rng.choice(len(Pdst), cap, replace=False)]
    tree = cKDTree(B0)
    s = float(T0[0, 0]) if T0[0, 0] > 0 else 1.0
    R = T0[:3, :3].copy() / (float(T0[0, 0]) if T0[0, 0] > 0 else 1.0)
    t = T0[:3, 3].copy()
    last = None
    for _ in range(iters):
        P = s * (A0 @ R.T) + t
        d, idx = tree.query(P, k=1)
        m = d < max_corr
        if int(m.sum()) < min_inl:
            break
        A, B = P[m], B0[idx[m]]
        ca, cb = A.mean(0), B.mean(0)
        Aa, Bb = A - ca, B - cb
        H = Aa.T @ Bb
        U, S, Vt = np.linalg.svd(H)
        Rr = Vt.T @ U.T
        if np.linalg.det(Rr) < 0:
            Vt = Vt.copy()
            Vt[-1] *= -1
            Rr = Vt.T @ U.T
        sr = float(S.sum() / max(1e-12, (Aa ** 2).sum()))
        sr = min(max(sr, 0.5), 2.0)
        tr = cb - sr * (Rr @ ca)
        s = sr * s
        R = Rr @ R
        t = sr * (Rr @ t) + tr
        rms = float(np.sqrt((d[m] ** 2).mean()))
        if last is not None and abs(last - rms) < 1e-6:
            last = rms
            break
        last = rms
    P = s * (A0 @ R.T) + t
    d, _ = tree.query(P, k=1)
    return s, R, t, float((d < max_corr).mean()), (last if last is not None else float(d.mean()))


def pair_align(A, B, vox=0.01, use_icp=True, verbose=False):
    """求 X: B 局部 -> A 局部 的相似变换 (s, R, t)。"""
    setB = set(B["idx"].tolist())
    sh = [int(f) for f in A["idx"].tolist() if int(f) in setB]
    if len(sh) < 3:
        return None
    pa = {int(v): k for k, v in enumerate(A["idx"])}
    pb = {int(v): k for k, v in enumerate(B["idx"])}
    # 尺度：相机高度恒定（d_ground 就是 DA3 估的相机到地面距离）
    s = abs(float(np.median(A["dg"]))) / max(1e-9, abs(float(np.median(B["dg"]))))
    # 旋转：共享帧朝向
    M = np.zeros((3, 3))
    for f in sh:
        M += A["c2w"][pa[f], :3, :3] @ B["c2w"][pb[f], :3, :3].T
    R = ortho(M)
    ang = []
    for f in sh:
        d = R.T @ (A["c2w"][pa[f], :3, :3] @ B["c2w"][pb[f], :3, :3].T)
        ang.append(float(np.degrees(np.arccos(np.clip((np.trace(d) - 1) / 2, -1, 1)))))
    # 平移初值：共享帧中心（baseline 小，只当起点）
    tA = np.stack([A["c2w"][pa[f], :3, 3] for f in sh])
    tB = np.stack([B["c2w"][pb[f], :3, 3] for f in sh])
    t = np.mean(tA - s * (tB @ R.T), axis=0)
    met = {"nshared": len(sh), "s": s, "ang_med": float(np.median(ang)),
           "ang_max": float(max(ang)), "t0": float(np.linalg.norm(t))}
    if use_icp:
        try:
            PA, _ = shared_pts(A, set(sh), vox)
            PB, _ = shared_pts(B, set(sh), vox)
            if len(PA) > 500 and len(PB) > 500:
                sr, Rr, tr, fit, rms = icp3(s * (PB @ R.T) + t, PA, np.eye(4))
                s = sr * s
                R = Rr @ R
                t = sr * (Rr @ t) + tr
                met["icp_fit"] = fit
                met["icp_rmse"] = rms
                met["icp_t"] = float(np.linalg.norm(tr))
                met["icp_s"] = sr
                met["s_after_icp"] = s
        except Exception as e:                                   # noqa: BLE001
            met["icp_err"] = str(e)[:80]
    return s, R, t, met


def plane_normal(P, thresh=0.02, iters=400, seed=0):
    """numpy RANSAC 拟合主平面（不用 open3d —— 它的 registration 在本机会崩）。"""
    rng = np.random.default_rng(seed)
    n = len(P)
    if n < 100:
        return None
    sub = P if n <= 400000 else P[rng.choice(n, 400000, replace=False)]
    best = (0, None)
    for _ in range(iters):
        i = rng.choice(len(sub), 3, replace=False)
        p0, p1, p2 = sub[i]
        nrm = np.cross(p1 - p0, p2 - p0)
        ln = np.linalg.norm(nrm)
        if ln < 1e-9:
            continue
        nrm = nrm / ln
        d = np.abs((sub - p0) @ nrm)
        k = int((d < thresh).sum())
        if k > best[0]:
            best = (k, nrm)
    if best[1] is None:
        return None
    nrm = best[1]
    # 用内点再精修一次
    d = np.abs((sub - sub.mean(0)) @ nrm)
    inl = sub[d < thresh]
    if len(inl) > 10:
        c = inl.mean(0)
        _, _, Vt = np.linalg.svd(inl - c)
        nrm = Vt[-1]
    return nrm / (np.linalg.norm(nrm) + 1e-12), best[0] / float(len(sub))


def write_ply(path, P, C):
    with open(path, "wb") as fh:
        fh.write(("ply\nformat binary_little_endian 1.0\nelement vertex %d\n"
                  "property float x\nproperty float y\nproperty float z\n"
                  "property uchar red\nproperty uchar green\nproperty uchar blue\n"
                  "end_header\n" % len(P)).encode("ascii"))
        rec = np.empty(len(P), dtype=np.dtype([("x", "<f4"), ("y", "<f4"), ("z", "<f4"),
                                               ("r", "u1"), ("g", "u1"), ("b", "u1")]))
        rec["x"], rec["y"], rec["z"] = P[:, 0], P[:, 1], P[:, 2]
        rec["r"], rec["g"], rec["b"] = C[:, 0], C[:, 1], C[:, 2]
        fh.write(rec.tobytes())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--posedir", default=r"C:\DLnotebook-media\tmp\poseda3")
    ap.add_argument("--prefix", default="desert-s1")
    ap.add_argument("--out", default=r"C:\DLnotebook-media\tmp\world2")
    ap.add_argument("--tag", default="")
    ap.add_argument("--voxel", type=float, default=0.01)
    ap.add_argument("--out-voxel", type=float, default=0.012)
    ap.add_argument("--max-pts", type=int, default=6000000)
    ap.add_argument("--no-icp", action="store_true")
    args = ap.parse_args()

    tag = args.tag or args.prefix
    os.makedirs(args.out, exist_ok=True)
    files = sorted(glob.glob(os.path.join(args.posedir, "%s-win*.npz" % args.prefix)))
    if not files:
        raise SystemExit("没有窗文件")
    print("[ws] %s  %d 窗" % (tag, len(files)), flush=True)

    W0 = load_win(files[0])
    S = [1.0]
    Rg = [np.eye(3)]
    Tg = [np.zeros(3)]
    wins = [W0]
    pairs = []
    P0, C0 = vox_down(W0["pts"].astype(float), W0["rgb"], args.out_voxel)
    clouds = [(P0, C0)]
    cam = []
    for k, f in enumerate(W0["idx"]):
        cam.append((int(f), W0["c2w"][k, :3, 3].copy(), float(W0["dg"][k]), 0))

    prev = W0
    for wi in range(1, len(files)):
        cur = load_win(files[wi])
        r = pair_align(prev, cur, vox=args.voxel, use_icp=not args.no_icp)
        if r is None:
            print("  窗 %d 共享帧不足，跳过" % wi, flush=True)
            prev = cur
            continue
        s, R, t, met = r
        s_B = S[-1] * s
        R_B = Rg[-1] @ R
        T_B = S[-1] * (Rg[-1] @ t) + Tg[-1]
        S.append(s_B)
        Rg.append(R_B)
        Tg.append(T_B)
        met["i"] = wi
        pairs.append(met)
        P, C = vox_down(cur["pts"].astype(float), cur["rgb"], args.out_voxel)
        clouds.append((s_B * (P @ R_B.T) + T_B, C))
        for k, f in enumerate(cur["idx"]):
            cam.append((int(f), cur["c2w"][k, :3, 3].copy(), float(cur["dg"][k]), wi))
        prev = cur
        if wi % 8 == 0 or wi == len(files) - 1:
            print("   ... 窗 %d/%d  对: s %.3f  ang %.2f°  icpfit %s  累计 %d 点"
                  % (wi, len(files) - 1, s, met["ang_med"],
                     ("%.2f" % met["icp_fit"]) if "icp_fit" in met else "-",
                     sum(len(c[0]) for c in clouds)), flush=True)

    cam.sort(key=lambda z: z[0])
    seen = set()
    cam_u = []
    for fr, c, dg, wi in cam:
        if fr in seen:
            continue
        seen.add(fr)
        g = S[wi] * (Rg[wi] @ c) + Tg[wi]
        cam_u.append((fr, g, abs(dg) * S[wi], wi))
    Cp = np.stack([c[1] for c in cam_u])
    Hl = np.array([c[2] for c in cam_u])
    med_h = float(np.median(Hl))
    step = np.linalg.norm(np.diff(Cp, axis=0), axis=1)
    step = step[step > 1e-9]

    print("[ws] 对：尺度中位 %.3f (%.3f..%.3f) | 朝向中位 %.2f° 最大 %.2f°"
          % (np.median([p["s"] for p in pairs]), min(p["s"] for p in pairs),
             max(p["s"] for p in pairs), np.median([p["ang_med"] for p in pairs]),
             max(p["ang_max"] for p in pairs)), flush=True)
    if any("icp_fit" in p for p in pairs):
        print("[ws] ICP：fitness 中位 %.3f  rmse 中位 %.4f  平移修正中位 %.3f"
              % (np.median([p.get("icp_fit", 0) for p in pairs if "icp_fit" in p]),
                 np.median([p.get("icp_rmse", 0) for p in pairs if "icp_rmse" in p]),
                 np.median([p.get("icp_t", 0) for p in pairs if "icp_t" in p])), flush=True)
    print("[ws] 相机高度(局部单位)：中位 %.4f  (%.4f..%.4f)  归一后待算" % (med_h, Hl.min(), Hl.max()), flush=True)
    print("[ws] 相机步长：中位 %.4f  CV %.3f  (n=%d)"
          % (float(np.median(step)), float(step.std() / (step.mean() + 1e-12)), len(step)), flush=True)

    k = 1.0 / (med_h + 1e-12)
    Pall = np.concatenate([c[0] for c in clouds], axis=0) * k
    Call = np.concatenate([c[1] for c in clouds], axis=0)
    Pall, Call = vox_down(Pall, Call, args.out_voxel * 0.5)
    if args.max_pts and len(Pall) > args.max_pts:
        sel = np.random.default_rng(1).choice(len(Pall), args.max_pts, replace=False)
        sel.sort()
        Pall, Call = Pall[sel], Call[sel]
    Cp = Cp * k
    Hl = Hl * k

    info = {"tag": tag, "windows": len(files), "points": int(len(Pall)),
            "scale_to_h": k, "cam_height_units": [float(Hl.min()), float(np.median(Hl)), float(Hl.max())],
            "step_med": float(np.median(step) * k), "step_cv": float(step.std() / (step.mean() + 1e-12)),
            "pairs": pairs}

    Rup = np.eye(3)
    pf = plane_normal(Pall)
    if pf is not None:
        nrm, frac = pf
        if np.dot(nrm, Cp.mean(axis=0) - Pall.mean(axis=0)) < 0:
            nrm = -nrm
        d = (Cp - Cp.mean(axis=0)) @ nrm
        info["plane_inlier_frac"] = frac
        info["cam_height_along_normal"] = [float(d.min()), float(np.median(d)), float(d.max())]
        tgt = np.array([0.0, -1.0, 0.0])
        v = np.cross(nrm, tgt)
        c0 = float(np.dot(nrm, tgt))
        if np.linalg.norm(v) < 1e-9:
            Rup = np.eye(3) if c0 > 0 else np.diag([1.0, -1.0, -1.0])
        else:
            vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
            Rup = np.eye(3) + vx + vx @ vx * (1.0 / (1.0 + c0))
        Pall = Pall @ Rup.T
        Cp = Cp @ Rup.T
        print("[ws] 地面平面：内点 %.0f%%  法向 [%.2f %.2f %.2f]  相机沿法向高度 中位 %.3f (%.3f..%.3f)"
              % (frac * 100, nrm[0], nrm[1], nrm[2], info["cam_height_along_normal"][1],
                 info["cam_height_along_normal"][0], info["cam_height_along_normal"][2]), flush=True)

    ply = os.path.join(args.out, "%s-world.ply" % tag)
    write_ply(ply, Pall, Call)
    json.dump(info, open(os.path.join(args.out, "%s-world.json" % tag), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    order = np.argsort([c[0] for c in cam_u])
    X = [float(Cp[i, 0]) for i in order]
    Y = [float(Cp[i, 1]) for i in order]
    Z = [float(Cp[i, 2]) for i in order]
    FR = [int(cam_u[i][0]) for i in order]
    json.dump({"X": X, "Y": Y, "Z": Z, "frame": FR},
              open(os.path.join(args.out, "%s-traj.json" % tag), "w", encoding="utf-8"),
              ensure_ascii=False)
    print("[ws] 写出 %s  (%d 点, %.1f MB)" % (ply, len(Pall), os.path.getsize(ply) / 1e6), flush=True)


if __name__ == "__main__":
    main()
