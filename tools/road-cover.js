/* =====================================================================
   road-cover.js — “景物有没有把路盖住”的**引擎级**审计

   为什么需要它：
     layout-gen / breeze-decor 一直只保证**几何净空**（方块不压到路面），
     但玩家看的是**画面**：一件离路 14m、高 6m 的方块，虽然碰不到路，
     却能在屏幕上把前方 30~60m 的舞线整个挡掉 —— 发起人 2026-10-14 的
     原话就是“你看不出来线被东西盖住了吗”。
     所以判据要换成**投影遮挡**：用引擎自己的相机与投影，
     看每件布景的屏幕方框有没有盖住路面中线点。

   做法（与 shot.js / render-demo.js 共用同一套虚拟时钟）：
     ① 逐时刻推进 `window.__setTime(t)`；
     ② 这一时刻把**线头前方 0~AHEAD 米**的路面中线点投影到屏幕；
     ③ 把 `scene` 里那个唯一的 InstancedMesh（`placed-box`）的每个实例
        取 8 个包围盒角点也投影到屏幕，得到屏幕 AABB + 视空间深度；
     ④ 路面点落在某个方框内、且方框更靠近相机 ⇒ 该点被遮住。
   输出：每 `--step` 秒一个采样（被遮路段总长 / 遮挡件位置尺寸），
        按“最长遮挡”排序打印 Top N，并写 `out/tmp/road-cover.json`。

   用法：
     node tools/road-cover.js --level "ring a bell-灰澈"
     node tools/road-cover.js --level "ring a bell-灰澈" --step 1 --ahead 120 --top 20
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
  step: parseFloat(A.step) || 0.5,
  ahead: parseFloat(A.ahead) || 90,
  top: parseInt(A.top, 10) || 12,
  w: parseInt(A.w, 10) || 1280,
  h: parseInt(A.h, 10) || 720,
  headless: !!A.headless,
  port: parseInt(A.port, 10) || 8251,
  cdpPort: parseInt(A["cdp-port"], 10) || 9251,
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

// 与 shot.js 同一套虚拟时钟
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

// 页面内的一次采样：返回 { coverM, segs, occluders }
// 判据用**射线×长方体**（精确），不用屏幕包围盒 —— 包围盒太松，
// 会把"贴在线旁边"的方块误判成遮挡（第一版就是这么误报的）。
function auditExpr(aheadM) {
  return `(() => {
    const g = window.__game || (window.__dbg && window.__dbg.game);
    if (!g) return { err: "找不到 Game 实例" };
    const THREE = window.__THREE;
    const cam = g.camera, lvl = g.level;
    const speed = (lvl.motion && lvl.motion.speedMps) || 14;
    const t = window.__vt;
    const tmp = new THREE.Vector3();

    // ① 布景：每件的矩阵 + 逆矩阵（局部空间就是边长 1 的盒子 [-0.5,0.5]^3）
    if (!window.__coverBoxes) {
      const grp = g.scene.getObjectByName("placed");
      const im = grp && grp.children.find(o => o.isInstancedMesh);
      const list = [];
      if (im) for (let k = 0; k < im.count; k++) {
        const m = new THREE.Matrix4(); im.getMatrixAt(k, m);
        const pos = new THREE.Vector3(), sc = new THREE.Vector3(), q = new THREE.Quaternion();
        m.decompose(pos, q, sc);
        list.push({ k, inv: m.clone().invert(),
                    x: +pos.x.toFixed(2), y: +pos.y.toFixed(2), z: +pos.z.toFixed(2),
                    w: +sc.x.toFixed(2), h: +sc.y.toFixed(2), d: +sc.z.toFixed(2) });
      }
      // 顺带算出"引擎里这件方块实际对应路上哪个时刻、横向偏了多少米"
      // （用来和 place[] 里写的 t/off 对照 —— 两者不一致就是这个 bug 的根源）
      const P = lvl.path || [];
      for (const b of list) {
        let best = -1, bd = 1e9;
        for (let i = 0; i < P.length; i++) {
          const dx = P[i].pos[0] - b.x, dz = P[i].pos[2] - b.z;
          const dd = dx * dx + dz * dz;
          if (dd < bd) { bd = dd; best = i; }
        }
        if (best >= 0) {
          const a = P[Math.max(0, best - 1)].pos, c = P[Math.min(P.length - 1, best + 1)].pos;
          const ux = c[0] - a[0], uz = c[2] - a[2];
          const ul = Math.hypot(ux, uz) || 1;
          const dx = b.x - P[best].pos[0], dz = b.z - P[best].pos[2];
          b.pt = +P[best].t.toFixed(2);
          b.off = +((dx * (-uz / ul)) + (dz * (ux / ul))).toFixed(2);   // 法向分量（左负右正看方向）
        }
      }
      window.__coverBoxes = list;
    }
    const boxes = window.__coverBoxes;

    // ② 线头前方 AHEAD 米的路面中线点（含每点的世界坐标）
    const path = lvl.path || [];
    const tEnd = t + ${aheadM} / speed;
    const pts = [];
    for (let i = 0; i < path.length; i++) {
      const tt = path[i].t;
      if (tt < t) continue;
      if (tt > tEnd) break;
      const P = path[i].pos;
      pts.push({ t: tt, x: P[0], y: P[1], z: P[2] });
    }
    if (!pts.length) return { t: +t.toFixed(2), coverM: 0, segs: [], occ: [], boxes: boxes.length, pts: 0 };

    const camPos = cam.getWorldPosition(new THREE.Vector3());
    const hitOf = new Map();
    const covered = [];
    const lo = new THREE.Vector3(), lp = new THREE.Vector3();
    // 另外做一次**几何压线**判定：路面中线点是否落进某个方块的体积里
    // （这比射线遮挡更硬：说明"方块真的压在路面上"，是引擎侧的净空复核）
    const inside = [];
    for (const p of pts) {
      for (const b of boxes) {
        lp.set(p.x, p.y, p.z).applyMatrix4(b.inv);
        // 只有"顶面高过路面"的方块才算盖住线：桥墩那种整个在路面**下方**的结构不算
        if (Math.abs(lp.x) <= 0.5 && Math.abs(lp.y) <= 0.5 && Math.abs(lp.z) <= 0.5
            && (b.y + b.h / 2) > p.y + 0.05) {
          inside.push({ t: +p.t.toFixed(2), x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2),
                        bx: b.x, by: b.y, bz: b.z, w: b.w, h: b.h, d: b.d, k: b.k,
                        pt: b.pt, off: b.off });
        }
      }
    }
    for (const p of pts) {
      let worst = null, worstT = 2;
      for (const b of boxes) {
        lo.copy(camPos).applyMatrix4(b.inv);
        lp.set(p.x, p.y, p.z).applyMatrix4(b.inv);
        const dx = lp.x - lo.x, dy = lp.y - lo.y, dz = lp.z - lo.z;
        let t0 = 0, t1 = 1, ok = true;
        // slab 法：与 [-0.5,0.5]^3 求交，参数 t 在 (0,1) 内才叫"挡在这条视线中间"
        const slab = (o, dd, lim) => {
          if (Math.abs(dd) < 1e-9) return o >= -lim && o <= lim;
          let a = (-lim - o) / dd, bb = (lim - o) / dd;
          if (a > bb) { const s = a; a = bb; bb = s; }
          if (a > t0) t0 = a;
          if (bb < t1) t1 = bb;
          return t0 <= t1;
        };
        ok = slab(lo.x, dx, 0.5) && slab(lo.y, dy, 0.5) && slab(lo.z, dz, 0.5);
        if (!ok || t0 <= 0.001 || t0 >= 0.999) continue;      // 交点在相机后面或路面点之后
        hitOf.set(b.k, (hitOf.get(b.k) || 0) + 1);
        if (t0 < worstT) { worstT = t0; worst = b; }
      }
      if (worst) covered.push({ t: p.t, x: p.x, z: p.z, k: worst.k });
    }

    // ③ 被遮路段总长（沿路折线的 3D 弧长；跳变 > 12m 不算）
    let coverM = 0;
    for (let i = 1; i < covered.length; i++) {
      const a = covered[i - 1], b = covered[i];
      const d = Math.hypot(b.x - a.x, b.z - a.z);
      if (d < 12) coverM += d;
    }
    let cur = null; const segs = [];
    for (const c of covered) {
      if (cur && c.t - cur.t1 < 12 / speed) { cur.t1 = c.t; }
      else { if (cur) segs.push(cur); cur = { t0: c.t, t1: c.t }; }
    }
    if (cur) segs.push(cur);

    const occ = [...hitOf.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
      .map(([k, n]) => { const b = boxes.find(o => o.k === k); return b ? { n, x: b.x, y: b.y, z: b.z, w: b.w, h: b.h, d: b.d } : { n }; });
    return { t: +t.toFixed(2), coverM: +coverM.toFixed(1),
             cam: [+camPos.x.toFixed(1), +camPos.y.toFixed(1), +camPos.z.toFixed(1)],
             inside: inside.slice(0, 20), insideN: inside.length,
             segs: segs.map(s => [+s.t0.toFixed(2), +s.t1.toFixed(2)]),
             occ, boxes: boxes.length, pts: pts.length };
  })()`;
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
  const pathArr = lv.json.path || [];
  const tMax = pathArr.length ? pathArr[pathArr.length - 1].t : 180;

  log("");
  log("  关卡    " + lv.name);
  log("  采样    " + O.step + "s 一帧，路面取线头前方 " + O.ahead + "m");
  log("  分辨率  " + O.w + "x" + O.h);

  devServer = spawn(process.execPath, [path.join(ROOT, "tools", "dev-server.js"), String(O.port)],
    { cwd: ROOT, stdio: "ignore" });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await sleep(250);
    try { const r = await fetch("http://127.0.0.1:" + O.port + "/api/levels"); up = r.ok; } catch (e) {}
  }
  if (!up) throw new Error("本地服务器启动失败（端口 " + O.port + " 被占用？）");

  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dlcover-"));
  const args = [
    "--remote-debugging-port=" + O.cdpPort, "--remote-allow-origins=*",
    "--user-data-dir=" + userDataDir,
    "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--mute-audio",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows", "--disable-features=CalculateNativeWindowOcclusion",
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
  if (!ok) throw new Error("客户端没有启动起来");

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
        window.__setTime(0);
        return { viewHidden: !v || v.classList.contains("hide"), hasCanvas: !!c,
                 canvasW: c ? c.width : 0, canvasH: c ? c.height : 0,
                 err: (document.getElementById("errBox") || {}).textContent || "" };
      })()`);
      ready = !lastState.viewHidden && lastState.hasCanvas && lastState.canvasW >= O.w;
    } catch (e) {}
  }
  if (!ready) throw new Error("游戏视图没建好：" + JSON.stringify(lastState));
  if (lastState.err) log("  ⚠ 页面报错：" + String(lastState.err).slice(0, 200));

  await cdp.eval(`(() => {
    document.getElementById("gameCanvas").dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));
    document.getElementById("hud").style.display = "none";
    window.dispatchEvent(new Event("resize"));
    return true;
  })()`);

  const expr = auditExpr(O.ahead);
  const samples = [];
  const fps = 30, dt = 1 / fps;
  let cur = 0, next = 0;
  const N = Math.floor(tMax / O.step);
  log("");
  for (let i = 0; i <= N; i++) {
    const t = +(i * O.step).toFixed(3);
    while (cur < t - dt / 2) { cur = Math.min(t, cur + dt); await cdp.eval("window.__setTime(" + cur + ")"); }
    cur = t;
    const r = await cdp.eval("window.__setTime(" + t + "), " + expr);
    if (!r || r.err) throw new Error("审计失败：" + JSON.stringify(r));
    samples.push(r);
    if (i % 20 === 0) log("  · " + t.toFixed(0) + "s  被遮 " + r.coverM.toFixed(1) + "m");
  }

  cleanup();

  const bad = samples.filter(s => s.coverM > 0.5).sort((a, b) => b.coverM - a.coverM);
  const totalCover = samples.reduce((a, s) => a + s.coverM, 0);
  log("");
  log("  ── 结果 ──────────────────────────────────────────");
  log("  采样 " + samples.length + " 帧；有遮挡的 " + bad.length + " 帧"
    + "（" + (100 * bad.length / samples.length).toFixed(1) + "%）");
  log("  遮住路面总计 " + totalCover.toFixed(0) + " m（沿线时长口径）");
  log("");
  log("  最严重的 " + Math.min(O.top, bad.length) + " 帧：");
  for (const s of bad.slice(0, O.top)) {
    const o = (s.occ || []).map(x => "(" + x.x.toFixed(0) + "," + x.z.toFixed(0) + ") " +
      x.w.toFixed(0) + "x" + x.h.toFixed(1) + "x" + x.d.toFixed(0) + "m").join("  ");
    log("   t=" + s.t.toFixed(1) + "s  被遮 " + s.coverM.toFixed(1) + "m  " + o);
  }
  const insideAll = [];
  for (const s of samples) for (const it of (s.inside || [])) insideAll.push(it);
  const byBox = new Map();
  for (const it of insideAll) {
    const key = [it.bx.toFixed(1), it.bz.toFixed(1), it.w.toFixed(1), it.h.toFixed(2)].join(",");
    const e = byBox.get(key) || { n: 0, it };
    e.n++; byBox.set(key, e);
  }
  log("");
  log("  ── 几何压线（引擎侧复核）────────────────────────");
  log("  路面中线点落进方块体积：共 " + insideAll.length + " 个采样点、涉及 " + byBox.size + " 件方块");
  for (const [, e] of [...byBox.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 10)) {
    const it = e.it;
    log("   (" + it.bx.toFixed(1) + "," + it.bz.toFixed(1) + ")  " + it.w.toFixed(1) + "x" + it.h.toFixed(2)
      + "x" + it.d.toFixed(1) + "m  y=" + it.by.toFixed(2) + "  压住 " + e.n + " 个采样点"
      + "   ← 引擎里它在 t=" + it.pt + "s、off=" + it.off + "m");
  }
  const outFile = path.join(ROOT, "out", "tmp", "road-cover.json");  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ level: lv.name, step: O.step, ahead: O.ahead, samples }, null, 1));
  log("");
  log("  明细 → " + outFile);
  log("");
}

main().catch(e => { cleanup(); console.error("\n  ❌ " + ((e && e.stack) || e) + "\n"); process.exit(1); });
