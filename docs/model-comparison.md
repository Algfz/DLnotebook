# 几何模型对比实验：MoGe-2 / DA3-Giant / MapAnything / VGGT-1B

> 目的：单目几何模型的"谁更强"必须用**同一批官方帧 + 同机位回渲**判定，而不是看论文跑分。
> 本文件记录实验方法、真值来源、四张定量表、目视结论与**明确的限制**。
> 使用的验收标准来自 ADR-33（闭环回渲），工具见 `AGENT.md` §7 与本文 §7。
> 结论先行：**单帧稠密几何仍选 MoGe-2 ViT-L**（在当前合成画风上结构相关最高）；
> **多帧骨架/位姿应改用 DA3-Giant**（8 帧连续输入自洽、尺度稳定），VGGT-1B 的分块输出会裂成两团。

## 1. 实验设置

| 项 | 值 |
|---|---|
| 评测帧 | 官方"沙漠"关 `C:\DLnotebook-media\ref_official2\沙漠\_src.mp4`（1280×720 @30fps，127.08 s，3813 帧）；抽帧 `C:\DLnotebook-media\tmp\seq\desert-full\f00001..f00635.jpg`（fps=5） |
| 正对照帧 | 我们引擎渲的 `out/shot/abold/t20s.jpg`（1920×1080，**内参真值已知**） |
| 同机位回渲 | `node tools/refrender.mjs --identity --fov-y <竖直fov> --point-size 0.05 ...`（真 Chrome + 真 WebGL，相机放在点云原点，即"用重建结果还原参考帧"） |
| 评分 | `python tools/img-score.py --truth <帧> --render <渲染> ...`：`fg_iou`（前景掩膜 IoU）、`road_iou`、`edge_corr`（Sobel 梯度相关）、`edge_corr_fg`（**只在前景上算**）、`ssim`、`cover_render` |
| 点云导出 | `python tools/mkply.py --model moge\|da3 --img <帧> --tag <tag> [--process-res 504] [--force-truth-k]` |
| 下载 | `tools/fetch-hf.ps1 -Repo <hf id> -OutDir <目录> -Chunks 10`（走 **hf-mirror.com**，分片断点续传；单连接 2.7 MB/s → 10 分片 9.1 MB/s） |

### 1.1 真值内参

* 我们引擎：`src/js/game.js:289 new THREE.PerspectiveCamera(55, 1, 2, 800)` ⇒ **fov_y = 55.0°**（three.js 的 fov 是垂直的），16:9 时 **fov_x = 85.58°**。
* 官方视频：分辨率 1280×720（16:9），与引擎同画风 ⇒ **按 85.58°/55.0° 判定**。
  ⚠️ 这是**假设**（官方是 Unity 实现，不是我们的引擎），见 §6 限制 1。它的作用是给所有模型一把统一的尺子：即使真值偏 2~3°，"哪个模型更接近"的排序仍然成立。

### 1.2 同机位回渲的两种口径（很重要）

| 口径 | 做法 | 能回答什么 |
|---|---|---|
| **模型自洽口径** | 用模型**自己估的内参**把深度反投影成点云，再固定相机 55° 回渲 | "用户拿到这个模型直接用"的效果 |
| **固定真值内参口径**（`mkply.py --force-truth-k`） | 用**真值 55°** 反投影，只保留模型给的深度 | 把"fov 估错"与"深度估错"分开 |
| ~~尺度扫描口径~~ | `--scales 0.25/0.5/1` | ❌ **无效实验**：相机在原点时，点云整体乘标量不改变投影位置（只改点的大小）。早期 sweep 里这一维是白跑的 |

## 2. 表一：fov 估计（真值 fov_x 85.58° / fov_y 55.0°）

