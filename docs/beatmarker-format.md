# BeatMarker 导出格式说明（引擎无关；Unity 章节为历史遗留）

> ⚠️ **2026-10-12：本项目不再做 Unity 版**（见 `AGENT.md` ADR-13，已废弃）。
> 本文的格式说明仍然有效且是必需的——`.beat.json` 是**纯数据**，客户端与生成器都在读它；
> 只有**「Unity 对接要点」一章**属于历史留档；其余章节（导出格式说明、
> `dance-line.json` 的生成）**当前仍在使用**——`dance-line.json` 是
> `tools/PathPreview.html` 与 `tools/SceneryEditor.html` 的输入。

工具：`tools/BeatMarker.html`（纯前端，双击用浏览器打开，无需安装）
导出：点「导出 JSON」→ 得到 `曲名.beat.json`

**它是纯数据，与引擎无关**——Unity / Unreal / 自研引擎都能读。
下面是每个字段的确切含义，以及对接时的注意事项。

## 顶层结构

```jsonc
{
  "tool": "BeatMarker",
  "version": "0.3",
  "audio":  { "name": "xxx.mp3", "duration": 152.15, "sampleRate": 44100 },
  "latency_ms": 299.0,          // ⚠️ 见下方「延迟的坑」
  "timing": {
    "offset": 0.397,            // 第一拍的时间（秒），即网格相位
    "meter": 4,                 // 拍号（4 = 4/4 拍）
    "sections": [ /* 分段，见下 */ ]
  },
  "beats":  [0.397, 1.248, ...],          // 全曲每一拍的时间（秒）
  "tracks": [                             // ★ 两条线各一组踩音点
    { "id": "A", "count": 120, "marks": [ { "i": 0, "time": 1.234, "beat": 0.85 }, ... ] },
    { "id": "B", "count": 118, "marks": [ ... ] }
  ],
  "marks":  [ /* = tracks[0].marks，供只认单轨的旧读取方直接使用 */ ],
  "count": 120
}
```

### `tracks` —— 两条线的踩音（双轨）

一关若有**两条线**（玩家同时操控），每条线的转向时刻可以不同，因此分两组：

| 字段 | 含义 |
|---|---|
| `tracks[0]` | **线 A** 的踩音点（与旧版 `marks` 含义相同） |
| `tracks[1]` | **线 B** 的踩音点 |
| `tracks[].id` | 轨道标识，固定 `"A"` / `"B"` |
| `tracks[].marks` | 该线的踩音点数组，字段与旧的 `marks[]` 完全一致（`i` / `time` / `beat`） |

> 只有一条线时，`tracks[1].marks` 为空数组。
> 顶层 `marks` 字段保留（= 线 A），这样**旧的单轨读取方（含 Unity 脚本）不改也能用**。

**做双线关卡时，`tracks[0].marks[].time` 与 `tracks[1].marks[].time` 分别是两条线的转向时刻。**

### `marks` —— 核心产出

| 字段 | 含义 |
|---|---|
| `time` | **踩音点的秒数**（绝对值，从音频 0 秒算起）。关卡里的转向时刻直接用它 |
| `beat` | 该点落在第几拍（小数，按分段 BPM 折算），用于按拍号复算或提纯节奏 |
| `i` | 序号（0 起） |

**做关卡时，`marks[].time` 就是转向点的时间轴。**

### `timing.sections` —— 分段 BPM

```jsonc
{ "t": 0, "bpm": 70.5, "phase": 0.397, "div": 1, "snap": true }
```

| 字段 | 含义 |
|---|---|
| `t` | 这一段的**开始时间**（秒）。第一段通常是 0 |
| `bpm` | 这一段的速度 |
| `phase` | 这一段起点处的**网格相位**（即该段第一拍的时间，秒） |
| `div` | 吸附细分（1 = 整拍，2 = 八分，4 = 十六分……） |
| `snap` | 这一段是否开启吸附；`false` 表示自由段（如收尾渐弱） |

**BPM 中途会变**，所以第 n 拍的时间要**逐段积分**算，不能用 `t = offset + n*60/bpm` 一算到底。

### `beats`

全曲每一拍的时间数组，已经按分段 BPM 展开好了。
如果只是要"拍子在哪"，直接用它，不必自己积分。

