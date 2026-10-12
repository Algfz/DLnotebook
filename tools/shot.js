/* =====================================================================
   shot.js — 截图工具（离线单帧渲染）

   为什么需要它：
     render-demo.js 渲染整段视频很慢（50ms/帧、整关 15 分钟）。调视觉时
     要反复"改一行 → 看一眼"，需要的是**几秒钟拿到几张图**。
     本工具复用 render-demo.js 那套「虚拟时钟 + CDP 取像素」的原理，
     但只抓指定的几个时刻，并且允许注入一段任意 JS 来改客户端参数
     （改相机、关雾、换颜色…），从而快速对比不同视觉方案。

   用法：
     node tools/shot.js --level Breeze --times 20,60,100,150     # 抓 4 个时刻
     node tools/shot.js --level "ring a bell" --times 0,40,90 --w 1600 --h 900
     node tools/shot.js --level Breeze --times 60 --js "game.scene.fog = null"
     node tools/shot.js --level Breeze --times 60 --setup-file _shot_setup.js
     node tools/shot.js --level Breeze --times 20,60,120 --check --js "game.setAutoLines([true,true])"
       # --check：报出每个时刻的游戏状态与线头坐标（确认自动播放跑完全程没死）

   --js / --setup-file 里可以用这些变量（注入在 Game 实例之后执行）：
     window.__dbg = { THREE, game, scene, renderer, camera, level }
   输出：out/shot/<关卡名>/t<时刻>s.jpg
   ===================================================================== */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i];
    if (!s.startsWith("--")) { a._.push(s); continue; }
    const eq = s.indexOf("=");
    if (eq >= 0) a[s.slice(2, eq)] = s.slice(eq + 1);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) a[s.slice(2)] = argv[++i];
    else a[s.slice(2)] = true;
  }
  return a;
}
const A = parseArgs(process.argv.slice(2));
const O = {
  level: A.level || A._[0],
  times: String(A.times || "0,30,75,120").split(",").map(s => parseFloat(s)),
  w: parseInt(A.w, 10) || 1600,
  h: parseInt(A.h, 10) || 900,
  q: parseFloat(A.q) || 92,
  js: A.js || null,
  setupFile: A["setup-file"] || null,
  out: A.out || null,
  hud: !!A.hud,
  check: !!A.check,
  headless: !!A.headless,
  port: parseInt(A.port, 10) || 8241,
  cdpPort: parseInt(A["cdp-port"], 10) || 9241,
};
if (!O.level) { console.error("缺少 --level（关卡目录名或标题关键字）"); process.exit(2); }

const log = (...m) => console.log(...m);
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

function findChrome() {
  const cands = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error("找不到 Chrome / Edge");
}

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
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error("页面报错：" + ((d.exception && (d.exception.description || d.exception.value)) || d.text));
    }
    return r.result ? r.result.value : undefined;
  }
}

// 与 render-demo.js 同一套虚拟时钟；额外把 Game 实例暴露到 window.__dbg 供注入脚本改写
function initScript() {
  return `(() => {
  try {
    localStorage.setItem("dlfan.settings", JSON.stringify({
      latency: 0, volume: 0, guide: true, autoLines: [true, true], keys: [], quality: "high",
    }));
  } catch (e) {}
  window.__vt = 0; window.__frames = 0;
  try {
    Object.defineProperty(performance, "now", {
      value: () => window.__vt * 1000, configurable: true, writable: true });
  } catch (e) {}
  for (const n of ["BaseAudioContext", "AudioContext", "webkitAudioContext"]) {
    const C = window[n]; if (!C || !C.prototype) continue;
    try { Object.defineProperty(C.prototype, "currentTime", { get: () => window.__vt, configurable: true }); } catch (e) {}
  }
  const cbs = []; let nid = 0;
  window.requestAnimationFrame = cb => { const id = ++nid; cbs.push({ id, cb }); return id; };
  window.cancelAnimationFrame = id => { const i = cbs.findIndex(o => o.id === id); if (i >= 0) cbs.splice(i, 1); };
  window.__setTime = t => {
    window.__vt = t; window.__frames++;
    const list = cbs.splice(0);
    for (const o of list) o.cb(t * 1000);
  };
})();`;
}

