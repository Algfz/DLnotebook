# -*- coding: utf-8 -*-
"""A 路线核心：把「地面上的路径」按已标定的机架正投到俯视地图，并逐帧 2D ICP 拼接。

为什么可行：机架已由灭点自标定出来（f≈430 px / 俯角 60° / 滚转 0，见 tools/vp-calib.py）。
地面是平面 ⇒ 单帧的正投是**尺度已知（差一个相机高 h 的比例）、无深度歧义**的二维映射；
帧间只差一个 SE(2)（平移 + 绕竖轴旋转）。于是用**路径本身**做 2D ICP 就能把整段拼成一张
清晰的俯视地图 —— 没有 3D 重建、没有点云噪声累积。

用法:
  python tools/path-map.py --dir <帧目录> [--start 0] [--end 400] [--step 2]
      [--mask red|dark] [--f 430] [--pitch 60] [--out 目录] [--tag 名字]
      [--map-px 400]（每 h 单位画多少像素）[--max-pts 4000]
"""
import os
import sys
import json
import math
import glob
import argparse

import cv2
import numpy as np
from scipy.spatial import cKDTree

try:
    from skimage.morphology import skeletonize
except Exception:                                    # 退化时仍可用 mask 模式
    skeletonize = None


# ------------------------------------------------------------------ 掩膜
def path_mask(img, mode="red"):
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    if mode == "red":
        m = cv2.inRange(hsv, (0, 110, 70), (20, 255, 255))
        m2 = cv2.inRange(hsv, (165, 110, 70), (179, 255, 255))
        m = cv2.bitwise_or(m, m2)
    elif mode == "dark":
        v = hsv[:, :, 2]
        m = ((v < 95).astype(np.uint8)) * 255
    else:
        raise SystemExit("未知 --mask %s" % mode)
    k = np.ones((3, 3), np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, k, iterations=2)
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, k, iterations=1)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m, 8)
    keep = np.zeros_like(m)
    if n > 1:
        order = np.argsort(-stats[1:, 4]) + 1
        for i in order[:5]:
            if stats[i, 4] < 200:
                break
            keep[lab == i] = 255
    return keep


# ------------------------------------------------------------------ 中轴
def centerline(mask, min_dist=1.2, nb=5, max_gap=45.0):
    """距离变换脊线 + 从画面最下方开始贪心串成一条折线（每帧单独用，保留小锯齿）。"""
    d = cv2.distanceTransform(mask, cv2.DIST_L2, 5)
    mx = cv2.dilate(d, np.ones((nb, nb), np.uint8))
    ridge = (d >= mx - 1e-6) & (d > min_dist)
    ys, xs = np.nonzero(ridge)
    if len(xs) < 4:
        return np.zeros((0, 2), np.float64), d
    pts = np.stack([xs, ys], 1).astype(np.float64)
    start = int(np.argmax(pts[:, 1]))            # 画面最下的点（离相机最近）
    used = np.zeros(len(pts), bool)
    order = [start]
    used[start] = True
    for _ in range(len(pts) - 1):
        last = pts[order[-1]]
        dd = np.linalg.norm(pts - last, axis=1)
        dd[used] = 1e9
        j = int(np.argmin(dd))
        if dd[j] > max_gap:
            break
        order.append(j)
        used[j] = True
    return pts[order], d


# ------------------------------------------------------------------ 机架
def to_ground(uv, f, pitch_deg, cx, cy, h=1.0):
    th = math.radians(pitch_deg)
    uv = np.asarray(uv, np.float64).reshape(-1, 2)
    x = (uv[:, 0] - cx) / f
    y = (uv[:, 1] - cy) / f
    d_y = -(y * math.cos(th) + math.sin(th))
    d_x = x
    d_z = y * (-math.sin(th)) + math.cos(th)
    t = -h / d_y
    return np.stack([t * d_x, t * d_z], 1)