## ⚠️ 延迟的坑（`latency_ms`）

这个值 = **音频输出延迟 + 人的反应时间**。

- 在踩音器里，它是**正确的**：你打点时带着同样的反应时间，两者正好抵消。
- **但在游戏里不能直接照搬**。游戏里的点击由程序判定，不存在"人的反应时间"，
  所以照搬会让判定**偏早**约 100~200ms。

游戏里应该只保留**设备输出延迟**部分（蓝牙耳机约 200~300ms，有线约 20~50ms），
并按你原本的设计拆成两层：

```
实际音频延迟 = 全局音频延迟（玩家设置，针对设备）+ 关卡内音频延迟（关卡自带）
```

建议：游戏里做一个和踩音器同款的校准（播放蜂鸣 → 玩家跟着敲），
但**校准 UI 要说明这是设备延迟**，且判定用该值；
或者直接让玩家在设置里手动微调（对着鼓点调，最可靠）。

## Unity 对接要点

> ⚠️ **历史留档（2026-10-12 起不再推进）**：本项目不做 Unity 版了（ADR-13 已废弃）。
> 以下内容仅在"以后又想用 Unity"时作参考，日常开发请忽略。
### 1. 音频时钟必须用 `AudioSettings.dspTime`

`Time.time` 会随帧率抖动，几分钟能漂出去几十毫秒，音游绝对不能用。
标准做法是记录调度时刻，用 dspTime 差值：

```csharp
public class SongClock : MonoBehaviour {
    public AudioSource src;
    double dspStart;
    public bool playing { get; private set; }

    public void Play() {
        dspStart = AudioSettings.dspTime + 0.1;   // 留一点调度余量
        src.PlayScheduled(dspStart);
        playing = true;
    }

    // 采样级精确的音频时间（秒）
    public double time => AudioSettings.dspTime - dspStart;
}
```

判定、路面推进、场景事件**全部读这个 `time`**，不要读 `Time.time`。

### 2. 数据结构与读取（JsonUtility 可直接反序列化）

```csharp
[Serializable] public class BeatMap {
    public string tool, version;
    public AudioInfo audio;
    public float latency_ms;
    public Timing timing;
    public float[] beats;
    public Mark[] marks;          // 单轨（= 线 A）
    public Track[] tracks;        // 双轨（两条线），只有一条线时可忽略
    public int count;
}
[Serializable] public class AudioInfo { public string name; public float duration; public int sampleRate; }
[Serializable] public class Timing { public float offset; public int meter; public Section[] sections; }
[Serializable] public class Section { public float t, bpm, phase; public int div; public bool snap; }
[Serializable] public class Mark { public int i; public float time, beat; }
[Serializable] public class Track { public string id; public int count; public Mark[] marks; }

// 读取（放在 StreamingAssets 下，跨平台可读）
var path = System.IO.Path.Combine(Application.streamingAssetsPath, "xxx.beat.json");
var map  = JsonUtility.FromJson<BeatMap>(System.IO.File.ReadAllText(path));

// 转向时刻
foreach (var m in map.marks) Debug.Log($"转向 @ {m.time}s (第 {m.beat} 拍)");
```

> 顶层是对象不是数组，所以 `JsonUtility` 能用（它不支持顶层数组）。

### 3. 分段 BPM 下第 n 拍的时间（逐段积分）

```csharp
double BeatToTime(BeatMap map, double beat) {
    var s = map.timing.sections;
    double acc = 0;                                   // 到当前段起点为止已累积的拍数
    for (int i = 0; i < s.Length; i++) {
        bool last = (i + 1 == s.Length);
        double beatsInSeg = last
            ? double.PositiveInfinity
            : (s[i + 1].t - s[i].t) * s[i].bpm / 60.0;
        if (last || beat <= acc + beatsInSeg)
            return s[i].phase + (beat - acc) * 60.0 / s[i].bpm;
        acc += beatsInSeg;
    }
    return 0;
}
```

### 4. 当前时间属于第几拍

