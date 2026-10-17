"""检查 refpose 输出的 pose.json 结构（键、关键帧数、c2w 尺度稳定性）与窗口 npz 帧数。"""
import glob
import json
import os
import sys

import numpy as np

for name in ["desert-s1-pose.json", "desert-s1-pose-centers.json"]:
    p = r"C:\DLnotebook-media\tmp\poseda3" + "\\" + name
    if not os.path.exists(p):
        print("===", name, "不存在"); continue
    d = json.load(open(p, encoding="utf-8"))
    ps = d["poses"]
    print("===", name)
    print("   顶层键:", [k for k in d.keys()])
    print("   poses 数 %d，其中 key=True 的 %d" % (len(ps), sum(1 for q in ps if q.get("key"))))
    kdg = d.get("key_d_ground") or {}
    print("   key_d_ground 条目 %d" % len(kdg))
    print("   poses[0] 键:", sorted(ps[0].keys()))
    print("   poses[3]:", {k: (np.round(v, 4).tolist() if hasattr(v, "__len__") else v)
                          for k, v in ps[3].items() if k != "c2w"})
    sc = []
    for q in ps[:80]:
        M = np.asarray(q["c2w"], float).reshape(4, 4)[:3, :3]
        sc.append(float(np.cbrt(abs(np.linalg.det(M)))))
    print("   前 80 帧 c2w 3x3 的尺度（det^(1/3)）: min %.4f max %.4f" % (min(sc), max(sc)))

fs = sorted(glob.glob(r"C:\DLnotebook-media\tmp\poseda3\desert-s1-win*.npz"))
print("\n窗口 npz：%d 个" % len(fs))
for f in fs[:3] + fs[-1:]:
    z = np.load(f)
    print("  %s  idxs=%d  %s ... %s" % (os.path.basename(f), len(z["idxs"]),
                                        list(z["idxs"][:5]), list(z["idxs"][-3:])))
