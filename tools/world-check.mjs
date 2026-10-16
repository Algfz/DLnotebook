// 无头 Chrome 检查「自由观察」查看器：能否启动 WebGL、载入点云、响应键鼠输入。
// 用法: node tools/world-check.mjs [url] [outPng]
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const URL_ = process.argv[2] || "http://127.0.0.1:8898/";
const OUT = process.argv[3] || "C:\\DLnotebook-media\\tmp\\world\\check.png";
const PORT = 9411;

function findChrome() {
  const cands = [
    join(process.env["ProgramFiles"] || "", "Google/Chrome/Application/chrome.exe"),
    join(process.env["ProgramFiles(x86)"] || "", "Google/Chrome/Application/chrome.exe"),
    join(process.env["LOCALAPPDATA"] || "", "Google/Chrome/Application/chrome.exe"),
    join(process.env["ProgramFiles"] || "", "Microsoft/Edge/Application/msedge.exe"),
    join(process.env["ProgramFiles(x86)"] || "", "Microsoft/Edge/Application/msedge.exe"),
  ];
  for (const c of cands) if (c && existsSync(c)) return c;
  throw new Error("找不到 Chrome/Edge");
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waits = new Map(); }
  static async open(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", rej, { once: true });
    });
    const c = new CDP(ws);
    ws.addEventListener("message", ev => {
      const m = JSON.parse(ev.data);
      if (m.id && c.waits.has(m.id)) { c.waits.get(m.id)(m); c.waits.delete(m.id); }
    });
    return c;
  }
  send(method, params = {}, timeout = 120000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("CDP 超时: " + method)), timeout);
      this.waits.set(id, m => { clearTimeout(t); m.error ? rej(new Error(m.error.message)) : res(m.result); });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async js(expr, timeout = 120000) {
    const r = await this.send("Runtime.evaluate",
      { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true }, timeout);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "JS 异常");
    return r.result.value;
  }
}

const exe = findChrome();
const udd = mkdtempSync(join(tmpdir(), "wchk-"));
const child = spawn(exe, [
  "--headless=new", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
  "--remote-debugging-port=" + PORT, "--user-data-dir=" + udd,
  "--window-size=1280,720", "--window-position=-30000,-30000", "--no-first-run",
  "--no-default-browser-check", "--disable-features=Translate", "about:blank",
], { stdio: "ignore" });

