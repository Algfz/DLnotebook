import glob, os, numpy as np
for tag in ["desert-s1", "desert-s2", "desert-s3"]:
    fs = sorted(glob.glob(r"C:\DLnotebook-media\tmp\poseda3\%s-win*.npz" % tag))
    print("===", tag, len(fs), "个窗口")
    for f in fs:
        z = np.load(f)
        n_i = len(z["idxs"]); n_c = z["c2w"].shape[0]
        n_f = len(z["fov_x"]) if "fov_x" in z.files else -1
        n_p = len(z["pcount"]) if "pcount" in z.files else -1
        flag = "" if (n_i == n_c == n_f == n_p) else "   <== 长度不一致"
        if flag or f is fs[-1] or f is fs[0]:
            print("  %-26s idxs %2d c2w %2d fov %2d pcount %2d%s" % (os.path.basename(f), n_i, n_c, n_f, n_p, flag))
