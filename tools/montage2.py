"""montage2.py — 用 PIL 拼图（不依赖 ImageMagick）：把若干图片按 tile 排布并加标签

用法：
  python tools\\montage2.py --out cmp.png --tile 2x2 --geom 620x349 ^
      --item "真值 t=0.0s=C:\\...\\f00001.jpg" --item "新管线 frame0=C:\\...\\new-f000.png"
"""
import argparse
import os

from PIL import Image, ImageDraw, ImageFont


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--item", action="append", required=True, help=' "标签=路径"')
    ap.add_argument("--tile", default="2x2")
    ap.add_argument("--geom", default="620x349")
    ap.add_argument("--bg", default="#101216")
    ap.add_argument("--fg", default="#e8eaf2")
    ap.add_argument("--pad", type=int, default=6)
    ap.add_argument("--label-h", type=int, default=26)
    args = ap.parse_args()

    cols, rows = (int(x) for x in args.tile.lower().split("x"))
    gw, gh = (int(x) for x in args.geom.lower().split("x"))
    try:
        font = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 19)
    except Exception:
        font = ImageFont.load_default()

    def hexrgb(s):
        s = s.lstrip("#")
        return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4))

    bg = hexrgb(args.bg)
    fg = hexrgb(args.fg)
    cellw, cellh = gw + 2 * args.pad, gh + args.label_h + 2 * args.pad
    W, H = cols * cellw, rows * cellh
    canvas = Image.new("RGB", (W, H), bg)
    dr = ImageDraw.Draw(canvas)

    for i, item in enumerate(args.item):
        sep = "|" if "|" in item else ("=" if "=" in item else None)
        if sep is None:
            continue
        label, path = item.split(sep, 1)
        r, c = divmod(i, cols)
        x0, y0 = c * cellw + args.pad, r * cellh + args.pad
        dr.text((x0 + 2, y0 + 2), label, fill=fg, font=font)
        if not os.path.exists(path):
            dr.text((x0 + 2, y0 + args.label_h + 8), "[缺失] " + path, fill=(255, 120, 120), font=font)
            continue
        im = Image.open(path).convert("RGB")
        im.thumbnail((gw, gh), Image.LANCZOS)
        canvas.paste(im, (x0 + (gw - im.width) // 2, y0 + args.label_h + (gh - im.height) // 2))
    canvas.save(args.out)
    print("[montage2] %d 图 -> %s (%dx%d)" % (len(args.item), args.out, W, H))


if __name__ == "__main__":
    main()
