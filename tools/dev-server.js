/* =====================================================================
   dev-server.js — 客户端开发服务器
   用法: node tools/dev-server.js [端口]
   然后浏览器打开 http://localhost:8080
   为什么需要它：浏览器在 file:// 下无法 fetch 本地 JSON，必须走 HTTP。
   最终交付是 Electron 打包的 exe，这个服务器只在开发阶段使用。
   ===================================================================== */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PORT = parseInt(process.argv[2], 10) || 8080;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

// 扫描 levels/ 下所有含 level.json 的目录
function listLevels() {
  const lvRoot = path.join(ROOT, "levels");
  const out = [];
  if (!fs.existsSync(lvRoot)) return out;
  for (const ent of fs.readdirSync(lvRoot, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const dir = path.join(lvRoot, ent.name);
    let files;
    try { files = fs.readdirSync(dir); } catch (e) { continue; }
    if (!files.includes("level.json")) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, "level.json"), "utf8"));
      out.push({
        dir: ent.name,
        title: (j.meta && j.meta.title) || ent.name,
        subtitle: (j.meta && j.meta.subtitle) || "",
        artist: (j.meta && j.meta.artist) || "",
        difficulty: (j.meta && j.meta.difficulty) || 0,
        tags: (j.meta && j.meta.tags) || [],
        cover: (j.meta && j.meta.cover && files.includes(j.meta.cover))
          ? j.meta.cover : null,
        music: j.music,
        latency_ms: j.latency_ms || 0,
        duration: (j.timing && j.timing.duration) || 0,
      });
    } catch (e) {
      console.warn("  跳过损坏的关卡:", ent.name, "→", e.message);
    }
  }
  return out;
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);

  if (urlPath === "/api/levels") {
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(listLevels()));
    return;
  }

  // 静态文件：/ 映射到 src/index.html
  let fp = (urlPath === "/")
    ? path.join(ROOT, "src", "index.html")
    : path.join(ROOT, urlPath);

  // 安全：禁止逃出项目根目录
  if (!path.resolve(fp).startsWith(ROOT)) {
    res.writeHead(403); res.end("Forbidden"); return;
  }

  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found: " + urlPath); return; }
    const ext = path.extname(fp).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      // 开发阶段禁用缓存：否则浏览器会缓存旧的 JS 模块，改了代码刷新也拿不到新版
      "Cache-Control": "no-store",
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log("");
  console.log("  开发服务器已启动 →  http://localhost:" + PORT);
  console.log("");
  console.log("  关卡:");
  const lvs = listLevels();
  if (!lvs.length) console.log("    （levels/ 下没有找到任何 level.json）");
  lvs.forEach(l => console.log("    · " + l.title + "  [" + l.dir + "]"));
  console.log("");
  console.log("  按 Ctrl+C 停止");
  console.log("");

  // --open：服务器就绪后再打开浏览器（避免「启动客户端.bat」打开太早连不上）
  // 用 explorer.exe 打开 URL 最可靠——cmd start 的引号经过 Node 转义后会错乱，
  // 导致「Windows 找不到文件 ''」
  if (process.argv.includes("--open")) {
    const { spawn } = require("child_process");
    spawn("explorer.exe", ["http://localhost:" + PORT],
      { detached: true, stdio: "ignore" }).unref();
  }
});
