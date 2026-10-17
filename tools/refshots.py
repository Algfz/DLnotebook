"""refshots.py — 关卡视频的**镜头切分**（找出场景突变点，把一关切成多个独立场景）

为什么需要：官方关卡 `_src.mp4` 是整关录制，可能包含多处**场景突变**（换配色/换地形/转场/菜单）。
我们之前把整关帧强行链式对齐成一份点云，一旦跨场景，仿射估计会随机跳变并把后面所有帧带偏。

三种便宜信号（全部 CPU、不用模型）：
  1. 直方图突变   hist  —— 相邻帧 32 桶灰度直方图 L1 距离的尖峰
  2. 几何断裂     flow  —— Farneback 光流 + RANSAC 相似变换：内点率骤降 / 残差骤增
  3. 转场/黑场    blank —— 均值过暗或方差过小（淡入淡出、纯色过场）

输出：
  <out>/<tag>-shots.json   每关的切点、场景区间、逐帧指标摘要
  <out>/shots.md           汇总表：关卡 | 时长 | 场景数 | 切点(秒) | 最强跳变
  <out>/shots.json         全部关卡汇总（供后续管线读取分段）

用法：
  $env:PYTHONPATH="C:\\D\\DLnotebook\\tools"
  python tools\\refshots.py --only 沙漠            # 单关试跑
  python tools\\refshots.py --jobs 4               # 全量 61 关
"""
import argparse
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ProcessPoolExecutor

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FFMPEG = r"C:\ffmpeg\ffmpeg-8.1.1-full_build\bin\ffmpeg.exe"
FFPROBE = r"C:\ffmpeg\ffmpeg-8.1.1-full_build\bin\ffprobe.exe"


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
        p = subprocess.run([FFPROBE, "-v", "error", "-show_entries", "format=duration",
                            "-of", "csv=p=0", src], stdout=subprocess.PIPE, text=True)
        return float((p.stdout or "0").strip() or 0)
    except Exception:
        return 0.0


def iter_frames(src, fps, w, h):
    """用 ffmpeg 把视频按 fps 降采样、缩到 w×h 后逐帧吐出（rgb24）"""
    cmd = [FFMPEG, "-v", "error", "-i", src, "-vf", f"fps={fps},scale={w}:{h}",
           "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=w * h * 3 * 8)
    n = w * h * 3
    try:
        while True:
            buf = p.stdout.read(n)
            if not buf or len(buf) < n:
                break
            yield np.frombuffer(buf, np.uint8).reshape(h, w, 3)
    finally:
        try:
            p.stdout.close()
        finally:
            p.wait()


def frame_metrics(frames, flow_step=2):
    """逐帧指标：mad / hist / inl / res / edge"""
    gray = [cv2.cvtColor(f, cv2.COLOR_RGB2GRAY) for f in frames]
    n = len(gray)
    hist = np.zeros(n, np.float32)
    mad = np.zeros(n, np.float32)
    inl = np.full(n, np.nan, np.float32)
    res = np.full(n, np.nan, np.float32)
    edge = np.zeros(n, np.float32)
    for i in range(n):
        g = gray[i]
        edge[i] = float(cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3).__abs__().mean())
        if i == 0:
            continue
        a, b = gray[i - 1], g
        mad[i] = float(np.abs(a.astype(np.int16) - b.astype(np.int16)).mean())
        ha = cv2.calcHist([a], [0], None, [32], [0, 256]).ravel()
        hb = cv2.calcHist([b], [0], None, [32], [0, 256]).ravel()
        ha /= max(1.0, ha.sum())
        hb /= max(1.0, hb.sum())
        hist[i] = float(np.abs(ha - hb).sum())
        # 光流：小图上做，降采样点做 RANSAC
        flow = cv2.calcOpticalFlowFarneback(a, b, None, 0.5, 3, 15, 3, 5, 1.2, 0)
        ys, xs = np.mgrid[0:a.shape[0]:flow_step, 0:a.shape[1]:flow_step]
        p0 = np.stack([xs.ravel(), ys.ravel()], 1).astype(np.float32)
        p1 = p0 + flow[::flow_step, ::flow_step].reshape(-1, 2)
        M, mask = cv2.estimateAffinePartial2D(p0, p1, method=cv2.RANSAC,
                                             ransacReprojThreshold=1.5, maxIters=2000, confidence=0.99)
        if M is None or mask is None:
            inl[i], res[i] = 0.0, np.inf
        else:
            mask = mask.ravel().astype(bool)
            inl[i] = float(mask.mean())
            pr = p0[mask] @ M[:, :2].T + M[:, 2]
            d = np.linalg.norm(pr - p1[mask], axis=1)
            res[i] = float(np.median(d)) if len(d) else np.inf
    return {"mad": mad, "hist": hist, "inl": inl, "res": res, "edge": edge,
            "mean": np.array([float(g.mean()) for g in gray], np.float32),
            "std": np.array([float(g.std()) for g in gray], np.float32)}


