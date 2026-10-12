/* =====================================================================
   render-demo.js — 离线渲染「演示视频」（逐帧渲染 + 合成音轨）

   为什么需要它：
     客户端里画面比音频**晚** latency_ms（预卷补偿），所以直接录屏得到的
     视频「音频提前」。离线渲染把画面按 latency = 0 生成（转向正好落在鼓点上），
     再和关卡 mp3 合成，就得到干净、同步的演示视频 —— 不需要给客户端加录制功能。

   做法（不引入任何 npm 依赖）：
     1. 起本地服务器（复用 tools/dev-server.js），页面才能 fetch 关卡与音乐
     2. 用 Chrome 打开客户端，注入一段「虚拟时钟」脚本：
        · performance.now() 与 AudioContext.currentTime 都改走虚拟时间
        · 接管 requestAnimationFrame —— 页面自己的循环不再自动跑，
          改由本脚本一帧一帧地喂（于是渲染不受实时限制，跑多快算多快）
     3. 每帧：设虚拟时间 → 走一帧 → canvas.toDataURL('image/jpeg')
        （必须在同一个 JS 任务里读像素；跨任务时 WebGL 缓冲已提交，读出来是黑的）
     4. ffmpeg 把逐帧图和 mp3 合成 mp4

   用法：
     node tools/render-demo.js --level "Breeze"                 # 整关
     node tools/render-demo.js --level "Breeze" --end 5          # 只渲染前 5 秒（试跑）
     node tools/render-demo.js --level "Breeze" --start 100 --end 105   # 抽一段看效果
     node tools/render-demo.js --level "Breeze" --hud            # 保留 HUD（默认隐藏）
     node tools/render-demo.js --level "Breeze" --headless       # 无窗口（慢，软件渲染）

   主要参数：
     --level <名>      关卡目录名或标题的关键字（必填）
     --w/--h           分辨率，默认 3840x2160（4K）
     --fps             帧率，默认 60
     --start/--end     渲染区间（秒）。--start 之前只推进不截帧，用来热好状态
     --q               JPEG 质量，默认 88
     --out             输出 mp4 路径，默认 out/<关卡名>-<宽x高><fps>.mp4
     --frames          逐帧图目录，默认 out/frames
     --keep-frames     编码完不删逐帧图（默认保留；传 --clean-frames 才删）
     --encoder         h264_nvenc（默认）| libx264
   ===================================================================== */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");

/* ---------------------- 参数 ---------------------- */
function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i];
    if (!s.startsWith("--")) { a._.push(s); continue; }
    const eq = s.indexOf("=");
    if (eq >= 0) { a[s.slice(2, eq)] = s.slice(eq + 1); }
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) { a[s.slice(2)] = argv[++i]; }
    else { a[s.slice(2)] = true; }
  }
  return a;
}
const A = parseArgs(process.argv.slice(2));
const O = {
  level: A.level || A._[0],
  w: parseInt(A.w, 10) || 3840,
  h: parseInt(A.h, 10) || 2160,
  fps: parseFloat(A.fps) || 60,
  start: A.start != null ? parseFloat(A.start) : 0,
  end: A.end != null ? parseFloat(A.end) : null,
  q: parseFloat(A.q) || 88,
  hud: !!A.hud,
  headless: !!A.headless,
  out: A.out || null,
  frames: A.frames || path.join(ROOT, "out", "frames"),
  cleanFrames: !!A["clean-frames"],
  encoder: A.encoder || "h264_nvenc",
  port: parseInt(A.port, 10) || 8231,
  cdpPort: parseInt(A["cdp-port"], 10) || 9231,
  chrome: A.chrome || null,
};
if (!O.level) {
  console.error("缺少 --level（关卡目录名或标题关键字）");
  process.exit(2);
}

const log = (...m) => console.log(...m);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------------- 小工具 ---------------------- */
function findLevelDir(key) {
  const root = path.join(ROOT, "levels");
  const dirs = fs.readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory()).map(e => e.name);
  const hit = dirs.find(d => d === key) || dirs.find(d => d.includes(key))
    || dirs.find(d => { try { const j = JSON.parse(fs.readFileSync(path.join(root, d, "level.json"), "utf8")); return String(j.meta && j.meta.title || "").includes(key); } catch (e) { return false; } });
  if (!hit) throw new Error("levels/ 下找不到匹配「" + key + "」的关卡，可选：" + dirs.join(" / "));
  const dir = path.join(root, hit);
  const json = JSON.parse(fs.readFileSync(path.join(dir, "level.json"), "utf8"));
  return { name: hit, dir, json };
}

