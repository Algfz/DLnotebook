#!/usr/bin/env python
"""点云 + 相机轨迹 -> 路径中心线 + 路宽 W (把一切长度归一到 W).

  python tools/refpath.py --tag desert-a --frames "C:\\DLnotebook-media\\tmp\\seq\\desert-a"

思路:
  1) 世界 up: 用相邻帧朝向(相机 z 轴)的旋转轴 —— 路径转弯的转轴就是重力方向 (无需地平假设);
  2) 地面: 沿路径附近点云在 up 上的高度直方图主峰;
  3) 路面: 每帧 HSV 阈值 (低饱和/高亮) 得到路面掩膜, 把点云投影到最近帧筛出"路面点";
  4) 路径中心线: 对路面点按弧长分箱取中位数 -> 折线; 路宽 W = 路面点横向展布 (2×p75);
  5) 输出 <tag>-path.json (折线/弧长/每帧弧长/地面/W/相机高度) + 顶视校验图.
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


def world_up_from_headings(Rs):
    """相邻帧朝向的旋转轴 ≈ 世界 up (路径转弯为主)."""
    heads = Rs[:, 2, :]                      # 相机 z 轴在世界系中的方向
    axes = []
    for i in range(len(heads) - 1):
        h0, h1 = heads[i], heads[i + 1]
        c = np.cross(h0, h1)
        n = np.linalg.norm(c)
        if n > 1e-3:
            axes.append(c / n)
    if not axes:
        return np.array([0.0, 1.0, 0.0]), 0.0
    A = np.array(axes)
    mean = A.mean(0)
    mean /= max(np.linalg.norm(mean), 1e-9)
    for i in range(len(A)):                  # 统一朝向
        if A[i] @ mean < 0:
            A[i] = -A[i]
    up = A.mean(0)
    up /= max(np.linalg.norm(up), 1e-9)
    res = float(np.mean([math.acos(min(1.0, abs(a @ up))) for a in A]))
    return up, res


def road_mask(img):
    """路面: 低饱和 + 高亮 (ETW 关卡路面普遍是浅色中性带)."""
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    s, v = hsv[..., 1].astype(np.float32), hsv[..., 2].astype(np.float32)
    m = ((s < 70) & (v > 195)).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    return m.astype(bool)


def resample_polyline(P, s, step):
    """按弧长等距重采样折线, 返回 (点, 弧长)."""
    out_pts, out_s = [P[0]], [0.0]
    target = step
    acc = 0.0
    for i in range(1, len(P)):
        seg = P[i] - P[i - 1]
        L = np.linalg.norm(seg)
        while L > 1e-9 and acc + L >= target:
            f = (target - acc) / L
            out_pts.append(P[i - 1] + f * seg)
            out_s.append(target)
            target += step
        acc += L
    return np.array(out_pts), np.array(out_s)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", required=True)
    ap.add_argument("--frames", required=True, help="原始帧目录 (与 refseq 同源)")
    ap.add_argument("--out", default=os.path.join("out", "tmp", "ref-scene"))
    ap.add_argument("--bin", type=float, default=None, help="弧长分箱 (默认 W/2)")
    ap.add_argument("--no-viz", action="store_true")
    args = ap.parse_args()

    out = os.path.abspath(args.out)
    with open(os.path.join(out, "%s-poses.json" % args.tag), encoding="utf-8") as f:
        pj = json.load(f)
    poses = pj["frames"]
    P, C = rs.read_ply(os.path.join(out, "%s-cloud.ply" % args.tag))
    rs.log("[refpath] %d poses, %d points" % (len(poses), len(P)))

    Rs = np.array([p["R"] for p in poses])
    Cc = np.array([p["cam_center"] for p in poses])
    up, up_res = world_up_from_headings(Rs)
    rs.log("[refpath] up=(%.3f,%.3f,%.3f) 朝向-转轴残差 %.2f deg" % (*up, math.degrees(up_res)))

    # 水平基 (e1 = 首帧朝向在水平面的投影)
    h0 = Rs[0, 2, :] - (Rs[0, 2, :] @ up) * up
    if np.linalg.norm(h0) < 1e-6:
        h0 = np.array([1.0, 0.0, 0.0])
    e1 = h0 / np.linalg.norm(h0)
    e2 = np.cross(up, e1)
    rs.log("[refpath] e1=(%.3f,%.3f,%.3f) e2=(%.3f,%.3f,%.3f)" % (*e1, *e2))

    # 地面高度: 相机附近点云在 up 上的主峰
    cam_h = (Cc - Cc.mean(0)) @ up * 0 + (Cc @ up)
    near = np.linalg.norm((P - Cc.mean(0)) - (((P - Cc.mean(0)) @ up)[:, None] * up), axis=1) < 12.0
    u = P[near] @ up if near.any() else P @ up
    hist, edges = np.histogram(u, bins=200)
    ground = float(0.5 * (edges[int(np.argmax(hist))] + edges[int(np.argmax(hist)) + 1]))
    height_cam = float(np.median(cam_h) - ground)
    rs.log("[refpath] 地面 up=%.3f, 相机离地中位 %.3f (世界单位)" % (ground, height_cam))

    # 路面点: 每帧掩膜 + 投影
    files = sorted(glob.glob(os.path.join(args.frames, "*.jpg")))
    by_name = {os.path.basename(f): f for f in files}
    road_flags = np.zeros(len(P), bool)
    lat_all, ab_all, valid = [], [], np.zeros(len(P), bool)
    e1a, e2a = P @ e1, P @ e2
    for p in poses:
        fp = by_name.get(p["frame"])
        if fp is None:
            continue
        img = rs.imread_u(fp)
        if img is None:
            continue
        m = road_mask(img)
        K = np.array([[p["fx"], 0, 1554.0 * 0 + 0], [0, p["fy"], 0], [0, 0, 1.0]])
        # 用预处理尺寸 (518x291) 的内参与图像尺寸的比例还原像素内参
        H, W = img.shape[:2]
        # VGGT 内参对应预处理图 (W0 = 518, H0 = round(H*518/W)) —— 由 poses 里 fov 反推
        fov_x = math.radians(p["fov_x_deg"])
        fx = 0.5 * W / math.tan(0.5 * fov_x)
        fy = fx
        K = np.array([[fx, 0, W / 2], [0, fy, H / 2], [0, 0, 1.0]])
        R, t = np.array(p["R"]), np.array(p["t"])
        cam = P @ R.T + t
        z = cam[:, 2]
        ok = z > 1e-6
        uv = (cam @ K.T)[:, :2] / np.maximum(z[:, None], 1e-6)
        ui = np.round(uv[:, 0]).astype(np.int32)
        vi = np.round(uv[:, 1]).astype(np.int32)
        inbox = ok & (ui >= 0) & (ui < W) & (vi >= 0) & (vi < H)
        idx = np.flatnonzero(inbox)
        hit = m[vi[idx], ui[idx]]
        road_flags[idx[hit]] = True
        valid[idx] = True

    road = road_flags
    rs.log("[refpath] 路面点 %d / 有效投影 %d" % (int(road.sum()), int(valid.sum())))
    if road.sum() < 500:
        rs.log("[refpath] 警告: 路面点太少, 路宽/中心线不可靠")

    # 路径: 相机中心投影到地面 + 平滑
    path3 = Cc - ((Cc @ up - ground)[:, None] * up)
    pa, pb = path3 @ e1, path3 @ e2
    P2 = np.stack([pa, pb], 1)
    # 平滑 (滑动平均)
    k = 5
    ker = np.ones(k) / k
    P2s = np.stack([np.convolve(P2[:, 0], ker, mode="same"), np.convolve(P2[:, 1], ker, mode="same")], 1)
    P2s[: k // 2] = P2[: k // 2]
    P2s[-(k // 2):] = P2[-(k // 2):]
    d = np.linalg.norm(np.diff(P2s, axis=0), axis=1)
    s_frame = np.concatenate([[0.0], np.cumsum(d)])
    total_len = float(s_frame[-1])
    # 等距重采样
    step = total_len / 400.0
    Pl, sl = resample_polyline(P2s, s_frame, step)
    rs.log("[refpath] 路径长 %.3f 世界单位, 重采样 %d 点 (step %.4f)" % (total_len, len(Pl), step))

    # 路宽: 路面点到路径的横向距离
    if road.sum() > 100:
        R2 = np.stack([e1a[road], e2a[road]], 1)
        # 最近路径点
        d2 = ((R2[:, None, :] - Pl[None, :, :]) ** 2).sum(-1)
        j = np.argmin(d2, axis=1)
        # 局部切向与法向
        jn = np.clip(j + 1, 0, len(Pl) - 1)
        tan = Pl[jn] - Pl[j]
        nrm = np.linalg.norm(tan, axis=1, keepdims=True)
        tan = tan / np.maximum(nrm, 1e-9)
        nor = np.stack([-tan[:, 1], tan[:, 0]], 1)
        lat = ((R2 - Pl[j]) * nor).sum(1)
        W = float(2.0 * np.percentile(np.abs(lat), 75))
        lat_med = float(np.median(np.abs(lat)))
        rs.log("[refpath] 路宽 W=%.3f 世界单位 (p75 横向 %.3f, 中位 %.3f, 样本 %d)"
               % (W, np.percentile(np.abs(lat), 75), lat_med, len(lat)))
    else:
        W, lat = float("nan"), np.zeros(0)

    meta = {
        "tag": args.tag, "up": up.tolist(), "up_resid_deg": math.degrees(up_res),
        "e1": e1.tolist(), "e2": e2.tolist(), "ground_up": ground,
        "cam_height_world": height_cam,
        "road_width_W_world": W,
        "path_len_world": total_len,
        "path_ab": Pl.tolist(), "path_s": sl.tolist(),
        "frame_s": s_frame.tolist(),
        "frames": [p["frame"] for p in poses],
        "cam_height_W": (height_cam / W) if (W and not math.isnan(W)) else None,
        "path_len_W": (total_len / W) if (W and not math.isnan(W)) else None,
    }
    with open(os.path.join(out, "%s-path.json" % args.tag), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    if not args.no_viz and len(P):
        # 顶视: 点云(灰) + 路面点(白) + 路径(红) + 路宽带(青)
        A, B = P @ e1, P @ e2
        U = P @ up
        sel = np.random.RandomState(0).choice(len(P), min(len(P), 400000), replace=False)
        img = np.full((900, 900, 3), 255, np.uint8)
        a, b = A[sel], B[sel]
        lo_a, hi_a = np.percentile(a, [1, 99])
        lo_b, hi_b = np.percentile(b, [1, 99])
        sc = 860.0 / max(hi_a - lo_a, hi_b - lo_b, 1e-6)

        def px(xa, xb):
            return (60 + (xa - lo_a) * sc).astype(np.int32), (860 - (xb - lo_b) * sc).astype(np.int32)

        order = np.argsort(U[sel])
        xi, yi = px(a[order], b[order])
        img[yi, xi] = (170, 170, 170)
        if road.sum():
            ro = np.flatnonzero(road)[:200000]
            xi, yi = px(A[ro], B[ro])
            img[yi, xi] = (40, 40, 40)
        xi, yi = px(Pl[:, 0], Pl[:, 1])
        for i in range(len(xi) - 1):
            cv2.line(img, (xi[i], yi[i]), (xi[i + 1], yi[i + 1]), (0, 0, 255), 2)
        xi, yi = px(pa, pb)
        for i in range(len(xi) - 1):
            cv2.line(img, (xi[i], yi[i]), (xi[i + 1], yi[i + 1]), (255, 100, 0), 1)
        rs.imwrite_u(os.path.join(out, "%s-path.png" % args.tag), img)
        rs.log("[refpath] 顶视校验图 %s-path.png" % args.tag)

    rs.log("[refpath] done -> %s-%s.json/png" % (args.tag, "path"))


if __name__ == "__main__":
    main()
