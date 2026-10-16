#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""从 reffuse 日志 + traj.json 重建 refall 的 summary.md。

为什么需要它：refall 逐关写表时，如果日志是共享文件（append）或子进程编码不对，
"原始点/体素后点"两列会串行/恒为 0（2026-10-16 实测踩过两个坑）。这里改成
**事后重建**：解析 <work>/*.log 里每个 `$ ... reffuse.py --tag X` 块，取该块内
最后一次 "原始 N 点" / "体素降采样(xm) 后 N 点"，路径与均速读 <out>/X-traj.json。

用法:
  python tools/refall-summary.py --out C:\\DLnotebook-media\\tmp\\fuse-all ^
                                 --work C:\\DLnotebook-media\\tmp\\refall3
"""

import argparse
import glob
import json
import os
import re


def parse_logs(work):
    """返回 {tag: {"raw": int, "vox": int, "sec": float}}（同名 tag 取最后一次）。"""
    info = {}
    for log_path in sorted(glob.glob(os.path.join(work, "*.log"))):
        try:
            with open(log_path, encoding="utf-8", errors="replace") as fh:
                lines = fh.read().splitlines()
        except OSError:
            continue
        tag = None
        raw = vox = 0
        sec = 0.0
        for ln in lines:
            m = re.search(r"reffuse\.py\b.*?--tag\s+(\S+)", ln)
            if m:
                if tag:
                    info[tag] = {"raw": raw, "vox": vox, "sec": sec}
                tag, raw, vox, sec = m.group(1), 0, 0, 0.0
                continue
            if tag is None:
                continue
            m = re.findall(r"原始\s+(\d+)\s+点", ln)
            if m:
                raw = int(m[-1])
            m = re.findall(r"体素降采样\(([\d.]+)m\)\s*后\s+(\d+)\s+点", ln)
            if m:
                vox = int(m[-1][1])
                sec = 0.0
            m = re.search(r"完成用时\s*([\d.]+)", ln)
            if m:
                sec = float(m.group(1))
        if tag:
            info[tag] = {"raw": raw, "vox": vox, "sec": sec}
    return info


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="refall 的 --out（含 map.json / *-traj.json）")
    ap.add_argument("--work", required=True, help="refall 的 --work（含 *.log）")
    ap.add_argument("--tail", type=int, default=0, help="只统计最后 N 关（0=全部）")
    args = ap.parse_args()

    mp = os.path.join(args.out, "map.json")
    mapping = json.load(open(mp, encoding="utf-8"))
    info = parse_logs(args.work)

    rows = []
    for name, tag in sorted(mapping.items(), key=lambda kv: kv[1]):
        tj = os.path.join(args.out, "%s-traj.json" % tag)
        ply = os.path.join(args.out, "%s-fused.ply" % tag)
        if not os.path.exists(ply):
            continue
        frames = path_len = speed = 0
        if os.path.exists(tj):
            d = json.load(open(tj, encoding="utf-8"))
            frames = d.get("frames", 0)
            path_len = d.get("path_len_m", 0.0)
            speed = d.get("speed_mps", 0.0)
        meta = info.get(tag, {})
        rows.append((tag, name, frames, meta.get("raw", 0), meta.get("vox", 0),
                     path_len, speed, meta.get("sec", 0.0)))
    if args.tail:
        rows = rows[-args.tail:]

    out = os.path.join(args.out, "summary.md")
    with open(out, "w", encoding="utf-8") as f:
        f.write("# 全量关卡反推（MoGe 逐帧 → 稠密融合）\n\n")
        f.write("单位 = MoGe 任意单位（各关独立，跨关不可比；比速/长度只看**关内**）。\n")
        f.write("`原始点`/`体素后点` 由 `tools/refall-summary.py` 从日志重建。\n\n")
        f.write("| # | 关卡 | tag | 帧数 | 原始点 | 体素后点 | 路径(单位) | 均速(单位/s) | 融合耗时 |\n")
        f.write("|--:|---|---|--:|--:|--:|--:|--:|--:|\n")
        for i, (tag, name, frames, raw, vox, pl, sp, sec) in enumerate(rows, 1):
            f.write("| %d | %s | %s | %d | %d | %d | %.2f | %.3f | %.0fs |\n"
                    % (i, name, tag, frames, raw, vox, pl, sp, sec))
    print("[summary] %d 关 -> %s" % (len(rows), out))


if __name__ == "__main__":
    main()
