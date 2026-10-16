"""refcache.py — 并行把 MoGe 逐帧几何缓存成 npz（把 GPU 吃满用）

单进程跑 MoGe 只有 ~0.6s/帧、显存 1.9GB、GPU 利用率不到 15% —— 单进程喂不饱。
本工具起 N 个进程各带一份模型，按帧号取模分工，输出与 `reffuse.frame_cache()` 完全同格式的
npz（uv/h/rgb/uvf/n/d/r/f/fx/fy/H/W/fname），后续 `reffuse.py --cache <同一目录>` 直接复用。

用法：
  $env:PYTHONPATH="C:\\D\\DLnotebook\\tools"
  python tools\\refcache.py --dir C:\\DLnotebook-media\\tmp\\seq\\desert-full --tag desert-full \
      --cache C:\\DLnotebook-media\\tmp\\fuse\\cache-full --workers 3 --px-step 2
"""
import argparse
import os
import subprocess
import sys
import time
from types import SimpleNamespace

import numpy as np
import cv2

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import refserve as rv      # noqa: E402
import reffuse as rf       # noqa: E402


def load_bgr(path):
    b = np.fromfile(path, dtype=np.uint8)
    return cv2.imdecode(b, cv2.IMREAD_COLOR)


def collect_jobs(dirs, tags, start, end, stride):
    """返回 [(tag, dir, name), ...]；多个 (tag, dir) 一起排班，模型只加载一次。"""
    if len(tags) != len(dirs):
        raise SystemExit("--dir 与 --tag 数量必须一致")
    jobs = []
    for d, t in zip(dirs, tags):
        names = sorted(f for f in os.listdir(d) if f.lower().endswith((".jpg", ".png")))[start:end or None]
        for n in names[::stride]:
            jobs.append((t, d, n))
    return jobs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True, nargs="+")
    ap.add_argument("--tag", required=True, nargs="+")
    ap.add_argument("--cache", required=True)
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--worker-index", type=int, default=-1)
    ap.add_argument("--px-step", type=int, default=2)
    ap.add_argument("--num-tokens", type=int, default=2200)
    ap.add_argument("--start", type=int, default=0)
    ap.add_argument("--end", type=int, default=0, help="0=到底")
    ap.add_argument("--stride", type=int, default=1, help="先抽稀（1=每帧都要）")
    args = ap.parse_args()

    os.makedirs(args.cache, exist_ok=True)
    jobs = collect_jobs(args.dir, args.tag, args.start, args.end, args.stride)

    if args.worker_index < 0:                     # 父进程：起 N 个工人
        procs = []
        for i in range(args.workers):
            cmd = [sys.executable, os.path.abspath(__file__),
                   "--cache", args.cache, "--workers", str(args.workers), "--worker-index", str(i),
                   "--px-step", str(args.px_step), "--num-tokens", str(args.num_tokens),
                   "--start", str(args.start), "--end", str(args.end), "--stride", str(args.stride),
                   "--dir"] + list(args.dir) + ["--tag"] + list(args.tag)
            procs.append(subprocess.Popen(cmd, env=os.environ.copy()))
            print("[cache] worker %d 起（pid %d）" % (i, procs[-1].pid), flush=True)
        t0 = time.time()
        for p in procs:
            p.wait()
        print("[cache] 全部完成，用时 %.1fs" % (time.time() - t0), flush=True)
        return

    todo = [j for k, j in enumerate(jobs) if k % args.workers == args.worker_index]
    model = device = None
    done, skip = 0, 0
    t0 = time.time()
    for n, (tag, d, name) in enumerate(todo):
        cf = os.path.join(args.cache, "%s-%s.npz" % (tag, name.rsplit(".", 1)[0]))
        if os.path.exists(cf):
            skip += 1
            continue
        if model is None:
            model, device = rv.load_model(rv.DEFAULT_CKPT, None)
        img = load_bgr(os.path.join(d, name))
        if img is None:
            print("[w%d] 读不出 %s" % (args.worker_index, name), flush=True)
            continue
        fr = rv.infer_frame(model, device, img, args.num_tokens)
        fr["fname"] = name
        rf.frame_cache(SimpleNamespace(px_step=args.px_step), fr, img, name, cf)
        done += 1
        if done % 20 == 0 or n == len(todo) - 1:
            el = time.time() - t0
            print("[w%d] %d/%d 帧  已用 %.0fs  (%.2fs/帧) 跳过 %d"
                  % (args.worker_index, n + 1, len(todo), el, el / max(1, done), skip), flush=True)


if __name__ == "__main__":
    main()
