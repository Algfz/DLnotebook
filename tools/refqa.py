#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""样板验收一键体检：融合统计 + 粗糙度指标 + 俯视图 + 同机位回渲对比真值

用法：
  python tools\\refqa.py --tag desert-s1 ^
     --fuse-dir C:\\DLnotebook-media\\tmp\\fuse5 --pose-dir C:\\DLnotebook-media\\tmp\\poseda3 ^
     --truth-dir C:\\DLnotebook-media\\tmp\\seq\\desert-s1 --frames 0,48,96,144
"""
import argparse
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PY = sys.executable
NODE = r"C:\Program Files\nodejs\node.exe"
MONTAGE = os.path.join(HERE, "montage2.py")
TOP = os.path.join(HERE, "ply-top.py")
ROUGH = os.path.join(HERE, "ply-rough.py")
RENDER = os.path.join(HERE, "refrender.mjs")


def run(cmd, **kw):
    p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", **kw)
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", required=True)
    ap.add_argument("--fuse-dir", required=True)
    ap.add_argument("--pose-dir", required=True)
    ap.add_argument("--truth-dir", default="")
    ap.add_argument("--out", default="")
    ap.add_argument("--frames", default="0,48,96")
    ap.add_argument("--fov-y", type=float, default=55.0)
    ap.add_argument("--point-size", type=float, default=0.01)
    ap.add_argument("--max-points", type=int, default=600000)
    ap.add_argument("--no-render", action="store_true")
    args = ap.parse_args()

    out = args.out or os.path.join(args.fuse_dir, "qa")
    os.makedirs(out, exist_ok=True)
    ply = os.path.join(args.fuse_dir, "%s-fused2.ply" % args.tag)
    poses = os.path.join(args.pose_dir, "%s-render-poses.json" % args.tag)
    traj = os.path.join(args.fuse_dir, "%s-traj2.json" % args.tag)
    js = os.path.join(args.fuse_dir, "%s-fuse2.json" % args.tag)
    if not os.path.exists(ply):
        print("缺 %s" % ply)
        return 1

    if os.path.exists(js):
        d = json.load(open(js, encoding="utf-8"))
        print("=== 融合统计 ===")
        print("  帧 %s  用点 %s  体素(>=%s 点) %s  体素边长 %s  配准帧 %s" %
              (d.get("frames"), d.get("used_points"), d.get("min_weight"), d.get("voxels"),
               d.get("voxel"), d.get("refined_frames")))
        b = d.get("bbox") or []
        if len(b) == 6:
            print("  包围盒 %.2f×%.2f×%.2f" % (b[3] - b[0], b[4] - b[1], b[5] - b[2]))

    print("=== 粗糙度（局部平面厚度，按对角线归一后才可跨尺度比较）===")
    for rf in (0.012, 0.025):
        rc, o = run([PY, ROUGH, "--ply", ply, "--r-frac", str(rf), "--sample", "150000"])
        for ln in o.strip().splitlines():
            if "厚度" in ln or "太稀" in ln:
                print("  " + ln.strip())

    rc, o = run([PY, TOP, "--ply", ply, "--out", os.path.join(out, "%s-top.png" % args.tag),
                 "--traj", traj, "--plane", "xz", "--px", "900", "--title", args.tag])
    print("=== 俯视图 ===\n  " + o.strip())

    if args.no_render or not os.path.exists(poses):
        print("跳过同机位回渲（--no-render 或缺 %s）" % poses)
        return 0
    items, nrow = [], 0
    for fs in args.frames.split(","):
        fs = fs.strip()
        if not fs:
            continue
        i = int(fs)
        rp = os.path.join(out, "%s-render-f%04d.png" % (args.tag, i))
        rc, o = run([NODE, RENDER, "--cloud", ply, "--poses", poses, "--frame", str(i),
                     "--fov-y", str(args.fov_y), "--point-size", str(args.point_size),
                     "--max-points", str(args.max_points), "--bg", "0xf0d24b", "--out", rp])
        ok = os.path.exists(rp)
        print("  回渲 f%04d %s %s" % (i, "OK" if ok else "失败", "" if ok else o.strip()[-160:]))
        if not ok:
            continue
        nrow += 1
        if args.truth_dir:
            tf = os.path.join(args.truth_dir, "f%05d.jpg" % (i + 1))
            if os.path.exists(tf):
                items += ["--item", "真值 t%.1fs|%s" % (i / 10.0, tf)]
            else:
                items += ["--item", "真值缺失 f%05d|%s" % (i + 1, tf)]
        items += ["--item", "新管线 f%04d|%s" % (i, rp)]
    if items:
        cols = 2 if args.truth_dir else 1
        mp = os.path.join(out, "%s-render-cmp.png" % args.tag)
        rc, o = run([PY, MONTAGE, "--out", mp, "--tile", "%dx%d" % (cols, max(1, nrow)),
                     "--geom", "620x350"] + items)
        print("  拼图 " + (mp if os.path.exists(mp) else "失败 " + o.strip()[-160:]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