| 模型 | 输入 | fov_x | Δ | 有效像素 | 备注 |
|---|---|---|---|---|---|
| **MoGe-2 ViT-L** | 引擎 1920×1080（正对照） | 94.13 | **+8.55** | 86.9% | 有纹理的图上很稳 |
| **MoGe-2 ViT-L** | 官方 f00001 | 84.58 | **−1.00** | 4.5% | 该帧大片纯黄天空，有效像素极低 |
| **DA3-Giant** | 引擎 1920×1080（正对照） | 88.62 | **+3.04** | — | 比 MoGe 准 |
| DA3-Giant | 官方 f00001 **单帧** | 44.97 | **−40.61** | 4.5% | ✗ 单帧失效 |
| DA3-Giant | 官方 f00341 单帧（process_res 1008） | 80.06 | −5.52 | — | |
| DA3-Giant | 官方 4 帧**间隔 100/140/300 帧** | 101.02 / 72.03 / 99.51 / 54.38 | 乱 | — | ✗ **我用错了**：间隔帧基线极大 |
| **DA3-Giant** | 官方 **8 帧连续** f00341–f00348 | **79.46 ~ 81.60（中位 81.0）** | **−4.6** | 80% | ✓ 8 帧互相一致 + `scale_factor` 恒为 1.12871 + 相机中心真的在动 |
| MapAnything | 官方 f00001 / f00121 | 81.72 / 88.11 | −3.9 / +2.5 | 12% / 26% | 两帧都比 MoGe 的单帧更接近真值，且覆盖面更大 |
| VGGT-1B | 官方 `desert-a` 40 帧 | 65.55（61.44~74.30） | **−20.0** | — | 逐帧抖动大 |

**读法**：官方帧的"有效像素只有 4.5%"是 MoGe 这类置信度模型在**大面积纯色**上的固有行为（不是分辨率问题：降到 640×360 后仍是 4.5%）。
DA3-Giant 的 fov 在**多视图且小基线**时与 MoGe 单帧同级，但**单帧不可用**——它的 `anyview` 分支是靠多视图约束推 fov 的。

## 3. 表二：同机位回渲定量（fov 固定 55°，相机在点云原点）

真值前景占比：f00001 = 0.3581，f00121 = 0.3538（"前景"= 非天空区域）。

### f00001

| 渲染 | 口径 | fg_iou | edge_corr | **edge_corr_fg** | cover_render |
|---|---|---|---|---|---|
| `ren-moge-f00001-truthk.png` | MoGe 深度 + **真值内参** | 0.0288 | 0.4641 | **+0.4517** | 0.0350 |
| `ren-moge-f00001-s0.25.png` | MoGe 自洽 | 0.0538 | 0.2801 | **+0.2792** | 0.0522 |
| `ren-ma-f00001.png` | MapAnything 自洽 | 0.2054 | 0.0292 | +0.0033 | 0.0849 |
| `ren-da3-f00001-s1.png` | DA3 自洽 | 0.0400 | 0.0068 | **−0.0009** | 0.1309 |
| `ren-da3-f00001-truthk.png` | DA3 深度 + 真值内参 | 0.2979 | 0.0061 | **−0.0208** | 0.6165 |

⇒ **MoGe 的深度本身是好的**（真值内参下前景梯度相关 0.45），它自洽口径的 0.28 主要是被 fov 估大 8.5° 拖掉的；
**DA3 单帧的深度在图上是"一坨"**（真值内参下相关性仍 ≈ 0，覆盖率却 62%——糊满画面）。

### f00121

| 渲染 | fg_iou | edge_corr | edge_corr_fg | cover_render |
|---|---|---|---|---|
| `ren-moge-f00121-s1.png` | **0.7776** | 0.1259 | +0.0539 | 0.3815 |
| `ren-moge-f00121-s0.5.png` | 0.7607 | 0.1037 | +0.0323 | 0.3932 |
| `ren-moge-f00121-s0.25.png` | 0.7296 | 0.0917 | +0.0235 | 0.4161 |
| `ren-da3-f00121-s4.png` | 0.4935 | 0.1214 | +0.0439 | 0.4789 |
| `ren-da3-f00121-s1.png` | 0.4927 | 0.1013 | +0.0211 | 0.4986 |