let devServer = null, chrome = null, cdp = null, userDataDir = null;
function cleanup() {
  try { if (cdp) cdp.close(); } catch (e) {}
  try { if (chrome && !chrome.killed) chrome.kill(); } catch (e) {}
  try { if (devServer && !devServer.killed) devServer.kill(); } catch (e) {}
  try { if (userDataDir && fs.existsSync(userDataDir)) fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) {}
}

async function main() {
  const lv = findLevelDir(O.level);
  const outDir = path.resolve(O.out || path.join(ROOT, "out", "shot", lv.name.replace(/[\\/:*?"<>|]/g, "_")));
  fs.mkdirSync(outDir, { recursive: true });

  let setupJs = O.js || "";
  if (O.setupFile) setupJs = fs.readFileSync(path.resolve(O.setupFile), "utf8");

  log("");
  log("  关卡    " + lv.name);
  log("  时刻    " + O.times.join(" / ") + " s");
  log("  分辨率  " + O.w + "x" + O.h + " @q" + O.q);
  log("  输出    " + outDir);
  log("");

  devServer = spawn(process.execPath, [path.join(ROOT, "tools", "dev-server.js"), String(O.port)],
    { cwd: ROOT, stdio: "ignore" });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await sleep(250);
    try { const r = await fetch("http://127.0.0.1:" + O.port + "/api/levels"); up = r.ok; } catch (e) {}
  }
  if (!up) throw new Error("本地服务器启动失败（端口 " + O.port + " 被占用？）");

  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dlshot-"));
  const args = [
    "--remote-debugging-port=" + O.cdpPort, "--remote-allow-origins=*",
    "--user-data-dir=" + userDataDir,
    "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--mute-audio",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows", "--disable-features=CalculateNativeWinOcclusion",
    "--window-size=" + O.w + "," + O.h, "--window-position=-30000,-30000",
    "about:blank",
  ];
  if (O.headless) { args.unshift("--headless=new"); args.splice(1, 0, "--use-angle=swiftshader", "--enable-unsafe-swiftshader"); }
  chrome = spawn(findChrome(), args, { stdio: "ignore" });

  let wsUrl = null;
  for (let i = 0; i < 80 && !wsUrl; i++) {
    await sleep(250);
    try {
      const list = await (await fetch("http://127.0.0.1:" + O.cdpPort + "/json/list")).json();
      const page = list.find(t => t.type === "page");
      if (page) wsUrl = page.webSocketDebuggerUrl;
    } catch (e) {}
  }
  if (!wsUrl) throw new Error("连不上 Chrome 调试端口（" + O.cdpPort + "）");

  cdp = new CDP(wsUrl);
  await cdp.connect();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: initScript() });
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: O.w, height: O.h, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.navigate", { url: "http://127.0.0.1:" + O.port + "/" });

  let ok = false;
  for (let i = 0; i < 60 && !ok; i++) {
    await sleep(300);
    try { ok = await cdp.eval("window.__moduleLoaded === true"); } catch (e) {}
  }
  if (!ok) {
    let why = "";
    try { why = await cdp.eval("String(window.__startError || '')"); } catch (e) {}
    throw new Error("客户端没有启动起来" + (why ? "：" + why : ""));
  }

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

  let ready = false, lastState = null;
  for (let i = 0; i < 60 && !ready; i++) {
    await sleep(300);
    try {
      lastState = await cdp.eval(`(() => {
        const v = document.getElementById("viewGame");
        const c = document.getElementById("gameCanvas");
        return { viewHidden: !v || v.classList.contains("hide"), hasCanvas: !!c,
          canvasW: c ? c.width : 0, canvasH: c ? c.height : 0,
          hudInfo: (window.__setTime && window.__setTime(0),
                    (document.getElementById("hudInfo") || {}).textContent) || "",
          err: (document.getElementById("errBox") || {}).textContent || "" };
      })()`);
      ready = !lastState.viewHidden && lastState.hasCanvas
        && lastState.canvasW >= O.w && lastState.canvasH >= O.h
        && lastState.hudInfo.indexOf(title.slice(0, 8)) >= 0;
    } catch (e) {}
  }
  if (!ready) throw new Error("游戏视图没建好：" + JSON.stringify(lastState));

  // 开始游戏 + 隐藏 HUD
  await cdp.eval(`(() => {
    document.getElementById("gameCanvas").dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));
    ${O.hud ? "" : 'document.getElementById("hud").style.display = "none";'}
    window.dispatchEvent(new Event("resize"));
    return true;
  })()`);

  if (lastState.err) log("  ⚠ 页面报错：" + String(lastState.err).slice(0, 300));

  // 把 Game 实例暴露出来，注入自定义改动（只执行一次；改的是持久状态）
  if (setupJs) {
    const r = await cdp.eval(`(() => {
      try {
        const g = window.__game || (window.__dbg && window.__dbg.game);
        if (!g) return "找不到 Game 实例（main.js 的调试钩子没生效？）";
        window.__dbg = { THREE: window.__THREE, game: g, level: g.level,
          scene: g.scene, renderer: g.renderer, camera: g.camera };
        // 让注入脚本能直接用这些短名字（下面用 with 把它们放进作用域）
        const THREE = window.__THREE || {};
        const game = g, scene = g.scene, renderer = g.renderer, camera = g.camera,
              level = g.level, dbg = window.__dbg;
        with ({ THREE, game, scene, renderer, camera, level, dbg, console }) {
          ${setupJs}
        }
        return "ok";
      } catch (e) { return "出错：" + (e && e.stack || e); }
    })()`);
    if (r !== "ok") throw new Error("注入脚本失败 → " + r);
    log("  已注入自定义改动");
  }

  // 逐时刻：从 0 连续推进到该时刻（轨迹/相机需要历史），然后取图
  let cur = 0;
  const fps = 30, dt = 1 / fps;
  for (const t of O.times) {
    while (cur < t - dt / 2) { cur = Math.min(t, cur + dt); await cdp.eval("window.__setTime(" + cur + ")"); }
    cur = t;
    // --check：报出这一时刻的游戏状态与线头位置（用来确认"自动播放跑完全程没死"）
    if (O.check) {
      const st = await cdp.eval(`(() => {
        const g = window.__game;
        if (!g) return null;
        const L = (g.lines || [])[0];
        return { state: g.state, t: window.__vt,
                 x: L ? +L.pos.x.toFixed(2) : null,
                 y: L ? +L.pos.y.toFixed(2) : null,
                 z: L ? +L.pos.z.toFixed(2) : null };
      })()`);
      if (st) log("  · 状态 " + st.state + "   线头 (" + st.x + ", " + st.y + ", " + st.z + ")");
      else log("  · 找不到 window.__game，--check 跳过");
    }
    const dataUrl = await cdp.eval(`(() => {
      window.__setTime(${t});
      return document.getElementById("gameCanvas").toDataURL("image/jpeg", ${O.q});
    })()`);
    if (typeof dataUrl !== "string" || dataUrl.indexOf("data:image/jpeg") !== 0)
      throw new Error("取图失败：" + String(dataUrl).slice(0, 120));
    const file = path.join(outDir, "t" + String(t).replace(".", "_") + "s.jpg");
    fs.writeFileSync(file, Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64"));
    log("  ✓ " + t + "s → " + file);
  }

  const jsErr = await cdp.eval("(document.getElementById('errBox')||{}).textContent || ''");
  if (jsErr) log("  ⚠ 运行时报错：" + String(jsErr).slice(0, 300));

  cleanup();
  log("");
}

main().catch(e => { cleanup(); console.error("\n  ❌ " + ((e && e.stack) || e) + "\n"); process.exit(1); });
