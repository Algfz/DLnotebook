#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""全量按场景重跑：读 tmp\\shots\\*-shots.json → 每个可用场景抽帧 → 调 refrun-da3.py（位姿+点云+fuse+打包）

用法（先 dry-run 看清单，再实跑）：
  python tools\\refrun-all.py --dry
  python tools\\refrun-all.py --levels lv38 --min-seg 3          # 只跑沙漠样板
  python tools\\refrun-all.py --res 280 --key-step 4 --stride 12 # 夜间全量（省时档）

行为：
  * 场景筛选：seconds >= --min-seg，按时间从长到短最多取 --max-seg-per-level 段（0=全部）
  * 抽帧：ffmpeg -ss <t0+pad-start> -t <dur-pad> -i <src> -vf fps=<fps> -q:v 2 <seq>\\f%05d.jpg
  * 每关一次 refrun-da3.py，场景序号即 manifest 里的「第 N 段」
  * 断点续跑：<fuse-out>\\<tag>-fused2.ply 已存在且比 shots.json 新就跳过该段
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
FFMPEG = r"C:\ffmpeg\ffmpeg-8.1.1-full_build\bin\ffmpeg.exe"


def log(*a):
    print("[runall]", *a, flush=True)


def run(cmd, tag="", what=""):
    t0 = time.time()
    p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    el = time.time() - t0
    ok = p.returncode == 0
    log("%s %s %s (%.1fs)" % ("OK  " if ok else "FAIL", tag, what, el))
    if not ok:
        tail = (p.stderr or p.stdout or "").strip().splitlines()[-8:]
        for ln in tail:
            log("   | " + ln)
    return ok


