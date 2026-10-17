"""ply-align.py — 把重建出来的世界「摆正」：重力对齐（y 轴朝上）+ 平移到起点。

背景：DA3 每个窗口自己选世界坐标系，DA3 的原生约定是 x 右 / y 下或上 / z 后，
拼接后整个世界的「上」跟观看器的 y 轴不一致 —— 表现就是「整条路线不是水平的」，
地面在观看器里变成一堵斜墙。

做法（不依赖任何约定假设）：
  1) 用相机位姿里相机的局部 y 轴平均出「重力候选」（正负两种）；
  2) 在点云上用 RANSAC 找最大的平面（地面），取法向；
  3) 用「相机在平面的哪一侧」定符号 ⇒ 得到真正的 up；
  4) 旋转世界使 up -> +Y，并把起点平移到原点、地面平均高度归零。

用法：
  python tools/ply-align.py --ply in.ply --out out.ply \
      [--poses pose.json --poses-out pose-aligned.json] \
      [--traj traj.json --traj-out traj-aligned.json] \
      [--rot-json rot.json] [--sample 400000]
"""
import argparse
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from refscene import read_ply, write_ply  # noqa: E402


def rot_from_to(a, b):
    """把单位向量 a 旋转到单位向量 b 的旋转矩阵。"""
    a = a / (np.linalg.norm(a) + 1e-12)
    b = b / (np.linalg.norm(b) + 1e-12)
    v = np.cross(a, b)
    c = float(np.dot(a, b))
    s = float(np.linalg.norm(v))
    if s < 1e-9:
        if c > 0:
            return np.eye(3)
        # 反向：绕任一垂直轴转 180°
        tmp = np.array([1.0, 0.0, 0.0]) if abs(a[0]) < 0.9 else np.array([0.0, 1.0, 0.0])
        v = np.cross(a, tmp)
        v = v / (np.linalg.norm(v) + 1e-12)
        return -np.eye(3) + 2 * np.outer(v, v)
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx * ((1 - c) / (s * s))


def ransac_plane(P, iters=400, tol_ratio=0.0015, seed=0, max_pts=400000):
    """返回 (法向, 内点掩码阈值, 内点数)。tol 相对整体尺度。"""
    rng = np.random.default_rng(seed)
    Q = P if len(P) <= max_pts else P[rng.choice(len(P), max_pts, replace=False)]
    lo, hi = Q.min(0), Q.max(0)
    scale = float(np.linalg.norm(hi - lo)) + 1e-9
    tol = tol_ratio * scale
    best = (None, -1, None)
    cands = []
    for _ in range(iters):
        i = rng.choice(len(Q), 3, replace=False)
        p0, p1, p2 = Q[i]
        n = np.cross(p1 - p0, p2 - p0)
        nn = np.linalg.norm(n)
        if nn < 1e-9:
            continue
        n = n / nn
        d = float(np.dot(n, p0))
        cnt = int(np.sum(np.abs(Q @ n - d) < tol))
        if cnt > best[1]:
            best = (n, cnt, d)
        cands.append((cnt, n.copy(), d))
    n, cnt, d = best
    if n is None:
        return np.array([0.0, 1.0, 0.0]), 0, tol
    # 用内点做一次最小二乘精修
    m = np.abs(P @ n - d) < tol * 1.5
    if int(m.sum()) >= 30:
        Qm = P[m]
        c = Qm.mean(0)
        u, s, vt = np.linalg.svd(Qm - c, full_matrices=False)
        n2 = vt[2]
        if np.dot(n2, n) < 0:
            n2 = -n2
        n, cnt = n2, int(m.sum())
    return n, cnt, tol, cands


