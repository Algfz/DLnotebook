"""refrun-da3.py — 一个场景「DA3 位姿+点云 → 加权体素融合 → 打包成查看器场景」的流水线

用户已认可的方向（2026-10-16 拍板）：沙漠样板走最准路线 ——
DA3-Giant 多视图真位姿 + DA3 多视图点云（实测每帧有效点 ~80% 栅格，比 MoGe 单帧的 ~9% 高一个量级，
且窗内地面高只抖 1.6~2.8%，MoGe 抖 27~48%），再做加权体素（TSDF 风格）融合。

用法（可多段）：
  python tools/refrun-da3.py --pose-out P --fuse-out F --world-out W ^
      --seg "desert-s1=C:\\...\\seq\\desert-s1:0-689" --seg "desert-s2=C:\\...\\seq\\desert-s2:0-309" ^
      --res 392 --voxel 0.004 [--skip-pose] [--max-pts 600000] [--group 沙漠] [--dry]

每段做三件事：
  1) refpose.py   DA3 关键帧位姿 + 点云（--save-points），窗口重叠拼接
  2) reffuse2.py  --from-da3：加权体素融合 + 刚体 ICP → <tag>-fused2.ply / -traj2.json
  3) make-world.py 打包 <tag>.bin + 写 manifest（带 level/scene 两级信息）
"""
import argparse
import glob
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
PY = sys.executable


def run(cmd, tag, step):
    t0 = time.time()
    print("\n[refrun] === %s / %s ===\n[refrun] %s" % (tag, step, " ".join('"%s"' % c if " " in c else c for c in cmd)),
          flush=True)
    r = subprocess.run(cmd, cwd=os.path.dirname(HERE))
    print("[refrun] %s / %s 退出码 %d  用时 %.0fs" % (tag, step, r.returncode, time.time() - t0), flush=True)
    return r.returncode == 0