⇒ 这一帧真值前景 0.3538，**MoGe 自洽口径覆盖 0.3815、IoU 0.78**（几乎完全复原）；DA3 单帧只有 0.49。
（注意"edge_corr_fg"在这一帧都不高，因为画面大面积是平坦色块，梯度本身很稀 ⇒ 该指标对平坦帧不敏感，看 IoU 与覆盖更可靠。）

### f00301

真值前景 0.2606。

| 渲染 | fg_iou | edge_corr_fg | ssim | cover_render |
|---|---|---|---|---|
| `ren-moge-f00301-s1.png` | **0.8100** | +0.0849 | 0.9654 | 0.2978 |
| `ren-moge-f00301-s0.5.png` | 0.7916 | +0.0753 | 0.9653 | 0.3008 |
| `ren-moge-f00301-s0.25.png` | 0.7536 | +0.0686 | 0.9658 | 0.3066 |
| `ren-da3-f00301-s1.png` | 0.2084 | +0.0252 | 0.9705 | 0.2551 |
| `ren-da3-f00301-s4.png` | 0.2047 | +0.0298 | 0.9712 | 0.2430 |
| `ren-da3-f00301-s8.png` | 0.1621 | +0.0360 | 0.9635 | 0.2049 |

⇒ 三帧合起来：**MoGe 单帧前景 IoU 0.78 / 0.81（f00121 / f00301）**，DA3 单帧 0.49 / 0.21。
f00001 的 MoGe IoU 只有 0.054 是**覆盖率**问题（该帧 MoGe 只认 4.5% 像素 ⇒ 点太少，IoU 被覆盖上限压死），
那一帧要看梯度指标：真值内参下 **edge_fg +0.45**。

## 3.1 多视图同机位回渲（DA3 的"正确用法"）

DA3 8 帧连续窗口（f00341–f00348）重建出的世界点云，用**它自己第 0 帧的位姿**回渲（`--poses` + `--frame 0`，
位姿从 `cam_c2w` 转 w2c：`R_w2c = R_c2wᵀ`、`t_w2c = −R_w2c·C`）：

* 取证图：`C:\DLnotebook-media\tmp\cmp\cmp-da3m8-341.jpg`（= [truth f00341 | DA3-8帧同机位回渲]）。
* **目视结论：山的轮廓、之字形红路、路两侧的黄色方块与左侧沟壑全都对上了** ✓✓
  （比它单帧那团黄色块好了一个量级）。
* **同机位评分**（`score-f00341.json`，真值前景 0.3244；同帧的 MoGe 单帧作对照）：

  | 渲染 | fg_iou | **road_iou** | edge_corr | edge_fg | ssim | cover |
  |---|---|---|---|---|---|---|
  | MoGe 单帧（自洽 K，fov 88.70°） | **0.6192** | 0.5448 | 0.2238 | 0.2254 | 0.9578 | 0.4745 |
  | DA3-Giant 8 帧多视图（自洽 K，fov 81.60°） | 0.2461 | **0.7079** | **0.3521** | **0.3393** | 0.9682 | 0.4887 |

  ⇒ **分项看各有胜负**：MoGe 的**整体前景轮廓**更像（IoU 0.62 vs 0.25），
  DA3 多视图的**路面结构**（road_iou 0.71 vs 0.54）与**边缘**（edge_fg 0.34 vs 0.23）更好。
  取证图 `cmp-341-moge-vs-da3m8.jpg` 与目视一致：MoGe 面板山的轮廓更贴，DA3 面板红色之字路更锐、位置更准。

⇒ **DA3-Giant 不该被单帧判死刑**：它的价值在"连续多帧 + 小基线"，正好是步骤 2/4 需要的位姿与骨架。

## 4. 表三：多视图一致性（俯视图 + 轨迹）