```csharp
double TimeToBeat(BeatMap map, double t) {
    var s = map.timing.sections;
    int i = 0;
    for (int k = s.Length - 1; k >= 0; k--) if (t >= s[k].t) { i = k; break; }
    double acc = 0;
    for (int k = 0; k < i; k++)
        acc += (s[k + 1].t - s[k].t) * s[k].bpm / 60.0;
    return acc + (t - s[i].t) * s[i].bpm / 60.0;
}
```

## 生成「理想舞线轨迹」（`dance-line.json`，供路径预览与布景）

```bash
node build/gen-path.js --width 1
```

读取 `.beat.json`，在同级目录输出 `dance-line.json`（纯几何数据）
和 `dance-line.svg`（俯视预览图，浏览器直接打开即可看形态）。

**双轨**：`.beat.json` 若有 `tracks[]`（线 A / 线 B），则**每条线各生成一条路径**，
预览图左右并排显示两条线；`dance-line.json` 顶层仍是线 A（向后兼容），
双线数据附在 `lines[]`。只有单轨（旧格式）时行为与以往完全一致。

**最小转角间隔**：相邻两个转折点之间的最小距离（米），即"最短段长"。
`--b-x` / `--b-z` 都用它作单位（例：`--b-z 10` = 线 B 起点下移 10 × 2.386m = 23.86m；
`--b-x -5` = 左移 5 × 2.386m = 11.93m）。整条线随之平移、**形状不变**。

| 参数 | 默认 | 说明 |
|---|---|---|
| `--speed` | 12 | 线速（米/拍），决定路径尺度 |
| `--mps` | 14 | 线速（米/秒，恒定）；给了它就不用 `--speed` |
| `--width` | 1 | 线宽（米） |
| `--sample` | 5 | 布景采样间距（米） |
| `--elevate` | 0 | 高架桥桥面高度（米），>0 时输出 bridge |
| `--pier` | 18 | 桥墩间距（米） |
| `--split` | 关 | 在崩塌处瞬移断开成两个场景 |
| `--level` | 关 | 同时输出客户端 `level.json`；双轨时写入可选 `lines[]`（顶层 `path` 仍是线 A） |
| `--b-x n` | 0 | 双线：**线 B 起始位置沿 X 平移 n 个「最小转角间隔」**（正=俯视向右，负=向左） |
| `--b-z n` | 0 | 双线：**线 B 起始位置沿 Z 平移 n 个「最小转角间隔」**（正=俯视向下，负=向上） |
| `--b-gap n` | 0 | 旧写法，等价 `--b-z n`（只能向下） |
| `--view a,b` | 关 | **预览图只画 [a,b] 秒**（路径太密时用来放大看形态；JSON 仍是全曲） |
| `--out NAME` | dance-line | 输出文件名前缀（`NAME.json` / `NAME.svg`） |
| `--svg-only` | 关 | 只出预览图，不写 JSON / level |
| `--no-svg` | 关 | 不生成预览图 |

> 高难关卡踩音本就密集（如 3–4 转/秒），整曲俯视预览会糊成一条斜线——那只是**尺度**现象，不是错误。
> 用 `--view 0,30` 之类的窗口放大，即可看清之字形是否正常。

输出字段：

- `points[]` — `t` 时间、`x/y/z` 坐标、`turn` 该点是否转向（R/L/null）、
  `dir` 离开该点时的方向（0:+X 1:+Z 2:-X 3:-Z）
- `segments[]` — 段长 `len`、方向 `dir`、中心点 `mid`（布景对位用）
- `samples[]` — 沿路径每 N 米一个采样点，批量摆景物时直接用
- `scenes[]` — 各幕的时间范围与点索引范围（分场景布景用）

**线速不能太低**：踩音最密处间隔只有 0.19 秒，速度一低，段长就会短于线宽，
路面会自己叠在一起。脚本会检查「最短段」和「最近路段间距」，小于线宽时告警。

> 曾经有一个 Unity 侧脚本 `tools/unity/DanceLinePath.cs`（拖入 JSON 即可画线并生成路面），
> 已于 2026-10-12 随 Unity 方向一并删除——需要时从 git 历史里取回。

## 导出是纯数据，可以直接搬走

`.beat.json` 里只有时间与参数，不含任何客户端专有结构，所以同一份导出
**既能给网页客户端用，也能给任何其它引擎用**（引擎无关是它的设计目标）。
