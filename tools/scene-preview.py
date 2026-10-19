#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
scene-preview.py —— 关卡场景的软件渲染预览（不依赖浏览器 / WebGL）

为什么要自己写一个：这台机器（手机上的 Ubuntu 容器）里 Chromium 一启动就
Trace/breakpoint trap，装不上也跑不了；tasks/shot.js 那套 CDP 截图用不了。
而"重新布景"这件事必须有眼睛看，否则就是盲改。

做法：把关卡数据（路径 + 地形剖面 + place[] 方块）直接投影成 PNG。
不是游戏的真实渲染（没有雾、没有阴影贴图、没有抗锯齿），但**体量关系、天际线、
路的走向、块面朝向**这些设计上要判断的东西都在。

用法：
  python3 tools/scene-preview.py --level "ring a bell" --t 20 --span 80 --out out/preview/t20.png
  python3 tools/scene-preview.py --level "ring a bell" --t 20 --mode top --out out/preview/plan.png
"""
import json, math, os, sys, argparse
from PIL import Image, ImageDraw

W, H = 1280, 760

def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--level", required=True, help="关卡目录名（含中文/空格都行）")
    p.add_argument("--t", type=float, default=20.0, help="相机所在的时刻（秒）")
    p.add_argument("--span", type=float, default=90.0, help="渲染多长时间窗（秒），越大视野越远")
    p.add_argument("--mode", default="persp", choices=["persp", "top", "side"])
    p.add_argument("--out", default="out/preview/preview.png")
    p.add_argument("--yaw", type=float, default=None, help="相机相对行进方向的偏角（度），缺省跟随视角")
    p.add_argument("--tilt", type=float, default=34.0, help="相机俯角（度）")
    p.add_argument("--dist", type=float, default=46.0, help="相机离路头的距离（米）")
    p.add_argument("--fov", type=float, default=55.0)
    return p.parse_args()

# ---------------------------------------------------------------- 数据

def load_level(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)

def path_pts(level):
    sp = level.get("motion", {}).get("spawn") or {"x": 0, "y": 0, "z": 0}
    pts = [{"x": sp["x"], "y": sp.get("y", 0), "z": sp["z"], "t": 0.0}]
    for p in level.get("path", []):
        pts.append({"x": p["pos"][0], "y": p["pos"][1], "z": p["pos"][2], "t": p.get("t", 0)})
    return pts

def at_time(pts, t):
    """按时间线性插值取点"""
    if t <= pts[0]["t"]:
        return dict(pts[0])
    if t >= pts[-1]["t"]:
        return dict(pts[-1])
    lo, hi = 0, len(pts) - 1
    while lo < hi - 1:
        m = (lo + hi) // 2
        if pts[m]["t"] <= t:
            lo = m
        else:
            hi = m
    a, b = pts[lo], pts[hi]
    k = (t - a["t"]) / max(1e-9, b["t"] - a["t"])
    return {q: a[q] + (b[q] - a[q]) * k for q in ("x", "y", "z")} | {"t": t}

def dir_at(pts, t, base=30.0):
    a = at_time(pts, t - base)
    b = at_time(pts, t + base)
    dx, dz = b["x"] - a["x"], b["z"] - a["z"]
    L = math.hypot(dx, dz) or 1.0
    return dx / L, dz / L

# ---------------------------------------------------------------- 地形剖面

DEFAULT_PROFILE = [(1.5, 0.0), (60.0, 0.0)]

def profile_at(level, t):
    """返回该时刻的横断面：[(off, h), ...]，off 是从路中心向外的距离，h 是相对路面的高度。
    左右对称。第一个点之内 = 路面本身；之后每一段先水平（台面）再竖直（立面）落下。"""
    spec = level.get("terrain") or {}
    spans = spec.get("spans") or []
    base = spec.get("base") or {}
    prof = None
    for s in spans:
        if s["t"][0] <= t < s["t"][1]:
            prof = (s.get("params") or {}).get("profile")
            break
    if prof is None:
        prof = (base.get("params") or {}).get("profile")
    return prof or DEFAULT_PROFILE


# 色卡（与 src/js/terrain.js 的 PALETTES 一一对应）
PALETTES = {
    "board": (0x9199ac, 0xd1d0bb, 0xa8b8d8),
    "rose":  (0x8e2a57, 0xc06a95, 0xf0d2e0),
    "plum":  (0x452838, 0x6b3f63, 0xbe9cba),
    "sand":  (0x8a5a2b, 0xc9a86f, 0xf2e4c4),
    "ice":   (0x27506e, 0x5f89a6, 0xcfe2ec),
    "jade":  (0x2f6b48, 0x74ad91, 0xc4e8d5),
    "cream": (0xa89f8e, 0xe9e3d7, 0xfdfbf6),
}
def hexrgb(v):
    return ((v >> 16) & 255, (v >> 8) & 255, v & 255)
def palette_at(level, t):
    spec = level.get("terrain") or {}
    for sp in spec.get("spans") or []:
        if sp["t"][0] <= t < sp["t"][1] and sp.get("palette"):
            return PALETTES.get(sp["palette"]) or PALETTES["board"]
    base = (spec.get("base") or {}).get("palette")
    return PALETTES.get(base) or PALETTES["board"]

def road_half(level):
    return (level.get("roadWidth") or 3.0) / 2.0

# ---------------------------------------------------------------- 几何采集

def build_faces(level, pts, t0, t1):
    """返回 [(poly3d, color)] —— 世界坐标三角形/四边形 + 颜色（0-255）。"""
    faces = []

    # ---- 地形的"环形剖面"：沿路取一串采样点，每个断面一串 (off,h) ----
    step = 3.0
    samples = []
    t = t0
    while t <= t1:
        p = at_time(pts, t)
        dx, dz = dir_at(pts, t)
        nx, nz = dz, -dx                       # 右法线
        samples.append({"p": p, "n": (nx, nz), "prof": profile_at(level, t)})
        t += step
    if len(samples) < 2:
        return faces

    # 大平滑副本：远处的环（off > 30m）用它，天际线才不会跟着 90° 折点碎成一块块。
    # 引擎里对应 terrain.js 的 smoothCoords(pts, 2~3)，这里用更宽的滑动平均近似。
    def smooth_points(win):
        out = []
        n = len(samples)
        for i in range(n):
            a = max(0, i - win); b = min(n, i + win + 1)
            xs = sum(samples[k]["p"]["x"] for k in range(a, b)) / (b - a)
            zs = sum(samples[k]["p"]["z"] for k in range(a, b)) / (b - a)
            ys = sum(samples[k]["p"]["y"] for k in range(a, b)) / (b - a)
            out.append({"p": {"x": xs, "y": ys, "z": zs, "t": samples[i]["p"]["t"]},
                        "n": samples[i]["n"], "prof": samples[i]["prof"]})
        return out
    far_samples = smooth_points(18)
    def curve(off, idx):
        """近/远两条采样按偏移混合（与 terrain.js 的 motifProfile 同一套逻辑）"""
        t = max(0.0, min(1.0, (off - 3.0) / (40.0 - 3.0)))
        if t <= 0: return samples[idx]
        if t >= 1: return far_samples[idx]
        a, b = samples[idx], far_samples[idx]
        return {"p": {k: a["p"][k] + (b["p"][k] - a["p"][k]) * t for k in ("x", "y", "z", "t")},
                "n": a["n"], "prof": a["prof"]}

    # 每个断面的剖面可能不同（换母题），渲染时取两侧较大者，用同一套环
    nring = max(len(s["prof"]) for s in samples)
    def pt_at(s, off, hsign=1.0):
        p, (nx, nz) = s["p"], s["n"]
        return (p["x"] + nx * off * hsign, p["y"] + s["prof_h"], p["z"] + nz * off * hsign)

    # 先把每个断面的高度查好
    for s in samples:
        byoff = {round(o, 3): h for o, h in s["prof"]}
        s["byoff"] = byoff
        s["offs"] = [o for o, _ in s["prof"]]

    def height_at(s, off):
        # 落在哪一段：取 <= off 的最后一段
        best = s["prof"][0][1]
        for o, h in s["prof"]:
            if o <= off:
                best = h
        return best

    def world(s, off, h, sign):
        p, (nx, nz) = s["p"], s["n"]
        return (p["x"] + nx * off * sign, p["y"] + h, p["z"] + nz * off * sign)

    C_TOP = (209, 208, 187)      # 台面：米黄
    C_TOP2 = (186, 186, 170)     # 台面（次档）
    C_CUT = (145, 153, 172)      # 断面：蓝灰
    C_ROAD = (168, 184, 216)     # 路面
    C_DEEP = (120, 128, 148)

    maxoff = max(max(s["offs"]) for s in samples)
    # 每一档 offset 之间：水平台面 + 竖直立面
    for i in range(nring - 1):
        for k in range(len(samples) - 1):
            off0 = maxoff if i >= len(samples[k]["offs"]) else samples[k]["offs"][i]
            off1 = maxoff if i + 1 >= len(samples[k]["offs"]) else samples[k]["offs"][i + 1]
            # 两端各按自己的偏移取混合曲线：相邻环在同一个 offset 上求值，接缝闭合
            s0, s1 = curve(off0, k), curve(off1, k + 1)
            if off1 <= off0 + 1e-6:
                continue
            for sign in (1, -1):
                h = height_at(s0, off0)
                a = world(s0, off0, h, sign); b = world(s1, off0, h, sign)
                c = world(s1, off1, h, sign); d = world(s0, off1, h, sign)
                pal = palette_at(level, s0["p"]["t"])
                col = hexrgb(pal[1]) if i % 2 == 0 else hexrgb(pal[2])
                faces.append(([a, b, c, d], col))
                # 立面：从这一段高度落到下一段高度
                h2 = height_at(s0, off1)
                if abs(h2 - h) > 1e-6:
                    a2 = world(s0, off1, h2, sign); b2 = world(s1, off1, h2, sign)
                    pal2 = palette_at(level, s0["p"]["t"])
                    faces.append(([d, c, b2, a2], hexrgb(pal2[0])))

    # ---- 路面 ----
    w = road_half(level)
    for k in range(len(samples) - 1):
        s0, s1 = samples[k], samples[k + 1]
        a = world(s0, w, 0.02, 1); b = world(s1, w, 0.02, 1)
        c = world(s1, -w, 0.02, 1); d = world(s0, -w, 0.02, 1)
        faces.append(([a, b, c, d], C_ROAD))

    # ---- place[] 方块 ----
    for it in level.get("place") or []:
        tt = it.get("t")
        if tt is None or tt < t0 - 20 or tt > t1 + 20:
            continue
        s = None
        p = at_time(pts, tt)
        dx, dz = dir_at(pts, tt)
        nx, nz = dz, -dx
        off = it.get("off", 0)
        yaw = math.atan2(dx, dz) + (it.get("rot") or 0)
        ww, hh, dd = it.get("w") or 1, it.get("h") if it.get("h") is not None else 1, it.get("d") or 1
        prof = profile_at(level, tt)
        gy = p["y"] - 0.06
        # 近似：方块贴在该 offset 的台面上
        gh = 0.0
        for o, h in prof:
            if o <= abs(off):
                gh = h
        base = gy + gh + (it.get("dy") or 0)
        cx, cz = p["x"] + nx * off, p["z"] + nz * off
        cy = base + hh / 2
        tone = it.get("tone", 0)
        shade = [(150, 160, 184), (168, 178, 200), (188, 196, 214)][tone % 3]
        add_box(faces, cx, cy, cz, ww, hh, dd, yaw, shade)
    # ---- props[] 规则（树/石/柱…）：预览里用"树干 + 两层树冠"的方块近似 ----
    TREE_KINDS = ("tree", "pine", "bush", "rock", "column", "giant", "arch", "crystal")
    for r in (level.get("props") or []):
        kind = r.get("kind")
        if kind not in TREE_KINDS:
            continue
        tt0 = (r.get("t") or [0, pts[-1]["t"]])[0]
        tt1 = (r.get("t") or [0, pts[-1]["t"]])[1]
        every = max(4.0, r.get("every") or 30)
        off = r.get("off") or 10
        off0 = off[0] if isinstance(off, list) else off
        off1 = off[1] if isinstance(off, list) else off
        sc = r.get("scale") or 1.0
        sc0 = sc[0] if isinstance(sc, list) else sc
        # 每 every 米一个（沿弧长），左右交替
        t = tt0
        side = 1
        while t < tt1:
            sp_ = at_time(pts, t)
            dx, dz = dir_at(pts, t)
            nx, nz = dz, -dx
            o = off0 + (off1 - off0) * (0.5 + 0.5 * math.sin(t * 1.7))   # 在带内错落
            prof = profile_at(level, t)
            gh = 0.0
            for oo, hh in prof:
                if oo <= abs(o):
                    gh = hh
            base = sp_["y"] - 0.06 + gh - (r.get("inset") or 0.45)
            x = sp_["x"] + nx * o * side
            z = sp_["z"] + nz * o * side
            hg = (7.5 if kind == "tree" else 4.0) * sc0
            add_box(faces, x, base + hg * 0.30, z, 0.7, hg * 0.6, 0.7, 0, (92, 74, 58))       # 干
            add_box(faces, x, base + hg * 0.85, z, hg * 0.62, hg * 0.55, hg * 0.62, 0, (86, 148, 96))  # 冠
            side = -side
            t += every / 14.0      # every 是米，换成时间（线速 14 m/s）
    return faces

def add_box(faces, cx, cy, cz, w, h, d, yaw, color):
    cy_, sy_ = math.cos(yaw), math.sin(yaw)
    def rot(x, z):
        return (x * cy_ + z * sy_, -x * sy_ + z * cy_)
    hw, hh, hd = w / 2, h / 2, d / 2
    vs = []
    for sx in (-1, 1):
        for sy in (-1, 1):
            for sz in (-1, 1):
                rx, rz = rot(sx * hw, sz * hd)
                vs.append((cx + rx, cy + sy * hh, cz + rz))
    # 顶点索引：sx,sy,sz 的三重循环
    def vi(sx, sy, sz):
        return ((1 if sx > 0 else 0) * 4 + (1 if sy > 0 else 0) * 2 + (1 if sz > 0 else 0))
    quads = [
        ([vi(-1, 1, -1), vi(1, 1, -1), vi(1, 1, 1), vi(-1, 1, 1)], 1.00),   # 顶
        ([vi(-1, -1, 1), vi(1, -1, 1), vi(1, -1, -1), vi(-1, -1, -1)], 0.45),
        ([vi(-1, -1, -1), vi(1, -1, -1), vi(1, 1, -1), vi(-1, 1, -1)], 0.72),
        ([vi(-1, -1, 1), vi(1, -1, 1), vi(1, 1, 1), vi(-1, 1, 1)], 0.72),
        ([vi(-1, -1, -1), vi(-1, -1, 1), vi(-1, 1, 1), vi(-1, 1, -1)], 0.60),
        ([vi(1, -1, -1), vi(1, -1, 1), vi(1, 1, 1), vi(1, 1, -1)], 0.60),
    ]
    for idx, k in quads:
        poly = [vs[i] for i in idx]
        faces.append((poly, tuple(min(255, int(c * k)) for c in color)))

# ---------------------------------------------------------------- 相机与投影

def look_at(cam, target, up=(0, 1, 0)):
    fx, fy, fz = target[0] - cam[0], target[1] - cam[1], target[2] - cam[2]
    L = math.sqrt(fx * fx + fy * fy + fz * fz) or 1
    f = (fx / L, fy / L, fz / L)
    ux, uy, uz = up
    rx = f[1] * uz - f[2] * uy
    ry = f[2] * ux - f[0] * uz
    rz = f[0] * uy - f[1] * ux
    R = math.sqrt(rx * rx + ry * ry + rz * rz) or 1
    r = (rx / R, ry / R, rz / R)
    u = (r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0])
    return r, u, f

def make_camera(pts, t, dist, tilt_deg, yaw_deg, fov_deg):
    p = at_time(pts, t)
    dx, dz = dir_at(pts, t)
    yaw = math.atan2(dx, dz) + math.radians(yaw_deg)
    # 相机在路头的"后方 + 上方"，看前方 30 米
    back = dist * math.cos(math.radians(tilt_deg))
    up = dist * math.sin(math.radians(tilt_deg))
    cam = (p["x"] - math.sin(yaw) * back, p["y"] + up, p["z"] - math.cos(yaw) * back)
    tgt = at_time(pts, t + 8)
    tgt = (tgt["x"], tgt["y"] + 1.0, tgt["z"])
    return cam, tgt, fov_deg

def shade_face(poly, col):
    """按面朝向做一个假光照：法线朝上/朝光的面亮，背光面暗。flat 色块看不出体量，必须打光。"""
    if len(poly) < 3:
        return col
    ax, ay, az = poly[0]
    bx, by, bz = poly[1]
    cx, cy, cz = poly[2]
    ux, uy, uz = bx - ax, by - ay, bz - az
    vx, vy, vz = cx - ax, cy - ay, cz - az
    nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
    L = math.sqrt(nx * nx + ny * ny + nz * nz) or 1
    nx, ny, nz = nx / L, ny / L, nz / L
    if ny < 0:                                  # 朝下的面也用同一个"上方光源"
        nx, ny, nz = -nx, -ny, -nz
    lx, ly, lz = -0.45, 0.78, -0.44
    k = 0.55 + 0.45 * max(0.0, nx * lx + ny * ly + nz * lz)
    k = min(1.25, max(0.42, k))
    return tuple(min(255, int(c * k)) for c in col)

SKY = (176, 196, 216)

def project(faces, cam, tgt, fov, w=W, h=H, yaw_deg=0.0):
    r, u, f = look_at(cam, tgt)
    out = []
    for poly, col in faces:
        pts2, depth = [], 0.0
        ok = True
        for (x, y, z) in poly:
            vx, vy, vz = x - cam[0], y - cam[1], z - cam[2]
            zz = vx * f[0] + vy * f[1] + vz * f[2]
            if zz <= 0.4:
                ok = False
                break
            xx = vx * r[0] + vy * r[1] + vz * r[2]
            yy = vx * u[0] + vy * u[1] + vz * u[2]
            sc = (h / 2) / math.tan(math.radians(fov) / 2) / zz
            pts2.append((w / 2 + xx * sc, h / 2 - yy * sc))
            depth += zz
        if ok:
            d = depth / len(poly)
            # 大气透视：远处向天空色靠拢，深度才分得出来（游戏里有雾，这里补一个近似）
            fog = min(1.0, max(0.0, (d - 70.0) / 200.0)) ** 1.3
            base = shade_face(poly, col)
            col2 = tuple(int(base[i] * (1 - fog) + SKY[i] * fog) for i in range(3))
            out.append((d, pts2, col2))
    out.sort(key=lambda o: -o[0])
    return out

def draw(items, args):
    img = Image.new("RGB", (W, H), (176, 196, 216))
    d = ImageDraw.Draw(img)
    for depth, poly, col in items:
        if len(poly) >= 3:
            d.polygon(poly, fill=col, outline=None)
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    img.save(args.out)
    print("渲染", len(items), "个面 →", args.out)

def main():
    a = parse_args()
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    lvdir = os.path.join(root, "levels", a.level)
    if not os.path.isdir(lvdir):
        cands = [d for d in os.listdir(os.path.join(root, "levels")) if a.level in d]
        if not cands:
            print("找不到关卡:", a.level); sys.exit(2)
        lvdir = os.path.join(root, "levels", cands[0])
    level = load_level(os.path.join(lvdir, "level.json"))
    pts = path_pts(level)
    t0, t1 = a.t - a.span * 0.25, a.t + a.span
    faces = build_faces(level, pts, max(0, t0), min(pts[-1]["t"], t1))
    if a.mode == "top":
        cam = (at_time(pts, a.t)["x"], 900, at_time(pts, a.t)["z"] + 0.1)
        tgt = (at_time(pts, a.t)["x"], 0, at_time(pts, a.t)["z"])
        items = project(faces, cam, tgt, 40)
    elif a.mode == "side":
        p = at_time(pts, a.t)
        cam = (p["x"], p["y"] + 40, p["z"] - 400)
        tgt = (p["x"], p["y"], p["z"])
        items = project(faces, cam, tgt, 30)
    else:
        yaw = a.yaw if a.yaw is not None else 0.0
        cam, tgt, fov = make_camera(pts, a.t, a.dist, a.tilt, yaw, a.fov)
        items = project(faces, cam, tgt, fov)
    draw(items, a)

if __name__ == "__main__":
    main()