def extract(src, dst, t0, dur, fps, ffmpeg, force=False):
    os.makedirs(dst, exist_ok=True)
    have = glob.glob(os.path.join(dst, "f*.jpg"))
    want = max(1, int(round(dur * fps)))
    if have and not force and abs(len(have) - want) <= max(3, want * 0.1):
        log("  抽帧已存在 %d 帧，跳过" % len(have))
        return len(have)
    if force or have:
        for f in have:
            try:
                os.remove(f)
            except OSError:
                pass
    cmd = [ffmpeg, "-y", "-v", "error", "-ss", "%.3f" % t0, "-t", "%.3f" % dur, "-i", src,
           "-vf", "fps=%g" % fps, "-q:v", "2", os.path.join(dst, "f%05d.jpg")]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    except FileNotFoundError:
        log("  ffmpeg 不存在: %s" % ffmpeg)
        return 0
    n = len(glob.glob(os.path.join(dst, "f*.jpg")))
    if r.returncode != 0 or n == 0:
        log("  抽帧失败 rc=%s %s" % (r.returncode, (r.stderr or "").strip()[:200]))
        return 0
    log("  抽帧 %d 帧 -> %s" % (n, os.path.basename(dst)))
    return n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shots-dir", default=r"C:\DLnotebook-media\tmp\shots")
    ap.add_argument("--seq-root", default=r"C:\DLnotebook-media\tmp\seq2")
    ap.add_argument("--pose-out", default=r"C:\DLnotebook-media\tmp\poseda3")
    ap.add_argument("--fuse-out", default=r"C:\DLnotebook-media\tmp\fuse5")
    ap.add_argument("--world-out", default=r"C:\DLnotebook-media\tmp\world")
    ap.add_argument("--levels", default="", help="逗号分隔的 tag 白名单（例如 lv38,lv09）")
    ap.add_argument("--min-seg", type=float, default=3.0, help="短于此秒数的场景丢弃")
    ap.add_argument("--pad-start", type=float, default=1.5, help="每个场景开头裁掉的秒数（转场/黑场）")
    ap.add_argument("--pad-end", type=float, default=0.3)
    ap.add_argument("--max-seg-per-level", type=int, default=0, help="0=不限制")
    ap.add_argument("--fps", type=float, default=10.0)
    ap.add_argument("--ffmpeg", default=FFMPEG)
    ap.add_argument("--res", type=int, default=392)
    ap.add_argument("--key-step", type=int, default=2)
    ap.add_argument("--win", type=int, default=16)
    ap.add_argument("--stride", type=int, default=8)
    ap.add_argument("--fov-x", type=float, default=85.58)
    ap.add_argument("--voxel", type=float, default=0.004)
    ap.add_argument("--pts-per-frame", type=int, default=80000)
    ap.add_argument("--min-weight", type=int, default=2)
    ap.add_argument("--max-range", type=float, default=20.0)
    ap.add_argument("--max-pts", type=int, default=600000)
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--cost-table", action="store_true", help="打印各档位耗时估算")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    allow = set(x.strip() for x in args.levels.split(",") if x.strip())
    shots = sorted(glob.glob(os.path.join(args.shots_dir, "*-shots.json")))
    stfile = os.path.join(args.fuse_out, "_runall.json")
    state = json.load(open(stfile, encoding="utf-8")) if os.path.exists(stfile) else {}

    plan = []
    for sp in shots:
        d = json.load(open(sp, encoding="utf-8"))
        tag = d.get("tag") or os.path.basename(sp).replace("-shots.json", "")
        if allow and tag not in allow:
            continue
        src = d.get("src") or ""
        if not src or not os.path.exists(src):
            log("跳过 %s：源视频不存在 %s" % (tag, src))
            continue
        segs = []
        for s in d.get("scenes") or []:
            sec = float(s.get("seconds") or (s.get("t_end", 0) - s.get("t_start", 0)))
            if sec < args.min_seg:
                continue
            t0 = float(s.get("t_start", 0)) + args.pad_start
            t1 = float(s.get("t_end", 0)) - args.pad_end
            if t1 - t0 < args.min_seg * 0.5:
                continue
            segs.append({"idx": s.get("idx"), "t0": t0, "t1": t1, "sec": t1 - t0})
        segs.sort(key=lambda x: -x["sec"])
        if args.max_seg_per_level:
            segs = segs[: args.max_seg_per_level]
        segs.sort(key=lambda x: x["t0"])
        if not segs:
            continue
        plan.append({"tag": tag, "name": d.get("name") or tag, "src": src,
                     "shots": sp, "segs": segs,
                     "total_play": sum(x["sec"] for x in segs)})

    # 估算：3.1 s/关键帧（res 392, key-step 2），关键帧数 ≈ fps/key-step * 秒
    kps = args.fps / max(1, args.key_step)
    cost = 0.0
    log("关卡 %d 个，场景 %d 段，可用素材 %.1f 分钟" %
        (len(plan), sum(len(p["segs"]) for p in plan),
         sum(p["total_play"] for p in plan) / 60))
    for p in plan[:12]:
        log("  %-6s %-10s %d 段 %5.1fs  %s" %
            (p["tag"], p["name"][:10], len(p["segs"]), p["total_play"],
             " ".join("%.0f-%.0fs" % (s["t0"], s["t1"]) for s in p["segs"][:4])))
    if len(plan) > 12:
        log("  ... 其余 %d 个关卡" % (len(plan) - 12))
    # 实测基准：res 392 / win16 / stride 8 时 3.1 s/关键帧（含窗重叠冗余 16/8=2）
    sec_per_key = 3.1 * (args.res / 392.0) ** 2 * ((float(args.win) / args.stride) / (16.0 / 8.0))
    total_key = sum(p["total_play"] for p in plan) * kps
    est = total_key * sec_per_key / 3600.0
    log("关键帧约 %.0f 个；按 res=%d/win=%d/stride=%d/key-step=%d 估 **%.1f 小时**（不含融合/打包，约 +10%%）"
        % (total_key, args.res, args.win, args.stride, args.key_step, est))
    if args.cost_table:
        base_play = sum(p["total_play"] for p in plan)
        log("---- 成本档位（同一批 %.1f 分钟素材）----" % (base_play / 60))
        for res in (392, 336, 280, 224):
            for step in (2, 4, 6):
                for stride in (8, 12):
                    k = base_play * (args.fps / step)
                    s = 3.1 * (res / 392.0) ** 2 * ((float(args.win) / stride) / (16.0 / 8.0))
                    log("   res %-3d step %d stride %-2d ⇒ 关键帧 %6.0f  约 %5.1f 小时"
                        % (res, step, stride, k, k * s / 3600.0))
    if args.dry:
        log("dry-run，不执行")
        return

    t_all = time.time()
    for pi, p in enumerate(plan, 1):
        tag = p["tag"]
        log("=== [%d/%d] %s %s ===" % (pi, len(plan), tag, p["name"]))
        seg_args, oksegs = [], []
        for si, s in enumerate(p["segs"], 1):
            st = "%s-s%d" % (tag, si)
            dst = os.path.join(args.seq_root, st)
            ply = os.path.join(args.fuse_out, "%s-fused2.ply" % st)
            if (not args.force) and os.path.exists(ply) and \
                    os.path.getmtime(ply) > os.path.getmtime(p["shots"]):
                log("  第 %d 段已完成，跳过" % si)
                continue
            n = extract(p["src"], dst, s["t0"], s["t1"] - s["t0"], args.fps, args.ffmpeg, args.force)
            if n < max(8, int(args.fps)):
                log("  第 %d 段帧数过少(%d)，跳过" % (si, n))
                continue
            seg_args += ["--seg", "%s=%s:0-%d" % (st, dst, n - 1)]
            oksegs.append({"tag": st, "idx": s["idx"], "t0": s["t0"], "t1": s["t1"], "frames": n})
        if not seg_args:
            log("  本关无待跑场景")
            continue
        # 每关重建一次 _world-scenes.json（只留本关的段，避免旧序号串台）
        sc = os.path.join(args.fuse_out, "_world-scenes.json")
        if os.path.exists(sc):
            old = json.load(open(sc, encoding="utf-8"))
            old = [it for it in old if it.get("level") != tag]
            json.dump(old, open(sc, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        cmd = [PY, os.path.join(HERE, "refrun-da3.py")] + seg_args + [
            "--pose-out", args.pose_out, "--fuse-out", args.fuse_out,
            "--world-out", args.world_out, "--group", tag, "--group-name", p["name"],
            "--fps", str(args.fps), "--res", str(args.res), "--key-step", str(args.key_step),
            "--win", str(args.win), "--stride", str(args.stride), "--fov-x", str(args.fov_x),
            "--voxel", str(args.voxel), "--pts-per-frame", str(args.pts_per_frame),
            "--min-weight", str(args.min_weight), "--max-range", str(args.max_range),
            "--max-pts", str(args.max_pts)]
        ok = run(cmd, tag, "位姿+融合+打包（%d 段）" % len(oksegs))
        state[tag] = {"ok": ok, "segs": oksegs, "when": time.strftime("%H:%M:%S")}
        json.dump(state, open(stfile, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    log("全部结束，用时 %.1f 分钟" % ((time.time() - t_all) / 60))


if __name__ == "__main__":
    main()
