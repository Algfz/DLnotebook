/* =====================================================================
   main.js — 客户端入口
   选关界面 → 游戏界面，设置持久化到 localStorage。
   ===================================================================== */
import { fetchLevels, loadLevelJSON, loadAudioBuffer } from "./level.js";
import { Game, THREE } from "./game.js";

// 标记模块已成功执行（index.html 里有个超时检测在等这个标志）
window.__moduleLoaded = true;

const $ = s => document.querySelector(s);
const fmt = t => {
  t = Math.max(0, t);
  return Math.floor(t / 60) + ":" + String(Math.floor(t % 60)).padStart(2, "0");
};

/* ---------------------- 设置持久化 ---------------------- */
const SET_KEY = "dlfan.settings";
const DEFAULTS = {
  latency: null,      // null = 使用关卡自带的 latency_ms
  volume: 80,
  guide: false,
  auto: false,        // 旧字段：= 所有线一起自动播放（保留，用于读旧存档）
  autoLines: [],      // 每条线各自的自动播放开关（下标 = 线的序号）
  keys: [],           // 每条线各自的操作按键 KeyboardEvent.code（空 = 用关卡自带的）
  quality: "medium",
};
let settings;
try { settings = Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(SET_KEY)) || {}); }
catch (e) { settings = Object.assign({}, DEFAULTS); }
function saveSettings() {
  try { localStorage.setItem(SET_KEY, JSON.stringify(settings)); } catch (e) { /* 忽略 */ }
}

function showErr(e) {
  const b = $("#errBox");
  b.style.display = "block";
  b.textContent = "出错：" + ((e && e.stack) || e);
}

/* ---------------------- 操作按键 / 自动播放（逐线） ---------------------- */
// 按键与自动播放都按「线的序号」记忆：单线关卡只有第 0 条。
// 关卡自带 lines[].key / lines[].color 是默认值，玩家改过就以玩家为准。
const LINE_COLOR_NAME = { "#ffffff": "白线", "#000000": "黑线" };

const KEY_NAME = {
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
  Space: "空格", Enter: "回车", Tab: "Tab", Backspace: "退格", CapsLock: "大写锁定",
  ShiftLeft: "左Shift", ShiftRight: "右Shift",
  ControlLeft: "左Ctrl", ControlRight: "右Ctrl",
  AltLeft: "左Alt", AltRight: "右Alt",
};
function keyName(code) {
  if (!code) return "—";
  if (KEY_NAME[code]) return KEY_NAME[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad/.test(code)) return "小键盘" + code.slice(6);
  return code;
}

// 第 i 条线的显示名：按关卡给的颜色取名（白线/黑线），否则退回「线 A / 线 B」
function lineName(i) {
  const L = game && game.lines[i];
  if (!L) return "线 " + i;
  const hex = String(L.def.color || "#ffffff").toLowerCase();
  return LINE_COLOR_NAME[hex] || ("线 " + L.id);
}
function keyRowLabel(i) {
  return (game && game.lines.length > 1) ? (lineName(i) + "操作按键：") : "操作按键：";
}
// 该线实际生效的按键：玩家改过就用玩家的，否则用关卡自带的
function effectiveKey(i) {
  const ov = settings.keys[i];
  if (ov) return ov;
  return (game && game.lines[i]) ? game.lines[i].key : null;
}
// 该线实际生效的自动播放开关（settings.auto 是旧存档里的「全部一起」开关）
const autoOf = i =>
  (settings.autoLines[i] != null ? !!settings.autoLines[i] : !!settings.auto);

/* ---------------------- 全局状态 ---------------------- */
let levels = [];
let curLevel = null;
let levelData = null;         // 当前关卡的 level.json（显示作者校准值要用）
let AC = null;
let game = null;
let audioBuf = null;
let previewClock = null;      // 试听用的时钟
let inGame = false;

const coverURL = lv =>
  lv.cover ? "/levels/" + encodeURIComponent(lv.dir) + "/" + encodeURIComponent(lv.cover) : null;