def detect_cuts(m, fps, min_gap=0.4, hist_k=3.0):
    """把三种信号合成切点；返回切点列表（帧下标，从 0 起）"""
    n = len(m["mad"])
    hist, mad, inl, res, mean, std = m["hist"], m["mad"], m["inl"], m["res"], m["mean"], m["std"]
    ok = np.isfinite(res)
    med_res = float(np.median(res[ok])) if ok.any() else 1.0
    med_inl = float(np.nanmedian(inl[1:])) if n > 1 else 1.0
    # 稳健阈值：中位数 + k×MAD
    med_h = float(np.median(hist[1:]))
    mad_h = float(np.median(np.abs(hist[1:] - med_h))) * 1.4826
    thr_hist = max(0.30, med_h + hist_k * max(mad_h, 1e-6))
    thr_mad = max(6.0, float(np.median(mad[1:])) + 4 * max(1e-6, float(np.median(np.abs(mad[1:] - np.median(mad[1:])))) * 1.4826))
    thr_res = max(2.0, 4.0 * med_res)
    thr_inl = min(0.55, 0.6 * med_inl)

    blank = (mean < 14.0) | (std < 3.0)
    raw = []
    for i in range(1, n):
        h_spike = hist[i] > thr_hist
        m_spike = mad[i] > thr_mad
        f_break = (inl[i] < thr_inl) or (not np.isfinite(res[i])) or (res[i] > thr_res)
        if blank[i] and not blank[i - 1]:
            raw.append((i, "blank", float(mean[i])))
        elif h_spike and (f_break or m_spike):
            raw.append((i, "cut", float(hist[i])))
        elif f_break and m_spike and hist[i] > 0.6 * thr_hist:
            raw.append((i, "flow", float(hist[i])))
    # 合并邻近切点（最小间隔）
    gap = max(1, int(round(min_gap * fps)))
    cuts = []
    for i, why, sc in raw:
        if cuts and i - cuts[-1]["frame"] < gap:
            if sc > cuts[-1]["score"]:
                cuts[-1] = {"frame": i, "t": round(i / fps, 3), "why": why, "score": round(sc, 3)}
            continue
        cuts.append({"frame": i, "t": round(i / fps, 3), "why": why, "score": round(sc, 3)})
    return cuts, {"thr_hist": round(thr_hist, 3), "thr_mad": round(thr_mad, 2),
                  "thr_res": round(thr_res, 2), "thr_inl": round(thr_inl, 3),
                  "med_hist": round(med_h, 3), "med_inl": round(med_inl, 3), "med_res": round(med_res, 3)}


def split_scenes(n_frames, cuts, fps, min_sec=0.8):
    """按切点切成场景区间；太短的段并入邻居"""
    bounds = [0] + [c["frame"] for c in cuts] + [n_frames]
    segs = []
    for a, b in zip(bounds[:-1], bounds[1:]):
        if b > a:
            segs.append([a, b])
    # 合并过短段
    merged = []
    min_n = max(1, int(round(min_sec * fps)))
    for s in segs:
        if merged and (s[1] - s[0]) < min_n:
            merged[-1][1] = s[1]
        else:
            merged.append(s)
    out = []
    for i, (a, b) in enumerate(merged, 1):
        out.append({"idx": i, "start": a, "end": b - 1, "frames": b - a,
                    "t_start": round(a / fps, 3), "t_end": round((b - 1) / fps, 3),
                    "seconds": round((b - a) / fps, 3)})
    return out


