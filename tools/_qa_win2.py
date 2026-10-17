"""统计窗口 npz 的切片数与"落在关键帧集合里"的切片数，解释 used_points/frames 的来源。"""
import glob
import json
import os
from collections import Counter

import numpy as np

pj = json.load(open(r"C:\DLnotebook-media\tmp\poseda3\desert-s1-pose.json", encoding="utf-8"))
keys = set(int(k) for k in pj["key_d_ground"].keys())
poses = set(int(p["idx"]) for p in pj["poses"])
print("关键帧 %d 个，poses 覆盖 %d 个帧号，范围 %d~%d" % (len(keys), len(poses), min(poses), max(poses)))

fs = sorted(glob.glob(r"C:\DLnotebook-media\tmp\poseda3\desert-s1-win*.npz"))
print("窗口 npz：%d 个" % len(fs))
tot = ok = 0
per_key = Counter()
lens = []
for f in fs:
    z = np.load(f)
    idxs = [int(x) for x in z["idxs"]]
    lens.append(len(idxs))
    cnt = z["pcount"]
    for j, ix in enumerate(idxs):
        tot += 1
        if ix in keys and ix in poses and int(cnt[j]) >= 50:
            ok += 1
            per_key[ix] += 1
print("切片总数 %d，其中通过（关键帧+点数≥50）%d" % (tot, ok))
print("每窗口切片数：min %d max %d 中位 %d" % (min(lens), max(lens), int(np.median(lens))))
if per_key:
    c = Counter(per_key.values())
    print("每个关键帧被几个窗口包含：", dict(sorted(c.items())))
    print("预计融合帧数 = %d ⇒ ×80000 = %.1fM 点" % (ok, ok * 80000 / 1e6))
