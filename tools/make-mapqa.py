#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""make-mapqa.py —— 把 A 路线的成果打包成一个可浏览的静态页面（含逐帧正射动画 GIF）。

输入：path-legs.py 产出的 <tag>-frame-*.png（单帧正射俯视）
输出：<out>/index.html、<out>/anim.gif、<out>/grid.png、<out>/frames/*.png、（可选）额外大图
"""
import argparse, glob, os, shutil

from PIL import Image, ImageDraw


def pad_to(im, size, bg=(255, 255, 255)):
    c = Image.new("RGB", size, bg)
    c.paste(im.convert("RGB"), ((size[0] - im.width) // 2, (size[1] - im.height) // 2))
    return c


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--legs", required=True, help="含 <tag>-frame-*.png 的目录")
    ap.add_argument("--tag", default="s1f")
    ap.add_argument("--out", required=True)
    ap.add_argument("--asset", action="append", default=[], help="标题|图片路径，可重复")
    ap.add_argument("--ms", type=int, default=170)
    ap.add_argument("--cols", type=int, default=6)
    ap.add_argument("--cell", type=int, default=300)
    ap.add_argument("--title", default="A 路线：曼哈顿世界 + 已知机架 —— 逐帧正射俯视")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    fdir = os.path.join(a.out, "frames")
    os.makedirs(fdir, exist_ok=True)

    fr = sorted(glob.glob(os.path.join(a.legs, "%s-frame-*.png" % a.tag)))
    if not fr:
        raise SystemExit("没有找到 %s-frame-*.png" % a.tag)
    ims = [Image.open(p).convert("RGB") for p in fr]
    W = max(i.width for i in ims)
    H = max(i.height for i in ims)
    print("[qa] %d 帧，画布 %dx%d" % (len(ims), W, H))

    # 单帧图（居中补白、统一尺寸）
    unif = [pad_to(i, (W, H)) for i in ims]
    for i, (p, im) in enumerate(zip(fr, unif)):
        im.save(os.path.join(fdir, os.path.basename(p)))

    # 动画 GIF
    gif = [i.resize((int(W * 0.8), int(H * 0.8)), Image.LANCZOS) for i in unif]
    gif[0].save(os.path.join(a.out, "anim.gif"), save_all=True, append_images=gif[1:],
                duration=a.ms, loop=0, optimize=True)
    print("[qa] 写出 anim.gif")

    # 拼图
    cols = a.cols
    rows = (len(unif) + cols - 1) // cols
    cw, ch = a.cell, int(a.cell * H / W) + 20
    sheet = Image.new("RGB", (cols * cw, rows * ch), (18, 18, 22))
    d = ImageDraw.Draw(sheet)
    for k, im in enumerate(unif):
        t = im.resize((cw - 8, ch - 24), Image.LANCZOS)
        x, y = (k % cols) * cw + 4, (k // cols) * ch + 20
        sheet.paste(t, (x, y))
        d.text((x, (k // cols) * ch + 5), os.path.basename(fr[k])[:-4], fill=(230, 230, 230))
    sheet.save(os.path.join(a.out, "grid.png"))
    print("[qa] 写出 grid.png (%dx%d)" % sheet.size)

    # 额外大图
    assets = []
    for it in a.asset:
        if "|" not in it:
            continue
        t, p = it.split("|", 1)
        if os.path.exists(p):
            dst = os.path.join(a.out, os.path.basename(p))
            shutil.copy2(p, dst)
            assets.append((t, os.path.basename(p)))
            print("[qa] 附带 %s" % os.path.basename(p))

    css = """<style>
body{background:#12131a;color:#e8e8ee;font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif;margin:0;padding:24px}
h1{font-size:20px;margin:0 0 6px}h2{font-size:16px;margin:26px 0 8px;color:#9ecbff}
p{max-width:1000px;color:#b9bccb}img{max-width:100%;border-radius:6px;background:#fff}
.card{background:#1b1c26;border:1px solid #2a2c3a;border-radius:10px;padding:14px;margin:12px 0}
a{color:#7fb2ff}code{background:#000;padding:1px 5px;border-radius:4px;color:#ffd479}
ul{color:#b9bccb}
</style>"""
    html = ["<!doctype html><html lang=\"zh\"><meta charset=\"utf-8\">",
            "<title>%s</title>" % a.title, css,
            "<h1>%s</h1>" % a.title,
            "<p>沙漠关（lv38）第 1 段，<code>%d</code> 帧抽样。红=该帧路径点云经地平面正投后的落点，黑=拟合出的曼哈顿折线，蓝=折点。</p>" % len(unif),
            "<div class=\"card\"><h2>逐帧正射动画</h2><img src=\"anim.gif\"></div>",
            "<div class=\"card\"><h2>抽样帧拼图</h2><img src=\"grid.png\"></div>"]
    for t, fn in assets:
        html.append("<div class=\"card\"><h2>%s</h2><img src=\"%s\"></div>" % (t, fn))
    html.append("</div></html>")
    with open(os.path.join(a.out, "index.html"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(html))
    print("[qa] 写出 %s" % os.path.join(a.out, "index.html"))


if __name__ == "__main__":
    main()