def one_level(job):
    tag, name, src, fps, w, h = job
    t0 = time.time()
    frames = list(iter_frames(src, fps, w, h))
    if not frames:
        return {"tag": tag, "name": name, "src": src, "error": "no frames"}
    m = frame_metrics(frames)
    cuts, thr = detect_cuts(m, fps)
    scenes = split_scenes(len(frames), cuts, fps)
    return {
        "tag": tag, "name": name, "src": src, "fps": fps, "size": [w, h],
        "frames": len(frames), "duration_s": round(len(frames) / fps, 2),
        "n_scenes": len(scenes), "cuts": cuts, "scenes": scenes, "thresholds": thr,
        "metrics": {
            "mad_p50": round(float(np.median(m["mad"][1:])), 3),
            "hist_p50": round(float(np.median(m["hist"][1:])), 4),
            "hist_max": round(float(m["hist"].max()), 4),
            "inl_p50": round(float(np.nanmedian(m["inl"][1:])), 3),
            "res_p50": round(float(np.nanmedian(m["res"][1:])), 3),
            "blank_frames": int(((m["mean"] < 14) | (m["std"] < 3)).sum()),
            "edge_p50": round(float(np.median(m["edge"])), 2),
        },
        "seconds": round(time.time() - t0, 1),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=r"C:\DLnotebook-media\ref_official2")
    ap.add_argument("--out", default=r"C:\DLnotebook-media\tmp\shots")
    ap.add_argument("--fps", type=float, default=10.0, help="分析帧率（只影响检测，不抽帧存档）")
    ap.add_argument("--width", type=int, default=192)
    ap.add_argument("--height", type=int, default=108)
    ap.add_argument("--jobs", type=int, default=4)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--only", default=None, help="只跑这些关卡名（逗号分隔）")
    args = ap.parse_args()

    levels = []
    for name in sorted(os.listdir(args.root)):
        d = os.path.join(args.root, name)
        if not os.path.isdir(d):
            continue
        src = find_src(d)
        if src:
            levels.append((name, d, src))
    all_names = sorted(n for n, _, _ in levels)
    mapping = {n: "lv%02d" % i for i, n in enumerate(all_names, 1)}
    if args.only:
        want = {s.strip() for s in args.only.split(",")}
        levels = [lv for lv in levels if lv[0] in want]
    levels.sort(key=lambda t: probe_duration(t[2]))
    if args.limit:
        levels = levels[:args.limit]

    os.makedirs(args.out, exist_ok=True)
    jobs = [(mapping[n], n, s, args.fps, args.width, args.height) for n, _, s in levels]
    print("[shots] %d 关，jobs=%d，分析 %g fps @ %dx%d" % (len(jobs), args.jobs, args.fps, args.width, args.height), flush=True)

    results = []
    if args.jobs <= 1:
        for j in jobs:
            r = one_level(j)
            print("  %-6s %-22s 场景 %d  用时 %ss" % (r.get("tag"), r.get("name"), r.get("n_scenes", -1), r.get("seconds")), flush=True)
            results.append(r)
    else:
        with ProcessPoolExecutor(max_workers=args.jobs) as ex:
            for r in ex.map(one_level, jobs):
                print("  %-6s %-22s 场景 %d  用时 %ss" % (r.get("tag"), r.get("name"), r.get("n_scenes", -1), r.get("seconds")), flush=True)
                results.append(r)

    for r in results:
        if "error" not in r:
            json.dump(r, open(os.path.join(args.out, "%s-shots.json" % r["tag"]), "w", encoding="utf-8"),
                      ensure_ascii=False, indent=1)
    json.dump({"mapping": mapping, "levels": results},
              open(os.path.join(args.out, "shots.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    rows = ["| tag | 关卡 | 时长(s) | 场景数 | 切点(秒) | 最强跳变 | 黑场帧 | 内点率p50 |",
            "|---|---|---|---|---|---|---|---|"]
    for r in sorted(results, key=lambda x: (-x.get("n_scenes", 0), x.get("name", ""))):
        if "error" in r:
            rows.append("| %s | %s | - | - | - | - | - | - |" % (r.get("tag"), r.get("name")))
            continue
        cut_txt = ", ".join("%.1f" % c["t"] for c in r["cuts"][:12]) or "—"
        hmax = max([c["score"] for c in r["cuts"]], default=0.0)
        rows.append("| %s | %s | %.1f | **%d** | %s | %.3f | %d | %.2f |" % (
            r["tag"], r["name"], r["duration_s"], r["n_scenes"], cut_txt, hmax,
            r["metrics"]["blank_frames"], r["metrics"]["inl_p50"]))
    multi = sum(1 for r in results if r.get("n_scenes", 1) > 1)
    rows.append("")
    rows.append("多场景关卡：**%d / %d**" % (multi, len(results)))
    open(os.path.join(args.out, "shots.md"), "w", encoding="utf-8").write("\n".join(rows) + "\n")
    print("[shots] 汇总 -> %s（多场景 %d/%d）" % (os.path.join(args.out, "shots.md"), multi, len(results)), flush=True)


if __name__ == "__main__":
    main()