const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
  let list = null;
  for (let i = 0; i < 60 && !list; i++) {
    await sleep(300);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const j = await r.json();
      if (j.some(t => t.type === "page")) list = j;
    } catch { /* 还没起来 */ }
  }
  if (!list) throw new Error("Chrome 没起来");
  const page = list.find(t => t.type === "page");

  const cdp = await CDP.open(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable").catch(() => {});
  await cdp.send("Page.navigate", { url: URL_ });
  await sleep(1500);

  // 等查看器就绪（最多 90 秒：要下载 5.4 MB 点云）
  let ok = false, count = 0;
  for (let i = 0; i < 90; i++) {
    const st = await cdp.js(`return window.__world ? window.__world.count() : -1;`, 20000).catch(() => -1);
    if (st > 0) { ok = true; count = st; break; }
    await sleep(1000);
  }
  const err = await cdp.js(`const e=document.querySelector('#err'); return e?e.textContent:'';`).catch(() => "?");
  if (!ok) throw new Error("点云没加载出来 err=" + err);

  const info = await cdp.js(`
    const W = window.__world, S = W.S;
    return { count: W.count(), tag: S.man.tag, title: S.man.title,
             fps: +S.fps.toFixed(1), pos: W.pos(), touch: S.touch,
             diag: +S.diag.toFixed(2), speed: +S.speed.toFixed(2),
             pixelRatio: W.renderer.getPixelRatio(),
             hasTraj: !!(W.S.traj && W.S.traj.length>0),
             gl: W.renderer.getContext().getParameter(0x1F01) };`);

  // 默认机位的第一眼（回起点，别让后面的输入测试污染画面）
  const posBefore = await cdp.js(`return window.__world.pos();`);
  const start = await cdp.js(`return window.__world.S.man.start;`);
  await cdp.js(`document.querySelector('#bReset').click(); return 1;`);
  await sleep(1200);
  const posAfter = await cdp.js(`return window.__world.pos();`);
  const hud = await cdp.js(`return document.querySelector('#st').textContent;`);
  const shot0 = await cdp.send("Page.captureScreenshot", { format: "png" }, 60000);
  writeFileSync(OUT, Buffer.from(shot0.data, "base64"));

  // 桌面键鼠：按住 W 一秒，看相机是否前进
  await cdp.js(`window.__world.setMode(false); return 1;`);
  const before = await cdp.js(`return window.__world.pos();`);
  await cdp.js(`
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'w'}));
    return 1;`);
  await sleep(1200);
  await cdp.js(`window.dispatchEvent(new KeyboardEvent('keyup',{key:'w'})); return 1;`);
  const after = await cdp.js(`return window.__world.pos();`);
  const moved = Math.hypot(after[0]-before[0], after[1]-before[1], after[2]-before[2]);

  // 触屏模式：模拟摇杆推动
  const dragRes = await cdp.js(`
    const W = window.__world; W.setMode(true);
    const stick = document.querySelector('#stick'), r = stick.getBoundingClientRect();
    const cx = r.left + r.width/2, cy = r.top + r.height/2;
    const mk = (type, x, y) => { const t = new Touch({identifier: 7, target: stick, clientX: x, clientY: y});
      return new TouchEvent(type, {touches: type==='touchend'?[]:[t], targetTouches:[t], changedTouches:[t], bubbles:true, cancelable:true}); };
    stick.dispatchEvent(mk('touchstart', cx, cy));
    window.dispatchEvent(mk('touchmove', cx, cy-40));
    return { f: W.S ? 0 : 0, cls: document.body.className };`);
  await sleep(900);
  const touchPos = await cdp.js(`return window.__world.pos();`);
  const touchMoved = Math.hypot(touchPos[0]-after[0], touchPos[1]-after[1], touchPos[2]-after[2]);

  const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, 60000);
  writeFileSync(OUT, Buffer.from(shot.data, "base64"));

  // 手机尺寸 + 触屏模拟，检查移动端 UI 不被遮挡
  const MOB = OUT.replace(/\.png$/, "-mobile.png");
  await cdp.send("Emulation.setDeviceMetricsOverride",
    { width: 412, height: 915, deviceScaleFactor: 2.6, mobile: true });
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await cdp.send("Emulation.setEmitTouchEventsForMouse", { enabled: true, configuration: "mobile" });
  await sleep(2500);
  await cdp.js(`window.__world.setMode(true); document.querySelector('#bReset').click(); return 1;`);
  await sleep(1200);
  const mob = await cdp.js(`
    const W = window.__world; W.setMode(true);
    const g = id => { const e = document.querySelector(id); if(!e) return null; const r = e.getBoundingClientRect();
      return {w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top),
              vis: getComputedStyle(e).display !== 'none' && r.width > 0}; };
    return { cls: document.body.className, dpr: W.renderer.getPixelRatio(),
             size: [innerWidth, innerHeight], stick: g('#stick'), up: g('#bUp'), panel: g('#panel'),
             btns: g('#btns'), hud: g('#top') };`);
  await sleep(600);
  const shot2 = await cdp.send("Page.captureScreenshot", { format: "png" }, 60000);
  writeFileSync(MOB, Buffer.from(shot2.data, "base64"));

  console.log(JSON.stringify({ url: URL_, loaded: info, start, posBefore, posAfter, hud,
    desktopMoved: +moved.toFixed(3),
    touchClass: dragRes.cls, touchMoved: +touchMoved.toFixed(3), screenshot: OUT,
    mobile: mob, mobileScreenshot: MOB }, null, 1));
} catch (e) {
  console.error("❌ " + e.message);
  process.exitCode = 1;
} finally {
  child.kill();
}