| 模型 | 帧数 | 点数 | 轨迹（模型单位） | fov 帧间一致性 | 俯视图 |
|---|---|---|---|---|---|
| **VGGT-1B** | 40（`desert-a` 每 3 帧） | 77,070 | 路径 0.5476，步长中位 0.0118 | 61.4~74.3°（±13°） | ✗ **裂成两团**，轨迹与两团都不重合 |
| **DA3-Giant** | 8（连续 f00341–f00348） | 5,898,259（8 个世界系 PLY） | cam 由 `[0.0226,0.1992,−0.0693]` 走到 `[−0.0341,−0.0319,0.1332]` | 79.5~81.6°（±2°） | ✓ **一整片连续扇形地面**，轨迹贴在上面 |
| MoGe（我的 2D 仿射融合） | 635 | 900k（voxel 0.02） | 路径 137.52（≈1.08 单位/s） | 不适用（沿用单帧内参） | 🟡 长条走廊带连成一片，但远处地面是**扇形/鱼骨纹**（2D 相似变换对齐在长距离上必然漂） |

取证图：`C:\DLnotebook-media\tmp\cmp\top-3up.png`（三联俯视）、`top-vggt.png`、`top-da3m8.png`、`top-moge.png`（由 `tools/cmp-top.py` 生成）。

## 5. 目视结论（`C:\DLnotebook-media\tmp\cmp\test-montage.jpg`）

三联图 `[参考帧 f00001 | MoGe 自洽 @55° | DA3-Giant 自洽 @55°]`：

* **参考帧**：路向左上拐，红边 + 红方块 + 两个黄色高台。
* **MoGe 面板**：同一个弯、红边、红方块都在 ✓（虽然偏糊）。
* **DA3 面板**：一团认不出的黄色块，弯和方块都没有 ✗。

⇒ 在**我们的合成美术风格**上（纯色、硬边、大面积同色），**单帧**几何 MoGe-2 ViT-L 明显更可用；
DA3-Giant 的价值在**多视图**（表三 + §3.1，它的 8 帧同机位回渲能把整条路和山形还原出来），
不该拿它做单帧密集重建。

## 5.1 一张图说清"该用谁"

| 用途 | 最优模型 | 证据 |
|---|---|---|
| **单帧稠密深度 → 道具尺寸/离路距离** | **MoGe-2 ViT-L** | f00121 IoU 0.78、f00301 IoU 0.81、f00001 真值内参下 edge_fg +0.45 |
| **多帧位姿/骨架 → 沿路连续场** | **DA3-Giant（连续 8~24 帧，fp32）** | fov 中位 81.0°（−4.6°）、8 帧 `scale_factor` 恒定、俯视图连续、同机位回渲能认出整条路 |
| **单帧内参标定 / 覆盖率兜底** | **MapAnything** | fov −3.9°/+2.5°、覆盖 12%/26%（MoGe 在纯色帧只有 4.5%） |
| 交叉核对（不单独用） | VGGT-1B | fov −20°、点云裂两团 ⇒ 只作旁证 |

## 6. 限制（必须和结论一起读）

1. **官方视频的 fov 真值是继承来的假设**（85.58°/55.0° 来自我们引擎）。要独立验证得用灭点/已知长度联合标定——尚未做。
2. **`--scales` 一维是无效实验**（见 §1.2）；表二的数字只反映几何与内参，不反映点大小。
3. 回渲是"点云 + `sizeAttenuation` 的点精灵"，`cover_*` / `edge_*` 对 `--point-size` 敏感（本表统一 0.05）。
4. 官方关卡的**绝对尺度未知**（我们的路宽 3 单位只是我们引擎的参数）⇒ 表中一切长度都是"模型单位"。
5. 只测了**沙漠一关 + 2 个评测帧 + 1 个 8 帧窗口**。换美术风格（写实贴图、复杂光照）结论可能不同。
6. **DA3-Giant 只能 fp32**：bf16 会在包内部显式 `.float()` 处炸
   （`RuntimeError: expected scalar type Float but found BFloat16`，栈 `dualdpt.py:220 x = self.norm(x)`；
   1377 个参数其实都已转 bf16，元凶是 `vision_transformer.py:226 pos_embed = self.pos_embed.float()`、`head_utils.py:146 return emb.float()`）。
   fp32 + `process_res=504` 实测 **2.70 s/帧（8 帧批）**，8 GB 卡不 OOM。