function mediaDuration(file) {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration",
    "-of", "csv=p=0", file], { encoding: "utf8" });
  const d = parseFloat(String(r.stdout).trim());
  if (!isFinite(d) || d <= 0) throw new Error("ffprobe 读不到时长：" + file);
  return d;
}

function findChrome() {
  const cands = [
    O.chrome,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error("找不到 Chrome / Edge，可用 --chrome 指定路径");
}

/* ---------------------- CDP 客户端（Node 自带 WebSocket） ---------------------- */
class CDP {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((res, rej) => {
      this.ws.addEventListener("open", res, { once: true });
      this.ws.addEventListener("error", e => rej(new Error("CDP 连接失败：" + (e.message || e.type))), { once: true });
      setTimeout(() => rej(new Error("CDP 连接超时")), 15000);
    });
    this.ws.addEventListener("message", ev => {
      let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? p.rej(new Error(msg.method + " → " + msg.error.message)) : p.res(msg.result);
      }
    });
  }

  send(method, params) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }

  close() { try { this.ws && this.ws.close(); } catch (e) { /* 忽略 */ } }

  // 求值并取回值（出错时把页面的异常抛出来）
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error("页面报错：" + ((d.exception && (d.exception.description || d.exception.value)) || d.text));
    }
    return r.result ? r.result.value : undefined;
  }
}

/* ---------------------- 注入页面的「虚拟时钟」脚本 ---------------------- */
// 关键三件事：
//  ① performance.now / AudioContext.currentTime 改走 __vt（虚拟时间）
//  ② 接管 requestAnimationFrame：页面循环注册进来后不再自动执行
//  ③ 预置 localStorage：latency=0（演示视频不需要预卷）、开启自动播放、静音
function initScript(fps, autoLines) {
  return `(() => {
  try {
    localStorage.setItem("dlfan.settings", JSON.stringify({
      latency: 0, volume: 0, guide: false,
      autoLines: ${JSON.stringify(autoLines)}, keys: [], quality: "high",
    }));
  } catch (e) { /* 隐私模式等，忽略 */ }

  const FPS = ${fps};
  window.__vt = 0;
  window.__frames = 0;

  // ① 时间源
  try {
    Object.defineProperty(performance, "now", {
      value: () => window.__vt * 1000, configurable: true, writable: true,
    });
  } catch (e) { /* 忽略 */ }
  for (const n of ["BaseAudioContext", "AudioContext", "webkitAudioContext"]) {
    const C = window[n];
    if (!C || !C.prototype) continue;
    try {
      Object.defineProperty(C.prototype, "currentTime", {
        get: () => window.__vt, configurable: true,
      });
    } catch (e) { /* 忽略 */ }
  }

  // ② rAF 接管
  const cbs = [];
  let nid = 0;
  window.requestAnimationFrame = cb => { const id = ++nid; cbs.push({ id, cb }); return id; };
  window.cancelAnimationFrame = id => { const i = cbs.findIndex(o => o.id === id); if (i >= 0) cbs.splice(i, 1); };

  // 把虚拟时间设到 t 并执行一帧（页面里的游戏循环会把自己重新注册回来）
  window.__setTime = t => {
    window.__vt = t;
    window.__frames++;
    const list = cbs.splice(0);
    for (const o of list) o.cb(t * 1000);
  };
})();`;
}

/* ---------------------- 主流程 ---------------------- */
let devServer = null, chrome = null, cdp = null, userDataDir = null;
let framesWritten = 0;
let progressFile = null;

function writeProgress(text) {
  if (!progressFile) return;
  try { fs.writeFileSync(progressFile, text + "\n"); } catch (e) { /* 忽略 */ }
}

