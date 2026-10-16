#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把反推出的点云世界打包成手机/桌面浏览器能直接吃的紧凑二进制，并生成清单。

输出目录:
  <out>/<tag>.bin        二进制点云（见下）
  <out>/manifest.json    场景清单（每个场景的 bbox/点数/起始机位/大小）
  <out>/index.html       查看器（从 tools/world-viewer.html 复制）
  <out>/three.module.min.js

.bin 格式（小端，36 字节头）:
  0  'DLW1'          4 字节 magic
  4  uint32 count    点数
  8  uint32 ntraj    轨迹点数（可为 0）
 12  float32 bbox[6] minx,miny,minz,maxx,maxy,maxz
 36  uint16 pos[count*3]   归一化到 bbox 的坐标
 ..  uint8  rgb[count*3]   sRGB 颜色
 ..  uint16 traj[ntraj*3]  轨迹（同一 bbox 归一化）

坐标已烘焙成 three.js 的 Y-up：MoGe 系 (x,y,h)->(x,h,-y)；OpenCV 系 (x,y,z)->(x,-y,-z)。

用法:
  python tools/make-world.py --out C:\\DLnotebook-media\\tmp\\world --max-pts 600000
"""

import argparse
import json
import os
import shutil
import struct
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import refscene  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
FUSE = r"C:\DLnotebook-media\tmp\fuse"
FUSEALL = r"C:\DLnotebook-media\tmp\fuse-all"
CMP = r"C:\DLnotebook-media\tmp\cmp"

# (tag, 标题, ply, 轨迹文件, up 轴, 说明)
SCENES = [
    ("desert-near", "沙漠 · 走廊带（MoGe 635 帧近景融合，40 万→600k 点）",
     os.path.join(FUSE, "desert-near-fused.ply"), os.path.join(FUSE, "desert-near-traj.json"), "h",
     "只保留相机周围 3 单位、高度 2 以内的稠密点：沿轨迹的连续可飞走廊"),
    ("desert-full", "沙漠 · 全关（MoGe 635 帧融合，900k 点）",
     os.path.join(FUSE, "desert-full-fused.ply"), os.path.join(FUSE, "desert-full-traj.json"), "h",
     "整关融合：相机轨迹 137.5 单位，远处地面较稀"),
    ("desert-win", "沙漠 · 窗口（MoGe 110 帧，780 万点抽稀到 600k）",
     os.path.join(FUSE, "desert-win-fused.ply"), os.path.join(FUSE, "desert-win-traj.json"), "h",
     "一个 110 帧窗口的高密度重建，适合近距离看路面与方块"),
    ("da3m8-341", "沙漠 f00341 · DA3-Giant 8 帧多视图",
     os.path.join(CMP, "da3m", "da3m8-f00341.ply"), os.path.join(CMP, "da3m", "da3m8-poses.json"), "-y",
     "DA3-Giant 用连续 8 帧解出的几何（fp32、process_res 504），带真实相机路径"),
]


def load_ply(path):
    pts, cols = refscene.read_ply(path)
    return np.asarray(pts, dtype=np.float64), np.asarray(cols, dtype=np.uint8)


def traj_points(tpath, up):
    """从 traj.json（X/Y 数组）或 DA3 poses.json（cam_c2w 平移）取轨迹点。"""
    if not tpath or not os.path.exists(tpath):
        return np.zeros((0, 3))
    d = json.load(open(tpath, encoding="utf-8"))
    if "X" in d and "Y" in d:
        X = np.asarray(d["X"], dtype=np.float64)
        Y = np.asarray(d["Y"], dtype=np.float64)
        Z = np.zeros_like(X)                       # 轨迹在地面上，抬到相机高由查看器做
        return np.stack([X, Y, Z], 1)
    cam = []
    for fr in d.get("poses", d.get("frames", [])):
        M = fr.get("cam_c2w")
        if M is not None:
            cam.append([M[0][3], M[1][3], M[2][3]])
        elif fr.get("cam_center") is not None:
            cam.append(fr["cam_center"])
    return np.asarray(cam, dtype=np.float64) if cam else np.zeros((0, 3))


def bake_axes(P, up):
    """-> three.js Y-up"""
    if up == "h":                                  # MoGe 世界系 (x, y, h)
        return np.stack([P[:, 0], P[:, 2], -P[:, 1]], 1)
    if up == "-y":                                 # OpenCV (x, y, z), y 向下
        return np.stack([P[:, 0], -P[:, 1], -P[:, 2]], 1)
    raise SystemExit("未知 up 轴 %s" % up)


def quant(v, lo, hi):
    span = np.where(hi > lo, hi - lo, 1.0)
    q = np.clip((v - lo) / span, 0.0, 1.0) * 65535.0
    return np.round(q).astype(np.uint16)


def build_scene(out, tag, ply, tpath, up, max_pts, seed=0):
    P, C = load_ply(ply)
    T = traj_points(tpath, up)
    if len(T):
        T = bake_axes(T, up)
    n0 = len(P)
    if max_pts and n0 > max_pts:
        rng = np.random.default_rng(seed)
        idx = rng.choice(n0, max_pts, replace=False)
        P, C = P[idx], C[idx]
    P = bake_axes(P, up)
    lo = P.min(0)
    hi = P.max(0)
    if len(T):
        lo = np.minimum(lo, T.min(0))
        hi = np.maximum(hi, T.max(0))
    pos = quant(P, lo, hi).astype("<u2").tobytes()
    rgb = np.ascontiguousarray(C, dtype=np.uint8).tobytes()
    trj = quant(T, lo, hi).astype("<u2").tobytes() if len(T) else b""
    path = os.path.join(out, "%s.bin" % tag)
    with open(path, "wb") as fh:
        fh.write(b"DLW1")
        fh.write(struct.pack("<II", len(P), len(T)))
        fh.write(struct.pack("<6f", *[float(x) for x in lo], *[float(x) for x in hi]))
        fh.write(pos)
        fh.write(rgb)
        fh.write(trj)
    diag = float(np.linalg.norm(hi - lo))
    # 起始机位：轨迹上「局部点云最密」的采样点，看向前方（略微俯视）
    start = None
    if len(T) >= 2:
        n = len(T)
        cand = np.unique(np.linspace(0, n - 1, min(40, n)).astype(int))
        # 自适应「局部密度」半径：太小时（例如 DA3 那种小场景）会一个点都没有
        best, bestc, dense_r = int(cand[0]), -1, None
        for k in (0.02, 0.05, 0.12, 0.25, 0.5, 1.0):
            r = max(k * diag, 1e-6)
            c, bi = max((int((np.linalg.norm(P - T[i], axis=1) < r).sum()), int(i)) for i in cand)
            if c > 0:
                best, bestc, dense_r = bi, c, r
                break
        i0 = best
        step = max(1, n // 20)
        j = i0 + step if i0 + step <= n - 1 else max(0, i0 - step)
        # 1) 沿轨迹往前看；2) 前向退化就回看；3) 仍退化（轨迹本身太短）就看向场景中心
        tgt = T[j]
        if np.linalg.norm(tgt - T[i0]) < 0.05 * diag:
            tgt = T[max(0, i0 - step)] if j != max(0, i0 - step) else (hi + lo) / 2
        if np.linalg.norm(tgt - T[i0]) < 0.02 * diag:
            tgt = (hi + lo) / 2
        drop = 0.10 * max(0.012 * diag, 1e-6)
        eye = T[i0] + np.array([0.0, 0.012 * diag, 0.0])
        look = np.array([tgt[0], tgt[1] + 0.012 * diag - drop, tgt[2]])
        start = {"eye": [float(x) for x in eye], "look": [float(x) for x in look],
                 "dense_idx": i0, "dense_n": bestc, "dense_r": dense_r,
                 "center": [float(x) for x in (hi + lo) / 2]}
    print("[world] %-12s %8d -> %7d 点  bbox %s  轨迹 %d 点  %.1f MB  %s"
          % (tag, n0, len(P), np.round(hi - lo, 2).tolist(), len(T),
             os.path.getsize(path) / 1e6, os.path.basename(ply)))
    return {
        "tag": tag, "file": "%s.bin" % tag, "count": int(len(P)), "ntraj": int(len(T)),
        "bbox": [float(x) for x in lo] + [float(x) for x in hi],
        "diag": diag, "size_hint": 0.0016 * diag, "start": start,
        "bytes": os.path.getsize(path),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=r"C:\DLnotebook-media\tmp\world")
    ap.add_argument("--max-pts", type=int, default=600000)
    ap.add_argument("--only", default="")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    scn = []
    for tag, title, ply, tpath, up, desc in SCENES:
        if args.only and tag not in args.only.split(","):
            continue
        if not os.path.exists(ply):
            print("[world] 缺少 %s，跳过 %s" % (ply, tag))
            continue
        info = build_scene(args.out, tag, ply, tpath, up, args.max_pts)
        info.update({"title": title, "desc": desc, "ply": os.path.basename(ply)})
        scn.append(info)
    man = os.path.join(args.out, "manifest.json")
    old = []
    if os.path.exists(man):
        try:
            old = json.load(open(man, encoding="utf-8")).get("scenes", [])
        except Exception:                                        # noqa: BLE001
            old = []
    have = {s["tag"] for s in scn}
    scn += [s for s in old if s["tag"] not in have]                # 保留本次没重建的
    with open(man, "w", encoding="utf-8") as fh:
        json.dump({"scenes": scn, "built": len(scn)}, fh, ensure_ascii=False, indent=1)
    # 查看器与 three
    for src, dst in [(os.path.join(HERE, "world-viewer.html"), "index.html"),
                     (os.path.join(HERE, "..", "src", "vendor", "three.module.min.js"), "three.module.min.js")]:
        if os.path.exists(src):
            shutil.copyfile(src, os.path.join(args.out, dst))
    total = sum(s["bytes"] for s in scn)
    print("[world] %s  %d 个场景  合计 %.1f MB" % (man, len(scn), total / 1e6))


if __name__ == "__main__":
    main()