def pick_ground_plane(P, C, cands, tol, extent, top=40, prior=None):
    """从 RANSAC 候选里挑「地面」而不是「墙」：地面必须让相机稳定地待在它上方固定高度。

    评分：内点数 × 相机在正侧的比例 ÷ (1 + 相机到平面距离的相对 MAD)。
    """
    if not cands:
        return None, None
    cands = sorted(cands, key=lambda x: -x[0])[:top]
    best = None
    for cnt, n, d in cands:
        n = np.asarray(n, np.float64)
        sd = C @ n - d                       # 相机到平面的有符号距离
        if np.median(sd) < 0:                # 让相机在正侧
            n, sd = -n, -sd
        above = float(np.mean(sd > 0))
        if above < 0.9:
            continue
        pos = sd[sd > 0]
        h = float(np.median(pos))
        if not (0.004 * extent < h < 0.35 * extent):
            continue
        mad = float(np.median(np.abs(pos - h))) / max(h, 1e-9)
        if prior is not None and np.dot(n, prior) < 0.5:
            continue
        score = cnt * above / (1.0 + mad)
        if best is None or score > best[0]:
            best = (score, n, d, cnt, above, h, mad)
    if best is None:
        return None, None
    _, n, d, cnt, above, h, mad = best
    print("[align] 选中的地面平面：内点 %d  相机上方比例 %.0f%%  相机中位离地 %.4f  相对 MAD %.3f"
          % (cnt, 100 * above, h, mad))
    return n, d


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ply", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--poses", default="")
    ap.add_argument("--poses-out", default="")
    ap.add_argument("--render-poses", default="")
    ap.add_argument("--render-poses-out", default="")
    ap.add_argument("--traj", default="")
    ap.add_argument("--traj-out", default="")
    ap.add_argument("--rot-json", default="")
    ap.add_argument("--sample", type=int, default=400000)
    ap.add_argument("--no-recenter", action="store_true")
    args = ap.parse_args()

    P, C = read_ply(args.ply)
    P = np.asarray(P, dtype=np.float64)
    print("[align] 读入 %d 点" % len(P))

    traj = None
    if args.traj and os.path.exists(args.traj):
        d = json.load(open(args.traj, encoding="utf-8"))
        keys = [k for k in ("X", "Y", "Z") if k in d] or ["x", "y", "z"]
        traj = np.stack([np.asarray(d[k], dtype=np.float64) for k in keys], 1)

    # 1) 相机局部 y 轴的平均（重力候选）
    cam_up = None
    pose_obj = None
    if args.poses and os.path.exists(args.poses):
        pose_obj = json.load(open(args.poses, encoding="utf-8"))
        Rs = [np.asarray(p["R"], dtype=np.float64) for p in pose_obj["poses"] if p.get("key")]
        if Rs:
            cam_up = np.mean([R[:, 1] for R in Rs], axis=0)
            cam_up = cam_up / (np.linalg.norm(cam_up) + 1e-12)
            print("[align] 相机局部 y 轴均值（关键帧 %d 个）= %s" % (len(Rs), np.round(cam_up, 3).tolist()))

    # 2) 地面 RANSAC（多候选择优：要有相机稳定地待在它上方固定高度 ⇒ 是地面而不是墙）
    Cc = None
    if traj is not None and len(traj):
        Cc = np.asarray(traj, np.float64)
    elif pose_obj is not None:
        Cc = np.array([np.asarray(p["c2w"], dtype=np.float64).reshape(4, 4)[:3, 3]
                       for p in pose_obj["poses"] if p.get("key")])
    extent = float(np.linalg.norm(P.max(0) - P.min(0)))
    n, inl, tol, cands = ransac_plane(P, seed=1, max_pts=args.sample)
    print("[align] 最大平面：法向 %s  内点 %d  容差 %.4f  场景对角线 %.2f"
          % (np.round(n, 3).tolist(), inl, tol, extent))
    if Cc is not None and len(Cc) >= 5:
        n_g, d_g = pick_ground_plane(P, Cc, cands, tol, extent, prior=cam_up)
        if n_g is not None:
            n_max = n.copy()
            if np.dot(n_g, n) < 0:
                n_g = -n_g
            print("[align] 地面法向与「最大平面」法向夹角 %.1f°"
                  % np.degrees(np.arccos(np.clip(abs(float(np.dot(n_g, n_max))), -1, 1))))
            n = n_g
    elif cam_up is not None and np.dot(n, cam_up) < 0:
        n = -n

    # 3) 定符号：相机应该在「地面法向的正侧」（即 up 指向相机一侧）
    ref = None
    if traj is not None and len(traj):
        ref = traj.mean(0)
    elif cam_up is not None:
        ref = np.mean([np.asarray(p["c2w"], dtype=np.float64).reshape(4, 4)[:3, 3]
                       for p in pose_obj["poses"] if p.get("key")], axis=0)
    if ref is None:
        ref = P.mean(0)
    mask = np.abs(P @ n - float(np.dot(n, P[0]))) < tol * 2
    if P[mask].size == 0:
        mask = np.ones(len(P), bool)
    ground = P[mask].mean(0)
    if np.dot(n, ref - ground) < 0:
        n = -n
    ang_cam = None
    if cam_up is not None:
        c = abs(float(np.dot(cam_up, n)))
        ang_cam = float(np.degrees(np.arccos(np.clip(c, -1, 1))))
        print("[align] 相机 y 轴与地面法向夹角 %.1f°（接近 0 或 180 说明约定一致）" % ang_cam)

    # 4) 旋转到 y 轴朝上
    up_target = np.array([0.0, 1.0, 0.0])
    R = rot_from_to(n, up_target)
    tilt_before = float(np.degrees(np.arccos(np.clip(abs(float(n[1])), -1, 1))))
    print("[align] 旋转 %.1f°（原法向与水平面夹角）" % tilt_before)

    P2 = (R @ P.T).T
    if traj is not None:
        traj2 = (R @ traj.T).T
    else:
        traj2 = None

    # 5) 平移：起点（轨迹首点 x/z）到原点，地面平均高度归零
    if not args.no_recenter:
        m2 = np.abs(P2 @ up_target - 0.0)  # 重新取地面：用旋转后的最低一层
        h = P2[:, 1]
        ground_h = float(np.percentile(h, 12.0))
        if traj2 is not None and len(traj2):
            x0, z0 = float(traj2[0, 0]), float(traj2[0, 2])
        else:
            x0 = float((P2[:, 0].min() + P2[:, 0].max()) / 2)
            z0 = float((P2[:, 2].min() + P2[:, 2].max()) / 2)
        shift = np.array([-x0, -ground_h, -z0])
    else:
        shift = np.zeros(3)
    P2 = P2 + shift
    if traj2 is not None:
        traj2 = traj2 + shift

    write_ply(args.out, P2, C)
    print("[align] 写出 %s" % args.out)

    info = {"R": R.tolist(), "shift": shift.tolist(), "up_raw": n.tolist(),
            "tilt_deg": tilt_before, "cam_axis_deg": ang_cam, "ground_inliers": inl,
            "convention_before": (pose_obj or {}).get("convention"),
            "bbox_after": [float(x) for x in P2.min(0)] + [float(x) for x in P2.max(0)]}

    if traj2 is not None:
        if args.traj_out:
            json.dump({"X": traj2[:, 0].tolist(), "Y": traj2[:, 1].tolist(), "Z": traj2[:, 2].tolist()},
                      open(args.traj_out, "w", encoding="utf-8"))
            print("[align] 写出轨迹 %s" % args.traj_out)
        dy = np.diff(traj2[:, 1])
        print("[align] 轨迹高度：min %.3f max %.3f  首末差 %.3f  单步最大 |Δh| %.3f"
              % (traj2[:, 1].min(), traj2[:, 1].max(), traj2[-1, 1] - traj2[0, 1],
                 float(np.abs(dy).max()) if len(dy) else 0.0))
        info["traj_h"] = [float(traj2[:, 1].min()), float(traj2[:, 1].max()),
                          float(traj2[-1, 1] - traj2[0, 1])]

    if pose_obj is not None and args.poses_out:
        for p in pose_obj["poses"]:
            c2w = np.asarray(p["c2w"], dtype=np.float64).reshape(4, 4)
            c2w[:3, :3] = R @ c2w[:3, :3]
            c2w[:3, 3] = R @ c2w[:3, 3] + shift
            p["c2w"] = [float(x) for x in c2w.reshape(-1)]
            if "R" in p:
                p["R"] = [float(x) for x in c2w[:3, :3].reshape(-1)]
        pose_obj["convention"] = "c2w_xright_yup_zback(aligned)"
        pose_obj["up_axis"] = "y"
        pose_obj["align"] = {"tilt_deg": tilt_before, "R": R.tolist(), "shift": shift.tolist()}
        json.dump(pose_obj, open(args.poses_out, "w", encoding="utf-8"), ensure_ascii=False)
        print("[align] 写出位姿 %s" % args.poses_out)

    if args.rot_json:
        json.dump(info, open(args.rot_json, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        print("[align] 写出旋转 %s" % args.rot_json)

    if args.render_poses and args.render_poses_out and os.path.exists(args.render_poses):
        rp = json.load(open(args.render_poses, encoding="utf-8"))
        A, st = R, shift
        At = A.T
        for fr in rp.get("frames", rp if isinstance(rp, list) else []):
            Rw = np.asarray(fr["R"], dtype=np.float64).reshape(3, 3)
            tw = np.asarray(fr["t"], dtype=np.float64).reshape(3)
            Rw_new = Rw @ At
            # refrender.mjs 需要 3x3 嵌套；统一输出嵌套
            fr["R"] = [[float(x) for x in row] for row in Rw_new]
            fr["t"] = [float(x) for x in (tw - Rw @ (At @ st))]
        json.dump(rp, open(args.render_poses_out, "w", encoding="utf-8"), ensure_ascii=False)
        print("[align] 写出回渲位姿 %s" % args.render_poses_out)


if __name__ == "__main__":
    main()