function cleanup() {
  try { if (cdp) cdp.close(); } catch (e) { /* 忽略 */ }
  try { if (chrome && !chrome.killed) chrome.kill(); } catch (e) { /* 忽略 */ }
  try { if (devServer && !devServer.killed) devServer.kill(); } catch (e) { /* 忽略 */ }
  try { if (userDataDir && fs.existsSync(userDataDir)) fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
}

async function main() {
  const lv = findLevelDir(O.level);
  const musicPath = path.join(lv.dir, lv.json.music);
  if (!fs.existsSync(musicPath)) throw new Error("找不到音乐文件：" + musicPath);
  const duration = mediaDuration(musicPath);
  const endT = Math.min(O.end != null ? O.end : duration, duration);
  const nFrames = Math.max(1, Math.round(endT * O.fps));
  const startFrame = Math.max(0, Math.round(O.start * O.fps));
  // 每条线都自动播放（演示视频不需要玩家操作）；--manual 可关掉
  const nLines = Array.isArray(lv.json.lines) && lv.json.lines.length
    ? lv.json.lines.length : 1;
  const autoLines = new Array(Math.max(nLines, 2)).fill(!A.manual);

  fs.mkdirSync(O.frames, { recursive: true });
  O.frames = path.resolve(O.frames);
  progressFile = path.join(path.dirname(O.frames), "render-progress.txt");
  const outFile = path.resolve(O.out || path.join(ROOT, "out",
    lv.name.replace(/[\\/:*?"<>|]/g, "_") + "-" + O.w + "x" + O.h + "-" + O.fps + "fps.mp4"));

  log("");
  log("  关卡      " + lv.name + "（" + (lv.json.meta && lv.json.meta.title) + "）");
  log("  音乐      " + lv.json.music + "（" + duration.toFixed(3) + "s）");
  log("  线数      " + nLines + "，自动播放 " + (A.manual ? "关（手动按键逐帧模拟暂未实现）" : "开"));
  log("  分辨率    " + O.w + "x" + O.h + " @" + O.fps + "fps，JPEG q" + O.q);
  log("  帧范围    第 " + startFrame + " ~ " + (nFrames - 1) + " 帧（共 " + nFrames + " 帧，"
    + (nFrames / O.fps).toFixed(1) + "s）");
  log("  逐帧图    " + O.frames);
  log("  输出      " + outFile);
  log("");
  writeProgress("启动中…");

  /* 1. 本地服务器 */
  devServer = spawn(process.execPath, [path.join(ROOT, "tools", "dev-server.js"), String(O.port)],
    { cwd: ROOT, stdio: "ignore" });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await sleep(250);
    try { const r = await fetch("http://127.0.0.1:" + O.port + "/api/levels"); up = r.ok; } catch (e) { /* 还没起来 */ }
  }
  if (!up) throw new Error("本地服务器启动失败（端口 " + O.port + " 被占用？）");
  log("  本地服务器就绪 → http://127.0.0.1:" + O.port);

  /* 2. 启动 Chrome */
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dlrender-"));
  const args = [
    "--remote-debugging-port=" + O.cdpPort,
    "--remote-allow-origins=*",
    "--user-data-dir=" + userDataDir,
    "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    "--mute-audio",
    "--autoplay-policy=no-user-gesture-required",
    // 这几条是「别因为窗口不可见/在后台就偷懒」：本工具自己喂帧，不能被节流
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--disable-features=CalculateNativeWinOcclusion",
    "--window-size=1280,720",
    "--window-position=-30000,-30000",          // 挪到屏幕外，不打扰用户
    "about:blank",
  ];
  if (O.headless) {
    args.unshift("--headless=new");
    args.splice(1, 0, "--use-angle=swiftshader", "--enable-unsafe-swiftshader");
  }
  const chromePath = findChrome();
  log("  浏览器    " + chromePath + (O.headless ? "（无窗口 / 软件渲染）" : "（有窗口 / 用 GPU，已挪到屏幕外）"));
  chrome = spawn(chromePath, args, { stdio: "ignore" });

  let wsUrl = null;
  for (let i = 0; i < 80 && !wsUrl; i++) {
    await sleep(250);
    try {
      const list = await (await fetch("http://127.0.0.1:" + O.cdpPort + "/json/list")).json();
      const page = list.find(t => t.type === "page");
      if (page) wsUrl = page.webSocketDebuggerUrl;
    } catch (e) { /* 还没起来 */ }
  }
  if (!wsUrl) throw new Error("连不上 Chrome 调试端口（" + O.cdpPort + "）");

  /* 3. 注入脚本 → 设视口 → 打开页面 */
  cdp = new CDP(wsUrl);
  await cdp.connect();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: initScript(O.fps, autoLines) });
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: O.w, height: O.h, deviceScaleFactor: 1, mobile: false,
  });
  await cdp.send("Page.navigate", { url: "http://127.0.0.1:" + O.port + "/" });

  // 等模块执行完（index.html 里有个 __moduleLoaded 标志）
  let ok = false;
  for (let i = 0; i < 60 && !ok; i++) {
    await sleep(300);
    try { ok = await cdp.eval("window.__moduleLoaded === true"); } catch (e) { /* 页面还在加载 */ }
  }
  if (!ok) {
    const fatal = await cdp.eval("(document.getElementById('fatal')||{}).textContent || ''");
    throw new Error("客户端没有启动起来" + (fatal ? "：" + fatal : ""));
  }

  /* 4. 选关 → Play → 点一下开始（首帧要输入才启动）→ 藏 HUD */
  const title = (lv.json.meta && lv.json.meta.title) || lv.name;
  const started = await cdp.eval(`(async () => {
    const items = [...document.querySelectorAll("#selList .lvItem")];
    const hit = items.find(el => (el.querySelector(".t") || {}).textContent === ${JSON.stringify(title)})
             || items.find(el => (el.querySelector(".t") || {}).textContent.includes(${JSON.stringify(O.level)}));
    if (!hit) return "关卡列表里没有：" + ${JSON.stringify(title)};
    hit.click();
    document.querySelector("#btnPlay").click();
    return "ok";
  })()`);
  if (started !== "ok") throw new Error(String(started));

  // 等游戏视图建好（canvas 有尺寸 + 关卡标题出现在 HUD 里）
  let ready = false, lastState = null;
  for (let i = 0; i < 60 && !ready; i++) {
    await sleep(300);
    try {
      lastState = await cdp.eval(`(() => {
        const v = document.getElementById("viewGame");
        const c = document.getElementById("gameCanvas");
        return {
          viewHidden: !v || v.classList.contains("hide"),
          hasCanvas: !!c,
          canvasW: c ? c.width : 0, canvasH: c ? c.height : 0,
          clientW: c ? c.clientWidth : 0, clientH: c ? c.clientHeight : 0,
          winW: innerWidth, winH: innerHeight,
          // HUD 文案由页面自己的循环刷新，而我们已接管 rAF，所以这里喂一帧再读
          hudInfo: (window.__setTime && window.__setTime(0),
                    (document.getElementById("hudInfo") || {}).textContent) || "",
          err: (document.getElementById("errBox") || {}).textContent || "",
          fatal: (document.getElementById("fatal") || {}).textContent || "",
        };
      })()`);
      if (A.debug) log("    [debug] " + JSON.stringify(lastState));
      ready = !lastState.viewHidden && lastState.hasCanvas
        && lastState.canvasW >= O.w && lastState.canvasH >= O.h
        && lastState.hudInfo.indexOf(title.slice(0, 8)) >= 0;
    } catch (e) { /* 还在建 */ }
  }
  if (!ready) {
    throw new Error("游戏视图没建好。页面状态：" + JSON.stringify(lastState));
  }
  log("  关卡已就绪，画布 " + O.w + "x" + O.h);

  // 点一下画布开始（idle → playing）。此时 __vt 还是 0，所以音频时钟的 t0 = 0。
  await cdp.eval(`(() => {
    document.getElementById("gameCanvas").dispatchEvent(
      new MouseEvent("mousedown", { button: 0, bubbles: true }));
    if (!${O.hud}) document.getElementById("hud").style.display = "none";
    window.dispatchEvent(new Event("resize"));     // 让 renderer 按最终视口重新 setSize
    return true;
  })()`);
  const info = await cdp.eval(`(() => {
    const c = document.getElementById("gameCanvas");
    return { canvas: c.width + "x" + c.height, keyBtns: document.querySelectorAll("#keyRows .keyBtn").length };
  })()`);
  log("  画布实际尺寸 " + info.canvas + "，操作按键行 " + info.keyBtns + "（= 线数）");
  if (!O.hud) log("  HUD 已隐藏（要保留加 --hud）");

  /* 5. 逐帧渲染 */
  log("");
  const t0 = Date.now();
  for (let i = 0; i < nFrames; i++) {
    const t = i / O.fps;
    if (i < startFrame) {
      // 只推进不截帧：把轨迹/相机状态热到该时刻
      if (i === 0 || i % Math.max(1, Math.floor(startFrame / 10)) === 0) {
        const p = (i / startFrame * 100).toFixed(0);
        process.stdout.write("\r  预热中 " + p + "%   ");
      }
      await cdp.eval("window.__setTime(" + t + ")");
      continue;
    }
    // 关键：设置时间、走一帧、读像素，三段必须在同一个 JS 任务里
    const dataUrl = await cdp.eval(`(() => {
      window.__setTime(${t});
      return document.getElementById("gameCanvas").toDataURL("image/jpeg", ${O.q});
    })()`);
    if (typeof dataUrl !== "string" || dataUrl.indexOf("data:image/jpeg") !== 0) {
      throw new Error("第 " + i + " 帧取图失败：" + String(dataUrl).slice(0, 120));
    }
    const buf = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
    fs.writeFileSync(path.join(O.frames, "frame_" + String(i).padStart(6, "0") + ".jpg"), buf);
    framesWritten++;

    if (i % 30 === 0 || i === nFrames - 1) {
      const el = (Date.now() - t0) / 1000;
      const done = i - startFrame + 1;
      const perMs = (el * 1000) / Math.max(1, done);       // 毫秒/帧
      const eta = (nFrames - i - 1) * perMs / 60000;       // 剩余分钟
      process.stdout.write("\r  渲染 " + (i + 1) + "/" + nFrames + " 帧  "
        + (100 * (i + 1) / nFrames).toFixed(1) + "%  " + perMs.toFixed(0) + "ms/帧  剩余约 "
        + eta.toFixed(1) + " 分钟   ");
      writeProgress("渲染 " + (i + 1) + "/" + nFrames + " 帧（" + perMs.toFixed(0) + "ms/帧，剩余约 "
        + eta.toFixed(1) + " 分钟）");
    }
  }
  process.stdout.write("\n");
  log("  渲染完成，共 " + framesWritten + " 帧，用时 " + ((Date.now() - t0) / 60000).toFixed(1) + " 分钟");

  const jsErr = await cdp.eval("(document.getElementById('errBox')||{}).textContent || ''");
  if (jsErr) log("  ⚠ 页面运行时报错过：" + String(jsErr).slice(0, 300));

  cleanup();

  /* 6. 合成 mp4 */
  log("");
  log("  ffmpeg 合成中（" + O.encoder + "）…");
  writeProgress("ffmpeg 合成中…");
  const enc = O.encoder === "libx264"
    ? ["-preset", "slow", "-crf", "18"]
    : ["-preset", "p5", "-rc", "vbr", "-cq", "21", "-b:v", "0", "-spatial-aq", "1"];
  const ffArgs = [
    "-y", "-hide_banner", "-loglevel", "warning", "-stats",
    "-framerate", String(O.fps), "-start_number", String(startFrame),
    "-i", path.join(O.frames, "frame_%06d.jpg"),
    "-i", musicPath,
    "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", O.encoder, ...enc,
    "-pix_fmt", "yuv420p",
    "-vf", "scale=in_range=full:out_range=tv:out_color_matrix=bt709",
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
    "-shortest",
    outFile,
  ];
  const r = spawnSync("ffmpeg", ffArgs, { stdio: ["ignore", "ignore", "inherit"] });
  if (r.status !== 0) throw new Error("ffmpeg 失败（退出码 " + r.status + "）。可试 --encoder libx264");

  const size = (fs.statSync(outFile).size / 1048576).toFixed(0);
  log("");
  log("  ✅ 完成：" + outFile + "（" + size + " MB）");
  writeProgress("完成：" + outFile + "（" + size + " MB）");

  // 清理逐帧图：失败不算渲染失败（有些环境装了安全删除护栏，会拦下批量删除）
  if (O.cleanFrames) {
    try {
      fs.rmSync(O.frames, { recursive: true, force: true });
      log("  已删除逐帧图（--clean-frames）");
    } catch (e) {
      log("  ⚠ 逐帧图没能自动删除（" + ((e && e.message) || e) + "）");
      log("    可以手动删掉这个目录：" + O.frames);
    }
  } else {
    log("  逐帧图保留在 " + O.frames + "（传 --clean-frames 可自动删）");
  }
}

main().catch(e => {
  cleanup();
  writeProgress("失败：" + ((e && e.message) || e));
  console.error("\n  ❌ " + ((e && e.stack) || e) + "\n");
  process.exit(1);
});
