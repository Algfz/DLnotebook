/* =====================================================================
   refrender.mjs — 把"反推出来的场景"用真 three.js 渲出来（闭环回渲）

   为什么需要它：
     反推结果的验收标准不是"数字好看"，而是"**同机位渲出来和参考帧像不像**"。
     本工具复用 shot.js 那套「CDP + 真 Chrome + 真 WebGL」管线，
     但不用我们的关卡数据：直接把点云/盒 塞进 three.js 场景，
     按重建出来的相机位姿摆相机，然后取图。

   用法：
     node tools/refrender.mjs --cloud out/tmp/ref-scene/desert-a-vggt-cloud.ply \
          --poses out/tmp/ref-scene/desert-a-vggt-poses.json --frame 0 \
          --out out/tmp/ref-scene/desert-a-render-src.png
     node tools/refrender.mjs --cloud ... --poses ... --frame 0 \
          --shift 0,-0.4,1.2 --out out/tmp/ref-scene/desert-a-render-novel.png
     # 单帧 MoGe 点云（相机系，R=I,t=0）：
     node tools/refrender.mjs --cloud out/tmp/ref-scene/space-g0150-points.ply --identity \
          --fov-y 74.1 --out out/tmp/ref-scene/space-g0150-render.png
   ===================================================================== */
"use strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");

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
  cloud: A.cloud,
  poses: A.poses || null,
  frame: parseInt(A.frame, 10) || 0,
  identity: !!A.identity,
  out: A.out || path.join(ROOT, "out", "tmp", "ref-scene", "render.png"),
  w: parseInt(A.w, 10) || 1280,
  h: parseInt(A.h, 10) || 720,
  fovY: A["fov-y"] ? parseFloat(A["fov-y"]) : null,
  shift: String(A.shift || "").split(",").filter(s => s !== "").map(Number),
  look: A.look || null,
  pointSize: parseFloat(A["point-size"]) || 0.03,
  farPct: A["far-pct"] !== undefined ? parseFloat(A["far-pct"]) : 0.985,
  farMin: parseFloat(A["far-min"]) || 5,
  maxPoints: parseInt(A["max-points"], 10) || 400000,
  bg: A.bg || "0x14161c",
  port: parseInt(A.port, 10) || 8243,
  cdpPort: parseInt(A["cdp-port"], 10) || 9243,
  headless: A.headless !== false,
  level: A.level || null,
  keep: !!A.keep,
};

function log(...s) { console.log(...s); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

function findChrome() {
  const cands = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    path.join(os.homedir(), "AppData/Local/Google/Chrome/Application/chrome.exe"),
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error("找不到 Chrome/Edge");
}

/* ---------- PLY（write_ply 写出的固定记录格式） ---------- */
function readPly(file) {
  const buf = fs.readFileSync(file);
  let end = buf.indexOf("end_header\n");
  if (end < 0) throw new Error("PLY 头不完整: " + file);
  const head = buf.slice(0, end).toString("latin1");
  const m = head.match(/element vertex (\d+)/);
  if (!m) throw new Error("PLY 里没有 vertex 元素: " + file);
  const n = parseInt(m[1], 10);
  const off = end + "end_header\n".length;
  const stride = 3 * 4 + 3;                     // x,y,z float32 + r,g,b uint8
  if (buf.length - off < n * stride) throw new Error("PLY 数据长度不足（" + n + " 点）");
  const xyz = new Float32Array(n * 3), rgb = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const b = off + i * stride;
    xyz[i * 3] = buf.readFloatLE(b);
    xyz[i * 3 + 1] = buf.readFloatLE(b + 4);
    xyz[i * 3 + 2] = buf.readFloatLE(b + 8);
    rgb[i * 3] = buf[b + 12]; rgb[i * 3 + 1] = buf[b + 13]; rgb[i * 3 + 2] = buf[b + 14];
  }
  return { n, xyz, rgb };
}

function mat4FromRt(R, t, scale) {
  const s = scale || 1;
  return [R[0][0] * s, R[0][1] * s, R[0][2] * s, t[0],
          R[1][0] * s, R[1][1] * s, R[1][2] * s, t[1],
          R[2][0] * s, R[2][1] * s, R[2][2] * s, t[2],
          0, 0, 0, 1];
}