def ground_to_image(XZ, f, pitch_deg, cx, cy, h=1.0):
    th = math.radians(pitch_deg)
    XZ = np.asarray(XZ, np.float64).reshape(-1, 2)
    X, Z = XZ[:, 0], XZ[:, 1]
    # 世界点 (X,0,Z) 相对相机 (0,h,0)
    px, py, pz = X - 0.0, -h, Z - 0.0
    fwd = np.array([0.0, -math.sin(th), math.cos(th)])
    right = np.array([1.0, 0.0, 0.0])
    down = np.array([0.0, -math.cos(th), -math.sin(th)])
    zc = px * fwd[0] + py * fwd[1] + pz * fwd[2]
    xc = px * right[0] + py * right[1] + pz * right[2]
    yc = px * down[0] + py * down[1] + pz * down[2]
    ok = zc > 1e-9
    u = np.full(len(XZ), np.nan)
    v = np.full(len(XZ), np.nan)
    u[ok] = f * xc[ok] / zc[ok] + cx
    v[ok] = f * yc[ok] / zc[ok] + cy
    return np.stack([u, v], 1)


# ------------------------------------------------------------------ SE(2)
def se2(yaw, tx, tz):
    c, s = math.cos(yaw), math.sin(yaw)
    return np.array([[c, -s, tx], [s, c, tz], [0, 0, 1]], np.float64)


def apply_se2(T, P):
    P = np.asarray(P, np.float64).reshape(-1, 2)
    return (T[:2, :2] @ P.T).T + T[:2, 2]


def rigid_fit(src, dst, w=None):
    """求 T（旋转+平移，不含尺度）使 T src ≈ dst。"""
    if len(src) < 3:
        return None
    mu_s = src.mean(0)
    mu_d = dst.mean(0)
    S = src - mu_s
    D = dst - mu_d
    if w is not None:
        ww = w[:, None]
        H = (S * ww).T @ D
    else:
        H = S.T @ D
    U, _, Vt = np.linalg.svd(H)
    d = np.sign(np.linalg.det(Vt.T @ U.T))
    R = Vt.T @ np.diag([1.0, d]) @ U.T
    t = mu_d - R @ mu_s
    T = np.eye(3)
    T[:2, :2] = R
    T[:2, 2] = t
    return T


def icp(cur, tree, pose0, cutoff=0.06, iters=30, tol=1e-6):
    T = pose0.copy()
    prev = None
    for _ in range(iters):
        P = apply_se2(T, cur)
        d, idx = tree.query(P, k=1, distance_upper_bound=cutoff)
        ok = np.isfinite(d)
        if ok.sum() < 8:
            return None, float("inf"), int(ok.sum())
        med = float(np.median(d[ok]))
        if prev is not None and abs(prev - med) < tol:
            break
        prev = med
        dT = rigid_fit(P[ok], tree.data[idx[ok]], w=1.0 / (1.0 + d[ok]))
        if dT is None:
            break
        T = dT @ T
    P = apply_se2(T, cur)
    d, idx = tree.query(P, k=1, distance_upper_bound=cutoff)
    ok = np.isfinite(d)
    return T, (float(np.median(d[ok])) if ok.sum() else float("inf")), int(ok.sum())


