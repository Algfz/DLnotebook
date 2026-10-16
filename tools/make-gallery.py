#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""生成一个可远程查看的静态图集（给手机看）。

- 原图只读，缩放版写到 <out>/i/（PIL，最长边 --max-w，JPEG q85）
- 表格/进度从 fuse-all 的 map.json + *-traj.json + *.ply 现算（不依赖 summary.md）
- 页面带 meta refresh，配合 `--loop 30` 就能边跑边看

用法:
  python tools/make-gallery.py --out C:\\DLnotebook-media\\tmp\\gallery --loop 30
"""

import argparse
import glob
import html
import json
import os
import shutil
import subprocess
import time

from PIL import Image

MEDIA = r"C:\DLnotebook-media\tmp"
CMP = os.path.join(MEDIA, "cmp")
FUSE = os.path.join(MEDIA, "fuse")
FUSEALL = os.path.join(MEDIA, "fuse-all")
REPO = r"C:\D\DLnotebook"
OUTS = os.path.join(REPO, "out")

# (标题, 说明, 源路径) —— 顺序即页面顺序
MONTAGES = [
    ("模型对比 · f00001 三联",
     "左=官方沙漠真值帧，中=MoGe-2 ViT-L 单帧 @真值 fov55，右=DA3-Giant 单帧。"
     "这一帧 MoGe 只认 4.5% 像素（大片纯黄天空），所以用真值内参时它的 edge_corr 反而最高（+0.45）",
     os.path.join(CMP, "test-montage.jpg")),
    ("模型对比 · f00341 同机位回渲",
     "左=真值，中=MoGe 单帧（IoU 0.62），右=DA3-Giant **8 帧连续多视图**（road_iou 0.71、edge_fg 0.34）。"
     "DA3 的路面与边缘更准，MoGe 的整体轮廓更贴",
     os.path.join(CMP, "cmp-341-moge-vs-da3m8.jpg")),
    ("DA3-Giant 8 帧同机位回渲 vs 真值",
     "山的轮廓、之字红路、路两侧黄方块、左侧沟壑全部对上 —— 这是\"DA3 不该被单帧判死刑\"的关键证据",
     os.path.join(CMP, "cmp-da3m8-341.jpg")),
    ("三模型俯视图",
     "VGGT-1B 40 帧：点云裂成两块互不相连的团，轨迹不贴合；DA3-Giant 8 帧：一整片连续地面，轨迹贴在上面；"
     "MoGe 635 帧融合：长条走廊带（各自任意单位，尺度不可跨模型比）",
     os.path.join(CMP, "top-3up.png")),
    ("官方「空间」闭环回渲",
     "左=参考帧，中=同机位用反推几何回渲，右=换机位（能看到单视图固有的背面空洞 —— 所以\"可飞场景\"必须多帧融合）",
     os.path.join(REPO, "out", "tmp", "ref-scene", "cmp-space-3up.jpg")),
    ("我们自己的关卡 t=22 闭环回渲",
     "左=引擎真实渲染，中=用从单帧反推的几何同机位回渲 —— 之字路、方块位置与相对大小全对上",
     os.path.join(REPO, "out", "tmp", "ref-scene", "cmp-own-t22.jpg")),
]

DESERT = [
    ("沙漠全关稠密融合（635 帧）· 追车视角",
     "MoGe 逐帧 → 地面系 → 链式位姿 → 世界点云，用轨迹机位回渲。红边路带伸向远方、黄地面、绿灌木都在",
     os.path.join(FUSE, "chase-k27.png")),
    ("沙漠窗口点云（110 帧）",
     "同一套管线的窗口版：路面、黄地面、方块",
     os.path.join(FUSE, "win-a.png")),
    ("沙漠全关融合 · 顶视图",
     "红线=相机轨迹（137.5 单位 / 126.8 秒）。远处地面呈楔形 + 随机抽稀 ⇒ 三维看像\"散沙\"",
     os.path.join(FUSE, "desert-full-top.png")),
    ("沙漠近景融合 · 顶视图",
     "只留相机周围 3 单位、高度 2 以内：沿轨迹的一条 4~6 单位宽连续走廊带 ⇒ \"可飞场景\"成立",
     os.path.join(FUSE, "desert-near-top.png")),
    ("道具检测 · 几何法 overlay",
     "不靠颜色（会吃到阴影），改成\"高出局部地面 + 厚度\"检测；绿框是检出，注意地平线附近误检已压住",
     os.path.join(MEDIA, "props", "geo-b-overlay-f0021.png")),
]


def fit(src, dst, max_w, quality=85):
    if not os.path.exists(src):
        return None
    if os.path.exists(dst) and os.path.getmtime(dst) >= os.path.getmtime(src):
        return dst
    try:
        im = Image.open(src)
        im = im.convert("RGB")
        if im.width > max_w:
            im = im.resize((max_w, max(1, round(im.height * max_w / im.width))), Image.LANCZOS)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        im.save(dst, "JPEG", quality=quality, optimize=True)
        return dst
    except Exception as exc:                                    # noqa: BLE001
        print("[gallery] 跳过 %s (%s)" % (os.path.basename(src), exc))
        return None


def level_rows():
    mp = os.path.join(FUSEALL, "map.json")
    if not os.path.exists(mp):
        return [], 0
    mapping = json.load(open(mp, encoding="utf-8"))
    rows, done = [], 0
    for name, tag in sorted(mapping.items(), key=lambda kv: kv[1]):
        ply = os.path.join(FUSEALL, "%s-fused.ply" % tag)
        ok = os.path.exists(ply)
        frames = plen = speed = 0
        tj = os.path.join(FUSEALL, "%s-traj.json" % tag)
        if ok and os.path.exists(tj):
            d = json.load(open(tj, encoding="utf-8"))
            frames = d.get("frames", 0)
            plen = d.get("path_len_m", 0.0)
            speed = d.get("speed_mps", 0.0)
        if ok:
            done += 1
        rows.append((tag, name, ok, frames, plen, speed,
                     os.path.join(FUSEALL, "%s-top.png" % tag) if ok else None))
    return rows, done


def gpu_line():
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=utilization.gpu,memory.used,power.draw",
                              "--format=csv,noheader"], stdout=subprocess.PIPE, text=True, timeout=8)
        return (out.stdout or "").strip()
    except Exception:                                            # noqa: BLE001
        return ""


def running():
    for kind in ("refall3", "refall2", "refall"):
        p = os.path.join(MEDIA, kind, "progress.txt")
        if os.path.exists(p):
            try:
                return open(p, encoding="utf-8").read().strip()
            except OSError:
                pass
    return ""


def img_tag(path, alt, cls="shot"):
    if not path:
        return ""
    rel = "i/" + os.path.basename(path)
    return '<a href="%s" target="_blank"><img class="%s" src="%s" alt="%s" loading="lazy"></a>' % (
        rel, cls, rel, html.escape(alt))


def figures(items, gallery, max_w):
    out = []
    for title, desc, src in items:
        dst = fit(src, os.path.join(gallery, "i", os.path.basename(src)), max_w)
        if not dst:
            continue
        out.append('<figure>%s<figcaption><b>%s</b><br><span>%s</span></figcaption></figure>'
                   % (img_tag(dst, title, "shot"), html.escape(title), desc))
    return "\n".join(out)


def build(gallery, max_w):
    os.makedirs(os.path.join(gallery, "i"), exist_ok=True)
    rows, done = level_rows()
    total = len(rows)
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")

    # 关卡顶视图缩略图（只取已完成的）
    thumbs = []
    for tag, name, ok, *_rest in rows:
        if ok:
            src = os.path.join(FUSEALL, "%s-top.png" % tag)
            dst = fit(src, os.path.join(gallery, "i", "%s-top.jpg" % tag), 520, 82)
            if dst:
                thumbs.append('<a class="th" href="i/%s" target="_blank"><img src="i/%s" alt="%s">'
                              '<span>%s · %s</span></a>' % (os.path.basename(dst), os.path.basename(dst),
                                                            html.escape(name), html.escape(name), tag))

    tbl = ['<table><thead><tr><th>#</th><th>关卡</th><th>tag</th><th>帧数</th>'
           '<th>路径(单位)</th><th>均速(单位/s)</th><th>状态</th></tr></thead><tbody>']
    for i, (tag, name, ok, frames, plen, speed, _t) in enumerate(rows, 1):
        tbl.append("<tr class='%s'><td>%d</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td>"
                   "<td>%s</td><td>%s</td></tr>"
                   % ("ok" if ok else "wait", i, html.escape(name), tag,
                      frames or "-", ("%.2f" % plen) if ok else "-",
                      ("%.3f" % speed) if ok else "-", "✅" if ok else "…"))
    tbl.append("</tbody></table>")

    hero = fit(os.path.join(CMP, "cmp-341-moge-vs-da3m8.jpg"),
               os.path.join(gallery, "i", "hero.jpg"), 1600, 88)

    doc = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="45">
<script>if(location.pathname.slice(-1)!='/')location.replace(location.pathname+'/')</script>
<title>跳舞的线 · 官方关卡反推结果</title>
<style>
:root{{--bg:#12141a;--fg:#e8eaf0;--dim:#98a0b3;--acc:#ffd24b;--card:#1b1f27}}
*{{box-sizing:border-box}}
body{{margin:0;background:var(--bg);color:var(--fg);
  font:15px/1.6 -apple-system,"Segoe UI",system-ui,"PingFang SC","Microsoft YaHei",sans-serif}}
header{{padding:22px 18px 14px;background:linear-gradient(160deg,#1e2433,#12141a)}}
h1{{margin:0 0 6px;font-size:21px}}
h2{{margin:30px 18px 10px;font-size:18px;color:var(--acc)}}
.sub{{color:var(--dim);font-size:13px}}
.wrap{{padding:0 18px 40px;max-width:1500px;margin:0 auto}}
.bar{{height:10px;background:#242a36;border-radius:6px;overflow:hidden;margin:10px 0 6px}}
.bar>i{{display:block;height:100%;background:linear-gradient(90deg,#ffd24b,#ff8a3d);width:{pct}%}}
table{{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px}}
th,td{{padding:6px 8px;border-bottom:1px solid #262b36;text-align:right;white-space:nowrap}}
th:nth-child(2),td:nth-child(2),th:nth-child(3),td:nth-child(3){{text-align:left}}
tr.ok td{{color:#d8ffe2}} tr.wait td{{color:#6b7280}}
figure{{margin:0 0 26px;background:var(--card);border-radius:12px;padding:12px}}
figure img{{width:100%;border-radius:8px;display:block}}
figcaption{{margin-top:8px;font-size:13px;color:var(--dim)}}
figcaption b{{color:var(--fg)}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px}}
.th{{position:relative;display:block;text-decoration:none;color:var(--fg)}}
.th img{{width:100%;border-radius:8px;display:block}}
.th span{{position:absolute;left:6px;bottom:6px;font-size:12px;background:#000b;padding:2px 6px;border-radius:6px}}
code{{background:#222834;padding:1px 5px;border-radius:4px;font-size:12px}}
.kv{{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:13px;color:var(--dim)}}
.kv b{{color:var(--fg);font-weight:600}}
a{{color:var(--acc)}}
</style></head><body>
<header>
  <h1>跳舞的线 · 官方关卡反推</h1>
  <div class="sub">更新时间 <b>{stamp}</b>（每 45 秒自动刷新） · 机器 GPU：{gpu} · 后台任务：{run}</div>
  <div class="bar"><i></i></div>
  <div class="sub">官方 61 关：已完成 <b>{done}/{total}</b> 关的逐帧 MoGe → 稠密融合（每关约 500 帧，3 进程并行）</div>
</header>
<div class="wrap">

<h2>模型对比结论（本轮的重点）</h2>
<figure><img src="i/{hero}" alt="hero"><figcaption><b>f00341：真值 vs MoGe 单帧 vs DA3-Giant 8 帧多视图</b><br>
<span>真值内参由引擎给出（<code>PerspectiveCamera(55°)</code> 垂直 fov ⇒ 16:9 时 fov_x=85.58°）。
MoGe 整体轮廓更像（IoU 0.62），DA3 多视图的路面与边缘更准（road_iou 0.71 / edge_fg 0.34）。
结论：单帧稠密深度用 <b>MoGe-2 ViT-L</b>，多帧位姿/骨架用 <b>DA3-Giant（连续 8~24 帧 fp32）</b>，
单帧内参标定用 <b>MapAnything</b>，VGGT-1B 只作旁证（fov 偏 −20°、点云裂成两团）。</span>
</figcaption></figure>
{montages}

<h2>官方关卡反推（MoGe 逐帧 → 地面系 → 稠密融合）</h2>
<div class="grid">{thumbs}</div>
{tbl}

<h2>沙漠关卡全过程</h2>
{desert}

<h2>说明</h2>
<div class="kv">
  <b>单位</b><span>MoGe 任意单位，各关独立、跨关不可比；关内比速/长度有效（相机高约 2.5 单位、路宽约 3 单位）</span>
  <b>验收方式</b><span>ADR-33：同机位回渲与真值帧并排；定量用 fg_iou / road_iou / 边缘相关 / SSIM / 覆盖率</span>
  <b>文档</b><span>{docs}</span>
</div>
</div></body></html>
""".format(stamp=stamp, gpu=html.escape(gpu_line()) or "读取失败",
           run=html.escape(running()) or "无",
           pct=(100.0 * done / total) if total else 0, done=done, total=total,
           hero=os.path.basename(hero) if hero else "",
           montages=figures(MONTAGES, gallery, max_w),
           thumbs="\n".join(thumbs) or "<i>还没有完成的关卡</i>",
           tbl="".join(tbl),
           desert=figures(DESERT, gallery, max_w),
           docs="<code>docs/model-comparison.md</code>（模型对比）· <code>docs/reference-study-method.md</code>（反推方法）")

    with open(os.path.join(gallery, "index.html"), "w", encoding="utf-8") as fh:
        fh.write(doc)
    print("[gallery] %s  (%d/%d 关)  %s" % (os.path.join(gallery, "index.html"), done, total, stamp))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(MEDIA, "gallery"))
    ap.add_argument("--max-w", type=int, default=1500)
    ap.add_argument("--loop", type=int, default=0, help=">0 则每隔这么多秒重建一次")
    args = ap.parse_args()
    while True:
        try:
            build(args.out, args.max_w)
        except Exception as exc:                                 # noqa: BLE001
            print("[gallery] 出错 %s" % exc)
        if not args.loop:
            break
        time.sleep(args.loop)


if __name__ == "__main__":
    main()