def merge_manifest(allsc, world_out):
    """把场景清单合进查看器 manifest，并按 level 重新编号 seg/segments。

    每次合并都重算编号：分段分多次跑（例如先跑第 1 段、再跑 2~3 段）时，
    每次只知道本次的段落数，只有统一重算才对得上。
    """
    by_level = {}
    for s in allsc:
        by_level.setdefault(s.get("level") or s["tag"], []).append(s)
    for lv, group in by_level.items():
        group.sort(key=lambda s: (s.get("tStart") if s.get("tStart") is not None else 0.0))
        for i, s in enumerate(group, 1):
            s["seg"] = i
            s["segments"] = len(group)
            s["title"] = "%s · 第 %d 段" % (s.get("levelName") or lv, i)
    if not allsc:
        return
    man = os.path.join(world_out, "manifest.json")
    old = json.load(open(man, encoding="utf-8"))["scenes"] if os.path.exists(man) else []
    bymap = {s["tag"]: s for s in old}
    for s in allsc:
        bymap[s["tag"]] = dict(bymap.get(s["tag"], {}), **s)
    out = list(bymap.values())
    json.dump({"scenes": out, "built": len(out)}, open(man, "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print("[refrun] manifest %d 个场景" % len(out), flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seg", action="append", help='"tag=目录:起始帧-结束帧[@绝对起始秒]"（可多次）')
    ap.add_argument("--pose-out", required=True)
    ap.add_argument("--fuse-out", required=True)
    ap.add_argument("--world-out", required=True)
    ap.add_argument("--group", default="", help="写进 manifest 的分组名（关卡 key，例如 沙漠）")
    ap.add_argument("--group-name", default="", help="分组显示名（缺省=--group）")
    ap.add_argument("--fps", type=float, default=10.0, help="抽帧帧率，用来把帧号换算成秒（默认 10）")
    ap.add_argument("--key-step", type=int, default=2)
    ap.add_argument("--win", type=int, default=16)
    ap.add_argument("--stride", type=int, default=8)
    ap.add_argument("--res", type=int, default=392)
    ap.add_argument("--fov-x", type=float, default=85.58,
                    help="强制水平视场角（真值 85.58°）。DA3 每窗预测的内参能从 50° 跳到 111°，不锁死各窗点云横向尺度就不一致")
    ap.add_argument("--px-step", type=int, default=2)
    ap.add_argument("--voxel", type=float, default=0.004)
    ap.add_argument("--no-align", action="store_true",
                    help="跳过重力对齐（默认融合后会摆正世界并改 up=y）")
    ap.add_argument("--pts-per-frame", type=int, default=80000)
    ap.add_argument("--min-weight", type=int, default=2)
    ap.add_argument("--max-range", type=float, default=20.0)
    ap.add_argument("--icp-iters", type=int, default=0,
                    help="缺省 0：实测 DA3 点云上 ICP 会把相机甩飞（轨迹总长 1.7 → 42.7）")
    ap.add_argument("--max-pts", type=int, default=600000)
    ap.add_argument("--skip-pose", action="store_true")
    ap.add_argument("--merge-only", action="store_true",
                    help="只把 _world-scenes.json 合进 manifest 并重算 seg/segments，不跑位姿/融合")
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()

    if args.merge_only:
        allsc = []
        for f in glob.glob(os.path.join(args.fuse_out, "_world-scenes.json")):
            allsc += json.load(open(f, encoding="utf-8"))
        os.makedirs(args.world_out, exist_ok=True)
        merge_manifest(allsc, args.world_out)
        return
    if not args.seg:
        print("[refrun] 需要至少一个 --seg（或 --merge-only）", flush=True)
        return

    for d in (args.pose_out, args.fuse_out, args.world_out):
        os.makedirs(d, exist_ok=True)
    entries, failed = [], []
    for spec in args.seg:
        tag, rest = spec.split("=", 1)
        # 可选后缀 @绝对起始秒（用于场景在原视频里的真实时间，压缩片段时帧号是相对的）
        t_abs = None
        if "@" in rest:
            rest, t_abs_s = rest.rsplit("@", 1)
            try:
                t_abs = float(t_abs_s)
            except ValueError:
                t_abs = None
        d, rng = rest.rsplit(":", 1)
        entries.append((tag, d, rng, t_abs))
    grp_name = args.group_name or args.group
    total_seg = len(entries)

    for seg_i, (tag, sdir, rng, t_abs) in enumerate(entries, 1):
        try:
            f0, f1 = [int(x) for x in rng.replace("~", "-").split("-", 1)]
            t0, t1 = f0 / args.fps, (f1 + 1) / args.fps
            if t_abs is not None:
                t1 = t_abs + (f1 + 1 - f0) / args.fps
                t0 = t_abs
        except Exception:
            t0 = t1 = None
        if not os.path.isdir(sdir):
            print("[refrun] 目录不存在，跳过 %s: %s" % (tag, sdir), flush=True)
            failed.append(tag)
            continue
        pose = os.path.join(args.pose_out, "%s-pose.json" % tag)
        if not args.skip_pose:
            ok = run([PY, os.path.join(HERE, "refpose.py"), "--dir", sdir, "--tag", tag,
                      "--out", args.pose_out, "--frames", rng, "--key-step", str(args.key_step),
                      "--win", str(args.win), "--stride", str(args.stride),
                      "--process-res", str(args.res), "--save-points", "--px-step", str(args.px_step),
                      "--fov-x", str(args.fov_x)], tag, "位姿+点云")
            if not ok:
                failed.append(tag)
                continue
        if not os.path.exists(pose):
            print("[refrun] 缺 %s，跳过 %s" % (pose, tag), flush=True)
            failed.append(tag)
            continue
        ok = run([PY, os.path.join(HERE, "reffuse2.py"), "--tag", tag, "--from-da3", pose,
                  "--win-dir", args.pose_out, "--out", args.fuse_out, "--voxel", str(args.voxel),
                  "--pts-per-frame", str(args.pts_per_frame), "--icp-iters", str(args.icp_iters),
                  "--min-weight", str(args.min_weight), "--max-range", str(args.max_range)], tag, "融合")
        if not ok:
            failed.append(tag)
            continue
        ply = os.path.join(args.fuse_out, "%s-fused2.ply" % tag)
        traj = os.path.join(args.fuse_out, "%s-traj2.json" % tag)
        up_axis = "-y"
        if not args.no_align:
            ply_a = os.path.join(args.fuse_out, "%s-aligned.ply" % tag)
            traj_a = os.path.join(args.fuse_out, "%s-traj-aligned.json" % tag)
            pose_a = os.path.join(args.pose_out, "%s-pose-aligned.json" % tag)
            rp_in = os.path.join(args.pose_out, "%s-render-poses.json" % tag)
            rp_out = os.path.join(args.fuse_out, "%s-render-poses-aligned.json" % tag)
            cmd = [PY, os.path.join(HERE, "ply-align.py"), "--ply", ply, "--out", ply_a,
                   "--poses", pose, "--poses-out", pose_a,
                   "--traj", traj, "--traj-out", traj_a,
                   "--rot-json", os.path.join(args.fuse_out, "%s-align.json" % tag)]
            if os.path.exists(rp_in):
                cmd += ["--render-poses", rp_in, "--render-poses-out", rp_out]
            if run(cmd, tag, "重力对齐") and os.path.exists(ply_a):
                ply, traj, up_axis = ply_a, traj_a, "y"
        sc = os.path.join(args.fuse_out, "_world-scenes.json")
        items = json.load(open(sc, encoding="utf-8")) if os.path.exists(sc) else []
        stat = {}
        st = os.path.join(args.fuse_out, "%s-fuse2.json" % tag)
        if os.path.exists(st):
            stat = json.load(open(st, encoding="utf-8"))
        items = [it for it in items if it["tag"] != tag]
        items.append({"tag": tag, "title": "%s · 第 %d 段" % (grp_name or tag, seg_i),
                      "ply": ply, "traj": traj, "up": up_axis,
                      "desc": "DA3-Giant 多视图真位姿 + 加权体素融合（体素 %s，%d 点）"
                              % (stat.get("voxel"), stat.get("voxels") or 0),
                      "level": args.group or tag, "levelName": grp_name or tag,
                      "seg": seg_i, "segments": total_seg,
                      "tStart": t0, "tEnd": t1, "frames": rng})
        json.dump(items, open(sc, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        ok = run([PY, os.path.join(HERE, "make-world.py"), "--out", args.world_out,
                  "--max-pts", str(args.max_pts), "--scenes-json", sc, "--only", tag], tag, "打包查看器")
        if not ok:
            failed.append(tag)
        # 俯视图（给报告/验收用）
        run([PY, os.path.join(HERE, "ply-top.py"), "--ply", ply,
             "--out", os.path.join(args.fuse_out, "%s-top.png" % tag),
             "--traj", traj, "--plane", "xz", "--px", "1000", "--title", tag], tag, "俯视图")

    # 合并本组所有场景的清单（供查看器按组展示）
    allsc = []
    for f in glob.glob(os.path.join(args.fuse_out, "_world-scenes.json")):
        allsc += json.load(open(f, encoding="utf-8"))
    merge_manifest(allsc, args.world_out)
    print("[refrun] 失败/跳过: %s" % (failed or "无"), flush=True)


if __name__ == "__main__":
    main()