# ------------------------------------------------------------------ 主流程
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--start", type=int, default=0)
    ap.add_argument("--end", type=int, default=400)
    ap.add_argument("--step", type=int, default=2)
    ap.add_argument("--mask", default="red")
    ap.add_argument("--zmin", type=float, default=0.0,
                    help="只用相机前方 Z>=zmin 的点做配准（近场边缘被画框切掉且是侧面，会把 ICP 拉偏）")
    ap.add_argument("--zmax", type=float, default=99.0, help="只用 Z<=zmax 的点做配准")
    ap.add_argument("--accum", default="centerline", choices=["mask", "centerline"],
                    help="往地图里累加点用哪种：mask=整条带（配准稳但地图糊）；"
                         "centerline=每帧中轴（地图细、保锯齿）——推荐 mask 配准 + centerline 成图")
    ap.add_argument("--f", type=float, default=430.0)
    ap.add_argument("--pitch", type=float, default=60.0)
    ap.add_argument("--path-h", type=float, default=0.0,
                    help="路径带离地高度（相机高为单位）。红带是凸起的 3D 物体，"
                         "用 h=1-δ 的平面正投才能落回它真正的 (X,Z)；δ 可用「地图占格最少」自标定")
    ap.add_argument("--out", default="")
    ap.add_argument("--tag", default="")
    ap.add_argument("--map-px", type=float, default=400.0, help="每个 h（相机高）画多少像素")
    ap.add_argument("--max-pts", type=int, default=4000)
    ap.add_argument("--cutoff", type=float, default=0.06)
    ap.add_argument("--min-inl", type=int, default=120)
    ap.add_argument("--gate-deg", type=float, default=12.0,
                    help="单步旋转闸门：ICP 相对预测的偏转超过它就不采信（防跳支）")
    ap.add_argument("--gate-move", type=float, default=0.5,
                    help="单步平移闸门（h 单位）")
    ap.add_argument("--refine", type=int, default=0,
                    help="全局精修轮数：建图→逐帧对全图重配（近似 bundle adjustment，抹掉累积漂移）")
    ap.add_argument("--refine-cutoff", type=float, default=0.03)
    ap.add_argument("--refine-gate-deg", type=float, default=3.0)
    a = ap.parse_args()

    fs = sorted(glob.glob(os.path.join(a.dir, "*.jpg")) + glob.glob(os.path.join(a.dir, "*.png")))
    if not fs:
        raise SystemExit("没有帧: %s" % a.dir)
    sel = list(range(a.start, min(a.end, len(fs)), max(1, a.step)))
    tag = a.tag or os.path.basename(os.path.normpath(a.dir))
    outd = a.out or os.path.join(os.path.dirname(a.dir.rstrip("\\/")), "map-" + tag)
    os.makedirs(outd, exist_ok=True)
    print("[pm] %s  %d 帧（%d..%d step %d）  机架 f=%.0f 俯角=%.1f°  掩膜=%s"
          % (tag, len(sel), sel[0], sel[-1], a.step, a.f, a.pitch, a.mask))

    map_pts = []      # 地图里的 2D 点（世界）
    map_rgb = []      # 对应颜色
    map_frame = []    # 每个点来自第几帧（供弧长正则化重排）
    ref_pts = []      # 配准参照地图（始终是宽带掩膜点，约束强）
    frames = []       # 每帧的相机系地面点 + 颜色（供全局精修）
    poses = []        # 每帧 SE(2)
    prev_T = np.eye(3)
    prev_T2 = None
    info = []
    for n, i in enumerate(sel):
        img = cv2.imread(fs[i])
        if img is None:
            continue
        H, W = img.shape[:2]
        cx, cy = W / 2.0, H / 2.0
        m = path_mask(img, a.mask)
        ys, xs = np.nonzero(m)
        if len(xs) < 30:
            info.append({"i": i, "ok": False, "why": "掩膜太小"})
            continue
        if len(xs) > a.max_pts:
            k = np.random.default_rng(0).choice(len(xs), a.max_pts, replace=False)
            ys, xs = ys[k], xs[k]
        uv = np.stack([xs, ys], 1).astype(np.float64)
        G = to_ground(uv, a.f, a.pitch, cx, cy, h=1.0 - a.path_h)   # 相机系地面坐标
        col = img[ys, xs].astype(np.uint8)              # 保持 BGR（cv2.imwrite 也按 BGR 写）
        if a.zmin > 0 or a.zmax < 90:
            kz = (G[:, 1] >= a.zmin) & (G[:, 1] <= a.zmax)
            if int(kz.sum()) >= 40:
                G, col = G[kz], col[kz]
        if a.accum == "centerline":
            sk = skeletonize(m > 0)
            ym, xm = np.nonzero(sk)
            if len(xm) < 20:
                info.append({"i": i, "ok": False, "why": "中轴太短"})
                continue
            uv_m = np.stack([xm, ym], 1).astype(np.float64)
            G_map = to_ground(uv_m, a.f, a.pitch, cx, cy, h=1.0 - a.path_h)
            col_map = img[ym, xm].astype(np.uint8)
        else:
            G_map, col_map = G, col
        if not map_pts:                                  # 第一帧（或前面全被跳过）
            T = np.eye(3)
            resid, ninl = 0.0, len(G)
        else:
            pred = prev_T if prev_T2 is None else prev_T @ np.linalg.inv(prev_T2) @ prev_T
            tree = cKDTree(np.asarray(ref_pts, np.float64))   # 配准参照始终用宽带掩膜点（约束强）
            T, resid, ninl = icp(G, tree, pred, cutoff=a.cutoff)
            need = max(20, min(a.min_inl, int(0.4 * len(G))))
            if T is not None:
                D = np.linalg.inv(pred) @ T                # 相对预测的偏转
                dyaw = abs(math.degrees(math.atan2(D[1, 0], D[0, 0])))
                dmov = float(np.hypot(D[0, 2], D[1, 2]))
                if dyaw > a.gate_deg or dmov > a.gate_move:
                    print("   [gate] %s 拒绝跳支（偏转 %.1f° / %.3f h），退回预测"
                          % (os.path.basename(fs[i]), dyaw, dmov))
                    T, resid, ninl = pred, 9.99, need
            if T is None or ninl < need:
                info.append({"i": i, "ok": False, "why": "ICP 失败", "resid": resid, "inl": ninl})
                print("   [warn] %s ICP 失败 (inl %d)" % (os.path.basename(fs[i]), ninl))
                continue
        Pw = apply_se2(T, G_map)
        map_pts.extend(Pw.tolist())
        map_rgb.extend(col_map.tolist())
        map_frame.extend([i] * len(Pw))
        ref_pts.extend(apply_se2(T, G).tolist())
        frames.append({"i": i, "G": G, "G_map": G_map, "col": col_map})
        prev_T2 = prev_T.copy()
        prev_T = T.copy()
        poses.append({"i": i, "file": os.path.basename(fs[i]),
                      "T": T.tolist(), "resid": float(resid), "inl": int(ninl),
                      "yaw_deg": float(math.degrees(math.atan2(T[1, 0], T[0, 0])))})
        info.append({"i": i, "ok": True, "resid": float(resid), "inl": int(ninl)})
        if (n + 1) % 25 == 0:
            print("   ... %d/%d  地图点 %d  最近 resid %.4f" % (n + 1, len(sel), len(map_pts), resid))

    if not map_pts:
        raise SystemExit("没有任何帧成功")

    # ---------- 全局精修（近似 bundle adjustment：建图 → 逐帧对全图重配）----------
    if a.refine > 0 and len(frames) > 4:
        Gs = [f["G"] for f in frames]
        Gms = [f["G_map"] for f in frames]
        cols = [f["col"] for f in frames]
        Ts = [np.asarray(p["T"], np.float64) for p in poses]
        for it in range(a.refine):
            # 半集交替：A 组建图、B 组对其精修 —— 避免"帧对着自己那份点做 ICP"的零残差假象
            A = [k for k in range(len(Gs)) if (k + it) % 2 == 0]
            B = [k for k in range(len(Gs)) if (k + it) % 2 == 1]
            Pw = np.concatenate([apply_se2(Ts[k], Gs[k]) for k in A])
            tree = cKDTree(Pw)
            moved, worst, dsum = 0, 0.0, 0.0
            for k in B:
                T2, resid, ninl = icp(Gs[k], tree, Ts[k], cutoff=a.refine_cutoff)
                if T2 is None:
                    continue
                D = np.linalg.inv(Ts[k]) @ T2
                dyaw = abs(math.degrees(math.atan2(D[1, 0], D[0, 0])))
                dmov = float(np.hypot(D[0, 2], D[1, 2]))
                worst = max(worst, dyaw)
                if dyaw <= a.refine_gate_deg and dmov <= a.gate_move:
                    Ts[k] = T2
                    moved += 1
                    dsum += dmov
            print("[pm] 精修 %d/%d：半集 %d 建图 / %d 重配，更新 %d 帧，平均位移 %.4f h，最大偏转 %.2f°"
                  % (it + 1, a.refine, len(A), len(B), moved, dsum / max(1, moved), worst))
        map_pts, map_rgb, map_frame = [], [], []
        for k in range(len(Gs)):
            Pw = apply_se2(Ts[k], Gms[k])
            map_pts.extend(Pw.tolist())
            map_rgb.extend(cols[k].tolist())
            map_frame.extend([frames[k]["i"]] * len(Pw))
            poses[k]["T"] = Ts[k].tolist()
            poses[k]["yaw_deg"] = float(math.degrees(math.atan2(Ts[k][1, 0], Ts[k][0, 0])))

    P = np.asarray(map_pts, np.float64)
    C = np.asarray(map_rgb, np.uint8)
    lo = P.min(0) - 0.05
    hi = P.max(0) + 0.05
    S = a.map_px
    cw = int((hi[0] - lo[0]) * S) + 1
    ch = int((hi[1] - lo[1]) * S) + 1
    print("[pm] 地图 %dx%d px（世界范围 %.2f x %.2f h 单位）  点 %d"
          % (cw, ch, hi[0] - lo[0], hi[1] - lo[1], len(P)))
    canvas = np.full((ch, cw, 3), 255, np.uint8)
    px = ((P[:, 0] - lo[0]) * S).astype(int)
    pz = ((P[:, 1] - lo[1]) * S).astype(int)
    ok = (px >= 0) & (px < cw) & (pz >= 0) & (pz < ch)
    canvas[pz[ok], px[ok]] = C[ok]
    # 让点更实：轻微膨胀
    k = np.ones((2, 2), np.uint8)
    canvas = cv2.dilate(canvas, k)
    png = os.path.join(outd, "%s-map.png" % tag)
    cv2.imwrite(png, canvas)
    occ = int((canvas.reshape(-1, 3).sum(1) < 720).sum())
    print("[pm] 写出 %s   占格 %d px（越小=同样路径被画得越细、越锐）" % (png, occ))
    # 叠加相机轨迹
    tr = np.array([[p["T"][0][2], p["T"][1][2]] for p in poses], np.float64)
    trp = np.stack([(tr[:, 0] - lo[0]) * S, (tr[:, 1] - lo[1]) * S], 1).astype(int)
    vis = canvas.copy()
    cv2.polylines(vis, [trp.reshape(-1, 1, 2)], False, (0, 0, 255), 2)
    cv2.circle(vis, tuple(trp[0]), 6, (0, 180, 0), -1)
    cv2.circle(vis, tuple(trp[-1]), 6, (255, 0, 0), -1)
    png2 = os.path.join(outd, "%s-map-traj.png" % tag)
    cv2.imwrite(png2, vis)
    print("[pm] 写出 %s" % png2)
    res = [x["resid"] for x in info if x.get("ok")]
    js = {"tag": tag, "f": a.f, "pitch": a.pitch, "map_px": S,
          "origin": [float(lo[0]), float(lo[1])], "size": [cw, ch],
          "n_frames_ok": len(poses), "n_frames_all": len(sel),
          "resid_med": float(np.median(res)) if res else None,
          "poses": poses, "info": info}
    np.savez_compressed(os.path.join(outd, "%s-map-pts.npz" % tag),
                        P=P.astype(np.float32), C=C.astype(np.uint8),
                        F=np.asarray(map_frame, np.int32),
                        origin=lo.astype(np.float64), map_px=np.float64(S))
    print("[pm] 写出 %s" % os.path.join(outd, "%s-map-pts.npz" % tag))
    with open(os.path.join(outd, "%s-map.json" % tag), "w", encoding="utf-8") as fh:
        json.dump(js, fh, ensure_ascii=False)
    print("[pm] 成功 %d/%d 帧  残差中位 %.4f h 单位" % (len(poses), len(sel), np.median(res) if res else -1))
    print("[pm] 写出 %s" % os.path.join(outd, "%s-map.json" % tag))


if __name__ == "__main__":
    main()
