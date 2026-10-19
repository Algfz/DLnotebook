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
// 可选第二个参数：只绑定某个网卡地址（例如 127.0.0.1）。
// 为什么要这个：要让别人（手机/Tailscale 组网里的另一台机器）看 `out/` 下的视频时，
// 把它只绑在 127.0.0.1、再由 `tailscale serve` 代理出去，
// 比直接 listen 0.0.0.0 更可控（后者会同时暴露到 WiFi 那个网卡上）。
const HOST = process.argv[3] || null;

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
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
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

  fs.stat(fp, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end("Not found: " + urlPath); return; }
    const type = MIME[path.extname(fp).toLowerCase()] || "application/octet-stream";
    // 开发阶段禁用缓存：否则浏览器会缓存旧的 JS 模块，改了代码刷新也拿不到新版

    // 支持 HTTP Range（206）：视频要能拖进度条。
    // 不支持 Range 时浏览器只能从 0 开始把整个文件下完（90MB 的视频很难用），
    // 而且拖到没缓冲的位置会从头再来。
    const m = /^bytes=(\d*)-(\d*)$/.exec((req.headers.range || "").trim());
    if (m) {
      let start = m[1] === "" ? null : parseInt(m[1], 10);
      let end = m[2] === "" ? null : parseInt(m[2], 10);
      if (start === null && end === null) {
        res.writeHead(416, { "Content-Range": "bytes */" + st.size });
        res.end();
        return;
      }
      if (start === null) { start = Math.max(0, st.size - end); end = st.size - 1; }  // bytes=-N：最后 N 字节
      if (end === null || end >= st.size) end = st.size - 1;
      if (start > end || start >= st.size) {
        res.writeHead(416, { "Content-Range": "bytes */" + st.size });
        res.end();
        return;
      }
      const head = {
        "Content-Type": type,
        "Content-Length": end - start + 1,
        "Content-Range": "bytes " + start + "-" + end + "/" + st.size,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
      };
      res.writeHead(206, head);
      if (req.method === "HEAD") { res.end(); return; }
      fs.createReadStream(fp, { start, end }).on("error", () => res.end()).pipe(res);
      return;
    }

    const head = {
      "Content-Type": type,
      "Content-Length": st.size,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    };
    res.writeHead(200, head);
    if (req.method === "HEAD") { res.end(); return; }
    fs.createReadStream(fp).on("error", () => res.end()).pipe(res);
  });
});

server.listen(PORT, HOST || undefined, () => {
  console.log("");
  console.log("  开发服务器已启动 →  http://" + (HOST || "localhost") + ":" + PORT);
  console.log("");
  console.log("  关卡:");
  const lvs = listLevels();
  if (!lvs.length) console.log("    （levels/ 下没有找到任何 level.json）");
  lvs.forEach(l => console.log("    · " + l.title + "  [" + l.dir + "]"));
  console.log("");
  console.log("  按 Ctrl+C 停止");
  console.log("");

  // --open：服务器就绪后再打开浏览器（避免「启动客户端.bat」打开太早连不上）
  // 为什么要跨平台：原来只写死 explorer.exe —— 项目已经搬到手机上开发，
  // 这条在 Android/Linux 上会直接报 "spawn explorer.exe ENOENT"。
  // 打不开也不要紧：上面已经打印了地址，手动点一下就行，所以整体 try 掉。
  if (process.argv.includes("--open")) {
    const url = "http://localhost:" + PORT;
    const { spawn } = require("child_process");
    const opener = process.platform === "win32" ? "explorer.exe"
                 : process.platform === "darwin" ? "open"
                 : "xdg-open";
    try {
      spawn(opener, [url], { detached: true, stdio: "ignore" }).unref();
    } catch (e) {
      console.log("  （没能自动打开浏览器，请手动访问上面的地址）");
    }
  }
});
