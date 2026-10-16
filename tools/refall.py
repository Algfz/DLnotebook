"""refall.py — 把反推流水线在**所有官方关卡**上批量跑一遍

对每个关卡目录（`<root>/<关卡名>/<关卡名>_src.mp4`）：
  1. ffmpeg 抽帧（fps=5）→ <work>/frames/<tag>/f%05d.jpg
  2. refcache.py（一批关卡共用一次模型加载）→ <work>/cache/<tag>-<fname>.npz
  3. reffuse.py → <out>/<tag>-fused.ply / -top.png / -traj.json
  4. 删掉该关的帧与 npz（省盘），把一行结果写进 <out>/summary.md

可续跑：已有 <tag>-fused.ply 的关卡直接跳过（按 --order 重新编号会变，所以用 --map 固定）。

用法：
  $env:PYTHONPATH="C:\\D\\DLnotebook\\tools"
  python tools\\refall.py --limit 3 --workers 3            # 先试三关
  python tools\\refall.py                                   # 全量 62 关
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PY = sys.executable


def run(cmd, log_path=None, quiet=True):
    t0 = time.time()
    # 子进程必须强制 UTF-8 输出：Windows 上重定向到管道时 Python 默认用 cp936，
    # 中文日志会被下面的 utf-8 解码吃成乱码 -> 正则匹配不到 "原始 N 点"（raw/vox 恒为 0）。
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                       encoding="utf-8", errors="replace", env=env)
    out = p.stdout or ""
    if log_path:
        with open(log_path, "a", encoding="utf-8") as f:
            f.write("$ " + " ".join(str(c) for c in cmd) + "\n" + out + "\n")
    if p.returncode != 0 and not quiet:
        print(out[-2000:])
    return p.returncode, out, time.time() - t0


def find_src(level_dir):
    for f in os.listdir(level_dir):
        if f.lower().endswith(".mp4") and "_src" in f:
            return os.path.join(level_dir, f)
    for f in os.listdir(level_dir):
        if f.lower().endswith(".mp4"):
            return os.path.join(level_dir, f)
    return None


def probe_duration(src):
    try:
        p = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                            "-of", "csv=p=0", src], stdout=subprocess.PIPE, text=True)
        return float((p.stdout or "0").strip() or 0)
    except Exception:
        return 0.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=r"C:\DLnotebook-media\ref_official2")
    ap.add_argument("--work", default=r"C:\DLnotebook-media\tmp\refall")
    ap.add_argument("--out", default=os.path.join(ROOT, "out", "tmp", "fuse-all"))
    ap.add_argument("--fps", type=float, default=5.0)
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--px-step", type=int, default=2)
    ap.add_argument("--voxel", type=float, default=0.02)
    ap.add_argument("--max-h", type=float, default=4.0)
    ap.add_argument("--max-pts", type=int, default=1500000)
    ap.add_argument("--batch", type=int, default=8, help="一次缓存多少个关卡（控盘）")
    ap.add_argument("--limit", type=int, default=0, help="只跑前 N 关（0=全部）")
    ap.add_argument("--only", default=None, help="只跑这些关卡名（逗号分隔）")
    ap.add_argument("--sign-t", type=float, default=-1)
    ap.add_argument("--sign-yaw", type=float, default=-1)
    ap.add_argument("--keep-frames", action="store_true")
    args = ap.parse_args()

    levels = []
    for name in sorted(os.listdir(args.root)):
        d = os.path.join(args.root, name)
        if not os.path.isdir(d):
            continue
        src = find_src(d)
        if src:
            levels.append((name, d, src, probe_duration(src)))
    all_levels = list(levels)                            # tag 编号必须基于**全部**关卡，
    if args.only:                                        # 否则换个子集(如 --limit)就会串号
        want = {s.strip() for s in args.only.split(",")}
        levels = [lv for lv in levels if lv[0] in want]
    levels.sort(key=lambda t: t[3])                      # 短关卡先跑，早出结果
    if args.limit:
        levels = levels[:args.limit]

    os.makedirs(args.work, exist_ok=True)
    os.makedirs(args.out, exist_ok=True)
    mapping_path = os.path.join(args.out, "map.json")
    mapping = json.load(open(mapping_path, encoding="utf-8")) if os.path.exists(mapping_path) else {}

    # 固定 tag：按**全部关卡名称排序**编号，续跑/换子集都不会串号；老 map 有重号/漏号时自愈重建
    all_names = sorted(lv[0] for lv in all_levels)
    fresh = {n: "lv%02d" % i for i, n in enumerate(all_names, 1)}
    inv, broken = {}, False
    for n, t in mapping.items():
        if t in inv:
            broken = True
        inv[t] = n
    if broken or len(mapping) != len(fresh) or any(mapping.get(n) != fresh[n] for n in fresh):
        print("[all] map.json 重建（原 %d 条，重号/错位 => 全量重编）" % len(mapping), flush=True)
        mapping = fresh
    json.dump(mapping, open(mapping_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    summary_path = os.path.join(args.out, "summary.md")
    if not os.path.exists(summary_path):
        with open(summary_path, "w", encoding="utf-8") as f:
            f.write("# 全量关卡反推（MoGe 逐帧 → 稠密融合）\n\n"
                    "| # | 关卡 | tag | 帧数 | 原始点 | 体素后点 | 路径(单位) | 均速(单位/s) | 耗时 |\n"
                    "|--:|---|---|--:|--:|--:|--:|--:|--:|\n")

    todo = [(n, d, s, dur) for (n, d, s, dur) in levels
            if not os.path.exists(os.path.join(args.out, "%s-fused.ply" % mapping[n]))]
    total_frames = sum(dur * args.fps for (_, _, _, dur) in todo)
    print("[all] 待跑 %d 关 / 共 %.0f 秒视频 → 约 %.0f 帧；预计 MoGe %.0f 分钟"
          % (len(todo), sum(d for *_, d in todo), total_frames, total_frames / 4.8 / 60), flush=True)

    t_start = time.time()
    for bi in range(0, len(todo), args.batch):
        group = todo[bi:bi + args.batch]
        print("\n[all] === 批次 %d/%d：%s ==="
              % (bi // args.batch + 1, (len(todo) + args.batch - 1) // args.batch,
                 ", ".join(n for n, *_ in group)), flush=True)
        # 1) 抽帧
        dirs, tags, kept = [], [], []
        for name, d, src, dur in group:
            tag = mapping[name]
            fdir = os.path.join(args.work, "frames", tag)
            if not os.path.isdir(fdir) or len(os.listdir(fdir)) < 5:
                os.makedirs(fdir, exist_ok=True)
                rc, out, el = run(["ffmpeg", "-y", "-v", "error", "-i", src,
                                   "-vf", "fps=%g,format=yuvj420p" % args.fps, "-q:v", "3",
                                   os.path.join(fdir, "f%05d.jpg")])
                print("[all]   %s(%s) 抽帧 %.0fs" % (name, tag, el), flush=True)
            dirs.append(fdir)
            tags.append(tag)
            kept.append((name, tag, dur))
        # 2) 并行缓存（一次加载模型，覆盖本批所有关卡）
        rc, out, el = run([PY, os.path.join(HERE, "refcache.py"),
                           "--cache", os.path.join(args.work, "cache"),
                           "--workers", str(args.workers), "--px-step", str(args.px_step),
                           "--dir"] + dirs + ["--tag"] + tags,
                          log_path=os.path.join(args.work, "refcache.log"))
        print("[all]   缓存本批 %.0f 秒（rc=%d）" % (el, rc), flush=True)
        # 3) 逐关融合
        for name, tag, dur, fdir in zip([k[0] for k in kept], [k[1] for k in kept],
                                        [k[2] for k in kept], dirs):
            t0 = time.time()
            rc, out, el = run([PY, os.path.join(HERE, "reffuse.py"),
                               "--dir", fdir, "--tag", tag,
                               "--cache", os.path.join(args.work, "cache"),
                               "--out", args.out, "--fps", str(args.fps), "--step", "1",
                               "--max-frames", "0", "--voxel", str(args.voxel),
                               "--max-h", str(args.max_h), "--max-pts", str(args.max_pts),
                               "--sign-t", str(args.sign_t), "--sign-yaw", str(args.sign_yaw)],
                              log_path=os.path.join(args.work, "reffuse.log"))
            raw = vox = 0
            # log_path 会把子进程输出写进文件，run() 的 out 是空的 -> 必须回读日志文件
            try:
                with open(os.path.join(args.work, "reffuse.log"), encoding="utf-8", errors="replace") as fh:
                    txt = fh.read()
            except OSError:
                txt = out or ""
            m = re.search(r"原始\s+(\d+)\s+点", txt)
            if m:
                raw = int(m.group(1))
            m = re.search(r"体素降采样\([^)]*\)\s*后\s+(\d+)\s+点", txt)
            if m:
                vox = int(m.group(1))
            tj = os.path.join(args.out, "%s-traj.json" % tag)
            path_len = speed = frames = 0
            if os.path.exists(tj):
                d = json.load(open(tj, encoding="utf-8"))
                path_len, speed, frames = d.get("path_len_m", 0), d.get("speed_mps", 0), d.get("frames", 0)
            with open(summary_path, "a", encoding="utf-8") as f:
                f.write("| %s | %s | %s | %d | %d | %d | %.2f | %.3f | %.0fs |\n"
                        % (mapping[name], name, tag, frames, raw, vox, path_len, speed, el))
            print("[all]   %s(%s): %d 帧 → %d 点，路径 %.1f 单位，均速 %.2f 单位/s，%.0fs"
                  % (name, tag, frames, vox, path_len, speed, el), flush=True)
            # 4) 清盘
            if not args.keep_frames:
                shutil.rmtree(fdir, ignore_errors=True)
            cache = os.path.join(args.work, "cache")
            for fn in os.listdir(cache):
                if fn.startswith(tag + "-"):
                    try:
                        os.remove(os.path.join(cache, fn))
                    except OSError:
                        pass
        with open(os.path.join(args.work, "progress.txt"), "w", encoding="utf-8") as f:
            f.write("done %d/%d  elapsed %.0fs\n" % (min(bi + args.batch, len(todo)), len(todo), time.time() - t_start))

    print("\n[all] 完成：%d 关，用时 %.0f 分钟" % (len(todo), (time.time() - t_start) / 60), flush=True)


if __name__ == "__main__":
    main()