/* ---------- CDP ---------- */
class CDP {
  constructor(url) { this.url = url; this.id = 0; this.wait = new Map(); this.ws = null; }
  connect() {
    return new Promise((res, rej) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.addEventListener("open", () => res(), { once: true });
      ws.addEventListener("error", e => rej(new Error("CDP 连接失败：" + (e.message || e.type))), { once: true });
      ws.addEventListener("message", ev => {
        let m; try { m = JSON.parse(String(ev.data)); } catch (e) { return; }
        if (m.id && this.wait.has(m.id)) {
          const { res: r, rej: j } = this.wait.get(m.id);
          this.wait.delete(m.id);
          m.error ? j(new Error(JSON.stringify(m.error))) : r(m.result);
        }
      });
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.wait.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (this.wait.has(id)) { this.wait.delete(id); rej(new Error("CDP 超时: " + method)); } }, 120000);
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression, returnByValue: true, awaitPromise: true, allowUnsafeEvalBlockedByCSP: true, timeout: 120000,
    });
    if (r.exceptionDetails) throw new Error("页面异常: " + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result && r.result.value;
  }
}

let devServer = null, chrome = null, userDataDir = null;
function cleanup() {
  try { if (chrome) chrome.kill(); } catch (e) {}
  try { if (devServer) devServer.kill(); } catch (e) {}
  try { if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) {}
}
process.on("exit", cleanup);

const INIT = `(() => {
  window.__moduleLoaded = window.__moduleLoaded || false;
})();`;

