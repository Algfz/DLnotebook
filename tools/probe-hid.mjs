/* 复核：我写进关卡的手工件（hid）在引擎里到底落在世界哪个位置，列出偏差最大的几件 */
import fs from "node:fs";
import path from "node:path";
import { buildVerts, linesOf } from "../src/js/level.js";
import { buildPlaced } from "../src/js/props.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const DUR = 174.667;
const SECDIR = path.join(ROOT, "tools", "hand-sections");
const seen = new Set();
const HAND = fs.readdirSync(SECDIR).filter((n) => n.endsWith(".json")).sort()
  .flatMap((f) => JSON.parse(fs.readFileSync(path.join(SECDIR, f), "utf8")).items)
  .filter((it) => { const k = it.at[0] + "," + it.at[1]; if (seen.has(k)) return false; seen.add(k); return true; });

const level = JSON.parse(fs.readFileSync(path.join(ROOT, "levels/ring a bell-灰澈/level.json"), "utf8"));
const verts = buildVerts(level, DUR, linesOf(level)[0]);
const built = buildPlaced(level, verts);
const byPi = new Map((built.solids || []).map((s) => [s.pi, s]));

const rows = [];
level.place.forEach((it, i) => {
  if (it.hid == null) return;
  const want = HAND[it.hid]; if (!want) return;
  if (!it.sol) return;
  const s = byPi.get(i);
  if (!s) { rows.push({ i, hid: it.hid, dev: null, want, note: it.note }); return; }
  rows.push({ i, hid: it.hid, dev: Math.hypot(s.x - want.at[0], s.z - want.at[1]), want, note: it.note,
              got: [+s.x.toFixed(2), +s.z.toFixed(2)], t: it.t, off: it.off });
});
rows.filter((r) => r.dev == null).forEach((r) => console.log("无判定盒  " + r.note));
rows.filter((r) => r.dev != null).sort((a, b) => b.dev - a.dev).slice(0, 8)
  .forEach((r) => console.log("偏差 " + r.dev.toFixed(3) + "m  t=" + r.t + " off=" + r.off +
    "  我要 " + JSON.stringify(r.want.at) + " → 引擎 " + JSON.stringify(r.got) + "  " + r.note));
const devs = rows.filter((r) => r.dev != null).map((r) => r.dev).sort((a, b) => a - b);
console.log("受检 " + devs.length + " 件；偏差中位 " + devs[Math.floor(devs.length / 2)].toFixed(3) +
  "m；>0.1m 的 " + devs.filter((d) => d > 0.1).length + " 件");
