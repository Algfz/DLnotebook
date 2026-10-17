"""make-scenes.py — 把 refshots 的镜头切分结果做成一页"场景总览"

- 每关一行（按关名排序），每个场景一个缩略图（从 _src.mp4 取该段中点帧）
- 缩略图下方标时间区间与时长；长段（>= --min-seg 秒）标绿=可用，碎段标暗红
- 输出 <out>/index.html（+ <out>/<tag>-s<idx>.jpg 缩略图）

用法：
  python tools\\make-scenes.py --shots C:\\DLnotebook-media\\tmp\\shots --root C:\\DLnotebook-media\\ref_official2 ^
      --out C:\\DLnotebook-media\\tmp\\gallery\\scenes --ffmpeg C:\\ffmpeg\\ffmpeg-8.1.1-full_build\\bin\\ffmpeg.exe
"""
import argparse
import glob
import html
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def find_src(root, name):
    for d in os.listdir(root):
        if d == name or d.startswith(name):
            for f in os.listdir(os.path.join(root, d)):
                if f.lower().endswith((".mp4", ".mkv", ".webm")):
                    return os.path.join(root, d, f)
    return None


def thumb(ff, src, t, out, dur=0.4):
    if os.path.exists(out):
        return True
    r = subprocess.run([ff, "-y", "-loglevel", "error", "-ss", "%.2f" % max(0.0, t),
                        "-i", src, "-frames:v", "1", "-vf", "scale=256:-1", "-q:v", "4", out],
                       capture_output=True)
    return os.path.exists(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shots", required=True)
    ap.add_argument("--root", required=True, help="官方素材根目录（每关一个子目录）")
    ap.add_argument("--out", required=True)
    ap.add_argument("--ffmpeg", default=r"C:\ffmpeg\ffmpeg-8.1.1-full_build\bin\ffmpeg.exe")
    ap.add_argument("--min-seg", type=float, default=3.0, help=">= 该秒数算可用场景")
    ap.add_argument("--max-levels", type=int, default=0)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    files = sorted(glob.glob(os.path.join(args.shots, "*-shots.json")))
    if args.max_levels:
        files = files[:args.max_levels]
    levels = []
    for p in files:
        d = json.load(open(p, encoding="utf-8"))
        tag = d.get("tag") or os.path.basename(p).split("-shots")[0]
        name = d.get("name") or d.get("level") or tag
        src = d.get("src") or find_src(args.root, name)
        levels.append({"tag": tag, "name": name, "src": src, "scenes": d.get("scenes", []),
                       "cuts": d.get("cuts", []), "duration": d.get("duration_s") or d.get("duration") or 0})
    levels.sort(key=lambda x: x["name"])

    n_all = sum(len(l["scenes"]) for l in levels)
    n_use = sum(1 for l in levels for s in l["scenes"] if s["seconds"] >= args.min_seg)
    print("[scenes] %d 关, %d 场景（其中 >=%.1fs 的 %d 个）" % (len(levels), n_all, args.min_seg, n_use))

    rows = []
    done = 0
    for lv in levels:
        cells = []
        for s in lv["scenes"]:
            t = (s["t_start"] + s["t_end"]) / 2.0
            fn = "%s-s%02d.jpg" % (lv["tag"], s["idx"])
            ok = thumb(args.ffmpeg, lv["src"], t, os.path.join(args.out, fn)) if lv["src"] else False
            done += 1
            if done % 40 == 0:
                print("  缩略图 %d/%d" % (done, n_all), flush=True)
            use = s["seconds"] >= args.min_seg
            cls = "use" if use else "frag"
            img = ('<img src="%s" loading="lazy">' % fn) if ok else '<div class="noimg">×</div>'
            cells.append('<div class="sc %s" title="场景 %d：%.2f~%.2f s">%s'
                         '<b>%.1fs</b><span>%.1f~%.1f</span></div>'
                         % (cls, s["idx"], s["t_start"], s["t_end"], img, s["seconds"], s["t_start"], s["t_end"]))
        cut_txt = " ".join("%.1fs(%s)" % (c["t"], html.escape(str(c.get("why", "?")))) for c in lv["cuts"][:8])
        rows.append('<section><h3>%s <em>%s</em> <span class="meta">%d 段 · %s</span></h3><div class="grid">%s</div>'
                    '<p class="cuts">切点：%s</p></section>'
                    % (html.escape(lv["name"]), html.escape(lv["tag"]), len(lv["scenes"]),
                       ("%.1fs" % lv["duration"]) if lv["duration"] else "", "".join(cells), cut_txt or "—"))

    doc = """<!doctype html><html lang="zh"><meta charset="utf-8">
<title>官方关卡场景总览 · 跳舞的线反推</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
 body{margin:0;background:#11131a;color:#e8eaf2;font:14px/1.5 -apple-system,"Segoe UI",Roboto,sans-serif}
 header{padding:14px 16px;background:#191c26;position:sticky;top:0;z-index:5;border-bottom:1px solid #262b39}
 h1{margin:0 0 4px;font-size:17px} header p{margin:0;color:#9aa3b8;font-size:12.5px}
 a{color:#7fb2ff} section{padding:10px 14px;border-bottom:1px solid #1e2230}
 h3{margin:0 0 8px;font-size:14.5px;font-weight:600} h3 em{color:#7c8497;font-style:normal;font-size:12px}
 h3 .meta{color:#8b94aa;font-size:12px;font-weight:400;margin-left:6px}
 .grid{display:flex;flex-wrap:wrap;gap:8px}
 .sc{position:relative;border-radius:6px;overflow:hidden;background:#0c0e14;border:2px solid #3b2f2f}
 .sc.use{border-color:#2f6b3a}
 .sc img{display:block;width:160px;height:90px;object-fit:cover}
 .noimg{width:160px;height:90px;display:flex;align-items:center;justify-content:center;color:#444}
 .sc b{position:absolute;left:4px;bottom:3px;font-size:11px;background:#000a;padding:1px 4px;border-radius:3px}
 .sc span{position:absolute;right:4px;bottom:3px;font-size:10px;color:#c9d2e6;background:#000a;padding:1px 4px;border-radius:3px}
 .cuts{margin:6px 0 0;color:#6d768c;font-size:11.5px}
 .lg{display:inline-block;width:10px;height:10px;border-radius:2px;vertical-align:-1px;margin:0 3px 0 10px}
</style>
<header><h1>🎬 官方关卡其实是剪过的 —— %d 关 / %d 个场景</h1>
<p>绿框 = 时长 ≥ %.1fs 的可用场景（%d 个）；暗红 = 过渡/碎段。
<a href="/gallery/">← 回图集</a> <span class="lg" style="background:#2f6b3a"></span>可用
<span class="lg" style="background:#3b2f2f"></span>碎段</p></header>
%s
</html>""" % (len(levels), n_all, args.min_seg, n_use, "".join(rows))
    open(os.path.join(args.out, "index.html"), "w", encoding="utf-8").write(doc)
    print("[scenes] 写好 %s" % os.path.join(args.out, "index.html"))


if __name__ == "__main__":
    main()