async function main() {
  if (!O.cloud || !fs.existsSync(O.cloud)) throw new Error("--cloud 不存在: " + O.cloud);
  const ply = readPly(O.cloud);
  log("  点云    " + O.cloud + "  " + ply.n + " 点");

  let R = [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t = [0, 0, 0], fovY = O.fovY, srcName = null;
  let frames = null;
  if (O.poses) {
    const pj = JSON.parse(fs.readFileSync(O.poses, "utf8"));
    frames = pj.frames;
    const f = frames[Math.min(O.frame, frames.length - 1)];
    R = f.R; t = f.t;
    srcName = f.frame;
    if (!fovY && f.fov_x_deg) {
      // 用 fov_x 换算 fov_y（按参考帧宽高比），保证渲染取景与参考帧一致
      const fx = f.fov_x_deg * Math.PI / 180;
      fovY = 2 * Math.atan(Math.tan(fx / 2) * (O.h / O.w)) * 180 / Math.PI;
    }
    log("  相机    frame#" + O.frame + " " + (srcName || "") + "  fov_y=" + (fovY ? fovY.toFixed(1) : "?") + "°");
  } else {
    log("  相机    --identity（点云已在相机系，R=I,t=0）");
  }
  if (!fovY) throw new Error("缺 --fov-y（没有 poses 时必须给）");
  let camMat = mat4FromRt(R, t, 1);
  if (O.shift.length === 3 && O.shift.every(v => Number.isFinite(v))) {
    // 只平移眼睛、保持朝向：R 不变，t' = t - R*shift
    const s = O.shift;
    const t2 = [
      t[0] - (R[0][0] * s[0] + R[0][1] * s[1] + R[0][2] * s[2]),
      t[1] - (R[1][0] * s[0] + R[1][1] * s[1] + R[1][2] * s[2]),
      t[2] - (R[2][0] * s[0] + R[2][1] * s[1] + R[2][2] * s[2]),
    ];
    camMat = mat4FromRt(R, t2, 1);
    log("  机位    novel（shift " + s.join(",") + "）");
  }

  /* ---- 起服务/Chrome ---- */
  let up = false;
  try { const r = await fetch("http://127.0.0.1:" + O.port + "/api/levels"); up = r.ok; } catch (e) {}
  if (!up) {
    devServer = spawn(process.execPath, [path.join(ROOT, "tools", "dev-server.js"), String(O.port)], { cwd: ROOT, stdio: "ignore" });
    for (let i = 0; i < 60 && !up; i++) {
      await sleep(250);
      try { const r = await fetch("http://127.0.0.1:" + O.port + "/api/levels"); up = r.ok; } catch (e) {}
    }
    if (!up) throw new Error("本地服务器启动失败（端口 " + O.port + "）");
  }

  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dlref-"));
  const args = [
    "--remote-debugging-port=" + O.cdpPort, "--remote-allow-origins=*",
    "--user-data-dir=" + userDataDir, "--no-first-run", "--no-default-browser-check",
    "--disable-extensions", "--mute-audio", "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    "--disable-features=CalculateNativeWinOcclusion",
    "--window-size=" + O.w + "," + O.h, "--window-position=-30000,-30000", "about:blank",
  ];
  if (O.headless) args.unshift("--headless=new", "--use-angle=swiftshader", "--enable-unsafe-swiftshader");
  chrome = spawn(findChrome(), args, { stdio: "ignore" });

  let wsUrl = null;
  for (let i = 0; i < 80 && !wsUrl; i++) {
    await sleep(250);
    try {
      const list = await (await fetch("http://127.0.0.1:" + O.cdpPort + "/json/list")).json();
      const page = list.find(x => x.type === "page");
      if (page) wsUrl = page.webSocketDebuggerUrl;
    } catch (e) {}
  }
  if (!wsUrl) throw new Error("连不上 Chrome 调试端口 " + O.cdpPort);

  const cdp = new CDP(wsUrl);
  await cdp.connect();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: O.w, height: O.h, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.navigate", { url: "http://127.0.0.1:" + O.port + "/" });

  let ok = false;
  for (let i = 0; i < 80 && !ok; i++) {
    await sleep(300);
    try { ok = await cdp.eval("window.__moduleLoaded === true"); } catch (e) {}
  }
  if (!ok) throw new Error("客户端没启动起来（window.__moduleLoaded 一直为假）");

  // 进游戏视图（要的只是"有 WebGL 的 canvas + THREE"）
  const lv = O.level;
  const started = await cdp.eval(`(async () => {
    const items = [...document.querySelectorAll("#selList .lvItem")];
    if (!items.length) return "关卡列表为空";
    const hit = ${lv ? `items.find(el => ((el.querySelector(".t")||{}).textContent||"").includes(${JSON.stringify(lv)}))` : "items[0]"};
    if (!hit) return "找不到关卡 " + ${JSON.stringify(lv || "")};
    hit.click();
    document.querySelector("#btnPlay").click();
    return "ok";
  })()`);
  if (started !== "ok") throw new Error(String(started));
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    await sleep(300);
    try { ready = await cdp.eval(`!!(document.getElementById("gameCanvas") && window.__THREE)`); } catch (e) {}
  }
  if (!ready) throw new Error("游戏视图/THREE 没就绪");
  await cdp.eval(`(() => { const h = document.getElementById("hud"); if (h) h.style.display = "none"; return true; })()`);

  /* ---- 注入场景 + 渲 + 取图（同一段 eval 内取图，避免被游戏循环覆盖） ---- */
  const xyzB64 = Buffer.from(ply.xyz.buffer, ply.xyz.byteOffset, ply.xyz.byteLength).toString("base64");
  const rgbB64 = Buffer.from(ply.rgb.buffer, ply.rgb.byteOffset, ply.rgb.byteLength).toString("base64");
  const expr = `(() => {
    const T = window.__THREE;
    const g = window.__game;
    const canvas = document.getElementById("gameCanvas");
    if (!T || !canvas) return "缺 THREE 或 canvas";
    if (g && g.renderer) { try { g.renderer.setAnimationLoop(null); } catch (e) {} }
    const renderer = (g && g.renderer) || window.__renderer;
    const scene = new T.Scene();
    scene.background = new T.Color(${JSON.stringify(String(O.bg))});

    const b64 = (s) => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i=0;i<bin.length;i++) u[i]=bin.charCodeAt(i); return u; };
    let pos = new Float32Array(b64(${JSON.stringify(xyzB64)}).buffer);
    let col = b64(${JSON.stringify(rgbB64)});
    const N = pos.length / 3;
    if (N > ${O.maxPoints}) {                     // 均匀抽稀
      const step = Math.ceil(N / ${O.maxPoints});
      const p2 = new Float32Array(((N + step - 1) / step | 0) * 3), c2 = new Uint8Array(p2.length);
      let k = 0;
      for (let i = 0; i < N; i += step) { p2[k*3]=pos[i*3]; p2[k*3+1]=pos[i*3+1]; p2[k*3+2]=pos[i*3+2];
        c2[k*3]=col[i*3]; c2[k*3+1]=col[i*3+1]; c2[k*3+2]=col[i*3+2]; k++; }
      pos = p2.slice(0, k*3); col = c2.slice(0, k*3);
    }
    const geo0 = new T.BufferGeometry();
    geo0.setAttribute("position", new T.BufferAttribute(pos, 3));
    const M = new T.Matrix4();
    M.set(${camMat.map(v => v.toFixed(9)).join(",")});
    geo0.applyMatrix4(M);                                   // world/相机系 -> 相机坐标（OpenCV）
    // 远处点（MoGe 把雾/天空放在远平面）会糊成一个大罩子 -> 按距离分位裁剪
    let keep = null;
    {
      const P = geo0.attributes.position.array, n = P.length / 3;
      const d = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const dd = Math.hypot(P[i*3], P[i*3+1], P[i*3+2]);
        d[i] = Number.isFinite(dd) ? dd : 1e9;         // MoGe 的天空/无效点常是 NaN/Inf
      }
      const fin = [];
      for (let i = 0; i < n; i++) if (d[i] < 1e8) fin.push(d[i]);
      fin.sort((a, b) => a - b);
      const thr = Math.max(${(O.farMin || 5)}, fin.length ? fin[Math.min(fin.length - 1, Math.floor(fin.length * ${O.farPct}))] : 1e9);
      keep = new Uint8Array(n);
      let m = 0;
      for (let i = 0; i < n; i++) if (d[i] <= thr) { keep[i] = 1; m++; }
      if (m < n * 0.2) keep = null;                         // 裁太狠就放弃
    }
    const geo = new T.BufferGeometry();
    if (keep) {
      const P = geo0.attributes.position.array;
      const p2 = new Float32Array(keep.reduce ? (() => { let m = 0; for (let i = 0; i < keep.length; i++) m += keep[i]; return m * 3; })() : 0);
      const c2 = new Float32Array(p2.length);
      let k = 0;
      for (let i = 0; i < keep.length; i++) if (keep[i]) {
        p2[k*3] = P[i*3]; p2[k*3+1] = P[i*3+1]; p2[k*3+2] = P[i*3+2];
        const r = col[i*3]/255, gg = col[i*3+1]/255, b = col[i*3+2]/255;   // sRGB -> linear
        c2[k*3] = Math.pow(r, 2.2); c2[k*3+1] = Math.pow(gg, 2.2); c2[k*3+2] = Math.pow(b, 2.2);
        k++;
      }
      geo.setAttribute("position", new T.BufferAttribute(p2, 3));
      geo.setAttribute("color", new T.BufferAttribute(c2, 3));
    } else {
      const c = new Float32Array(pos.length);
      for (let i = 0; i < pos.length; i++) c[i] = Math.pow(col[i]/255, 2.2);
      geo.setAttribute("position", new T.BufferAttribute(pos, 3));
      geo.setAttribute("color", new T.BufferAttribute(c, 3));
    }
    geo.applyMatrix4(new T.Matrix4().makeScale(1, -1, -1)); // OpenCV -> three.js 相机系
    geo.computeBoundingSphere();
    const mat = new T.PointsMaterial({ size: ${O.pointSize}, vertexColors: true, sizeAttenuation: true });
    const pts = new T.Points(geo, mat);
    pts.frustumCulled = false;
    scene.add(pts);

    const cam = new T.PerspectiveCamera(${fovY}, ${O.w} / ${O.h}, 0.01, 2000);
    cam.position.set(0, 0, 0);
    cam.up.set(0, 1, 0);
    cam.quaternion.identity();
    cam.updateProjectionMatrix();

    renderer.setSize(${O.w}, ${O.h}, false);
    renderer.setPixelRatio(1);
    renderer.render(scene, cam);
    const url = canvas.toDataURL("image/png");
    return { ok: true, n: pos.length / 3, bs: geo.boundingSphere ? geo.boundingSphere.radius : 0, url: url };
  })()`;
  const r = await cdp.eval(expr);
  if (!r || !r.ok) throw new Error("渲染失败：" + JSON.stringify(r).slice(0, 300));
  const out = path.resolve(O.out);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(String(r.url).split(",")[1], "base64"));
  log("  渲染    " + r.n + " 点  包围球 " + r.bs.toFixed(2) + " → " + out);
  if (srcName) log("  对照帧  " + srcName);
  if (!O.keep) cleanup();
  log("");
}

main().catch(e => { cleanup(); console.error("\n  ❌ " + ((e && e.stack) || e) + "\n"); process.exit(1); });