7. **官方 CLI 不可用**：`da3 image ...` 在 `depth_anything_3/cli.py:383` 抛
   `NameError: name 'reference_view_strategy' is not defined`（0.1.1 打包 bug）⇒ 只用 Python API
   `depth_anything_3.api.DepthAnything3.from_pretrained(dir).inference(...)`。
   MapAnything 没有 PyPI 包，走 `codeload.github.com/facebookresearch/map-anything/tar.gz/refs/heads/main`。

## 7. 复现命令

```powershell
$py = "C:\Users\abc\.conda\envs\comfyui\python.exe"
$seq = "C:\DLnotebook-media\tmp\seq\desert-full"
$cmp = "C:\DLnotebook-media\tmp\cmp"

# 1) fov 标定（MoGe + DA3 都跑；--no-da3 / --no-moge 可关掉一个）
& $py tools\cmp-fov.py --img "$seq\f00001.jpg" --img "C:\D\DLnotebook\out\shot\abold\t20s.jpg" --process-res 504 --da3-dtype fp32

# 2) 单帧点云（自洽 / 真值内参两种口径；产物 <model>-<tag>-s<scale>[-truthk].ply + .json）
& $py tools\mkply.py --model moge --img "$seq\f00001.jpg" --tag f00001 --out $cmp --scales 0.25,0.5,1
& $py tools\mkply.py --model moge --img "$seq\f00001.jpg" --tag f00001 --out $cmp --force-truth-k
& $py tools\mkply.py --model da3  --img "$seq\f00001.jpg" --tag f00001 --out $cmp --scales 1,4,8 --process-res 504

# 3) 同机位回渲 + 评分
node tools\refrender.mjs --cloud "$cmp\moge-f00001-s0.25.ply" --identity --fov-y 55 --point-size 0.05 `
     --far-pct 1.0 --far-min 60 --bg "#f0d24b" --out "$cmp\ren-moge-f00001-s0.25.png" --w 1280 --h 720
& $py tools\img-score.py --truth "$seq\f00001.jpg" --render "$cmp\ren-moge-f00001-s0.25.png" --out "$cmp\score-f00001.json"

# 4) DA3 多视图（连续 8 帧，fp32 + process_res 504）
& $py tools\refserve-da3.py --dir $seq --tag da3m8 --frames 340-347 --multi --chunk 8 `
     --process-res 504 --dtype fp32 --ply --out "$cmp\da3m"

# 5) 俯视图对比
& $py tools\cmp-top.py --ply "$cmp\da3m\da3m8-f0034*.ply" --poses "$cmp\da3m\da3m8-poses.json" `
     --out "$cmp\top-da3m8.png" --up-axis=-y
& tools\montage.ps1 -Out "$cmp\top-3up.png" -Img "$cmp\top-vggt.png|VGGT-1B 40f", "$cmp\top-da3m8.png|DA3-Giant 8f", "$cmp\top-moge.png|MoGe fused 635f"
```

## 8. 对"反推官方关卡"的直接影响

| 步骤 | 之前 | 本次实验后 |
|---|---|---|
| 2 骨架（位姿/内参） | VGGT-1B 24~40 帧，fov 偏 −20°，点云裂成两团 | **改用 DA3-Giant 连续 8~24 帧**（fov −4.6°、尺度因子恒定、轨迹自洽）；VGGT 保留作交叉核对 |
| 3 静态几何（道具/尺寸） | MoGe-2 ViT-L 单帧 | **仍是 MoGe**（同机位回渲结构相关最高），但必须用**已知/标定过的内参**，否则 fov 误差会污染一切尺寸 |
| 4 沿路连续场 | MoGe 逐帧 + 2D 仿射链式对齐（会漂） | 用 DA3 多视图给**位姿**，MoGe 给**稠密深度**，再 TSDF/ICP 融合；不要再用 2D 仿射 |
| 尺度 | 以路宽 W 为单位 | 不变（MapAnything 的 `metric_scaling_factor` 两帧一致，可作为新的尺度线索，待验证） |