/* ---------------------- 选关界面 ---------------------- */
function renderList() {
  const box = $("#selList");
  box.innerHTML = "";
  if (!levels.length) {
    box.innerHTML = '<div style="color:#8b93a3;font-size:13px;padding:12px">' +
                    'levels/ 下没有找到任何 level.json</div>';
    return;
  }
  levels.forEach((lv, i) => {
    const el = document.createElement("div");
    el.className = "lvItem";
    const cu = coverURL(lv);
    el.innerHTML =
      '<div class="lvThumb"' + (cu ? ' style="background-image:url(\'' + cu + '\')"' : "") + ">" +
      (cu ? "" : "♪") + "</div>" +
      '<div class="lvMeta"><div class="t">' + escapeHtml(lv.title) + "</div>" +
      '<div class="s">' + escapeHtml(lv.artist || "") + "</div></div>";
    el.onclick = () => selectLevel(i);
    box.appendChild(el);
  });
}

function selectLevel(i) {
  curLevel = levels[i];
  if (!curLevel) return;

  document.querySelectorAll(".lvItem").forEach((el, k) =>
    el.classList.toggle("sel", k === i));

  const cu = coverURL(curLevel);
  const cov = $("#selCover");
  if (cu) { cov.style.backgroundImage = "url('" + cu + "')"; cov.textContent = ""; }
  else { cov.style.backgroundImage = ""; cov.textContent = "无封面"; }

  $("#selBg").style.backgroundImage = cu ? "url('" + cu + "')" : "";
  $("#selTitle").textContent = curLevel.title;
  $("#selSubtitle").textContent = curLevel.subtitle || "";
  $("#selArtist").textContent = curLevel.artist || "";
  $("#selDiff").textContent = curLevel.difficulty || "–";

  stopPreview();
  $("#prevFill").style.width = "0%";
  $("#prevTime").textContent = "0:00 / " + fmt(curLevel.duration || 0);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------------------- 试听 ---------------------- */
function ensureAC() {
  if (!AC) AC = new (window.AudioContext || window.webkitAudioContext)();
  if (AC.state === "suspended") AC.resume();
  return AC;
}

async function togglePreview() {
  if (previewClock) { stopPreview(); return; }
  if (!curLevel) return;
  try {
    ensureAC();
    if (!audioBuf || audioBuf.__dir !== curLevel.dir) {
      $("#btnPreview").textContent = "…";
      audioBuf = await loadAudioBuffer(AC, curLevel.dir, curLevel.music);
      audioBuf.__dir = curLevel.dir;
    }
    // 试听用同一个 AudioClock，但延迟补偿为 0（试听不需要补偿）
    const { AudioClock } = await import("./audio.js");
    previewClock = new AudioClock(AC, audioBuf, 0);
    previewClock.setVolume(settings.volume / 100);
    previewClock.play(0);
    $("#btnPreview").textContent = "❚❚";
  } catch (e) {
    $("#btnPreview").textContent = "▶";
    showErr(e);
  }
}
function stopPreview() {
  if (previewClock) { previewClock.stop(); previewClock = null; }
  $("#btnPreview").textContent = "▶";
}

function updatePreviewUI() {
  if (!previewClock) return;
  const d = previewClock.duration || 1;
  const t = previewClock.time;
  $("#prevFill").style.width = (100 * t / d).toFixed(2) + "%";
  $("#prevTime").textContent = fmt(t) + " / " + fmt(d);
  if (t >= d - 1e-3) stopPreview();
}

/* ---------------------- 延迟校准 ----------------------
   与采音器 tools/BeatMarker.html 的校准器同一套算法，原样搬进关卡界面：
   按固定间隔播放蜂鸣，玩家跟着敲空格，取「敲击时刻 − 最近蜂鸣时刻」的中位数。

   为什么取中位数而不是平均：按键反应时间的分布有长尾（偶尔走神），
   中位数对离群值天然免疫，比平均稳得多。
   为什么匹配「最近响过的那一声」而不是「绝对值最近的」：
   延迟大时绝对值最近会错配到下一声，测值会严重偏小（且看起来还挺稳）。
   ---------------------------------------------------------- */
const cal = {
  active: false, clicks: [], samples: [], nextT: 0, timer: null, nodes: [], iv: 1.0,
};

function calBeep(t) {
  const o = AC.createOscillator(), g = AC.createGain();
  o.frequency.setValueAtTime(1200, t);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(0.4, t + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
  o.connect(g); g.connect(AC.destination);
  o.start(t); o.stop(t + 0.07);
  cal.nodes.push(o);
  o.onended = () => { const i = cal.nodes.indexOf(o); if (i >= 0) cal.nodes.splice(i, 1); };
}

function calSchedule() {
  const iv = cal.iv;
  // 预调度未来一个多间隔。间隔 ≥ 0.5s 远大于任何合理延迟，绝不会错配到下一声。
  while (cal.nextT < AC.currentTime + iv + 0.4) {
    calBeep(cal.nextT);
    cal.clicks.push(cal.nextT);
    if (cal.clicks.length > 48) cal.clicks.shift();
    cal.nextT += iv;
  }
}

function calStart() {
  ensureAC();
  cal.active = true; cal.clicks = []; cal.nodes = [];
  cal.nextT = AC.currentTime + 0.6;
  calSchedule();
  cal.timer = setInterval(calSchedule, 120);
  $("#btnCalToggle").textContent = "停止校准";
  $("#btnCalToggle").classList.add("on");
  $(".modalBox.wide").classList.add("calibrating");
}

function calStop() {
  cal.active = false;
  if (cal.timer) { clearInterval(cal.timer); cal.timer = null; }
  cal.nodes.slice().forEach(o => { try { o.stop(); } catch (e) { /* 已停止 */ } });
  cal.nodes = [];
  const b = $("#btnCalToggle");
  if (b) { b.textContent = "开始校准"; b.classList.remove("on"); }
  const box = $(".modalBox.wide");
  if (box) box.classList.remove("calibrating");
}

// 校准中敲一下：匹配最近响过的那一声
function calTap() {
  if (!cal.active) return;
  const now = AC.currentTime;
  let bd = null, best = 1e9;
  for (const c of cal.clicks) {
    const d = now - c;
    if (d < -0.2 || d >= cal.iv) continue;
    const score = d >= 0 ? d : 1000 + Math.abs(d);   // 非负优先，全负时才接受
    if (score < best) { best = score; bd = d; }
  }
  if (bd === null) return;
  cal.samples.push(bd * 1000);
  if (cal.samples.length > 48) cal.samples.shift();
  calUpdate();
}

function calUpdate() {
  const s = cal.samples;
  $("#calN").textContent = s.length;
  if (!s.length) {
    $("#calMed").textContent = "–";
    $("#calStd").textContent = "–";
    $("#calBars").innerHTML = "";
    $("#calWarn").textContent = "";
    return;
  }
  // 先用中位数粗剔离群（±150ms），再算中位数与抖动
  const srt = s.slice().sort((a, b) => a - b);
  const rough = srt[srt.length >> 1];
  const kept = s.filter(v => Math.abs(v - rough) < 150).sort((a, b) => a - b);
  let med = kept[kept.length >> 1];
  if (kept.length % 2 === 0 && kept.length) {
    med = (kept[kept.length / 2 - 1] + kept[kept.length / 2]) / 2;
  }
  const mean = kept.reduce((a, b) => a + b, 0) / (kept.length || 1);
  const std = Math.sqrt(kept.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (kept.length || 1));
  $("#calMed").textContent = med.toFixed(0);
  $("#calStd").textContent = std.toFixed(1);
  const inp = $("#inpLat");
  if (document.activeElement !== inp) inp.value = med.toFixed(0);   // 正在手输时不打断
  if (game) game.setLatency(med);        // 实时预览：敲几下就能看到画面跟着变

  const w = $("#calWarn");               // 合理性检查
  if (kept.length >= 6 && med < 60) {
    w.textContent = "⚠ 数值偏小：多半是漏敲或抢拍，建议清空重测（正常应在 100ms 以上）";
  } else if (med > 700) {
    w.textContent = "⚠ 数值过大：确认音频没有经过蓝牙或音效处理链路";
  } else if (kept.length >= 6 && std > 60) {
    w.textContent = "⚠ 抖动偏大：节奏不稳，多敲几次取稳定值";
  } else {
    w.textContent = "";
  }

  // 条形图：每次敲击的偏差，红色 = 被剔除的离群值
  $("#calBars").innerHTML = s.map(v => {
    const bad = Math.abs(v - med) >= 150;
    const h = Math.max(0, Math.min(500, v)) / 500 * 100;
    return '<i class="' + (bad ? "bad" : "") + '" style="height:' + h.toFixed(1) + '%"></i>';
  }).join("");
}

// 打开弹窗时把「作者校准值」摆出来给玩家做参考
function fillCalRef() {
  const lv = levelData;
  const ref = (lv && lv.latency_ms != null) ? (lv.latency_ms + " ms") : "本关没有标注";
  $("#calRef").innerHTML =
    "本关作者校准值：<b>" + escapeHtml(ref) + "</b>" +
    "（你实测的值会覆盖它；清空输入框则回退到作者的值）";
}

/* ---------------------- 开始游戏 ---------------------- */
async function startGame() {
  if (!curLevel) return;
  const btn = $("#btnPlay");
  const old = btn.textContent;
  btn.textContent = "载入中…";
  btn.disabled = true;
  try {
    ensureAC();
    stopPreview();

    const level = await loadLevelJSON(curLevel.dir);
    levelData = level;
    if (!audioBuf || audioBuf.__dir !== curLevel.dir) {
      audioBuf = await loadAudioBuffer(AC, curLevel.dir, curLevel.music);
      audioBuf.__dir = curLevel.dir;
    }

    // 先显示游戏视图，再创建 Game（否则 canvas 尺寸为 0）
    $("#viewSelect").classList.add("hide");
    $("#viewGame").classList.remove("hide");
    inGame = true;

    if (game) { game.dispose(); game = null; }

    game = new Game($("#gameCanvas"), level, audioBuf, {
      ctx: AC,
      latency: settings.latency != null ? settings.latency : (level.latency_ms || 0),
      volume: settings.volume / 100,
      guide: settings.guide,
      roadWidth: 3.0,
      lineWidth: 1.0,
    });

    // 调试钩子：把 Game 实例挂到 window，供 tools/shot.js 之类的离线工具
    // 在页面里改参数后立刻截图对比（正常玩不受影响，reload 即消失）
    window.__game = game;
    window.__THREE = THREE;

    game.setGuide(settings.guide);
    applyKeys();                 // 玩家改过的操作按键
    applyAuto();                 // 每条线各自的自动播放开关
    capturing = -1;
    renderHudRows();             // 右下角：各线按键按钮 + 各线自动开关
    game.onStart = () => { $("#startHint").style.opacity = "0"; };
    game.onDeath = () => {
      const f = $("#deathFlash");
      f.classList.add("on");
      setTimeout(() => f.classList.remove("on"), 260);
    };
    game.resize();
    $("#startHint").style.opacity = "1";
    $("#chkGuide").checked = settings.guide;
  } catch (e) {
    showErr(e);
    $("#viewGame").classList.add("hide");
    $("#viewSelect").classList.remove("hide");
    inGame = false;
  } finally {
    btn.textContent = old;
    btn.disabled = false;
  }
}

function backToSelect() {
  if (game) { game.dispose(); game = null; }
  capturing = -1;
  calStop();                                    // 别让蜂鸣跟到选关界面去
  const lm = $("#latModal"); if (lm) lm.classList.add("hide");
  inGame = false;
  $("#viewGame").classList.add("hide");
  $("#viewSelect").classList.remove("hide");
}

/* ---------------------- 右下角：操作按键 / 自动播放 ---------------------- */
let capturing = -1;          // 正在录制哪条线的按键（-1 = 未录制）

// 建立/刷新右下角的两块控件：每条线一个「操作按键」按钮 + 一个「自动」开关
function renderHudRows() {
  if (!game) return;

  const kr = $("#keyRows");
  kr.innerHTML = "";
  game.lines.forEach((L, i) => {
    const b = document.createElement("button");
    b.className = "keyBtn";
    b.onclick = () => startCapture(i);
    kr.appendChild(b);
    refreshKeyBtn(b, i);
  });

  const ab = $("#autoBox");
  ab.innerHTML = "";
  game.lines.forEach((L, i) => {
    const lab = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = autoOf(i);
    cb.onchange = () => setAutoLine(i, cb.checked);
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(
      game.lines.length > 1 ? ("自动播放 " + lineName(i)) : "自动播放"));
    ab.appendChild(lab);
  });

  updateStartHint();
}

// 开始提示：只列「需要玩家操作」的线（自动播放的线不用按键）
function updateStartHint() {
  if (!game) return;
  const names = game.lines.filter(L => !L.auto).map(L => keyName(L.key));
  $("#startHint").textContent = names.length
    ? "点击屏幕或按 " + names.join(" / ") + " 开始游戏"
    : "点击屏幕开始游戏（全部线都是自动播放）";
}

function refreshKeyBtn(btn, i) {
  const hex = String(game.lines[i].def.color || "#ffffff").toLowerCase();
  btn.classList.toggle("capturing", capturing === i);
  btn.innerHTML =
    '<span class="keySw" style="background:' + hex + '"></span>' +
    escapeHtml(keyRowLabel(i)) +
    "<b>" + (capturing === i ? "按下按键…" : escapeHtml(keyName(effectiveKey(i)))) + "</b>";
}

function refreshKeyButtons() {
  const btns = document.querySelectorAll("#keyRows .keyBtn");
  btns.forEach((b, k) => refreshKeyBtn(b, k));
}

function startCapture(i) {
  capturing = i;
  refreshKeyButtons();
}
function cancelCapture() {
  if (capturing < 0) return;
  capturing = -1;
  refreshKeyButtons();
}

// 录制中按下的键：绑定到该线。Esc / Tab 取消。
function captureKey(e) {
  if (e.code === "Escape" || e.code === "Tab") { cancelCapture(); return; }
  const i = capturing;
  const old = effectiveKey(i);
  // 撞键：把原本占用这个键的那条线换成当前这条线原来的键（互换），
  // 否则两条线会同时响应同一个键。
  game.lines.forEach((_, j) => {
    if (j !== i && effectiveKey(j) === e.code) settings.keys[j] = old;
  });
  settings.keys[i] = e.code;
  saveSettings();
  applyKeys();
  capturing = -1;
  renderHudRows();
}

// 把记忆里的按键落到当前关卡上
function applyKeys() {
  if (!game) return;
  game.lines.forEach((L, i) => { if (settings.keys[i]) L.key = settings.keys[i]; });
}

// 把记忆里的自动播放开关落到当前关卡上（可只开其中一条线）
function applyAuto() {
  if (game) game.setAutoLines(game.lines.map((_, i) => autoOf(i)));
}

function setAutoLine(i, v) {
  // 先把「当前实际生效的值」整体固化，再改这一条 ——
  // 否则旧存档的全局 auto 会从还没被触碰的那几条线里漏进来
  const cur = game ? game.lines.map((_, j) => autoOf(j)) : [];
  cur[i] = !!v;
  settings.autoLines = cur;
  settings.auto = false;
  saveSettings();
  applyAuto();
  updateStartHint();
}

/* ---------------------- HUD ---------------------- */
function updateHud() {
  if (!game) return;
  const st = game.state;
  const t = game.clock.time;

  // 首帧状态显示开始提示
  $("#startHint").style.opacity = (st === "idle") ? "1" : "0";

  const prog = game.dur ? Math.round(100 * t / game.dur) : 0;
  $("#hudInfo").innerHTML =
    "关卡 " + (curLevel ? escapeHtml(curLevel.title) : "") + "<br>" +
    "时间 " + fmt(t) + " / " + fmt(game.dur) + "<br>" +
    "进度 " + prog + "%<br>" +
    (st === "dead" ? '<span style="color:#ff8a82">失败，即将重来…</span>' : "") +
    (st === "finished" ? '<span style="color:#8fe3c0">通关！</span>' : "");
}

/* ---------------------- 主循环 ---------------------- */
function loop() {
  if (inGame && game) {
    try {
      game.update();
      updateHud();
    } catch (e) { showErr(e); }
  } else {
    updatePreviewUI();
  }
  requestAnimationFrame(loop);
}

/* ---------------------- 事件绑定 ---------------------- */
function bindUI() {
  $("#btnPlay").onclick = startGame;
  $("#btnPreview").onclick = togglePreview;
  $("#prevBar").onclick = e => {
    if (!previewClock || !audioBuf) return;
    const r = e.currentTarget.getBoundingClientRect();
    const k = (e.clientX - r.left) / r.width;
    previewClock.play(Math.max(0, Math.min(1, k)) * previewClock.duration);
  };

  $("#btnBack").onclick = backToSelect;

  // 游戏输入：每条线一个按键（多线关卡由关卡数据给出，默认 上箭头 / X）；
  // 鼠标左键与空格 = 第一条线（右手），兼容单线关卡。
  $("#gameCanvas").addEventListener("mousedown", e => {
    if (e.button === 0 && game) game.onTap(0);
  });
  window.addEventListener("keydown", e => {
    // 在输入框/下拉框里打字时按键不归游戏管
    // （否则在「延迟补偿」里按 ↑↓ 调数字会同时把线转掉，还会 preventDefault 掉步进）
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    // 正在重绑按键：这一下按键全部交给录制，不进游戏
    if (capturing >= 0) { e.preventDefault(); captureKey(e); return; }
    // 校准进行中：空格专用于跟着蜂鸣敲击
    if (cal.active && e.code === "Space") { e.preventDefault(); calTap(); return; }
    if (e.code === "Escape" && inGame) { backToSelect(); return; }
    if (!inGame || !game) return;
    const li = game.keyToLine(e.code);
    if (li >= 0) { e.preventDefault(); game.onTap(li); }
  });

  // 引导线
  $("#chkGuide").onchange = e => {
    settings.guide = e.target.checked;
    saveSettings();
    if (game) game.setGuide(settings.guide);
  };

  // 延迟校准弹窗：打开时带出作者校准值 + 当前生效值
  $("#btnLat").onclick = () => {
    fillCalRef();
    $("#inpLat").value = (settings.latency != null ? settings.latency : gameLatency());
    $("#selCalIv").value = String(cal.iv);
    cal.samples = [];
    calUpdate();
    $("#latModal").classList.remove("hide");
  };
  $("#selCalIv").onchange = e => {
    cal.iv = parseFloat(e.target.value) || 1;
    if (cal.active) { calStop(); calStart(); }     // 换间隔要重排蜂鸣，否则旧声还在响
  };
  $("#btnCalToggle").onclick = () => { cal.active ? calStop() : calStart(); };
  $("#btnCalReset").onclick = () => { cal.samples = []; calUpdate(); };
  $("#btnLatClose").onclick = () => {
    calStop();
    const raw = $("#inpLat").value.trim();
    const v = parseFloat(raw);
    if (raw === "" || isNaN(v)) settings.latency = null;     // 清空 = 回退到关卡自带值
    else { settings.latency = v; if (game) game.setLatency(v); }
    saveSettings();
    $("#latModal").classList.add("hide");
  };

  // 设置弹窗
  $("#btnSettings").onclick = $("#btnGameSet").onclick = () => {
    $("#inpVol").value = settings.volume;
    $("#volVal").textContent = settings.volume;
    $("#selQuality").value = settings.quality;
    $("#setModal").classList.remove("hide");
  };
  $("#inpVol").oninput = e => {
    settings.volume = parseInt(e.target.value, 10) || 0;
    $("#volVal").textContent = settings.volume;
    if (game) game.setVolume(settings.volume / 100);
    if (previewClock) previewClock.setVolume(settings.volume / 100);
    saveSettings();
  };
  $("#selQuality").onchange = e => {
    settings.quality = e.target.value;
    saveSettings();
    if (game) {
      const pr = { high: 2, medium: 1.5, low: 1 }[settings.quality] || 1.5;
      game.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, pr));
      game.resize();
    }
  };
  $("#btnSetClose").onclick = () => $("#setModal").classList.add("hide");

  window.addEventListener("resize", () => { if (game) game.resize(); });
}

function gameLatency() {
  return (game && game.clock) ? game.clock.latency * 1000 : (curLevel ? curLevel.latency_ms : 0);
}

/* ---------------------- 启动 ---------------------- */
async function init() {
  bindUI();
  try {
    levels = await fetchLevels();
  } catch (e) {
    showErr(e);
    levels = [];
  }
  renderList();
  if (levels.length) selectLevel(0);
  requestAnimationFrame(loop);
}

init();
